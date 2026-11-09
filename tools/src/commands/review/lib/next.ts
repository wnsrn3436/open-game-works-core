import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { CommandResult, Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, writeFileAtomic } from '../../../lib/fsx.ts';
import { git, gitRaw, head, revParse, statusLines } from '../../../lib/git.ts';
import { killJob, listJobs, readJob, startJob, type JobRecord } from '../../../lib/jobs.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { mergedOutput, type AgentMeta } from '../../agent/lib/meta.ts';
import { startAgent } from '../../agent/lib/prepare.ts';
import { coreEngines } from '../../code/lib/target.ts';
import { moduleFolder } from '../../core/lib/impl.ts';
import { debtRepo, hasMustFix, itemLine, readList, scopeDebt, type ListItem } from './debt.ts';
import { coreDefinitions, toolDefinitions } from './definitions.ts';
import { formatReviewInput, type Side } from './input.ts';
import { endCommit, ended, lastFixCheck, readState, removeToolReviewFiles, reviewRepo, targetDir, withTarget, writeState, type FixCheckState, type ReviewState, type RoundState } from './state.ts';
import { proofFailed } from './wait.ts';

/**
 * Core agent jobs of the `fix` input of a round, retries included (`taskInput`), oldest first. Only jobs started after
 * the round's review job ended count: a round of an earlier review of the target has the same fix input path, and its
 * jobs fixed other findings.
 */
export async function fixJobs(ctx: Context, round: RoundState, fixInput: string): Promise<JobRecord[]> {
  const judgedAt = (await readJob(round.reviewJob, ctx.env)).endedAt ?? 0;
  return (await listJobs(ctx.env)).filter(
    (job) => job.command === 'agent' && job.meta.role === 'core' && (job.meta as AgentMeta).taskInput === fixInput && job.startedAt >= judgedAt,
  );
}

/** Whether a fix job is the round's fix: merged, and ended `done`. A job that failed has no report, merged or not. */
export function mergedFix(job: JobRecord): boolean {
  return (job.meta as AgentMeta).merged && job.status === 'done';
}

/**
 * Core agent jobs started with a `fix` input, retries of such a job included (`taskInput` is the input of the
 * retried work, and equals `input` for a job that is not a retry); fails unless one was merged with `ogw agent merge`.
 * Returns the merged job ids and their reports.
 */
async function mergedFixJobs(ctx: Context, round: RoundState, fixInput: string): Promise<{ jobs: string[]; reports: string[] }> {
  const jobs = await fixJobs(ctx, round, fixInput);
  const merged = jobs.filter(mergedFix);
  if (merged.length === 0) {
    throw new OgwError(`the core agent job of fix input ${fixInput} has not been merged with ogw agent merge`);
  }
  const reports = merged.map((job) => mergedOutput(job.meta as AgentMeta)).filter((path): path is string => path !== null);
  const missing = reports.filter((path) => !exists(path));
  if (missing.length > 0) throw new OgwError(`core agent report not found: ${missing.join(', ')}`);
  return { jobs: merged.map((job) => job.id), reports };
}

/**
 * The commit a round or a fix check starts at, read once: the review worktree is made at it, the code check job checks
 * the target's files at it, and the input's commit range ends at it. `core`: main of `open-game-works-core-impl/`, where
 * `ogw agent merge` puts the fix. `tool`: HEAD of the harness repo, whose `tools/` must have no change that is not
 * committed, since the lead agent fixes `tools/` in that checkout and a change left out of the commit would not be
 * reviewed or checked.
 */
async function startCommit(ctx: Context, side: Side): Promise<string> {
  const repo = await reviewRepo(ctx, side);
  const options = { env: ctx.env };
  if (side === 'tool') {
    const changes = await statusLines(repo, options, ['tools']);
    if (changes.length > 0) {
      throw new OgwError(`${join(repo, 'tools')} has changes that are not committed; commit them so that the review and the code check read them:\n${changes.join('\n')}`);
    }
    return head(repo, options);
  }
  const main = await revParse(repo, 'main', options);
  if (main === null) throw new OgwError(`${repo} has no branch main`);
  return main;
}

interface InputRequest {
  side: Side;
  target: string;
  round: number;
  /** The review file of the round whose fix or definition change this round follows (`## previous review`), or null. */
  previous: string | null;
  definitions: string[];
  reports: string[];
  /** The commit range's start, or null for a review of the whole target. */
  from: string | null;
  commit: string;
  specChanges: string | null;
  debt: RoundItems;
}

/** Writes the review agent input of the round. */
async function writeInput(dir: string, request: InputRequest): Promise<string> {
  const { side, target, round, from, commit } = request;
  const path = join(dir, `round-${String(round)}-input.md`);
  await writeFileAtomic(path, formatReviewInput({
    side,
    target,
    round,
    definitions: request.definitions,
    previousReview: request.previous,
    commitRange: from === null ? null : `${from}..${commit}`,
    coreReports: request.reports,
    specChanges: request.specChanges,
    debt: request.debt.debt.map(itemLine),
    mustFix: request.debt.mustFix.map(itemLine),
  }));
  return path;
}

export interface NextOptions {
  /** `--respec`: a round after a definition change, from the last round. */
  respec?: boolean;
  /** `--since <commit>`: round 1 reviews the changes from that commit. */
  since?: string;
  /** `--full`: the round reviews the whole target (core only). */
  full?: boolean;
  /** `--debt`: the round reviews the items of the target's debt list. */
  debt?: boolean;
  definitions: string[];
}

/**
 * Aspects of a finding whose fix changes behavior: the code check after the fix proves the fix's tests on the code
 * before it. A `test evidence` finding adds tests to code that already behaves, so no test of its fix can fail on the
 * code before it (ogw.md `## review run`).
 */
const BEHAVIOR_ASPECTS = ['correctness', 'spec', 'security'];

/** Whether the round's open findings hold a behavior finding to fix (a `spec change` `yes` finding goes to the human). */
function fixesBehavior(round: RoundState): boolean {
  return round.open.some((f) => f.specChange === 'no' && BEHAVIOR_ASPECTS.includes(f.aspect));
}

/**
 * `--fix-base` of the code check after the fix of the `fix` round `last` (its second round, a `--respec` round or a fix
 * check; ogw.md `## review run`): that of its last fix check, else that of its own code check when that proof failed,
 * else its start commit when it has a behavior finding, else null. Null when `last` is not a `fix` round.
 */
export function fixBase(last: RoundState | undefined): string | null {
  if (last?.result !== 'fix') return null;
  const check = lastFixCheck(last);
  if (check !== undefined) return check.fixBase;
  if (proofFailed(last.codeCheck) && typeof last.fixBase === 'string') return last.fixBase;
  return fixesBehavior(last) ? last.startCommit : null;
}

/**
 * Whether the round after the fix of the `fix` round `last` is a second round (core command.md `## review and code
 * check`): an `open` finding to fix has severity `critical` or `high`, and `last` is not a second round itself.
 */
export function secondRoundDue(last: RoundState): boolean {
  return last.result === 'fix' && last.second !== true && last.open.some((f) => f.specChange !== 'yes' && (f.severity === 'critical' || f.severity === 'high'));
}

function startedText(round: RoundState): CommandResult {
  return {
    text: [`round: ${String(round.round)}`, `review job: ${round.reviewJob}`, `code check job: ${round.codeCheckJob}`].join('\n'),
    data: { result: 'started', round: round.round, reviewJob: round.reviewJob, codeCheckJob: round.codeCheckJob },
  };
}

function fixCheckText(round: RoundState, check: FixCheckState): CommandResult {
  return {
    text: [`round: ${String(round.round)}`, `fix check job: ${check.job}`].join('\n'),
    data: { result: 'started', round: round.round, fixCheckJob: check.job },
  };
}

/**
 * Stops the jobs of a round or fix check that was not written to the review state, and removes its tool review file
 * (`review`). It runs after the start failed, and that failure stays the result: a kill that failed is said in the log
 * with its error.
 */
async function dropJobs(ctx: Context, side: Side, jobs: readonly string[], review: boolean): Promise<void> {
  for (const job of jobs) {
    await killJob(job, ctx.env).catch((error: unknown) => {
      ctx.log(`killing job ${job} failed: ${(error instanceof Error ? error.message : String(error)).split('\n', 1)[0] as string}`);
    });
  }
  if (review && side === 'tool' && jobs[0] !== undefined) await removeToolReviewFiles(ctx, [{ reviewFile: null, reviewJob: jobs[0] }]);
}

/** Starts the `ogw code check` job of a round or a fix check at `commit`, with `fix test proof` when `base` is a commit. */
async function startCodeCheck(ctx: Context, side: Side, target: string, commit: string, base: string | null): Promise<string> {
  const proof = base === null ? [] : ['--fix-base', base, '--target', target];
  return startJob({
    argv: ['code', 'check', side, '--commit', commit, ...proof, '--json'],
    cwd: await reviewRepo(ctx, side),
    command: 'code check',
    game: null,
    timeLimitMs: LIMITS.jobMs,
    agentJob: null,
    env: ctx.env,
  });
}

interface NewRound {
  round: number;
  second: boolean;
  commit: string;
  input: string;
  definitionHashes: Record<string, string>;
  fixBase: string | null;
  harnessCommit: string | null;
  specChanges: string | null;
  debt: string[];
  mustFix: string[];
  whole: boolean;
  paysDebt: boolean;
  debtFloor: number;
}

/** Starts the round's review agent and code check jobs and writes the round to the review state. */
async function startRound(ctx: Context, dir: string, state: ReviewState, round: NewRound): Promise<RoundState> {
  const side = state.side;
  const reviewJob = await startAgent(ctx, { role: 'review', input: round.input, baseCommit: round.commit });
  const jobs = [reviewJob];
  try {
    const codeCheckJob = await startCodeCheck(ctx, side, state.target, round.commit, round.fixBase);
    jobs.push(codeCheckJob);
    const entry: RoundState = {
      round: round.round,
      ...(round.second ? { second: true } : {}),
      definitionHashes: round.definitionHashes,
      ...(round.harnessCommit === null ? {} : { harnessCommit: round.harnessCommit }),
      ...(round.specChanges === null ? {} : { specChanges: round.specChanges }),
      fixBase: round.fixBase,
      debt: round.debt,
      mustFix: round.mustFix,
      paysDebt: round.paysDebt,
      debtFloor: round.debtFloor,
      whole: round.whole,
      startCommit: round.commit,
      input: round.input,
      reviewJob,
      codeCheckJob,
      reviewFile: null,
      judged: false,
      result: null,
      open: [],
      codeCheck: [],
      codeCheckFile: null,
      fixInput: null,
    };
    state.rounds.push(entry);
    await writeState(dir, state);
    return entry;
  } catch (error) {
    await dropJobs(ctx, side, jobs, true);
    throw error;
  }
}

/**
 * Starts the fix check of the `fix` round `last` (core command.md `## review and code check` 3): the code check of the
 * commit now, with `fix test proof` when it gets a fix base (`fixBase`); for core once the fix is merged.
 */
async function startFixCheck(ctx: Context, dir: string, state: ReviewState, last: RoundState): Promise<FixCheckState> {
  await fixReports(ctx, dir, state, last);
  const commit = await startCommit(ctx, state.side);
  const base = fixBase(last);
  const job = await startCodeCheck(ctx, state.side, state.target, commit, base);
  try {
    const check: FixCheckState = { job, commit, fixBase: base, judged: false, result: null, codeCheck: [], outsideTarget: [], proofNotCounted: false };
    last.fixChecks = [...(last.fixChecks ?? []), check];
    await writeState(dir, state);
    return check;
  } catch (error) {
    await dropJobs(ctx, state.side, [job], false);
    throw error;
  }
}

function unjudged(target: string, round: RoundState): OgwError {
  return new OgwError(`round ${String(round.round)} of ${target} has not been judged by ogw review wait`);
}

/** Refuses an option while the last round or its fix check is not judged. */
function requireJudged(target: string, last: RoundState | undefined): void {
  if (last === undefined) return;
  if (!last.judged) throw unjudged(target, last);
  if (lastFixCheck(last)?.judged === false) throw new OgwError(`the fix check of round ${String(last.round)} of ${target} has not been judged by ogw review wait`);
}

/**
 * `--respec`: after a definition change, the review goes on with a round that reviews the code changes since the last
 * round and the target against the definition changes since the harness commit that round started at. Refused while a
 * round or fix check runs, and unless a definition document changed. Keeps the option in the state (`respecAfter`)
 * until a round it started is judged other than `invalid`.
 */
async function markRespec(state: ReviewState, target: string): Promise<void> {
  const last = state.rounds.at(-1);
  if (last === undefined) throw new OgwError(`--respec of ${target}: there is no round to go on from`);
  requireJudged(target, last);
  if (last.harnessCommit === undefined || last.definitionHashes === undefined) {
    throw new OgwError(`--respec of ${target}: round ${String(last.round)} kept no harness commit to diff the definitions from`);
  }
  if (!(await definitionsChanged(last))) {
    throw new OgwError(`--respec of ${target}: no definition document changed since round ${String(last.round)} started; it reviews ${target} against the definition changes only after its definition changed`);
  }
  dropOpeners(state);
  state.respecAfter = last.round;
}

/** `ogw review run --respec`: keeps the option in the review state once the last round is judged (`markRespec`). */
export async function keepRespec(ctx: Context, side: Side, target: string): Promise<void> {
  const dir = await targetDir(ctx, side, target);
  await withTarget(dir, async () => {
    const state = await readState(dir, side, target);
    await markRespec(state, target);
    await writeState(dir, state);
  });
}

/** Whether a definition document of `round` changed since it started: what `--respec` reviews. */
export async function definitionsChanged(round: RoundState): Promise<boolean> {
  const before = round.definitionHashes ?? {};
  const now = await definitionHashes(Object.keys(before));
  return Object.entries(before).some(([path, hash]) => now[path] !== hash);
}

/**
 * Drops a `--full` or `--debt` kept in the state from a round dropped as `invalid`: an option given now decides the
 * next round instead.
 */
function dropOpeners(state: ReviewState): void {
  delete state.full;
  delete state.debtReview;
}

/** An option that begins a new review: `--full` (the whole target) or `--debt` (the target's debt list). */
export type Opener = 'full' | 'debt';

/**
 * `--full` and `--debt` (`core` command.md `## review and code check`): the next round begins a new review, of the
 * whole target (`--full`, core only) or of the items of the target's debt list (`--debt`, which needs a debt list with
 * items). Taken with no round, or after a review that ended. Refused while a round or fix check runs and after another
 * result. Keeps the option in the state (`full`, `debtReview`) until a round it started is judged other than `invalid`.
 */
async function markOpener(ctx: Context, state: ReviewState, target: string, opener: Opener): Promise<void> {
  if (opener === 'full' && state.side !== 'core') throw new OgwError('--full is taken by a core target only');
  const last = state.rounds.at(-1);
  requireJudged(target, last);
  if (last !== undefined && !ended(last)) throw new OgwError(`--${opener} of ${target} needs no review state or a review that ended (done or fixed)`);
  if (opener === 'debt' && (await readList(await debtRepo(ctx, state.side), 'debt', target)).items.length === 0) {
    throw new OgwError(`--debt of ${target}: its debt list has no item`);
  }
  // the option given last decides the next round: drop what a round dropped as `invalid` left in the state
  dropOpeners(state);
  delete state.respecAfter;
  if (opener === 'full') state.full = true;
  else state.debtReview = true;
}

/** `ogw review run --full` or `--debt`: keeps the option in the review state (`markOpener`). */
export async function keepOpener(ctx: Context, target: string, opener: Opener): Promise<void> {
  const dir = await targetDir(ctx, 'core', target);
  await withTarget(dir, async () => {
    const state = await readState(dir, 'core', target);
    await markOpener(ctx, state, target, opener);
    await writeState(dir, state);
  });
}

/** Whether the round after `last` follows the `--full` or `--debt` kept in the state (`opener`, either when absent). */
export function opensLast(state: ReviewState, last: RoundState | undefined, opener?: Opener): boolean {
  const kept = opener === 'full' ? state.full === true : opener === 'debt' ? state.debtReview === true : state.full === true || state.debtReview === true;
  return kept && (last === undefined || ended(last));
}

/** Whether the round after the judged round `last` follows the `--respec` kept in the state. */
export function respecsLast(state: ReviewState, last: RoundState | undefined): boolean {
  return last?.judged === true && state.respecAfter === last.round;
}

/** Writes the diff of the definition documents since the harness commit `last` started at, and returns its path. */
async function specChangesDiff(ctx: Context, dir: string, last: RoundState): Promise<string> {
  const harness = (await ctx.workspace()).harness;
  const paths = Object.keys(last.definitionHashes ?? {}).map((path) => relative(harness, path)).filter((path) => !path.startsWith('..'));
  const file = join(dir, `round-${String(last.round + 1)}-spec-changes.diff`);
  await writeFileAtomic(file, await git(harness, ['diff', last.harnessCommit as string, '--', ...paths], { env: ctx.env }));
  return file;
}

/** SHA-256 of each document, or `missing`. */
async function definitionHashes(paths: readonly string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const path of paths) hashes[path] = exists(path) ? createHash('sha256').update(await readFile(path)).digest('hex') : 'missing';
  return hashes;
}

/**
 * Whether a core target is new since `commit`: none of its folders (`server/core/<module>/`,
 * `client/<engine>/core/<module folder>/` of each engine, `tools/<tool>/`) is in that commit.
 */
export async function newSince(ctx: Context, target: string, commit: string): Promise<boolean> {
  const repo = await reviewRepo(ctx, 'core');
  const engines = (await coreEngines(repo)).map((engine) => `client/${engine}/core/${moduleFolder(target)}`);
  for (const path of [`server/core/${target}`, `tools/${target}`, ...engines]) {
    if ((await gitRaw(repo, ['cat-file', '-e', `${commit}:${path}`], { env: ctx.env })).code === 0) return false;
  }
  return true;
}

/** The commit `--since` names, in the review repo. */
async function sinceCommit(ctx: Context, side: Side, since: string): Promise<string> {
  const repo = await reviewRepo(ctx, side);
  const resolved = await revParse(repo, since, { env: ctx.env });
  if (resolved === null) throw new OgwError(`--since: commit ${since} not found in ${repo}`);
  return resolved;
}

/** core: the reports of the merged core agent jobs that fixed the `fix` round `last`, recorded in the state. */
async function fixReports(ctx: Context, dir: string, state: ReviewState, last: RoundState | undefined): Promise<string[]> {
  if (state.side !== 'core' || last?.result !== 'fix' || last.fixInput === null) return [];
  const fix = await mergedFixJobs(ctx, last, last.fixInput);
  last.fixJobs = fix.jobs;
  await writeState(dir, state);
  return fix.reports;
}

/**
 * What the next round is (core command.md `## review and code check`): round 1 (`first`), a round of a new review
 * (`full`, `debt`, the must-fix round), the second round after a fix, or a round after a definition change (`respec`).
 */
type RoundKind = 'first' | 'full' | 'debt' | 'must fix' | 'second' | 'respec';

/**
 * The start of the round's commit range, or null for a review of the whole target: `--since` for round 1 (given now, or
 * kept in the state when round 1 was dropped as `invalid`), which the state keeps; the start commit of the last round
 * for a second or `--respec` round; the commit the review ended at for the must-fix round; the round's own commit for a
 * `--debt` round, which reviews no change.
 */
async function rangeStart(ctx: Context, state: ReviewState, kind: RoundKind, commit: string, since: string | undefined): Promise<string | null> {
  const last = state.rounds.at(-1);
  if (kind === 'full') return null;
  if (kind === 'debt') return commit;
  if (kind === 'must fix') return endCommit(last as RoundState);
  if (kind === 'second' || kind === 'respec') return (last as RoundState).startCommit;
  const { side, target } = state;
  if (since !== undefined) state.since = await sinceCommit(ctx, side, since);
  // a core target with no folder at `--since` is new since it: its review is of the whole target
  if (state.since !== undefined && side === 'core' && (await newSince(ctx, target, state.since))) return null;
  if (state.since !== undefined) return state.since;
  if (side === 'tool') throw new OgwError(`round 1 of tool target ${target} needs --since <the harness repo HEAD when the command started>`);
  return null;
}

/**
 * Keeps `--full`, `--debt` and `--respec` given now in the state, and tells which of them the next round follows. `--since`
 * given now decides round 1 over a `--full` or `--debt` that its dropped round left in the state.
 */
async function keptOption(ctx: Context, dir: string, state: ReviewState, options: NextOptions): Promise<RoundKind | null> {
  if (options.since !== undefined && state.rounds.length === 0 && (state.full === true || state.debtReview === true)) {
    dropOpeners(state);
    await writeState(dir, state);
  }
  for (const opener of ['full', 'debt'] as const) {
    if (options[opener] !== true) continue;
    await markOpener(ctx, state, state.target, opener);
    await writeState(dir, state);
  }
  if (options.respec === true) {
    await markRespec(state, state.target);
    await writeState(dir, state);
  }
  const last = state.rounds.at(-1);
  if (opensLast(state, last, 'full')) return 'full';
  if (opensLast(state, last, 'debt')) return 'debt';
  return respecsLast(state, last) ? 'respec' : null;
}

/** The review list items a round gives as scope. */
interface RoundItems {
  debt: ListItem[];
  mustFix: ListItem[];
  /** Whether the round's review pays debt, and the debt list's `nextId` when that review began. */
  paysDebt: boolean;
  debtFloor: number;
}

/**
 * The review list items of the round (`core` command.md `## review lists`): every must-fix item of the target, and, in a
 * review that pays debt (of the whole target, or `--debt`), the debt items in the list when the review began
 * (`scopeDebt`). A review begins at round 1, at the must-fix round and at a `--full` or `--debt` round (`begins`), which
 * takes `paysDebt` and the debt list's `nextId`; a later round takes them from the last round of its review.
 */
async function roundDebt(ctx: Context, state: ReviewState, begins: boolean, paysDebt: boolean): Promise<RoundItems> {
  const repo = await debtRepo(ctx, state.side);
  const list = await readList(repo, 'debt', state.target);
  const last = state.rounds.at(-1);
  const pays = begins ? paysDebt : last?.paysDebt === true;
  const floor = begins ? list.nextId : last?.debtFloor ?? 1;
  return { debt: pays ? scopeDebt(list, floor) : [], mustFix: (await readList(repo, 'must fix', state.target)).items, paysDebt: pays, debtFloor: floor };
}

/**
 * What a round of `kind` takes from the round `last` before it: a second round and a `--respec` round go on from it
 * (its review file is their `## previous review`) and check its fix when it is a `fix` round (its reports, and its fix
 * test proof); the other kinds begin a review.
 */
function roundShape(kind: RoundKind, last: RoundState | undefined): { followsFix: boolean; begins: boolean; previous: string | null } {
  const goesOn = kind === 'second' || kind === 'respec';
  return { followsFix: goesOn && last?.result === 'fix', begins: !goesOn, previous: goesOn ? last?.reviewFile ?? null : null };
}

/** Writes the input of the next round, starts its jobs and writes it to the review state. */
async function nextRound(ctx: Context, dir: string, state: ReviewState, kind: RoundKind, options: NextOptions): Promise<RoundState> {
  const { side, target } = state;
  const last = state.rounds.at(-1);
  const definitions = side === 'core' ? await coreDefinitions(ctx, target) : toolDefinitions(ctx, target, options.definitions);
  const commit = await startCommit(ctx, side);
  const from = await rangeStart(ctx, state, kind, commit, options.since);
  const specChanges = kind === 'respec' ? await specChangesDiff(ctx, dir, last as RoundState) : null;
  const { followsFix, begins, previous } = roundShape(kind, last);
  const reports = followsFix ? await fixReports(ctx, dir, state, last) : [];
  const debt = await roundDebt(ctx, state, begins, from === null || kind === 'debt');
  const round = (last?.round ?? 0) + 1;
  const input = await writeInput(dir, { side, target, round, previous, definitions, reports, from, commit, specChanges, debt });
  const hashes = await definitionHashes(definitions);
  const harnessCommit = await revParse((await ctx.workspace()).harness, 'HEAD', { env: ctx.env });
  const base = followsFix ? fixBase(last) : null;
  const ids = (items: readonly ListItem[]): string[] => items.map((item) => item.id);
  return startRound(ctx, dir, state, { round, second: kind === 'second', commit, input, definitionHashes: hashes, fixBase: base, harnessCommit, specChanges, debt: ids(debt.debt), mustFix: ids(debt.mustFix), whole: from === null, paysDebt: debt.paysDebt, debtFloor: debt.debtFloor });
}

/**
 * `ogw review next <core|tool> <target>` (core command.md `## review and code check`): starts round 1, the round a kept
 * option asks for, the second round or the fix check after a `fix` round, or the must-fix round after a review that
 * ended; otherwise starts nothing and prints the last result.
 */
export async function reviewNext(ctx: Context, side: Side, target: string, options: NextOptions): Promise<CommandResult> {
  const dir = await targetDir(ctx, side, target);
  return withTarget(dir, async () => {
    const state = await readState(dir, side, target);
    const last = state.rounds.at(-1);
    requireJudged(target, last);
    const kept = await keptOption(ctx, dir, state, options);
    if (kept !== null) return startedText(await nextRound(ctx, dir, state, kept, options));
    if (last === undefined) return startedText(await nextRound(ctx, dir, state, 'first', options));
    if (last.result === 'fix') {
      if (secondRoundDue(last)) return startedText(await nextRound(ctx, dir, state, 'second', options));
      return fixCheckText(last, await startFixCheck(ctx, dir, state, last));
    }
    if (ended(last) && (await hasMustFix(ctx, side, target))) return startedText(await nextRound(ctx, dir, state, 'must fix', options));
    if (ended(last) || last.result === 'blocked') return { text: String(last.result), data: { result: last.result, round: last.round } };
    throw new OgwError(`round ${String(last.round)} of ${target} has the result ${String(last.result)}, which ogw review next does not go on from; run ogw review clear ${side}`);
  });
}
