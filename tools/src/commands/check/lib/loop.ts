import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
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
import { hostProbe, type HostProbe } from './host-load.ts';
import { Slots } from './instances.ts';
import { performanceCheck, platformProfiles } from './performance.ts';
import { regressionTest } from './regression.ts';
import { rowSimulationCheck } from './row-simulation.ts';
import { uiQualityCheck, type UiCheckScreen } from './ui-quality.ts';

export { CHECK_ORDER };

export function gateOf(checks: readonly CheckResult[]): 'pass' | 'fail' {
  return GATE_CHECKS.every((name) => mergedResult(checks.filter((c) => c.name === name)) === 'pass') ? 'pass' : 'fail';
}

export interface LoopOptions {
  godot: string;
  db?: 'postgresql';
  /** Polling interval of instance state. */
  pollMs: number;
  /** Host load sampling interval (`performance` `## host load`: 1000 ms). */
  sampleMs: number;
  probe?: HostProbe;
}

export interface LoopOutcome {
  file: string;
  commit: string;
  checks: CheckResult[];
  gate: 'pass' | 'fail';
}

/**
 * Runs a check; an error it throws makes it `unknown` (what was not checked is not a failure), at `where`: line 1 of
 * the file or folder the check reads (`game-loop` `## loop iteration record`: a file:line).
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

async function maxTextScale(ctx: Context, game: GameRepo, client: readonly string[]): Promise<number | null> {
  if (!client.includes('AccessibilityCore')) return null;
  const scales = coreSetting(await mergedCoreSettings(ctx, game), 'AccessibilityCore.textScales');
  const numbers = Array.isArray(scales) ? scales.filter((s): s is number => typeof s === 'number') : [];
  return numbers.length > 0 ? Math.max(...numbers) : 1000;
}

/** Core settings `UnitTestCore.runTimeLimitMs` of the game, or null when the merged core settings do not have it. */
export async function runTimeLimitMs(ctx: Context, game: GameRepo): Promise<number | null> {
  const value = coreSetting(await mergedCoreSettings(ctx, game), 'UnitTestCore.runTimeLimitMs');
  return typeof value === 'number' ? value : null;
}

export async function slotsOf(ctx: Context): Promise<Slots> {
  const max = (await ctx.settings()).maxConcurrentInstances;
  if (max === null) throw new OgwError('harness settings maxConcurrentInstances is null: do update env first');
  return new Slots(max);
}

/** `ogw check <game> --loop`: every check of iteration step 2, the result file, and `gate`. */
export async function loopCheck(ctx: Context, game: GameRepo, settings: GameSettings, options: LoopOptions): Promise<LoopOutcome> {
  const run = await requireOpenRun(game);
  if (run.iteration < 1) throw new OgwError(`run ${run.name} has no iteration yet`);
  const records = `records/loops/${run.name}`;
  const evidenceDir = `${records}/evidence/check-${String(run.iteration)}`;
  await rm(join(game.root, evidenceDir), { recursive: true, force: true });
  const commit = await head(game.root, { env: ctx.env });
  const evidence: Evidence = { root: game.root, dir: evidenceDir, relative: true };
  const instance: InstanceCheckOptions = { evidence, slots: await slotsOf(ctx), db: options.db, pollMs: options.pollMs };
  const modules = await gameModules(ctx, game);
  const scenario = await readScenario(game.root);
  const profiles = platformProfiles(settings.buildPlatforms ?? []);
  const probe = options.probe ?? hostProbe(ctx);
  const performance = {
    ...instance,
    targetFps: numberSetting(settings, 'targetFps'),
    loadingTimeLimitMs: numberSetting(settings, 'loadingTimeLimitMs'),
    quality: modules.client.includes('QualityCore'),
    probe,
    sampleMs: options.sampleMs,
  };
  const ui = {
    ...instance,
    languages: settings.supportedLanguages ?? [],
    screens: (settings.uiCheckScreens ?? []) as UiCheckScreen[],
    baseResolution: (settings.baseResolution ?? [0, 0]) as [number, number],
    gamepadSupported: settings.gamepadSupported === true,
    maxTextScale: await maxTextScale(ctx, game, modules.client),
  };
  // One import before the checks run together: an instance skips its import once `client/.godot/` exists, so no import
  // may still be writing it when the instances start. A failed import removed `client/.godot/` (each instance start then
  // fails on its own import); the regression test and the type check report it and do not import again.
  const importFailure = await importClient(ctx, options.godot, game.root);
  const imported = importFailure === null ? { imported: true } : { importFailure };
  const db = options.db ? { db: options.db } : {};
  const client = { godot: options.godot, evidence, runTimeLimitMs: await runTimeLimitMs(ctx, game), ...imported, ...db };
  const tasks: Promise<CheckResult | CheckResult[]>[] = [
    guarded('regression test', 'client/tests:1', () => regressionTest(ctx, game.root, { client: 'client/tests', server: 'server/tests' }, client)),
    guarded('static check', 'settings.json:1', () => staticCheck(ctx, game, { ...db, ...imported })),
    botPlaytest(ctx, game.name, scenario, instance),
    ...profiles.map((p) => performanceCheck(ctx, game.name, p, scenario, performance)),
    ...profiles.map((p) => uiQualityCheck(ctx, game.name, p, ui)),
    guarded('no placeholder', 'resource/resources.csv:1', async () => checkResult('no placeholder', null, await placeholderFailures(ctx, game))),
    rowSimulationCheck(ctx, game.name, game.root, numberSetting(settings, 'rowSimulationSeeds'), instance),
  ];
  const checks = (await Promise.all(tasks)).flat().sort((a, b) => CHECK_ORDER.indexOf(a.name) - CHECK_ORDER.indexOf(b.name));
  const file = `${records}/check-${String(run.iteration)}.json`;
  const gate = gateOf(checks);
  await writeJsonAtomic(join(game.root, file), { commit, checks, gate });
  await commitPaths(game.root, [file], `loop ${run.name}: check ${String(run.iteration)}`, { env: ctx.env });
  return { file, commit, checks, gate };
}
