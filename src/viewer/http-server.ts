import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import bcrypt from 'bcryptjs';
import type { SelfHostBackend } from '../backend/selfhost.js';
import { TokenBucket } from './rate-limit.js';

const PAGE = (title: string, body: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>body{max-width:760px;margin:2rem auto;padding:0 1rem;font-family:system-ui,sans-serif;line-height:1.6}
pre{overflow-x:auto;background:#f6f6f6;padding:.8rem}code{background:#f6f6f6}
input[type=password]{padding:.4rem;font-size:1rem}button{padding:.4rem 1rem;font-size:1rem}</style>
</head><body>${body}</body></html>`;

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
  const now = opts.now ?? (() => new Date());
  const bucket = new TokenBucket(5, 60_000);

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const docMatch = url.pathname.match(/^\/docs\/([0-9a-f-]{36})$/);
    const fileMatch = url.pathname.match(/^\/files\/([A-Za-z0-9._-]+)$/);

    if (docMatch) {
      const docId = docMatch[1];
      const row = backend.docRow(docId);
      if (!row) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
      if (row.status !== 'active' || row.content === null) {
        res.writeHead(410, { 'content-type': 'text/plain' }).end('gone'); return;
      }
      const html = { 'content-type': 'text/html; charset=utf-8' };

      if (req.method === 'GET') {
        if (row.passwordHash) { res.writeHead(200, html).end(passwordForm(docId)); return; }
        res.writeHead(200, html).end(renderDoc(row.title, row.content));
        return;
      }
      if (req.method === 'POST') {
        // NOTE: behind a tunnel (Tailscale funnel / cloudflared) remoteAddress is the
        // tunnel's loopback for ALL external requesters, so this bucket is effectively
        // per-doc, not per-attacker — stricter than intended, never weaker. Documented
        // in the README rather than trusting X-Forwarded-For (spoofable).
        const key = `${req.socket.remoteAddress}:${docId}`;
        if (!bucket.allow(key, now())) {
          res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': String(bucket.retryAfterSeconds(key, now())) })
            .end('too many attempts');
          return;
        }
        let body: string;
        try {
          body = await readBody(req);
        } catch {
          res.writeHead(413, { 'content-type': 'text/plain' }).end('payload too large');
          return;
        }
        const password = new URLSearchParams(body).get('password') ?? '';
        if (!row.passwordHash || bcrypt.compareSync(password, row.passwordHash)) {
          res.writeHead(200, html).end(renderDoc(row.title, row.content));
        } else {
          res.writeHead(401, html).end(passwordForm(docId, true));
        }
        return;
      }
      res.writeHead(405).end();
      return;
    }

    if (fileMatch && req.method === 'GET') {
      const f = backend.fileRow(fileMatch[1]);
      if (!f) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
      // RFC 5987/6266: non-ASCII filenames go in filename*; the quoted filename is an
      // ASCII fallback with CR/LF and quotes stripped (Node throws on non-ASCII header values).
      const ascii = f.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\r\n]/g, '');
      const star = encodeURIComponent(f.filename).replace(/['()]/g, escape);
      const stream = createReadStream(f.path);
      // A stream 'error' fires outside route()'s stack — without this handler a single
      // GET for a row whose file vanished from disk would crash the whole process.
      stream.on('error', () => {
        if (!res.headersSent) res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('file missing');
      });
      stream.once('open', () => {
        res.writeHead(200, {
          'content-type': (f.contentType ?? 'application/octet-stream').replace(/[\r\n]/g, ''),
          'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${star}`,
        });
        stream.pipe(res);
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }

  const server = createServer((req, res) => {
    route(req, res).catch(e => {
      console.error('sharedoc-mcp viewer:', e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
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
