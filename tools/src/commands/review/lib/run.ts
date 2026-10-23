/**
 * `ogw review run core <target>`: the rounds of a core review target until they stop (`core` command.md
 * `## review and code check`).
 */
import { join } from 'node:path';
import type { CommandResult, Context } from '../../../lib/command.ts';
import { OgwError, EXIT_STILL_RUNNING } from '../../../lib/errors.ts';
import { jobsDir, readJob, startJob, waitJob, type WaitResult } from '../../../lib/jobs.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { withLock } from '../../../lib/lock.ts';
import { git, worktreeAdd, worktreeRemove } from '../../../lib/git.ts';
import { newId } from '../../../lib/ids.ts';
import { cliEntry } from '../../../lib/paths.ts';
import { run } from '../../../lib/proc.ts';
import { withSlot } from '../../../lib/slots.ts';
import { mergeAgents } from '../../agent/lib/merge.ts';
import type { AgentMeta } from '../../agent/lib/meta.ts';
import { startAgent } from '../../agent/lib/prepare.ts';
import { dependentsOf } from '../../core/dependents.ts';
import { enginesOf, readCoreSpecDir } from '../../core/lib/impl.ts';
import { serverImplementedModules } from '../../core/lib/server-layout.ts';
import { engineImplementedModules } from '../../core/lib/spec-dir-check.ts';
import { TOOLS } from '../../core/lib/tools.ts';
import { urgentOutOfScope } from './review-file.ts';
import { changedSinceRound, checkContinue, continuesLimit, fixJobs, keepOpener, mergedFix as isMergedFix, keepReopen, opensLast, keepRespec, reopensLast, respecsLast, reviewNext, type NextOptions, type Opener } from './next.ts';
import { readState, targetDir, type ReviewState, type RoundState } from './state.ts';
import { judgedOutput, reviewWait } from './wait.ts';

/** Why `ogw review run` stopped. */
export type RunStop = 'done' | 'blocked' | 'limit' | 'invalid' | 'not merged' | 'test fail';

interface Stop {
  result: RunStop;
  /** Lines after the round: why the fix was not merged, or the failed core tests. */
  detail: string[];
}

/** What one run of the command keeps between steps. */
interface Drive {
  ctx: Context;
  target: string;
  dir: string;
  slots: { dir: string; count: number };
  /** `--restart`: the first `review next` of this run removes the review state. */
  restart: boolean;
  /** `--continue`: kept until a round it started is judged other than `invalid`, which drops that round. */
  continuing: boolean;
  /**
   * `--respec` or `--reopen` of the run not kept in the review state yet: it follows the last round once that is judged
   * (`keepPending`).
   */
  pending: { respec: boolean; reopen: boolean };
  /** `--since`: the range of round 1, also of a round 1 started again after an `invalid` one. */
  since: string | undefined;
  /** `--full` or `--debt` of the run not kept in the review state yet (`keepOpener`). */
  opener: Opener | null;
  /** Rounds judged `invalid` in a row. */
  invalid: number;
  /** The lines after `round:` that `ogw review wait` printed for the last `invalid` round. */
  invalidLines: string[];
  /** Failed lines of other modules' core tests after a fix that failed also before the fix: reported, not stopping. */
  preexisting: string[];
  /** The `fix` round whose merged fix passed its core tests in this run: its next round may start. */
  tested: number | null;
}

async function slot<T>(drive: Drive, fn: () => Promise<T>): Promise<T> {
  return withSlot(drive.slots.dir, drive.slots.count, fn);
}

/** Waits until the job ends, without a time limit. */
async function waitEnd(drive: Drive, id: string): Promise<WaitResult> {
  for (;;) {
    const waited = await waitJob(id, LIMITS.jobMs, drive.ctx.env);
    if (waited.finished) return waited;
  }
}

/** `ogw review wait core <target>` until the round is judged. */
async function judge(drive: Drive): Promise<CommandResult> {
  for (;;) {
    const result = await reviewWait(drive.ctx, 'core', drive.target, LIMITS.jobMs);
    if (result.exitCode !== EXIT_STILL_RUNNING) return result;
  }
}

/**
 * Counts a judged round: an `invalid` one raises the count of `invalid` rounds in a row and keeps its reason lines, any
 * other resets it. Returns the stop at the second `invalid` in a row, or null.
 */
function counted(drive: Drive, judged: CommandResult): Stop | null {
  const data = judged.data as { result: string; reviewFile?: string | null; notMerged?: string[] };
  if (data.result !== 'invalid') {
    drive.invalid = 0;
    drive.continuing = false;
    return null;
  }
  drive.invalid += 1;
  const notMerged = data.notMerged ?? [];
  drive.invalidLines = notMerged.length > 0 ? notMerged : [`review file missing or not in the review file format: ${data.reviewFile ?? 'none'}`];
  return drive.invalid >= 2 ? { result: 'invalid', detail: drive.invalidLines } : null;
}

/** Starts a round (the first with `--restart` when asked) and judges it. Returns a stop, or null to go on. */
async function round(drive: Drive): Promise<Stop | null> {
  const judged = await slot(drive, async () => {
    // `--respec` and `--reopen` are kept in the review state once the last round is judged (`keepPending`)
    const options: NextOptions = { restart: drive.restart, continue: drive.continuing, definitions: [], ...(drive.since === undefined ? {} : { since: drive.since }) };
    const started = await reviewNext(drive.ctx, 'core', drive.target, options);
    drive.restart = false;
    const data = started.data as { result?: string };
    // `review next` starts no round when the last result was done, blocked or limit
    if (data.result === 'done' || data.result === 'blocked' || data.result === 'limit') return data.result;
    return judge(drive);
  });
  if (typeof judged === 'string') return { result: judged, detail: [] };
  return counted(drive, judged);
}

/** Merges the core agent job; returns null when merged, else why not. A job that did not end `done` has no report and is not merged. */
async function merge(drive: Drive, id: string): Promise<string | null> {
  const job = await readJob(id, drive.ctx.env);
  if (job.status !== 'done') return `${id} ended ${job.status}`;
  const result = await mergeAgents(drive.ctx, [id]);
  if (result.merged.includes(id)) return null;
  const failed = result.failed.find((f) => f.id === id);
  return failed === undefined ? `${id} was not merged` : `${id}: ${failed.reason}: ${failed.detail}`;
}

/** Calls a core agent with the fix input at main HEAD and waits for it. */
async function callFixAgent(drive: Drive, fixInput: string): Promise<string> {
  return slot(drive, async () => {
    const id = await startAgent(drive.ctx, { role: 'core', modules: [drive.target], input: fixInput });
    await waitEnd(drive, id);
    return id;
  });
}

/**
 * The fix of a `fix` round merged into main: a merged `done` job of its input, else its newest `done` job not merged
 * yet (its running jobs waited for first) merged, else a new core agent merged. A job that did not end `done` has no
 * report and is not merged. A job not merged is called again once from main HEAD. Returns a stop, or null.
 */
async function mergedFix(drive: Drive, round: RoundState, fixInput: string): Promise<Stop | null> {
  for (const job of (await fixJobs(drive.ctx, round, fixInput)).filter((j) => j.status === 'running')) {
    await slot(drive, () => waitEnd(drive, job.id));
  }
  const jobs = await fixJobs(drive.ctx, round, fixInput);
  if (jobs.some(isMergedFix)) return null;
  const ready = jobs.filter((job) => job.status === 'done' && !(job.meta as AgentMeta).merged && (job.meta as AgentMeta).worktree !== null).at(-1);
  let id = ready?.id ?? (await callFixAgent(drive, fixInput));
  let called = false;
  for (;;) {
    const why = await merge(drive, id);
    if (why === null) return null;
    if (called) return { result: 'not merged', detail: [`not merged: ${why}`] };
    id = await callFixAgent(drive, fixInput);
    called = true;
  }
}

/** The merge commit `ogw agent merge <id>` on main of the round's merged fix job, or null when none is found. */
async function fixMergeCommit(drive: Drive, round: RoundState, fixInput: string): Promise<string | null> {
  const merged = (await fixJobs(drive.ctx, round, fixInput)).find(isMergedFix);
  if (merged === undefined) return null;
  const coreImpl = (await drive.ctx.workspace()).coreImpl;
  const commit = (await git(coreImpl, ['log', 'main', '-1', '--format=%H', '--fixed-strings', `--grep=ogw agent merge ${merged.id}`], { env: drive.ctx.env })).trim();
  return commit === '' ? null : commit;
}

/**
 * The commits a failing module of the fix's core tests runs again at: `before`, main just before the fix was merged
 * (the first parent of its merge commit, or the round's start when the merge commit is not found), and `merge`, the
 * merge commit itself, or null when it is not found or main changed nothing outside `records/` since it (then the
 * core tests after the fix read that commit's files).
 */
async function fixCommits(drive: Drive, round: RoundState): Promise<{ before: string; merge: string | null }> {
  const merge = round.fixInput === null ? null : await fixMergeCommit(drive, round, round.fixInput);
  if (merge === null) return { before: round.startCommit, merge: null };
  const coreImpl = (await drive.ctx.workspace()).coreImpl;
  const later = (await git(coreImpl, ['diff', '--name-only', merge, 'main'], { env: drive.ctx.env })).split('\n').filter((f) => f !== '' && !f.startsWith('records/'));
  return { before: `${merge}^1`, merge: later.length > 0 ? merge : null };
}

/**
 * Whether the merged fix job of the round changed no file outside `records/` (core command.md `## review and code
 * check`: then no core test runs after it). Read from its merge commit `ogw agent merge <id>` on main; when that
 * commit is not found, the tests run.
 */
async function fixOnlyRecords(drive: Drive, round: RoundState, fixInput: string): Promise<boolean> {
  const commit = await fixMergeCommit(drive, round, fixInput);
  if (commit === null) return false;
  const coreImpl = (await drive.ctx.workspace()).coreImpl;
  const files = (await git(coreImpl, ['diff', '--name-only', `${commit}^1`, commit], { env: drive.ctx.env })).split('\n').filter((f) => f !== '');
  return files.length > 0 && files.every((f) => f.startsWith('records/'));
}

/** The `ogw core test` runs after a fix of the target (`ogw core dependents`, implemented modules only). */
export async function testRuns(coreImpl: string, target: string): Promise<string[][]> {
  if ((TOOLS as readonly string[]).includes(target)) return [['tools']];
  const modules = await readCoreSpecDir(coreImpl, { required: true });
  const byName = new Map(modules.map((m) => [m.name, m]));
  if (!byName.has(target)) throw new OgwError(`not in core-spec: ${target}`);
  const found = dependentsOf(byName, [target]);
  const runs: string[][] = [];
  const implemented = new Set(await serverImplementedModules(coreImpl));
  const server = modules.filter((m) => m.side === 'server' && found.has(m.name) && implemented.has(m.name)).map((m) => m.name);
  if (server.length > 0) runs.push(['server', ...server]);
  const client = modules.filter((m) => found.has(m.name));
  for (const engine of await enginesOf(coreImpl)) {
    const names = await engineImplementedModules(coreImpl, engine, client);
    if (names.length > 0) runs.push([engine, ...names], [engine, ...names, '--web']);
  }
  return runs;
}

/** Lines of the failed modules of a `ogw core test --json` job. */
interface CoreTestOutput {
  modules?: Record<string, string>;
  failures?: Record<string, string[]>;
  skipped?: Record<string, string>;
  error?: string;
}

/**
 * Lines of the `fail` modules of a core test output (`core` command.md `## review and code check`: only a `fail` stops
 * the fix). A `skipped` module has none: one skipped for a dependency that did not pass comes with that dependency's
 * lines, and a tool whose engine round trip was left out failed nothing.
 */
function moduleLines(command: string, data: CoreTestOutput): string[] {
  const lines: string[] = [];
  for (const [module, result] of Object.entries(data.modules ?? {})) {
    if (result !== 'fail') continue;
    lines.push(`${command}: ${module} ${result}`, ...(data.failures?.[module] ?? []).map((failure) => `  ${failure}`));
  }
  return lines;
}

export function failedLines(args: readonly string[], waited: WaitResult): string[] {
  const command = `ogw core test ${args.join(' ')}`;
  try {
    const data = JSON.parse(waited.stdout) as CoreTestOutput;
    if (typeof data.error === 'string') return [`${command}: ${data.error}`];
    const lines = moduleLines(command, data);
    // a run with a left-out round trip ends with exit code 1 and no failing test
    if (lines.length > 0 || waited.job.exitCode === 0 || Object.keys(data.skipped ?? {}).length > 0) return lines;
  } catch {
    // not JSON: the command failed before it tested
  }
  return [`${command}: exit code ${String(waited.job.exitCode)}: ${(waited.stderr || waited.stdout).trim().split('\n')[0] ?? ''}`];
}

/** The failed lines of one core test run after a fix, with the modules whose tests failed in it. */
export interface FixRun {
  args: string[];
  lines: string[];
  /** The failed modules; null when the run failed otherwise (it stopped before the tests, or did not report). */
  failed: string[] | null;
}

/** `pass` or `fail` as a core test output reports `module`, or null for any other output or result. */
function moduleResult(waited: WaitResult, module: string): 'pass' | 'fail' | null {
  try {
    const data = JSON.parse(waited.stdout) as CoreTestOutput;
    if (typeof data.error === 'string') return null;
    const result = data.modules?.[module];
    return result === 'pass' || result === 'fail' ? result : null;
  } catch {
    return null;
  }
}

/** The modules a core test output reports as `fail`, or null when it is not such an output. */
function failedModules(waited: WaitResult): string[] | null {
  try {
    const data = JSON.parse(waited.stdout) as CoreTestOutput;
    if (typeof data.error === 'string') return null;
    return Object.entries(data.modules ?? {}).filter(([, result]) => result === 'fail').map(([module]) => module);
  } catch {
    return null;
  }
}

/** Runs the core tests after the fix, each in a slot of its own and together. */
async function testFix(drive: Drive): Promise<FixRun[]> {
  const coreImpl = (await drive.ctx.workspace()).coreImpl;
  const runs = await testRuns(coreImpl, drive.target);
  const results = await Promise.all(runs.map((args) => slot(drive, async () => {
    const id = await startJob({
      argv: ['core', 'test', ...args, '--json'],
      cwd: coreImpl,
      command: 'core test',
      game: null,
      timeLimitMs: LIMITS.jobMs,
      agentJob: null,
      env: drive.ctx.env,
    });
    const waited = await waitEnd(drive, id);
    return { args, lines: failedLines(args, waited), failed: failedModules(waited) };
  })));
  return results.filter((r) => r.lines.length > 0);
}

/**
 * The result `module` of the run's target (`args[0]`, and `--web` when the run has it) has at `commit`: `pass` or `fail`
 * as the run reports it, or null for a run that did not report it so (it stopped before the tests, did not report, or
 * skipped the module). Runs `ogw core test` of that module alone in a worktree of that commit under
 * `worktrees/_core/`, which `ogw core test` takes as the core checkout.
 */
async function resultAt(drive: Drive, args: readonly string[], module: string, commit: string): Promise<'pass' | 'fail' | null> {
  const ws = await drive.ctx.workspace();
  const worktree = join(ws.worktrees, '_core', `before-${newId()}`);
  try {
    await worktreeAdd(ws.coreImpl, worktree, commit, undefined, { env: drive.ctx.env });
    const target = [args[0] as string, ...(args.includes('--web') ? ['--web'] : [])];
    return await slot(drive, async () => {
      const id = await startJob({ argv: ['core', 'test', ...target, module, '--json'], cwd: worktree, command: 'core test', game: null, timeLimitMs: LIMITS.jobMs, agentJob: null, env: drive.ctx.env });
      return moduleResult(await waitEnd(drive, id), module);
    });
  } finally {
    await worktreeRemove(ws.coreImpl, worktree, { env: drive.ctx.env }).catch(() => undefined);
  }
}

/**
 * The stop of the core tests after a fix, or null. A failure of the target, or a run that failed otherwise, stops the
 * run (`test fail`). A failure of another module stops it only when it is the fix's: that module passes at main before
 * the fix and, when main moved past the fix merge, fails at that merge. Otherwise its lines are kept to report
 * (`pre-existing test fail`).
 */
async function fixTestStop(drive: Drive, last: RoundState, runs: readonly FixRun[]): Promise<Stop | null> {
  const { before, merge } = await fixCommits(drive, last);
  // not the fix's: it fails without the fix, or it passes without the fix, main moved past the fix merge, and it passes
  // at that merge; any run that does not report it is the fix's
  const notTheFixs = async (args: readonly string[], module: string): Promise<boolean> => {
    const without = await resultAt(drive, args, module, before);
    if (without !== 'pass') return without === 'fail';
    return merge !== null && (await resultAt(drive, args, module, merge)) === 'pass';
  };
  const sorted = await sortFixRuns(runs, drive.target, notTheFixs);
  drive.preexisting.push(...sorted.preexisting);
  return sorted.stopping.length > 0 ? { result: 'test fail', detail: sorted.stopping } : null;
}

/** The failed lines that stop the run and those that failed before the fix (`fixTestStop`). */
export async function sortFixRuns(
  runs: readonly FixRun[],
  target: string,
  failedBefore: (args: readonly string[], module: string) => Promise<boolean>,
): Promise<{ stopping: string[]; preexisting: string[] }> {
  const stopping: string[] = [];
  const preexisting: string[] = [];
  for (const run of runs) {
    const others = run.failed?.filter((module) => module !== target) ?? [];
    if (run.failed === null || run.failed.includes(target) || others.length === 0) {
      stopping.push(...run.lines);
      continue;
    }
    const before = await Promise.all(others.map((module) => failedBefore(run.args, module)));
    (before.every(Boolean) ? preexisting : stopping).push(...run.lines);
  }
  return { stopping, preexisting };
}

/** The `fix` or `escalate` result of the last round: merge its fix, test it, then start the next round. */
async function afterFix(drive: Drive, last: RoundState): Promise<Stop | null> {
  if (drive.tested !== last.round) {
    if (last.fixInput === null) throw new OgwError(`round ${String(last.round)} of ${drive.target} is ${String(last.result)} with no fix input`);
    const notMerged = await mergedFix(drive, last, last.fixInput);
    if (notMerged !== null) return notMerged;
    if (!(await fixOnlyRecords(drive, last, last.fixInput))) {
      const stop = await fixTestStop(drive, last, await testFix(drive));
      if (stop !== null) return stop;
    }
    drive.tested = last.round;
  }
  return round(drive);
}

async function step(drive: Drive): Promise<Stop | null> {
  const state = await readState(drive.dir, 'core', drive.target);
  const last = state.rounds.at(-1);
  if (last !== undefined && !last.judged) return counted(drive, await slot(drive, () => judge(drive)));
  if (drive.restart || last === undefined) return round(drive);
  // the fix of a `fix` or `escalate` round is merged and tested before the next round, a `--respec` round too
  if (last.result === 'fix' || last.result === 'escalate') return afterFix(drive, last);
  if (opensLast(state, last) || respecsLast(state, last) || reopensLast(state, last) || continuesLimit(state, last, drive.continuing)) return round(drive);
  if (last.result === 'done' || last.result === 'blocked' || last.result === 'limit') return { result: last.result, detail: [] };
  return round(drive);
}

/**
 * Whether the pending option is used up by the unjudged round `last`: the kept option started it, and what the option
 * reviews did not change after it started.
 */
async function usedUp(drive: Drive, state: ReviewState, last: RoundState, respec: boolean): Promise<boolean> {
  const kept = respec ? state.respecAfter : state.reopenAfter;
  const started = kept !== undefined && kept === state.rounds.at(-2)?.round;
  return started && !(await changedSinceRound(drive.ctx, state, last, respec ? '--respec' : '--reopen'));
}

/**
 * Keeps the run's `--respec` or `--reopen` in the review state (`keepRespec`, `keepReopen`) once the last round is
 * judged: a round left unjudged (by a run that was ended) is judged first, and the option follows that judged round.
 * A round left unjudged that the option kept in the state started already follows it: the option is used up, unless
 * what the option reviews changed after that round started (`changedSinceRound`); then it follows that round too.
 * `--reopen` follows a round judged `done` only: after another result it is dropped.
 */
async function keepPending(drive: Drive, afterStep: boolean): Promise<void> {
  const { respec, reopen } = drive.pending;
  if (!respec && !reopen) return;
  const state = await readState(drive.dir, 'core', drive.target);
  const last = state.rounds.at(-1);
  if (last !== undefined && !last.judged) {
    if (await usedUp(drive, state, last, respec)) drive.pending = { respec: false, reopen: false };
    return;
  }
  drive.pending = { respec: false, reopen: false };
  // the step dropped its round 1 as `invalid`: the next round 1 reviews the whole target against the definitions now
  if (last === undefined && afterStep) return;
  if (respec) await keepRespec(drive.ctx, 'core', drive.target);
  // a round the step judged other than `done` goes on with its result: the next round of its chain reviews the changes
  // since it started, so `--reopen`, which goes on only from `done`, is dropped
  if (reopen && !(afterStep && last?.result !== 'done')) await keepReopen(drive.ctx, 'core', drive.target);
}

async function stopOutput(drive: Drive, stop: Stop): Promise<CommandResult> {
  const judgedRounds = (await readState(drive.dir, 'core', drive.target)).rounds.filter((r) => r.judged);
  const last = judgedRounds.at(-1);
  // an `invalid` stop carries its reason lines alone: the findings of an earlier round are not its result
  const judged = last === undefined || stop.result === 'invalid' ? [] : judgedOutput(last).text?.split('\n') ?? [];
  const lines = [
    `result: ${stop.result}`,
    `round: ${String(last?.round ?? 0)}`,
    ...judged.filter((line) => line.startsWith('open finding: ') || line.startsWith('code check fail: ') || line.startsWith('code check fail outside target: ') || line.startsWith('  ')),
    ...stop.detail,
    ...drive.preexisting.map((line) => `pre-existing test fail: ${line}`),
    ...judgedRounds.flatMap((r) => (r.outOfScope ?? []).filter(urgentOutOfScope).map((line) => `out of scope: round ${String(r.round)}: ${line}`)),
    ...judgedRounds.flatMap((r) => (r.gameImpact ?? []).map((line) => `game impact: round ${String(r.round)}: ${line}`)),
    ...judgedRounds.flatMap((r) => (r.debtLines ?? []).map((line) => `round ${String(r.round)}: ${line}`)),
  ];
  return { exitCode: stop.result === 'done' ? 0 : 1, text: lines.join('\n'), data: { result: stop.result, round: last?.round ?? 0, detail: stop.detail } };
}

/** The folder of the slots that every `ogw review run` job of this host shares. */
export async function runSlotsDir(env: NodeJS.ProcessEnv): Promise<string> {
  return join(await jobsDir(env), 'review-run-slots');
}

/**
 * What a run hands to the process of the changed harness code that goes on with it (`RUN_AGAIN`): the counts and lines
 * that live only in the run, not in the review state.
 */
type Carry = Pick<Drive, 'invalid' | 'invalidLines' | 'preexisting' | 'tested'>;

/** The environment variable that hands the `Carry` of a run to the process that goes on with it, as JSON. */
const CARRY_ENV = 'OGW_REVIEW_RUN_CARRY';

/** The `Carry` handed to this process, removed from the environment so that no job it starts inherits it. */
function takeCarry(env: NodeJS.ProcessEnv): Carry {
  const text = env[CARRY_ENV];
  delete env.OGW_REVIEW_RUN_CARRY;
  if (text === undefined) return { invalid: 0, invalidLines: [], preexisting: [], tested: null };
  const carry = JSON.parse(text) as Partial<Carry>;
  const lines = (value: unknown): value is string[] => Array.isArray(value) && value.every((line) => typeof line === 'string');
  if (typeof carry.invalid !== 'number' || !lines(carry.invalidLines) || !lines(carry.preexisting) || (carry.tested !== null && typeof carry.tested !== 'number')) {
    throw new OgwError(`${CARRY_ENV} is not a review run carry: ${text}`);
  }
  return { invalid: carry.invalid, invalidLines: carry.invalidLines, preexisting: carry.preexisting, tested: carry.tested };
}

/** `ogw review run core <target> [--since <commit>|--full|--debt] [--restart|--respec|--continue|--reopen]`. */
export async function reviewRun(ctx: Context, target: string, first: Omit<NextOptions, 'definitions'>): Promise<CommandResult> {
  const dir = await targetDir(ctx, 'core', target);
  const drive: Drive = {
    ctx,
    target,
    dir,
    slots: { dir: await runSlotsDir(ctx.env), count: (await ctx.settings()).reviewRunConcurrency },
    restart: first.restart,
    continuing: first.continue === true,
    pending: { respec: first.respec === true, reopen: first.reopen === true },
    since: first.since,
    opener: first.full === true ? 'full' : first.debt === true ? 'debt' : null,
    ...takeCarry(ctx.env),
  };
  checkContinue(target, (await readState(dir, 'core', target)).rounds.at(-1), first.continue === true);
  const tools = await harnessToolsTree(ctx);
  let entered = false;
  // one run per target: a second one fails at once
  const result = await withLock(`${dir}.run.lock`, async (): Promise<CommandResult | typeof RUN_AGAIN> => {
    entered = true;
    if (drive.opener !== null) {
      await keepOpener(ctx, target, drive.opener);
      drive.opener = null;
    }
    for (;;) {
      await keepPending(drive, false);
      const stop = await step(drive);
      if (stop !== null) return stopOutput(drive, stop);
      // a step ends with the last round judged: the option is kept before the run can go on in another process
      await keepPending(drive, true);
      // the run goes on from the review state, so after a step it can go on in a process of the changed harness code
      if (tools !== null && (await harnessToolsTree(ctx)) !== tools) return RUN_AGAIN;
    }
  }, 0).catch((error: unknown) => {
    if (!entered && error instanceof OgwError && error.message.startsWith('lock busy')) {
      throw new OgwError(`an ogw review run job of ${target} is running`);
    }
    throw error;
  });
  if (result !== RUN_AGAIN) return result;
  ctx.log(`the harness tools changed: ogw review run core ${target} goes on with the new code`);
  const carry: Carry = { invalid: drive.invalid, invalidLines: drive.invalidLines, preexisting: drive.preexisting, tested: drive.tested };
  const env = { ...ctx.env, [CARRY_ENV]: JSON.stringify(carry) };
  const again = await run(process.execPath, [...process.execArgv, cliEntry(), 'review', 'run', 'core', target], { cwd: ctx.cwd, env, timeoutMs: RUN_TIME_LIMIT_MS });
  if (again.stderr.trim() !== '') ctx.log(again.stderr.trimEnd());
  return { exitCode: again.timedOut ? 1 : again.code ?? 1, text: again.stdout.trimEnd() };
}

const RUN_AGAIN = Symbol('run again with the changed harness code');

/** The time limit of a `ogw review run` job: it goes through the rounds of its target and waits for free slots between them, longer than one job. */
export const RUN_TIME_LIMIT_MS = 4 * LIMITS.jobMs;

/** The tree of the harness `tools/` at HEAD, or null when it cannot be read: a job keeps the code it started with. */
async function harnessToolsTree(ctx: Context): Promise<string | null> {
  try {
    return (await git((await ctx.workspace()).harness, ['rev-parse', 'HEAD:tools'], { env: ctx.env })).trim();
  } catch {
    return null;
  }
}
