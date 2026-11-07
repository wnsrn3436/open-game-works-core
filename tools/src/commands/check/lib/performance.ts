import type { Context } from '../../../lib/command.ts';
import { hostRefreshHz } from '../../../lib/display.ts';
import { withWriterWithin, type RwLock } from '../../../lib/rwlock.ts';
import { automationRequest } from '../../instance/automation.ts';
import type { CheckFailure, CheckResult, HostLoad } from '../api.ts';
import { SCENARIO_WHERE, type InstanceCheckOptions } from './bot-playtest.ts';
import { checkResult, failure, writeEvidence } from './evidence.ts';
import { HostLoadSampler, type HostProbe } from './host-load.ts';
import { withInstance } from './instances.ts';
import { instanceCoreSettings, runScenario, type Scenario, type ScenarioOutcome } from './scenario.ts';

const MOBILE = ['android', 'ios'];
const DESKTOP = ['windows', 'macos', 'linux', 'web'];

/** `performance` `## platform profile`: the first mobile and the first other platform of `buildPlatforms`. */
export function platformProfiles(buildPlatforms: readonly string[]): string[] {
  const mobile = buildPlatforms.find((p) => MOBILE.includes(p));
  const desktop = buildPlatforms.find((p) => DESKTOP.includes(p));
  return [mobile, desktop].filter((p): p is string => p !== undefined);
}

/** `where` of a performance failure of a scene: the scene key, or the scenario file when the client gave none. */
function sceneWhere(key: unknown): string {
  return typeof key === 'string' && key !== '' ? key : SCENARIO_WHERE;
}

/** Interval of the fps sampler that runs alongside the scenario (`performance` `## performance`; a test makes it short). */
export const fpsSampling = { intervalMs: 1000 };

/** Kept samples a scene needs to be judged; a scene with fewer kept samples, and at least one, is unknown. */
export const MIN_SCENE_SAMPLES = 2;

/** One kept fps sample and the fps bound it is compared with. */
export interface FpsSample {
  fps: number;
  boundFps: number;
}

/** One reading of the fps sampler; null when its `get_state` or `get_stats` failed or did not answer ok. */
export type FpsTick = {
  scene: string;
  /** `boot_stage` is `Done` and `in_transition` is not true. */
  settled: boolean;
  /** What a scene load or a restart changes: `scene_key`, `last_scene_load_ms`, `boot_ms`. */
  loadKey: string;
  fps: number | null;
  boundFps: number;
  /** `frame_intervals_ms` of `get_stats`, or null when it is not an array of numbers. */
  intervalsMs: number[] | null;
  /** The frame budget of the tick in ms. */
  budgetMs: number;
} | null;

/** `frame_limit_fps` of the `QualityCore` level named `level` (`quality-core` `### quality profile`), or null without one. */
export function frameLimitFps(targetFps: number, levels: unknown, level: unknown): number | null {
  if (typeof level !== 'string' || level === '' || typeof levels !== 'object' || levels === null) return null;
  const permille = (levels as Record<string, { frameLimitPermille?: unknown } | undefined>)[level]?.frameLimitPermille;
  return typeof permille === 'number' ? Math.max(1, Math.floor((targetFps * permille) / 1000)) : null;
}

/** The smallest of `targetFps`, the refresh rate and the frame limit that are known. */
function frameRateBound(targetFps: number, refreshHz: number | null, frameLimit: number | null): number {
  return Math.min(targetFps, refreshHz ?? targetFps, frameLimit ?? targetFps);
}

/** The fps bound: the smallest of `targetFps`, the refresh rate and the frame limit that are known, minus 1. */
export function fpsBound(targetFps: number, refreshHz: number | null, frameLimit: number | null): number {
  return frameRateBound(targetFps, refreshHz, frameLimit) - 1;
}

/** The frame budget in ms: 1000 ms divided by the smallest of `targetFps`, the refresh rate and the frame limit that are known. */
export function frameBudgetMs(targetFps: number, refreshHz: number | null, frameLimit: number | null): number {
  return 1000 / frameRateBound(targetFps, refreshHz, frameLimit);
}

/** Whether tick `k` has a scene load: it or the tick before was not read, it is not settled, or its load key changed. */
function loadAt(ticks: readonly FpsTick[], k: number): boolean {
  const tick = ticks[k];
  const before = ticks[k - 1];
  return !tick || !before || !tick.settled || tick.loadKey !== before.loadKey;
}

/** Whether tick `k` of `ticks` is kept: it neither has a scene load nor follows one. */
export function isKeptTick(ticks: readonly FpsTick[], k: number): boolean {
  return ticks[k] !== null && !loadAt(ticks, k) && !loadAt(ticks, k - 1);
}

/** The kept ticks: those that neither have a scene load nor follow one. */
function keptTicks(ticks: readonly FpsTick[]): NonNullable<FpsTick>[] {
  return ticks.filter((tick, k): tick is NonNullable<FpsTick> => isKeptTick(ticks, k));
}

/** The samples of the kept ticks by scene, and the scenes of kept ticks whose `get_stats` had no numeric `fps`. */
export function keptSamples(ticks: readonly FpsTick[]): { samples: Map<string, FpsSample[]>; missed: Set<string> } {
  const samples = new Map<string, FpsSample[]>();
  const missed = new Set<string>();
  for (const tick of keptTicks(ticks)) {
    if (tick.fps === null) missed.add(tick.scene);
    else samples.set(tick.scene, [...(samples.get(tick.scene) ?? []), { fps: tick.fps, boundFps: tick.boundFps }]);
  }
  return { samples, missed };
}

/** The frame intervals of one kept tick and the frame budget of that tick. */
export interface FrameTick {
  budgetMs: number;
  intervalsMs: number[];
}

/**
 * The frame intervals of the kept ticks by scene, one entry per kept tick, and the scenes of kept ticks whose
 * `get_stats` had no `frame_intervals_ms` array of numbers.
 */
export function keptFrames(ticks: readonly FpsTick[]): { frames: Map<string, FrameTick[]>; missed: Set<string> } {
  const frames = new Map<string, FrameTick[]>();
  const missed = new Set<string>();
  for (const tick of keptTicks(ticks)) {
    if (tick.intervalsMs === null) missed.add(tick.scene);
    else frames.set(tick.scene, [...(frames.get(tick.scene) ?? []), { budgetMs: tick.budgetMs, intervalsMs: tick.intervalsMs }]);
  }
  return { frames, missed };
}

/** The fixed values of the frame judgement (ogw.md `## performance`), not settings. */
export const FRAMES = { minKeptMs: 10_000, hitchBudgets: 1.5, maxHitchRatio: 10, maxIntervalMs: 100 } as const;

/** The hitch time of a frame interval: the interval minus one frame budget when it is longer than 1.5 frame budgets, else 0. */
export function hitchTimeMs(intervalMs: number, budgetMs: number): number {
  return intervalMs > FRAMES.hitchBudgets * budgetMs ? intervalMs - budgetMs : 0;
}

/** The place and message of a performance failure, before its evidence is known. */
export interface PerformanceFinding {
  where: string;
  message: string;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * The frame judgement of the kept frame intervals. `unknown` holds why the frames cannot be judged: per scene, a kept
 * tick without a `frame_intervals_ms` array of numbers, and kept intervals that add up to less than 10 s. Otherwise
 * `failures` holds a hitch ratio failure at the scene with the largest sum of hitch times and, per scene with a kept
 * interval longer than 100 ms, a long frame failure naming the longest one. Both empty: the frames keep.
 */
export function judgeFrames(frames: ReadonlyMap<string, readonly FrameTick[]>, missed: ReadonlySet<string>): { failures: PerformanceFinding[]; unknown: PerformanceFinding[] } {
  const unknown = [...missed].map((scene) => ({ where: scene, message: 'get_stats of a kept tick has no frame_intervals_ms array of numbers' }));
  const scenes = [...frames].map(([scene, ticks]) => {
    const intervals = ticks.flatMap((t) => t.intervalsMs);
    return {
      scene,
      count: intervals.length,
      keptMs: sum(intervals),
      hitchMs: sum(ticks.flatMap((t) => t.intervalsMs.map((ms) => hitchTimeMs(ms, t.budgetMs)))),
      long: intervals.filter((ms) => ms > FRAMES.maxIntervalMs),
    };
  });
  const keptMs = sum(scenes.map((s) => s.keptMs));
  if (keptMs < FRAMES.minKeptMs) {
    unknown.push({ where: SCENARIO_WHERE, message: `kept frame intervals add up to ${String(Math.floor(keptMs / 10) / 100)} s, less than ${String(FRAMES.minKeptMs / 1000)} s` });
  }
  const failures: PerformanceFinding[] = [];
  // the hitch ratio needs every kept tick's intervals over the least kept time; a long frame fails on its own
  const ratio = unknown.length > 0 ? 0 : sum(scenes.map((s) => s.hitchMs)) / (keptMs / 1000);
  if (ratio >= FRAMES.maxHitchRatio) {
    const worst = scenes.reduce((a, b) => (b.hitchMs > a.hitchMs ? b : a));
    const seconds = (keptMs / 1000).toFixed(1);
    failures.push({
      where: worst.scene,
      message: `hitch ratio ${ratio.toFixed(1)} ms/s is at least ${String(FRAMES.maxHitchRatio)} ms/s over ${seconds} s of kept frames (${worst.hitchMs.toFixed(1)} ms of hitch time in this scene)`,
    });
  }
  for (const s of scenes) {
    if (s.long.length === 0) continue;
    const longest = s.long.reduce((a, b) => Math.max(a, b));
    failures.push({
      where: s.scene,
      message: `frame interval ${String(longest)} ms is longer than ${String(FRAMES.maxIntervalMs)} ms (${String(s.long.length)} of ${String(s.count)} kept intervals of this scene)`,
    });
  }
  return { failures, unknown: failures.length > 0 ? [] : unknown };
}

/** The sample at the 5 percentile of `fps − boundFps` by the nearest-rank method, or null for no samples. */
export function percentile5Sample(samples: readonly FpsSample[]): FpsSample | null {
  const sorted = [...samples].sort((a, b) => a.fps - a.boundFps - (b.fps - b.boundFps));
  return sorted[Math.max(0, Math.ceil((sorted.length * 5) / 100) - 1)] ?? null;
}

/** The scenes with at least {@link MIN_SCENE_SAMPLES} samples and the sample at the 5 percentile of each. */
function judgedScenes(samples: ReadonlyMap<string, readonly FpsSample[]>): { scene: string; count: number; p5: FpsSample }[] {
  return [...samples].flatMap(([scene, values]) => {
    const p5 = percentile5Sample(values);
    return values.length >= MIN_SCENE_SAMPLES && p5 !== null ? [{ scene, count: values.length, p5 }] : [];
  });
}

/** True when at least one scene is judged and every judged scene keeps its fps bound at the 5 percentile. */
export function fpsHolds(samples: ReadonlyMap<string, readonly FpsSample[]>): boolean {
  const judged = judgedScenes(samples);
  return judged.length > 0 && judged.every((j) => j.p5.fps >= j.p5.boundFps);
}

/** `value` when it is an array of numbers, else null. */
function numbers(value: unknown): number[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'number' && Number.isFinite(v)) ? (value as number[]) : null;
}

/** What bounds the fps of a tick: game settings `targetFps`, the refresh rate (null for none) and `QualityCore.levels`. */
export interface TickBound {
  targetFps: number;
  refreshHz: number | null;
  levels: unknown;
}

/** Reads one tick of the fps sampler. */
async function readTick(ctx: Context, id: string, bound: TickBound): Promise<FpsTick> {
  const state = await automationRequest(ctx, id, 'get_state', []);
  const stats = await automationRequest(ctx, id, 'get_stats', []);
  if (!state.ok || !stats.ok) return null;
  return tickOf(state.result, stats.result, bound);
}

/** A tick from the `result` of its `get_state` and `get_stats`, both answered `ok`. */
export function tickOf(stateResult: unknown, statsResult: unknown, bound: TickBound): NonNullable<FpsTick> {
  const s = stateResult as { scene_key?: unknown; boot_stage?: unknown; in_transition?: unknown } | null;
  const t = (statsResult ?? {}) as { fps?: unknown; frame_intervals_ms?: unknown; quality_level?: unknown; last_scene_load_ms?: unknown; boot_ms?: unknown };
  const frameLimit = frameLimitFps(bound.targetFps, bound.levels, t.quality_level);
  return {
    scene: sceneWhere(s?.scene_key),
    settled: s?.boot_stage === 'Done' && s.in_transition !== true,
    loadKey: JSON.stringify([s?.scene_key ?? null, t.last_scene_load_ms ?? null, t.boot_ms ?? null]),
    fps: typeof t.fps === 'number' ? t.fps : null,
    boundFps: fpsBound(bound.targetFps, bound.refreshHz, frameLimit),
    intervalsMs: numbers(t.frame_intervals_ms),
    budgetMs: frameBudgetMs(bound.targetFps, bound.refreshHz, frameLimit),
  };
}

/** Reads a tick every `intervalMs` from its start until `stop`; a tick that throws is not read. */
class FpsSampler {
  private readonly ticks: FpsTick[] = [];
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;

  constructor(read: () => Promise<FpsTick>, intervalMs: number) {
    void this.loop(read, intervalMs);
  }

  private isStopped(): boolean {
    return this.stopped;
  }

  private async loop(read: () => Promise<FpsTick>, intervalMs: number): Promise<void> {
    while (!this.isStopped()) {
      const started = Date.now();
      const tick = await read().catch(() => null);
      if (this.isStopped()) return;
      this.ticks.push(tick);
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, Math.max(0, started + intervalMs - Date.now()));
      });
    }
  }

  /** Stops reading and returns the ticks read; a tick still being read is dropped. */
  stop(): FpsTick[] {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.wake?.();
    return [...this.ticks];
  }
}

export interface PerformanceOptions extends InstanceCheckOptions {
  targetFps: number;
  loadingTimeLimitMs: number;
  /** `QualityCore` is in the module list. */
  quality: boolean;
  probe: HostProbe;
  sampleMs: number;
  /** The performance lease, with harness settings `performanceLeaseWaitTimeoutMs` as its wait (ogw.md `### performance lease`). */
  lease: RwLock;
}

interface SceneLoad {
  scene_key?: unknown;
  duration_ms?: unknown;
}

function fpsFailures(samples: ReadonlyMap<string, readonly FpsSample[]>, evidence: (string | null)[]): CheckFailure[] {
  return judgedScenes(samples)
    .filter((j) => j.p5.fps < j.p5.boundFps)
    .map((j) => failure(j.scene, `fps 5 percentile ${String(j.p5.fps)} is below the fps bound ${String(j.p5.boundFps)} (${String(j.count)} samples)`, evidence));
}

function loadFailures(loads: readonly SceneLoad[], limit: number, evidence: (string | null)[]): CheckFailure[] {
  return loads
    .filter((load) => typeof load.duration_ms === 'number' && load.duration_ms > limit)
    .map((load) =>
      failure(sceneWhere(load.scene_key), `scene load ${String(load.duration_ms)} ms is over loadingTimeLimitMs ${String(limit)}`, evidence),
    );
}

function withLoad(result: CheckResult, hostLoad: HostLoad): CheckResult {
  return { ...result, hostLoad };
}

/** The host load at or above which a `fail` of a measurement is `unknown` (ogw.md `### host load`): fixed values of the check. */
const BUSY_HOST = { memoryPercent: 95, cpuPercent: 90 };

/** One failure per value of `BUSY_HOST` that the host load of a measurement reached, memory first. */
function busyHost(hostLoad: HostLoad, evidence: (string | null)[]): CheckFailure[] {
  return [
    ...(hostLoad.memoryMaxPercent >= BUSY_HOST.memoryPercent ? [failure(SCENARIO_WHERE, `host memory ${String(hostLoad.memoryMaxPercent)}%`, evidence)] : []),
    ...(hostLoad.cpuMaxPercent >= BUSY_HOST.cpuPercent ? [failure(SCENARIO_WHERE, `host CPU ${String(hostLoad.cpuMaxPercent)}%`, evidence)] : []),
  ];
}

/**
 * What `measureScenario` read: the scenario outcome, the kept fps samples by scene, the scenes of kept ticks whose
 * `get_stats` had no numeric `fps`, the kept frame intervals by scene, the scenes of kept ticks whose `get_stats` had
 * no `frame_intervals_ms` array of numbers, and the telemetry `scene_loads` (with the reason when `get_telemetry` did
 * not answer `ok`).
 */
export type ScenarioMeasure =
  | { kind: 'quality'; message: string }
  | {
      kind: 'done';
      outcome: ScenarioOutcome;
      samples: Map<string, FpsSample[]>;
      missedScenes: Set<string>;
      frames: Map<string, FrameTick[]>;
      missedFrames: Set<string>;
      sceneLoads: unknown;
      telemetryError: string | null;
    };

export interface MeasureOptions {
  quality: boolean;
  pollMs: number;
  /** Game settings `targetFps`. */
  targetFps: number;
  /** The client draws on this host, whose display refresh rate bounds its fps; false for a client on a device. */
  onHost: boolean;
  /** Blocker of a client the runner did not start (`ScenarioOptions.blocker`). */
  blocker?: () => Promise<string | null>;
}

/**
 * `performance` `## performance` measurement on the client `main` of an instance: `set_quality_level` `High`
 * when asked, the scenario with the fps sampler alongside it, and the telemetry `scene_loads` after it.
 */
export async function measureScenario(ctx: Context, id: string, scenario: Scenario, options: MeasureOptions): Promise<ScenarioMeasure> {
  if (options.quality) {
    const set = await automationRequest(ctx, id, 'set_quality_level', ['High']);
    if (!set.ok) return { kind: 'quality', message: `set_quality_level High failed: ${JSON.stringify(set.result)}` };
  }
  const bound = {
    targetFps: options.targetFps,
    refreshHz: options.onHost ? await hostRefreshHz(ctx.env) : null,
    levels: (await instanceCoreSettings(ctx, id).catch(() => null))?.['QualityCore.levels'] ?? null,
  };
  const sampler = new FpsSampler(() => readTick(ctx, id, bound), fpsSampling.intervalMs);
  let ticks: FpsTick[];
  let outcome: ScenarioOutcome;
  try {
    outcome = await runScenario(ctx, id, scenario, { pollMs: options.pollMs, ...(options.blocker ? { blocker: options.blocker } : {}) });
  } finally {
    ticks = sampler.stop();
  }
  const { samples, missed: missedScenes } = keptSamples(ticks);
  const { frames, missed: missedFrames } = keptFrames(ticks);
  const kept = { outcome, samples, missedScenes, frames, missedFrames };
  // a client that ended during the run (the scenario stopped on it) gives no telemetry: the reason is the telemetry error
  const telemetry = await automationRequest(ctx, id, 'get_telemetry', []).catch((error: unknown) => (error as Error));
  if (telemetry instanceof Error || !telemetry.ok) {
    const telemetryError = telemetry instanceof Error ? `get_telemetry failed: ${telemetry.message}` : `get_telemetry returned ok false: ${JSON.stringify(telemetry.result)}`;
    return { kind: 'done', ...kept, sceneLoads: null, telemetryError };
  }
  const sceneLoads = (telemetry.result as { scene_loads?: unknown } | null)?.scene_loads ?? null;
  return { kind: 'done', ...kept, sceneLoads, telemetryError: null };
}

/**
 * What a finished measurement could not confirm: telemetry `scene_loads`, a kept fps sample of the run, enough kept
 * samples of each scene that has one, a kept sample of each scene whose `get_stats` had no numeric `fps`, and the
 * frames (`frames`: the `unknown` of `judgeFrames`).
 */
function unmeasured(measured: Extract<ScenarioMeasure, { kind: 'done' }>, frames: readonly PerformanceFinding[], evidence: (string | null)[]): CheckFailure[] {
  const out: CheckFailure[] = [];
  if (measured.telemetryError !== null) out.push(failure(SCENARIO_WHERE, measured.telemetryError, evidence));
  else if (!Array.isArray(measured.sceneLoads)) out.push(failure(SCENARIO_WHERE, `telemetry scene_loads is not a list: ${JSON.stringify(measured.sceneLoads)}`, evidence));
  if (measured.samples.size === 0) out.push(failure(SCENARIO_WHERE, 'no get_stats fps sample in the run outside scene loads', evidence));
  for (const [scene, values] of measured.samples) {
    if (values.length < MIN_SCENE_SAMPLES) out.push(failure(scene, `${String(values.length)} fps samples in this scene, fewer than ${String(MIN_SCENE_SAMPLES)}`, evidence));
  }
  for (const scene of measured.missedScenes) {
    if (measured.samples.size > 0 && !measured.samples.has(scene)) out.push(failure(scene, 'no get_stats fps sample in this scene', evidence));
  }
  for (const f of frames) out.push(failure(f.where, f.message, evidence));
  return out;
}

/**
 * The `performance` verdict of a finished measurement: `fail` with any scene load failure, or with any fps or frame
 * failure of a run that did not stop, else `unknown` when the scenario stopped or something was not measured
 * (`unmeasured`), else `pass`. A load over the limit is a failure however the run ended; the fps samples and frame
 * intervals of a stopped run are partial.
 */
export function performanceVerdict(
  measured: Extract<ScenarioMeasure, { kind: 'done' }>,
  platform: string,
  limits: { loadingTimeLimitMs: number },
  evidence: (string | null)[],
): CheckResult {
  const loads = Array.isArray(measured.sceneLoads) ? (measured.sceneLoads as SceneLoad[]) : [];
  const loadMisses = loadFailures(loads, limits.loadingTimeLimitMs, evidence);
  const stop = measured.outcome.stop;
  if (stop !== null) {
    if (loadMisses.length > 0) return checkResult('performance', platform, loadMisses);
    const stopped = failure(`step ${String(stop.step)}`, `scenario stopped: ${stop.message}`, evidence);
    return checkResult('performance', platform, [stopped], true);
  }
  const frames = judgeFrames(measured.frames, measured.missedFrames);
  const failures = [...fpsFailures(measured.samples, evidence), ...frames.failures.map((f) => failure(f.where, f.message, evidence)), ...loadMisses];
  if (failures.length > 0) return checkResult('performance', platform, failures);
  const missing = unmeasured(measured, frames.unknown, evidence);
  return checkResult('performance', platform, missing, missing.length > 0);
}

async function measure(ctx: Context, id: string, platform: string, scenario: Scenario, options: PerformanceOptions, sampler: HostLoadSampler): Promise<CheckResult> {
  const measured = await measureScenario(ctx, id, scenario, { quality: options.quality, pollMs: options.pollMs, targetFps: options.targetFps, onHost: true });
  const hostLoad = await sampler.stop();
  if (measured.kind === 'quality') return withLoad(checkResult('performance', platform, [failure(SCENARIO_WHERE, measured.message)], true), hostLoad);
  const record = { samples: Object.fromEntries(measured.samples), frameIntervals: Object.fromEntries(measured.frames), scene_loads: measured.sceneLoads, hostLoad };
  const evidence = [await writeEvidence(options.evidence, `performance-${platform}/samples.json`, `${JSON.stringify(record, null, 2)}\n`)];
  const verdict = performanceVerdict(measured, platform, options, evidence);
  const busy = verdict.result === 'fail' ? busyHost(hostLoad, evidence) : [];
  return withLoad(busy.length > 0 ? checkResult('performance', platform, busy, true) : verdict, hostLoad);
}

/** performance of one platform profile: the bot playtest scenario again in an instance that draws the screen. */
export async function performanceCheck(ctx: Context, game: string, platform: string, scenario: Scenario | string, options: PerformanceOptions): Promise<CheckResult> {
  const started: { sampler?: HostLoadSampler } = {};
  try {
    if (typeof scenario === 'string') throw new Error(scenario);
    return await withInstance(ctx, options.slots, { game, platform, client: 'window', db: options.db }, async (instance) => {
      started.sampler = new HostLoadSampler(options.probe, options.sampleMs, instance.id);
      return measure(ctx, instance.id, platform, scenario, options, started.sampler);
    }, options.evidence);
  } catch (error) {
    const hostLoad = await (started.sampler ?? new HostLoadSampler(options.probe, options.sampleMs)).stop();
    return withLoad(checkResult('performance', platform, [failure(SCENARIO_WHERE, `performance did not run: ${(error as Error).message}`)], true), hostLoad);
  }
}

/**
 * performance of every platform profile, one profile at a time so that no other instance of the check runs beside the
 * measured one (ogw.md `## performance`), holding the performance lease exclusively across all of them (ogw.md
 * `### performance lease`). When the lease does not come within its wait, nothing is measured and each item is
 * `unknown`, with the host load read during the wait.
 */
export async function performanceChecks(ctx: Context, game: string, platforms: readonly string[], scenario: Scenario | string, options: PerformanceOptions): Promise<CheckResult[]> {
  const each = async (): Promise<CheckResult[]> => {
    const results: CheckResult[] = [];
    for (const p of platforms) results.push(await performanceCheck(ctx, game, p, scenario, options));
    return results;
  };
  // nothing to measure: the items say why without waiting for the lease
  if (platforms.length === 0 || typeof scenario === 'string') return each();
  const waiting = new HostLoadSampler(options.probe, options.sampleMs);
  const unknown = async (message: string): Promise<CheckResult[]> => {
    const hostLoad = await waiting.stop();
    return platforms.map((p) => withLoad(checkResult('performance', p, [failure(SCENARIO_WHERE, message)], true), hostLoad));
  };
  try {
    const leased = await withWriterWithin(options.lease, async () => {
      await waiting.stop();
      return each();
    });
    if (leased.ran) return leased.value;
    return await unknown(leased.waited === 'readers' ? 'host busy: local generation' : 'host busy: performance measurement');
  } catch (error) {
    return unknown(`performance did not run: ${(error as Error).message}`);
  }
}
