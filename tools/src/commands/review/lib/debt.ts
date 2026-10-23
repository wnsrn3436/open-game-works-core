/**
 * The review lists (`core` command.md `## review lists`, ogw.md `## update harness tool`): what reviews found out of
 * their scope, kept per target until a later review of that target confirms it gone. The debt list holds `medium`
 * items, deferred to the next review of the target; the must-fix list holds `critical` and `high` items, fixed now,
 * which block a release.
 */
import { existsSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { formatJson, readJsonIfExists, writeFileAtomic } from '../../../lib/fsx.ts';
import { checkoutLock, commitPaths, currentBranch } from '../../../lib/git.ts';
import { withLock } from '../../../lib/lock.ts';
import { byteCompare } from '../../../lib/order.ts';
import { moduleFolder } from '../../core/lib/impl.ts';
import { withCoreMain } from '../../core/lib/main-checkout.ts';
import { moduleSpecs } from './definitions.ts';
import { targetSlug, type Side } from './input.ts';
import { outOfScopeItem, type OutOfScopeItem } from './review-file.ts';

export type ListKind = 'debt' | 'must fix';

export interface ListItem {
  /** `D<n>` in a debt list, `M<n>` in a must-fix list: n from 1, never given again in the list. */
  id: string;
  /** Must-fix list only: `critical` or `high`. A debt list item is `medium`. */
  severity?: 'critical' | 'high';
  location: string;
  problem: string;
  /** The review that found it: `<target> round <n>`, or `spec <module>` for a spec review. */
  foundBy: string;
}

export interface ReviewList {
  target: string;
  /** The number of the next item. */
  nextId: number;
  items: ListItem[];
}

/** The folder of each kind's lists (checkout relative), its id prefix and its output name. */
const KINDS: Record<ListKind, { dir: string; prefix: string; name: string }> = {
  debt: { dir: 'records/review-debt', prefix: 'D', name: 'review debt' },
  'must fix': { dir: 'records/review-must-fix', prefix: 'M', name: 'review must fix' },
};

/** The lists of a spec review of a module: `spec <module>`. */
export function specDebtTarget(module: string): string {
  return `spec ${module}`;
}

/** The checkout relative path of a target's list of a kind. */
export function listPath(kind: ListKind, target: string): string {
  return `${KINDS[kind].dir}/${targetSlug(target)}.json`;
}

/** The checkout that keeps the lists of a side: `open-game-works-core-impl/` (`core`, spec reviews) or the harness repo. */
export async function debtRepo(ctx: Context, side: Side): Promise<string> {
  const ws = await ctx.workspace();
  return side === 'core' ? ws.coreImpl : ws.harness;
}

function isReviewList(value: unknown): value is ReviewList {
  const list = value as Partial<ReviewList> | null;
  return typeof list?.target === 'string' && Number.isInteger(list.nextId) && Array.isArray(list.items);
}

/** A target's list of a kind; an empty one when the file is not there. */
export async function readList(repo: string, kind: ListKind, target: string): Promise<ReviewList> {
  const path = join(repo, listPath(kind, target));
  const value = await readJsonIfExists(path);
  if (value === null) return { target, nextId: 1, items: [] };
  if (!isReviewList(value)) throw new OgwError(`${path} is not a ${KINDS[kind].name} list`);
  return value;
}

/** Every list of a kind in the checkout, by file name. */
export async function readAllLists(repo: string, kind: ListKind): Promise<ReviewList[]> {
  const dir = join(repo, KINDS[kind].dir);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.json')).sort(byteCompare);
  const lists: ReviewList[] = [];
  for (const name of names) {
    const value = await readJsonIfExists(join(dir, name));
    if (!isReviewList(value)) throw new OgwError(`${join(dir, name)} is not a ${KINDS[kind].name} list`);
    lists.push(value);
  }
  return lists;
}

function itemNumber(item: Pick<ListItem, 'id'>): number {
  return Number(item.id.slice(1));
}

/**
 * The debt items a review round gives as scope (`core` command.md `## review lists`): those in the list when the review
 * began (number below `floor`, the list's `nextId` then).
 */
export function scopeDebt(list: ReviewList, floor: number): ListItem[] {
  return list.items.filter((item) => itemNumber(item) < floor);
}

/** An item as a line of the review input `## debt` or `## must fix`: `<id>: <file:line>: <severity> <problem>`. */
export function itemLine(item: ListItem): string {
  return `${item.id}: ${item.location}: ${item.severity ?? 'medium'} ${item.problem}`;
}

const RANK: Record<OutOfScopeItem['severity'], number> = { medium: 1, high: 2, critical: 3 };

/** What a judged review round changes in the lists. */
export interface ListChange {
  /** Out of scope items, each with the target whose lists it goes to. */
  add: { target: string; line: string }[];
  /** Items of one target the round confirmed gone (`fixed`, `withdrawn`), by kind. */
  remove: { target: string; debt: string[]; mustFix: string[] };
  /** `<target> round <n>`, or `spec <module>`. */
  foundBy: string;
}

type Lists = Map<string, ReviewList>;

function listKey(kind: ListKind, target: string): string {
  return `${kind}\u0000${target}`;
}

function listOf(lists: Lists, kind: ListKind, target: string): ReviewList {
  return lists.get(listKey(kind, target)) as ReviewList;
}

function removeItem(lists: Lists, kind: ListKind, target: string, id: string, changed: Set<string>): boolean {
  const list = listOf(lists, kind, target);
  if (!list.items.some((item) => item.id === id)) return false;
  list.items = list.items.filter((item) => item.id !== id);
  changed.add(listKey(kind, target));
  return true;
}

function pushItem(lists: Lists, kind: ListKind, target: string, item: Omit<ListItem, 'id'>, changed: Set<string>): ListItem {
  const list = listOf(lists, kind, target);
  const added: ListItem = { id: `${KINDS[kind].prefix}${String(list.nextId)}`, ...item };
  list.nextId += 1;
  list.items.push(added);
  changed.add(listKey(kind, target));
  return added;
}

/**
 * Adds one out of scope item: `medium` to the debt list, `critical` and `high` to the must-fix list. A location the
 * target's lists already have is not added again: a must-fix item takes a higher severity, and a debt item whose line is
 * now `critical` or `high` moves to the must-fix list.
 */
function addItem(lists: Lists, target: string, line: string, foundBy: string, changed: Set<string>): string[] {
  const read = outOfScopeItem(line);
  if (read === null) return [];
  const fixing = listOf(lists, 'must fix', target).items.find((item) => item.location === read.location);
  if (fixing !== undefined) {
    if (RANK[read.severity] <= RANK[fixing.severity ?? 'high']) return [];
    fixing.severity = 'critical';
    changed.add(listKey('must fix', target));
    return [`review must fix raised: ${target} ${fixing.id} critical`];
  }
  const deferred = listOf(lists, 'debt', target).items.find((item) => item.location === read.location);
  const found = { location: read.location, problem: read.problem, foundBy };
  if (read.severity === 'medium') {
    if (deferred !== undefined) return [];
    return [`review debt added: ${target} ${itemLine(pushItem(lists, 'debt', target, found, changed))}`];
  }
  const lines: string[] = [];
  if (deferred !== undefined && removeItem(lists, 'debt', target, deferred.id, changed)) lines.push(`review debt removed: ${target} ${deferred.id}`);
  const added = pushItem(lists, 'must fix', target, { severity: read.severity, ...found }, changed);
  lines.push(`review must fix added: ${target} ${itemLine(added)}${deferred === undefined ? '' : ` (was ${deferred.id})`}`);
  return lines;
}

/** Applies a change to the lists in memory. Returns the output lines and the keys of the lists that changed. */
function applyChange(lists: Lists, change: ListChange): { lines: string[]; changed: Set<string> } {
  const lines: string[] = [];
  const changed = new Set<string>();
  const { target } = change.remove;
  for (const [kind, ids] of [['debt', change.remove.debt], ['must fix', change.remove.mustFix]] as const) {
    for (const id of ids) if (removeItem(lists, kind, target, id, changed)) lines.push(`${KINDS[kind].name} removed: ${target} ${id}`);
  }
  for (const add of change.add) lines.push(...addItem(lists, add.target, add.line, change.foundBy, changed));
  return { lines, changed };
}

/** Runs `fn` holding the lock under which the review lists of the checkout change. */
async function withListLock<T>(ctx: Context, side: Side, repo: string, fn: () => Promise<T>): Promise<T> {
  if (side === 'core') {
    // the main checkout of `open-game-works-core-impl/`: merges and generated commits change it one at a time
    return withCoreMain(repo, ctx.env, async () => {
      const branch = await currentBranch(repo, { env: ctx.env });
      if (branch !== 'main') throw new OgwError(`${repo} must have main checked out to write the review lists (now ${branch ?? 'detached HEAD'})`);
      return fn();
    });
  }
  return withLock(await checkoutLock(repo, 'ogw-review-lists.lock', { env: ctx.env }), fn);
}

/**
 * Writes a judged round's change to the lists of the side's checkout and commits the changed lists on its branch
 * (core: main of `open-game-works-core-impl/`). Returns the output lines.
 */
export async function changeLists(ctx: Context, side: Side, change: ListChange): Promise<string[]> {
  if (change.add.length === 0 && change.remove.debt.length === 0 && change.remove.mustFix.length === 0) return [];
  const repo = await debtRepo(ctx, side);
  return withListLock(ctx, side, repo, async () => {
    const lists: Lists = new Map();
    for (const target of new Set([change.remove.target, ...change.add.map((a) => a.target)])) {
      for (const kind of ['debt', 'must fix'] as const) lists.set(listKey(kind, target), await readList(repo, kind, target));
    }
    const { lines, changed } = applyChange(lists, change);
    const paths: string[] = [];
    for (const changedKey of changed) {
      const list = lists.get(changedKey) as ReviewList;
      const path = listPath(changedKey.split('\u0000')[0] as ListKind, list.target);
      paths.push(path);
      await writeFileAtomic(join(repo, path), formatJson(list));
    }
    await commitPaths(repo, paths, `ogw: review lists of ${change.foundBy}`, { env: ctx.env, noVerify: true });
    return lines;
  });
}

/**
 * The checkout relative path of a location's file: an absolute path under `root` made relative, `./` dropped. Null for
 * an absolute path outside `root`.
 */
function relativeFile(location: string, root: string): string | null {
  const file = location.replace(/:\d+$/, '');
  if (!isAbsolute(file)) return file.replace(/^\.\//, '');
  const rel = relative(root, file);
  return rel.startsWith('..') || isAbsolute(rel) ? null : rel;
}

/** The real path of `path`, through its nearest folder that is there: a removed worktree's folder is gone. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPath(parent), basename(path));
  }
}

/**
 * An out of scope line whose location is an absolute path under one of `roots` (the review agent's worktree, the
 * checkout), with that location made relative to it: the worktree goes away, and the lists keep checkout paths.
 */
export function checkoutLine(line: string, roots: readonly string[]): string {
  const location = outOfScopeItem(line)?.location;
  const file = location?.replace(/:\d+$/, '');
  if (location === undefined || file === undefined || !isAbsolute(file)) return line;
  // a path the agent read from its working folder is the real path of the root (`/private/var` for `/var` on macOS)
  for (const root of roots.flatMap((r) => [r, realPath(r)])) {
    const rel = relative(root, file);
    if (!rel.startsWith('..') && !isAbsolute(rel)) return `${rel}${location.slice(file.length)}${line.slice(location.length)}`;
  }
  return line;
}

/**
 * Whether a location of a core review is a file of a game repo (harness settings `paths.games`): an absolute path under
 * that folder, or a path that names no file of the checkout and is under it when read from the workspace root `root`
 * (`games/<game>/...`). A core review does not fix a game: such a problem is a game impact, not a finding or a list item.
 */
export function gameLocation(location: string, games: string, checkout: string, root: string): boolean {
  const file = location.replace(/:\d+$/, '');
  if (file === '') return false;
  const under = (path: string): boolean => {
    const rel = relative(games, path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  };
  if (isAbsolute(file)) return under(file);
  return !existsSync(join(checkout, file)) && under(resolve(root, file));
}

/** Whether a target's must-fix list has an item: `--reopen` then reviews the target to confirm the fix. */
export async function hasMustFix(ctx: Context, side: Side, target: string): Promise<boolean> {
  return (await readList(await debtRepo(ctx, side), 'must fix', target)).items.length > 0;
}

/**
 * The core target whose lists an out of scope item of a core review goes to: the module or tool whose folder holds its
 * file (`server/core/<module>/`, `client/<engine>/core/<module folder>/`, `core-spec/<module>.json`, `tools/<tool>/`),
 * else the reviewed target.
 */
export async function coreDebtTarget(ctx: Context, line: string, target: string): Promise<string> {
  const ws = await ctx.workspace();
  const file = relativeFile(outOfScopeItem(line)?.location ?? '', ws.coreImpl);
  if (file === null) return target;
  const modules = (await moduleSpecs(ws.harness)).map((spec) => spec.module);
  const named = (name: string | undefined): string | null => (name !== undefined && [...modules, 'contract-tool', 'data-tool'].includes(name) ? name : null);
  const server = /^server\/core\/([^/]+)\//.exec(file)?.[1];
  const client = /^client\/[^/]+\/core\/([^/]+)\//.exec(file)?.[1];
  const spec = /^core-spec\/([^/]+)\.json$/.exec(file)?.[1];
  const tool = /^tools\/([^/]+)\//.exec(file)?.[1];
  const fromClient = client === undefined ? undefined : modules.find((module) => moduleFolder(module) === client);
  return named(server) ?? named(fromClient) ?? named(spec) ?? named(tool) ?? target;
}

/** The spec lists an out of scope item of a spec review goes to: the module whose spec file holds it, else the reviewed module's. */
export async function specDebtTargetOf(ctx: Context, line: string, module: string): Promise<string> {
  const harness = (await ctx.workspace()).harness;
  const file = relativeFile(outOfScopeItem(line)?.location ?? '', harness);
  const owner = file === null ? undefined : (await moduleSpecs(harness)).find((spec) => resolve(harness, file) === spec.spec);
  return specDebtTarget(owner?.module ?? module);
}
