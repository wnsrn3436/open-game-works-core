import { OgwError } from '../../../lib/errors.ts';
import { head } from '../../../lib/git.ts';
import { harnessRoot } from '../../../lib/paths.ts';
import type { RunState } from '../../../lib/runstate.ts';

/** The pinned harness commit of a loop run and its repins (ogw.md `## loop next`). */

/** `run.data` key of the pins of the run, in pin order. */
export const HARNESS_PINS_KEY = 'harness pins';

export interface HarnessPin {
  commit: string;
  /** The iteration the pin counts for: 0 for the pin of `ogw loop start`. */
  iteration: number;
}

export function harnessPins(run: RunState): HarnessPin[] {
  const value = run.data[HARNESS_PINS_KEY];
  return Array.isArray(value) ? (value as HarnessPin[]) : [];
}

/** The pinned harness commit of the run; null for a run without one (a build run). */
export function pinnedHarness(run: RunState): string | null {
  return harnessPins(run).at(-1)?.commit ?? null;
}

export async function harnessHead(env: NodeJS.ProcessEnv): Promise<string> {
  return head(harnessRoot(env), { env });
}

/** Pins `commit` for `iteration`. Nothing changes when `commit` is already the pinned harness commit. */
export function pinHarness(run: RunState, commit: string, iteration: number): void {
  if (pinnedHarness(run) === commit) return;
  run.data[HARNESS_PINS_KEY] = [...harnessPins(run), { commit, iteration }];
}

/** Fails, naming both commits, when the run has a pinned harness commit that is not the harness repo HEAD. */
export function requirePinned(run: RunState, harnessHeadCommit: string): void {
  const pinned = pinnedHarness(run);
  if (pinned === null || pinned === harnessHeadCommit) return;
  throw new OgwError(
    `harness repo HEAD ${harnessHeadCommit} is not the pinned harness commit ${pinned} of run ${run.name}: give --repin to pin ${harnessHeadCommit}`,
    1,
    { pinned, harnessHead: harnessHeadCommit },
  );
}

/**
 * The `- harness:` value of iteration `n` (ogw.md `## loop record`): the commit of the last pin that counts for `n` or an
 * earlier iteration, with the commit of iteration `n - 1` when a repin that changed the commit counts for `n`. A run
 * without a pin (a build run) gives `harnessHeadCommit`.
 */
export function harnessLine(run: RunState, n: number, harnessHeadCommit: string): string {
  const pins = harnessPins(run);
  if (pins.length === 0) return harnessHeadCommit;
  const commitOf = (iteration: number): string | null => pins.filter((p) => p.iteration <= iteration).at(-1)?.commit ?? null;
  const commit = commitOf(n) ?? 'none';
  const before = n >= 1 ? commitOf(n - 1) : null;
  const repinned = before !== null && before !== commit && pins.some((p) => p.iteration === n);
  return repinned ? `${commit} (repinned from ${before})` : commit;
}
