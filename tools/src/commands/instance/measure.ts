import { readdir, rm } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { expectPositionals, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists, readText } from '../../lib/fsx.ts';
import { LIMITS } from '../../lib/limits.ts';
import { loadGameSettings, type GenerationMethod } from '../../lib/settings.ts';
import { coreRelease, remoteReleaseVersions } from '../core/api.ts';
import { extractArchive } from '../env/lib/files.ts';
import { newPrivateTempFolder } from '../../lib/secret-files.ts';
import { compareVersions, parseVersion } from '../env/lib/pep440.ts';
import { readEnvResult, writeEnvResult, type InstanceMeasureTarget, type MeasuredRun } from '../env/lib/results.ts';
import { MIN_SCENE_SAMPLES, fpsHolds, measureScenario } from '../check/lib/performance.ts';
import { parseScenario, type Scenario } from '../check/lib/scenario.ts';
import { runStandardStage } from '../generation/lib/standard.ts';
import { startInstance, stopInstance, type InstanceInfo, type InstanceOptions } from './api.ts';
import { gameTargetFps } from './lib/prepare.ts';

/** Interval of `get_state` polling while a scenario condition is not true yet. */
export const measureTiming = { pollMs: 200 };

/** The CPU count the first measured count comes from when this host has no measured value (a test replaces it). */
export const measureHost = { cpus: (): number => availableParallelism() };

/** Instance options for a game repo outside `games/`: the benchmark game unpacked from a core release. */
export interface MeasureInstanceOptions extends InstanceOptions {
  /** Game repo folder to run instead of `games/<game>/`. */
  root?: string;
  /** Core version to run the game with instead of its game settings `coreVersion`. */
  coreVersion?: string;
}

interface Target {
  name: string;
  kind: 'benchmark' | 'game';
  options: MeasureInstanceOptions;
  /** The parsed `client/dev/bot/scenario.json`, or why it could not be parsed. */
  scenario: Scenario | string;
  targetFps: number;
}

async function readScenario(path: string): Promise<Scenario | string> {
  return parseScenario(await readText(path));
}

function byVersionDescending(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  return va && vb ? compareVersions(vb, va) : 0;
}

/** The benchmark games of the highest core release that has a `benchmark-<engine>.zip`. */
async function benchmarkTargets(ctx: Context, scratch: string[]): Promise<Target[]> {
  for (const version of [...(await remoteReleaseVersions(ctx))].sort(byVersionDescending)) {
    const release = await coreRelease(ctx, version);
    const zips = (await readdir(release.dir)).filter((f) => /^benchmark-.+\.zip$/.test(f)).sort();
    if (zips.length === 0) continue;
    const targets: Target[] = [];
    for (const zip of zips) {
      const root = await newPrivateTempFolder('ogw-benchmark-', ctx.env);
      scratch.push(root);
      await extractArchive(join(release.dir, zip), root, ctx.env);
      const game = zip.slice(0, -'.zip'.length);
      targets.push({
        name: `${game} ${version}`,
        kind: 'benchmark',
        options: { game, client: 'window', root, coreVersion: version },
        scenario: await readScenario(join(root, 'client', 'dev', 'bot', 'scenario.json')),
        targetFps: await gameTargetFps(ctx.env, {}),
      });
    }
    return targets;
  }
  return [];
}

async function gameTargets(ctx: Context): Promise<Target[]> {
  const games = (await ctx.workspace()).games;
  if (!exists(games)) return [];
  const targets: Target[] = [];
  for (const name of (await readdir(games)).sort()) {
    const scenarioPath = join(games, name, 'client', 'dev', 'bot', 'scenario.json');
    if (!exists(scenarioPath)) continue;
    const settings = await loadGameSettings(join(games, name));
    targets.push({
      name,
      kind: 'game',
      options: { game: name, client: 'window' },
      scenario: await readScenario(scenarioPath),
      targetFps: await gameTargetFps(ctx.env, settings),
    });
  }
  return targets;
}

/**
 * Runs the scenario on one instance with the fps sampler of the `performance` judgement alongside it. `holds` is true
 * when it ran to the end and kept the fps bound; a run in which no scene got enough fps samples did not hold, with its
 * reason.
 */
async function scenarioHolds(ctx: Context, id: string, scenario: Scenario, targetFps: number): Promise<{ holds: boolean; reason: string | null }> {
  const measured = await measureScenario(ctx, id, scenario, { quality: false, pollMs: measureTiming.pollMs, targetFps, onHost: true });
  if (measured.kind !== 'done' || measured.outcome.stop !== null) return { holds: false, reason: null };
  if (fpsHolds(measured.samples)) return { holds: true, reason: null };
  const judged = [...measured.samples.values()].some((values) => values.length >= MIN_SCENE_SAMPLES);
  return { holds: false, reason: judged ? null : `instance ${id}: no scene got ${String(MIN_SCENE_SAMPLES)} fps samples outside scene loads` };
}

/**
 * Starts `count` instances together (measure is not bound by `maxConcurrentInstances`), runs the scenario on each, and
 * stops them.
 * `holds` is true when all kept the fps condition; otherwise `reason` says why when it is not the fps condition.
 */
async function countHolds(ctx: Context, target: Target, scenario: Scenario, count: number): Promise<{ holds: boolean; reason: string | null }> {
  const started: InstanceInfo[] = [];
  try {
    const starts = await Promise.allSettled(Array.from({ length: count }, () => startInstance(ctx, { ...target.options, ignoreConcurrencyLimit: true })));
    for (const start of starts) if (start.status === 'fulfilled') started.push(start.value);
    const failed = starts.findIndex((start) => start.status === 'rejected');
    if (failed >= 0) {
      const error = (starts[failed] as PromiseRejectedResult).reason as Error;
      // one instance that does not start is not a measured count: the measure fails with the reason (`host-env` 5)
      if (count === 1) throw new OgwError(`${target.name}: the first instance did not start: ${error.message}`);
      return { holds: false, reason: `instance ${String(failed + 1)} of ${String(count)} did not start: ${error.message}` };
    }
    const held = await Promise.all(started.map((info) => scenarioHolds(ctx, info.id, scenario, target.targetFps)));
    return { holds: held.every((h) => h.holds), reason: held.find((h) => h.reason !== null)?.reason ?? null };
  } finally {
    for (const info of started) await stopInstance(ctx, info.id).catch(() => undefined);
  }
}

/**
 * The count measured first (`host-env` 5): this host's last value, else half its CPU count, within 1 and the upper bound
 * `limit` (harness settings `instanceMeasureLimit`).
 */
export function firstCount(previous: number | null, cpus: number, limit: number): number {
  return Math.min(limit, Math.max(1, previous ?? Math.floor(cpus / 2)));
}

/**
 * The count to measure after the largest count that held (`held`, 0 for none) and the smallest that did not (`broke`,
 * above the upper bound for none), or null when they are next to each other. With no broken count yet it measures the
 * count after this host's last value, then doubles; with no held count it halves; otherwise it takes the middle.
 */
export function nextCount(held: number, broke: number, previous: number | null, limit: number): number | null {
  if (broke - held <= 1) return null;
  if (broke > limit) return held === previous ? held + 1 : Math.min(limit, held * 2);
  if (held === 0) return Math.max(1, Math.floor(broke / 2));
  return Math.floor((held + broke) / 2);
}

async function measureTarget(ctx: Context, target: Target, aborted: () => boolean, previous: number | null, limit: number): Promise<InstanceMeasureTarget> {
  const scenario = target.scenario;
  if (typeof scenario === 'string') return { name: target.name, kind: target.kind, value: 0, detail: `scenario.json: ${scenario}` };
  // instance counts are taken to hold up to one count and break above it: more instances give less fps
  let held = 0;
  let broke = limit + 1;
  let detail: string | null = null;
  let count: number | null = firstCount(previous, measureHost.cpus(), limit);
  while (count !== null && !aborted()) {
    const { holds, reason } = await countHolds(ctx, target, scenario, count);
    if (holds) held = count;
    else {
      broke = count;
      // a count that broke on fps has no reason: it keeps the reason of a larger count that did not start
      detail = reason ?? detail;
    }
    count = nextCount(held, broke, previous, limit);
  }
  if (held === limit) detail = `stopped at the upper bound ${String(limit)} (instanceMeasureLimit)`;
  return { name: target.name, kind: target.kind, value: held, detail };
}

/** The `ok` local-model standard test stage with the largest peak memory in the last `generation measure`. */
async function heaviestJob(ctx: Context): Promise<{ method: GenerationMethod; step: MeasuredRun } | null> {
  const measure = await readEnvResult(ctx, 'generation-measure');
  const settings = await ctx.settings();
  let best: { method: GenerationMethod; step: MeasuredRun } | null = null;
  for (const method of settings.resourceGeneration.filter((m) => m.kind === 'local-model')) {
    for (const step of measure?.methods[method.name]?.steps ?? []) {
      if (step.result !== 'ok' || step.maxMemoryBytes === null) continue;
      if (best === null || step.maxMemoryBytes > (best.step.maxMemoryBytes ?? 0)) best = { method, step };
    }
  }
  return best;
}

/** Runs the heaviest standard test job again and again until `stopped`; throws when a run is not `ok`. */
async function loadLoop(ctx: Context, job: { method: GenerationMethod; step: MeasuredRun }, stopped: () => boolean): Promise<void> {
  const stage = {
    ...(job.step.resolution === undefined ? {} : { resolution: job.step.resolution }),
    ...(job.step.durationMs === undefined ? {} : { durationMs: job.step.durationMs }),
  };
  while (!stopped()) {
    const run = await runStandardStage(ctx, job.method, stage);
    if (run.result !== 'ok') throw new Error(`${job.method.name} ${run.result}: ${run.error ?? run.detail ?? 'no error output'}`);
  }
}

export const measureCommand: CommandDef = {
  name: ['instance', 'measure'],
  usage: 'ogw instance measure',
  background: { timeLimitMs: () => LIMITS.jobMs },
  async run(ctx, args) {
    expectPositionals(args, 0, 0, this.usage);
    const scratch: string[] = [];
    try {
      const targets = [...(await benchmarkTargets(ctx, scratch)), ...(await gameTargets(ctx))];
      if (targets.length === 0) {
        const path = await writeEnvResult(ctx, 'instance-measure', { measuredAt: Date.now(), targets: [] });
        return { text: `not measured: no core release has benchmark-<engine>.zip and no game has client/dev/bot/scenario.json\nresult: ${path}`, data: { targets: [], resultFile: path } };
      }
      const job = await heaviestJob(ctx);
      const { maxConcurrentInstances: previous, instanceMeasureLimit: limit } = await ctx.settings();
      let stop = false;
      // a load job that fails leaves the instances measured without the load: the measure fails (`host-env` 5)
      const failed: { error: Error | null } = { error: null };
      const load = job === null ? Promise.resolve() : loadLoop(ctx, job, () => stop).catch((error: unknown) => {
        failed.error = error as Error;
      });
      const results: InstanceMeasureTarget[] = [];
      try {
        // after a load job failure, no further count or target is measured
        for (const target of targets) {
          if (failed.error !== null) break;
          results.push(await measureTarget(ctx, target, () => failed.error !== null, previous, limit));
        }
      } finally {
        stop = true;
        await load;
      }
      if (failed.error !== null) throw new OgwError(`the generation load job failed while measuring: ${failed.error.message}`);
      const path = await writeEnvResult(ctx, 'instance-measure', { measuredAt: Date.now(), targets: results });
      const lines = results.map((r) => `${r.name}: ${String(r.value)}${r.detail === null ? '' : ` (${r.detail})`}`);
      const loadLine = job === null ? 'no generation load job' : `generation load job: ${job.method.name}`;
      return { text: [...lines, loadLine, `result: ${path}`].join('\n'), data: { targets: results, resultFile: path } };
    } finally {
      for (const dir of scratch) await rm(dir, { recursive: true, force: true });
    }
  },
};
