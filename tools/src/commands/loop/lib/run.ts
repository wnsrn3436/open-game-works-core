import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readJsonIfExists } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { openRun, type RunState } from '../../../lib/runstate.ts';
import { loadGameSettings, loadSchema, schemaPath, withDefaults, type GameSettings } from '../../../lib/settings.ts';
import type { CheckFile, EvaluateFile, MeasureFile } from './files.ts';

/** A resource or translation task: the jobs that came from one first input. */
export interface TaskState {
  role: 'resource' | 'translation';
  /** Absolute path of the first input file. */
  input: string;
  /** Jobs of the task in start order. */
  jobs: string[];
  /** Times `ogw loop sync` gave the task to a new job. */
  retries: number;
  gaveUp: boolean;
  lastFailure: string | null;
}

/** A `ogw agent merge` that `ogw loop sync` did: the branch HEAD before and after. */
export interface MergeRecord {
  job: string;
  role: 'resource' | 'translation';
  before: string;
  after: string;
}

export interface VerdictRecord {
  iteration: number;
  reason: 'success' | 'repeated defect' | 'oscillation' | 'plateau' | 'limit reached' | 'confirm' | 'continue';
  evidence: string[];
}

export interface PrepareMergeRecord {
  /** The commit chosen to merge; null when none. */
  commit: string | null;
  /** True when the work `ogw loop sync` merged after that commit goes with it; absent is read as false. */
  withSyncedWork?: boolean;
  mainHead: string;
  baseCommit: string;
  /** True when `merge/<run>` was made. */
  created: boolean;
  /** Why making `merge/<run>` failed while main HEAD was the work branch base. */
  failed?: string;
}

/** A confirmation iteration (`game-loop` `## stop`) and the candidate iteration it confirms. */
export interface ConfirmRecord {
  iteration: number;
  candidate: number;
}

/** Fields the loop commands keep in `run.data.loop`. */
export interface LoopData {
  tasks: TaskState[];
  /** Agent jobs `ogw loop sync` finished handling (merged, given again, or given up). */
  handled: string[];
  merges: MergeRecord[];
  verdict: VerdictRecord | null;
  prepareMerge: PrepareMergeRecord | null;
  /** Confirmation iterations of the run, in iteration order. */
  confirms: ConfirmRecord[];
  /** Done jobs whose last merge failed for a reason other than a conflict or a `ogw data` failure. */
  stuck: StuckJob[];
}

export interface StuckJob {
  job: string;
  failure: string;
}

/**
 * Fields `ogw core upgrade` keeps in `run.data['core upgrade']`: the version it changed `coreVersion` to (null when
 * the record has none) and the versions it skipped for backward compatibility.
 */
export interface CoreUpgradeData {
  version: string | null;
  skipped: string[];
}

export const CORE_UPGRADE_KEY = 'core upgrade';

/** `run.data` key that `ogw loop input` sets to true when it asked for the judge moment `memorable_moment`. */
export const MEMORABLE_MOMENT_KEY = 'memorable moment';

export function memorableMomentAsked(run: RunState): boolean {
  return run.data[MEMORABLE_MOMENT_KEY] === true;
}

/** `run.data.loop`, created with defaults. The object is the one in the run, so changes stay in it. */
export function loopData(run: RunState): LoopData {
  const current = run.data.loop as Partial<LoopData> | undefined;
  const data: LoopData = {
    tasks: current?.tasks ?? [],
    handled: current?.handled ?? [],
    merges: current?.merges ?? [],
    verdict: current?.verdict ?? null,
    prepareMerge: current?.prepareMerge ?? null,
    confirms: current?.confirms ?? [],
    stuck: current?.stuck ?? [],
  };
  run.data.loop = data;
  return data;
}

/** The candidate iteration that iteration `n` confirms; null when `n` is not a confirmation iteration. */
export function confirmOf(run: RunState, n: number): number | null {
  const current = run.data.loop as Partial<LoopData> | undefined;
  return current?.confirms?.find((c) => c.iteration === n)?.candidate ?? null;
}

export function coreUpgrade(run: RunState): CoreUpgradeData | null {
  const value = run.data[CORE_UPGRADE_KEY] as Partial<CoreUpgradeData> | undefined;
  if (!value) return null;
  return { version: value.version ?? null, skipped: value.skipped ?? [] };
}

export interface LoopTarget {
  game: GameRepo;
  run: RunState;
}

/** The game and its open run. `ogw loop` commands other than start and status fail without one. */
export async function openTarget(ctx: Context, name: string, kind?: 'loop'): Promise<LoopTarget> {
  const game = await ctx.game(name);
  const run = await openRun(game);
  if (!run) throw new OgwError(`no open run for game ${name}`);
  if (kind === 'loop' && run.kind !== 'loop') throw new OgwError(`run ${run.name} is a build run; this command runs only in a loop run`);
  return { game, run };
}

/** Game-repo-relative path of a file in `records/loops/<run>/`. */
export function runRel(run: RunState, file: string): string {
  return `records/loops/${run.name}/${file}`;
}

export function abs(game: GameRepo, rel: string): string {
  return join(game.root, rel);
}

export function runFileExists(game: GameRepo, run: RunState, file: string): boolean {
  return exists(abs(game, runRel(run, file)));
}

/** Game settings of the checkout with schema defaults filled in. */
export async function gameSettings(ctx: Context, game: GameRepo): Promise<GameSettings> {
  const schema = await loadSchema(schemaPath('game-settings', ctx.env));
  return withDefaults(schema, await loadGameSettings(game.root));
}

export async function readRunJson<T>(game: GameRepo, run: RunState, file: string): Promise<T | null> {
  return readJsonIfExists<T>(abs(game, runRel(run, file)));
}

export const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Text of a game-repo-relative file; null when it does not exist. */
export async function readGameText(game: GameRepo, rel: string): Promise<string | null> {
  const path = abs(game, rel);
  return exists(path) ? readFile(path, 'utf8') : null;
}

/** Results of iteration `n`: `check-<n>.json`, `evaluate-<n>.json`, and the measure file the evaluate file names. */
export interface IterationResults {
  checkRel: string;
  check: CheckFile | null;
  evaluate: EvaluateFile | null;
  measure: MeasureFile | null;
}

export async function iterationResults(game: GameRepo, run: RunState, n: number): Promise<IterationResults> {
  const checkRel = runRel(run, `check-${String(n)}.json`);
  const evaluate = await readRunJson<EvaluateFile>(game, run, `evaluate-${String(n)}.json`);
  return {
    checkRel,
    check: await readJsonIfExists<CheckFile>(abs(game, checkRel)),
    evaluate,
    measure: evaluate?.measure ? await readJsonIfExists<MeasureFile>(abs(game, evaluate.measure)) : null,
  };
}
