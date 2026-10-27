import { join, resolve } from 'node:path';
import type { Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { readJson, readText, writeJsonAtomic } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { requireOpenRun } from '../../lib/runstate.ts';
import { getInstance } from '../instance/api.ts';
import { automationRequest } from '../instance/automation.ts';
import { readTelemetryRaw } from '../telemetry/api.ts';
import { showFile } from '../../lib/git.ts';
import { freeScenes } from '../telemetry/lib/compare.ts';
import { metricValue, toTelemetry, type FreeScenes, type Sample } from '../telemetry/lib/metrics.ts';
import { rowProblems, targetRows } from './lib/targets.ts';

/** A design target: a row of `## feel targets` or `## tuning targets`. */
export interface Target {
  metric: string;
  min: number;
  max: number;
  data: string | null;
}

export interface MeasuredTarget extends Target {
  value: number | null;
  result: 'in' | 'out' | 'unknown';
}

/** What `--collect` writes: the telemetry and `QAState` of one instance at that time. */
export interface Collected {
  instance: string;
  commit: string;
  telemetry: unknown;
  state: unknown;
}

/** Rows of the target tables of `design.md` in document order; fails on a row the `design target` static check reports. */
export function parseTargets(design: string): Target[] {
  return targetRows(design).map((row) => {
    const problem = rowProblems(row)[0];
    if (problem !== undefined) throw new OgwError(`design.md:${String(row.line)}: ${problem}`);
    return { metric: row.metric, min: Number(row.min), max: Number(row.max), data: row.data === '' ? null : row.data };
  });
}

export function measureTargets(targets: readonly Target[], samples: readonly Sample[], free: FreeScenes = null): MeasuredTarget[] {
  return targets.map((t) => {
    const value = metricValue(t.metric, samples, free);
    const result = value === null ? 'unknown' : value >= t.min && value <= t.max ? 'in' : 'out';
    return { ...t, value, result };
  });
}

async function collect(ctx: Context, game: string, instanceId: string): Promise<Collected> {
  const info = await getInstance(ctx, instanceId);
  if (info.game !== game) throw new OgwError(`instance ${instanceId} is not of game ${game}`);
  if (info.fixture) throw new OgwError(`instance ${instanceId} was started with a save fixture; ogw measure takes instances started without one`);
  const telemetry = await readTelemetryRaw(ctx, instanceId);
  // A telemetry the metrics cannot read fails this instance's collect, not the measure of every instance.
  toTelemetry(telemetry);
  const state = await automationRequest(ctx, instanceId, 'get_state', []);
  if (!state.ok) throw new OgwError(`get_state failed: ${JSON.stringify(state.result)}`);
  return { instance: instanceId, commit: info.commit, telemetry, state: state.result };
}

function sampleOf(c: Collected): Sample {
  const state = typeof c.state === 'object' && c.state !== null ? (c.state as Record<string, unknown>) : {};
  return { telemetry: toTelemetry(c.telemetry), state };
}

/** Fails when an instance id appears more than once: each instance is one sample. */
export function rejectRepeated(instanceIds: readonly string[]): void {
  const repeated = instanceIds.find((id, i) => instanceIds.indexOf(id) !== i);
  if (repeated !== undefined) throw new OgwError(`instance ${repeated} is given more than once: each instance is one sample`);
}

export interface MeasureResult {
  path: string;
  commit: string;
  targets: MeasuredTarget[];
}

/** Computes the targets of `design.md` and writes `records/loops/<run>/measure-<iteration>.json`. */
export async function measure(ctx: Context, gameName: string, collected: readonly Collected[]): Promise<MeasureResult> {
  const game: GameRepo = await ctx.game(gameName);
  const run = await requireOpenRun(game);
  if (collected.length === 0) throw new OgwError('no instance to measure');
  rejectRepeated(collected.map((c) => c.instance));
  const commits = [...new Set(collected.map((c) => c.commit))];
  if (commits.length > 1) throw new OgwError(`the measured instances are of different commits: ${commits.join(', ')}`);
  const commit = (collected[0] as Collected).commit;
  const guide = await showFile(game.root, commit, 'play-guide.md');
  const free = guide === null ? null : freeScenes(guide.toString('utf8'));
  const targets = measureTargets(parseTargets(await readText(join(game.root, 'design.md'))), collected.map(sampleOf), free);
  const path = join(game.root, 'records', 'loops', run.name, `measure-${String(run.iteration)}.json`);
  await writeJsonAtomic(path, {
    commit,
    targets: targets.map((t) => ({ metric: t.metric, min: t.min, max: t.max, value: t.value, result: t.result, data: t.data })),
  });
  return { path, commit, targets };
}

/** `ogw measure <game> <instance id>...`. */
export async function measureInstances(ctx: Context, game: string, instanceIds: readonly string[]): Promise<MeasureResult> {
  rejectRepeated(instanceIds);
  const collected: Collected[] = [];
  for (const id of instanceIds) collected.push(await collect(ctx, game, id));
  return measure(ctx, game, collected);
}

/** `ogw measure <game> --collect <instance id> --out <file>`. */
export async function collectMeasure(ctx: Context, game: string, instanceId: string, out: string): Promise<void> {
  await writeJsonAtomic(resolve(ctx.cwd, out), await collect(ctx, game, instanceId));
}

function readCollected(value: unknown, file: string): Collected {
  const c = value as Partial<Collected> | null;
  if (!c || typeof c.instance !== 'string' || typeof c.commit !== 'string' || c.telemetry === undefined) {
    throw new OgwError(`not a file of ogw measure --collect: ${file}`);
  }
  try {
    toTelemetry(c.telemetry);
  } catch (error) {
    throw new OgwError(`${file}: ${(error as Error).message}`);
  }
  return { instance: c.instance, commit: c.commit, telemetry: c.telemetry, state: c.state ?? {} };
}

async function readCollectedFiles(ctx: Context, files: readonly string[]): Promise<Collected[]> {
  const collected: Collected[] = [];
  for (const file of files) {
    const path = resolve(ctx.cwd, file);
    collected.push(readCollected(await readJson(path), path));
  }
  return collected;
}

/** `ogw measure <game> --collected <file>...`. */
export async function measureCollected(ctx: Context, game: string, files: readonly string[]): Promise<MeasureResult> {
  return measure(ctx, game, await readCollectedFiles(ctx, files));
}
