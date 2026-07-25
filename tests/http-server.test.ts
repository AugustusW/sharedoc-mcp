import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelfHostBackend } from '../src/backend/selfhost.js';
import { TokenBucket } from '../src/viewer/rate-limit.js';
import { startViewer } from '../src/viewer/http-server.js';

const T0 = new Date('2026-07-25T10:00:00Z');

describe('TokenBucket', () => {
  it('allows 5 per minute per key, refills after window', () => {
    const b = new TokenBucket(5, 60_000);
    for (let i = 0; i < 5; i++) expect(b.allow('k', T0)).toBe(true);
    expect(b.allow('k', T0)).toBe(false);
    expect(b.allow('other', T0)).toBe(true);
    expect(b.allow('k', new Date(T0.getTime() + 61_000))).toBe(true);
  });
});

describe('HTTP viewer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdv-'));
  const backend = new SelfHostBackend({
    dbPath: join(dir, 'docs.db'), filesDir: join(dir, 'files'),
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

  it('rate limits the password endpoint: 6th attempt → 429 + Retry-After', async () => {
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

  it('unknown → 404; revoked → 410', async () => {
    expect((await fetch(`${base}/docs/3f2a8c1e-1111-2222-3333-444455556666`)).status).toBe(404);
    const id = await createId({ title: 'R', content: 'x' });
    await backend.revokeDoc(id);
    expect((await fetch(`${base}/docs/${id}`)).status).toBe(410);
  });

  it('serves shared files with original filename', async () => {
    const src = join(dir, 'up.txt');
    writeFileSync(src, 'file-content');
    const { url } = await backend.createFile({ filePath: src });
    const key = url.split('/files/').pop()!;
    const res = await fetch(`${base}/files/${key}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('file-content');
    expect(res.headers.get('content-disposition')).toContain('up.txt');
  });

  it('non-ASCII filename downloads via RFC 5987 (no 500)', async () => {
    const src = join(dir, 'zh.md');
    writeFileSync(src, 'zh-content');
    const { url } = await backend.createFile({ filePath: src, filename: '週報.md' });
    const res = await fetch(`${base}/files/${url.split('/files/').pop()!}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain(`filename*=UTF-8''`);
  });

  it('missing file on disk → 404, and the server survives (no process crash)', async () => {
    const src = join(dir, 'gone.txt');
    writeFileSync(src, 'x');
    const { url } = await backend.createFile({ filePath: src });
    const key = url.split('/files/').pop()!;
    rmSync(backend.fileRow(key)!.path); // file vanishes after registration
    const res = await fetch(`${base}/files/${key}`);
    expect(res.status).toBe(404);
    // server must still answer afterwards — the old code died on the stream error
    const again = await fetch(`${base}/docs/3f2a8c1e-1111-2222-3333-444455556666`);
    expect(again.status).toBe(404);
  });
});
