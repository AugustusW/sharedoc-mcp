import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { IndexStore } from '../index-store.js';
import {
  BackendError, type BackendCapabilities, type CreateDocParams,
  type DocRecord, type SearchParams, type ShareBackend,
} from './types.js';

export type CommandRunner = (argv: string[], input?: string)
  => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** Real runner: spawns argv[0] with argv.slice(1), optional stdin. */
export const execRunner: CommandRunner = (argv, input) =>
  new Promise(resolve => {
    const child = execFile(argv[0], argv.slice(1), { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let exitCode = child.exitCode ?? 0;
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') exitCode = 127;
        else if (err && exitCode === 0) exitCode = 1;
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode });
      });
    if (input !== undefined) child.stdin?.end(input); else child.stdin?.end();
  });

export function slugify(title: string): string {
  const kept = title.replace(/[^A-Za-z0-9 _-]/g, '').trim().toLowerCase()
    .replace(/[ -]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return kept || 'doc';
}

const DEDUP_WINDOW_MS = 5 * 60_000;

export class GistBackend implements ShareBackend {
  constructor(
    private store: IndexStore,
    private run: CommandRunner,
    private now: () => Date = () => new Date(),
  ) {}

  capabilities(): BackendCapabilities {
    return { password: 'none', expiry: 'lazy', revoke: 'hard-delete' };
  }

  private async gh(args: string[], input?: string): Promise<string> {
    const r = await this.run(['gh', ...args], input);
    if (r.exitCode === 127) {
      throw new BackendError('GitHub CLI (`gh`) not found. Install it (https://cli.github.com) and run `gh auth login`.');
    }
    if (r.exitCode !== 0) {
      throw new BackendError(`gh ${args[0]} failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
    }
    return r.stdout;
  }

  private async lazyCleanup(): Promise<void> {
    for (const e of this.store.expired(this.now())) {
      try {
        await this.gh(['gist', 'delete', e.docId, '--yes']);
      } catch { /* best-effort: gist may already be gone */ }
      this.store.update(e.docId, { status: 'expired' }, this.now());
    }
  }

  async createDoc(p: CreateDocParams): Promise<{ url: string }> {
    if (p.password) {
      throw new BackendError('The gist backend does not support passwords — the secret URL itself is the protection. Switch to the selfhost backend (SHAREDOC_BACKEND=selfhost) for password support.');
    }
    await this.lazyCleanup();
    const now = this.now();
    const hash = createHash('sha256')
      .update(`${p.title}\0${p.content}\0${p.author ?? ''}`).digest('hex');
    // Same guard as selfhost: only dedup expiry-free retries against expiry-free docs,
    // so a retry that adds an expiry never silently reuses the everlasting URL.
    if (p.expiresInHours == null) {
      const dup = this.store.findDuplicate(hash, DEDUP_WINDOW_MS, now);
      if (dup && dup.expiresAt === null) return { url: dup.url };
    }

    const filename = `${slugify(p.title)}.md`;
    const out = await this.gh(['gist', 'create', '--filename', filename, '--desc', p.title, '-'], p.content);
    const url = out.trim().split('\n').pop() ?? '';
    const docId = url.split('/').pop() ?? '';
    if (!docId) throw new BackendError(`could not parse gist URL from gh output: ${out.slice(0, 200)}`);

    this.store.add({
      docId, title: p.title, url, status: 'active', author: p.author ?? null,
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
      expiresAt: p.expiresInHours ? new Date(now.getTime() + p.expiresInHours * 3600e3).toISOString() : null,
      contentHash: hash, filename, excerpt: p.content.slice(0, 200),
    });
    return { url };
  }

  private mustGet(docId: string) {
    const e = this.store.get(docId);
    if (!e) throw new BackendError(`doc ${docId} not found in local index — it was not created by this backend on this machine.`);
    if (e.status !== 'active') throw new BackendError(`doc ${docId} is ${e.status}.`);
    return e;
  }

  async appendDoc(docId: string, content: string): Promise<void> {
    await this.lazyCleanup();
    const e = this.mustGet(docId);
    const filename = e.filename ?? `${slugify(e.title)}.md`;
    const raw = await this.gh(['api', `gists/${docId}`]);
    let file: { content?: string; truncated?: boolean } | undefined;
    try {
      file = JSON.parse(raw).files?.[filename];
    } catch {
      throw new BackendError(`could not parse gist ${docId} API response`);
    }
    if (!file) throw new BackendError(`gist ${docId} has no file named ${filename}`);
    if (file.truncated) {
      throw new BackendError(`gist ${docId} content is truncated by the GitHub API (file too large) — append refused to avoid data loss. Create a new doc instead.`);
    }
    const current = file.content ?? '';
    const body = JSON.stringify({ files: { [filename]: { content: current.replace(/\n$/, '') + content } } });
    await this.gh(['api', `gists/${docId}`, '-X', 'PATCH', '--input', '-'], body);
    this.store.update(docId, {}, this.now());
  }

  async extendDoc(docId: string, hours: number): Promise<void> {
    this.mustGet(docId);
    this.store.update(docId, {
      expiresAt: new Date(this.now().getTime() + hours * 3600e3).toISOString(),
    }, this.now());
  }

  async resetPassword(): Promise<void> {
    throw new BackendError('The gist backend does not support passwords. Switch to the selfhost backend.');
  }

  async updateTitle(docId: string, newTitle: string): Promise<void> {
    if (!newTitle.trim()) throw new BackendError('title must not be empty');
    this.mustGet(docId);
    const body = JSON.stringify({ description: newTitle });
    await this.gh(['api', `gists/${docId}`, '-X', 'PATCH', '--input', '-'], body);
    this.store.update(docId, { title: newTitle }, this.now());
  }

  async revokeDoc(docId: string): Promise<void> {
    this.mustGet(docId);
    await this.gh(['gist', 'delete', docId, '--yes']);
    this.store.update(docId, { status: 'revoked' }, this.now());
  }

  async deleteDoc(docId: string): Promise<void> {
    const e = this.store.get(docId);
    if (!e) throw new BackendError(`doc ${docId} not found in local index.`);
    if (e.status === 'active') {
      try {
        await this.gh(['gist', 'delete', docId, '--yes']);
      } catch { /* gist may already be gone — the index cleanup is the point */ }
    }
    this.store.remove(docId);
  }

  async searchDocs(p: SearchParams): Promise<DocRecord[]> {
    await this.lazyCleanup();
    const cq = (p.contentQuery ?? '').toLowerCase();
    return this.store.search(p)
      .filter(e => cq === '' || (e.excerpt ?? '').toLowerCase().includes(cq))
      // Map IndexEntry → DocRecord: internal fields (contentHash, filename, excerpt) stay internal.
      .map(({ docId, title, url, status, author, createdAt, updatedAt, expiresAt }) =>
        ({ docId, title, url, status, author, createdAt, updatedAt, expiresAt }));
  }
}
