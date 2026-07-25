#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GistBackend, execRunner } from './backend/gist.js';
import { IndexStore } from './index-store.js';
import { buildServer } from './server.js';

const backendName = process.env.SHAREDOC_BACKEND ?? 'gist';

async function main(): Promise<void> {
  if (backendName === 'selfhost') {
    console.error('selfhost backend ships in the next milestone — set SHAREDOC_BACKEND=gist for now');
    process.exit(1);
  }
  if (backendName !== 'gist') {
    console.error(`unknown SHAREDOC_BACKEND: ${backendName} (expected gist|selfhost)`);
    process.exit(1);
  }
  const store = new IndexStore(
    process.env.SHAREDOC_INDEX_PATH ?? join(homedir(), '.config', 'sharedoc-mcp', 'index.json'));
  const server = buildServer(new GistBackend(store, execRunner));
  await server.connect(new StdioServerTransport());
}

main().catch(e => { console.error(e); process.exit(1); });
