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

  it('selfhost backend serves 8 tools and returns a reachable ephemeral-port URL', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sd-smoke-sh-'));
    const child = spawn('node', ['dist/index.js'], {
      env: { ...process.env, SHAREDOC_BACKEND: 'selfhost', SHAREDOC_DATA_DIR: dataDir, SHAREDOC_PORT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const send = (o: object) => child.stdin.write(JSON.stringify(o) + '\n');
    let buf = '';
    child.stdout.on('data', d => { buf += d; });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    await new Promise(r => setTimeout(r, 600));
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await new Promise(r => setTimeout(r, 600));
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'create_shared_doc', arguments: { title: 'smoke', content: 'x' } } });
    await new Promise(r => setTimeout(r, 800));
    const line = (id: number) => buf.split('\n').filter(l => l.trim().startsWith('{')).find(l => JSON.parse(l).id === id)!;
    expect((JSON.parse(line(2)).result.tools as { name: string }[]).length).toBe(8);
    // ephemeral-port regression guard (plan-advisor run 927): the returned URL must
    // point at the port the viewer actually listens on — fetch while child still alive.
    const url = JSON.parse(JSON.parse(line(3)).result.content[0].text).url as string;
    expect(url).not.toContain(':8377');
    const res = await fetch(url);
    expect(res.status).toBe(200);
    child.kill();
    await once(child, 'exit');
  }, 15_000);

  it('selfhost server exits when the MCP client closes stdin (no orphan holding the port)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sd-smoke-exit-'));
    const child = spawn('node', ['dist/index.js'], {
      env: { ...process.env, SHAREDOC_BACKEND: 'selfhost', SHAREDOC_DATA_DIR: dataDir, SHAREDOC_PORT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise(r => setTimeout(r, 600)); // let it boot
    child.stdin.end(); // client gone
    const exited = await Promise.race([
      once(child, 'exit').then(() => true),
      new Promise<false>(r => setTimeout(() => r(false), 3000)),
    ]);
    if (!exited) child.kill();
    expect(exited).toBe(true);
  }, 10_000);
});
