import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { span } from '../../../lib/spans.ts';
import { writeJsonAtomic } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { commitPaths, head } from '../../../lib/git.ts';
import { requireOpenRun } from '../../../lib/runstate.ts';
import type { GameSettings } from '../../../lib/settings.ts';
import { gameModules, mergedCoreSettings } from '../../generate/api.ts';
import { CHECK_ORDER, GATE_CHECKS, mergedResult, placeholderFailures, type CheckResult } from '../api.ts';
import { staticCheck } from '../static-api.ts';
import { botPlaytest, readScenario, type InstanceCheckOptions } from './bot-playtest.ts';
import { coreSetting, importClient } from './engine.ts';
import { checkResult, failure, type Evidence } from './evidence.ts';
import { Slots } from './instances.ts';
import { regressionTest } from './regression.ts';
import { iterationKind } from '../../loop/lib/run.ts';
import { platformProfiles, uiQualityCheck, type UiCheckScreen, type UiQualityLimits } from './ui-quality.ts';

export { CHECK_ORDER };

export function gateOf(checks: readonly CheckResult[]): 'pass' | 'fail' {
  return GATE_CHECKS.every((name) => mergedResult(checks.filter((c) => c.name === name)) === 'pass') ? 'pass' : 'fail';
}

export interface LoopOptions {
  godot: string;
  db?: 'postgresql';
  /** Polling interval of instance state. */
  pollMs: number;
}

export interface LoopOutcome {
  file: string;
  commit: string;
  checks: CheckResult[];
  gate: 'pass' | 'fail';
}

/**
 * Runs a check; an error it throws makes it `unknown` (what was not checked is not a failure), at `where`: line 1 of
 * the file or folder the check reads (ogw.md `## check`: a file:line).
 */
async function guarded(name: string, where: string, work: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await work();
  } catch (error) {
    return checkResult(name, null, [failure(where, `${name} did not run: ${(error as Error).message}`)], true);
  }
}

/** The largest `AccessibilityCore.textScales` of the merged core settings, or null without `AccessibilityCore`. */
function maxTextScale(merged: Record<string, unknown>, client: readonly string[]): number | null {
  if (!client.includes('AccessibilityCore')) return null;
  const scales = coreSetting(merged, 'AccessibilityCore.textScales');
  const numbers = Array.isArray(scales) ? scales.filter((s): s is number => typeof s === 'number') : [];
  return numbers.length > 0 ? Math.max(...numbers) : 1000;
}

/** A number of the merged core settings, or null when they do not have it. */
function coreNumber(merged: Record<string, unknown>, key: string): number | null {
  const value = coreSetting(merged, key);
  return typeof value === 'number' ? value : null;
}

/** Core settings `UnitTestCore.startTimeLimitMs` of the game, or null when the merged core settings do not have it. */
export async function startTimeLimitMs(ctx: Context, game: GameRepo): Promise<number | null> {
  return coreNumber(await mergedCoreSettings(ctx, game), 'UnitTestCore.startTimeLimitMs');
}

/** Core settings `UnitTestCore.runTimeLimitMs` of the game, or null when the merged core settings do not have it. */
export async function runTimeLimitMs(ctx: Context, game: GameRepo): Promise<number | null> {
  return coreNumber(await mergedCoreSettings(ctx, game), 'UnitTestCore.runTimeLimitMs');
}

export async function slotsOf(ctx: Context): Promise<Slots> {
  const max = (await ctx.settings()).maxConcurrentInstances;
  if (max === null) throw new OgwError('harness settings maxConcurrentInstances is null: do update env first');
  return new Slots(max);
}

/**
 * Checks of `gameChecks`: every check of iteration step 2 (`all`), those of a fun iteration (`fun`), or those of
 * `ogw core try`. `no blocker` and `full flow` come from one bot playtest.
 */
export type CheckSet = 'all' | 'fun' | 'core try';

/** The values of game settings that the UI quality check reads. */
function uiSettings(settings: GameSettings): { languages: string[]; screens: UiCheckScreen[]; baseResolution: [number, number]; gamepadSupported: boolean; quality: UiQualityLimits } {
  return {
    languages: settings.supportedLanguages ?? [],
    screens: (settings.uiCheckScreens ?? []) as UiCheckScreen[],
    baseResolution: (settings.baseResolution ?? [0, 0]) as [number, number],
    gamepadSupported: settings.gamepadSupported === true,
    quality: settings.uiQuality as UiQualityLimits,
  };
}

/**
 * The checks of iteration step 2 on the checkout of `game`, with evidence in `evidence`, sorted in `CHECK_ORDER`;
 * `core try` leaves out `no placeholder`; `fun` runs only the regression test, the static check and the bot playtest
 * (ogw.md `## check`). The work that does not read the checkout's `client/` (the server regression test and no
 * placeholder) runs beside its import.
 */
export async function gameChecks(
  ctx: Context,
  game: GameRepo,
  settings: GameSettings,
  options: LoopOptions,
  evidence: Evidence,
  set: CheckSet,
): Promise<CheckResult[]> {
  const [slots, modules, scenario, merged] = await Promise.all([slotsOf(ctx), gameModules(ctx, game), readScenario(game.root), mergedCoreSettings(ctx, game)]);
  const instance: InstanceCheckOptions = { evidence, slots, db: options.db, pollMs: options.pollMs };
  const profiles = platformProfiles(settings.buildPlatforms ?? []);
  const ui = { ...instance, ...uiSettings(settings), maxTextScale: maxTextScale(merged, modules.client) };
  // One import before the instances start, with the engine packages put in first: an instance skips its import once
  // `client/.godot/` exists, so no import may still be writing it when the instances start, and the import that the
  // instance clients run on holds the plugins that their runner's `ogw generate` puts in later. A failed import removed
  // `client/.godot/` (each instance start then fails on its own import); the regression test and the type check report
  // it and do not import again. The static check waits for it too, as the import may write files beside the scripts and
  // assets of `client/`, which the static check lists. An import that throws fails the check once the work started ends.
  // Its step is named apart from the `import` of an instance start, which skips once `client/.godot/` exists, and in
  // `ogw core try`, whose fresh worktree has no import yet, apart from that of the checkouts of `ogw check`: `outlier`
  // of `ogw time` compares a step only with the earlier steps of its name (ogw.md `## time`).
  const importing = span(set === 'core try' ? 'core try import' : 'check import', () => importClient(ctx, options.godot, game));
  const settled = importing.then(
    (importFailure): { imported: true } | { importFailure: string } => (importFailure === null ? { imported: true } : { importFailure }),
    (error: unknown) => ({ error }),
  );
  const afterImport = <T>(work: (imported: { imported: true } | { importFailure: string }) => Promise<T>): Promise<T | null> =>
    settled.then((done) => ('error' in done ? null : work(done)));
  const db = options.db ? { db: options.db } : {};
  const limits = { runTimeLimitMs: coreNumber(merged, 'UnitTestCore.runTimeLimitMs'), startTimeLimitMs: coreNumber(merged, 'UnitTestCore.startTimeLimitMs') };
  const client = { godot: options.godot, evidence, ...limits, importing, ...db };
  const all = set === 'all';
  const fun = set === 'fun';
  // the instances of the check, in this order once the import ended
  const instances: Promise<CheckResult | CheckResult[] | null>[] = [
    afterImport(() => span('bot playtest', () => botPlaytest(ctx, game.name, scenario, instance))),
    ...(fun ? [] : profiles.map((p) => afterImport(() => span(`UI quality ${p}`, () => uiQualityCheck(ctx, game.name, p, ui))))),
  ];
  const tasks: Promise<CheckResult | CheckResult[] | null>[] = [
    span('regression test', () => guarded('regression test', 'client/tests:1', () => regressionTest(ctx, game, { client: 'client/tests', server: 'server/tests' }, client))),
    afterImport((imported) => span('static check', () => guarded('static check', 'settings.json:1', () => staticCheck(ctx, game, { ...db, ...imported })))),
    ...instances,
    ...(all ? [span('no placeholder', () => guarded('no placeholder', 'resource/resources.csv:1', async () => checkResult('no placeholder', null, await placeholderFailures(ctx, game))))] : []),
  ];
  const results = await Promise.all(tasks);
  const done = await settled;
  if ('error' in done) throw done.error;
  return results.flatMap((r) => (r === null ? [] : [r].flat())).sort((a, b) => CHECK_ORDER.indexOf(a.name) - CHECK_ORDER.indexOf(b.name));
}

/** `ogw check <game> --loop`: the checks of iteration step 2 for the kind of the iteration, the result file, and `gate`. */
export async function loopCheck(ctx: Context, game: GameRepo, settings: GameSettings, options: LoopOptions): Promise<LoopOutcome> {
  const run = await requireOpenRun(game);
  if (run.iteration < 1) throw new OgwError(`run ${run.name} has no iteration yet`);
  const records = `records/loops/${run.name}`;
  const evidenceDir = `${records}/evidence/check-${String(run.iteration)}`;
  await rm(join(game.root, evidenceDir), { recursive: true, force: true });
  const commit = await head(game.root, { env: ctx.env });
  const evidence: Evidence = { root: game.root, dir: evidenceDir, relative: true };
  const set = iterationKind(run, run.iteration) === 'fun' ? 'fun' : 'all';
  const checks = await gameChecks(ctx, game, settings, options, evidence, set);
  const file = `${records}/check-${String(run.iteration)}.json`;
  const gate = gateOf(checks);
  await span('record', async () => {
    await writeJsonAtomic(join(game.root, file), { commit, checks, gate });
    await commitPaths(game.root, [file], `loop ${run.name}: check ${String(run.iteration)}`, { env: ctx.env });
  });
  return { file, commit, checks, gate };
}
