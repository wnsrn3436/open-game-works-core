// A fake headless Chromium: a Chrome DevTools Protocol endpoint (DevToolsActivePort in --user-data-dir).
// Page.navigate fetches the page (the fake web export holds the launch values JSON) and starts the fake client.
// FAKE_DIR/chromium.jsonl gets the calls. FAKE_CHROMIUM_CONSOLE (JSON list) is sent as console calls;
// FAKE_CHROMIUM_CRASH crashes the page after the navigation; FAKE_CHROMIUM_EXIT ends the browser at once;
// FAKE_CHROMIUM_THROTTLE_ERROR refuses the CPU throttle; FAKE_CHROMIUM_NAV_ERROR fails the navigation.
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

interface Message {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

const env = process.env;
const dir = env.FAKE_DIR ?? '';
const profile = process.argv.find((a) => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length) ?? '';
const log = (entry: unknown): void => {
  appendFileSync(join(dir, 'chromium.jsonl'), `${JSON.stringify(entry)}\n`);
};
log({ argv: process.argv.slice(2) });
if (env.FAKE_CHROMIUM_EXIT) process.exit(Number(env.FAKE_CHROMIUM_EXIT));

async function navigate(socket: WebSocket, url: string, reply: (result: unknown) => void): Promise<void> {
  const event = (method: string, params: unknown, sessionId: string): void => {
    socket.send(JSON.stringify({ method, params, sessionId }));
  };
  if (env.FAKE_CHROMIUM_NAV_ERROR) {
    reply({ frameId: 'F1', errorText: 'net::ERR_CONNECTION_REFUSED' });
    return;
  }
  const response = await fetch(url);
  const text = await response.text();
  const folder = await fetch(new URL('/', url));
  const post = await fetch(url, { method: 'POST' });
  log({ page: url, status: response.status, type: response.headers.get('content-type'), root: folder.status, post: post.status });
  const values = join(dir, 'page-launch-values.json');
  writeFileSync(values, text);
  spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'fake-launch.ts'), values], { stdio: 'ignore', env });
  reply({ frameId: 'F1' });
  for (const line of JSON.parse(env.FAKE_CHROMIUM_CONSOLE ?? '[]') as string[]) {
    event('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: line }] }, 'S1');
    event('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'other\tsession' }] }, 'S2');
  }
  event('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'boot' }, { type: 'number', value: 1 }, { type: 'object', description: 'Object' }, {}, 3] }, 'S1');
  if (env.FAKE_CHROMIUM_CRASH) {
    setTimeout(() => {
      event('Inspector.targetCrashed', {}, 'S1');
    }, 30);
  }
}

function handle(socket: WebSocket, message: Message): void {
  const { id, method, params, sessionId } = message;
  log({ method, params, sessionId });
  const reply = (result: unknown): void => {
    socket.send(JSON.stringify({ id, result, sessionId }));
  };
  if (method === 'Target.createTarget') reply({ targetId: 'T1' });
  else if (method === 'Target.attachToTarget') reply({ sessionId: 'S1' });
  else if (method === 'Emulation.setCPUThrottlingRate' && env.FAKE_CHROMIUM_THROTTLE_ERROR) {
    socket.send(JSON.stringify({ id, error: { code: -32000, message: 'no throttle' }, sessionId }));
  } else if (method === 'Page.navigate') void navigate(socket, String(params.url), reply);
  else reply({});
}

const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
server.on('listening', () => {
  writeFileSync(join(profile, 'DevToolsActivePort'), `${String((server.address() as AddressInfo).port)}\n/devtools/browser/fake\n`);
});
server.on('connection', (socket) => {
  socket.on('message', (data) => {
    socket.send('not json');
    handle(socket, JSON.parse((data as Buffer).toString('utf8')) as Message);
  });
});
