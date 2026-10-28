import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { formatJson, readJsonIfExists, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import { runLogPath, type RunLog } from '../../../lib/agentctx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { commonDir, currentBranch, deleteBranch, git, gitRaw, head, revParse, showFile, statusLines, worktreeRemove } from '../../../lib/git.ts';
import { harnessRoot } from '../../../lib/paths.ts';
import type { Role } from '../../../lib/settings.ts';
import { partCovers, runCoreTypeCheck } from '../../code/api.ts';
import { enginesOf } from '../../core/lib/impl.ts';
import { isGeneratedPath, withCoreMain } from '../../core/lib/main-checkout.ts';
import { passedEngines, readTestRecords, sideOf } from '../../core/lib/test-records.ts';
import { harnessToolsTree } from '../../core/lib/test-reuse.ts';
import { TOOLS } from '../../core/lib/tools.ts';
import { runData } from '../../data/api.ts';
import { changeAgentMeta, readAgentJob, type AgentMeta } from './meta.ts';
import { column, parseCsv } from './csv.ts';
import { mergeCsvRows, mergeJson, type JsonMerge } from './jsonmerge.ts';
import { coreSpecDependencies, mergeOrder, topologicalOrder, type MergeCandidate } from './order.ts';
import { mergeGlossary, mergeResources, mergeTranslation, type RowMerge } from './rowmerge.ts';
import { GLOSSARY, RESOURCES, translationPaths, utf8Text } from './translation-files.ts';

export interface MergeFailure {
  id: string;
  /** `conflict`, `data`, or why the job cannot be merged. */
  reason: string;
  detail: string;
}

export interface MergeOptions {
  /**
   * Paths relative to the game repo checkout that go into the merge commit of a game worktree job with the merged
   * files (`ogw loop variants` commits its records with the merge of the chosen variant).
   */
  alsoCommit?: readonly string[];
}

export interface MergeResult {
  merged: string[];
  failed: MergeFailure[];
}

class MergeStop extends Error {
  readonly reason: string;
  readonly detail: string;
  constructor(reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
}

async function untracked(repo: string): Promise<Set<string>> {
  const out = await git(repo, ['ls-files', '--others', '--exclude-standard', '-z']);
  return new Set(out.split('\0').filter((path) => path !== ''));
}

/** Undoes a merge in progress and removes files it left that were not there before. */
async function abortMerge(repo: string, before: ReadonlySet<string>): Promise<void> {
  await gitRaw(repo, ['merge', '--abort']);
  await gitRaw(repo, ['reset', '--hard', '--quiet', 'HEAD']);
  for (const path of await untracked(repo)) if (!before.has(path)) await rm(join(repo, path), { force: true });
}

async function writeMerged(repo: string, path: string, merged: RowMerge): Promise<void> {
  if ('conflict' in merged) throw new MergeStop('conflict', merged.conflict);
  if (merged.text === null) {
    await gitRaw(repo, ['rm', '--quiet', '--force', '--ignore-unmatch', '--', path]);
    return;
  }
  await writeFileAtomic(join(repo, path), merged.text);
  await git(repo, ['add', '--', path]);
}

interface Sides {
  repo: string;
  base: string;
  ours: string;
  theirs: string;
}

type FileBytes = Buffer | null;

async function bytesOf(sides: Sides, path: string): Promise<[FileBytes, FileBytes, FileBytes]> {
  return [await showFile(sides.repo, sides.base, path), await showFile(sides.repo, sides.ours, path), await showFile(sides.repo, sides.theirs, path)];
}

function sameBytes(a: FileBytes, b: FileBytes): boolean {
  return a === null || b === null ? a === b : a.equals(b);
}

/** The UTF-8 text of a side; bytes that are not UTF-8 throw `OgwError`, which `rowMerge` turns into reason `data`. */
function text(bytes: FileBytes): string | null {
  return bytes === null ? null : utf8Text(bytes);
}

/** The sub-agent's text as it is, once it reads as CSV: a branch that did not change the file takes it unmerged. */
function readable(text: string | null): RowMerge {
  // the rows are matched by `key`: a file without it fails like a side the row merge cannot read
  if (text !== null) column(parseCsv(text), 'key');
  return { text };
}

/** A row merge of `path`; a side that is not CSV stops the merge as a `ogw data` failure does (ogw.md `## agent merge`). */
function rowMerge(path: string, merge: () => RowMerge): RowMerge {
  try {
    return merge();
  } catch (error) {
    if (error instanceof OgwError) throw new MergeStop('data', `${path}: ${error.message}`);
    throw error;
  }
}

/** Row-wise merges of `resources.csv`, the translation files and the glossary the sub-agent changed, of the paths `discarded` does not hold. */
async function mergeRows(sides: Sides, discarded: ReadonlySet<string>): Promise<Set<string>> {
  const handled = new Set<string>();
  const [rb, ro, rt] = await bytesOf(sides, RESOURCES);
  if (!sameBytes(rt, rb) && !discarded.has(RESOURCES)) {
    handled.add(RESOURCES);
    await writeMerged(sides.repo, RESOURCES, rowMerge(RESOURCES, () => (sameBytes(ro, rb) ? readable(text(rt)) : mergeResources(text(rb), text(ro), text(rt)))));
  }
  const translations = new Set([...(await translationPaths(sides.repo, sides.ours)), ...(await translationPaths(sides.repo, sides.theirs))]);
  for (const path of translations) {
    const [b, o, t] = await bytesOf(sides, path);
    if (sameBytes(t, b) || discarded.has(path)) continue;
    handled.add(path);
    await writeMerged(sides.repo, path, rowMerge(path, () => mergeTranslation(path, text(b), text(o), text(t))));
  }
  const [gb, go, gt] = await bytesOf(sides, GLOSSARY);
  if (!sameBytes(gt, gb) && !discarded.has(GLOSSARY)) {
    handled.add(GLOSSARY);
    await writeMerged(sides.repo, GLOSSARY, rowMerge(GLOSSARY, () => mergeGlossary(text(gb), text(go), text(gt))));
  }
  return handled;
}

async function unmergedPaths(repo: string): Promise<string[]> {
  const out = await git(repo, ['diff', '--name-only', '--diff-filter=U', '-z']);
  return out.split('\0').filter((path) => path !== '');
}

async function commitMerge(repo: string, before: ReadonlySet<string>, message: string, alsoCommit: readonly string[] = []): Promise<void> {
  await git(repo, ['add', '--update']);
  if (alsoCommit.length > 0) await git(repo, ['add', '--', ...alsoCommit]);
  const added = [...(await untracked(repo))].filter((path) => !before.has(path));
  if (added.length > 0) await git(repo, ['add', '--', ...added]);
  const merging = (await revParse(repo, 'MERGE_HEAD')) !== null;
  const staged = (await gitRaw(repo, ['diff', '--cached', '--quiet'])).code !== 0;
  if (merging || staged) await git(repo, ['commit', '--quiet', '-m', message]);
}

async function gameRepoAt(ctx: Context, name: string, root: string): Promise<GameRepo> {
  const ws = await ctx.workspace();
  return { name, root, mainRoot: join(ws.games, name), commonDir: await commonDir(root, { env: ctx.env }), inWorktree: false };
}

/** The folders (ending in `/`) and files each game worktree role may change besides its result file and run log (ogw.md `## agent merge`). */
const EDIT_SCOPE: Partial<Record<Role, readonly string[]>> = {
  'server-hardening': ['server/'],
  'client-hardening': ['client/'],
  translation: ['data/translations/', 'data/glossary.csv'],
  resource: ['resource/'],
};

/** Roles whose job is not merged when it changed a path outside its edit scope; the others' changes there are discarded. */
const REFUSED_OUTSIDE_SCOPE: readonly Role[] = ['server-hardening', 'client-hardening'];

/** The paths branch `agent/<id>` changed since `baseCommit` outside the edit scope of the job's role. */
async function outsideScope(ctx: Context, checkout: string, baseCommit: string, id: string, meta: AgentMeta): Promise<string[]> {
  const scope = EDIT_SCOPE[meta.role];
  if (scope === undefined) return [];
  const own = meta.outputRel === null ? [] : [meta.outputRel, runLogPath(meta.outputRel)];
  const inScope = (path: string): boolean => own.includes(path) || scope.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));
  // a rename out of the scope is a deletion there and an addition elsewhere
  const changed = await git(checkout, ['diff', '--name-only', '--no-renames', '-z', baseCommit, `agent/${id}`], { env: ctx.env });
  return changed.split('\0').filter((path) => path !== '' && !inScope(path));
}

/** Gives paths of a merge in progress the contents of `ours`, whose merge resolves; a path `ours` lacks is removed. */
async function keepOurs(repo: string, ours: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    if ((await showFile(repo, ours, path)) !== null) await git(repo, ['checkout', ours, '--', path]);
    else await git(repo, ['rm', '--quiet', '--force', '--ignore-unmatch', '--', path]);
  }
}

async function mergeGameWorktree(ctx: Context, id: string, meta: AgentMeta, options: MergeOptions): Promise<void> {
  if (meta.place.kind !== 'game-worktree') return;
  const { checkout, branch, baseCommit } = meta.place;
  if ((await currentBranch(checkout, { env: ctx.env })) !== branch) throw new MergeStop('not on branch', `${checkout} is not on ${branch}`);
  if ((await statusLines(checkout, { env: ctx.env })).some((line) => !line.startsWith('??'))) {
    throw new MergeStop('uncommitted changes', `${checkout} has uncommitted changes`);
  }
  const outside = await outsideScope(ctx, checkout, baseCommit, id, meta);
  if (outside.length > 0 && REFUSED_OUTSIDE_SCOPE.includes(meta.role)) throw new MergeStop('outside scope', outside.join(', '));
  const before = await untracked(checkout);
  const sides: Sides = { repo: checkout, base: baseCommit, ours: await head(checkout, { env: ctx.env }), theirs: `agent/${id}` };
  try {
    const merge = await gitRaw(checkout, ['merge', '--no-commit', '--no-ff', '--no-edit', sides.theirs], { env: ctx.env });
    // git refused to start the merge (for example an untracked file it would overwrite): nothing is merged
    if (merge.code !== 0 && (await revParse(checkout, 'MERGE_HEAD', { env: ctx.env })) === null) {
      throw new MergeStop('conflict', (merge.stderr.trim() || merge.stdout.trim()) || `git merge ended with code ${String(merge.code)}`);
    }
    await keepOurs(checkout, sides.ours, outside);
    const handled = await mergeRows(sides, new Set(outside));
    const left = (await unmergedPaths(checkout)).filter((path) => !handled.has(path));
    if (left.length > 0) throw new MergeStop('conflict', left.join(', '));
    const data = await runData(ctx, await gameRepoAt(ctx, meta.game as string, checkout));
    if (data.exitCode !== 0) {
      const errors = data.lines.filter((line) => line.level === 'ERROR').map((line) => line.text);
      throw new MergeStop('data', (errors.length > 0 ? errors : [data.stderr.trim()]).join('\n'));
    }
    await commitMerge(checkout, before, `ogw agent merge ${id}`, options.alsoCommit);
  } catch (error) {
    await abortMerge(checkout, before);
    throw error;
  }
}

/** Engines whose client core passed, per repo, main HEAD and record count: one computation for the jobs of one merge. */
const passedCache = new Map<string, Promise<Set<string>>>();

async function enginesPassed(repo: string, engines: readonly string[]): Promise<Set<string>> {
  const key = [repo, await revParse(repo, 'main'), (await readTestRecords(repo)).length].join('\0');
  let cached = passedCache.get(key);
  if (cached === undefined) {
    cached = passedEngines(repo, engines);
    passedCache.set(key, cached);
  }
  return cached;
}

/**
 * A core agent branch that changes files outside `records/` needs a passing `ogw core test` as the last one in its
 * run log: the lead agent merges on that record (`core` command.md `## command`), except as ogw.md `## agent merge` says.
 */
async function checkCoreTest(repo: string, id: string, meta: AgentMeta): Promise<void> {
  if (meta.place.kind !== 'core-worktree') return;
  const changed = (await git(repo, ['diff', '--name-only', '-z', `main...agent/${id}`])).split('\0').filter((path) => path !== '');
  if (!changed.some((path) => !path.startsWith('records/'))) return;
  const engines = await enginesOf(repo);
  const passed = await enginesPassed(repo, engines);
  const notPassed = engines.filter((engine) => !passed.has(engine));
  if (await exemptForEngine(repo, id, meta, changed, engines, passed)) return;
  const log = meta.runLog === undefined ? null : ((await readJsonIfExists(meta.runLog).catch(() => null)) as RunLog | null);
  // a run of one test file (`--file`) is not a run of its module
  const runs = (log?.runs ?? []).filter((run) => run.command.startsWith('ogw core test') && !/\s--file(\s|=)/.test(run.command));
  // a tool job while an engine's client core has not passed: `ogw core test tools` leaves that round trip out, `skipped`
  const toolsLeftOut = notPassed.length > 0 && meta.modules.length > 0 && meta.modules.every((module) => (TOOLS as readonly string[]).includes(module));
  const last = (toolsLeftOut ? runs.filter((run) => run.command.startsWith('ogw core test tools')) : runs).at(-1);
  if (last === undefined || !(toolsLeftOut || last.exitCode === 0) || !allPassed(last.summary)) {
    throw new MergeStop('no core test', `the run log has no passing ogw core test as its last one: call the agent again with the same input`);
  }
}

/**
 * Whether the job needs no core test for an engine whose client core never compiled as a whole, whose core tests run in
 * step 6 (`core` command.md): a client module job that changes a file of it, or a job of no module that changes only its
 * files (`create client core` 2: the engine's `engine.json`). An engine is a `client/<engine>/` with an `engine.json` on
 * main (`engines`) or on the branch.
 */
async function exemptForEngine(
  repo: string,
  id: string,
  meta: AgentMeta,
  changed: readonly string[],
  engines: readonly string[],
  passed: ReadonlySet<string>,
): Promise<boolean> {
  const notPassed = new Set(engines.filter((engine) => !passed.has(engine)));
  for (const path of changed) {
    const added = /^client\/([^/]+)\/engine\.json$/.exec(path)?.[1];
    if (added !== undefined && !engines.includes(added) && (await showFile(repo, `agent/${id}`, path)) !== null) notPassed.add(added);
  }
  const ofNotPassed = (path: string): boolean => {
    const engine = /^client\/([^/]+)\//.exec(path)?.[1];
    return engine !== undefined && notPassed.has(engine);
  };
  if (meta.modules.length === 0) return changed.filter((path) => !path.startsWith('records/')).every(ofNotPassed);
  return changed.some(ofNotPassed) && (await clientModulesOnly(repo, id, meta));
}

/** Whether every `--module` of the job is a client module (its `core-spec/` file on the branch, else on main). */
async function clientModulesOnly(repo: string, id: string, meta: AgentMeta): Promise<boolean> {
  if (meta.modules.length === 0) return false;
  for (const module of meta.modules) {
    const bytes = (await showFile(repo, `agent/${id}`, `core-spec/${module}.json`)) ?? (await showFile(repo, 'main', `core-spec/${module}.json`));
    if (sideOf(bytes) !== 'client') return false;
  }
  return true;
}

/** A `ogw core test` run log summary with one test or more, all passed. */
function allPassed(value: unknown): boolean {
  const summary = value as { tests?: unknown; passed?: unknown } | null | undefined;
  return typeof summary?.tests === 'number' && summary.tests > 0 && summary.passed === summary.tests;
}

/** Paths of `open-game-works-core-impl/` outside `records/` that a `git diff` of `range` names. */
async function changedOutsideRecords(repo: string, ...range: string[]): Promise<string[]> {
  return (await git(repo, ['diff', '--name-only', '-z', ...range])).split('\0').filter((path) => path !== '' && !path.startsWith('records/'));
}

/**
 * The type check failure lines of main's commit `commit`, made once per commit and harness `tools/` tree in the harness
 * git common dir. With changes of the harness `tools/` not committed, nothing is kept or used.
 */
async function mainTypeCheck(ctx: Context, repo: string, commit: string): Promise<string[]> {
  const tools = await harnessToolsTree(ctx.env);
  const folder = join(await commonDir(harnessRoot(ctx.env), { env: ctx.env }), 'ogw-cache', 'core-type-check');
  const file = tools === null ? null : join(folder, `${commit}-${tools}.json`);
  const kept = file === null ? null : await readJsonIfExists<{ failures?: unknown }>(file).catch(() => null);
  if (Array.isArray(kept?.failures) && kept.failures.every((line) => typeof line === 'string')) return kept.failures;
  const checked = await runCoreTypeCheck(ctx, commit, repo);
  // a check that stopped with an error (for example an engine not on this host) is not the commit's result
  if (checked.complete && file !== null) {
    await mkdir(folder, { recursive: true });
    await writeJsonAtomic(file, { failures: checked.failures });
  }
  return checked.failures;
}

/**
 * A type check failure line without its line and column: the file, code and message, so that a failure main has does
 * not read as new where the branch moved its line.
 */
export function failureKey(line: string): string {
  return line.replace(/^([^\s:]+):\d+(?::\d+)?(?=\s)/, '$1');
}

/**
 * A core agent branch that changes files outside `records/` merges only when the `ogw code check core` type check of
 * its branch has no failure line that the one of main HEAD lacks (`core` command.md `## command`). Returns main's
 * commit it compared with, or null for a job it does not check.
 */
async function checkTypeCheck(ctx: Context, repo: string, id: string, meta: AgentMeta): Promise<string | null> {
  if (meta.place.kind !== 'core-worktree') return null;
  const main = await revParse(repo, 'main');
  if (main === null) throw new MergeStop('not on branch', `${repo} has no branch main`);
  const changed = (await git(repo, ['diff', '--name-only', '-z', `${main}...agent/${id}`])).split('\0').filter((path) => path !== '');
  if (!changed.some((path) => !path.startsWith('records/'))) return null;
  // the exemption of the core test requirement: an engine whose client core never passed does not compile as a whole
  const engines = await enginesOf(repo);
  if (await exemptForEngine(repo, id, meta, changed, engines, await enginesPassed(repo, engines))) return null;
  const before = new Set((await mainTypeCheck(ctx, repo, main)).map(failureKey));
  // the branch is checked in its worktree: the packages there are the ones its package-lock.json installs
  const branch = await runCoreTypeCheck(ctx, `agent/${id}`, meta.worktree as string);
  // a part that stopped checked none of the branch's files it covers
  const stopped = branch.stops.filter((stop) => changed.some((path) => !path.startsWith('records/') && partCovers(stop.part, path)));
  if (stopped.length > 0) throw new MergeStop('type check', stopped.map((stop) => `${stop.part} part stopped: ${stop.reason}`).join('\n'));
  // the message of a part that stopped is one of its failure lines, which main's kept complete result lacks
  const reasons = new Set(branch.stops.map((stop) => stop.reason));
  const added = branch.failures.filter((line) => !reasons.has(line) && !before.has(failureKey(line)));
  if (added.length > 0) throw new MergeStop('type check', added.join('\n'));
  return main;
}

async function mergeCoreWorktree(ctx: Context, id: string, meta: AgentMeta, checkedMain: string | null): Promise<void> {
  if (meta.place.kind !== 'core-worktree') return;
  const repo = meta.place.coreImpl;
  // main moved past the commit the type check compared with: a change outside records/ may change main's failures
  const main = await revParse(repo, 'main');
  if (checkedMain !== null && main !== null && main !== checkedMain && (await changedOutsideRecords(repo, checkedMain, main)).length > 0) {
    await checkTypeCheck(ctx, repo, id, meta);
  }
  if ((await currentBranch(repo)) !== 'main') throw new MergeStop('not on branch', `${repo} is not on main`);
  if ((await statusLines(repo)).some((line) => !line.startsWith('??'))) throw new MergeStop('uncommitted changes', `${repo} has uncommitted changes`);
  const result = await gitRaw(repo, ['merge', '--no-ff', '--no-edit', '-m', `ogw agent merge ${id}`, `agent/${id}`]);
  if (result.code !== 0) {
    const why = await mergeCoreSettings(repo);
    if (why === null) {
      await git(repo, ['commit', '--no-edit', '--no-verify']);
      return;
    }
    await gitRaw(repo, ['merge', '--abort']);
    throw new MergeStop('conflict', why === '' ? (result.stdout + result.stderr).trim() : why);
  }
}

/** The files of `open-game-works-core-impl/` that every module adds its core settings keys to (ogw.md `## agent merge`). */
const CORE_SETTINGS_FILES: readonly string[] = ['settings/core-settings.json', 'settings/core-settings.schema.json'];

/** Core test data CSV files, which every module adds its rows to. */
function isCoreTestDataCsv(path: string): boolean {
  return path.startsWith('test-data/data/') && path.endsWith('.csv');
}

/**
 * Resolves a core merge whose conflicts are all in the files modules add to: the core settings files key by key, core test
 * data CSV files row by row, and generated files as main has them, which the next `ogw core test` on main makes again.
 * Returns null when it resolved them and staged the files, `''` when another file conflicts, or why one cannot merge.
 */
async function mergeCoreSettings(repo: string): Promise<string | null> {
  const left = await unmergedPaths(repo);
  const own = (path: string): boolean => CORE_SETTINGS_FILES.includes(path) || isCoreTestDataCsv(path);
  // a file under `test-data/data/` that is not CSV is hand-written core test data, not a generated file
  const generated = (path: string): boolean => isGeneratedPath(path) && !path.startsWith('test-data/data/');
  if (left.length === 0 || !left.every((path) => own(path) || generated(path))) return '';
  for (const path of left.filter((p) => !own(p))) {
    // main's side of the merge into main; a file main deleted stays deleted
    if ((await gitRaw(repo, ['checkout', '--ours', '--', path])).code === 0) await git(repo, ['add', '--', path]);
    else await git(repo, ['rm', '--quiet', '--', path]);
  }
  for (const path of left.filter(own)) {
    const stage = async (n: number): Promise<string> => {
      const shown = await gitRaw(repo, ['show', `:${String(n)}:${path}`]);
      return shown.code === 0 ? shown.stdout : '';
    };
    const [base, ours, theirs] = [await stage(1), await stage(2), await stage(3)];
    const text = isCoreTestDataCsv(path) ? csvMerged(path, base, ours, theirs) : jsonMerged(path, base, ours, theirs);
    if (!('text' in text)) return text.conflict;
    await writeFileAtomic(join(repo, path), text.text);
    await git(repo, ['add', '--', path]);
  }
  return null;
}

function csvMerged(path: string, base: string, ours: string, theirs: string): { text: string } | { conflict: string } {
  try {
    // a data table has a 4-row header (`data` SKILL.md `## CSV format`); translations, glossary and the other files have one
    const merged = mergeCsvRows(base, ours, theirs, /^test-data\/data\/(tables|system)\//.test(path) ? 4 : 1);
    return 'conflict' in merged ? { conflict: `${path}: ${merged.conflict}` } : merged;
  } catch {
    return { conflict: `${path} is not CSV on a side` };
  }
}

function jsonMerged(path: string, base: string, ours: string, theirs: string): { text: string } | { conflict: string } {
  let merged: JsonMerge;
  try {
    const parse = (text: string): unknown => (text === '' ? undefined : JSON.parse(text));
    merged = mergeJson(parse(base), parse(ours), parse(theirs), { schema: path.endsWith('.schema.json') });
  } catch {
    return { conflict: `${path} is not JSON on a side` };
  }
  return 'conflict' in merged ? { conflict: `${path}: both sides changed ${merged.conflict}` } : { text: formatJson(merged.value) };
}

function checkMergeable(meta: AgentMeta, status: string): void {
  if (status === 'running') throw new MergeStop('running', 'the agent is running');
  if (meta.merged) throw new MergeStop('already merged', 'the job was merged before');
  if (meta.worktree === null || meta.branch === null) throw new MergeStop('no worktree', 'the job has no worktree to merge');
}

async function mergeOne(ctx: Context, id: string, options: MergeOptions): Promise<void> {
  const { job, meta } = await readAgentJob(id, ctx.env);
  checkMergeable(meta, job.status);
  const repo = meta.place.kind === 'game-worktree' ? meta.place.checkout : meta.place.kind === 'core-worktree' ? meta.place.coreImpl : null;
  if (repo === null) throw new MergeStop('no worktree', 'the job has no worktree to merge');
  if (meta.place.kind === 'game-worktree') await mergeGameWorktree(ctx, id, meta, options);
  else if (meta.place.kind === 'core-worktree') {
    // one change of the main checkout at a time, and none under the module tests of a core test run (ogw.md `## agent merge`)
    // a review job adds only its review file under records/, which no module test reads
    // the checks run before the lock: a type check takes long, and the checkout waits for no change meanwhile
    await checkCoreTest(meta.place.coreImpl, id, meta);
    const checkedMain = await checkTypeCheck(ctx, meta.place.coreImpl, id, meta);
    await withCoreMain(meta.place.coreImpl, ctx.env, () => mergeCoreWorktree(ctx, id, meta, checkedMain), { readers: meta.role === 'core' });
  }
  // the merge commit is on the branch: the result file is found there before the worktree goes (`resultFile`)
  await changeAgentMeta(id, ctx.env, (m) => {
    m.mergeCommitted = true;
  });
  await worktreeRemove(repo, meta.worktree as string, { env: ctx.env });
  await rm(meta.worktree as string, { recursive: true, force: true });
  await deleteBranch(repo, meta.branch as string, { env: ctx.env });
  await changeAgentMeta(id, ctx.env, (m) => {
    m.merged = true;
    m.worktree = null;
  });
}

interface Candidate extends MergeCandidate {
  /** The commit a core agent job's worktree was made from; null for other jobs. */
  baseCommit: string | null;
}

async function candidates(ctx: Context, ids: readonly string[]): Promise<Candidate[]> {
  const list: Candidate[] = [];
  for (const id of ids) {
    const meta = await readAgentJob(id, ctx.env).then((r) => r.meta).catch(() => null);
    const core = meta?.role === 'core' && meta.place.kind === 'core-worktree' ? meta.place : null;
    list.push({ id, modules: meta?.role === 'core' ? meta.modules : [], baseCommit: core?.baseCommit ?? null });
  }
  return list;
}

/**
 * Module dependencies for the merge order: `core-spec/` at main of `open-game-works-core-impl/`, with the files each
 * candidate's branch `agent/<id>` has added or changed since its worktree's commit on top, so a module that a core
 * agent adds can be ordered and a branch's unchanged copy of a file does not undo another branch's change.
 */
async function mergeDependencies(ctx: Context, coreImpl: string, main: string, list: readonly Candidate[]): Promise<Map<string, string[]>> {
  // a file of main that cannot be read leaves its module out of the order: its jobs are reported, others merge
  const dependencies = await coreSpecDependencies(coreImpl, main, { skipInvalid: true });
  for (const candidate of list) {
    if (candidate.modules.length === 0 || candidate.baseCommit === null) continue;
    const branch = await revParse(coreImpl, `agent/${candidate.id}`, { env: ctx.env });
    if (branch === null) continue;
    const diff = await gitRaw(coreImpl, ['diff', '--name-only', '-z', '--diff-filter=d', candidate.baseCommit, branch, '--', 'core-spec/'], { env: ctx.env });
    // a branch whose core-spec/ cannot be read adds nothing; its job is then reported as not ordered
    if (diff.code !== 0) continue;
    const paths = diff.stdout.split('\0').filter((path) => path !== '');
    const added = await coreSpecDependencies(coreImpl, branch, { paths }).catch(() => new Map<string, string[]>());
    for (const [name, deps] of added) dependencies.set(name, deps);
  }
  return dependencies;
}

/** The order `ogw agent merge` merges the ids in, and the ids it cannot order. */
export async function orderIds(ctx: Context, ids: readonly string[]): Promise<{ ids: string[]; unordered: { id: string; module: string }[] }> {
  const list = await candidates(ctx, ids);
  if (!list.some((c) => c.modules.length > 0)) return { ids: [...ids], unordered: [] };
  const coreImpl = (await ctx.workspace()).coreImpl;
  const main = await revParse(coreImpl, 'main', { env: ctx.env });
  if (main === null) throw new OgwError(`${coreImpl} has no branch main`);
  return mergeOrder(list, topologicalOrder(await mergeDependencies(ctx, coreImpl, main, list)));
}

/** `ogw agent merge <id>...`. */
export async function mergeAgents(ctx: Context, ids: readonly string[], options: MergeOptions = {}): Promise<MergeResult> {
  const order = await orderIds(ctx, ids);
  const result: MergeResult = {
    merged: [],
    failed: order.unordered.map(({ id, module }) => ({ id, reason: 'not defined', detail: `merge order of module ${module}, which is in no core-spec/ of main or of the branch or is on a dependency cycle` })),
  };
  for (const id of order.ids) {
    try {
      await mergeOne(ctx, id, options);
      result.merged.push(id);
    } catch (error) {
      if (error instanceof MergeStop) result.failed.push({ id, reason: error.reason, detail: error.detail });
      else if (error instanceof OgwError) result.failed.push({ id, reason: 'error', detail: error.message });
      else throw error;
    }
  }
  return result;
}
