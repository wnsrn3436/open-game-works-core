import type { GameRepo } from '../../../lib/game.ts';
import type { RunState } from '../../../lib/runstate.ts';
import { confirmOf } from './run.ts';
import { gatePassed, iterationRecords, mainOf, type ParsedRecord } from './iteration-record.ts';

/**
 * Baseline game commit from the loop iteration records before `iteration` (`game-loop` `## iteration` 7):
 * none for `create` and the work branch base for `update` at first; then an iteration whose step 4 judge
 * says `better` sets it, and while there is none, an iteration that passed the gate checks sets it.
 */
export function baselineFrom(run: RunState, records: readonly ParsedRecord[]): string | null {
  let baseline: string | null = run.command === 'update' ? run.baseCommit : null;
  for (const record of records) {
    if (record.commit === null) continue;
    if (mainOf(record)?.vsBaseline === 'better') baseline = record.commit;
    else if (baseline === null && gatePassed(record)) baseline = record.commit;
  }
  return baseline;
}

/**
 * `ogw loop baseline`: build run → the build branch base; a confirmation iteration → the commit of its candidate
 * iteration; loop run → from the records of earlier iterations.
 */
export async function runBaseline(game: GameRepo, run: RunState): Promise<string | null> {
  if (run.kind === 'build') return run.baseCommit;
  const records = (await iterationRecords(game, run)).filter((r) => r.iteration < run.iteration);
  const candidate = confirmOf(run, run.iteration);
  if (candidate !== null) return records.find((r) => r.iteration === candidate)?.commit ?? null;
  return baselineFrom(run, records);
}
