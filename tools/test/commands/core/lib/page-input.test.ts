import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { pageInput } from '../../../../src/commands/core/lib/page-input.ts';

/** A DevTools endpoint with two page targets that records the calls it gets. */
async function fakeDevtools(profile: string, hiddenLists = 0): Promise<{ calls: Record<string, unknown>[]; connections: () => number; close: () => void }> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const calls: Record<string, unknown>[] = [];
  let lists = 0;
  server.on('connection', (ws) => {
    ws.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString('utf8')) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
      calls.push({ method: message.method, params: message.params, sessionId: message.sessionId ?? null });
      const result: Record<string, unknown> =
        message.method === 'Target.getTargets' && lists++ < hiddenLists
          ? { targetInfos: [] }
          : message.method === 'Target.getTargets'
          ? { targetInfos: [{ type: 'page', url: 'http://127.0.0.1:9/other', targetId: 'o' }, { type: 'page', url: 'http://127.0.0.1:9/app/index.html?ogw_run_id=r', targetId: 'p' }] }
          : message.method === 'Target.attachToTarget' ? { sessionId: 's1' } : {};
      ws.send(JSON.stringify({ id: message.id, result }));
    });
  });
  writeFileSync(join(profile, 'DevToolsActivePort'), `${String((server.address() as AddressInfo).port)}\n/devtools/browser/x\n`);
  return { calls, connections: () => [...server.clients].length, close: () => { server.close(); } };
}

describe('pageInput', () => {
  it('attaches to the run page at the first input and dispatches a left click and a key press to it', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ogw-page-input-'));
    const devtools = await fakeDevtools(profile);
    const input = pageInput(profile, 'http://127.0.0.1:9/app/index.html', () => null);
    try {
      await input.put({ type: 'click', x: 12, y: 34 });
      await input.put({ type: 'key', key: 'a' });
      await input.put({ type: 'key', key: 'Enter' });
      expect(devtools.calls).toEqual([
        { method: 'Target.getTargets', params: {}, sessionId: null },
        { method: 'Target.attachToTarget', params: { targetId: 'p', flatten: true }, sessionId: null },
        { method: 'Browser.grantPermissions', params: { permissions: ['clipboardSanitizedWrite'], origin: 'http://127.0.0.1:9' }, sessionId: null },
        { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 12, y: 34, button: 'left', clickCount: 1 }, sessionId: 's1' },
        { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 12, y: 34, button: 'left', clickCount: 1 }, sessionId: 's1' },
        { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'a', text: 'a' }, sessionId: 's1' },
        { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'a' }, sessionId: 's1' },
        { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Enter' }, sessionId: 's1' },
        { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'Enter' }, sessionId: 's1' },
      ]);
    } finally {
      input.close();
      devtools.close();
    }
  });

  it('tries the DevTools open again after a failed one, without leaving the failed connection open', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ogw-page-input-'));
    const devtools = await fakeDevtools(profile, 1);
    const input = pageInput(profile, 'http://127.0.0.1:9/app/index.html', () => null);
    try {
      await expect(input.put({ type: 'key', key: 'a' })).rejects.toThrow('no browser page at http://127.0.0.1:9/app/index.html');
      await input.put({ type: 'key', key: 'a' });
      expect(devtools.calls.filter((c) => c.method === 'Input.dispatchKeyEvent')).toHaveLength(2);
      await new Promise((r) => setTimeout(r, 100));
      expect(devtools.connections()).toBe(1);
    } finally {
      input.close();
      devtools.close();
    }
  });

  it('fails with the browser end reason when the browser is gone before it gave its DevTools port', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ogw-page-input-'));
    const input = pageInput(profile, 'http://127.0.0.1:9/app/index.html', () => 'headless browser ended with 1');
    await expect(input.put({ type: 'key', key: 'a' })).rejects.toThrow('headless browser ended with 1');
    input.close();
  });
});
