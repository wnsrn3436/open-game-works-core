import { setTimeout as sleep } from 'node:timers/promises';
import { OgwError } from '../../../lib/errors.ts';
import { isPlainObject } from '../../../lib/json.ts';
import { isInputCommand } from './qa.ts';
import type { MatchModeRow } from './records.ts';
import { POLL_MS, getState, type Requester } from './steps.ts';

/**
 * Gate of the bot loops: `pause` stops new `.opponent_step` and `.social_step` calls and waits for the
 * calls in flight; in step mode the loops run only while a `ogw step` advances time.
 */
export class BotGate {
  stopped = false;
  private paused = false;
  private stepMode = false;
  private stepping = 0;
  private inFlight = 0;
  private wakers: (() => void)[] = [];

  private wake(): void {
    const wakers = this.wakers;
    this.wakers = [];
    for (const w of wakers) w();
  }

  private open(): boolean {
    return !this.paused && (!this.stepMode || this.stepping > 0);
  }

  /** Waits until a call may start; false when the loops stopped. */
  async enter(): Promise<boolean> {
    while (!this.stopped && !this.open()) {
      await new Promise<void>((resolvePromise) => this.wakers.push(resolvePromise));
    }
    if (this.stopped) return false;
    this.inFlight += 1;
    return true;
  }

  leave(): void {
    this.inFlight -= 1;
    this.wake();
  }

  async pause(): Promise<void> {
    this.paused = true;
    while (this.inFlight > 0) await new Promise<void>((resolvePromise) => this.wakers.push(resolvePromise));
  }

  resume(stepMode: boolean | null): void {
    if (stepMode !== null) this.stepMode = stepMode;
    this.paused = false;
    this.wake();
  }

  setStepping(active: boolean): void {
    this.stepping = Math.max(0, this.stepping + (active ? 1 : -1));
    this.wake();
  }

  stop(): void {
    this.stopped = true;
    this.wake();
  }
}

export type Log = (line: string) => void;

/** The input command a content command returned as `{"command", "args"}`, when it is an input command. */
export function inputOf(result: unknown): { command: string; args: string[] } | null {
  if (!isPlainObject(result) || typeof result.command !== 'string' || !isInputCommand(result.command)) return null;
  const args = result.args ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) return null;
  return { command: result.command, args };
}

/** Names in a `list_commands` result. */
export function commandNames(result: unknown): string[] {
  if (!Array.isArray(result)) throw new OgwError('list_commands did not return a list');
  return result.map((entry) => (isPlainObject(entry) && typeof entry.name === 'string' ? entry.name : null)).filter((n): n is string => n !== null);
}

/** The one content command whose name ends with `suffix`; fails when there is not exactly one. */
export function oneCommand(names: readonly string[], suffix: string): string {
  const found = names.filter((n) => n.endsWith(suffix));
  if (found.length !== 1) {
    throw new OgwError(`expected one content command ending with ${suffix}, found ${String(found.length)}${found.length > 0 ? `: ${found.join(', ')}` : ''}`);
  }
  return found[0] as string;
}

/** A mode whose room `matchmaker` can open: `allow_room`, or `allow_queue` with `max_party_size` 2 or more. */
export function roomCapable(row: MatchModeRow): boolean {
  return row.allowRoom || (row.allowQueue && row.maxPartySize >= 2);
}

/** How many opponent bot clients of the row join a room of that mode. */
export function roomJoinCount(row: MatchModeRow, bots: number): number {
  return row.allowRoom ? bots : Math.min(bots, row.maxPartySize - 1);
}

export interface OpponentBot {
  name: string;
  row: MatchModeRow;
  request: Requester;
  /** Room code to join before the next `.opponent_step`. */
  pendingJoin: string | null;
}

export interface BotCommands {
  step: string;
  joinRoom: string | null;
  timeoutMs: number;
}

/** Calls `.opponent_step` with the row ID name and puts the returned input command in, until the loops stop. */
export async function opponentLoop(gate: BotGate, bot: OpponentBot, commands: BotCommands, log: Log): Promise<void> {
  for (;;) {
    if (!(await gate.enter())) return;
    let idle = false;
    try {
      idle = await opponentTurn(bot, commands);
    } catch (error) {
      log(`${bot.name}: ${(error as Error).message}`);
      idle = true;
    } finally {
      gate.leave();
    }
    if (idle) await sleep(POLL_MS);
  }
}

async function opponentTurn(bot: OpponentBot, commands: BotCommands): Promise<boolean> {
  const code = bot.pendingJoin;
  if (code !== null && commands.joinRoom !== null) {
    bot.pendingJoin = null;
    const joined = await bot.request(commands.joinRoom, [code], commands.timeoutMs);
    if (!joined.ok) throw new OgwError(`${commands.joinRoom} failed: ${JSON.stringify(joined.result)}`);
    return false;
  }
  const response = await bot.request(commands.step, [bot.row.id], commands.timeoutMs);
  if (!response.ok) throw new OgwError(`${commands.step} failed: ${JSON.stringify(response.result)}`);
  const input = inputOf(response.result);
  if (!input) return true;
  const put = await bot.request(input.command, input.args, commands.timeoutMs);
  if (!put.ok) throw new OgwError(`${input.command} failed: ${JSON.stringify(put.result)}`);
  return false;
}

/** Calls `.social_step` with the user ID of the client that is not a bot client, until the loops stop. */
export async function socialLoop(gate: BotGate, request: Requester, command: string, userId: string, timeoutMs: number, log: Log): Promise<void> {
  for (;;) {
    if (!(await gate.enter())) return;
    let idle = true;
    try {
      const response = await request(command, [userId], timeoutMs);
      if (!response.ok) throw new OgwError(`${command} failed: ${JSON.stringify(response.result)}`);
      idle = response.result === null;
    } catch (error) {
      log(`social: ${(error as Error).message}`);
    } finally {
      gate.leave();
    }
    if (idle) await sleep(POLL_MS);
  }
}

/** Interval of the room watch on the client that is not a bot client. */
export const ROOM_POLL_MS = 500;

/** The `match_mode` row whose ID name is the `room_mode` of `get_state`. */
export function rowOfMode(rows: readonly MatchModeRow[], mode: string): MatchModeRow {
  const row = rows.find((r) => r.id === mode);
  if (!row) throw new OgwError(`room_mode ${JSON.stringify(mode)} is not a match_mode row with opponent bot clients`);
  return row;
}

/**
 * Watches `room_code` of the client that is not a bot client. Each time it changes from the empty string
 * to a code, the first k opponent bot clients of that mode join the room before their next `.opponent_step`.
 */
export async function roomWatch(
  gate: BotGate,
  main: Requester,
  bots: readonly OpponentBot[],
  rows: readonly MatchModeRow[],
  timeoutMs: number,
  log: Log,
): Promise<void> {
  let previous = '';
  while (!gate.stopped) {
    try {
      const state = await getState(main, timeoutMs);
      const code = typeof state.room_code === 'string' ? state.room_code : '';
      const was = previous;
      previous = code;
      if (was === '' && code !== '') assignJoins(bots, rows, typeof state.room_mode === 'string' ? state.room_mode : '', code);
    } catch (error) {
      log(`room watch: ${(error as Error).message}`);
    }
    await sleep(ROOM_POLL_MS);
  }
}

export function assignJoins(bots: readonly OpponentBot[], rows: readonly MatchModeRow[], mode: string, code: string): void {
  const row = rowOfMode(rows, mode);
  const ofRow = bots.filter((b) => b.row.id === row.id);
  for (const bot of ofRow.slice(0, roomJoinCount(row, ofRow.length))) bot.pendingJoin = code;
}
