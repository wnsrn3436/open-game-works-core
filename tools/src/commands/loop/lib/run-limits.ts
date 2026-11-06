import { nonNegativeInt, type CommandArgs, type OptionSpec } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import type { RunState } from '../../../lib/runstate.ts';

/** The iteration limit and the time limit of a loop run (ogw.md `## loop start`). */

/** `run.data` key of the limits that `ogw loop start` and `ogw loop resume` set. */
export const RUN_LIMITS_KEY = 'limits';

export interface RunLimits {
  /** `--limit`: the number of the last iteration of the run; null without one. */
  iterations: number | null;
  /** `--until`: the UTC Unix ms of the time limit; null without one. */
  until: number | null;
}

export const LIMIT_OPTIONS: Record<string, OptionSpec> = { limit: { type: 'string' }, until: { type: 'string' } };

export function runLimits(run: RunState): RunLimits {
  const value = run.data[RUN_LIMITS_KEY] as Partial<RunLimits> | undefined;
  return { iterations: value?.iterations ?? null, until: value?.until ?? null };
}

/** The `--limit` and `--until` given: an integer of 1 or more, and a Unix ms later than `now`. */
export function givenLimits(args: CommandArgs, now: number): Partial<RunLimits> {
  const out: Partial<RunLimits> = {};
  const iterations = nonNegativeInt(args, 'limit');
  if (iterations !== undefined) {
    if (iterations < 1) throw new OgwError('invalid --limit: 0: it is the number of the last iteration of the run, 1 or more');
    out.iterations = iterations;
  }
  const until = nonNegativeInt(args, 'until');
  if (until !== undefined) {
    if (until <= now) throw new OgwError(`invalid --until: ${String(until)} is not later than now (${String(now)}): it is a UTC Unix ms`);
    out.until = until;
  }
  return out;
}

/** Replaces the limits of the run that `given` has. */
export function setRunLimits(run: RunState, given: Partial<RunLimits>): void {
  run.data[RUN_LIMITS_KEY] = { ...runLimits(run), ...given } satisfies RunLimits;
}

export interface IterationLimit {
  limit: number;
  /** What gives the limit: the run's `--limit` or game settings `loopIterationLimit`. */
  by: '--limit' | 'game settings loopIterationLimit';
}

/** The iteration limit (ogw.md `## loop next`): the smaller of the run's `--limit` (`runLimit`) and `loopIterationLimit`. */
export function smallerLimit(runLimit: number | null, loopIterationLimit: number): IterationLimit {
  return runLimit !== null && runLimit <= loopIterationLimit
    ? { limit: runLimit, by: '--limit' }
    : { limit: loopIterationLimit, by: 'game settings loopIterationLimit' };
}

/** The iteration limit of the run. */
export function iterationLimit(run: RunState, loopIterationLimit: number): IterationLimit {
  return smallerLimit(runLimits(run).iterations, loopIterationLimit);
}

/** The `limit reached` evidence line of the iteration limit (ogw.md `## loop verdict`). */
export function iterationLimitLine(iteration: number, limit: IterationLimit): string {
  return `iteration ${String(iteration)} reached ${limit.by} ${String(limit.limit)}`;
}

/** The `limit reached` evidence line of the time limit (ogw.md `## loop verdict`). */
export function timeLimitLine(now: number, until: number): string {
  return `now ${String(now)} reached --until ${String(until)}`;
}
