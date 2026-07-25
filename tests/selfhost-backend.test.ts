import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { SelfHostBackend } from '../src/backend/selfhost.js';
import { BackendError } from '../src/backend/types.js';

const T0 = new Date('2026-07-25T10:00:00Z');
const URL_RE = /^http:\/\/127\.0\.0\.1:8377\/docs\/[0-9a-f-]{36}$/;

function makeBackend(now: Date = T0) {
  const dir = mkdtempSync(join(tmpdir(), 'sdh-'));
  const backend = new SelfHostBackend({
    dbPath: join(dir, 'docs.db'), filesDir: join(dir, 'files'),
    publicUrl: 'http://127.0.0.1:8377', now: () => now,
  });
  return { dir, backend };
}

describe('SelfHostBackend.createDoc', () => {
  it('returns a /docs/<uuid> URL and stores the doc', async () => {
    const { backend } = makeBackend();
    const { url } = await backend.createDoc({ title: 'T', content: '# hi', author: 'me' });
    expect(url).toMatch(URL_RE);
    const id = url.split('/').pop()!;
    const row = backend.docRow(id)!;
    expect(row.title).toBe('T');
    expect(row.content).toBe('# hi');
    expect(row.passwordHash).toBeNull();
  });

  it('hashes password with bcrypt (no plaintext in DB)', async () => {
    const { backend } = makeBackend();
    const { url } = await backend.createDoc({ title: 'T', content: 'c', password: 's3cret' });
    const row = backend.docRow(url.split('/').pop()!)!;
    expect(row.passwordHash).not.toContain('s3cret');
    expect(bcrypt.compareSync('s3cret', row.passwordHash!)).toBe(true);
  });

  it('dedups title+content+author within 5 minutes', async () => {
    const { backend } = makeBackend();
    const a = await backend.createDoc({ title: 't', content: 'c', author: 'a' });
    const b = await backend.createDoc({ title: 't', content: 'c', author: 'a' });
    expect(b.url).toBe(a.url);
  });

  it('retry that ADDS a password or expiry never reuses the unprotected doc', async () => {
    const { backend } = makeBackend();
    const open = await backend.createDoc({ title: 't', content: 'c', author: 'a' });
    const withPw = await backend.createDoc({ title: 't', content: 'c', author: 'a', password: 'pw' });
    expect(withPw.url).not.toBe(open.url);
    expect(backend.docRow(withPw.url.split('/').pop()!)!.passwordHash).not.toBeNull();
    const withExp = await backend.createDoc({ title: 't', content: 'c', author: 'a', expiresInHours: 1 });
    expect(withExp.url).not.toBe(open.url);
  });

  it('capabilities: full semantics', () => {
    const { backend } = makeBackend();
    expect(backend.capabilities()).toEqual(
      { password: 'server', expiry: 'enforced', files: true, revoke: 'grace' });
  });
});

describe('SelfHostBackend doc ops', () => {
  it('append / updateTitle / resetPassword / extend round-trip', async () => {
    const { backend } = makeBackend();
    const id = (await backend.createDoc({ title: 'T', content: 'a' })).url.split('/').pop()!;
    await backend.appendDoc(id, '\nb');
    await backend.updateTitle(id, 'T2');
    await backend.resetPassword(id, 'pw');
    await backend.extendDoc(id, 24);
    const row = backend.docRow(id)!;
    expect(row.content).toBe('a\nb');
    expect(row.title).toBe('T2');
    const full = backend.docRow(id)!;
    expect(bcrypt.compareSync('pw', full.passwordHash!)).toBe(true);
    expect(full.expiresAt).toBe(new Date(T0.getTime() + 24 * 3600e3).toISOString());
  });

  it('updateTitle rejects empty; unknown id rejects', async () => {
    const { backend } = makeBackend();
    const id = (await backend.createDoc({ title: 'T', content: 'c' })).url.split('/').pop()!;
    await expect(backend.updateTitle(id, '  ')).rejects.toThrow(BackendError);
    await expect(backend.appendDoc('3f2a8c1e-1111-2222-3333-444455556666', 'x')).rejects.toThrow(/not found/);
  });

  it('revoke marks grace state; ops on revoked doc reject; 7-day purge clears content', async () => {
    const { backend } = makeBackend();
    const id = (await backend.createDoc({ title: 'T', content: 'secret-body' })).url.split('/').pop()!;
    await backend.revokeDoc(id);
    expect(backend.docRow(id)!.status).toBe('revoked');
    expect(backend.docRow(id)!.content).toBe('secret-body'); // grace: content kept
    await expect(backend.appendDoc(id, 'x')).rejects.toThrow(/revoked/);

    // 8 days later: any op triggers purge
    const eightDays = new Date(T0.getTime() + 8 * 24 * 3600e3);
    const later = new SelfHostBackend({
      dbPath: backend.dbPath, filesDir: backend.filesDir,
      publicUrl: 'http://127.0.0.1:8377', now: () => eightDays,
    });
    await later.searchDocs({});
    expect(later.docRow(id)!.content).toBeNull(); // purged
    expect(later.docRow(id)!.status).toBe('revoked');
  });

  it('active doc past expiresAt flips to expired via housekeeping', async () => {
    const { backend } = makeBackend();
    const id = (await backend.createDoc({ title: 'T', content: 'c', expiresInHours: 1 })).url.split('/').pop()!;
    const later = new SelfHostBackend({
      dbPath: backend.dbPath, filesDir: backend.filesDir,
      publicUrl: 'http://127.0.0.1:8377', now: () => new Date(T0.getTime() + 2 * 3600e3),
    });
    expect(later.docRow(id)!.status).toBe('expired');
  });

  it('search: title filter + status + DocRecord shape', async () => {
    const { backend } = makeBackend();
    await backend.createDoc({ title: 'Weekly Report', content: 'x' });
    await backend.createDoc({ title: 'Other', content: 'y' });
    const rows = await backend.searchDocs({ titleQuery: 'weekly' });
    expect(rows.length).toBe(1);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['author', 'createdAt', 'docId', 'expiresAt', 'status', 'title', 'updatedAt', 'url']);
  });
});

describe('SelfHostBackend.createFile', () => {
  it('copies the file into filesDir and returns a /files/ URL', async () => {
    const { dir, backend } = makeBackend();
    const src = join(dir, 'up.txt');
    writeFileSync(src, 'file-content');
    const { url } = await backend.createFile({ filePath: src });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:8377\/files\//);
    const key = url.split('/files/').pop()!;
    const f = backend.fileRow(key)!;
    expect(f.filename).toBe('up.txt');
    expect(existsSync(f.path)).toBe(true);
  });

  it('missing source file rejects', async () => {
    const { backend } = makeBackend();
    await expect(backend.createFile({ filePath: '/nope/x.txt' })).rejects.toThrow(BackendError);
  });
});
