import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downloadAllowed, unpinnedItems } from '../../../src/commands/core/pin-engine.ts';
import { ogw, makeWorkspace, sh } from '../../helpers/workspace.ts';
import { sha256, writeFiles } from './helpers.ts';

let server: Server;
let base = '';
/** `/slow` answers when the test calls this; `slowStarted` resolves when `/slow` is requested. */
let releaseSlow: () => void = () => undefined;
let slowStarted: Promise<void> = Promise.resolve();
let slowRequested: () => void = () => undefined;

function armSlow(): void {
  slowStarted = new Promise<void>((resolve) => {
    slowRequested = resolve;
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/missing') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/target' });
      res.end();
      return;
    }
    if (req.url === '/redirect-insecure') {
      res.writeHead(302, { location: 'http://example.invalid/plugin.zip' });
      res.end();
      return;
    }
    if (req.url === '/slow') {
      releaseSlow = () => {
        res.writeHead(200);
        res.end('content of /slow');
      };
      slowRequested();
      return;
    }
    res.writeHead(200);
    res.end(`content of ${String(req.url)}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
});

function engineJson(): Record<string, unknown> {
  return {
    godot: '4.5.1.stable',
    downloads: [
      { platform: 'macos-arm64', url: `${base}/editor-mac`, sha256: '' },
      { platform: 'any', url: `${base}/templates`, sha256: 'kept' },
    ],
    buildTools: [{ name: 'jdk', downloads: [{ platform: 'linux-x64', url: `${base}/jdk` }] }, { name: 'xcode' }],
    gut: { version: '9.4.0', url: `${base}/gut`, sha256: '' },
    plugins: [
      { name: 'webrtc-native', url: `${base}/webrtc`, sha256: '' },
      { name: 'ogw-secure-storage', url: '', sha256: '' },
    ],
  };
}

describe('ogw core pin-engine', () => {
  it('lists the items without sha256', () => {
    const items = unpinnedItems(engineJson());
    expect(items.map((i) => i.url)).toEqual([`${base}/editor-mac`, `${base}/jdk`, `${base}/gut`, `${base}/webrtc`]);
    expect(unpinnedItems({})).toEqual([]);
  });

  it('downloads each unpinned item and writes its SHA-256', async () => {
    const ws = makeWorkspace();
    writeFiles(ws.coreImpl, { 'client/godot/engine.json': engineJson() });
    const run = await ogw(ws, ['core', 'pin-engine', 'godot']);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(`pinned:\n${base}/editor-mac\n${base}/jdk\n${base}/gut\n${base}/webrtc\n`);
    const written = JSON.parse(readFileSync(join(ws.coreImpl, 'client/godot/engine.json'), 'utf8')) as ReturnType<typeof engineJson> & {
      downloads: { sha256: string }[];
      buildTools: { downloads?: { sha256: string }[] }[];
      plugins: { sha256: string }[];
      gut: { sha256: string };
    };
    expect(written.gut.sha256).toBe(sha256('content of /gut'));
    expect(written.downloads.map((d) => d.sha256)).toEqual([sha256('content of /editor-mac'), 'kept']);
    expect(written.buildTools[0]?.downloads?.[0]?.sha256).toBe(sha256('content of /jdk'));
    expect(written.plugins.map((p) => p.sha256)).toEqual([sha256('content of /webrtc'), '']);
    expect((await ogw(ws, ['core', 'pin-engine', 'godot'])).stdout).toBe('nothing to pin\n');
  });

  it('writes nothing when a download fails', async () => {
    const ws = makeWorkspace();
    const json = engineJson();
    (json.downloads as { url: string }[])[0] = { url: `${base}/missing` };
    (json.plugins as Record<string, string>[]).push({ name: 'other', sha256: '' });
    writeFiles(ws.coreImpl, { 'client/godot/engine.json': json });
    const before = readFileSync(join(ws.coreImpl, 'client/godot/engine.json'), 'utf8');
    const run = await ogw(ws, ['core', 'pin-engine', 'godot', '--json']);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({ error: expect.stringContaining('download failed, engine.json not written') as string, data: { failed: ['(item without url)', `${base}/missing`] } });
    expect(readFileSync(join(ws.coreImpl, 'client/godot/engine.json'), 'utf8')).toBe(before);
  });

  it('fetches only https URLs, or http URLs of a loopback host, along the whole redirect chain', async () => {
    expect(downloadAllowed('https://example.com/plugin.zip')).toBe(true);
    expect(downloadAllowed('http://127.0.0.1:8080/x')).toBe(true);
    expect(downloadAllowed('http://localhost/x')).toBe(true);
    expect(downloadAllowed('http://[::1]/x')).toBe(true);
    expect(downloadAllowed('http://example.com/plugin.zip')).toBe(false);
    expect(downloadAllowed('ftp://example.com/plugin.zip')).toBe(false);
    expect(downloadAllowed('not a url')).toBe(false);
    const ws = makeWorkspace();
    writeFiles(ws.coreImpl, {
      'client/godot/engine.json': {
        downloads: [{ url: `${base}/redirect`, sha256: '' }],
        plugins: [
          { name: 'plain', url: 'http://example.invalid/plugin.zip', sha256: '' },
          { name: 'bounced', url: `${base}/redirect-insecure`, sha256: '' },
        ],
      },
    });
    const before = readFileSync(join(ws.coreImpl, 'client/godot/engine.json'), 'utf8');
    const run = await ogw(ws, ['core', 'pin-engine', 'godot', '--json']);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({
      error: `download failed, engine.json not written:\n${base}/redirect-insecure: not an https URL: http://example.invalid/plugin.zip\nhttp://example.invalid/plugin.zip: not an https URL: http://example.invalid/plugin.zip`,
      data: { failed: [`${base}/redirect-insecure`, 'http://example.invalid/plugin.zip'] },
    });
    expect(readFileSync(join(ws.coreImpl, 'client/godot/engine.json'), 'utf8')).toBe(before);
    writeFiles(ws.coreImpl, { 'client/godot/engine.json': { downloads: [{ url: `${base}/redirect`, sha256: '' }] } });
    expect((await ogw(ws, ['core', 'pin-engine', 'godot'])).code).toBe(0);
    expect(readFileSync(join(ws.coreImpl, 'client/godot/engine.json'), 'utf8')).toContain(sha256('content of /target'));
  });

  it('keeps changes made to engine.json during a download', async () => {
    const ws = makeWorkspace();
    const path = join(ws.coreImpl, 'client/godot/engine.json');
    writeFiles(ws.coreImpl, { 'client/godot/engine.json': { godot: '4.5.1.stable', plugins: [{ name: 'p1', url: `${base}/slow`, sha256: '' }] } });
    armSlow();
    const running = ogw(ws, ['core', 'pin-engine', 'godot']);
    await slowStarted;
    const changed = {
      godot: '4.5.2.stable',
      plugins: [
        { name: 'p1', url: `${base}/slow`, sha256: '' },
        { name: 'p2', url: `${base}/p2`, sha256: 'pinned-by-another-job' },
        { name: 'p3', url: `${base}/p3`, sha256: '' },
      ],
    };
    writeFileSync(path, `${JSON.stringify(changed, null, 2)}\n`);
    releaseSlow();
    const run = await running;
    expect(run.code).toBe(1);
    expect(run.stderr).toBe(`engine.json changed during the downloads; run ogw core pin-engine godot again to pin:\n${base}/p3\n`);
    const written = JSON.parse(readFileSync(path, 'utf8')) as typeof changed;
    expect(written.godot).toBe('4.5.2.stable');
    expect(written.plugins.map((p) => [p.name, p.sha256])).toEqual([['p1', sha256('content of /slow')], ['p2', 'pinned-by-another-job'], ['p3', '']]);
  });

  it('uses the core worktree it runs in and rejects bad engines', async () => {
    const ws = makeWorkspace();
    const wt = join(ws.worktrees, '_core', 'a1');
    sh(ws.coreImpl, 'git', ['worktree', 'add', '--quiet', '--detach', wt]);
    writeFiles(wt, { 'client/godot/engine.json': { downloads: [{ url: `${base}/x`, sha256: '' }] } });
    expect((await ogw(ws, ['core', 'pin-engine', 'godot'], { cwd: wt })).code).toBe(0);
    expect(readFileSync(join(wt, 'client/godot/engine.json'), 'utf8')).toContain(sha256('content of /x'));
    expect((await ogw(ws, ['core', 'pin-engine', 'Godot!'])).stderr).toContain('invalid engine: Godot!');
    expect((await ogw(ws, ['core', 'pin-engine', 'unity'])).stderr).toContain(`not found: ${join(ws.coreImpl, 'client', 'unity', 'engine.json')}`);
  });
});
