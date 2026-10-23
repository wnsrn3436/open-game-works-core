import { readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { expectPositionals, flag, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists } from '../../lib/fsx.ts';
import { git, stagedPaths } from '../../lib/git.ts';
import { LIMITS } from '../../lib/limits.ts';
import { run } from '../../lib/proc.ts';
import { requireEngine } from '../env/api.ts';
import { coreProject, gameProject, isEngineResource, isMetaFile, isProjectFile, isSyncedMeta, sourceOf, type MetaProject } from './lib/project.ts';

function nulList(out: string): string[] {
  return out.split('\0').filter((entry) => entry !== '');
}

async function importProject(ctx: Context, project: MetaProject): Promise<void> {
  const godot = await requireEngine(ctx, 'godot', await project.godotVersion());
  const result = await run(godot, ['--headless', '--path', project.dir, '--import'], { cwd: project.dir, timeoutMs: LIMITS.programMs });
  if (result.timedOut || result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new OgwError(`godot --import failed (${result.timedOut ? 'timed out' : String(result.code)})${detail ? `: ${detail}` : ''}`);
  }
}

/** Files below a checkout-relative folder that the project sees, without entering the folders it does not see. */
async function projectFilesBelow(project: MetaProject, folder: string): Promise<string[]> {
  const dir = join(project.repo, folder);
  if (!exists(dir)) return [];
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) {
      if (isProjectFile(project, `${path}/`)) files.push(...(await projectFilesBelow(project, path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

/** Removes `.uid` and `.import` files whose source file is gone. Returns their checkout-relative paths. */
export async function removeOrphanMeta(project: MetaProject): Promise<string[]> {
  const removed: string[] = [];
  for (const area of project.areas) {
    for (const path of await projectFilesBelow(project, area)) {
      if (!isSyncedMeta(project, path)) continue;
      if (exists(join(project.repo, sourceOf(path)))) continue;
      await rm(join(project.repo, path));
      removed.push(path);
    }
  }
  return removed.sort();
}

/** Meta files of the project that differ from HEAD in the index or the working tree. */
async function changedMeta(project: MetaProject, env: NodeJS.ProcessEnv): Promise<string[]> {
  const out = await git(project.repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', ...project.areas], { env });
  // A path deleted in the index and present on disk is listed twice (`D ` and `??`).
  const paths = nulList(out)
    .map((entry) => entry.slice(3))
    .filter((path) => isSyncedMeta(project, path));
  return [...new Set(paths)];
}

/** NUL-separated pathspec input for `--pathspec-from-file=- --pathspec-file-nul`. */
function pathspecInput(paths: Iterable<string>): string {
  return [...paths].map((path) => `${path}\0`).join('');
}

/**
 * Runs a git command on exact paths: the paths go in on stdin and `--literal-pathspecs` keeps a name such as
 * `a[1].gd.uid` from matching other files as a glob.
 */
async function gitOnPaths(project: MetaProject, args: readonly string[], paths: Iterable<string>, env: NodeJS.ProcessEnv): Promise<void> {
  await git(project.repo, ['--literal-pathspecs', ...args, '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: pathspecInput(paths) });
}

/** Puts meta files back to HEAD with one git process per kind: checked out when HEAD has them, else removed. */
async function revertMeta(project: MetaProject, paths: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  if (paths.length === 0) return;
  const inHead = new Set(
    nulList(await git(project.repo, ['--literal-pathspecs', 'ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...project.areas], { env })),
  );
  const kept = paths.filter((path) => inHead.has(path));
  const gone = paths.filter((path) => !inHead.has(path));
  if (kept.length > 0) await gitOnPaths(project, ['checkout', 'HEAD'], kept, env);
  if (gone.length === 0) return;
  await gitOnPaths(project, ['rm', '--cached', '--quiet', '--ignore-unmatch'], gone, env);
  for (const path of gone) await rm(join(project.repo, path), { force: true });
}

/** Checkout-relative paths of the project areas in the index. */
async function indexedPaths(project: MetaProject, env: NodeJS.ProcessEnv): Promise<Set<string>> {
  return new Set(nulList(await git(project.repo, ['ls-files', '-z', '--cached', '--', ...project.areas], { env })));
}

/**
 * The lock of the checkout's own index when git runs the hook of a partial commit (`git commit -- <path>`), else null.
 * In a partial commit git gives the hook a temporary index (HEAD plus the paths) to commit, and afterwards puts its
 * lock of the checkout's index (`index.lock`) in place of the index. A change the hook makes only to the temporary
 * index reaches the commit but not the checkout's index, so the same change goes to that lock too.
 */
async function partialCommitIndex(project: MetaProject, env: NodeJS.ProcessEnv): Promise<string | null> {
  const hookIndex = env.GIT_INDEX_FILE;
  if (hookIndex === undefined || hookIndex === '') return null;
  const own = { ...env };
  Reflect.deleteProperty(own, 'GIT_INDEX_FILE');
  const gitDir = await realpath((await git(project.repo, ['rev-parse', '--absolute-git-dir'], { env: own })).trim());
  const index = resolve(project.repo, hookIndex);
  const indexDir = exists(dirname(index)) ? await realpath(dirname(index)) : dirname(index);
  if (indexDir === gitDir && (basename(index) === 'index' || basename(index) === 'index.lock')) return null;
  const lock = join(gitDir, 'index.lock');
  return exists(lock) ? lock : null;
}

interface Restage {
  add: Set<string>;
  drop: Set<string>;
  reverted: string[];
}

/**
 * Lines each meta file up with its source in the commit. A meta file whose source has a staged change follows
 * the source: when the source is in the index its working tree change is staged, otherwise the meta file leaves
 * the index. The other meta changes go back to HEAD (a meta file HEAD lacks is removed).
 */
async function planRestage(project: MetaProject, staged: readonly string[], env: NodeJS.ProcessEnv): Promise<Restage> {
  const sources = new Set(staged.filter((path) => !isMetaFile(path)));
  const index = await indexedPaths(project, env);
  const plan: Restage = { add: new Set(), drop: new Set(), reverted: [] };
  for (const source of sources) {
    for (const meta of [`${source}.uid`, `${source}.import`]) {
      if (isSyncedMeta(project, meta) && !index.has(source) && index.has(meta)) plan.drop.add(meta);
    }
  }
  for (const meta of await changedMeta(project, env)) {
    const source = sourceOf(meta);
    if (!sources.has(source)) plan.reverted.push(meta);
    else if (!index.has(source)) continue;
    else if (exists(join(project.repo, meta))) plan.add.add(meta);
    else if (index.has(meta)) plan.drop.add(meta);
  }
  return plan;
}

async function applyRestage(project: MetaProject, plan: Restage, env: NodeJS.ProcessEnv): Promise<void> {
  if (plan.add.size > 0) await gitOnPaths(project, ['add', '--all'], plan.add, env);
  if (plan.drop.size > 0) await gitOnPaths(project, ['rm', '--cached', '--quiet', '--ignore-unmatch'], plan.drop, env);
  await revertMeta(project, plan.reverted, env);
}

async function restage(project: MetaProject, staged: readonly string[], env: NodeJS.ProcessEnv): Promise<{ staged: string[]; reverted: string[] }> {
  const partial = await partialCommitIndex(project, env);
  const plan = await planRestage(project, staged, env);
  await applyRestage(project, plan, env);
  if (partial !== null) await applyRestage(project, plan, { ...env, GIT_INDEX_FILE: partial });
  return { staged: [...plan.add, ...plan.drop].sort(), reverted: plan.reverted };
}

export const sync: CommandDef = {
  name: ['meta', 'sync'],
  usage: 'ogw meta sync <game|core> --staged',
  options: { staged: { type: 'boolean' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    // the pre-commit hook's sync of the commit's staged files is the only sync (`client-core` Godot `## engine meta file`)
    if (!flag(args, 'staged')) throw new OgwError(`usage: ${this.usage}`);
    const target = positional(args, 0, 'game or core');
    const project = target === 'core' ? await coreProject(ctx) : await gameProject(ctx, target);
    const staged = await stagedPaths(project.repo, { env: ctx.env });
    // only a staged engine resource needs an import; the meta files are lined up with their sources on every commit
    const imported = staged.some((path) => isEngineResource(project, path));
    if (imported) await importProject(ctx, project);
    const removed = await removeOrphanMeta(project);
    const changes = await restage(project, staged, ctx.env);
    const lines = [
      ...removed.map((path) => `removed ${path}`),
      ...changes.staged.map((path) => `staged ${path}`),
      ...changes.reverted.map((path) => `reverted ${path}`),
    ];
    const none = imported ? 'no meta change' : 'no staged engine resource';
    return { text: lines.length > 0 ? lines.join('\n') : none, data: { imported, removed, ...changes } };
  },
};
