import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('stdio smoke (built dist)', () => {
  it('answers initialize and lists 8 tools', async () => {
    const indexPath = join(mkdtempSync(join(tmpdir(), 'sd-smoke-')), 'index.json');
    const child = spawn('node', ['dist/index.js'], {
      env: { ...process.env, SHAREDOC_BACKEND: 'gist', SHAREDOC_INDEX_PATH: indexPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const send = (o: object) => child.stdin.write(JSON.stringify(o) + '\n');
    let buf = '';
    child.stdout.on('data', d => { buf += d; });

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    await new Promise(r => setTimeout(r, 400));
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await new Promise(r => setTimeout(r, 400));
    child.kill();
    await once(child, 'exit');

    expect(buf).toContain('"serverInfo"');
    const toolsLine = buf.split('\n')
      .filter(l => l.trim().startsWith('{'))
      .find(l => JSON.parse(l).id === 2)!;
    const names = (JSON.parse(toolsLine).result.tools as { name: string }[]).map(t => t.name);
    expect(names.length).toBe(8);
    expect(names).toContain('create_shared_doc');
  }, 15_000);
});
