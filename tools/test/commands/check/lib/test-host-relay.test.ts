import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startTestHost, type TestHost, type TestInput } from '../../../../src/commands/check/lib/test-host.ts';

let host: TestHost | null = null;

afterEach(async () => {
  await host?.close();
  host = null;
});

/** A WebSocket that keeps every frame it gets, and how it closed. */
function socket(url: string, protocols: string[] = []): { ws: WebSocket; frames: { text: string; binary: boolean }[]; opened: Promise<void>; closed: Promise<{ code: number; reason: string }> } {
  const ws = new WebSocket(url, protocols);
  const frames: { text: string; binary: boolean }[] = [];
  ws.on('message', (data: Buffer, binary: boolean) => frames.push({ text: data.toString('utf8'), binary }));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      resolve();
    });
    ws.once('error', reject);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.once('close', (code: number, reason: Buffer) => {
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
  return { ws, frames, opened, closed };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

const events = (frames: { text: string }[]): Record<string, unknown>[] => frames.map((f) => JSON.parse(f.text) as Record<string, unknown>);

describe('test host WebSocket relay', () => {
  it('tells the control each client connection, frame and close, and sends and closes for the control', async () => {
    host = await startTestHost();
    const made = (await (await fetch(`${host.url}/ws-servers`, { method: 'POST' })).json()) as { url: string; control_url: string };
    const port = new URL(host.url).port;
    expect(made).toEqual({ url: `ws://127.0.0.1:${port}/ws/1/client`, control_url: `ws://127.0.0.1:${port}/ws/1/control` });
    // a client that connects before the control: its events wait for the control, in order
    const client = socket(`${made.url}/match?token=t`, ['ogw.v1', 'other']);
    await client.opened;
    expect(client.ws.protocol).toBe('ogw.v1');
    client.ws.send(Buffer.from([1, 2, 3]));
    client.ws.send('hi');
    const control = socket(made.control_url);
    await control.opened;
    await until(() => control.frames.length === 3);
    expect(events(control.frames)).toEqual([
      { event: 'open', conn: 1, path: '/match?token=t', protocols: ['ogw.v1', 'other'] },
      { event: 'message', conn: 1, binary: true, data: Buffer.from([1, 2, 3]).toString('base64') },
      { event: 'message', conn: 1, binary: false, data: Buffer.from('hi').toString('base64') },
    ]);
    expect(control.frames.every((f) => !f.binary)).toBe(true);
    control.ws.send(JSON.stringify({ op: 'send', conn: 1, binary: true, data: Buffer.from([9]).toString('base64') }));
    control.ws.send(JSON.stringify({ op: 'send', conn: 1, binary: false, data: Buffer.from('yo').toString('base64') }));
    await until(() => client.frames.length === 2);
    expect(client.frames).toEqual([{ text: '\t', binary: true }, { text: 'yo', binary: false }]);
    control.ws.send(JSON.stringify({ op: 'close', conn: 1, code: 4001, reason: 'banned' }));
    expect(await client.closed).toEqual({ code: 4001, reason: 'banned' });
    await until(() => control.frames.length === 4);
    expect(events(control.frames)[3]).toEqual({ event: 'close', conn: 1, code: 4001, reason: 'banned' });
    // a second client gets the next number, and its own close is told
    const second = socket(made.url);
    await second.opened;
    second.ws.close(1000, 'bye');
    await until(() => control.frames.length === 6);
    expect(events(control.frames).slice(4)).toEqual([
      { event: 'open', conn: 2, path: '', protocols: [] },
      { event: 'close', conn: 2, code: 1000, reason: 'bye' },
    ]);
  });

  it('has one control, closes the clients when the control closes or the relay is deleted, and refuses unknown relays', async () => {
    host = await startTestHost();
    const made = (await (await fetch(`${host.url}/ws-servers`, { method: 'POST' })).json()) as { url: string; control_url: string };
    const control = socket(made.control_url);
    await control.opened;
    const extra = socket(made.control_url);
    expect((await extra.closed).code).toBe(1008);
    const client = socket(made.url);
    await client.opened;
    control.ws.close();
    expect((await client.closed).code).toBe(1001);
    const other = (await (await fetch(`${host.url}/ws-servers`, { method: 'POST' })).json()) as { url: string; control_url: string };
    const kept = socket(other.url);
    await kept.opened;
    const otherControl = socket(other.control_url);
    await otherControl.opened;
    expect((await fetch(`${host.url}/ws-servers/2`, { method: 'DELETE' })).status).toBe(204);
    expect((await kept.closed).code).toBe(1001);
    expect((await otherControl.closed).code).toBe(1001);
    expect((await fetch(`${host.url}/ws-servers/2`, { method: 'DELETE' })).status).toBe(404);
    await expect(socket(other.url).opened).rejects.toThrow('404');
    await expect(socket(`${host.url.replace('http:', 'ws:')}/ws/9/client`).opened).rejects.toThrow('404');
  });
});

describe('test host WebSocket relay control errors', () => {
  it('tells the control an error event for a frame it cannot do, and goes on', async () => {
    host = await startTestHost();
    const made = (await (await fetch(`${host.url}/ws-servers`, { method: 'POST' })).json()) as { url: string; control_url: string };
    const control = socket(made.control_url);
    await control.opened;
    const client = socket(made.url);
    await client.opened;
    await until(() => control.frames.length === 1);
    control.ws.send(JSON.stringify({ op: 'close', conn: 1, code: 1006, reason: '' }));
    control.ws.send(JSON.stringify({ op: 'close', conn: 1, code: 4000, reason: 'x'.repeat(200) }));
    control.ws.send(JSON.stringify({ op: 'send', conn: 7, binary: false, data: '' }));
    control.ws.send(JSON.stringify({ op: 'jump', conn: 1 }));
    control.ws.send('not json');
    control.ws.send('null');
    control.ws.send('[1]');
    await until(() => control.frames.length === 8);
    expect(events(control.frames).slice(1)).toEqual([
      { event: 'error', message: 'close code 1006 or a reason of 0 bytes cannot be sent' },
      { event: 'error', message: 'close code 4000 or a reason of 200 bytes cannot be sent' },
      { event: 'error', message: 'no open client connection 7' },
      { event: 'error', message: 'unknown control op jump' },
      { event: 'error', message: 'the control frame is not JSON' },
      { event: 'error', message: 'the control frame is not a JSON object' },
      { event: 'error', message: 'the control frame is not a JSON object' },
    ]);
    // the host still answers and the client is still open
    expect((await fetch(`${host.url}/ws-servers`, { method: 'POST' })).status).toBe(201);
    control.ws.send(JSON.stringify({ op: 'close', conn: 1, code: 4000, reason: 'ok' }));
    expect(await client.closed).toEqual({ code: 4000, reason: 'ok' });
  });
});

describe('test host input timing and failures', () => {
  it('answers 204 only after the input is in the page, and 500 with the cause it records when it is not', async () => {
    host = await startTestHost();
    let finish: () => void = () => undefined;
    let fail = false;
    host.onInput(() => {
      if (fail) return Promise.reject(new Error('no browser page at x'));
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    let answered = false;
    const pending = fetch(`${host.url}/input`, { method: 'POST', body: JSON.stringify({ type: 'key', key: 'a' }) }).then((r) => {
      answered = true;
      return r.status;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(answered).toBe(false);
    finish();
    expect(await pending).toBe(204);
    fail = true;
    const failed = await fetch(`${host.url}/input`, { method: 'POST', body: JSON.stringify({ type: 'key', key: 'a' }) });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'no browser page at x' });
    expect(host.inputFailures()).toEqual(['no browser page at x']);
  });

  it('stays up when a refused control or a refused upgrade socket fails', async () => {
    host = await startTestHost();
    const made = (await (await fetch(`${host.url}/ws-servers`, { method: 'POST' })).json()) as { url: string; control_url: string };
    const control = socket(made.control_url);
    await control.opened;
    // a second control sends a text frame that is not UTF-8 before its refusal arrives
    const second = new WebSocket(made.control_url);
    second.on('error', () => undefined);
    await new Promise<void>((resolve) => second.once('open', () => {
      second.send(Buffer.from([0xff, 0xfe]), { binary: false });
      resolve();
    }));
    // clients that drop their upgrade to an unknown relay at once
    const port = Number(new URL(host.url).port);
    for (let i = 0; i < 50; i++) {
      const raw = connect(port, '127.0.0.1', () => {
        raw.write('GET /ws/9/client HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
        raw.resetAndDestroy();
      });
      raw.on('error', () => undefined);
    }
    await new Promise((r) => setTimeout(r, 300));
    expect((await fetch(`${host.url}/ws-servers`, { method: 'POST' })).status).toBe(201);
    expect(control.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe('test host input', () => {
  it('is 404 without a page, 400 for a body not in the form, and puts the input into the page', async () => {
    host = await startTestHost();
    const post = (body: unknown): Promise<Response> => fetch(`${(host as TestHost).url}/input`, { method: 'POST', body: JSON.stringify(body) });
    expect((await post({ type: 'click', x: 1, y: 2 })).status).toBe(404);
    // a native run is 404 whatever the body
    expect((await fetch(`${host.url}/input`, { method: 'POST', body: '{' })).status).toBe(404);
    expect((await post(null)).status).toBe(404);
    const put: TestInput[] = [];
    host.onInput((input) => {
      put.push(input);
      return Promise.resolve();
    });
    expect((await post({ type: 'click', x: 'a', y: 2 })).status).toBe(400);
    expect((await post({ type: 'key', key: '' })).status).toBe(400);
    expect((await post({ type: 'tap' })).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    expect((await fetch(`${host.url}/input`, { method: 'POST', body: '{' })).status).toBe(400);
    expect((await post({ type: 'click', x: 10.5, y: 20 })).status).toBe(204);
    expect((await post({ type: 'key', key: 'Enter' })).status).toBe(204);
    expect(put).toEqual([{ type: 'click', x: 10.5, y: 20 }, { type: 'key', key: 'Enter' }]);
  });
});
