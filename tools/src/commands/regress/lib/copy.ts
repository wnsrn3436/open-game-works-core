/**
 * Regression states and fix repos (ogw.md `### regression state` of `## regress`): game repos whose `main` and
 * `id-registry` are each one root commit holding the tree of a commit of another repo, without `records/loops/`.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists } from '../../../lib/fsx.ts';
import { commonDir, git, gitRaw, revParse } from '../../../lib/git.ts';
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
 * hook that runs the harness tool of `OGW_HARNESS_ROOT`, and the regression mark. Returns the root commit of `main`.
 */
export async function makeCopyRepo(ctx: Context, name: string, source: CopySource, mark: RegressionMark, message: string): Promise<string> {
  const target = join((await ctx.workspace()).games, name);
  if (exists(target)) throw new OgwError(`${target} exists`);
  await mkdir(target, { recursive: true });
  try {
    await extractTree(ctx, source.repo, source.commit, target);
    await rm(join(target, 'records', 'loops'), { recursive: true, force: true });
    await git(target, ['init', '--quiet', '--initial-branch', 'main'], { env: ctx.env });
    // every file of the tree was tracked in the source, also one that its .gitignore names
    await git(target, ['add', '--all', '--force'], { env: ctx.env });
    await git(target, ['commit', '--quiet', '--no-verify', '--allow-empty', '-m', message], { env: ctx.env });
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

/** The commit of the `id-registry` branch of `repo`, or null without one. */
export async function registryCommit(ctx: Context, repo: string): Promise<string | null> {
  return revParse(repo, 'refs/heads/id-registry', { env: ctx.env });
}

/** The root commit of a branch: the first commit of its history. */
export async function rootOf(ctx: Context, repo: string, ref: string): Promise<string> {
  const out = await git(repo, ['rev-list', '--max-parents=0', ref], { env: ctx.env });
  const root = out.trim().split('\n').at(-1);
  if (root === undefined || root === '') throw new OgwError(`${repo} ${ref} has no root commit`);
  return root;
}

/**
 * Puts a fix repo back as it was made (ogw.md `### seed-run`): `main` and `id-registry` at their root commits, its other
 * branches and worktrees removed, and its untracked files removed except the ignored ones.
 */
export async function resetFixRepo(ctx: Context, repo: string, roots: { main: string; registry: string | null }): Promise<void> {
  const env = { env: ctx.env };
  for (const line of (await git(repo, ['worktree', 'list', '--porcelain'], env)).split('\n')) {
    const path = /^worktree (.+)$/.exec(line)?.[1];
    if (path !== undefined && path !== repo) await gitRaw(repo, ['worktree', 'remove', '--force', path], env);
  }
  await gitRaw(repo, ['worktree', 'prune'], env);
  await gitRaw(repo, ['merge', '--abort'], env);
  await git(repo, ['checkout', '--quiet', '--force', 'main'], env);
  await git(repo, ['reset', '--quiet', '--hard', roots.main], env);
  await git(repo, ['clean', '--quiet', '-d', '--force'], env);
  if (roots.registry !== null) await git(repo, ['update-ref', 'refs/heads/id-registry', roots.registry], env);
  const branches = (await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], env)).split('\n').filter((b) => b !== '' && b !== 'main' && b !== 'id-registry');
  for (const branch of branches) await git(repo, ['branch', '--quiet', '-D', branch], env);
  const tags = (await git(repo, ['tag', '--list'], env)).split('\n').filter((t) => t !== '');
  for (const tag of tags) await git(repo, ['tag', '-d', tag], env);
}
