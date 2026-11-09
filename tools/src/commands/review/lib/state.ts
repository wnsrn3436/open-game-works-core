import { readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readJsonIfExists, whenNotFound, writeJsonAtomic } from '../../../lib/fsx.ts';
import { commonDir } from '../../../lib/git.ts';
import { JobNotFound, readJob } from '../../../lib/jobs.ts';
import { withLock } from '../../../lib/lock.ts';
import type { Side } from './input.ts';

/**
 * The result of a judged round (core command.md `## review and code check`): `fixed` is a `fix` round whose fix check has
 * no counted `fail`. An `invalid` round is dropped from the state.
 */
export type ReviewResult = 'done' | 'fix' | 'fixed' | 'blocked' | 'invalid';

export interface CheckItemState {
  name: string;
  result: 'pass' | 'fail' | 'unknown';
  failures: string[];
}

export interface OpenFinding {
  id: string;
  aspect: string;
  severity: string;
  location: string;
  specChange: string;
}

/** The fix check of a `fix` round: the code check after its fix, with `fix test proof` when it has a fix base. */
export interface FixCheckState {
  /** The `ogw code check` job. */
  job: string;
  /** The commit it reads: main of `open-game-works-core-impl/` (core) or the harness HEAD (tool) at its start. */
  commit: string;
  /** Its `--fix-base`, or null without `fix test proof`. */
  fixBase: string | null;
  judged: boolean;
  /** `pass` when it has no `fail` that counts; null before it is judged. */
  result: 'pass' | 'fail' | null;
  codeCheck: CheckItemState[];
  /** core: the type check and lint failure lines in files outside the target, which do not count. */
  outsideTarget: string[];
  /** Whether its `fix test proof` `fail` does not count: an earlier code check of the target failed the proof on its base. */
  proofNotCounted: boolean;
}

export interface RoundState {
  round: number;
  startCommit: string;
  input: string;
  reviewJob: string;
  codeCheckJob: string;
  reviewFile: string | null;
  judged: boolean;
  result: ReviewResult | null;
  open: OpenFinding[];
  codeCheck: CheckItemState[];
  codeCheckFile: string | null;
  /** Whether the round is the second round after the fix of a round: no round follows its fix. Absent: it is not. */
  second?: boolean;
  /** SHA-256 of each definition document when the round started: `--respec` needs one of them changed. */
  definitionHashes?: Record<string, string>;
  /** The harness repo HEAD when the round started: a `--respec` round reviews the definition changes since it. */
  harnessCommit?: string;
  /** A round started by `--respec` after a definition change: the diff of the definition documents it reviews. */
  specChanges?: string;
  /** The `--fix-base` of the round's code check, or null when it had no `fix test proof`. Absent before proofs: null. */
  fixBase?: string | null;
  /** Whether the `fix test proof` `fail` of the round's code check does not count (`FixCheckState.proofNotCounted`). */
  proofNotCounted?: boolean;
  /** core: the type check and lint failure lines of the code check in files outside the target, which do not count. */
  outsideTarget?: string[];
  /** The `## out of scope` lines of the review file, game impacts left out. */
  outOfScope?: string[];
  /** The findings and `## out of scope` lines of a core review whose location is a file of a game repo (`gameLocation`). */
  gameImpact?: string[];
  /** The ids of the debt items the round's input gave as scope. Absent before review lists: none. */
  debt?: string[];
  /** The ids of the must-fix items the round's input gave as scope. Absent before review lists: none. */
  mustFix?: string[];
  /** Whether the round reviews the whole target (no commit range): it takes `low` findings. */
  whole?: boolean;
  /**
   * Whether the round's review pays debt: it reviews the whole target, or began with `--debt`. A round dropped as
   * `invalid` leaves the state with the round, so the review keeps what its own rounds hold. Absent: it does not.
   */
  paysDebt?: boolean;
  /**
   * The `nextId` of the target's debt list when the round's review began (round 1, the must-fix round, or a round
   * started by `--full` or `--debt`): in a review that pays debt, its items below it are the round's scope (`scopeDebt`).
   */
  debtFloor?: number;
  /** The lines of what the judged round changed in the review lists (`changeLists`). */
  debtLines?: string[];
  /** core: the core agent input for a `fix` result. */
  fixInput: string | null;
  /**
   * core: ids of the core agent jobs started with `fixInput` (a retry of one counts) and merged with `ogw agent merge`;
   * written by the next `review next` when it checks them. Absent until then.
   */
  fixJobs?: string[];
  /** The fix checks of a `fix` round, oldest first: another one follows a fix check judged `fail`. Absent: none. */
  fixChecks?: FixCheckState[];
}

export interface ReviewState {
  side: Side;
  target: string;
  rounds: RoundState[];
  /** `--since` of round 1, resolved: also the range of a round 1 started again after an `invalid` one. */
  since?: string;
  /**
   * The judged round a `--respec` follows, from when the option is given until a round it started is judged other than
   * `invalid`: the round whose harness commit and definition hashes the definition diff starts from.
   */
  respecAfter?: number;
  /**
   * `--full`: the next round reviews the whole target, from when the option is given until a round it started is judged
   * other than `invalid`.
   */
  full?: boolean;
  /**
   * `--debt`: the next round reviews the items of the target's debt list, from when the option is given until a round it
   * started is judged other than `invalid`.
   */
  debtReview?: boolean;
}

/** The last fix check of a round, or undefined. */
export function lastFixCheck(round: Pick<RoundState, 'fixChecks'>): FixCheckState | undefined {
  return round.fixChecks?.at(-1);
}

/** Whether the round or its last fix check is not judged yet. */
export function running(round: RoundState): boolean {
  return !round.judged || lastFixCheck(round)?.judged === false;
}

/** Whether the review whose last round is `round` ended: that round is `done` or `fixed` (core command.md `## review and code check`). */
export function ended(round: RoundState | undefined): boolean {
  return round?.judged === true && (round.result === 'done' || round.result === 'fixed');
}

/** The commit the review ended at: the start of a `done` round, the commit of the passing fix check of a `fixed` round. */
export function endCommit(round: RoundState): string {
  return round.result === 'fixed' ? (lastFixCheck(round)?.commit ?? round.startCommit) : round.startCommit;
}


/** The repo whose git common dir holds the review state: `open-game-works-core-impl/` or the harness repo. */
export async function reviewRepo(ctx: Context, side: Side): Promise<string> {
  const ws = await ctx.workspace();
  return side === 'core' ? ws.coreImpl : ws.harness;
}

export async function reviewRoot(ctx: Context, side: Side): Promise<string> {
  return join(await commonDir(await reviewRepo(ctx, side), { env: ctx.env }), 'ogw-review');
}

export function checkTarget(target: string): void {
  if (target === '' || target.includes('/') || target.includes('\\') || target.startsWith('.')) {
    throw new OgwError(`invalid review target: ${target}`);
  }
}

export async function targetDir(ctx: Context, side: Side, target: string): Promise<string> {
  checkTarget(target);
  return join(await reviewRoot(ctx, side), target);
}

export async function readState(dir: string, side: Side, target: string): Promise<ReviewState> {
  return (await readJsonIfExists<ReviewState>(join(dir, 'state.json'))) ?? { side, target, rounds: [] };
}

export async function writeState(dir: string, state: ReviewState): Promise<void> {
  await writeJsonAtomic(join(dir, 'state.json'), state);
}

/** Runs `fn` holding the target's lock. */
export async function withTarget<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  return withLock(`${dir}.lock`, fn);
}

/** Every target folder with review state: a folder holding `state.json` (a target's lock folder `<target>.lock` holds none). */
export async function listTargets(root: string): Promise<string[]> {
  const names = await readdir(root, { withFileTypes: true }).catch(whenNotFound([]));
  return names.filter((entry) => entry.isDirectory() && exists(join(root, entry.name, 'state.json'))).map((entry) => entry.name).sort();
}

/**
 * Removes the tool review file of each round: its `ogw-review-file-*` temp folder (ogw.md `## temp folder`), or the
 * file alone when it is elsewhere. A round not judged yet finds the file through its review agent job.
 */
export async function removeToolReviewFiles(ctx: Context, rounds: readonly Pick<RoundState, 'reviewFile' | 'reviewJob'>[]): Promise<void> {
  for (const round of rounds) {
    // a review job whose record is gone names no file
    const job = round.reviewFile === null ? await readJob(round.reviewJob, ctx.env).catch(notFoundJob) : null;
    const file = round.reviewFile ?? job?.meta.output;
    if (typeof file === 'string') await removeReviewFile(file);
  }
}

function notFoundJob(error: unknown): null {
  if (error instanceof JobNotFound) return null;
  throw error;
}

/** Removes a review file: its `ogw-review-file-*` temp folder (ogw.md `## temp folder`), or the file alone when it is elsewhere. */
export async function removeReviewFile(file: string): Promise<void> {
  const folder = dirname(file);
  await rm(basename(folder).startsWith('ogw-review-file-') ? folder : file, { recursive: true, force: true });
}
