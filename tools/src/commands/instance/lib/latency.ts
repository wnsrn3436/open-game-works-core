import { setTimeout as sleep } from 'node:timers/promises';
import type { ChannelResponse } from './channel.ts';
import { isInputCommand } from './qa.ts';
import type { Requester } from './steps.ts';

/** An input command held in step mode, and the game time (ms) still to pass before it is sent. */
interface Held {
  command: string;
  args: string[];
  leftMs: number;
}

const OK: ChannelResponse = { ok: true, result: null, bytes: Buffer.alloc(0), frames: [] };

/** The ms argument of `step`: a whole number of ms of at least 1, or null for any other argument. */
function stepMs(args: readonly string[]): number | null {
  const value = args[0];
  return value !== undefined && /^[0-9]{1,15}$/.test(value) && Number(value) >= 1 ? Number(value) : null;
}

/**
 * The input latency of the client `main` of an instance started with `--input-latency` (ogw.md `## runner`). An input
 * command is answered at once and sent the latency after it was received, in the order received; in step mode it is
 * held until the `step` commands after it have advanced game time by the latency, and the step during which that
 * happens is split there.
 */
export class InputLatency {
  private readonly ms: number;
  private readonly send: Requester;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private held: Held[] = [];
  /** The sends of the inputs received outside step mode, in the order received. */
  private delayed: Promise<void> = Promise.resolve();

  constructor(ms: number, send: Requester, wait: (ms: number) => Promise<void> = (delay) => sleep(delay), now: () => number = Date.now) {
    this.ms = ms;
    this.send = send;
    this.wait = wait;
    this.now = now;
  }

  /** Resolves once every input received outside step mode so far was sent (for tests). */
  async sent(): Promise<void> {
    await this.delayed;
  }

  /** The commands held now, oldest first (for tests and the runner log). */
  heldCommands(): string[] {
    return this.held.map((h) => h.command);
  }

  /** Sends a request to the client `main` with the latency applied. */
  async request(command: string, args: readonly string[], timeoutMs: number): Promise<ChannelResponse> {
    if (isInputCommand(command)) return this.input(command, [...args], timeoutMs);
    const ms = command === 'step' ? stepMs(args) : null;
    if (ms !== null && this.held.length > 0) return this.step(ms, timeoutMs);
    const response = await this.send(command, args, timeoutMs);
    if (command === 'set_step_mode' && args[0] === 'off' && response.ok) await this.flush(timeoutMs);
    return response;
  }

  private async stepMode(timeoutMs: number): Promise<boolean> {
    const state = await this.send('get_state', [], timeoutMs).catch(() => null);
    return state?.ok === true && (state.result as Record<string, unknown> | null)?.step_mode === true;
  }

  private async input(command: string, args: string[], timeoutMs: number): Promise<ChannelResponse> {
    if (await this.stepMode(timeoutMs)) {
      this.held.push({ command, args, leftMs: this.ms });
      return OK;
    }
    // each input waits only its own latency from when it was received, so the delays of inputs sent one after another do not add up
    const due = this.now() + this.ms;
    this.delayed = this.delayed.then(async () => {
      const left = due - this.now();
      if (left > 0) await this.wait(left);
      await this.send(command, args, timeoutMs).catch(() => undefined);
    });
    return OK;
  }

  /**
   * A `step` of `ms` while inputs are held: a step up to each held input that becomes due within it, that input, and a
   * step for the rest. The answer is that of the last part, or of the first part that failed.
   */
  private async step(ms: number, timeoutMs: number): Promise<ChannelResponse> {
    let advanced = 0;
    let last: ChannelResponse | null = null;
    while (this.held.length > 0 && (this.held[0] as Held).leftMs <= ms) {
      const due = this.held.shift() as Held;
      const part = due.leftMs - advanced;
      if (part > 0) {
        last = await this.send('step', [String(part)], timeoutMs);
        if (!last.ok) {
          this.held.unshift(due);
          return this.failed(last, advanced);
        }
        advanced = due.leftMs;
      }
      last = await this.send(due.command, due.args, timeoutMs);
      if (!last.ok) return this.failed(last, advanced);
    }
    for (const held of this.held) held.leftMs -= ms;
    if (ms - advanced > 0) last = await this.send('step', [String(ms - advanced)], timeoutMs);
    return last ?? OK;
  }

  /** A failed part of a split step: the inputs still held keep the game time that did pass. */
  private failed(response: ChannelResponse, advanced: number): ChannelResponse {
    for (const held of this.held) held.leftMs = Math.max(1, held.leftMs - advanced);
    return response;
  }

  /** Step mode turned off: sends the held inputs in order, each once the rest of its latency has passed. */
  private async flush(timeoutMs: number): Promise<void> {
    let waited = 0;
    const held = this.held;
    this.held = [];
    for (const item of held) {
      if (item.leftMs - waited > 0) await this.wait(item.leftMs - waited);
      waited = Math.max(waited, item.leftMs);
      await this.send(item.command, item.args, timeoutMs).catch(() => undefined);
    }
  }
}
