import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DocRecord, DocStatus } from './backend/types.js';

export interface IndexEntry extends DocRecord {
  contentHash: string;
  filename?: string;
  /** Opening excerpt of the content at creation time — the only body text searchable on gist. */
  excerpt?: string;
}

/** Tiny JSON-file document index. Atomic writes (tmp + rename). */
export class IndexStore {
  constructor(public readonly filePath: string) {}

  private load(): IndexEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return []; // no index yet
    }
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      // Corrupt index: preserve the evidence instead of silently overwriting it.
      const aside = `${this.filePath}.corrupt`;
      console.error(`sharedoc-mcp: index file ${this.filePath} is corrupt (${(e as Error).message}); moving it aside to ${aside} and starting fresh`);
      try { renameSync(this.filePath, aside); } catch { /* best effort */ }
      return [];
    }
  }

  private save(entries: IndexEntry[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    // Unique temp name per write: two processes sharing the index (e.g. two MCP
    // clients) must not clobber each other's in-flight temp file. Rename stays
    // atomic; concurrent writers degrade to last-writer-wins.
    const tmp = `${this.filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries, null, 2));
    renameSync(tmp, this.filePath);
  }

  add(entry: IndexEntry): void {
    const entries = this.load().filter(e => e.docId !== entry.docId);
    entries.push(entry);
    this.save(entries);
  }

  get(docId: string): IndexEntry | undefined {
    return this.load().find(e => e.docId === docId);
  }

  remove(docId: string): void {
    this.save(this.load().filter(e => e.docId !== docId));
  }

  update(docId: string, patch: Partial<IndexEntry>, now: Date = new Date()): void {
    this.save(this.load().map(e =>
      e.docId === docId ? { ...e, ...patch, updatedAt: now.toISOString() } : e));
  }

  findDuplicate(hash: string, windowMs: number, now: Date): IndexEntry | undefined {
    return this.load().find(e =>
      e.status === 'active' && e.contentHash === hash &&
      now.getTime() - Date.parse(e.createdAt) < windowMs);
  }

  expired(now: Date): IndexEntry[] {
    return this.load().filter(e =>
      e.status === 'active' && e.expiresAt !== null && Date.parse(e.expiresAt) < now.getTime());
  }

  /** Filter (title + status + excerpt) → sort → limit. The limit is applied LAST so a
   *  content match beyond the newest N is still found (review: filter-before-limit). */
  search(p: { titleQuery?: string; contentQuery?: string; status?: DocStatus; limit?: number }): IndexEntry[] {
    const q = (p.titleQuery ?? '').toLowerCase();
    const cq = (p.contentQuery ?? '').toLowerCase();
    const limit = Math.min(p.limit ?? 20, 100);
    return this.load()
      .filter(e => (q === '' || e.title.toLowerCase().includes(q)))
      .filter(e => (cq === '' || (e.excerpt ?? '').toLowerCase().includes(cq)))
      .filter(e => (p.status === undefined || e.status === p.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
}
