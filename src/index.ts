#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GistBackend, execRunner } from './backend/gist.js';
import { SelfHostBackend } from './backend/selfhost.js';
import { startViewer } from './viewer/http-server.js';
import { IndexStore } from './index-store.js';
import { buildServer } from './server.js';
import type { ShareBackend } from './backend/types.js';

const backendName = process.env.SHAREDOC_BACKEND ?? 'gist';

async function makeBackend(): Promise<ShareBackend> {
  if (backendName === 'gist') {
    const store = new IndexStore(
      process.env.SHAREDOC_INDEX_PATH ?? join(homedir(), '.config', 'sharedoc-mcp', 'index.json'));
    return new GistBackend(store, execRunner);
  }
  if (backendName === 'selfhost') {
    const dataDir = process.env.SHAREDOC_DATA_DIR ?? join(homedir(), '.local', 'share', 'sharedoc-mcp');
    const port = Number(process.env.SHAREDOC_PORT ?? 8377);
    const backend = new SelfHostBackend({
      dbPath: join(dataDir, 'docs.db'),
      publicUrl: process.env.SHAREDOC_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
    });
    try {
      const viewer = await startViewer(backend, { port });
      // SHAREDOC_PORT=0 (ephemeral) resolves to a real port only after listen —
      // rebind publicUrl to the actual port unless the user pinned SHAREDOC_PUBLIC_URL.
      if (!process.env.SHAREDOC_PUBLIC_URL) {
        backend.setPublicUrl(`http://127.0.0.1:${viewer.port}`);
      }
      console.error(`sharedoc-mcp: viewer listening on 127.0.0.1:${viewer.port} (localhost only — use a tunnel to share externally)`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        // Another MCP client on this machine is already serving this port —
        // with a shared data dir its viewer serves the same docs, so keep the
        // tool layer alive instead of killing the whole process.
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

async function main(): Promise<void> {
  const server = buildServer(await makeBackend());
  await server.connect(new StdioServerTransport());
  // When the MCP client goes away (stdin closes), exit instead of letting the
  // selfhost viewer keep the process alive — an orphan would hold the port and
  // block the next client's spawn.
  process.stdin.on('close', () => process.exit(0));
  process.stdin.on('end', () => process.exit(0));
}

main().catch(e => { console.error(e); process.exit(1); });
