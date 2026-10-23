import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { exists } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { git, gitRaw, revParse, worktreeAdd, worktreeRemove } from '../../../lib/git.ts';
import { newId } from '../../../lib/ids.ts';
import { runContract, type ContractRun } from '../../contract/api.ts';
import { runData } from '../../data/api.ts';
import { runGenerate } from '../../generate/api.ts';
import { walk } from './core-diff.ts';
import { absence, at, finding, folderOf, type Finding, type StaticContext } from './lib/context.ts';

/**
 * generated diff: HEAD plus the staged changes has `client/generated/`, `server/generated/`, `client/dev/generated/`,
 * `server/dev/generated/` or `data/simulation_tables.csv` content that differs from running `ogw generate`,
 * `ogw data`, `ogw contract` in that order on it. Runs in a temporary worktree `worktrees/<game>/check-<id>/`
 * that is removed whatever the result, shared with `contract`. A failing step is a finding.
 */
export const NAME = 'generated diff';

export const GENERATED_FOLDERS = ['client/generated/', 'server/generated/', 'client/dev/generated/', 'server/dev/generated/'];
export const GENERATED_FILES = ['data/simulation_tables.csv'];

/** Contents of the generated folders and files of a checkout. */
export async function snapshot(root: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const folder of GENERATED_FOLDERS) {
    for (const rel of await walk(join(root, folder))) out.set(`${folder}${rel}`, await readFile(join(root, folder, rel)));
  }
  for (const file of GENERATED_FILES) if (exists(join(root, file))) out.set(file, await readFile(join(root, file)));
  return out;
}

export function compareSnapshots(before: Map<string, Buffer>, after: Map<string, Buffer>): Finding[] {
  const out: Finding[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(path);
    const b = after.get(path);
    if (a && !b) out.push(finding(NAME, at(path, 1), 'is not produced by `ogw generate`, `ogw data`, `ogw contract`'));
    else if (!a && b) out.push(absence(NAME, folderOf(path), `${path} is missing; \`ogw generate\`, \`ogw data\`, \`ogw contract\` produce it`));
    else if (a && b && !a.equals(b)) out.push(finding(NAME, at(path, 1), 'differs from the output of `ogw generate`, `ogw data`, `ogw contract`'));
  }
  return out;
}

/** What one regeneration of HEAD plus the staged changes gave: the generated files before and after, and each step's outcome. */
export interface Regeneration {
  before: Map<string, Buffer>;
  after: Map<string, Buffer>;
  /** `ogw generate`, `ogw data` failure (a `OgwError` or a data tool argument error); null when it ran. */
  generateError: string | null;
  dataError: string | null;
  /** The contract tool result, or the `OgwError` message of `ogw contract`; both null when an earlier step failed. */
  contract: ContractRun | null;
  contractError: string | null;
}

function ogwMessage(error: unknown): string {
  if (!(error instanceof OgwError)) throw error;
  return error.message;
}

/** `ogw generate`, `ogw data`, `ogw contract` in that order (generate runs once) on the worktree `game`. */
async function regenerate(sc: StaticContext, game: GameRepo): Promise<Regeneration> {
  const before = await snapshot(game.root);
  const out: Regeneration = { before, after: before, generateError: null, dataError: null, contract: null, contractError: null };
  try {
    await runGenerate(sc.ctx, game);
  } catch (error) {
    out.generateError = ogwMessage(error);
    return out;
  }
  try {
    const data = await runData(sc.ctx, game, { generate: false });
    if (data.exitCode === 2) out.dataError = `data tool failed: ${data.stderr.trim()}`;
  } catch (error) {
    out.dataError = ogwMessage(error);
  }
  if (out.dataError !== null) return out;
  try {
    out.contract = await runContract(sc.ctx, game, { generate: false });
  } catch (error) {
    out.contractError = ogwMessage(error);
  }
  out.after = await snapshot(game.root);
  return out;
}

const regenerations = new WeakMap<StaticContext, Promise<Regeneration>>();

/**
 * The regeneration of HEAD plus the staged changes in one temporary worktree, shared by `generated diff` and
 * `contract` of the same static check run.
 */
export function regeneration(sc: StaticContext): Promise<Regeneration> {
  let value = regenerations.get(sc);
  if (!value) {
    value = withStagedWorktree(sc, (game) => regenerate(sc, game));
    regenerations.set(sc, value);
  }
  return value;
}

/** A worktree of HEAD at `path`; an empty worktree on an unborn branch while HEAD has no commit (the first commit). */
async function addHeadWorktree(root: string, path: string): Promise<void> {
  if ((await revParse(root, 'HEAD')) !== null) await worktreeAdd(root, path, 'HEAD');
  else await git(root, ['worktree', 'add', '--quiet', '--orphan', path]);
}

/**
 * The tree of the staged changes. `git write-tree` takes the lock of the index it reads, so it reads a copy: the
 * checkout's index may be locked by a `git status` running at the same time.
 */
async function stagedTree(sc: StaticContext): Promise<string> {
  const env = sc.stagedEnv ?? process.env;
  let index = env.GIT_INDEX_FILE;
  if (index === undefined) {
    const path = await gitRaw(sc.root, ['rev-parse', '--git-path', 'index'], { env });
    if (path.code !== 0) throw new OgwError(`git rev-parse --git-path index failed: ${path.stderr.trim()}`);
    index = path.stdout.trim();
  }
  const dir = await mkdtemp(join(tmpdir(), 'ogw-index-'));
  try {
    const copy = join(dir, 'index');
    // no index file: nothing is staged yet, and git reads a missing index as an empty one
    if (exists(resolve(sc.root, index))) await copyFile(resolve(sc.root, index), copy);
    const tree = await gitRaw(sc.root, ['write-tree'], { env: { ...env, GIT_INDEX_FILE: copy } });
    if (tree.code !== 0) throw new OgwError(`git write-tree failed: ${tree.stderr.trim()}`);
    return tree.stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Runs `fn` on a temporary worktree `worktrees/<game>/check-<id>/` of HEAD with the staged changes of the checkout
 * (read with `sc.stagedEnv`, so a pre-commit hook reads the index of the commit) checked out, and removes the worktree
 * whatever the result.
 */
export async function withStagedWorktree<T>(sc: StaticContext, fn: (game: GameRepo) => Promise<T>): Promise<T> {
  const ws = await sc.ctx.workspace();
  const path = join(ws.worktrees, sc.game.name, `check-${newId()}`);
  await mkdir(dirname(path), { recursive: true });
  await addHeadWorktree(sc.root, path);
  try {
    // git writes the staged tree into the worktree itself: a patch of the staged files would pass every byte of a
    // large binary (a reference video) through this process
    await git(path, ['read-tree', '--reset', '-u', await stagedTree(sc)]);
    return await fn({ ...sc.game, root: path, inWorktree: true });
  } finally {
    await worktreeRemove(sc.root, path);
  }
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const r = await regeneration(sc);
  if (r.generateError !== null) return [finding(NAME, at('client/generated', 1), `ogw generate failed: ${r.generateError}`)];
  if (r.dataError !== null) return [finding(NAME, at('data', 1), `ogw data failed: ${r.dataError}`)];
  if (r.contractError !== null) return [finding(NAME, at('contract', 1), `ogw contract failed: ${r.contractError}`)];
  if (r.contract?.exitCode === 2) return [finding(NAME, at('contract', 1), `ogw contract failed: contract tool failed: ${r.contract.stderr.trim()}`)];
  return compareSnapshots(r.before, r.after);
}
