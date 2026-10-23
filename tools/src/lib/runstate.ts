import { join } from 'node:path';
import { OgwError } from './errors.ts';
import { readJsonIfExists, writeJsonAtomic } from './fsx.ts';
import type { GameRepo } from './game.ts';
import type { JobRecord } from './jobs.ts';
import { withLock } from './lock.ts';

/**
 * Run state of a loop run (`create game`, `update game`) or a build run (`build`).
 * Commands keep their own fields in `data`, under a key named after the command.
 */
export interface RunState {
  name: string;
  kind: 'loop' | 'build';
  /** Loop run: `create` or `update`. */
  command: 'create' | 'update' | null;
  /** Build run: environment, version, platforms, and `--bundle-for` app version. */
  env: 'DEV' | 'STG' | 'PROD' | null;
  version: string | null;
  platforms: string[];
  bundleFor: string | null;
  /** `loop/<run>` or `build/<env>-<version>`. */
  branch: string;
  /** The main commit the branch was made from. */
  baseCommit: string;
  /** Commit that static check `game settings owner` compares against; null before it is set. */
  referenceCommit: string | null;
  startedAt: number;
  closedAt: number | null;
  /** Current iteration number; 0 before the first iteration. */
  iteration: number;
  data: Record<string, unknown>;
}

interface RunFile {
  runs: RunState[];
}

function runFile(game: GameRepo): string {
  return join(game.commonDir, 'ogw-runs.json');
}

function runLock(game: GameRepo): string {
  return join(game.commonDir, 'ogw-runs.lock');
}

export async function listRuns(game: GameRepo): Promise<RunState[]> {
  const file = await readJsonIfExists<RunFile>(runFile(game));
  return file?.runs ?? [];
}

/** The run of the game that is not closed, or null. */
export async function openRun(game: GameRepo): Promise<RunState | null> {
  return (await listRuns(game)).find((run) => run.closedAt === null) ?? null;
}

export async function requireOpenRun(game: GameRepo): Promise<RunState> {
  const run = await openRun(game);
  if (!run) throw new OgwError(`no open run for game ${game.name}`);
  return run;
}

/**
 * Runs `fn` under the run file lock. A command that commits to main when the game has no open run holds it from the
 * open-run check through the commit, so no run registers in between and finds its base commit moved.
 */
export async function withRunLock<T>(game: GameRepo, fn: () => Promise<T>): Promise<T> {
  return withLock(runLock(game), fn);
}

/** Changes the run file. The caller holds `withRunLock`. */
export async function changeRunsLocked<T>(game: GameRepo, change: (runs: RunState[]) => T | Promise<T>): Promise<T> {
  const runs = await listRuns(game);
  const result = await change(runs);
  await writeJsonAtomic(runFile(game), { runs } satisfies RunFile);
  return result;
}

/** Changes the run file under its lock. `change` returns the value to give back. */
export async function changeRuns<T>(game: GameRepo, change: (runs: RunState[]) => T | Promise<T>): Promise<T> {
  return withRunLock(game, () => changeRunsLocked(game, change));
}

/** Changes the open run. Fails when the game has no open run. */
export async function changeOpenRun<T>(game: GameRepo, change: (run: RunState) => T | Promise<T>): Promise<T> {
  return withRunLock(game, () => changeOpenRunLocked(game, change));
}

/** `changeOpenRun` for a caller that holds `withRunLock`. */
export async function changeOpenRunLocked<T>(game: GameRepo, change: (run: RunState) => T | Promise<T>): Promise<T> {
  return changeRunsLocked(game, async (runs) => {
    const run = runs.find((r) => r.closedAt === null);
    if (!run) throw new OgwError(`no open run for game ${game.name}`);
    return change(run);
  });
}

export function newRunState(fields: Partial<RunState> & Pick<RunState, 'name' | 'kind' | 'branch' | 'baseCommit'>): RunState {
  return {
    command: null,
    env: null,
    version: null,
    platforms: [],
    bundleFor: null,
    referenceCommit: null,
    startedAt: Date.now(),
    closedAt: null,
    iteration: 0,
    data: {},
    ...fields,
  };
}

/** Jobs of the game started while the run was open. */
export function jobsOfRun(run: RunState, jobs: readonly JobRecord[], game: string): JobRecord[] {
  return jobs.filter(
    (job) => job.game === game && job.startedAt >= run.startedAt && (run.closedAt === null || job.startedAt < run.closedAt),
  );
}
