import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import bcrypt from 'bcryptjs';
import type { SelfHostBackend } from '../backend/selfhost.js';

/** Non-reversible identifier for "which DB is this viewer serving" — safe to expose. */
export function dbFingerprint(dbPath: string): string {
  return createHash('sha256').update(dbPath).digest('hex').slice(0, 8);
}

const PAGE = (title: string, body: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>body{max-width:760px;margin:2rem auto;padding:0 1rem;font-family:system-ui,sans-serif;line-height:1.6}
pre{overflow-x:auto;background:#f6f6f6;padding:.8rem}code{background:#f6f6f6}
input[type=password]{padding:.4rem;font-size:1rem}button{padding:.4rem 1rem;font-size:1rem}</style>
</head><body>${body}</body></html>`;

/** Applied to every response — docs may hold sensitive content; lock the page down. */
const SEC_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function head(res: ServerResponse, status: number, extra: Record<string, string> = {}): ServerResponse {
  res.writeHead(status, { ...SEC_HEADERS, ...extra });
  return res;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function renderDoc(title: string, markdown: string): string {
  const html = sanitizeHtml(marked.parse(markdown, { async: false }), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'details', 'summary', 'input']),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      input: ['type', 'checked', 'disabled'],
      img: ['src', 'alt'],
    },
  });
  return PAGE(title, `<h1>${escapeHtml(title)}</h1>\n<hr>\n${html}`);
}

function passwordForm(docId: string, error = false): string {
  return PAGE('Protected document', `
    <h1>Protected document</h1>
    ${error ? '<p style="color:#b00">Wrong password, try again.</p>' : ''}
    <form method="POST" action="/docs/${docId}">
      <input type="password" name="password" autofocus>
      <button type="submit">Open</button>
    </form>`);
}

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > limit) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export async function startViewer(
  backend: SelfHostBackend,
  opts: { port: number; now?: () => Date },
): Promise<{ port: number; close(): Promise<void> }> {
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/healthz' && req.method === 'GET') {
      // Health + identity probe: external monitoring, and MCP-mode processes use it
      // to verify a busy port is really OUR viewer on the SAME database (review I2).
      head(res, 200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, server: 'sharedoc-mcp', db: dbFingerprint(backend.dbPath) }));
      return;
    }

    const docMatch = url.pathname.match(/^\/docs\/([0-9a-f-]{36})$/);

    if (docMatch) {
      const docId = docMatch[1];
      const row = backend.docRow(docId);
      if (!row) { head(res, 404, { 'content-type': 'text/plain' }).end('not found'); return; }
      if (row.status !== 'active' || row.content === null) {
        head(res, 410, { 'content-type': 'text/plain' }).end('gone'); return;
      }
      const html = { 'content-type': 'text/html; charset=utf-8' };

      if (req.method === 'GET') {
        if (row.passwordHash) { head(res, 200, html).end(passwordForm(docId)); return; }
        head(res, 200, html).end(renderDoc(row.title, row.content));
        return;
      }
      if (req.method === 'POST') {
        // NOTE: behind a tunnel, remoteAddress is the tunnel's loopback for ALL
        // external requesters — the bucket degrades to per-doc, which is stricter,
        // never weaker. Counters live in SQLite, so a restart doesn't reset them.
        const key = `${req.socket.remoteAddress}:${docId}`;
        if (!backend.rateAllow(key)) {
          head(res, 429, { 'content-type': 'text/plain', 'retry-after': String(backend.rateRetryAfterSeconds(key)) })
            .end('too many attempts');
          return;
        }
        let body: string;
        try {
          body = await readBody(req);
        } catch {
          head(res, 413, { 'content-type': 'text/plain' }).end('payload too large');
          return;
        }
        const password = new URLSearchParams(body).get('password') ?? '';
        if (!row.passwordHash || bcrypt.compareSync(password, row.passwordHash)) {
          head(res, 200, html).end(renderDoc(row.title, row.content));
        } else {
          head(res, 401, html).end(passwordForm(docId, true));
        }
        return;
      }
      head(res, 405).end();
      return;
    }

    head(res, 404, { 'content-type': 'text/plain' }).end('not found');
  }

  const server = createServer((req, res) => {
    route(req, res).catch(e => {
      console.error('sharedoc-mcp viewer:', e);
      if (!res.headersSent) head(res, 500, { 'content-type': 'text/plain' });
      res.end('internal error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // SECURITY: 127.0.0.1 only — public exposure is the user's tunnel's job.
    server.listen(opts.port, '127.0.0.1', resolve);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) =>
      server.close(err => (err ? reject(err) : resolve()))),
  };
}
