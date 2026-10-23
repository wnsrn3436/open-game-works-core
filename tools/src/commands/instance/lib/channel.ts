import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { OgwError } from '../../../lib/errors.ts';
import { rawBytes } from '../../../lib/wsdata.ts';

/** A response of the QACore automation channel. `frames` holds `capture_video` frames unless a frame handler took them. */
export interface ChannelResponse {
  ok: boolean;
  result: unknown;
  bytes: Buffer;
  frames: Buffer[];
}

export type FrameHandler = (n: number, png: Buffer) => void;

interface Pending {
  resolve: (response: ChannelResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  frames: Buffer[];
  onFrame: FrameHandler | null;
  socket: WebSocket;
}

/** Largest message the runner takes from a client: `capture_screen` PNGs and `capture_video` frames. */
const MAX_PAYLOAD = 512 * 1024 * 1024;

function sameToken(given: unknown, token: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parse(data: RawData): Record<string, unknown> | null {
  try {
    const text = rawBytes(data).toString('utf8');
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function decode(bytes: unknown): Buffer {
  return typeof bytes === 'string' && bytes !== '' ? Buffer.from(bytes, 'base64') : Buffer.alloc(0);
}

/**
 * The loopback WebSocket server the QACore automation channel of one client connects to,
 * with the token of that client. A new connection (after a restart) replaces the old one.
 */
export class ClientChannel {
  readonly name: string;
  readonly token: string;
  port = 0;
  /** Number of accepted connections; a restart makes it grow. */
  generation = 0;
  private server: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private connectWaiters: (() => void)[] = [];

  constructor(name: string) {
    this.name = name;
    this.token = randomBytes(32).toString('base64url');
  }

  get connected(): boolean {
    return this.socket !== null;
  }

  async listen(): Promise<number> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: MAX_PAYLOAD });
    this.server = server;
    server.on('connection', (socket) => {
      this.accept(socket);
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once('listening', resolvePromise);
      server.once('error', reject);
    });
    this.port = (server.address() as AddressInfo).port;
    return this.port;
  }

  private accept(socket: WebSocket): void {
    let greeted = false;
    socket.on('message', (data) => {
      const message = parse(data);
      if (!greeted) {
        if (!message || !sameToken(message.token, this.token)) {
          socket.terminate();
          return;
        }
        greeted = true;
        this.attach(socket);
        return;
      }
      if (message) this.receive(message);
    });
    socket.on('close', () => {
      if (this.socket === socket) this.detach(socket);
    });
    socket.on('error', () => undefined);
  }

  private attach(socket: WebSocket): void {
    const old = this.socket;
    this.socket = socket;
    this.generation += 1;
    if (old) {
      this.failPending(old, 'automation channel reconnected');
      old.terminate();
    }
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    for (const wake of waiters) wake();
  }

  private detach(socket: WebSocket): void {
    this.socket = null;
    this.failPending(socket, 'automation channel closed');
  }

  private failPending(socket: WebSocket, reason: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new OgwError(`${this.name}: ${reason}`));
    }
  }

  private receive(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id !== 'number') return;
    const pending = this.pending.get(id);
    if (!pending) return;
    if (typeof message.frame === 'number') {
      const png = decode(message.bytes);
      if (pending.onFrame) pending.onFrame(message.frame, png);
      else pending.frames.push(png);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve({ ok: message.ok === true, result: message.result ?? null, bytes: decode(message.bytes), frames: pending.frames });
  }

  /** Waits until a client is connected. */
  async waitConnected(timeoutMs: number): Promise<void> {
    if (this.socket) return;
    await this.waitConnection(timeoutMs);
  }

  /** Waits until a connection newer than `generation` is accepted. */
  async waitGeneration(generation: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.generation <= generation) {
      await this.waitConnection(Math.max(0, deadline - Date.now()));
    }
  }

  private waitConnection(timeoutMs: number): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.connectWaiters = this.connectWaiters.filter((w) => w !== wake);
        reject(new OgwError(`${this.name}: no automation channel connection within ${String(timeoutMs)} ms`));
      }, timeoutMs);
      const wake = (): void => {
        clearTimeout(timer);
        resolvePromise();
      };
      this.connectWaiters.push(wake);
    });
  }

  /** Sends one request; fails when no response comes within `timeoutMs`. */
  async request(command: string, args: readonly string[], timeoutMs: number, onFrame: FrameHandler | null = null): Promise<ChannelResponse> {
    const deadline = Date.now() + timeoutMs;
    await this.waitConnected(timeoutMs);
    const socket = this.socket as WebSocket;
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OgwError(`${this.name}: ${command} got no response within ${String(timeoutMs)} ms`));
      }, Math.max(0, deadline - Date.now()));
      this.pending.set(id, { resolve: resolvePromise, reject, timer, frames: [], onFrame, socket });
      socket.send(JSON.stringify({ id, command, args }));
    });
  }

  async close(): Promise<void> {
    if (this.socket) this.detach(this.socket);
    const server = this.server;
    this.server = null;
    if (!server) return;
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolvePromise) => {
      server.close(() => {
        resolvePromise();
      });
    });
  }
}
