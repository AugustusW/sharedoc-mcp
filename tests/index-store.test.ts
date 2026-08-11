import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexStore, type IndexEntry } from '../src/index-store.js';

const T0 = new Date('2026-07-25T10:00:00Z');

function entry(over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    docId: 'abc123', title: 'Doc', url: 'https://gist.github.com/u/abc123',
    status: 'active', author: 'me', createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(), expiresAt: null, contentHash: 'h1',
    viewCount: null, lastViewedAt: null, ...over,
  };
}

describe('IndexStore', () => {
  let store: IndexStore;
  beforeEach(() => {
    store = new IndexStore(join(mkdtempSync(join(tmpdir(), 'sd-')), 'index.json'));
  });

  it('add + get roundtrip, persists across instances', () => {
    store.add(entry());
    const again = new IndexStore(store.filePath);
    expect(again.get('abc123')?.title).toBe('Doc');
  });

  it('get unknown returns undefined; missing file yields empty store', () => {
    expect(store.get('nope')).toBeUndefined();
  });

  it('corrupt index file: starts fresh and preserves the bad file aside', () => {
    writeFileSync(store.filePath, '{not json!!', 'utf8');
    expect(store.get('anything')).toBeUndefined();
    store.add(entry());
    expect(store.get('abc123')?.title).toBe('Doc');
    expect(existsSync(`${store.filePath}.corrupt`)).toBe(true);
  });

  it('update patches fields and bumps updatedAt', () => {
    store.add(entry());
    store.update('abc123', { status: 'revoked' }, new Date('2026-07-25T11:00:00Z'));
    const e = store.get('abc123')!;
    expect(e.status).toBe('revoked');
    expect(e.updatedAt).toBe('2026-07-25T11:00:00.000Z');
  });

  it('findDuplicate: same hash within window, active only', () => {
    store.add(entry());
    const in4m = new Date(T0.getTime() + 4 * 60_000);
    const in6m = new Date(T0.getTime() + 6 * 60_000);
    expect(store.findDuplicate('h1', 5 * 60_000, in4m)?.docId).toBe('abc123');
    expect(store.findDuplicate('h1', 5 * 60_000, in6m)).toBeUndefined();
    expect(store.findDuplicate('other', 5 * 60_000, in4m)).toBeUndefined();
  });

  it('expired: active entries whose expiresAt has passed', () => {
    store.add(entry({ docId: 'e1', expiresAt: new Date(T0.getTime() + 3600e3).toISOString() }));
    store.add(entry({ docId: 'e2', expiresAt: null }));
    const later = new Date(T0.getTime() + 2 * 3600e3);
    expect(store.expired(later).map(e => e.docId)).toEqual(['e1']);
  });

  it('contentQuery match beyond the newest N is still found (filter before limit)', () => {
    store.add(entry({ docId: 'old', title: 'Old', createdAt: '2026-07-01T00:00:00Z', excerpt: 'the needle text' }));
    for (let i = 0; i < 25; i++) {
      store.add(entry({ docId: `n${i}`, title: `New ${i}`, createdAt: `2026-07-10T00:00:${String(i).padStart(2, '0')}Z` }));
    }
    const hits = store.search({ contentQuery: 'needle' }); // default limit 20
    expect(hits.entries.map(e => e.docId)).toEqual(['old']);
  });

  it('search: title substring (case-insensitive) + status filter + limit', () => {
    store.add(entry({ docId: 'a', title: 'Weekly Report' }));
    store.add(entry({ docId: 'b', title: 'weekly summary', status: 'revoked' }));
    store.add(entry({ docId: 'c', title: 'Other' }));
    expect(store.search({ titleQuery: 'weekly' }).entries.length).toBe(2);
    expect(store.search({ titleQuery: 'weekly', status: 'revoked' }).entries[0].docId).toBe('b');
    expect(store.search({ limit: 1 }).entries.length).toBe(1);
  });

  describe('offset pagination + hasMore', () => {
    beforeEach(() => {
      for (let i = 0; i < 5; i++) {
        store.add(entry({ docId: `p${i}`, title: `Page ${i}`, createdAt: `2026-07-10T00:00:0${i}Z` }));
      }
    });

    it('hasMore is true while more rows exist beyond offset+limit, false on the last page', () => {
      const page1 = store.search({ limit: 2, offset: 0 });
      expect(page1.entries.map(e => e.docId)).toEqual(['p4', 'p3']); // newest first
      expect(page1.hasMore).toBe(true);

      const page2 = store.search({ limit: 2, offset: 2 });
      expect(page2.entries.map(e => e.docId)).toEqual(['p2', 'p1']);
      expect(page2.hasMore).toBe(true);

      const page3 = store.search({ limit: 2, offset: 4 });
      expect(page3.entries.map(e => e.docId)).toEqual(['p0']);
      expect(page3.hasMore).toBe(false);
    });

    it('offset past the end returns an empty page with hasMore false', () => {
      const page = store.search({ limit: 2, offset: 50 });
      expect(page.entries).toEqual([]);
      expect(page.hasMore).toBe(false);
    });

    it('hasMore detection is exact even when limit is already at the max (100)', () => {
      for (let i = 0; i < 100; i++) {
        store.add(entry({ docId: `m${i}`, title: `Many ${i}`, createdAt: `2026-07-11T00:00:${String(i % 60).padStart(2, '0')}Z` }));
      }
      const page = store.search({ limit: 100, offset: 0 });
      expect(page.entries.length).toBe(100);
      expect(page.hasMore).toBe(true); // 105 total > 100
    });
  });
});
