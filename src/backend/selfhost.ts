import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import bcrypt from 'bcryptjs';
import {
  BackendError, type BackendCapabilities, type CreateDocParams,
  type DocRecord, type SearchParams, type ShareBackend,
} from './types.js';

const DEDUP_WINDOW_MS = 5 * 60_000;
const GRACE_MS = 7 * 24 * 3600e3;

export interface SelfHostOpts {
  dbPath: string;
  publicUrl: string;
  now?: () => Date;
}

export class SelfHostBackend implements ShareBackend {
  readonly dbPath: string;
  private db: DatabaseSync;
  private publicUrl: string;
  private now: () => Date;

  constructor(opts: SelfHostOpts) {
    this.dbPath = opts.dbPath;
    this.publicUrl = opts.publicUrl.replace(/\/$/, '');
    this.now = opts.now ?? (() => new Date());
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    // Two MCP clients may share this DB file: WAL + busy_timeout turn lock
    // contention into short waits instead of instant "database is locked" errors.
    this.db.exec(`PRAGMA journal_mode = WAL`);
    this.db.exec(`PRAGMA busy_timeout = 5000`);
    this.migrate();
  }

  /** user_version-gated migrations: append new statements, never edit shipped ones. */
  private migrate(): void {
    const migrations: string[] = [
      `CREATE TABLE IF NOT EXISTS docs (
        docId TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT,
        passwordHash TEXT, status TEXT NOT NULL DEFAULT 'active',
        author TEXT, contentHash TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        expiresAt TEXT, revokedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS files (
        key TEXT PRIMARY KEY, path TEXT NOT NULL, filename TEXT NOT NULL,
        contentType TEXT, createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_docs_status ON docs(status);`,
      // v2.0.0: file sharing removed (prompt-injection exfiltration vector);
      // rate-limit state moves into SQLite so a restart can't reset counters.
      `DROP TABLE IF EXISTS files;
      CREATE TABLE IF NOT EXISTS rateLimits (
        key TEXT PRIMARY KEY, windowStart INTEGER NOT NULL, count INTEGER NOT NULL
      );`,
    ];
    const current = (this.db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version;
    for (let v = current; v < migrations.length; v++) {
      this.db.exec(migrations[v]);
      this.db.exec(`PRAGMA user_version = ${v + 1}`);
    }
  }

  capabilities(): BackendCapabilities {
    return { password: 'server', expiry: 'enforced', revoke: 'grace' };
  }

  /** SQLite-backed fixed-window rate limiter — counters survive restarts. */
  rateAllow(key: string, capacity = 5, windowMs = 60_000): boolean {
    const t = this.now().getTime();
    this.db.prepare(`DELETE FROM rateLimits WHERE windowStart < ?`).run(t - windowMs);
    const row = this.db.prepare(`SELECT windowStart, count FROM rateLimits WHERE key = ?`).get(key) as { windowStart: number; count: number } | undefined;
    if (!row || t - row.windowStart >= windowMs) {
      this.db.prepare(`INSERT INTO rateLimits (key, windowStart, count) VALUES (?, ?, 1)
        ON CONFLICT(key) DO UPDATE SET windowStart = excluded.windowStart, count = 1`).run(key, t);
      return true;
    }
    if (row.count >= capacity) return false;
    this.db.prepare(`UPDATE rateLimits SET count = count + 1 WHERE key = ?`).run(key);
    return true;
  }

  rateRetryAfterSeconds(key: string, windowMs = 60_000): number {
    const row = this.db.prepare(`SELECT windowStart FROM rateLimits WHERE key = ?`).get(key) as { windowStart: number } | undefined;
    if (!row) return 0;
    return Math.max(1, Math.ceil((row.windowStart + windowMs - this.now().getTime()) / 1000));
  }

  /** Rebind the public URL after an ephemeral port resolves (SHAREDOC_PORT=0). */
  setPublicUrl(url: string): void {
    this.publicUrl = url.replace(/\/$/, '');
  }

  private lastHousekeepingMs = 0;

  /** Purge content of docs revoked more than GRACE_MS ago, and mark expired docs.
   *  Debounced: at most once per 60s per instance — every viewer GET calls into here. */
  private housekeeping(): void {
    if (this.now().getTime() - this.lastHousekeepingMs < 60_000) return;
    this.lastHousekeepingMs = this.now().getTime();
    const nowIso = this.now().toISOString();
    const cutoff = new Date(this.now().getTime() - GRACE_MS).toISOString();
    this.db.prepare(`UPDATE docs SET content = NULL, updatedAt = ? WHERE status = 'revoked' AND revokedAt < ? AND content IS NOT NULL`).run(nowIso, cutoff);
    this.db.prepare(`UPDATE docs SET status = 'expired', updatedAt = ? WHERE status = 'active' AND expiresAt IS NOT NULL AND expiresAt < ?`).run(nowIso, nowIso);
  }

  /** Raw row access for the HTTP viewer (read-only). */
  docRow(docId: string): { title: string; content: string | null; passwordHash: string | null; status: string; expiresAt: string | null } | undefined {
    this.housekeeping();
    const r = this.db.prepare(`SELECT title, content, passwordHash, status, expiresAt FROM docs WHERE docId = ?`).get(docId) as never;
    return r ?? undefined;
  }

  private mustActive(docId: string): void {
    this.housekeeping();
    const r = this.db.prepare(`SELECT status FROM docs WHERE docId = ?`).get(docId) as { status: string } | undefined;
    if (!r) throw new BackendError(`doc ${docId} not found`);
    if (r.status !== 'active') throw new BackendError(`doc ${docId} is ${r.status}`);
  }

  async createDoc(p: CreateDocParams): Promise<{ url: string }> {
    this.housekeeping();
    const now = this.now();
    const hash = createHash('sha256').update(`${p.title}\0${p.content}\0${p.author ?? ''}`).digest('hex');
    // Dedup only fully-unprotected creations matching a fully-unprotected doc:
    // a retry that ADDS a password/expiry must never silently return the old
    // unprotected URL (code-review finding — security expectation mismatch).
    if (!p.password && p.expiresInHours == null) {
      const windowStart = new Date(now.getTime() - DEDUP_WINDOW_MS).toISOString();
      const dup = this.db.prepare(`SELECT docId FROM docs WHERE status = 'active' AND contentHash = ? AND createdAt > ? AND passwordHash IS NULL AND expiresAt IS NULL`).get(hash, windowStart) as { docId: string } | undefined;
      if (dup) return { url: `${this.publicUrl}/docs/${dup.docId}` };
    }

    const docId = randomUUID();
    const nowIso = now.toISOString();
    this.db.prepare(`INSERT INTO docs (docId, title, content, passwordHash, status, author, contentHash, createdAt, updatedAt, expiresAt) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`).run(
      docId, p.title, p.content,
      p.password ? bcrypt.hashSync(p.password, 10) : null,
      p.author ?? null, hash, nowIso, nowIso,
      p.expiresInHours ? new Date(now.getTime() + p.expiresInHours * 3600e3).toISOString() : null,
    );
    return { url: `${this.publicUrl}/docs/${docId}` };
  }

  async appendDoc(docId: string, content: string): Promise<void> {
    this.mustActive(docId);
    this.db.prepare(`UPDATE docs SET content = COALESCE(content, '') || ?, updatedAt = ? WHERE docId = ?`).run(content, this.now().toISOString(), docId);
  }

  async extendDoc(docId: string, hours: number): Promise<void> {
    this.mustActive(docId);
    this.db.prepare(`UPDATE docs SET expiresAt = ?, updatedAt = ? WHERE docId = ?`).run(
      new Date(this.now().getTime() + hours * 3600e3).toISOString(), this.now().toISOString(), docId);
  }

  async resetPassword(docId: string, newPassword: string | null): Promise<void> {
    this.mustActive(docId);
    this.db.prepare(`UPDATE docs SET passwordHash = ?, updatedAt = ? WHERE docId = ?`).run(
      newPassword ? bcrypt.hashSync(newPassword, 10) : null, this.now().toISOString(), docId);
  }

  async updateTitle(docId: string, newTitle: string): Promise<void> {
    if (!newTitle.trim()) throw new BackendError('title must not be empty');
    this.mustActive(docId);
    this.db.prepare(`UPDATE docs SET title = ?, updatedAt = ? WHERE docId = ?`).run(newTitle, this.now().toISOString(), docId);
  }

  async revokeDoc(docId: string): Promise<void> {
    this.mustActive(docId);
    const nowIso = this.now().toISOString();
    this.db.prepare(`UPDATE docs SET status = 'revoked', revokedAt = ?, updatedAt = ? WHERE docId = ?`).run(nowIso, nowIso, docId);
  }

  async searchDocs(p: SearchParams): Promise<DocRecord[]> {
    this.housekeeping();
    const limit = Math.min(p.limit ?? 20, 100);
    const q = (p.titleQuery ?? '').replace(/[%_\\]/g, c => `\\${c}`);
    const rows = this.db.prepare(`
      SELECT docId, title, status, author, createdAt, updatedAt, expiresAt FROM docs
      WHERE (? = '' OR lower(title) LIKE '%' || lower(?) || '%' ESCAPE '\\')
        AND (? IS NULL OR status = ?)
      ORDER BY createdAt DESC LIMIT ?`).all(
      q, q, p.status ?? null, p.status ?? null, limit) as never[];
    return (rows as Array<Omit<DocRecord, 'url'>>).map(r => ({ ...r, url: `${this.publicUrl}/docs/${r.docId}` }));
  }
}
