import type { ChildProcess } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket, type RawData } from 'ws';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { killTree, spawnTracked } from '../../../lib/proc.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';
import { rawBytes } from '../../../lib/wsdata.ts';

/** A page of headless Chromium driven over the Chrome DevTools Protocol. */
export interface HeadlessPage {
  /** Console output of the page so far, one entry per console call. */
  console: string[];
  /** Why the page is gone (crashed, closed, browser ended), or null while it runs. */
  ended(): string | null;
  /** Unix ms right before `Page.navigate` was sent. */
  openedAt: number;
  close(): Promise<void>;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type EventHandler = (params: Record<string, unknown>, sessionId: string | undefined) => void;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(data: RawData): string {
  return rawBytes(data).toString('utf8');
}

/** One Chrome DevTools Protocol connection to the browser endpoint, with flat sessions. */
export class Cdp {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, EventHandler[]>();
  closed = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data) => {
      this.receive(textOf(data));
    });
    socket.on('close', () => {
      this.closed = true;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new OgwError('DevTools connection closed'));
      }
      this.emit('close', {}, undefined);
    });
    socket.on('error', () => undefined);
  }

  static connect(url: string, timeoutMs: number): Promise<Cdp> {
    return new Promise((resolvePromise, reject) => {
      const socket = new WebSocket(url, { handshakeTimeout: timeoutMs, maxPayload: 256 * 1024 * 1024 });
      socket.once('open', () => {
        resolvePromise(new Cdp(socket));
      });
      socket.once('error', (error) => {
        reject(new OgwError(`DevTools connection to ${url} failed: ${error.message}`));
      });
    });
  }

  private receive(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObject(message)) return;
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
    if (typeof message.id !== 'number') {
      if (typeof message.method === 'string') this.emit(message.method, isObject(message.params) ? message.params : {}, sessionId);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (isObject(message.error)) pending.reject(new OgwError(`DevTools: ${String(message.error.message)}`));
    else pending.resolve(isObject(message.result) ? message.result : {});
  }

  private emit(method: string, params: Record<string, unknown>, sessionId: string | undefined): void {
    for (const handler of this.handlers.get(method) ?? []) handler(params, sessionId);
  }

  on(method: string, handler: EventHandler): void {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), handler]);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new OgwError(`DevTools ${method}: connection closed`));
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OgwError(`DevTools ${method} got no answer within ${String(LIMITS.shortMs)} ms`));
      }, LIMITS.shortMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  }

  close(): void {
    this.socket.terminate();
  }
}

/** Text of one `Runtime.consoleAPICalled` event: its arguments joined by a space. */
export function consoleText(params: Record<string, unknown>): string {
  const args = Array.isArray(params.args) ? params.args : [];
  return args
    .map((arg: unknown) => {
      if (!isObject(arg)) return '';
      if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
      return typeof arg.description === 'string' ? arg.description : '';
    })
    .join(' ');
}

/**
 * The browser endpoint from `DevToolsActivePort` of the profile folder (first line port, second line path), waiting
 * until the browser wrote it; throws the `ended` reason when the browser is gone first.
 */
export async function devtoolsEndpoint(profile: string, ended: () => string | null, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // the browser writes the file once it listens: a file that is not there yet is waited for
    const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    });
    const [port, path] = text.split('\n');
    if (port !== undefined && /^[0-9]+$/.test(port.trim()) && path !== undefined && path.trim() !== '') return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
    const reason = ended();
    if (reason !== null) throw new OgwError(reason);
    if (Date.now() >= deadline) throw new OgwError(`headless browser gave no DevTools port within ${String(timeoutMs)} ms`);
    await sleep(100);
  }
}

class Page implements HeadlessPage {
  console: string[] = [];
  openedAt = 0;
  private reason: string | null = null;
  private readonly browser: ChildProcess;
  private readonly profile: string;
  cdp: Cdp | null = null;

  constructor(browser: ChildProcess, profile: string) {
    this.browser = browser;
    this.profile = profile;
    browser.once('exit', (code, signal) => {
      this.end(`headless browser ended with ${String(code ?? signal)}`);
    });
    browser.once('error', (error) => {
      this.end(`headless browser did not start: ${error.message}`);
    });
  }

  end(reason: string): void {
    this.reason ??= reason;
  }

  ended(): string | null {
    return this.reason;
  }

  async close(): Promise<void> {
    this.end('closed');
    this.cdp?.close();
    killTree(this.browser, 'SIGKILL');
    await rm(this.profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function attach(page: Page, cdp: Cdp, url: string, cpuThrottleRate: number): Promise<void> {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  if (typeof sessionId !== 'string') throw new OgwError('DevTools Target.attachToTarget gave no sessionId');
  cdp.on('Runtime.consoleAPICalled', (params, from) => {
    if (from === sessionId) page.console.push(consoleText(params));
  });
  cdp.on('Inspector.targetCrashed', (_params, from) => {
    if (from === sessionId) page.end('browser page crashed');
  });
  cdp.on('Target.detachedFromTarget', (params) => {
    if (params.sessionId === sessionId) page.end('browser page closed');
  });
  cdp.on('close', () => {
    page.end('DevTools connection closed');
  });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottleRate }, sessionId);
  page.openedAt = Date.now();
  const navigated = await cdp.send('Page.navigate', { url }, sessionId);
  if (typeof navigated.errorText === 'string' && navigated.errorText !== '') throw new OgwError(`page ${url} did not open: ${navigated.errorText}`);
}

/**
 * Starts the headless browser `chromium` with a new profile, sets the CPU throttle of a new page with
 * `Emulation.setCPUThrottlingRate`, and opens `url` in it. The caller closes the page.
 */
export async function openHeadless(ctx: Context, chromium: string, url: string, cpuThrottleRate: number): Promise<HeadlessPage> {
  const profile = await newPrivateTempFolder('ogw-web-smoke-', ctx.env);
  const args = ['--headless', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', 'about:blank'];
  const browser = spawnTracked(chromium, args, { env: ctx.env, stdio: 'ignore' });
  const page = new Page(browser, profile);
  try {
    page.cdp = await Cdp.connect(await devtoolsEndpoint(profile, () => page.ended(), LIMITS.shortMs), LIMITS.shortMs);
    await attach(page, page.cdp, url, cpuThrottleRate);
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}
