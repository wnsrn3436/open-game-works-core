/**
 * Regression states and fix repos (ogw.md `### regression state` of `## regress`): game repos whose `main` and
 * `id-registry` are each one root commit holding the tree of a commit of another repo, without `records/loops/`.
 */
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists } from '../../../lib/fsx.ts';
import { commonDir, git, revParse } from '../../../lib/git.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { runOk } from '../../../lib/proc.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';
import { installHook } from '../../game/lib/pre-commit.ts';
import { writeMark, type RegressionMark } from './mark.ts';

/** The tree of commit `commit` of `repo` written into the folder `into`, which `git archive` gives. */
async function extractTree(ctx: Context, repo: string, commit: string, into: string): Promise<void> {
  const temp = await newPrivateTempFolder('ogw-regress-tree-', ctx.env);
  try {
    const tar = join(temp, 'tree.tar');
    await git(repo, ['archive', '--format=tar', '-o', tar, commit], { env: ctx.env });
    await mkdir(into, { recursive: true });
    await runOk('tar', ['-xf', tar, '-C', into], { env: ctx.env, timeoutMs: LIMITS.programMs });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/** A root commit of the tree of the folder `tree` in `repo`, made with an index of its own so the checkout is untouched. */
async function rootCommitOf(ctx: Context, repo: string, tree: string, message: string): Promise<string> {
  const temp = await newPrivateTempFolder('ogw-regress-index-', ctx.env);
  try {
    const env = { ...ctx.env, GIT_INDEX_FILE: join(temp, 'index'), GIT_WORK_TREE: tree };
    await git(repo, ['add', '--all', '--force', '.'], { env });
    const id = (await git(repo, ['write-tree'], { env })).trim();
    return (await git(repo, ['commit-tree', id, '-m', message], { env: ctx.env })).trim();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export interface CopySource {
  /** The repo the tree is read from; it is only read. */
  repo: string;
  commit: string;
  /** The commit of the `id-registry` tree; null when the source has none. */
  registry: string | null;
}

/**
 * Makes the game repo `games/<name>/` from `source` (ogw.md `### regression state`): `main` one root commit of the tree of
 * the commit without `records/loops/`, `id-registry` one root commit of the tree of the registry commit, the pre-commit
 * hook that runs the harness tool of `OGW_HARNESS_ROOT`, and the regression mark. Returns the root commit of `main`. With
 * `reserved`, the folder is there and empty (the fix repo of a seed-run, `### regress run` 3); otherwise it is not there.
 */
export async function makeCopyRepo(ctx: Context, name: string, source: CopySource, mark: RegressionMark, message: string, reserved = false): Promise<string> {
  const target = join((await ctx.workspace()).games, name);
  if (reserved ? !exists(target) || (await readdir(target)).length > 0 : exists(target)) throw new OgwError(reserved ? `${target} is not an empty folder` : `${target} exists`);
  await mkdir(target, { recursive: true });
  try {
    await extractTree(ctx, source.repo, source.commit, target);
    await rm(join(target, 'records', 'loops'), { recursive: true, force: true });
    await git(target, ['init', '--quiet', '--initial-branch', 'main'], { env: ctx.env });
    // every file of the tree was tracked in the source, also one that its .gitignore names
    await git(target, ['add', '--all', '--force'], { env: ctx.env });
    // no `gc --auto` left running behind the commit: a clone of the repo (`cloneCopyRepo`) copies it as the commit left it
    await git(target, ['-c', 'gc.auto=0', 'commit', '--quiet', '--no-verify', '--allow-empty', '-m', message], { env: ctx.env });
    if (source.registry !== null) {
      const temp = await newPrivateTempFolder('ogw-regress-registry-', ctx.env);
      try {
        await extractTree(ctx, source.repo, source.registry, temp);
        const registry = await rootCommitOf(ctx, target, temp, `${message}: id-registry`);
        await git(target, ['update-ref', 'refs/heads/id-registry', registry], { env: ctx.env });
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    }
    await installHook(target, name, ctx.env, true);
    await writeMark(await commonDir(target, { env: ctx.env }), mark);
    return (await git(target, ['rev-parse', 'HEAD'], { env: ctx.env })).trim();
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Whether this host clones a folder of a copy repo (`cloneCopyRepo`): macOS, whose `cp -c` makes an APFS clone of each
 * file, which shares the blocks of the file until one of the two changes it.
 */
export function canCloneFolders(): boolean {
  return process.platform === 'darwin';
}

/**
 * Makes the game repo `games/<name>/` in its reserved, empty folder as a clone of the copy repo `from` (ogw.md `### regress
 * run` 4): the same tree, `main`, `id-registry` and regression mark, with the pre-commit hook of `<name>`. `from` must
 * be one that nothing changed since `makeCopyRepo` made it. Returns its root.
 */
export async function cloneCopyRepo(ctx: Context, from: string, name: string): Promise<string> {
  const target = join((await ctx.workspace()).games, name);
  if (!exists(target) || (await readdir(target)).length > 0) throw new OgwError(`${target} is not an empty folder`);
  try {
    // `<from>/` copies what is in it into the folder
    await runOk('cp', ['-c', '-R', `${from}/`, target], { env: ctx.env, timeoutMs: LIMITS.programMs });
    // the hook names its game, and `core.hooksPath` names the hooks folder of its repo
    await installHook(target, name, ctx.env, true);
    return target;
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

/** The commit of the `id-registry` branch of `repo`, or null without one. */
export async function registryCommit(ctx: Context, repo: string): Promise<string | null> {
  return revParse(repo, 'refs/heads/id-registry', { env: ctx.env });
}
