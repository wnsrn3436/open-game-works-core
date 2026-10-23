import { readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readJsonIfExists, writeJsonAtomic } from '../../../lib/fsx.ts';
import { commonDir } from '../../../lib/git.ts';
import { readJob } from '../../../lib/jobs.ts';
import { withLock } from '../../../lib/lock.ts';
import type { Side } from './input.ts';

export type ReviewResult = 'done' | 'fix' | 'escalate' | 'blocked' | 'limit' | 'invalid';

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
  /**
   * The chain of the round (core command.md `## review and code check`): 1 from round 1, one more after each `escalate`,
   * `--continue`, `--respec` or `--reopen`. Absent in a state written before chains: 1.
   */
  chain?: number;
  /** SHA-256 of each definition document when the round started: `--restart` and `--respec` need one of them changed. */
  definitionHashes?: Record<string, string>;
  /** The harness repo HEAD when the round started: a `--respec` round reviews the definition changes since it. */
  harnessCommit?: string;
  /** A round started by `--respec` after a definition change: the diff of the definition documents it reviews. */
  specChanges?: string;
  /** The `--fix-base` of the round's code check, or null when it had no `fix test proof`. Absent before proofs: null. */
  fixBase?: string | null;
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
   * The `nextId` of the target's debt list when the round's review began (round 1, or a round started by `--reopen`,
   * `--full` or `--debt`): in a review that pays debt, its items below it are the round's scope (`scopeDebt`).
   */
  debtFloor?: number;
  /** The lines of what the judged round changed in the review lists (`changeLists`). */
  debtLines?: string[];
  /** core: the core agent input for a `fix` result; both sides: the escalation input for an `escalate` result. */
  fixInput: string | null;
  /**
   * core: ids of the core agent jobs started with `fixInput` (a retry of one counts) and merged with `ogw agent merge`,
   * or, for a `limit` round, the core agent jobs of the target merged before `--continue`; written by the next
   * `review next` when it checks them. Absent until then.
   */
  fixJobs?: string[];
}

export interface ReviewState {
  side: Side;
  target: string;
  rounds: RoundState[];
  /** `--since` of round 1, resolved: also the range of a round 1 started again after an `invalid` one. */
  since?: string;
  /** The `limit` round a `--continue` follows, until a round it started is judged other than `invalid`. */
  continueAfter?: number;
  /**
   * The judged round a `--respec` follows, from when the option is given until a round it started is judged other than
   * `invalid`: the round whose harness commit and definition hashes the definition diff starts from.
   */
  respecAfter?: number;
  /** The `done` round a `--reopen` follows, from when the option is given until a round it started is judged other than `invalid`. */
  reopenAfter?: number;
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

/** The chain of a round (`RoundState.chain`). */
export function chainOf(round: Pick<RoundState, 'chain'>): number {
  return round.chain ?? 1;
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
  const names = await readdir(root, { withFileTypes: true }).catch(() => []);
  return names.filter((entry) => entry.isDirectory() && exists(join(root, entry.name, 'state.json'))).map((entry) => entry.name).sort();
}

/**
 * Removes the tool review file of each round: its `ogw-review-file-*` temp folder (ogw.md `## temp folder`), or the
 * file alone when it is elsewhere. A round not judged yet finds the file through its review agent job.
 */
export async function removeToolReviewFiles(ctx: Context, rounds: readonly Pick<RoundState, 'reviewFile' | 'reviewJob'>[]): Promise<void> {
  for (const round of rounds) {
    const file = round.reviewFile ?? (await readJob(round.reviewJob, ctx.env).catch(() => null))?.meta.output;
    if (typeof file === 'string') await removeReviewFile(file);
  }
}

/** Removes a review file: its `ogw-review-file-*` temp folder (ogw.md `## temp folder`), or the file alone when it is elsewhere. */
export async function removeReviewFile(file: string): Promise<void> {
  const folder = dirname(file);
  await rm(basename(folder).startsWith('ogw-review-file-') ? folder : file, { recursive: true, force: true });
}
