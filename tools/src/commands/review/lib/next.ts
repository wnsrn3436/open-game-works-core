import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
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
import { chainOf, readState, removeToolReviewFiles, reviewRepo, targetDir, withTarget, writeState, type ReviewState, type RoundState } from './state.ts';

/**
 * Core agent jobs of the `fix` input of a round, retries included (`taskInput`), oldest first. Only jobs started after
 * the round's review job ended count: a round of a chain started again (`--restart`) or of an earlier review of the
 * target has the same fix input path, and its jobs fixed other findings.
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
 * The round's start commit, read once: the review worktree is made at it, the code check job checks the target's files
 * at it, and the input's commit range starts from it. `core`: main of `open-game-works-core-impl/`, where `ogw agent merge`
 * puts the fix. `tool`: HEAD of the harness repo, whose `tools/` must have no change that is not committed, since the
 * lead agent fixes `tools/` in that checkout and a change left out of the commit would not be reviewed.
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
  last: RoundState | undefined;
  definitions: string[];
  reports: string[];
  /** The commit range's start: the last round's start commit, or `--since` for round 1. */
  from: string | null;
  commit: string;
  specChanges: string | null;
  debt: RoundItems;
}

/** Writes the review agent input of the round. */
async function writeInput(dir: string, request: InputRequest): Promise<string> {
  const { side, target, round, last, from, commit } = request;
  const path = join(dir, `round-${String(round)}-input.md`);
  await writeFileAtomic(path, formatReviewInput({
    side,
    target,
    round,
    definitions: request.definitions,
    previousReview: last?.reviewFile ?? null,
    commitRange: from === null ? null : `${from}..${commit}`,
    coreReports: request.reports,
    specChanges: request.specChanges,
    debt: request.debt.debt.map(itemLine),
    mustFix: request.debt.mustFix.map(itemLine),
  }));
  return path;
}

export interface NextOptions {
  restart: boolean;
  /** `--respec`: a round of a new chain after a definition change, from the last round. */
  respec?: boolean;
  /** `--continue`: a new chain after a `limit`. */
  continue?: boolean;
  /** `--reopen`: a new chain after a `done` round, when the target changed since it started. */
  reopen?: boolean;
  /** `--since <commit>`: round 1 reviews the changes from that commit. */
  since?: string;
  /** `--full`: the round reviews the whole target (core only). */
  full?: boolean;
  /** `--debt`: the round reviews the items of the target's debt list. */
  debt?: boolean;
  definitions: string[];
}

/**
 * Aspects of a finding whose fix changes behavior: the next round's code check proves the fix's tests on the code before
 * it. A `test evidence` finding adds tests to code that already behaves, so no test of its fix can fail on the code
 * before it; the review agent checks such tests by mutation (`core` command `## review and code check`).
 */
const BEHAVIOR_ASPECTS = ['correctness', 'spec', 'security'];

/** Whether the round's open findings hold a behavior finding to fix (a `spec change` `yes` finding goes to the human). */
function fixesBehavior(round: RoundState): boolean {
  return round.open.some((f) => f.specChange === 'no' && BEHAVIOR_ASPECTS.includes(f.aspect));
}

/**
 * `--fix-base` of the next round's code check: the last round's start commit after a fix of a behavior finding, the
 * last round's own `--fix-base` again when its proof failed and the round it proves had a behavior finding, or null.
 * `continues`: the next round is a `--continue` round, the only round after a `limit` that follows a fix.
 */
export function fixBase(last: RoundState | undefined, rounds: readonly RoundState[] = [], continues = false): string | null {
  if (last === undefined) return null;
  const proof = last.codeCheck.find((c) => c.name === 'fix test proof');
  if (proof?.result === 'fail' && typeof last.fixBase === 'string') {
    const proved = rounds.find((r) => r.startCommit === last.fixBase);
    // a base whose proof failed in two rounds is not asked again: no test fails on code that already behaved
    const failedOnBase = rounds.filter((r) => r.fixBase === last.fixBase && r.codeCheck.some((c) => c.name === 'fix test proof' && c.result === 'fail')).length;
    if ((proved === undefined || fixesBehavior(proved)) && failedOnBase < 2) return last.fixBase;
  }
  // a `--continue` round follows the fix the human chose after `limit`; a `--respec` round after `limit` follows no fix
  if (last.result !== 'fix' && last.result !== 'escalate' && !(last.result === 'limit' && continues)) return null;
  // a finding with `spec change` `yes` is not fixed: it goes to the human
  return fixesBehavior(last) ? last.startCommit : null;
}

function startedText(round: RoundState): CommandResult {
  return {
    text: [`round: ${String(round.round)}`, `review job: ${round.reviewJob}`, `code check job: ${round.codeCheckJob}`].join('\n'),
    data: { result: 'started', round: round.round, reviewJob: round.reviewJob, codeCheckJob: round.codeCheckJob },
  };
}

/** Stops the jobs of a round that was not written to the review state, and removes its tool review file. */
async function dropRound(ctx: Context, side: Side, jobs: readonly string[]): Promise<void> {
  for (const job of jobs) await killJob(job, ctx.env).catch(() => undefined);
  if (side === 'tool' && jobs[0] !== undefined) await removeToolReviewFiles(ctx, [{ reviewFile: null, reviewJob: jobs[0] }]);
}

interface NewRound {
  round: number;
  chain: number;
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
  const proof = round.fixBase === null ? [] : ['--fix-base', round.fixBase, '--target', state.target];
  try {
    const codeCheckJob = await startJob({
      argv: ['code', 'check', side, '--commit', round.commit, ...proof, '--json'],
      cwd: await reviewRepo(ctx, side),
      command: 'code check',
      game: null,
      timeLimitMs: LIMITS.jobMs,
      agentJob: null,
      env: ctx.env,
    });
    jobs.push(codeCheckJob);
    const entry: RoundState = {
      round: round.round,
      chain: round.chain,
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
    await dropRound(ctx, side, jobs);
    throw error;
  }
}

function unjudged(target: string, round: RoundState): OgwError {
  return new OgwError(`round ${String(round.round)} of ${target} has not been judged by ogw review wait`);
}

/**
 * `--restart`: removes the review state and, for `tool`, the review files of its rounds. Refused while a round runs, and
 * unless a definition document of the last round changed since it started (core command.md `## review and code check`).
 */
async function restart(ctx: Context, dir: string, side: Side, target: string): Promise<void> {
  const state = await readState(dir, side, target);
  const last = state.rounds.at(-1);
  if (last && !last.judged) throw unjudged(target, last);
  if (last) await requireDefinitionChange(target, last);
  if (side === 'tool') await removeToolReviewFiles(ctx, state.rounds);
  await rm(dir, { recursive: true, force: true });
}

/**
 * `--respec`: after a definition change, the review goes on with a round of a new chain that reviews the code changes
 * since the last round and the target against the definition changes since the harness commit that round started at.
 * Refused while a round runs, unless a definition document changed, and for a round that kept no harness commit
 * (`--restart` then). Keeps the option in the state (`respecAfter`) until a round it started is judged other than
 * `invalid`.
 */
async function markRespec(state: ReviewState, target: string): Promise<void> {
  const last = state.rounds.at(-1);
  if (last === undefined) throw new OgwError(`--respec of ${target}: there is no round to go on from`);
  if (!last.judged) throw unjudged(target, last);
  await requireDefinitionChange(target, last, '--respec');
  if (last.harnessCommit === undefined || last.definitionHashes === undefined) {
    throw new OgwError(`--respec of ${target}: round ${String(last.round)} kept no harness commit; use --restart`);
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

/**
 * The paths of a target whose change since a `done` round lets `--reopen` start a round (core command.md
 * `## review and code check`): `server/core/<module>/`, `client/<engine>/core/<module folder>/`, `tools/<tool>/` and
 * `core-spec/<module>.json` of `open-game-works-core-impl/`, or the harness `tools/` for a tool target.
 */
async function reopenPaths(repo: string, side: Side, target: string): Promise<string[]> {
  if (side === 'tool') return ['tools'];
  const engines = (await coreEngines(repo)).map((engine) => `client/${engine}/core/${moduleFolder(target)}`);
  return [`server/core/${target}`, `tools/${target}`, ...engines, `core-spec/${target}.json`];
}

/**
 * `--reopen`: after a `done` round, the review goes on with a round of a new chain that reviews the changes since the
 * commit that round started at. Refused while a round runs, unless the last round is `done`, and unless the target's
 * paths (`reopenPaths`) changed from that commit to the commit the round would start at or the target's must-fix list
 * has an item. Keeps the option in the state
 * (`reopenAfter`) until a round it started is judged other than `invalid`.
 */
async function markReopen(ctx: Context, state: ReviewState, target: string): Promise<void> {
  const last = state.rounds.at(-1);
  if (last === undefined) throw new OgwError(`--reopen of ${target}: there is no round to go on from`);
  if (!last.judged) throw unjudged(target, last);
  if (last.result !== 'done') throw new OgwError(`--reopen needs the last round of ${target} to be done`);
  const repo = await reviewRepo(ctx, state.side);
  const paths = await reopenPaths(repo, state.side, target);
  const changed = await git(repo, ['diff', '--name-only', last.startCommit, await startCommit(ctx, state.side), '--', ...paths], { env: ctx.env });
  // a fixed must-fix item of the target is confirmed by a review of it, wherever its file was
  if (changed.trim() === '' && !(await hasMustFix(ctx, state.side, target))) {
    throw new OgwError(`--reopen of ${target}: nothing of ${target} changed since round ${String(last.round)} started at ${last.startCommit} (${paths.join(', ')})`);
  }
  dropOpeners(state);
  state.reopenAfter = last.round;
}

/**
 * Whether what `--respec` or `--reopen` reviews changed since `round` started: a definition document (`--respec`), or
 * the target's paths (`reopenPaths`) from its start commit to the commit a round would start at now (`--reopen`).
 */
export async function changedSinceRound(ctx: Context, state: ReviewState, round: RoundState, option: '--respec' | '--reopen'): Promise<boolean> {
  if (option === '--respec') {
    const before = round.definitionHashes ?? {};
    const now = await definitionHashes(Object.keys(before));
    return Object.entries(before).some(([path, hash]) => now[path] !== hash);
  }
  const repo = await reviewRepo(ctx, state.side);
  const paths = await reopenPaths(repo, state.side, state.target);
  return (await git(repo, ['diff', '--name-only', round.startCommit, await startCommit(ctx, state.side), '--', ...paths], { env: ctx.env })).trim() !== '';
}

/** `ogw review run --reopen`: keeps the option in the review state once the last round is judged (`markReopen`). */
export async function keepReopen(ctx: Context, side: Side, target: string): Promise<void> {
  const dir = await targetDir(ctx, side, target);
  await withTarget(dir, async () => {
    const state = await readState(dir, side, target);
    await markReopen(ctx, state, target);
    await writeState(dir, state);
  });
}

/**
 * Drops a `--full` or `--debt` kept in the state from a round dropped as `invalid`: an option given now decides the
 * next round instead.
 */
function dropOpeners(state: ReviewState): void {
  delete state.full;
  delete state.debtReview;
}

/** An option that begins a new review after `done`: `--full` (the whole target) or `--debt` (the target's debt list). */
export type Opener = 'full' | 'debt';

/**
 * `--full` and `--debt` (`core` command.md `## review and code check`): the next round begins a new review, of the
 * whole target (`--full`, core only) or of the items of the target's debt list (`--debt`, which needs a debt list with
 * items). Taken with no round, or after a `done` round, whose review it ends: the round is in a new chain. Refused while
 * a round runs and after another result. Keeps the option in the state (`full`, `debtReview`) until a round it started
 * is judged other than `invalid`.
 */
async function markOpener(ctx: Context, state: ReviewState, target: string, opener: Opener): Promise<void> {
  if (opener === 'full' && state.side !== 'core') throw new OgwError('--full is taken by a core target only');
  const last = state.rounds.at(-1);
  if (last !== undefined && !last.judged) throw unjudged(target, last);
  if (last !== undefined && last.result !== 'done') throw new OgwError(`--${opener} of ${target} needs no review state or a last round that is done`);
  if (opener === 'debt' && (await readList(await debtRepo(ctx, state.side), 'debt', target)).items.length === 0) {
    throw new OgwError(`--debt of ${target}: its debt list has no item`);
  }
  // the option given last decides the next round: drop what a round dropped as `invalid` left in the state
  dropOpeners(state);
  delete state.respecAfter;
  delete state.reopenAfter;
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
  return kept && (last === undefined || (last.judged && last.result === 'done'));
}

/** Whether the round after the judged round `last` follows the `--reopen` kept in the state. */
export function reopensLast(state: ReviewState, last: RoundState | undefined): boolean {
  return last?.judged === true && last.result === 'done' && state.reopenAfter === last.round;
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

async function requireDefinitionChange(target: string, last: RoundState, option: '--restart' | '--respec' = '--restart'): Promise<void> {
  const before = last.definitionHashes;
  // a round written before the hashes were kept cannot be compared: its restart is taken
  if (before === undefined) return;
  const refused = `${option} of ${target}: no definition document changed since round ${String(last.round)} started; it reviews ${target} ${option === '--restart' ? 'from round 1' : 'against the definition changes'} only after its definition changed`;
  const now = await definitionHashes(Object.keys(before));
  if (Object.entries(before).every(([path, hash]) => now[path] === hash)) throw new OgwError(refused);
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

/**
 * The result that starts no round: the last round is `done`, `blocked`, or `limit` without `--continue` (given now,
 * or kept in the state from a run whose round was dropped as `invalid`); else null.
 */
function noRound(state: ReviewState, last: RoundState | undefined, target: string, options: NextOptions): CommandResult | null {
  if (last && !last.judged) throw unjudged(target, last);
  checkContinue(target, last, options.continue === true);
  if (last?.result === 'done' || last?.result === 'blocked' || (last?.result === 'limit' && !continuesLimit(state, last, options.continue === true))) {
    return { text: last.result, data: { result: last.result, round: last.round } };
  }
  return null;
}

/** `--continue` needs a `limit` last round, or a round it started that is not judged yet (a run started again). */
export function checkContinue(target: string, last: RoundState | undefined, continueOption: boolean): void {
  if (continueOption && last?.judged !== false && last?.result !== 'limit') throw new OgwError(`--continue needs the last round of ${target} to be limit`);
}

/**
 * Whether a round follows the `limit` round `last`: with `--continue` given now, or kept in the state from a run
 * whose round was dropped as `invalid`.
 */
export function continuesLimit(state: ReviewState, last: RoundState, continueOption: boolean): boolean {
  return last.result === 'limit' && (continueOption || state.continueAfter === last.round);
}

/**
 * Core agent jobs of the target merged after the `limit` round `last` was judged: the fix the human chose, which the
 * lead gave a core agent with `--module <target>` before `--continue`.
 */
async function humanFixJobs(ctx: Context, target: string, last: RoundState): Promise<{ jobs: string[]; reports: string[] }> {
  const judgedAt = (await readJob(last.reviewJob, ctx.env)).endedAt ?? 0;
  const merged = (await listJobs(ctx.env)).filter((job) => {
    const meta = job.meta as AgentMeta;
    return job.command === 'agent' && meta.role === 'core' && meta.merged && meta.modules.includes(target) && job.startedAt >= judgedAt;
  });
  const reports = merged.map((job) => mergedOutput(job.meta as AgentMeta)).filter((path): path is string => path !== null && exists(path));
  return { jobs: merged.map((job) => job.id), reports };
}

/** core: the reports of the merged core agent jobs that fixed the target after the last round, recorded in the state. */
async function fixReports(ctx: Context, dir: string, state: ReviewState, last: RoundState | undefined): Promise<string[]> {
  if (state.side !== 'core' || last === undefined) return [];
  let fix: { jobs: string[]; reports: string[] };
  if ((last.result === 'fix' || last.result === 'escalate') && last.fixInput !== null) fix = await mergedFixJobs(ctx, last, last.fixInput);
  else if (last.result === 'limit') fix = await humanFixJobs(ctx, state.target, last);
  else return [];
  last.fixJobs = fix.jobs;
  await writeState(dir, state);
  return fix.reports;
}

/**
 * The start of the round's commit range: the last round's start commit, or `--since` for round 1 (given now, or kept
 * in the state when round 1 was dropped as `invalid`), which the state keeps.
 */
async function rangeStart(ctx: Context, state: ReviewState, target: string, last: RoundState | undefined, since: string | undefined): Promise<string | null> {
  const side = state.side;
  if (opensLast(state, last, 'full')) return null;
  // `--since` sets the range of round 1 only: a later round reviews the fix since the last round
  if (last !== undefined) return last.startCommit;
  if (since !== undefined) state.since = await sinceCommit(ctx, side, since);
  // a core target with no folder at `--since` is new since it: its review is of the whole target
  if (state.since !== undefined && side === 'core' && (await newSince(ctx, target, state.since))) return null;
  if (state.since !== undefined) return state.since;
  if (side === 'tool') throw new OgwError(`round 1 of tool target ${target} needs --since <the harness repo HEAD when the command started>`);
  return null;
}

/**
 * The chain of the next round: a new one after `escalate`, after `limit` (`--continue`), and for a `--respec` or
 * `--reopen` round (`opens`).
 */
function nextChain(last: RoundState | undefined, opens: boolean): number {
  if (last === undefined) return 1;
  return chainOf(last) + (opens || last.result === 'escalate' || last.result === 'limit' ? 1 : 0);
}

/**
 * Keeps `--respec` and `--reopen` given now in the state, and tells whether the next round follows the one kept there:
 * a round after a definition change goes on from a `blocked` (or `done`, `limit`) round, a round after a change of the
 * target from a `done` round.
 */
async function opensChain(ctx: Context, dir: string, state: ReviewState, options: NextOptions): Promise<{ respecs: boolean; reopens: boolean; fulls: boolean; debts: boolean; opens: boolean }> {
  if (options.since !== undefined) await sinceDecides(dir, state);
  for (const opener of ['full', 'debt'] as const) {
    if (options[opener] !== true) continue;
    await markOpener(ctx, state, state.target, opener);
    await writeState(dir, state);
  }
  if (options.respec === true) {
    await markRespec(state, state.target);
    await writeState(dir, state);
  }
  if (options.reopen === true) {
    await markReopen(ctx, state, state.target);
    await writeState(dir, state);
  }
  const last = state.rounds.at(-1);
  const fulls = opensLast(state, last, 'full');
  const debts = opensLast(state, last, 'debt');
  const respecs = !fulls && !debts && respecsLast(state, last);
  const reopens = !fulls && !debts && !respecs && reopensLast(state, last);
  return { respecs, reopens, fulls, debts, opens: last !== undefined && (respecs || reopens || fulls || debts) };
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
 * (`scopeDebt`). The review begins at round 1 and at a round that follows `--reopen`, `--full` or `--debt` (`begins`),
 * which takes `paysDebt` and the debt list's `nextId`; a later round takes them from the last round of its review.
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
 * `--since` given now decides round 1 over a `--full` or `--debt` that its dropped round left in the state. With a round
 * in the state `--since` decides nothing (`rangeStart`), so a kept option stays.
 */
async function sinceDecides(dir: string, state: ReviewState): Promise<void> {
  if (state.rounds.length > 0 || (state.full !== true && state.debtReview !== true)) return;
  dropOpeners(state);
  await writeState(dir, state);
}

/** What `opensChain` tells of the next round. */
type Opening = Awaited<ReturnType<typeof opensChain>>;

/** Whether the next round begins a new review after a `done` round (`--reopen`, `--full`, `--debt`): it follows no fix. */
function beginsAfterDone(opening: Opening): boolean {
  return opening.reopens || opening.fulls || opening.debts;
}

/** Writes the input of the next round, starts its jobs and writes it to the review state. */
async function nextRound(ctx: Context, dir: string, state: ReviewState, opening: Opening, options: NextOptions): Promise<RoundState> {
  const { side, target } = state;
  const last = state.rounds.at(-1);
  const { respecs, debts, opens } = opening;
  const definitions = side === 'core' ? await coreDefinitions(ctx, target) : toolDefinitions(ctx, target, options.definitions);
  const commit = await startCommit(ctx, side);
  // a `--debt` round reviews no change: the empty range from its start commit, and the debt items
  const from = debts ? commit : await rangeStart(ctx, state, target, last, options.since);
  const specChanges = respecs ? await specChangesDiff(ctx, dir, last as RoundState) : null;
  // past `noRound`, a round after `limit` that is not a `--respec` round is a `--continue` round
  const continues = !respecs && last?.result === 'limit';
  if (continues) state.continueAfter = last.round;
  const reports = await fixReports(ctx, dir, state, last);
  const debt = await roundDebt(ctx, state, last === undefined || beginsAfterDone(opening), from === null || debts);
  const round = (last?.round ?? 0) + 1;
  const input = await writeInput(dir, { side, target, round, last, definitions, reports, from, commit, specChanges, debt });
  const hashes = await definitionHashes(definitions);
  const chain = nextChain(last, opens);
  const harnessCommit = await revParse((await ctx.workspace()).harness, 'HEAD', { env: ctx.env });
  const base = beginsAfterDone(opening) ? null : fixBase(last, state.rounds, continues);
  const ids = (items: readonly ListItem[]): string[] => items.map((item) => item.id);
  return startRound(ctx, dir, state, { round, chain, commit, input, definitionHashes: hashes, fixBase: base, harnessCommit, specChanges, debt: ids(debt.debt), mustFix: ids(debt.mustFix), whole: from === null, paysDebt: debt.paysDebt, debtFloor: debt.debtFloor });
}

/** `ogw review next <core|tool> <target>`. */
export async function reviewNext(ctx: Context, side: Side, target: string, options: NextOptions): Promise<CommandResult> {
  const dir = await targetDir(ctx, side, target);
  return withTarget(dir, async () => {
    if (options.restart) await restart(ctx, dir, side, target);
    const state = await readState(dir, side, target);
    const last = state.rounds.at(-1);
    if (last && !last.judged) throw unjudged(target, last);
    const opening = await opensChain(ctx, dir, state, options);
    const stopped = opening.opens || opening.fulls || opening.debts ? null : noRound(state, last, target, options);
    if (stopped !== null) return stopped;
    return startedText(await nextRound(ctx, dir, state, opening, options));
  });
}
