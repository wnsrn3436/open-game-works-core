import { join } from 'node:path';
import type { CommandResult, Context } from '../../../lib/command.ts';
import { OgwError, EXIT_STILL_RUNNING } from '../../../lib/errors.ts';
import { exists, readText, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import { gitRaw } from '../../../lib/git.ts';
import { waitJob, type WaitResult } from '../../../lib/jobs.ts';
import { mergeAgents } from '../../agent/lib/merge.ts';
import { mergedOutput, readAgentJob } from '../../agent/lib/meta.ts';
import { coreEngines } from '../../code/lib/target.ts';
import { moduleFolder } from '../../core/lib/impl.ts';
import type { Side } from './input.ts';
import { changeLists, checkoutLine, coreDebtTarget, gameLocation, type ListChange } from './debt.ts';
import { debtMismatch, outOfScopeItem, parseReviewFile, roundOfId, urgentOutOfScope, type ParseOptions, type ReviewFile } from './review-file.ts';
import {
  lastFixCheck,
  readState,
  removeToolReviewFiles,
  reviewRepo,
  targetDir,
  withTarget,
  writeState,
  type CheckItemState,
  type FixCheckState,
  type OpenFinding,
  type ReviewResult,
  type ReviewState,
  type RoundState,
} from './state.ts';

/** Check items from the `--json` output of the code check job. */
export function codeCheckItems(waited: WaitResult): CheckItemState[] {
  let data: unknown;
  try {
    data = JSON.parse(waited.stdout);
  } catch (error) {
    // not JSON: the command failed before it checked
    if (!(error instanceof SyntaxError)) throw error;
  }
  const checks = typeof data === 'object' && data !== null ? (data as { checks?: unknown }).checks : undefined;
  if (Array.isArray(checks)) return checks as CheckItemState[];
  return [{ name: 'code check', result: 'fail', failures: [(waited.stderr || waited.stdout).trim() || `exit code ${String(waited.job.exitCode)}`] }];
}

/** A folder of a core target's code (`targetFolders`), checkout relative with a trailing `/`. */
export interface TargetFolder {
  path: string;
  /** Whether the folder is in the commit the code check read: only then does the target have files under it. */
  present: boolean;
}

/**
 * The folders of a core target's code at `commit`: `server/core/<module>/`, `client/<engine>/core/<module folder>/` of
 * each engine, `tools/<tool>/`. Null for a harness tool target, which has no code outside it.
 */
export async function targetFolders(ctx: Context, side: Side, target: string, commit: string): Promise<TargetFolder[] | null> {
  if (side === 'tool') return null;
  const repo = await reviewRepo(ctx, side);
  const engines = await coreEngines(repo);
  const paths = [`server/core/${target}/`, ...engines.map((engine) => `client/${engine}/core/${moduleFolder(target)}/`), `tools/${target}/`];
  return Promise.all(paths.map(async (path) => ({
    path,
    present: (await gitRaw(repo, ['cat-file', '-e', `${commit}:${path.slice(0, -1)}`], { env: ctx.env })).code === 0,
  })));
}

/** The checks whose failures in files outside the target do not count (`core` command.md `## review and code check`). */
const TARGET_ONLY_CHECKS: readonly string[] = ['type check', 'lint'];

/** The check of the code check that proves a fix's tests on the code before it (ogw.md `## review run`). */
const PROOF = 'fix test proof';

/** The file a failure line names first (`<file>:<line>[:<column>] ...`), or null when it names none. */
export function failureFile(line: string): string | null {
  return /^([^\s:]+):\d+(?::\d+)?\s/.exec(line)?.[1] ?? null;
}

/**
 * The type check and lint failure lines of the code check in files outside `folders` (`targetFolders`), which do not
 * count as a code check `fail` for the result. A line that names no file counts, and so does one that names a folder
 * holding a target folder the target has files under (`client/godot:1 godot --import failed` for a client module):
 * that failure covers the target's files too. For a target with no files under that folder the line is outside it.
 */
export function outsideTargetFailures(items: readonly CheckItemState[], folders: readonly TargetFolder[] | null): string[] {
  if (folders === null) return [];
  const inTarget = (file: string): boolean => {
    const asFolder = file.endsWith('/') ? file : `${file}/`;
    return folders.some((folder) => file.startsWith(folder.path) || (folder.present && folder.path.startsWith(asFolder)));
  };
  return items
    .filter((item) => item.result === 'fail' && TARGET_ONLY_CHECKS.includes(item.name))
    .flatMap((item) => item.failures.filter((line) => {
      const file = failureFile(line);
      return file !== null && !inTarget(file);
    }));
}

/** What of a code check does not count for the result: the failure lines outside the target, and a proof failed before. */
interface NotCounted {
  outside: ReadonlySet<string>;
  /** The `fix test proof` `fail` does not count (`proofFailedBefore`). */
  proof: boolean;
}

/** The failure lines of an item that count, without those outside the target (`outsideTargetFailures`). */
function countedFailures(item: CheckItemState, outside: ReadonlySet<string>): string[] {
  return TARGET_ONLY_CHECKS.includes(item.name) ? item.failures.filter((line) => !outside.has(line)) : item.failures;
}

/** Whether a code check item is a `fail` that counts for the result: a `fail` with a failure line that counts, or none. */
function countsAsFail(item: CheckItemState, not: NotCounted): boolean {
  if (item.name === PROOF && not.proof) return false;
  return item.result === 'fail' && (item.failures.length === 0 || countedFailures(item, not.outside).length > 0);
}

/** The code check items without what does not count (`NotCounted`): an item failed only by it is a `pass`. */
function countedItems(items: readonly CheckItemState[], not: NotCounted): CheckItemState[] {
  return items.map((item) => {
    const failures = countedFailures(item, not.outside);
    return { ...item, failures, result: item.result === 'fail' && !countsAsFail(item, not) ? 'pass' : item.result };
  });
}

/**
 * Whether the code check passes for the result: no item is a `fail` that counts. The job ends with exit code 1 when an
 * item fails, so a run whose only failures do not count passes; another exit code that is not 0 does not.
 */
function codeCheckPasses(check: WaitResult, items: readonly CheckItemState[], not: NotCounted): boolean {
  const ended = check.job.exitCode === 0 || items.some((c) => c.result === 'fail');
  return ended && items.every((c) => !countsAsFail(c, not));
}

/** Whether a code check output has a `fix test proof` `fail`. */
export function proofFailed(items: readonly CheckItemState[]): boolean {
  return items.some((c) => c.name === PROOF && c.result === 'fail');
}

/**
 * Whether a judged code check of the target (of a round or a fix check) with the `--fix-base` `base` had a
 * `fix test proof` `fail`: a `fail` of a later proof on that base does not count (ogw.md `## review run`), since no
 * test fails on a base whose code already behaved.
 */
export function proofFailedBefore(state: ReviewState, base: string | null | undefined): boolean {
  if (typeof base !== 'string') return false;
  return state.rounds.some((r) => (r.judged && r.fixBase === base && proofFailed(r.codeCheck))
    || (r.fixChecks ?? []).some((c) => c.judged && c.fixBase === base && proofFailed(c.codeCheck)));
}

/** The review file the review agent job wrote: where it is after `ogw agent merge` (core), or its temp file (tool). */
async function reviewFilePath(ctx: Context, round: RoundState): Promise<string | null> {
  return mergedOutput((await readAgentJob(round.reviewJob, ctx.env)).meta);
}

async function readReview(path: string | null, options: ParseOptions = {}): Promise<ReviewFile | null> {
  if (path === null || !exists(path)) return null;
  return parseReviewFile(await readText(path), options);
}

/**
 * `open` findings: every `## findings` row and the `## previous` rows still `open`, as first written. A `spec change`
 * `yes` finding still `open` after a `--respec` round started later is `no`: its definition changed, and what is left
 * is code.
 */
async function openFindings(state: ReviewState, file: ReviewFile): Promise<OpenFinding[]> {
  const open: OpenFinding[] = file.findings.map((f) => ({ id: f.id, aspect: f.aspect, severity: f.severity, location: f.location, specChange: f.specChange }));
  for (const previous of file.previous.filter((p) => p.result === 'open')) {
    const round = roundOfId(previous.id);
    const earlier = state.rounds.find((r) => r.round === round);
    const first = (await readReview(earlier?.reviewFile ?? null, { earlier: true }))?.findings.find((f) => f.id === previous.id);
    const respecced = state.rounds.some((r) => r.round > round && r.specChanges !== undefined);
    open.push(first
      ? { id: first.id, aspect: first.aspect, severity: first.severity, location: first.location, specChange: first.specChange === 'yes' && respecced ? 'no' : first.specChange }
      : { id: previous.id, aspect: 'unknown', severity: 'unknown', location: 'unknown', specChange: 'unknown' });
  }
  return open;
}

/**
 * The result of a judged round (core command.md `## review and code check`): `done` with no `open` finding and a code
 * check that passes, `blocked` when only findings with `spec change` `yes` are left and the code check passes, else
 * `fix`.
 */
export function decide(open: readonly OpenFinding[], codeCheckPass: boolean): ReviewResult {
  if (open.length === 0 && codeCheckPass) return 'done';
  if (open.every((f) => f.specChange === 'yes') && codeCheckPass) return 'blocked';
  return 'fix';
}

/** An `open` finding line of the output and the fix input, with its counted `spec change` (`openFindings`). */
function openFindingLine(f: OpenFinding): string {
  return `open finding: ${f.id} ${f.aspect} ${f.severity} ${f.location} spec change: ${f.specChange}`;
}

function fixInputText(target: string, reviewFile: string, codeCheckFile: string, open: readonly OpenFinding[]): string {
  return ['command: review fix', `- target: ${target}`, `- review file: ${reviewFile}`, `- code check result: ${codeCheckFile}`, ...open.map((f) => `- ${openFindingLine(f)}`), ''].join('\n');
}

/** The `code check fail` lines of a code check, its `fix test proof` `fail` that does not count, and its failures outside the target. */
function codeCheckLines(items: readonly CheckItemState[], outsideTarget: readonly string[], proofNotCounted: boolean, fixBase: string | null | undefined): string[] {
  const not: NotCounted = { outside: new Set(outsideTarget), proof: proofNotCounted };
  const lines: string[] = [];
  for (const item of items.filter((c) => countsAsFail(c, not))) {
    lines.push(`code check fail: ${item.name}`, ...countedFailures(item, not.outside).map((failure) => `  ${failure}`));
  }
  if (proofNotCounted && proofFailed(items)) {
    lines.push(`fix test proof fail not counted: the proof on --fix-base ${String(fixBase)} failed in an earlier code check`);
    lines.push(...items.filter((c) => c.name === PROOF).flatMap((c) => c.failures.map((failure) => `  ${failure}`)));
  }
  for (const line of outsideTarget) lines.push(`code check fail outside target: ${line}`);
  return lines;
}

/** The output of a judged fix check: `fixed`, or `check fail`, with the findings left to the human (`spec change` `yes`). */
function fixCheckOutput(round: RoundState, check: FixCheckState): CommandResult {
  const result = check.result === 'pass' ? 'fixed' : 'check fail';
  const open = round.open.filter((f) => f.specChange === 'yes');
  const lines = [`result: ${result}`, `round: ${String(round.round)}`, ...open.map(openFindingLine), ...codeCheckLines(check.codeCheck, check.outsideTarget, check.proofNotCounted, check.fixBase)];
  return { text: lines.join('\n'), data: { result, round: round.round, open, codeCheck: check.codeCheck, outsideTarget: check.outsideTarget, fixCheckJob: check.job } };
}

/** The output of a judged round, or of its judged last fix check. */
export function judgedOutput(round: RoundState): CommandResult {
  const check = lastFixCheck(round);
  if (check?.judged === true) return fixCheckOutput(round, check);
  const lines = [`result: ${String(round.result)}`, `round: ${String(round.round)}`];
  for (const f of round.open) lines.push(openFindingLine(f));
  lines.push(...codeCheckLines(round.codeCheck, round.outsideTarget ?? [], round.proofNotCounted === true, round.fixBase));
  for (const line of (round.outOfScope ?? []).filter(urgentOutOfScope)) lines.push(`out of scope: ${line}`);
  for (const line of round.gameImpact ?? []) lines.push(`game impact: ${line}`);
  lines.push(...(round.debtLines ?? []));
  if (round.fixInput !== null) lines.push(`fix input: ${round.fixInput}`);
  return { text: lines.join('\n'), data: { result: round.result, round: round.round, open: round.open, codeCheck: round.codeCheck, outsideTarget: round.outsideTarget ?? [], fixInput: round.fixInput } };
}

/**
 * What a judged round changes in the review lists (`core` command.md `## review lists`): each out of scope item goes to the
 * list of the module or tool whose folder holds it (core) or of the target (tool), and the target's items the round
 * found `fixed` or `withdrawn` leave its list.
 */
async function debtChange(ctx: Context, state: ReviewState, round: RoundState, file: ReviewFile): Promise<ListChange> {
  const add = await Promise.all(file.outOfScope.map(async (line) => ({ line, target: state.side === 'core' ? await coreDebtTarget(ctx, line, state.target) : state.target })));
  const gone = (rows: ReviewFile['debt']): string[] => rows.filter((row) => row.result !== 'open').map((row) => row.id);
  return { add, remove: { target: state.target, debt: gone(file.debt), mustFix: gone(file.mustFix) }, foundBy: `${state.target} round ${String(round.round)}` };
}

/**
 * The round's review file when `readable` (its job ended `done` and merged) and in the review file form, with `low`
 * findings only in a round of the whole target and `## debt` and `## must fix` rows answering the round's items; else
 * null, with the line telling the mismatch.
 */
async function roundReview(path: string | null, round: RoundState, readable: boolean): Promise<{ file: ReviewFile | null; invalid: string[] }> {
  const read = readable ? await readReview(path, { low: round.whole === true }) : null;
  const mismatch = read === null ? null : debtMismatch(read, { debt: round.debt ?? [], mustFix: round.mustFix ?? [] });
  return mismatch === null ? { file: read, invalid: [] } : { file: null, invalid: [`review file lists: ${mismatch}`] };
}

async function judge(ctx: Context, dir: string, state: ReviewState, round: RoundState, waited: { review: WaitResult; check: WaitResult }): Promise<CommandResult> {
  const side = state.side;
  const merge = side === 'core' && waited.review.job.status === 'done' ? await mergeAgents(ctx, [round.reviewJob]) : null;
  const notMerged = merge?.failed.map((f) => `review job not merged: ${f.reason}: ${f.detail}`) ?? [];
  const codeCheck = codeCheckItems(waited.check);
  const outsideTarget = outsideTargetFailures(codeCheck, await targetFolders(ctx, side, state.target, round.startCommit));
  const not: NotCounted = { outside: new Set(outsideTarget), proof: proofFailedBefore(state, round.fixBase) };
  const codeCheckFile = join(dir, `round-${String(round.round)}-code-check.json`);
  // the core agent's fix input gives this file: only the failures that count
  await writeJsonAtomic(codeCheckFile, { checks: countedItems(codeCheck, not) });
  const reviewFile = await reviewFilePath(ctx, round);
  // a review job that was not merged left no review file of this round on main: an older file of the same name may be there
  const { file, invalid } = await roundReview(reviewFile, round, waited.review.job.status === 'done' && notMerged.length === 0);
  if (file === null) {
    if (side === 'tool') await removeToolReviewFiles(ctx, [round]);
    state.rounds = state.rounds.filter((r) => r.round !== round.round);
    await writeState(dir, state);
    return {
      exitCode: 1,
      text: [`result: invalid`, `round: ${String(round.round)}`, ...notMerged, ...invalid].join('\n'),
      data: { result: 'invalid', round: round.round, reviewFile, notMerged },
    };
  }
  // a location in the review agent's worktree is kept as a checkout path
  const roots = [(await readAgentJob(round.reviewJob, ctx.env)).meta.folder, await reviewRepo(ctx, side)].filter((root): root is string => typeof root === 'string');
  file.outOfScope = file.outOfScope.map((line) => checkoutLine(line, roots));
  // a core review does not fix a game: a problem in a game file is reported, and neither listed nor counted
  const ws = await ctx.workspace();
  const repo = await reviewRepo(ctx, side);
  const inGame = (location: string): boolean => side === 'core' && gameLocation(location, ws.games, repo, ws.root);
  const gameImpact = [
    ...file.findings.filter((f) => inGame(f.location)).map((f) => `${f.location}: ${f.severity} ${f.id} ${f.evidence}`),
    ...file.outOfScope.filter((line) => inGame(outOfScopeItem(line)?.location ?? '')),
  ];
  file.findings = file.findings.filter((f) => !inGame(f.location));
  file.outOfScope = file.outOfScope.filter((line) => !inGame(outOfScopeItem(line)?.location ?? ''));
  round.debtLines = await changeLists(ctx, side, await debtChange(ctx, state, round, file));
  round.reviewFile = reviewFile;
  round.codeCheck = codeCheck;
  round.codeCheckFile = codeCheckFile;
  round.open = (await openFindings(state, file)).filter((f) => !inGame(f.location));
  round.outOfScope = file.outOfScope;
  round.gameImpact = gameImpact;
  round.outsideTarget = outsideTarget;
  round.proofNotCounted = not.proof;
  round.result = decide(round.open, codeCheckPasses(waited.check, codeCheck, not));
  if (side === 'core' && round.result === 'fix' && reviewFile !== null) {
    round.fixInput = join(dir, `round-${String(round.round)}-fix.md`);
    await writeFileAtomic(round.fixInput, fixInputText(state.target, reviewFile, codeCheckFile, round.open));
  }
  round.judged = true;
  // a round judged other than `invalid` used the `--respec`, `--full` or `--debt` it was started with
  delete state.respecAfter;
  delete state.full;
  delete state.debtReview;
  await writeState(dir, state);
  return judgedOutput(round);
}

/** Judges the last fix check of a `fix` round: the round is `fixed` when it has no `fail` that counts. */
async function judgeFixCheck(ctx: Context, dir: string, state: ReviewState, round: RoundState, check: FixCheckState, waited: WaitResult): Promise<CommandResult> {
  const items = codeCheckItems(waited);
  check.outsideTarget = outsideTargetFailures(items, await targetFolders(ctx, state.side, state.target, check.commit));
  check.proofNotCounted = proofFailedBefore(state, check.fixBase);
  check.codeCheck = items;
  check.result = codeCheckPasses(waited, items, { outside: new Set(check.outsideTarget), proof: check.proofNotCounted }) ? 'pass' : 'fail';
  check.judged = true;
  if (check.result === 'pass') round.result = 'fixed';
  await writeState(dir, state);
  return judgedOutput(round);
}

const RUNNING: CommandResult = { exitCode: EXIT_STILL_RUNNING, text: 'running', data: { result: 'running' } };

/** Waits for the last fix check of round `roundNo` and judges it. */
async function waitFixCheck(ctx: Context, dir: string, side: Side, target: string, roundNo: number, job: string, timeoutMs: number): Promise<CommandResult> {
  const waited = await waitJob(job, timeoutMs, ctx.env);
  if (!waited.finished) return RUNNING;
  return withTarget(dir, async () => {
    const state = await readState(dir, side, target);
    const round = state.rounds.at(-1);
    const check = round === undefined ? undefined : lastFixCheck(round);
    if (round?.round !== roundNo || check?.job !== job) throw new OgwError(`review state of ${target} changed while waiting`);
    if (check.judged) return judgedOutput(round);
    return judgeFixCheck(ctx, dir, state, round, check, waited);
  });
}

/** `ogw review wait <core|tool> <target>`: judges the last round, or its last fix check. */
export async function reviewWait(ctx: Context, side: Side, target: string, timeoutMs: number): Promise<CommandResult> {
  const dir = await targetDir(ctx, side, target);
  const first = (await readState(dir, side, target)).rounds.at(-1);
  if (!first) throw new OgwError(`no review round of ${target}: run ogw review next first`);
  const fixCheck = lastFixCheck(first);
  if (first.judged && fixCheck?.judged === false) return waitFixCheck(ctx, dir, side, target, first.round, fixCheck.job, timeoutMs);
  if (first.judged) return judgedOutput(first);
  const deadline = Date.now() + timeoutMs;
  const review = await waitJob(first.reviewJob, timeoutMs, ctx.env);
  const check = review.finished ? await waitJob(first.codeCheckJob, Math.max(0, deadline - Date.now()), ctx.env) : null;
  if (!check?.finished) return RUNNING;
  return withTarget(dir, async () => {
    const state = await readState(dir, side, target);
    const round = state.rounds.at(-1);
    if (round?.round !== first.round) throw new OgwError(`review state of ${target} changed while waiting`);
    if (round.judged) return judgedOutput(round);
    return judge(ctx, dir, state, round, { review, check });
  });
}
