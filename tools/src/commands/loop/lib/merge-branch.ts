import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, writeFileAtomic } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { branchExists, commitPaths, currentBranch, git, gitRaw, isAncestor, showFile } from '../../../lib/git.ts';
import type { RunState } from '../../../lib/runstate.ts';
import { runData } from '../../data/api.ts';
import { syncResources } from '../../resource/api.ts';
import { formatCsv, parseCsv, type CsvTable } from '../../agent/lib/csv.ts';
import { rowsByKey } from './csv.ts';
import type { HarnessSettings } from '../../../lib/settings.ts';
import { gatePassed, iterationRecords, mainJudges, type ParsedRecord } from './iteration-record.ts';
import { candidateEvidence, confirmEvidence } from './verdict.ts';
import { loopData, type MergeRecord } from './run.ts';

/** The commit `ogw loop prepare-merge` merges, and whether the work `ogw loop sync` merged after it goes with it. */
export interface MergeChoice {
  commit: string;
  withSyncedWork: boolean;
}

/**
 * The merge commit (`game-loop` `## end` 2): the `success` iteration; else the latest confirmation iteration that
 * passed, else the latest candidate iteration, the three without the work synced after them, which no iteration
 * checked; else the latest iteration that passed the gate checks with a step 4 judge `done` and a `vs baseline` of the
 * step 4 judges together that is not `worse`. null when there is none.
 */
export async function chooseMergeCommit(game: GameRepo, run: RunState, loopStop: HarnessSettings['loopStop']): Promise<MergeChoice | null> {
  const records = await iterationRecords(game, run);
  const verdict = loopData(run).verdict;
  if (verdict?.reason === 'success') {
    const commit = records.find((r) => r.iteration === verdict.iteration)?.commit ?? null;
    if (commit !== null) return { commit, withSyncedWork: false };
  }
  const latest = [...records].reverse().filter((r): r is ParsedRecord & { commit: string } => r.commit !== null);
  const checked = latest.find((r) => confirmEvidence(r, loopStop) !== null) ?? latest.find((r) => candidateEvidence(r, loopStop) !== null);
  if (checked) return { commit: checked.commit, withSyncedWork: false };
  const passed = latest.find((r) => mainJudges(r).some((j) => j.status === 'done') && gatePassed(r) && r.vsBaseline !== 'worse');
  return passed ? { commit: passed.commit, withSyncedWork: true } : null;
}

export function mergeBranch(run: RunState): string {
  return `merge/${run.name}`;
}

/**
 * Why `merge/<run>` has nothing to merge: `missing` when the branch does not exist, `empty` when it has no commit
 * beyond the main commit the work branch was made from (a failed `ogw loop prepare-merge` leaves it there).
 * `null` when it has a commit of its own.
 */
export async function mergeBranchGap(game: GameRepo, run: RunState, env?: NodeJS.ProcessEnv): Promise<'missing' | 'empty' | null> {
  const branch = mergeBranch(run);
  if (!(await branchExists(game.root, branch, { env }))) return 'missing';
  if (await isAncestor(game.root, branch, run.baseCommit, { env })) return 'empty';
  return null;
}

/** True when `merge/<run>` has a commit of its own (`mergeBranchGap` is `null`) and is in main. */
export async function mergeBranchMerged(game: GameRepo, run: RunState, env?: NodeJS.ProcessEnv): Promise<boolean> {
  if ((await mergeBranchGap(game, run, env)) !== null) return false;
  return isAncestor(game.root, mergeBranch(run), 'main', { env });
}

/**
 * Makes `merge/<run>` at `from` and checks it out; an unmerged branch of that name is made again.
 * What a failed preparation left in the checkout of `merge/<run>` is thrown away first; ignored files stay.
 */
async function makeBranch(game: GameRepo, run: RunState, from: string): Promise<void> {
  const branch = mergeBranch(run);
  if (await mergeBranchMerged(game, run)) throw new OgwError(`branch ${branch} is already merged into main`);
  if ((await currentBranch(game.root)) === branch) {
    await git(game.root, ['reset', '--hard', '--quiet']);
    await git(game.root, ['clean', '-fd', '--quiet']);
  }
  await git(game.root, ['checkout', '--quiet', '-B', branch, from]);
}

/** Replaces `records/` with the one at the work branch HEAD. */
async function takeRecords(game: GameRepo, run: RunState): Promise<void> {
  await git(game.root, ['rm', '-r', '-q', '--ignore-unmatch', '--', 'records']);
  await git(game.root, ['checkout', run.branch, '--', 'records']);
}

export async function prepareRecordsOnly(game: GameRepo, run: RunState): Promise<void> {
  await makeBranch(game, run, run.baseCommit);
  await takeRecords(game, run);
  await commitPaths(game.root, ['records'], `loop ${run.name}: records`);
}

async function csvAt(game: GameRepo, rev: string, path: string): Promise<CsvTable | null> {
  const bytes = await showFile(game.root, rev, path);
  return bytes === null ? null : parseCsv(bytes.toString('utf8'));
}

function cellOf(csv: CsvTable, row: readonly string[] | undefined, column: string): string | undefined {
  const index = csv.header.indexOf(column);
  return row === undefined || index < 0 ? undefined : row[index];
}

/** Resource keys of the commit and the rows `ogw resource finalize` adds under them. */
function keyIncluded(keys: ReadonlySet<string>, key: string): boolean {
  if (keys.has(key)) return true;
  const sheet = /^sprite_sheet\/(.+)$/.exec(key);
  if (sheet && keys.has(`sprite_animation/${sheet[1] as string}`)) return true;
  const part = /^image\/(.+)\/[^/]+$/.exec(key);
  return part !== null && keys.has(`rig_animation_2d/${part[1] as string}`);
}

function fileKey(path: string, keys: ReadonlySet<string>): boolean {
  if (!path.startsWith('resource/') || path === 'resource/resources.csv') return false;
  const rest = path.slice('resource/'.length);
  for (let dot = rest.indexOf('.'); dot !== -1; dot = rest.indexOf('.', dot + 1)) {
    if (!rest.slice(dot).includes('/') && keyIncluded(keys, rest.slice(0, dot))) return true;
  }
  return false;
}

interface Target {
  game: GameRepo;
  /** Commit whose keys are kept. */
  base: string;
}

async function applyResources(t: Target, merge: MergeRecord, target: CsvTable): Promise<void> {
  const base = await csvAt(t.game, t.base, 'resource/resources.csv');
  const before = await csvAt(t.game, merge.before, 'resource/resources.csv');
  const after = await csvAt(t.game, merge.after, 'resource/resources.csv');
  if (!base || !after) return;
  const keys = new Set(rowsByKey(base, ['key']).keys());
  const beforeRows = before ? rowsByKey(before, ['key']) : new Map<string, string[]>();
  const keyCol = target.header.indexOf('key');
  const afterRows = rowsByKey(after, ['key']);
  for (const [key, row] of afterRows) {
    if (!keyIncluded(keys, key) || beforeRows.get(key)?.join('\u0000') === row.join('\u0000')) continue;
    const next = target.header.map((col) => cellOf(after, row, col) ?? '');
    const at = target.rows.findIndex((r) => r[keyCol] === key);
    if (at === -1) target.rows.push(next);
    else target.rows[at] = next;
  }
  const removed = new Set([...beforeRows.keys()].filter((key) => !afterRows.has(key) && keyIncluded(keys, key)));
  target.rows = target.rows.filter((r) => !removed.has(r[keyCol] ?? ''));
  const changed = await git(t.game.root, ['diff', '--name-status', '--no-renames', merge.before, merge.after, '--', 'resource']);
  for (const line of changed.split('\n').filter((l) => l !== '')) {
    const [status, path] = line.split('\t') as [string, string];
    if (!fileKey(path, keys)) continue;
    if (status === 'D') await rm(join(t.game.root, path), { force: true });
    else await git(t.game.root, ['checkout', merge.after, '--', path]);
  }
}

async function applyCells(t: Target, path: string, keyCols: readonly string[], valueCols: (header: string[]) => string[], merge: MergeRecord): Promise<void> {
  const full = join(t.game.root, path);
  const base = await csvAt(t.game, t.base, path);
  const before = await csvAt(t.game, merge.before, path);
  const after = await csvAt(t.game, merge.after, path);
  if (!base || !after || !exists(full)) return;
  const working = parseCsv(await readFile(full, 'utf8'));
  const keep = rowsByKey(base, keyCols);
  const beforeRows = before ? rowsByKey(before, keyCols) : new Map<string, string[]>();
  const workingRows = rowsByKey(working, keyCols);
  let changed = false;
  for (const [key, row] of rowsByKey(after, keyCols)) {
    const into = workingRows.get(key);
    if (!keep.has(key) || !into) continue;
    for (const col of valueCols(after.header)) {
      const value = cellOf(after, row, col);
      const index = working.header.indexOf(col);
      if (value === undefined || index < 0 || (before !== null && value === cellOf(before, beforeRows.get(key), col))) continue;
      into[index] = value;
      changed = true;
    }
  }
  if (changed) await writeFileAtomic(full, formatCsv(working));
}

async function translationFiles(game: GameRepo, rev: string): Promise<string[]> {
  const out = await git(game.root, ['ls-tree', '--name-only', rev, 'data/translations/']);
  return out.split('\n').filter((p) => p.endsWith('.csv'));
}

/** Adds the resource and translation work `ogw loop sync` merged after `commit`, for keys the commit has. */
async function applyMerges(game: GameRepo, run: RunState, commit: string): Promise<void> {
  const t: Target = { game, base: commit };
  const resources = (await csvAt(game, 'HEAD', 'resource/resources.csv')) ?? { header: [], rows: [], eol: '\n' as const };
  let resourcesChanged = false;
  for (const merge of loopData(run).merges) {
    if (!(await isAncestor(game.root, commit, merge.before))) continue;
    if (merge.role === 'resource') {
      await applyResources(t, merge, resources);
      resourcesChanged = true;
      continue;
    }
    for (const path of await translationFiles(game, merge.after)) {
      await applyCells(t, path, ['key'], () => ['text', 'source_hash'], merge);
    }
    await applyCells(t, 'data/glossary.csv', ['source', 'id_name'], (header) =>
      header.filter((h) => !['source', 'id_name', 'note', 'source_hash'].includes(h)), merge);
  }
  if (resourcesChanged && resources.header.length > 0) {
    await writeFileAtomic(join(game.root, 'resource', 'resources.csv'), formatCsv(resources));
  }
}

/** `merge/<run>` from `commit` with only the run's `records/`: the work synced after the commit does not go with it. */
export async function prepareCommitRecordsOnly(game: GameRepo, run: RunState, commit: string): Promise<void> {
  await makeBranch(game, run, commit);
  await takeRecords(game, run);
  await commitPaths(game.root, ['records'], `loop ${run.name}: merge ${commit.slice(0, 12)} with records`);
}

export async function prepareCommit(ctx: Context, game: GameRepo, run: RunState, commit: string): Promise<void> {
  await makeBranch(game, run, commit);
  await takeRecords(game, run);
  await applyMerges(game, run, commit);
  await syncResources(ctx, game);
  const data = await runData(ctx, game);
  if (data.exitCode !== 0) {
    throw new OgwError(`ogw data failed on ${mergeBranch(run)}:\n${data.lines.map((l) => l.text).join('\n')}${data.stderr}`);
  }
  await gitRaw(game.root, ['add', '--all'], { env: ctx.env });
  await commitPaths(game.root, ['.'], `loop ${run.name}: merge ${commit.slice(0, 12)}`, { env: ctx.env });
}
