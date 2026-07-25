import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DocRecord, DocStatus } from './backend/types.js';

export interface IndexEntry extends DocRecord {
  contentHash: string;
  filename?: string;
}

/** Tiny JSON-file document index. Atomic writes (tmp + rename). */
export class IndexStore {
  constructor(public readonly filePath: string) {}

  private load(): IndexEntry[] {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private save(entries: IndexEntry[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
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

  search(p: { titleQuery?: string; status?: DocStatus; limit?: number }): IndexEntry[] {
    const q = (p.titleQuery ?? '').toLowerCase();
    const limit = Math.min(p.limit ?? 20, 100);
    return this.load()
      .filter(e => (q === '' || e.title.toLowerCase().includes(q)))
      .filter(e => (p.status === undefined || e.status === p.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
}
