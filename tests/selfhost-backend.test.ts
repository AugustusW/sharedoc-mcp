import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { SelfHostBackend } from '../src/backend/selfhost.js';
import { BackendError } from '../src/backend/types.js';

const T0 = new Date('2026-07-25T10:00:00Z');
const URL_RE = /^http:\/\/127\.0\.0\.1:8377\/docs\/[0-9a-f-]{36}$/;

function makeBackend(now: Date = T0) {
  const dir = mkdtempSync(join(tmpdir(), 'sdh-'));
  const backend = new SelfHostBackend({
    dbPath: join(dir, 'docs.db'),
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
      { password: 'server', expiry: 'enforced', revoke: 'grace', stats: 'tracked' });
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
      dbPath: backend.dbPath,
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
      dbPath: backend.dbPath,
      publicUrl: 'http://127.0.0.1:8377', now: () => new Date(T0.getTime() + 2 * 3600e3),
    });
    expect(later.docRow(id)!.status).toBe('expired');
  });

  it('search: title filter + status + DocRecord shape', async () => {
    const { backend } = makeBackend();
    await backend.createDoc({ title: 'Weekly Report', content: 'x' });
    await backend.createDoc({ title: 'Other', content: 'y' });
    const { results } = await backend.searchDocs({ titleQuery: 'weekly' });
    expect(results.length).toBe(1);
    expect(Object.keys(results[0]).sort()).toEqual(
      ['author', 'createdAt', 'docId', 'expiresAt', 'lastViewedAt', 'status', 'title', 'updatedAt', 'url', 'viewCount']);
  });
});

describe('SelfHostBackend.updateContent (replace, not append)', () => {
  it('replaces content entirely and recomputes contentHash; title/password/expiry untouched', async () => {
    const { backend } = makeBackend();
    const { url } = await backend.createDoc({ title: 'T', content: 'old', password: 'pw', expiresInHours: 24, author: 'a' });
    const id = url.split('/').pop()!;
    const before = backend.docRow(id)!;
    await backend.updateContent(id, 'new content');
    const after = backend.docRow(id)!;
    expect(after.content).toBe('new content'); // replaced, not "oldnew content"
    expect(after.title).toBe('T');
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.expiresAt).toBe(before.expiresAt);
  });

  it('calling twice with the same content is idempotent (same stored content both times)', async () => {
    const { backend } = makeBackend();
    const id = (await backend.createDoc({ title: 'T', content: 'a' })).url.split('/').pop()!;
    await backend.updateContent(id, 'same');
    const first = backend.docRow(id)!.content;
    await backend.updateContent(id, 'same');
    const second = backend.docRow(id)!.content;
    expect(first).toBe('same');
    expect(second).toBe('same');
  });

  it('empty content is allowed (consistent with create/append accepting empty strings)', async () => {
    const { backend } = makeBackend();
    const id = (await backend.createDoc({ title: 'T', content: 'a' })).url.split('/').pop()!;
    await backend.updateContent(id, '');
    expect(backend.docRow(id)!.content).toBe('');
  });

  it('recomputes contentHash to match the new content (verified via createDoc dedup)', async () => {
    const { backend } = makeBackend();
    const id = (await backend.createDoc({ title: 'T', content: 'old', author: 'a' })).url.split('/').pop()!;
    await backend.updateContent(id, 'new content');
    // createDoc dedups on title+content+author hash within 5 minutes — if the stored
    // contentHash still reflected 'old', this would NOT dedup to the updated doc.
    const dup = await backend.createDoc({ title: 'T', content: 'new content', author: 'a' });
    expect(dup.url).toContain(id);
  });

  it('unknown id rejects with not found', async () => {
    const { backend } = makeBackend();
    await expect(backend.updateContent('3f2a8c1e-1111-2222-3333-444455556666', 'x')).rejects.toThrow(/not found/);
  });

  it('revoked doc rejects', async () => {
    const { backend } = makeBackend();
    const id = (await backend.createDoc({ title: 'T', content: 'c' })).url.split('/').pop()!;
    await backend.revokeDoc(id);
    await expect(backend.updateContent(id, 'x')).rejects.toThrow(/revoked/);
  });
});

describe('SelfHostBackend.deleteDoc (hard delete ≠ revoke)', () => {
  it('removes the row entirely — docRow gone, search gone, works on any status', async () => {
    const { backend } = makeBackend();
    const id = (await backend.createDoc({ title: 'Gone', content: 'x' })).url.split('/').pop()!;
    await backend.deleteDoc(id);
    expect(backend.docRow(id)).toBeUndefined();
    expect((await backend.searchDocs({})).results.length).toBe(0);

    const rid = (await backend.createDoc({ title: 'R', content: 'y' })).url.split('/').pop()!;
    await backend.revokeDoc(rid);
    await backend.deleteDoc(rid); // revoked docs are deletable too
    expect(backend.docRow(rid)).toBeUndefined();
  });

  it('unknown id rejects', async () => {
    const { backend } = makeBackend();
    await expect(backend.deleteDoc('3f2a8c1e-1111-2222-3333-444455556666')).rejects.toThrow(/not found/);
  });
});

describe('SelfHostBackend content search', () => {
  it('contentQuery matches body text; title match still works independently', async () => {
    const { backend } = makeBackend();
    await backend.createDoc({ title: 'Alpha', content: 'the quarterly budget line' });
    await backend.createDoc({ title: 'Beta', content: 'vacation photos' });
    const { results } = await backend.searchDocs({ contentQuery: 'budget' });
    expect(results.map(r => r.title)).toEqual(['Alpha']);
    expect((await backend.searchDocs({ titleQuery: 'beta' })).results.length).toBe(1);
  });
});

describe('SelfHostBackend rate limiter (SQLite-backed, failure-counting)', () => {
  it('blocks after 5 recorded FAILURES; checking alone never consumes', () => {
    const { backend } = makeBackend();
    for (let i = 0; i < 10; i++) expect(backend.rateBlocked('k')).toBe(false); // peeking is free
    for (let i = 0; i < 5; i++) backend.rateRecordFailure('k');
    expect(backend.rateBlocked('k')).toBe(true);
    expect(backend.rateBlocked('other')).toBe(false);
    expect(backend.rateRetryAfterSeconds('k')).toBeGreaterThan(0);
  });

  it('rateClear (successful unlock) resets the counter', () => {
    const { backend } = makeBackend();
    for (let i = 0; i < 4; i++) backend.rateRecordFailure('k');
    backend.rateClear('k');
    backend.rateRecordFailure('k');
    expect(backend.rateBlocked('k')).toBe(false); // back to 1 failure, not 5
  });

  it('failure count survives a restart (persisted in SQLite)', () => {
    const { backend } = makeBackend();
    for (let i = 0; i < 5; i++) backend.rateRecordFailure('k');
    const reborn = new SelfHostBackend({
      dbPath: backend.dbPath,
      publicUrl: 'http://127.0.0.1:8377', now: () => T0,
    });
    expect(reborn.rateBlocked('k')).toBe(true); // restart must NOT reset the counter
  });

  it('window refill after 61s', () => {
    const { backend } = makeBackend();
    for (let i = 0; i < 6; i++) backend.rateRecordFailure('k');
    const later = new SelfHostBackend({
      dbPath: backend.dbPath,
      publicUrl: 'http://127.0.0.1:8377', now: () => new Date(T0.getTime() + 61_000),
    });
    expect(later.rateBlocked('k')).toBe(false);
  });
});

describe('SelfHostBackend schema migration (v2.2.0: view stats columns)', () => {
  it('upgrades a pre-2.2.0 DB (no viewCount/lastViewedAt columns) without data loss', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdh-mig-'));
    const dbPath = join(dir, 'docs.db');
    // Hand-build the schema exactly as it existed at user_version 2 (pre-2.2.0) —
    // migrations 0 and 1 from selfhost.ts's migrate(), reproduced here so the test
    // fails loudly if a shipped migration is ever edited instead of appended to.
    const raw = new DatabaseSync(dbPath);
    raw.exec(`CREATE TABLE docs (
      docId TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT,
      passwordHash TEXT, status TEXT NOT NULL DEFAULT 'active',
      author TEXT, contentHash TEXT NOT NULL,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      expiresAt TEXT, revokedAt TEXT
    );
    CREATE TABLE rateLimits (
      key TEXT PRIMARY KEY, windowStart INTEGER NOT NULL, count INTEGER NOT NULL
    );
    CREATE INDEX idx_docs_status ON docs(status);`);
    raw.prepare(`INSERT INTO docs (docId, title, content, status, contentHash, createdAt, updatedAt) VALUES (?, ?, ?, 'active', ?, ?, ?)`)
      .run('11111111-1111-1111-1111-111111111111', 'Pre-existing', 'old body', 'h', T0.toISOString(), T0.toISOString());
    raw.exec(`PRAGMA user_version = 2`);
    raw.close();

    const backend = new SelfHostBackend({ dbPath, publicUrl: 'http://127.0.0.1:8377', now: () => T0 });
    const row = backend.docRow('11111111-1111-1111-1111-111111111111')!;
    expect(row.title).toBe('Pre-existing');
    expect(row.content).toBe('old body'); // no data loss on the pre-existing row

    const check = new DatabaseSync(dbPath);
    const uv = (check.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version;
    expect(uv).toBe(3); // the new migration ran, and only once
    const cols = check.prepare(`SELECT viewCount, lastViewedAt FROM docs WHERE docId = ?`)
      .get('11111111-1111-1111-1111-111111111111') as { viewCount: number; lastViewedAt: string | null };
    expect(cols.viewCount).toBe(0);       // NOT NULL DEFAULT 0 backfilled the existing row
    expect(cols.lastViewedAt).toBeNull(); // never viewed yet
    check.close();
  });
});

describe('SelfHostBackend view stats (recordView)', () => {
  it('increments viewCount and sets lastViewedAt, surfaced via searchDocs', async () => {
    const { backend } = makeBackend();
    const id = (await backend.createDoc({ title: 'Viewed', content: 'x' })).url.split('/').pop()!;
    let { results } = await backend.searchDocs({ titleQuery: 'Viewed' });
    expect(results[0].viewCount).toBe(0);
    expect(results[0].lastViewedAt).toBeNull();

    backend.recordView(id);
    backend.recordView(id);
    ({ results } = await backend.searchDocs({ titleQuery: 'Viewed' }));
    expect(results[0].viewCount).toBe(2);
    expect(results[0].lastViewedAt).toBe(T0.toISOString());
  });

  it('is a best-effort no-op on an unknown docId (never throws)', () => {
    const { backend } = makeBackend();
    expect(() => backend.recordView('3f2a8c1e-1111-2222-3333-444455556666')).not.toThrow();
  });
});

describe('SelfHostBackend.searchDocs offset pagination', () => {
  it('hasMore true mid-list, false on the last page; offset pages through newest-first order', async () => {
    // Advancing clock (not the frozen T0 helper): createDoc always stamps createdAt
    // from now(), so a frozen clock would give all 5 docs an identical timestamp and
    // leave "newest first" order undefined (SQLite ties aren't ordering-guaranteed).
    let t = T0.getTime();
    const dir = mkdtempSync(join(tmpdir(), 'sdh-page-'));
    const backend = new SelfHostBackend({
      dbPath: join(dir, 'docs.db'), publicUrl: 'http://127.0.0.1:8377', now: () => new Date(t),
    });
    for (let i = 0; i < 5; i++) {
      await backend.createDoc({ title: `Page ${i}`, content: 'x', author: `p${i}` });
      t += 1000;
    }
    const page1 = await backend.searchDocs({ limit: 2, offset: 0 });
    expect(page1.results.map(r => r.title)).toEqual(['Page 4', 'Page 3']);
    expect(page1.hasMore).toBe(true);

    const page2 = await backend.searchDocs({ limit: 2, offset: 2 });
    expect(page2.results.map(r => r.title)).toEqual(['Page 2', 'Page 1']);
    expect(page2.hasMore).toBe(true);

    const page3 = await backend.searchDocs({ limit: 2, offset: 4 });
    expect(page3.results.map(r => r.title)).toEqual(['Page 0']);
    expect(page3.hasMore).toBe(false);
  });

  it('offset past the end returns an empty page with hasMore false', async () => {
    const { backend } = makeBackend();
    await backend.createDoc({ title: 'Only', content: 'x' });
    const page = await backend.searchDocs({ offset: 50 });
    expect(page.results).toEqual([]);
    expect(page.hasMore).toBe(false);
  });
});
