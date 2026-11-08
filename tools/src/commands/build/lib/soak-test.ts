import { setTimeout as sleep } from 'node:timers/promises';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { readScenario } from '../../check/lib/bot-playtest.ts';
import { checkResult, failure, writeEvidence, type Evidence } from '../../check/lib/evidence.ts';
import { instanceServerLog } from '../../check/lib/instance-probe.ts';
import { ClientLogUnreadable } from '../../check/lib/logs.ts';
import { FRAMES, hitchTimeMs, isKeptTick, tickOf, type FpsTick, type TickBound } from '../../check/lib/performance.ts';
import { autoInputGapMs, instanceCoreSettings, LogCursor, processBlocker, stateBlocker, type Scenario } from '../../check/lib/scenario.ts';
import { isRecord } from '../../check/lib/scenario-form.ts';
import { automationRequest, type AutomationResponse } from '../../instance/automation.ts';
import type { BuildCheck } from './buildrun.ts';
import type { HeadlessPage } from './chromium.ts';
import { buildCheckOf, byteCount, checkoutOf, clientCheckTiming, didNotRun, evidenceOf, ranToEnd, withCheckInstance, withWebExport, type ClientCheckInput } from './client-check.ts';
import { outcome } from './settingschecks.ts';
import { pageBlocker, webRunSettings, webScenario, withWebPage } from './web-smoke.ts';

const NAME = 'soak test';

/**
 * The session of ogw.md `### soak test` 2 and 3 in ticks: a tick every `tickMs`, a cycle of `cycleTicks` whose first
 * `playTicks` ticks the bot plays, and `windows` windows of `windowTicks` ticks (window 0 the warm-up). Fixed values of
 * the check; a test makes the ticks short.
 */
export const soakPlan = { tickMs: 1000, cycleTicks: 150, playTicks: 120, windowTicks: 300, windows: 9 };

/** The fixed values of the judgement of ogw.md `### soak test` 3. */
export const SOAK = {
  /** A trend rises when its p is below this. */
  maxP: 0.05,
  /** 2048 MiB: the WebAssembly memory maximum of a Godot web export with threads. */
  memoryLimitBytes: 2048 * 1024 * 1024,
  /** 24 hours of 5-minute windows. */
  leakWindows: 288,
  windowMinutes: 5,
  /** The hitch ratio rise (ms/s) from the first to the last measured window that fails. */
  maxHitchRise: FRAMES.maxHitchRatio,
} as const;

/**
 * One tick of the soak: the tick of `## performance`, the `static_memory_bytes` reading (null when it is not a positive
 * number), and `heap_memory_bytes` and `total_memory_bytes` (null when not an integer of 0 or more).
 */
export interface SoakTick {
  frame: NonNullable<FpsTick>;
  memoryBytes: number | null;
  heapBytes: number | null;
  totalBytes: number | null;
}

/**
 * The values of one measured window; null when the window cannot give it, with the reason in `unknown` for the judged
 * ones. The largest heap and total memory of its ticks are not judged (null when no tick of the window has one).
 */
export interface SoakWindow {
  window: number;
  memoryFloor: number | null;
  hitchRatio: number | null;
  maxHeapMemoryBytes: number | null;
  maxTotalMemoryBytes: number | null;
  unknown: string[];
}

/** Permutations of `n` distinct values by their number of inversions (index): the Mahonian numbers. */
export function inversionCounts(n: number): number[] {
  let counts = [1];
  for (let size = 2; size <= n; size++) {
    const next = Array<number>(counts.length + size - 1).fill(0);
    for (const [k, c] of counts.entries()) for (let add = 0; add < size; add++) next[k + add] = (next[k + add] ?? 0) + c;
    counts = next;
  }
  return counts;
}

/** The median of numbers; the mean of the two middle values for an even count. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** The trend of values in order (ogw.md `### soak test` 3): Kendall's S, its one-sided exact p, and the Theil–Sen slope per step. */
export interface Trend {
  s: number;
  p: number;
  slope: number;
}

export function trendOf(values: readonly number[]): Trend {
  const n = values.length;
  let s = 0;
  const slopes: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = (values[j] ?? 0) - (values[i] ?? 0);
      s += Math.sign(d);
      slopes.push(d / (j - i));
    }
  }
  // an order of distinct values with `inv` inversions has S = pairs − 2 inv: S ≥ s holds for inv ≤ (pairs − s) / 2
  const counts = inversionCounts(n);
  const pairs = (n * (n - 1)) / 2;
  const orders = counts.reduce((a, b) => a + b, 0);
  const atLeast = counts.slice(0, Math.floor((pairs - s) / 2) + 1).reduce((a, b) => a + b, 0);
  return { s, p: atLeast / orders, slope: median(slopes) };
}

/** The frame values of one window: its hitch ratio of `## performance`, or why it has none. */
function windowFrames(frames: readonly FpsTick[], from: number, to: number): { hitchRatio: number | null; unknown: string[] } {
  let keptMs = 0;
  let hitchMs = 0;
  let missed = false;
  for (let k = from; k < Math.min(to, frames.length); k++) {
    const tick = frames[k];
    if (!tick || !isKeptTick(frames, k)) continue;
    if (tick.intervalsMs === null) missed = true;
    for (const ms of tick.intervalsMs ?? []) {
      keptMs += ms;
      hitchMs += hitchTimeMs(ms, tick.budgetMs);
    }
  }
  if (missed) return { hitchRatio: null, unknown: ['a kept tick has no frame_intervals_ms array of numbers'] };
  if (keptMs < FRAMES.minKeptMs) return { hitchRatio: null, unknown: [`kept frame intervals add up to ${(keptMs / 1000).toFixed(2)} s, less than ${String(FRAMES.minKeptMs / 1000)} s`] };
  return { hitchRatio: hitchMs / (keptMs / 1000), unknown: [] };
}

/** The values of `ticks` that are not null. */
function readings(ticks: readonly SoakTick[], of: (tick: SoakTick) => number | null): number[] {
  return ticks.flatMap((t) => {
    const value = of(t);
    return value === null ? [] : [value];
  });
}

/** The largest of `values`, or null without one. */
function largest(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

/** The measured windows (1 to `soakPlan.windows` − 1) of the ticks of a session. */
export function soakWindows(ticks: readonly SoakTick[]): SoakWindow[] {
  const frames = ticks.map((t) => t.frame);
  return Array.from({ length: soakPlan.windows - 1 }, (_, i) => {
    const window = i + 1;
    const from = window * soakPlan.windowTicks;
    const to = from + soakPlan.windowTicks;
    const inWindow = ticks.slice(from, to);
    const floors = readings(inWindow, (t) => t.memoryBytes);
    const memoryFloor = floors.length === 0 ? null : Math.min(...floors);
    const { hitchRatio, unknown } = windowFrames(frames, from, to);
    return {
      window,
      memoryFloor,
      hitchRatio,
      maxHeapMemoryBytes: largest(readings(inWindow, (t) => t.heapBytes)),
      maxTotalMemoryBytes: largest(readings(inWindow, (t) => t.totalBytes)),
      unknown: [...(memoryFloor === null ? ['no static_memory_bytes reading'] : []), ...unknown],
    };
  });
}

/** Where and why a session ended before its last tick; `blocker` when it is a blocker of the bot playtest. */
export interface SessionStop {
  tick: number;
  message: string;
  blocker: boolean;
}

const MIB = 1024 * 1024;

/** The memory leak line of a memory floor trend, or null (ogw.md `### soak test` 3). */
function leakLine(floors: readonly number[], trend: Trend): string | null {
  const last = floors[floors.length - 1] ?? 0;
  if (trend.p >= SOAK.maxP || last + SOAK.leakWindows * trend.slope < SOAK.memoryLimitBytes) return null;
  const hours = (Math.max(0, SOAK.memoryLimitBytes - last) / trend.slope) * (SOAK.windowMinutes / 60);
  return `memory floor rises ${(trend.slope / MIB).toFixed(2)} MiB per window (p ${trend.p.toFixed(4)}) and reaches 2048 MiB ${hours.toFixed(1)} hours after window ${String(floors.length)}`;
}

/** The frame degradation line of a hitch ratio trend, or null (ogw.md `### soak test` 3). */
function degradationLine(ratios: readonly number[], trend: Trend): string | null {
  const rise = (ratios.length - 1) * trend.slope;
  if (trend.p >= SOAK.maxP || rise < SOAK.maxHitchRise) return null;
  return `hitch ratio rises ${rise.toFixed(1)} ms/s from window 1 to window ${String(ratios.length)} (p ${trend.p.toFixed(4)})`;
}

function present(values: readonly (number | null)[]): number[] | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length === values.length ? known : null;
}

/** The trends of a full session and the lines they give; null for a kind with a window without its value. */
export function soakTrends(windows: readonly SoakWindow[]): { memory: Trend | null; frames: Trend | null; failures: string[]; unknown: string[] } {
  const floors = present(windows.map((w) => w.memoryFloor));
  const ratios = present(windows.map((w) => w.hitchRatio));
  const memory = floors === null ? null : trendOf(floors);
  const frames = ratios === null ? null : trendOf(ratios);
  const failures = [floors && memory ? leakLine(floors, memory) : null, ratios && frames ? degradationLine(ratios, frames) : null].filter((l): l is string => l !== null);
  const unknown = windows.flatMap((w) => w.unknown.map((reason) => `window ${String(w.window)}: ${reason}`));
  return { memory, frames, failures, unknown };
}

/** The check from a session (ogw.md `### soak test` 4). */
export function soakVerdict(env: ClientCheckInput['env'], ticks: readonly SoakTick[], stop: SessionStop | null): BuildCheck {
  if (stop !== null) {
    const details = [`tick ${String(stop.tick)}: ${stop.message}`];
    return stop.blocker ? { name: NAME, result: outcome(NAME, env, details), details } : { name: NAME, result: 'unknown', details };
  }
  const { failures, unknown } = soakTrends(soakWindows(ticks));
  if (failures.length > 0) return { name: NAME, result: outcome(NAME, env, failures), details: failures };
  if (unknown.length > 0) return { name: NAME, result: 'unknown', details: unknown };
  return { name: NAME, result: 'pass', details: [] };
}

/** The bot of the soak: the command and arguments of the last `auto` step of the scenario, or null without one. */
export function soakBot(scenario: Scenario): { command: string; args: string[] } | null {
  const auto = scenario.steps.filter((s) => s.kind === 'auto').at(-1);
  return auto === undefined ? null : { command: auto.command ?? '', args: auto.args };
}

function isInputCommand(value: unknown): value is { command: string; args: string[] } {
  return isRecord(value) && typeof value.command === 'string' && Array.isArray(value.args) && value.args.every((a) => typeof a === 'string');
}

/** The session of ogw.md `### soak test` 2: the ticks, the cycles of bot play and idle, and the blocker checks. */
class SoakSession {
  readonly ticks: SoakTick[] = [];
  stop: SessionStop | null = null;
  private tick = 0;
  private playing = false;
  private done = false;
  private wake: (() => void) | null = null;
  private readonly cursor = new LogCursor();
  private readonly ctx: Context;
  private readonly id: string;
  private readonly page: HeadlessPage;
  private readonly bot: { command: string; args: string[] } | null;
  private readonly bound: TickBound;

  constructor(ctx: Context, id: string, page: HeadlessPage, bot: { command: string; args: string[] } | null, bound: TickBound) {
    this.ctx = ctx;
    this.id = id;
    this.page = page;
    this.bot = bot;
    this.bound = bound;
  }

  private end(message: string, blocker: boolean): void {
    this.stop ??= { tick: this.tick, message, blocker };
    this.setPlaying(false);
  }

  private setPlaying(on: boolean): void {
    this.playing = on && this.stop === null && !this.done;
    // the bot waits for a play phase, and also for the end of the session
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  /** The blocker of the processes, the logs and the page; an unreadable log ends the session as no blocker. Whether it ended. */
  private async blocked(): Promise<boolean> {
    try {
      const found = (await processBlocker(this.ctx, this.id, this.cursor)) ?? (await pageBlocker(this.page)());
      if (found !== null) this.end(found, true);
    } catch (error) {
      if (!(error instanceof ClientLogUnreadable)) throw error;
      this.end(error.message, false);
    }
    return this.stop !== null;
  }

  /** A command of the session; null when it ended the session: `ok` false is a blocker, and so is a failed request a blocker explains. */
  private async request(command: string, args: string[]): Promise<AutomationResponse | null> {
    if (this.stop !== null) return null;
    let response: AutomationResponse;
    try {
      response = await automationRequest(this.ctx, this.id, command, args);
    } catch (error) {
      if (!(await this.blocked())) this.end(`${command} failed: ${(error as Error).message}`, false);
      return null;
    }
    if (!response.ok) {
      this.end(`${command} returned ok false: ${JSON.stringify(response.result)}`, true);
      return null;
    }
    return response;
  }

  private async readTick(): Promise<boolean> {
    const state = await this.request('get_state', []);
    const stats = state === null ? null : await this.request('get_stats', []);
    if (state === null || stats === null) return false;
    if (!isRecord(state.result)) {
      this.end('get_state returned no QAState', false);
      return false;
    }
    const values = isRecord(stats.result) ? stats.result : {};
    const memory = values.static_memory_bytes;
    this.ticks.push({
      frame: tickOf(state.result, stats.result, this.bound),
      memoryBytes: typeof memory === 'number' && memory > 0 ? memory : null,
      heapBytes: byteCount(values.heap_memory_bytes),
      totalBytes: byteCount(values.total_memory_bytes),
    });
    const found = stateBlocker(state.result);
    if (found !== null) this.end(found, true);
    return this.stop === null && !(await this.blocked());
  }

  private isPlaying(): boolean {
    return this.playing;
  }

  private waitForChange(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
    });
  }

  /** The bot: during a play phase, picks an input with the bot command and puts it in, with the gap of an `auto` step. */
  private async play(bot: { command: string; args: string[] }, gapMs: number): Promise<void> {
    let lastInputAt = 0;
    while (!this.done && this.stop === null) {
      if (!this.playing) {
        await this.waitForChange();
        continue;
      }
      const wait = lastInputAt + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      // the play phase can end during the gap
      const pick = this.isPlaying() ? await this.request(bot.command, bot.args) : undefined;
      if (pick === undefined) continue;
      if (pick === null) return;
      if (pick.result === null) {
        await sleep(clientCheckTiming.pollMs);
        continue;
      }
      if (!isInputCommand(pick.result)) {
        this.end(`${bot.command} returned no input command: ${JSON.stringify(pick.result)}`, false);
        return;
      }
      // no input goes in once the play phase has ended while the bot picked it
      if (!this.isPlaying()) continue;
      if ((await this.request(pick.result.command, pick.result.args)) === null) return;
      lastInputAt = Date.now();
    }
  }

  async run(gapMs: number): Promise<void> {
    const total = soakPlan.windows * soakPlan.windowTicks;
    const bot = this.bot === null ? Promise.resolve() : this.play(this.bot, gapMs);
    try {
      for (this.tick = 0; this.tick < total && this.stop === null; this.tick++) {
        const started = Date.now();
        const inCycle = this.tick % soakPlan.cycleTicks;
        if (inCycle === 0 && (await this.request('clear_telemetry', [])) === null) break;
        this.setPlaying(inCycle < soakPlan.playTicks);
        if (!(await this.readTick())) break;
        await sleep(Math.max(0, started + soakPlan.tickMs - Date.now()));
      }
    } finally {
      this.done = true;
      this.setPlaying(false);
      await bot;
    }
  }
}

/** Runs the session of ogw.md `### soak test` 2 on the client of instance `id` shown on `page`: its ticks, and why it ended early or null. */
export async function soakSession(
  ctx: Context,
  id: string,
  page: HeadlessPage,
  bot: { command: string; args: string[] } | null,
  bound: TickBound,
  gapMs: number,
): Promise<{ ticks: SoakTick[]; stop: SessionStop | null }> {
  const session = new SoakSession(ctx, id, page, bot, bound);
  await session.run(gapMs);
  return { ticks: session.ticks, stop: session.stop };
}

/** samples.json of the soak (ogw.md `### soak test` 4). */
async function keepSamples(evidence: Evidence, ticks: readonly SoakTick[], stop: SessionStop | null): Promise<void> {
  const windows = stop === null ? soakWindows(ticks) : [];
  const { memory, frames } = stop === null ? soakTrends(windows) : { memory: null, frames: null };
  const values = windows.map(({ window, memoryFloor, hitchRatio, maxHeapMemoryBytes, maxTotalMemoryBytes }) => ({ window, memoryFloor, hitchRatio, maxHeapMemoryBytes, maxTotalMemoryBytes }));
  const record = { ticks: ticks.length, stop, windows: values, memory, frames };
  await writeEvidence(evidence, 'samples.json', `${JSON.stringify(record, null, 2)}\n`);
}

/** The soak session after the scenario on an open page, then the check (ogw.md `### soak test` 2 to 4). */
async function soakOn(input: ClientCheckInput, id: string, page: HeadlessPage, scenario: Scenario, evidence: Evidence): Promise<BuildCheck> {
  const { ctx } = input;
  const targetFps = input.settings.targetFps;
  if (typeof targetFps !== 'number') throw new OgwError('game settings targetFps is not set');
  // the headless browser draws to no display: no refresh rate bounds its fps; core settings that cannot be read stop the check (`unknown`)
  const bound: TickBound = { targetFps, refreshHz: null, levels: (await instanceCoreSettings(ctx, id))?.['QualityCore.levels'] ?? null };
  const session = await soakSession(ctx, id, page, soakBot(scenario), bound, await autoInputGapMs(ctx, id));
  await keepSamples(evidence, session.ticks, session.stop);
  await writeEvidence(evidence, 'console.log', `${page.console.join('\n')}\n`);
  await writeEvidence(evidence, 'server.log', await instanceServerLog(ctx, id).catch((error: unknown) => `the server log could not be read: ${(error as Error).message}\n`));
  return soakVerdict(input.env, session.ticks, session.stop);
}

/**
 * Check `soak test` (`build` `## build-time check`, ogw.md `### soak test`): the bot playtest scenario and then the soak
 * session on a page of the web check export of the check workspaces (made here when no web check made it yet). Null
 * when the build has no web platform or is a PROD build.
 */
export async function soakTest(input: ClientCheckInput): Promise<BuildCheck | null> {
  if (!input.platforms.includes('web') || input.env === 'PROD') return null;
  const { ctx } = input;
  const scenario = await readScenario(checkoutOf(input));
  if (typeof scenario === 'string') {
    const where = failure('client/dev/bot/scenario.json:1', scenario);
    return buildCheckOf(NAME, input.env, [checkResult('no blocker', null, [where]), checkResult('full flow', null, [where])]);
  }
  try {
    const run = await webRunSettings(ctx);
    if (typeof run === 'string') return didNotRun(NAME, run);
    return await withWebExport(input, (own) =>
      withCheckInstance(ctx, input.game, 'web', async (instance, _external, values) =>
        withWebPage(ctx, run, await own.workspaces.webExport(), values, async (page) => {
          const evidence = evidenceOf(input, 'soak-test');
          const { results } = await webScenario(input, instance, page, scenario, run.bootLimitMs, evidence);
          const smoke = ranToEnd(NAME, buildCheckOf(NAME, input.env, results));
          return smoke.result === 'pass' ? soakOn(input, instance.id, page, scenario, evidence) : smoke;
        }),
      checkoutOf(input)),
    );
  } catch (error) {
    return didNotRun(NAME, error);
  }
}
