/**
 * The result of a check or test (AGENTS.md `## rules`): `pass`, `fail`, or `unknown` with the reason it could not be
 * checked. `unknown` is neither: a gate opens only on `pass` (`passes`), and reports the reason of an `unknown`.
 */
export type Result = 'pass' | 'fail' | 'unknown';

export interface Outcome {
  result: Result;
  /** Why it could not be checked: set for `unknown` only. */
  reason: string | null;
}

/** The reason of a render pass not run because the macOS screen is locked or the main display is off (ogw.md `### Godot core test`). */
export const SCREEN_LOCKED = 'screen locked';

/** The reason of a result that no record or output holds. */
export const NOT_RECORDED = 'not recorded';

/** What a gate tells the human to do about an `unknown` of `reason`. */
export function rerunHint(reason: string): string {
  return reason === SCREEN_LOCKED ? 'rerun with the screen unlocked' : 'rerun';
}

/**
 * Maps a raw result to an outcome. `pass` and `fail` are kept; every other value is `unknown` with `reason`: `unknown`
 * itself, the `skipped` that test records and job outputs of a part left out hold, and a missing result
 * (`NOT_RECORDED`). A raw value other than these is its own reason.
 */
export function outcomeOf(raw: unknown, reason: string | null = null): Outcome {
  if (raw === 'pass' || raw === 'fail') return { result: raw, reason: null };
  if (raw === undefined || raw === null) return { result: 'unknown', reason: reason ?? NOT_RECORDED };
  if (raw === 'unknown' || raw === 'skipped') return { result: 'unknown', reason: reason ?? 'not checked' };
  return { result: 'unknown', reason: reason ?? (typeof raw === 'string' ? raw : JSON.stringify(raw)) };
}

/**
 * The outcome of a run of tests or checks: `fail` when one failed, else `unknown` when part of it did not run (`notRun`,
 * the reason), else `pass`.
 */
export function runOutcome(failed: boolean, notRun: string | null | undefined): Outcome {
  if (failed) return { result: 'fail', reason: null };
  return notRun === null || notRun === undefined ? { result: 'pass', reason: null } : { result: 'unknown', reason: notRun };
}

/** Whether a gate that needs `pass` opens on `outcome`: only `pass` does, never `unknown`. */
export function passes(outcome: Outcome): boolean {
  return outcome.result === 'pass';
}
