#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GistBackend, execRunner } from './backend/gist.js';
import { SelfHostBackend } from './backend/selfhost.js';
import { startViewer } from './viewer/http-server.js';
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
}

/** `sharedoc-mcp serve` — standalone viewer daemon (no MCP): links outlive MCP clients. */
async function serveDaemon(): Promise<void> {
  const { dbPath, port, publicUrl } = selfHostConfig();
  const backend = new SelfHostBackend({ dbPath, publicUrl: publicUrl ?? `http://127.0.0.1:${port}` });
  warnIfDbLarge(dbPath);
  const viewer = await startViewer(backend, { port });
  if (!publicUrl) backend.setPublicUrl(`http://127.0.0.1:${viewer.port}`);
  console.error(`sharedoc-mcp: viewer daemon listening on 127.0.0.1:${viewer.port} (localhost only — use a tunnel to share externally)`);
  const stop = async () => { await viewer.close(); process.exit(0); };
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
        // A `serve` daemon (or another client) already owns this port — with a shared
        // data dir its viewer serves the same docs, so keep the tool layer alive.
        console.error(`sharedoc-mcp: port ${port} already in use — assuming another sharedoc-mcp viewer is serving; tools stay available`);
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
