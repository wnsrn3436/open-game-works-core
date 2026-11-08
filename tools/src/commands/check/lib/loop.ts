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
import { performanceLeaseBase } from '../../generation/api.ts';
import { CHECK_ORDER, GATE_CHECKS, mergedResult, placeholderFailures, type CheckResult } from '../api.ts';
import { staticCheck } from '../static-api.ts';
import { botPlaytest, readScenario, type InstanceCheckOptions } from './bot-playtest.ts';
import { coreSetting, importClient } from './engine.ts';
import { checkResult, failure, type Evidence } from './evidence.ts';
import { hostProbe, type HostProbe } from './host-load.ts';
import { Slots } from './instances.ts';
import { performanceChecks, platformProfiles } from './performance.ts';
import { fixedRows, rowProofs } from './fix-proof.ts';
import { regressionTest } from './regression.ts';
import { rowSimulationCheck } from './row-simulation.ts';
import { makeTelemetryRuns } from './telemetry-runs.ts';
import type { FixTestProof } from '../../loop/lib/files.ts';
import { iterationKind } from '../../loop/lib/run.ts';
import { uiQualityCheck, type UiCheckScreen, type UiQualityLimits } from './ui-quality.ts';

export { CHECK_ORDER };

export function gateOf(checks: readonly CheckResult[]): 'pass' | 'fail' {
  return GATE_CHECKS.every((name) => mergedResult(checks.filter((c) => c.name === name)) === 'pass') ? 'pass' : 'fail';
}

export interface LoopOptions {
  godot: string;
  db?: 'postgresql';
  /** Polling interval of instance state. */
  pollMs: number;
  /** Host load sampling interval (ogw.md `### host load`: 1000 ms). */
  sampleMs: number;
  probe?: HostProbe;
  /** The instance slots of the check, when the caller made them for work it starts before the checks (the fix test proof). */
  slots?: Slots;
}

export interface LoopOutcome {
  file: string;
  commit: string;
  checks: CheckResult[];
  gate: 'pass' | 'fail';
  fixTestProof: FixTestProof[];
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

function numberSetting(settings: GameSettings, key: string): number {
  const value = settings[key];
  if (typeof value !== 'number') throw new OgwError(`game settings ${key} is not set`);
  return value;
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

/** The run and start limits of `UnitTestCore` of the game from one read of the merged core settings. */
export async function testLimits(ctx: Context, game: GameRepo): Promise<{ runTimeLimitMs: number | null; startTimeLimitMs: number | null }> {
  const merged = await mergedCoreSettings(ctx, game);
  return { runTimeLimitMs: coreNumber(merged, 'UnitTestCore.runTimeLimitMs'), startTimeLimitMs: coreNumber(merged, 'UnitTestCore.startTimeLimitMs') };
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

/** Checks `ogw core try` runs (`core` command.md `update core`). */
const CORE_TRY_CHECKS: readonly string[] = ['regression test', 'static check', 'no blocker', 'full flow', 'performance', 'UI quality'];

/** The values of game settings that the UI quality check reads. */
function uiSettings(settings: GameSettings): { languages: string[]; screens: UiCheckScreen[]; baseResolution: [number, number]; gamepadSupported: boolean; quality: UiQualityLimits; targetFps: number } {
  return {
    languages: settings.supportedLanguages ?? [],
    screens: (settings.uiCheckScreens ?? []) as UiCheckScreen[],
    baseResolution: (settings.baseResolution ?? [0, 0]) as [number, number],
    gamepadSupported: settings.gamepadSupported === true,
    quality: settings.uiQuality as UiQualityLimits,
    targetFps: numberSetting(settings, 'targetFps'),
  };
}

/** Work of the check beside the checks that is not a check, named in the log line of its failure. */
export interface WorkBeside {
  name: string;
  /** Starts once the import of the checkout has ended; takes its instances within `instance.slots`. */
  work: (instance: InstanceCheckOptions) => Promise<void>;
}

/**
 * The checks of iteration step 2 on the checkout of `game`, with evidence in `evidence`, sorted in `CHECK_ORDER`;
 * `core try` leaves out `no placeholder` and `row simulation`; `fun` runs only the regression test, the static check and
 * the bot playtest (ogw.md `## check`). `alongside` is more work of the check, which is not a check (the shared telemetry
 * runs and the fix test proof of `--loop`); the failure of each is logged under its name. The work that does not read
 * the checkout's `client/` (the server regression test and no placeholder) runs beside its import. The performance
 * measurements start once every other instance of the check has stopped and the work of `alongside` has ended (ogw.md
 * `## performance`).
 */
export async function gameChecks(
  ctx: Context,
  game: GameRepo,
  settings: GameSettings,
  options: LoopOptions,
  evidence: Evidence,
  set: CheckSet,
  alongside: readonly WorkBeside[] = [],
): Promise<CheckResult[]> {
  const [slots, modules, scenario, merged, leaseBase, harness] = await Promise.all([
    options.slots ?? slotsOf(ctx),
    gameModules(ctx, game),
    readScenario(game.root),
    mergedCoreSettings(ctx, game),
    performanceLeaseBase(ctx),
    ctx.settings(),
  ]);
  const instance: InstanceCheckOptions = { evidence, slots, db: options.db, pollMs: options.pollMs };
  const profiles = platformProfiles(settings.buildPlatforms ?? []);
  const probe = options.probe ?? hostProbe(ctx);
  const performanceOptions = {
    ...instance,
    targetFps: numberSetting(settings, 'targetFps'),
    loadingTimeLimitMs: numberSetting(settings, 'loadingTimeLimitMs'),
    quality: modules.client.includes('QualityCore'),
    probe,
    sampleMs: options.sampleMs,
    lease: { base: leaseBase, waitMs: harness.performanceLeaseWaitTimeoutMs },
  };
  const ui = { ...instance, ...uiSettings(settings), maxTextScale: maxTextScale(merged, modules.client), scenario };
  // One import before the instances start, with the engine packages put in first: an instance skips its import once
  // `client/.godot/` exists, so no import may still be writing it when the instances start, and the import that the
  // instance clients run on holds the plugins that their runner's `ogw generate` puts in later. A failed import removed
  // `client/.godot/` (each instance start then fails on its own import); the regression test and the type check report
  // it and do not import again. The static check waits for it too, as the import may write files beside the scripts and
  // assets of `client/`, which the static check lists. An import that throws fails the check once the work started ends.
  const importing = span('import', () => importClient(ctx, options.godot, game));
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
  // every instance of the check other than those of the performance measurements, in this order once the import ended
  const instances: Promise<CheckResult | CheckResult[] | null>[] = [
    afterImport(() => span('bot playtest', () => botPlaytest(ctx, game.name, scenario, instance))),
    ...(fun ? [] : profiles.map((p) => afterImport(() => span(`UI quality ${p}`, () => uiQualityCheck(ctx, game.name, p, ui))))),
    ...(all ? [afterImport(() => span('row simulation', () => rowSimulationCheck(ctx, game.name, game.root, numberSetting(settings, 'rowSimulationSeeds'), instance)))] : []),
  ];
  const besides = alongside.map((beside) =>
    afterImport(() => beside.work(instance)).catch((error: unknown) => {
      ctx.log(`${beside.name}: ${(error as Error).message}`);
    }),
  );
  const tasks: Promise<CheckResult | CheckResult[] | null>[] = [
    span('regression test', () => guarded('regression test', 'client/tests:1', () => regressionTest(ctx, game, { client: 'client/tests', server: 'server/tests' }, client))),
    afterImport((imported) => span('static check', () => guarded('static check', 'settings.json:1', () => staticCheck(ctx, game, { ...db, ...imported })))),
    ...instances,
    ...(fun ? [] : [Promise.allSettled([...instances, ...besides]).then(() => afterImport(() => span('performance', () => performanceChecks(ctx, game.name, profiles, scenario, performanceOptions))))]),
    ...(all ? [span('no placeholder', () => guarded('no placeholder', 'resource/resources.csv:1', async () => checkResult('no placeholder', null, await placeholderFailures(ctx, game))))] : []),
  ];
  const [results] = await Promise.all([Promise.all(tasks), ...besides]);
  const done = await settled;
  if ('error' in done) throw done.error;
  const checks = results.flatMap((r) => (r === null ? [] : [r].flat())).sort((a, b) => CHECK_ORDER.indexOf(a.name) - CHECK_ORDER.indexOf(b.name));
  return set === 'core try' ? checks.filter((c) => CORE_TRY_CHECKS.includes(c.name)) : checks;
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
  const slots = await slotsOf(ctx);
  const proofOptions = { godot: options.godot, ...(await testLimits(ctx, game)), ...(options.db ? { db: options.db } : {}), slots };
  // a content agent report that cannot be read fails the check here, before any check starts
  const fixed = await fixedRows(game, run);
  // the fix test proof works in a worktree of its own: it does not wait for the import of the checkout. It does not
  // throw (what it could not decide is `unknown` with the reason), so its result is never left out
  const proof = span('fix test proof', () => rowProofs(ctx, game, run, commit, fixed, proofOptions));
  // the step 4 judges take the shared telemetry runs made here instead of waiting for them (ogw.md `## check`); the
  // performance measurements wait for them and for the fix test proof
  const checks = await gameChecks(ctx, game, settings, { ...options, slots }, evidence, set, [
    { name: 'shared telemetry runs', work: (instance) => span('shared telemetry runs', () => makeTelemetryRuns(ctx, game, run, commit, instance)) },
    {
      name: 'fix test proof',
      work: async () => {
        await proof;
      },
    },
  ]).finally(() => Promise.allSettled([proof]));
  const fixTestProof = await proof;
  const file = `${records}/check-${String(run.iteration)}.json`;
  const gate = gateOf(checks);
  await span('record', async () => {
    await writeJsonAtomic(join(game.root, file), { commit, checks, gate, fixTestProof });
    await commitPaths(game.root, [file], `loop ${run.name}: check ${String(run.iteration)}`, { env: ctx.env });
  });
  return { file, commit, checks, gate, fixTestProof };
}
