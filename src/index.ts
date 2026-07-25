#!/usr/bin/env node
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { statSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GistBackend, execRunner } from './backend/gist.js';
import { SelfHostBackend } from './backend/selfhost.js';
import { dbFingerprint, startViewer } from './viewer/http-server.js';
import { IndexStore } from './index-store.js';
import { buildServer } from './server.js';
import type { ShareBackend } from './backend/types.js';

const DB_SIZE_WARN_BYTES = 100 * 1024 * 1024;

function selfHostConfig(): { dbPath: string; port: number; publicUrl: string | undefined } {
  const dataDir = process.env.SHAREDOC_DATA_DIR ?? join(homedir(), '.local', 'share', 'sharedoc-mcp');
  const port = Number(process.env.SHAREDOC_PORT ?? 8377);
  return { dbPath: join(dataDir, 'docs.db'), port, publicUrl: process.env.SHAREDOC_PUBLIC_URL };
}

function warnIfDbLarge(dbPath: string): void {
  try {
    const size = statSync(dbPath).size;
    if (size > DB_SIZE_WARN_BYTES) {
      console.error(`sharedoc-mcp: docs.db is ${(size / 1024 / 1024).toFixed(0)} MB — consider delete_shared_doc on old docs`);
    }
  } catch { /* no db yet */ }
  // v1.0.0 leftovers: the removed file-sharing feature stored uploads next to the DB.
  const legacyFiles = join(dirname(dbPath), 'files');
  try {
    statSync(legacyFiles);
    console.error(`sharedoc-mcp: ${legacyFiles} is a leftover from the removed v1 file-sharing feature — no longer served, safe to delete manually`);
  } catch { /* not present — normal */ }
}

/** Verify a busy port is OUR viewer on the SAME database before trusting it (review I2). */
async function probeExistingViewer(port: number, dbPath: string): Promise<'ours' | 'other'> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    const j = await res.json() as { server?: string; db?: string };
    return j.server === 'sharedoc-mcp' && j.db === dbFingerprint(dbPath) ? 'ours' : 'other';
  } catch {
    return 'other';
  }
}

/** `sharedoc-mcp serve` — standalone viewer daemon (no MCP): links outlive MCP clients. */
async function serveDaemon(): Promise<void> {
  const { dbPath, port, publicUrl } = selfHostConfig();
  const backend = new SelfHostBackend({ dbPath, publicUrl: publicUrl ?? `http://127.0.0.1:${port}` });
  warnIfDbLarge(dbPath);
  const viewer = await startViewer(backend, { port });
  if (!publicUrl) backend.setPublicUrl(`http://127.0.0.1:${viewer.port}`);
  console.error(`sharedoc-mcp: viewer daemon listening on 127.0.0.1:${viewer.port} (localhost only — use a tunnel to share externally)`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;   // a second signal during drain must not throw (review M3)
    stopping = true;
    viewer.close().catch(() => {}).finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // No stdin handling: the daemon outlives whatever started it until signaled.
}

async function makeBackend(): Promise<ShareBackend> {
  const backendName = process.env.SHAREDOC_BACKEND ?? 'gist';
  if (backendName === 'gist') {
    const store = new IndexStore(
      process.env.SHAREDOC_INDEX_PATH ?? join(homedir(), '.config', 'sharedoc-mcp', 'index.json'));
    return new GistBackend(store, execRunner);
  }
  if (backendName === 'selfhost') {
    const { dbPath, port, publicUrl } = selfHostConfig();
    const backend = new SelfHostBackend({ dbPath, publicUrl: publicUrl ?? `http://127.0.0.1:${port}` });
    warnIfDbLarge(dbPath);
    try {
      const viewer = await startViewer(backend, { port });
      // SHAREDOC_PORT=0 (ephemeral) resolves to a real port only after listen —
      // rebind publicUrl to the actual port unless the user pinned SHAREDOC_PUBLIC_URL.
      if (!publicUrl) backend.setPublicUrl(`http://127.0.0.1:${viewer.port}`);
      console.error(`sharedoc-mcp: viewer listening on 127.0.0.1:${viewer.port} (localhost only — use a tunnel to share externally)`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        if (await probeExistingViewer(port, dbPath) === 'ours') {
          console.error(`sharedoc-mcp: port ${port} already served by another sharedoc-mcp viewer on the same database — tools stay available`);
        } else {
          console.error(`sharedoc-mcp: WARNING — port ${port} is occupied by a DIFFERENT service or a sharedoc-mcp viewer on a different database. Share links created by this process will NOT work until the conflict is resolved (change SHAREDOC_PORT or stop the other process).`);
        }
      } else {
        throw e;
      }
    }
    return backend;
  }
  console.error(`unknown SHAREDOC_BACKEND: ${backendName} (expected gist|selfhost)`);
  process.exit(1);
}

async function mcpMain(): Promise<void> {
  const server = buildServer(await makeBackend());
  await server.connect(new StdioServerTransport());
  // When the MCP client goes away (stdin closes), exit instead of letting the
  // selfhost viewer keep the process alive — an orphan would hold the port and
  // block the next client's spawn.
  process.stdin.on('close', () => process.exit(0));
  process.stdin.on('end', () => process.exit(0));
}

const main = process.argv[2] === 'serve' ? serveDaemon : mcpMain;
main().catch(e => { console.error(e); process.exit(1); });
