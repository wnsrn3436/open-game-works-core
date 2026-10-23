import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { OgwError } from './errors.ts';
import { run, type RunResult } from './proc.ts';

export const GIT_TIMEOUT_MS = 10 * 60_000;

export interface GitOptions {
  input?: string | Uint8Array;
  timeoutMs?: number;
  /** Environment of git; default `process.env`. Commands pass `ctx.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Runs git and returns the raw result. */
export async function gitRaw(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<RunResult> {
  return run('git', args, {
    cwd,
    input: options.input,
    timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
    env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: '0' },
  });
}

/** Runs git and returns stdout. Throws on a non-zero exit. */
export async function git(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<string> {
  const result = await gitRaw(cwd, args, options);
  if (result.timedOut) throw new OgwError(`git ${args.join(' ')} timed out`);
  if (result.code !== 0) {
    throw new OgwError(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

/** stdout without the trailing newline. */
export async function gitLine(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<string> {
  return (await git(cwd, args, options)).replace(/\r?\n$/, '');
}

export async function head(cwd: string, options: GitOptions = {}): Promise<string> {
  return gitLine(cwd, ['rev-parse', 'HEAD'], options);
}

export async function revParse(cwd: string, rev: string, options: GitOptions = {}): Promise<string | null> {
  const result = await gitRaw(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], options);
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function currentBranch(cwd: string, options: GitOptions = {}): Promise<string | null> {
  const result = await gitRaw(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], options);
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function topLevel(cwd: string, options: GitOptions = {}): Promise<string> {
  return gitLine(cwd, ['rev-parse', '--show-toplevel'], options);
}

function absolute(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** The git common dir, shared by the main checkout and its worktrees. */
export async function commonDir(cwd: string, options: GitOptions = {}): Promise<string> {
  return absolute(cwd, await gitLine(cwd, ['rev-parse', '--git-common-dir'], options));
}

/** The git dir of this checkout (differs per worktree). */
export async function gitDir(cwd: string, options: GitOptions = {}): Promise<string> {
  return absolute(cwd, await gitLine(cwd, ['rev-parse', '--git-dir'], options));
}

/** The folder is a git checkout: it has `.git` (a folder, or the file of a worktree). */
export function isCheckout(root: string): boolean {
  return existsSync(join(root, '.git'));
}

/** Path of the file lock `<name>` of a checkout: in its git dir, or `<root>/.<name>` when the folder is not a git checkout. */
export async function checkoutLock(root: string, name: string, options: GitOptions = {}): Promise<string> {
  return isCheckout(root) ? join(await gitDir(root, options), name) : join(root, `.${name}`);
}

/** Lines of `git status --porcelain` (untracked files included), limited to `paths` when given. Empty means no change. */
export async function statusLines(cwd: string, options: GitOptions = {}, paths: readonly string[] = []): Promise<string[]> {
  const out = await git(cwd, ['status', '--porcelain', '--untracked-files=all', ...(paths.length > 0 ? ['--', ...paths] : [])], options);
  return out.split('\n').filter((line) => line.length > 0);
}

/** Checkout-relative paths with a staged change (added, modified, deleted; a rename lists both paths). */
export async function stagedPaths(cwd: string, options: GitOptions = {}): Promise<string[]> {
  const out = await git(cwd, ['diff', '--cached', '--name-only', '-z', '--no-renames'], options);
  return out.split('\0').filter((path) => path !== '');
}

export async function branchExists(cwd: string, branch: string, options: GitOptions = {}): Promise<boolean> {
  const result = await gitRaw(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], options);
  return result.code === 0;
}

export async function tagExists(cwd: string, tag: string, options: GitOptions = {}): Promise<boolean> {
  const result = await gitRaw(cwd, ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], options);
  return result.code === 0;
}

export async function listTags(cwd: string, options: GitOptions = {}): Promise<string[]> {
  const out = await git(cwd, ['tag', '--list'], options);
  return out.split('\n').filter((line) => line.length > 0);
}

/** File content at a revision, or null when the path does not exist there. */
export async function showFile(cwd: string, rev: string, path: string, options: GitOptions = {}): Promise<Buffer | null> {
  const result = await gitRaw(cwd, ['show', `${rev}:${path}`], options);
  return result.code === 0 ? result.stdoutBytes : null;
}

/**
 * Stages and commits exactly `paths` (added, changed or deleted), and any change a pre-commit hook stages.
 * `noVerify` skips the pre-commit hook. Returns the new commit, or null when the paths have no change.
 */
export async function commitPaths(
  cwd: string,
  paths: readonly string[],
  message: string,
  options: GitOptions & { noVerify?: boolean } = {},
): Promise<string | null> {
  if (paths.length === 0) return null;
  await git(cwd, ['add', '--all', '--', ...paths], options);
  const staged = await gitRaw(cwd, ['diff', '--cached', '--quiet', '--', ...paths], options);
  if (staged.code === 0) return null;
  await git(cwd, ['commit', '--quiet', ...(options.noVerify === true ? ['--no-verify'] : []), '-m', message, '--', ...paths], options);
  await indexAsHead(cwd, paths, options);
  return head(cwd, options);
}

/**
 * Sets the index entries of `paths` and of every path the HEAD commit changed to HEAD's content. A commit with a
 * pathspec gives the pre-commit hook a temporary index, so what the hook stages or reverts (`ogw meta sync
 * --staged`) reaches the commit but not the real index; without this the next commit would undo it, or commit a
 * change the hook reverted.
 */
async function indexAsHead(cwd: string, paths: readonly string[], options: GitOptions): Promise<void> {
  const changed = await git(cwd, ['diff-tree', '-r', '--root', '--no-commit-id', '--name-only', '-z', '--no-renames', 'HEAD'], options);
  const literal = changed.split('\0').filter((path) => path !== '').map((path) => `:(literal)${path}`);
  const input = [...paths, ...literal].join('\0');
  await git(cwd, ['reset', '--quiet', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'], { ...options, input });
}

export async function worktreeAdd(cwd: string, path: string, ref: string, newBranch?: string, options: GitOptions = {}): Promise<void> {
  const args = ['worktree', 'add', '--quiet'];
  if (newBranch) args.push('-b', newBranch);
  else args.push('--detach');
  args.push(path, ref);
  await git(cwd, args, options);
}

export async function worktreeRemove(cwd: string, path: string, options: GitOptions = {}): Promise<void> {
  await gitRaw(cwd, ['worktree', 'remove', '--force', path], options);
  await gitRaw(cwd, ['worktree', 'prune'], options);
}

export async function deleteBranch(cwd: string, branch: string, options: GitOptions = {}): Promise<void> {
  await gitRaw(cwd, ['branch', '-D', branch], options);
}

/** `env` with `pairs` added as git config that comes before every config file (`GIT_CONFIG_COUNT`), after the ones `env` has. */
export function withGitConfig(env: NodeJS.ProcessEnv, pairs: readonly (readonly [string, string])[]): NodeJS.ProcessEnv {
  const count = Number(env.GIT_CONFIG_COUNT ?? '0');
  const start = Number.isInteger(count) && count > 0 ? count : 0;
  const copy: NodeJS.ProcessEnv = { ...env, GIT_CONFIG_COUNT: String(start + pairs.length) };
  pairs.forEach(([key, value], index) => {
    copy[`GIT_CONFIG_KEY_${String(start + index)}`] = key;
    copy[`GIT_CONFIG_VALUE_${String(start + index)}`] = value;
  });
  return copy;
}

const IDENT = /^(.*) <([^>]*)> \d+ [+-]\d{4}$/;

/**
 * The author and committer git uses for a commit in `dir` (or its nearest existing parent), as the environment
 * variables that set them. A side git cannot decide is left out.
 */
export async function gitIdentity(dir: string, options: GitOptions = {}): Promise<Record<string, string>> {
  let cwd = dir;
  while (!existsSync(cwd) && dirname(cwd) !== cwd) cwd = dirname(cwd);
  const identity: Record<string, string> = {};
  for (const side of ['AUTHOR', 'COMMITTER'] as const) {
    const result = await gitRaw(cwd, ['var', `GIT_${side}_IDENT`], options);
    const match = result.code === 0 ? IDENT.exec(result.stdout.trim()) : null;
    if (match === null) continue;
    identity[`GIT_${side}_NAME`] = match[1] as string;
    identity[`GIT_${side}_EMAIL`] = match[2] as string;
  }
  return identity;
}

/** True when `ancestor` is an ancestor of (or equal to) `commit`. */
export async function isAncestor(cwd: string, ancestor: string, commit: string, options: GitOptions = {}): Promise<boolean> {
  const result = await gitRaw(cwd, ['merge-base', '--is-ancestor', ancestor, commit], options);
  return result.code === 0;
}
