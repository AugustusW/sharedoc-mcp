import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexStore } from '../src/index-store.js';
import { GistBackend, slugify, type CommandRunner } from '../src/backend/gist.js';
import { BackendError } from '../src/backend/types.js';

const T0 = new Date('2026-07-25T10:00:00Z');
const GIST_URL = 'https://gist.github.com/AugustusW/f00dfeed';

type Call = { argv: string[]; input?: string };

function makeFake(responses: Record<string, string | { exitCode: number; stderr: string }>) {
  const calls: Call[] = [];
  const run: CommandRunner = async (argv, input) => {
    calls.push({ argv, input });
    const key = argv.slice(0, 3).join(' ');
    const r = responses[key];
    if (r === undefined) return { stdout: '', stderr: '', exitCode: 0 };
    if (typeof r === 'string') return { stdout: r, stderr: '', exitCode: 0 };
    return { stdout: '', stderr: r.stderr, exitCode: r.exitCode };
  };
  return { calls, run };
}

function makeBackend(fake: ReturnType<typeof makeFake>, now: Date = T0) {
  const store = new IndexStore(join(mkdtempSync(join(tmpdir(), 'sd-')), 'index.json'));
  return { store, backend: new GistBackend(store, fake.run, () => now) };
}

describe('GistBackend.createDoc', () => {
  it('creates a secret gist via stdin and indexes it', async () => {
    const fake = makeFake({ 'gh gist create': `${GIST_URL}\n` });
    const { store, backend } = makeBackend(fake);
    const { url } = await backend.createDoc({ title: 'My Report', content: '# hi', author: 'me' });
    expect(url).toBe(GIST_URL);
    const create = fake.calls.find(c => c.argv[1] === 'gist' && c.argv[2] === 'create')!;
    expect(create.argv).toContain('--filename');
    expect(create.argv).toContain('my-report.md');
    expect(create.input).toBe('# hi');
    expect(store.get('f00dfeed')?.status).toBe('active');
  });

  it('rejects password with a BackendError explaining capabilities', async () => {
    const { backend } = makeBackend(makeFake({}));
    await expect(backend.createDoc({ title: 't', content: 'c', password: 'x' }))
      .rejects.toThrow(BackendError);
  });

  it('dedups same title+content+author within 5 minutes (no second gh call)', async () => {
    const fake = makeFake({ 'gh gist create': `${GIST_URL}\n` });
    const { backend } = makeBackend(fake);
    await backend.createDoc({ title: 't', content: 'c', author: 'a' });
    const before = fake.calls.length;
    const { url } = await backend.createDoc({ title: 't', content: 'c', author: 'a' });
    expect(url).toBe(GIST_URL);
    expect(fake.calls.length).toBe(before);   // only lazy-cleanup scan, no create
  });

  it('surfaces gh failure with guidance', async () => {
    const fake = makeFake({ 'gh gist create': { exitCode: 4, stderr: 'To get started with GitHub CLI, please run: gh auth login' } });
    const { backend } = makeBackend(fake);
    await expect(backend.createDoc({ title: 't', content: 'c' }))
      .rejects.toThrow(/gh auth login/);
  });
});

describe('slugify', () => {
  it('sanitizes via allowlist, lowercases, hyphenates, truncates at 60, falls back to "doc"', () => {
    expect(slugify('My Report 2026!')).toBe('my-report-2026');
    expect(slugify('中文標題！@#')).toBe('doc');
    expect(slugify('A'.repeat(80))).toHaveLength(60);
    expect(slugify('Mixed_case Título')).toBe('mixed_case-ttulo');
  });
});

describe('GistBackend.resetPassword', () => {
  it('rejects with BackendError (unsupported on gist)', async () => {
    const { backend } = makeBackend(makeFake({}));
    await expect(backend.resetPassword('id', 'new')).rejects.toThrow(BackendError);
  });
});

describe('GistBackend.appendDoc', () => {
  it('fetches current content and PATCHes concatenation', async () => {
    const fake = makeFake({
      'gh gist create': `${GIST_URL}\n`,
      'gh api gists/f00dfeed': JSON.stringify({
        files: { 'my-report.md': { content: '# hi', truncated: false } },
      }),
    });
    const { backend } = makeBackend(fake);
    await backend.createDoc({ title: 'My Report', content: '# hi' });
    await backend.appendDoc('f00dfeed', '\nmore');
    const patch = fake.calls.find(c => c.argv.includes('PATCH'))!;
    expect(patch.argv.slice(0, 3)).toEqual(['gh', 'api', 'gists/f00dfeed']);
    expect(JSON.parse(patch.input!).files['my-report.md'].content).toBe('# hi\nmore');
  });

  it('refuses to append when the API reports truncated content (data-loss guard)', async () => {
    const fake = makeFake({
      'gh gist create': `${GIST_URL}\n`,
      'gh api gists/f00dfeed': JSON.stringify({
        files: { 'my-report.md': { content: 'partial…', truncated: true } },
      }),
    });
    const { backend } = makeBackend(fake);
    await backend.createDoc({ title: 'My Report', content: '# hi' });
    await expect(backend.appendDoc('f00dfeed', 'more')).rejects.toThrow(/truncated/);
    expect(fake.calls.some(c => c.argv.includes('PATCH'))).toBe(false);
  });

  it('unknown docId rejects (not in local index)', async () => {
    const { backend } = makeBackend(makeFake({}));
    await expect(backend.appendDoc('nope', 'x')).rejects.toThrow(/index/);
  });
});

describe('GistBackend.revokeDoc / extendDoc / lazy cleanup', () => {
  it('revoke deletes the gist and marks index revoked (hard-delete)', async () => {
    const fake = makeFake({ 'gh gist create': `${GIST_URL}\n` });
    const { store, backend } = makeBackend(fake);
    await backend.createDoc({ title: 't', content: 'c' });
    await backend.revokeDoc('f00dfeed');
    expect(fake.calls.some(c => c.argv[2] === 'delete' && c.argv.includes('--yes'))).toBe(true);
    expect(store.get('f00dfeed')?.status).toBe('revoked');
  });

  it('extend updates expiresAt to now + hours', async () => {
    const fake = makeFake({ 'gh gist create': `${GIST_URL}\n` });
    const { store, backend } = makeBackend(fake);
    await backend.createDoc({ title: 't', content: 'c', expiresInHours: 1 });
    await backend.extendDoc('f00dfeed', 48);
    expect(store.get('f00dfeed')?.expiresAt)
      .toBe(new Date(T0.getTime() + 48 * 3600e3).toISOString());
  });

  it('lazy cleanup deletes expired gists on next operation', async () => {
    const fake = makeFake({ 'gh gist create': `${GIST_URL}\n` });
    const { store, backend } = makeBackend(fake);
    await backend.createDoc({ title: 't', content: 'c', expiresInHours: 1 });
    const later = new GistBackend(store, fake.run, () => new Date(T0.getTime() + 2 * 3600e3));
    await later.searchDocs({});
    expect(fake.calls.some(c => c.argv[2] === 'delete')).toBe(true);
    expect(store.get('f00dfeed')?.status).toBe('expired');
  });

  it('capabilities reflect gist semantics', () => {
    const { backend } = makeBackend(makeFake({}));
    expect(backend.capabilities()).toEqual(
      { password: 'none', expiry: 'lazy', revoke: 'hard-delete' });
  });

  it('deleteDoc removes the gist AND the index entry entirely (search gone)', async () => {
    const fake = makeFake({ 'gh gist create': `${GIST_URL}\n` });
    const { store, backend } = makeBackend(fake);
    await backend.createDoc({ title: 't', content: 'c' });
    await backend.deleteDoc('f00dfeed');
    expect(fake.calls.some(c => c.argv[2] === 'delete' && c.argv.includes('--yes'))).toBe(true);
    expect(store.get('f00dfeed')).toBeUndefined();
    expect((await backend.searchDocs({})).length).toBe(0);
  });

  it('deleteDoc: real gh failure propagates and KEEPS the index entry (no orphaned live gist)', async () => {
    const fake = makeFake({ 'gh gist create': `${GIST_URL}\n` });
    const { store, backend } = makeBackend(fake);
    await backend.createDoc({ title: 't', content: 'c' });
    fake.calls.length = 0;
    const failing = makeFake({ 'gh gist delete': { exitCode: 1, stderr: 'HTTP 401: Bad credentials' } });
    const b2 = new GistBackend(store, failing.run, () => T0);
    await expect(b2.deleteDoc('f00dfeed')).rejects.toThrow(/401|failed/);
    expect(store.get('f00dfeed')).toBeDefined(); // retryable — record kept
  });

  it('deleteDoc: "not found" from gh is swallowed and the index is cleaned', async () => {
    const fake = makeFake({ 'gh gist create': `${GIST_URL}\n` });
    const { store, backend } = makeBackend(fake);
    await backend.createDoc({ title: 't', content: 'c' });
    const gone = makeFake({ 'gh gist delete': { exitCode: 1, stderr: 'not found' } });
    const b2 = new GistBackend(store, gone.run, () => T0);
    await b2.deleteDoc('f00dfeed');
    expect(store.get('f00dfeed')).toBeUndefined();
  });

  it('append tops up a short excerpt so later content search can find it', async () => {
    const fake = makeFake({
      'gh gist create': `${GIST_URL}\n`,
      'gh api gists/f00dfeed': JSON.stringify({ files: { 'stub.md': { content: 'x', truncated: false } } }),
    });
    const { backend } = makeBackend(fake);
    await backend.createDoc({ title: 'Stub', content: 'x' });
    await backend.appendDoc('f00dfeed', ' appended-budget-notes');
    expect((await backend.searchDocs({ contentQuery: 'appended-budget' })).length).toBe(1);
  });

  it('deleteDoc on a revoked entry still cleans the index (gist already gone)', async () => {
    const fake = makeFake({ 'gh gist create': `${GIST_URL}\n` });
    const { store, backend } = makeBackend(fake);
    await backend.createDoc({ title: 't', content: 'c' });
    await backend.revokeDoc('f00dfeed');
    await backend.deleteDoc('f00dfeed');
    expect(store.get('f00dfeed')).toBeUndefined();
  });

  it('content search matches the stored opening excerpt', async () => {
    const fake = makeFake({ 'gh gist create': `${GIST_URL}\n` });
    const { backend } = makeBackend(fake);
    await backend.createDoc({ title: 'Report', content: 'quarterly budget details…' });
    expect((await backend.searchDocs({ contentQuery: 'budget' })).length).toBe(1);
    expect((await backend.searchDocs({ contentQuery: 'nonexistent' })).length).toBe(0);
  });

  it('searchDocs returns DocRecord shape only (no internal fields)', async () => {
    const fake = makeFake({ 'gh gist create': `${GIST_URL}\n` });
    const { backend } = makeBackend(fake);
    await backend.createDoc({ title: 't', content: 'c' });
    const [row] = await backend.searchDocs({});
    expect(Object.keys(row).sort()).toEqual(
      ['author', 'createdAt', 'docId', 'expiresAt', 'status', 'title', 'updatedAt', 'url']);
  });
});
