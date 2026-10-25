import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo, Socket } from 'node:net';
import { join, normalize } from 'node:path';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { contentTypeOf } from '../../deploy/lib/s3.ts';
import { isInside } from '../../../lib/paths.ts';
import { rawBytes } from '../../../lib/wsdata.ts';

/** An input of `POST /input`: a left click at CSS pixels of the page, or a key press of a DOM `key` value. */
export type TestInput = { type: 'click'; x: number; y: number } | { type: 'key'; key: string };

/**
 * `UnitTestCore` test host (`unit-test-core` `### test host`): an HTTP server on a free port of `127.0.0.1`
 * that hosts loopback HTTP servers and WebSocket relays for tests and receives the result of the run.
 */
export interface TestHost {
  url: string;
  /** The result JSON the run sent with `PUT /result`, or null. */
  result(): unknown;
  /** The run ID the run sent with `PUT /released` after its `release`, or null. */
  released(): string | null;
  /** The run ID the run sent with `PUT /started` before its first test, or null. */
  started(): string | null;
  /** Sets what puts a `POST /input` into the page (the browser run); without it `POST /input` is 404 (the native run). */
  onInput(put: (input: TestInput) => Promise<void>): void;
  /** Why each `POST /input` that could not be put into the page failed, in order. */
  inputFailures(): string[];
  /** The `/app/` files whose response the browser closed before it was sent to the end, in order: a page that did not load. */
  appCutOff(): string[];
  close(): Promise<void>;
}

interface Registered {
  status: number;
  headers: [string, string][];
  body: Buffer;
}

interface LoopbackServer {
  responses: Map<string, Registered>;
  requests: { path: string; headers: [string, string][]; body: string }[];
  deleted: boolean;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function headerPairs(req: IncomingMessage): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) pairs.push([req.rawHeaders[i] as string, req.rawHeaders[i + 1] as string]);
  return pairs;
}

function parseRegistration(body: Buffer): Registered & { path: string } {
  const value = JSON.parse(body.toString('utf8')) as { path: string; status: number; headers?: [string, string][]; body?: string };
  if (typeof value.path !== 'string' || typeof value.status !== 'number') throw new Error('registration needs path and status');
  return { path: value.path, status: value.status, headers: value.headers ?? [], body: Buffer.from(value.body ?? '', 'base64') };
}

const SERVER_PATH = /^\/servers\/([1-9][0-9]*)(\/responses|\/requests|\/files(\/.*)?)?$/;
const RELAY_PATH = /^\/ws-servers\/([1-9][0-9]*)$/;
const RELAY_SOCKET = /^\/ws\/([1-9][0-9]*)\/(control$|client(?=[/?]|$))/;

function parseInput(body: Buffer): TestInput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  if (value.type === 'click' && typeof value.x === 'number' && typeof value.y === 'number') return { type: 'click', x: value.x, y: value.y };
  if (value.type === 'key' && typeof value.key === 'string' && value.key !== '') return { type: 'key', key: value.key };
  return null;
}

/** A close code a WebSocket close frame may carry: 1000-1003, 1007-1014 and 3000-4999. */
function closeCodeSendable(code: number): boolean {
  return Number.isInteger(code) && ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999));
}

/**
 * A WebSocket relay (`unit-test-core` `### test host`): each client connection is told to the one control connection
 * as JSON text frames, and the control sends frames to a client or closes it.
 */
class Relay {
  private readonly clients = new Map<number, WebSocket>();
  private control: WebSocket | null = null;
  private readonly held: string[] = [];
  private next = 1;
  deleted = false;

  private tell(event: Record<string, unknown>): void {
    const text = JSON.stringify(event);
    if (this.control?.readyState === WebSocket.OPEN) this.control.send(text);
    else this.held.push(text);
  }

  addClient(socket: WebSocket, path: string, protocols: string[]): void {
    const conn = this.next++;
    this.clients.set(conn, socket);
    this.tell({ event: 'open', conn, path, protocols });
    socket.on('message', (data: RawData, binary: boolean) => {
      const bytes = rawBytes(data);
      this.tell({ event: 'message', conn, binary, data: bytes.toString('base64') });
    });
    socket.on('close', (code: number, reason: Buffer) => {
      this.clients.delete(conn);
      this.tell({ event: 'close', conn, code, reason: reason.toString('utf8') });
    });
    socket.on('error', () => undefined);
  }

  setControl(socket: WebSocket): void {
    if (this.control !== null) {
      // a receiver error on the refused socket comes as an `error` event: with no listener it would end the process
      socket.on('error', () => undefined);
      socket.close(1008, 'a relay has one control connection');
      return;
    }
    this.control = socket;
    for (const text of this.held.splice(0)) socket.send(text);
    socket.on('message', (data: RawData) => {
      this.command(rawBytes(data).toString('utf8'));
    });
    socket.on('close', () => {
      this.closeClients(1001, 'relay control closed');
    });
    socket.on('error', () => undefined);
  }

  /** A control frame: sends or closes for a client, or tells the control an `error` event when the frame cannot be done. */
  private command(text: string): void {
    const error = (message: string): void => {
      this.tell({ event: 'error', message });
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      error('the control frame is not JSON');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      error('the control frame is not a JSON object');
      return;
    }
    const value = parsed as Record<string, unknown>;
    const client = typeof value.conn === 'number' ? this.clients.get(value.conn) : undefined;
    if (client === undefined) {
      error(`no open client connection ${String(value.conn)}`);
      return;
    }
    if (value.op === 'send' && typeof value.data === 'string') client.send(Buffer.from(value.data, 'base64'), { binary: value.binary === true });
    else if (value.op === 'close') {
      const code = typeof value.code === 'number' ? value.code : 1000;
      const reason = typeof value.reason === 'string' ? value.reason : '';
      // the codes a close frame may carry (RFC 6455 7.4) and its 123 byte reason limit: ws throws on others
      if (!closeCodeSendable(code) || Buffer.byteLength(reason) > 123) error(`close code ${String(code)} or a reason of ${String(Buffer.byteLength(reason))} bytes cannot be sent`);
      else client.close(code, reason);
    } else error(`unknown control op ${String(value.op)}`);
  }

  closeClients(code: number, reason: string): void {
    for (const client of this.clients.values()) client.close(code, reason);
  }

  remove(): void {
    this.deleted = true;
    this.closeClients(1001, 'relay deleted');
    this.control?.close(1001, 'relay deleted');
  }
}

class Host {
  private readonly servers = new Map<number, LoopbackServer>();
  readonly relays = new Map<number, Relay>();
  input: ((input: TestInput) => Promise<void>) | null = null;
  readonly inputFailures: string[] = [];
  readonly appCutOff: string[] = [];
  private result: unknown = null;
  private releasedRun: string | null = null;
  private startedRun: string | null = null;
  private readonly appDir: string | null;
  url = '';

  constructor(appDir: string | null) {
    this.appDir = appDir;
  }

  getResult(): unknown {
    return this.result;
  }

  getReleased(): string | null {
    return this.releasedRun;
  }

  getStarted(): string | null {
    return this.startedRun;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = req.url ?? '/';
    const method = req.method ?? 'GET';
    const body = await readBody(req);
    if (method === 'POST' && target === '/servers') {
      const n = this.servers.size + 1;
      this.servers.set(n, { responses: new Map(), requests: [], deleted: false });
      send(res, 201, { base_url: `${this.url}/servers/${String(n)}/files` });
      return;
    }
    if (this.relayRequest(method, target, res) || (await this.inputRequest(method, target, body, res))) return;
    if (this.runSignal(method, target, body, res)) return;
    if (method === 'GET' && target.startsWith('/app/')) {
      // the browser run opens `/app/index.html` with the test run config as its URL query (`client-core` Godot `## test`)
      const path = target.split('?', 1)[0] as string;
      await this.app(path.slice('/app/'.length), res);
      return;
    }
    this.server(req, method, target, body, res);
  }

  /** `PUT /result`, `PUT /started` and `PUT /released` of the run; false for another request. */
  private runSignal(method: string, target: string, body: Buffer, res: ServerResponse): boolean {
    if (method !== 'PUT') return false;
    if (target === '/result') {
      this.result = JSON.parse(body.toString('utf8'));
      send(res, 204);
      return true;
    }
    if (target !== '/started' && target !== '/released') return false;
    const runId = (JSON.parse(body.toString('utf8')) as { run_id?: unknown }).run_id;
    if (typeof runId !== 'string') send(res, 400);
    else {
      if (target === '/started') this.startedRun = runId;
      else this.releasedRun = runId;
      send(res, 204);
    }
    return true;
  }

  /** `POST /ws-servers` and `DELETE /ws-servers/<n>`; false for another request. */
  private relayRequest(method: string, target: string, res: ServerResponse): boolean {
    if (method === 'POST' && target === '/ws-servers') {
      const n = this.relays.size + 1;
      this.relays.set(n, new Relay());
      const ws = this.url.replace(/^http:/, 'ws:');
      send(res, 201, { url: `${ws}/ws/${String(n)}/client`, control_url: `${ws}/ws/${String(n)}/control` });
      return true;
    }
    const relay = RELAY_PATH.exec(target);
    if (!relay || method !== 'DELETE') return false;
    const found = this.relays.get(Number(relay[1]));
    if (!found || found.deleted) send(res, 404);
    else {
      found.remove();
      send(res, 204);
    }
    return true;
  }

  /** `POST /input`; false for another request. */
  private async inputRequest(method: string, target: string, body: Buffer, res: ServerResponse): Promise<boolean> {
    if (method !== 'POST' || target !== '/input') return false;
    if (this.input === null) {
      send(res, 404);
      return true;
    }
    const input = parseInput(body);
    if (input === null) {
      send(res, 400);
      return true;
    }
    try {
      await this.input(input);
      send(res, 204);
    } catch (error) {
      // the run is told with a status of its own; the tool reports the cause as a failure of the run
      const message = error instanceof Error ? error.message : String(error);
      this.inputFailures.push(message);
      send(res, 500, { error: message });
    }
    return true;
  }

  private server(req: IncomingMessage, method: string, target: string, body: Buffer, res: ServerResponse): void {
    const match = SERVER_PATH.exec(target.split('?')[0] ?? '');
    const server = match ? this.servers.get(Number(match[1])) : undefined;
    if (!match || !server || server.deleted) {
      send(res, 404);
      return;
    }
    const part = match[2];
    if (part === undefined && method === 'DELETE') {
      server.deleted = true;
      send(res, 204);
    } else if (part === '/responses' && method === 'PUT') {
      const registered = parseRegistration(body);
      server.responses.set(registered.path, registered);
      send(res, 204);
    } else if (part === '/requests' && method === 'GET') {
      send(res, 200, server.requests);
    } else if (part?.startsWith('/files') === true) {
      this.file(req, server, target.slice(target.indexOf('/files') + '/files'.length), body, res);
    } else {
      send(res, 404);
    }
  }

  private file(req: IncomingMessage, server: LoopbackServer, path: string, body: Buffer, res: ServerResponse): void {
    server.requests.push({ path, headers: headerPairs(req), body: body.toString('base64') });
    const registered = server.responses.get(path);
    if (!registered) {
      send(res, 404);
      return;
    }
    res.writeHead(registered.status, registered.headers.flat()).end(registered.body);
  }

  private async app(path: string, res: ServerResponse): Promise<void> {
    const file = this.appDir === null ? null : normalize(join(this.appDir, decodeURIComponent(path)));
    if (file === null || this.appDir === null || !isInside(this.appDir, file)) {
      send(res, 404);
      return;
    }
    const content = await readFile(file).catch(() => null);
    res.on('close', () => {
      if (!res.writableFinished) this.appCutOff.push(path);
    });
    if (content === null) send(res, 404);
    else res.writeHead(200, { 'content-type': contentTypeOf(file) }).end(content); // a browser checks the type of module scripts and audio worklets
  }
}

/** Starts a test host. `appDir` holds the web export a browser run opens under `/app/`. */
export async function startTestHost(appDir: string | null = null): Promise<TestHost> {
  const host = new Host(appDir);
  const server = createServer((req, res) => {
    host.handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 400);
      else res.end();
    });
  });
  const sockets = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => [...protocols][0] ?? false });
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    // Node takes its own `error` listener off an upgraded socket: a write error on it would end the process
    socket.on('error', () => undefined);
    const target = req.url ?? '/';
    const match = RELAY_SOCKET.exec(target);
    const relay = match ? host.relays.get(Number(match[1])) : undefined;
    if (!match || !relay || relay.deleted) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const protocols = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim()).filter((p) => p !== '');
    sockets.handleUpgrade(req, socket, head, (ws) => {
      if (match[2] === 'control') relay.setControl(ws);
      else relay.addClient(ws, target.slice(`/ws/${match[1] as string}/client`.length), protocols);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    url: host.url,
    result: () => host.getResult(),
    released: () => host.getReleased(),
    started: () => host.getStarted(),
    onInput: (put) => {
      host.input = put;
    },
    inputFailures: () => [...host.inputFailures],
    appCutOff: () => [...host.appCutOff],
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of sockets.clients) client.terminate();
        sockets.close();
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
