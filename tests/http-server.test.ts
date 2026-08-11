import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelfHostBackend } from '../src/backend/selfhost.js';
import { startViewer } from '../src/viewer/http-server.js';

describe('HTTP viewer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdv-'));
  const backend = new SelfHostBackend({
    dbPath: join(dir, 'docs.db'),
    publicUrl: 'http://127.0.0.1:8377',
  });
  let base = '';
  let close: () => Promise<void>;

  beforeAll(async () => {
    const v = await startViewer(backend, { port: 0 });
    base = `http://127.0.0.1:${v.port}`;
    close = v.close;
  });
  afterAll(async () => { await close(); });

  async function createId(p: Parameters<typeof backend.createDoc>[0]): Promise<string> {
    return (await backend.createDoc(p)).url.split('/').pop()!;
  }

  it('serves an open doc as sanitized HTML', async () => {
    const id = await createId({ title: 'Open', content: '# Hello\n<script>alert(1)</script>' });
    const res = await fetch(`${base}/docs/${id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Hello</h1>');
    expect(html).not.toContain('<script>alert');
  });

  it('password doc: form → wrong 401 → correct 200', async () => {
    const id = await createId({ title: 'P', content: 'secret-body', password: 'pw123' });
    const form = await fetch(`${base}/docs/${id}`);
    expect(await form.text()).toContain('type="password"');

    const bad = await fetch(`${base}/docs/${id}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=nope',
    });
    expect(bad.status).toBe(401);
    expect(await bad.text()).not.toContain('secret-body');

    const good = await fetch(`${base}/docs/${id}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=pw123',
    });
    expect(good.status).toBe(200);
    expect(await good.text()).toContain('secret-body');
  });

  it('rate limits WRONG passwords: 6th wrong attempt → 429 + Retry-After', async () => {
    const id = await createId({ title: 'RL', content: 'x', password: 'pw' });
    let last: Response = new Response();
    for (let i = 0; i < 6; i++) {
      last = await fetch(`${base}/docs/${id}`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'password=wrong',
      });
    }
    expect(last.status).toBe(429);
    expect(last.headers.get('retry-after')).toBeTruthy();
  });

  it('correct passwords are never rate-limited, and a success clears prior failures', async () => {
    const id = await createId({ title: 'RL2', content: 'ok-body', password: 'pw' });
    const post = (password: string) => fetch(`${base}/docs/${id}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${password}`,
    });
    for (let i = 0; i < 8; i++) expect((await post('pw')).status).toBe(200); // successes don't count
    for (let i = 0; i < 4; i++) await post('wrong');
    expect((await post('pw')).status).toBe(200);   // 4 failures < cap → unlock works, clears counter
    for (let i = 0; i < 4; i++) await post('wrong');
    expect((await post('wrong')).status).toBe(401); // 5th failure post-clear: still 401, not 429
  });

  it('unknown → 404; revoked → 410', async () => {
    expect((await fetch(`${base}/docs/3f2a8c1e-1111-2222-3333-444455556666`)).status).toBe(404);
    const id = await createId({ title: 'R', content: 'x' });
    await backend.revokeDoc(id);
    expect((await fetch(`${base}/docs/${id}`)).status).toBe(410);
  });

  it('/files/ routes are gone (feature removed): 404', async () => {
    expect((await fetch(`${base}/files/anything`)).status).toBe(404);
  });

  it('/healthz reports identity + db fingerprint (with security headers)', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const j = await res.json() as { ok: boolean; server: string; db: string };
    expect(j.ok).toBe(true);
    expect(j.server).toBe('sharedoc-mcp');
    expect(j.db).toMatch(/^[0-9a-f]{8}$/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('deleted doc → 404 end-to-end through the viewer', async () => {
    const id = await createId({ title: 'D', content: 'x' });
    expect((await fetch(`${base}/docs/${id}`)).status).toBe(200);
    await backend.deleteDoc(id);
    expect((await fetch(`${base}/docs/${id}`)).status).toBe(404);
  });

  it('every response carries the security header set', async () => {
    const id = await createId({ title: 'H', content: 'x' });
    for (const res of [
      await fetch(`${base}/docs/${id}`),
      await fetch(`${base}/docs/3f2a8c1e-1111-2222-3333-444455556666`), // 404 path too
    ]) {
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
  });

  it('doc HTML carries a noindex,nofollow robots meta (search engines must not index shares)', async () => {
    const id = await createId({ title: 'R', content: 'x' });
    const html = await (await fetch(`${base}/docs/${id}`)).text();
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  });

  it('doc page stylesheet: dark-mode aware + table/blockquote/img rules', async () => {
    const id = await createId({
      title: 'Styled',
      content: '| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\n![pic](https://example.com/p.png)',
    });
    const html = await (await fetch(`${base}/docs/${id}`)).text();
    // dark mode: color-scheme so form controls/scrollbars follow the system theme,
    // plus an explicit prefers-color-scheme override block for our own tokens
    expect(html).toContain('color-scheme:light dark');
    expect(html).toContain('prefers-color-scheme:dark');
    // tables render with real borders and scroll horizontally instead of bursting the layout
    expect(html).toContain('border-collapse:collapse');
    expect(html).toMatch(/table\{[^}]*overflow-x:auto/);
    // blockquote and img are styled; large images shrink to the viewport
    expect(html).toMatch(/blockquote\{[^}]*border-left/);
    expect(html).toMatch(/img\{[^}]*max-width:100%/);
    // the markdown table itself survived sanitize-html
    expect(html).toContain('<table>');
  });

  it('password page shares the same dark-mode aware stylesheet', async () => {
    const id = await createId({ title: 'PS', content: 'x', password: 'pw' });
    const html = await (await fetch(`${base}/docs/${id}`)).text();
    expect(html).toContain('color-scheme:light dark');
    expect(html).toContain('prefers-color-scheme:dark');
  });

  it('GFM strikethrough survives sanitization', async () => {
    const id = await createId({ title: 'Del', content: '~~obsolete~~ current' });
    const html = await (await fetch(`${base}/docs/${id}`)).text();
    expect(html).toContain('<del>obsolete</del>');
  });

  it('table column alignment (align attr) survives sanitization', async () => {
    const id = await createId({ title: 'Align', content: '| L | C | R |\n|:--|:-:|--:|\n| a | b | c |' });
    const html = await (await fetch(`${base}/docs/${id}`)).text();
    expect(html).toContain('<th align="center">');
    expect(html).toContain('<td align="right">');
  });

  describe('view stats: only a successful render counts', () => {
    it('GET on an unprotected doc increments viewCount + sets lastViewedAt', async () => {
      const id = await createId({ title: 'Views', content: 'x' });
      await fetch(`${base}/docs/${id}`);
      await fetch(`${base}/docs/${id}`);
      const { results } = await backend.searchDocs({ titleQuery: 'Views' });
      expect(results[0].viewCount).toBe(2);
      expect(results[0].lastViewedAt).toBeTruthy();
    });

    it('password doc: the form GET and a wrong POST do NOT count; a correct POST does', async () => {
      const id = await createId({ title: 'PV', content: 'x', password: 'pw' });
      await fetch(`${base}/docs/${id}`); // just the password form, no content shown
      await fetch(`${base}/docs/${id}`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'password=wrong',
      });
      let r = (await backend.searchDocs({ titleQuery: 'PV' })).results[0];
      expect(r.viewCount).toBe(0);

      await fetch(`${base}/docs/${id}`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'password=pw',
      });
      r = (await backend.searchDocs({ titleQuery: 'PV' })).results[0];
      expect(r.viewCount).toBe(1);
    });

    it('404 and 410 responses do not count (nothing was rendered)', async () => {
      const id = await createId({ title: 'Rv', content: 'x' });
      await backend.revokeDoc(id);
      expect((await fetch(`${base}/docs/${id}`)).status).toBe(410);
      expect((await fetch(`${base}/docs/3f2a8c1e-1111-2222-3333-444455556666`)).status).toBe(404);
      const { results } = await backend.searchDocs({ titleQuery: 'Rv' });
      expect(results[0].viewCount).toBe(0);
    });
  });
});

describe('startViewer bindHost option (Docker reachability)', () => {
  it('defaults to 127.0.0.1 when bindHost is omitted (unchanged existing behavior)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdv-bind-'));
    const backend = new SelfHostBackend({ dbPath: join(dir, 'docs.db'), publicUrl: 'http://127.0.0.1:0' });
    const v = await startViewer(backend, { port: 0 });
    expect(v.host).toBe('127.0.0.1');
    await v.close();
  });

  it('binds 0.0.0.0 when bindHost is set — this is what makes a container reachable via `docker run -p`', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdv-bind-'));
    const backend = new SelfHostBackend({ dbPath: join(dir, 'docs.db'), publicUrl: 'http://127.0.0.1:0' });
    const v = await startViewer(backend, { port: 0, bindHost: '0.0.0.0' });
    expect(v.host).toBe('0.0.0.0');
    // 0.0.0.0 includes the loopback interface, so it stays reachable via 127.0.0.1 too.
    const res = await fetch(`http://127.0.0.1:${v.port}/healthz`);
    expect(res.status).toBe(200);
    await v.close();
  });
});
