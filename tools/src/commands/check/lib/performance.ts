import type { Context } from '../../../lib/command.ts';
import { automationRequest } from '../../instance/automation.ts';
import type { CheckFailure, CheckResult, HostLoad } from '../api.ts';
import { SCENARIO_WHERE, type InstanceCheckOptions } from './bot-playtest.ts';
import { checkResult, failure, writeEvidence } from './evidence.ts';
import { HostLoadSampler, type HostProbe } from './host-load.ts';
import { withInstance } from './instances.ts';
import { runScenario, type Scenario, type ScenarioOutcome } from './scenario.ts';

const MOBILE = ['android', 'ios'];
const DESKTOP = ['windows', 'macos', 'linux', 'web'];

/** `performance` `## platform profile`: the first mobile and the first other platform of `buildPlatforms`. */
export function platformProfiles(buildPlatforms: readonly string[]): string[] {
  const mobile = buildPlatforms.find((p) => MOBILE.includes(p));
  const desktop = buildPlatforms.find((p) => DESKTOP.includes(p));
  return [mobile, desktop].filter((p): p is string => p !== undefined);
}

/** 5 percentile by the nearest-rank method: the ⌈5n/100⌉-th smallest of n samples. */
export function percentile5(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((sorted.length * 5) / 100) - 1)] ?? 0;
}

/** `where` of a performance failure of a scene: the scene key, or the scenario file when the client gave none. */
function sceneWhere(key: unknown): string {
  return typeof key === 'string' && key !== '' ? key : SCENARIO_WHERE;
}

/**
 * Adds one `get_stats` `fps` sample under the `get_state` `scene_key` of the instance (`sceneWhere`). Without a
 * numeric `fps`, adds the scene to `missed` instead.
 */
export async function sampleFps(ctx: Context, id: string, samples: Map<string, number[]>, missed?: Set<string>): Promise<void> {
  const stats = (await automationRequest(ctx, id, 'get_stats', [])).result as { fps?: unknown } | null;
  const state = (await automationRequest(ctx, id, 'get_state', [])).result as { scene_key?: unknown } | null;
  const scene = sceneWhere(state?.scene_key);
  if (typeof stats?.fps !== 'number') {
    missed?.add(scene);
    return;
  }
  samples.set(scene, [...(samples.get(scene) ?? []), stats.fps]);
}

/** True when the 5 percentile fps of every scene is at least `targetFps`. */
export function fpsHolds(samples: ReadonlyMap<string, readonly number[]>, targetFps: number): boolean {
  return [...samples.values()].every((values) => percentile5(values) >= targetFps);
}

export interface PerformanceOptions extends InstanceCheckOptions {
  targetFps: number;
  loadingTimeLimitMs: number;
  /** `QualityCore` is in the module list. */
  quality: boolean;
  probe: HostProbe;
  sampleMs: number;
}

interface SceneLoad {
  scene_key?: unknown;
  duration_ms?: unknown;
}

function fpsFailures(samples: Map<string, number[]>, targetFps: number, evidence: (string | null)[]): CheckFailure[] {
  const failures: CheckFailure[] = [];
  for (const [scene, values] of samples) {
    const p5 = percentile5(values);
    if (p5 < targetFps) {
      failures.push(failure(scene, `fps 5 percentile ${String(p5)} is below targetFps ${String(targetFps)} (${String(values.length)} samples)`, evidence));
    }
  }
  return failures;
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

/**
 * What `measureScenario` read: the scenario outcome, the fps samples by scene, the scenes of steps whose `get_stats`
 * had no numeric `fps`, and the telemetry `scene_loads` (with the reason when `get_telemetry` did not answer `ok`).
 */
export type ScenarioMeasure =
  | { kind: 'quality'; message: string }
  | {
      kind: 'done';
      outcome: ScenarioOutcome;
      samples: Map<string, number[]>;
      missedScenes: Set<string>;
      sceneLoads: unknown;
      telemetryError: string | null;
    };

export interface MeasureOptions {
  quality: boolean;
  pollMs: number;
  /** Blocker of a client the runner did not start (`ScenarioOptions.blocker`). */
  blocker?: () => Promise<string | null>;
}

/**
 * `performance` `## performance` measurement on the client `main` of an instance: `set_quality_level` `High`
 * when asked, the scenario with one `get_stats` `fps` sample per step under the `scene_key` of that time,
 * and the telemetry `scene_loads` after it.
 */
export async function measureScenario(ctx: Context, id: string, scenario: Scenario, options: MeasureOptions): Promise<ScenarioMeasure> {
  if (options.quality) {
    const set = await automationRequest(ctx, id, 'set_quality_level', ['High']);
    if (!set.ok) return { kind: 'quality', message: `set_quality_level High failed: ${JSON.stringify(set.result)}` };
  }
  const samples = new Map<string, number[]>();
  const missedScenes = new Set<string>();
  const afterStep = (): Promise<void> => sampleFps(ctx, id, samples, missedScenes);
  const outcome = await runScenario(ctx, id, scenario, { pollMs: options.pollMs, afterStep, ...(options.blocker ? { blocker: options.blocker } : {}) });
  const telemetry = await automationRequest(ctx, id, 'get_telemetry', []);
  if (!telemetry.ok) {
    const telemetryError = `get_telemetry returned ok false: ${JSON.stringify(telemetry.result)}`;
    return { kind: 'done', outcome, samples, missedScenes, sceneLoads: null, telemetryError };
  }
  const sceneLoads = (telemetry.result as { scene_loads?: unknown } | null)?.scene_loads ?? null;
  return { kind: 'done', outcome, samples, missedScenes, sceneLoads, telemetryError: null };
}

/** What a finished measurement could not confirm: telemetry `scene_loads`, and an fps sample of the run and of each scene. */
function unmeasured(measured: Extract<ScenarioMeasure, { kind: 'done' }>, evidence: (string | null)[]): CheckFailure[] {
  const out: CheckFailure[] = [];
  if (measured.telemetryError !== null) out.push(failure(SCENARIO_WHERE, measured.telemetryError, evidence));
  else if (!Array.isArray(measured.sceneLoads)) out.push(failure(SCENARIO_WHERE, `telemetry scene_loads is not a list: ${JSON.stringify(measured.sceneLoads)}`, evidence));
  if (measured.samples.size === 0) out.push(failure(SCENARIO_WHERE, 'no get_stats fps sample in the run', evidence));
  for (const scene of measured.missedScenes) {
    if (measured.samples.size > 0 && !measured.samples.has(scene)) out.push(failure(scene, 'no get_stats fps sample in this scene', evidence));
  }
  return out;
}

/**
 * The `performance` verdict of a finished measurement: `fail` with any scene load failure, or with any fps failure of a
 * run that did not stop, else `unknown` when the scenario stopped or something was not measured (`unmeasured`), else
 * `pass`. A load over the limit is a failure however the run ended; the fps of a stopped run is a partial sample.
 */
export function performanceVerdict(
  measured: Extract<ScenarioMeasure, { kind: 'done' }>,
  platform: string,
  limits: { targetFps: number; loadingTimeLimitMs: number },
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
  const failures = [...fpsFailures(measured.samples, limits.targetFps, evidence), ...loadMisses];
  if (failures.length > 0) return checkResult('performance', platform, failures);
  const missing = unmeasured(measured, evidence);
  return checkResult('performance', platform, missing, missing.length > 0);
}

async function measure(ctx: Context, id: string, platform: string, scenario: Scenario, options: PerformanceOptions, sampler: HostLoadSampler): Promise<CheckResult> {
  const measured = await measureScenario(ctx, id, scenario, options);
  const hostLoad = await sampler.stop();
  if (measured.kind === 'quality') return withLoad(checkResult('performance', platform, [failure(SCENARIO_WHERE, measured.message)], true), hostLoad);
  const record = { samples: Object.fromEntries(measured.samples), scene_loads: measured.sceneLoads, hostLoad };
  const evidence = [await writeEvidence(options.evidence, `performance-${platform}/samples.json`, `${JSON.stringify(record, null, 2)}\n`)];
  return withLoad(performanceVerdict(measured, platform, options, evidence), hostLoad);
}

/** performance of one platform profile: the bot playtest scenario again in an instance that draws the screen. */
export async function performanceCheck(ctx: Context, game: string, platform: string, scenario: Scenario | string, options: PerformanceOptions): Promise<CheckResult> {
  const started: { sampler?: HostLoadSampler } = {};
  try {
    if (typeof scenario === 'string') throw new Error(scenario);
    return await withInstance(ctx, options.slots, { game, platform, client: 'window', db: options.db }, async (instance) => {
      started.sampler = new HostLoadSampler(options.probe, options.sampleMs);
      return measure(ctx, instance.id, platform, scenario, options, started.sampler);
    }, options.evidence);
  } catch (error) {
    const hostLoad = await (started.sampler ?? new HostLoadSampler(options.probe, options.sampleMs)).stop();
    return withLoad(checkResult('performance', platform, [failure(SCENARIO_WHERE, `performance did not run: ${(error as Error).message}`)], true), hostLoad);
  }
}
