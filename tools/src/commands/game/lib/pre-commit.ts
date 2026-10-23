import { chmod, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliIo } from '../../../lib/cli.ts';
import { createContext, type Context } from '../../../lib/command.ts';
import { writeFileAtomic } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { commonDir, git, stagedPaths } from '../../../lib/git.ts';
import type { CheckFailure } from '../../check/api.ts';
import type { StaticCheckDetail, StaticCheckOptions } from '../../check/static-api.ts';

export interface PreCommitDeps {
  /** Runs an ogw command line with the given io and returns its exit code. */
  ogw(argv: string[], io: CliIo): Promise<number>;
  /** `ogw check <game> --static` with its absence failures. */
  staticCheck(ctx: Context, game: GameRepo, options: StaticCheckOptions): Promise<StaticCheckDetail>;
}

/** Variables git sets for a hook that point git at the committing checkout (`git help githooks`, `git help git`). */
export const REPO_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
] as const;

export interface HookEnvs {
  /** For git on the committing checkout: the index of the commit as an absolute path, no other repo variable. */
  checkout: NodeJS.ProcessEnv;
  /** For git on other checkouts (the temporary worktrees of the static check): no repo variable. */
  clean: NodeJS.ProcessEnv;
}

/** The environments of the hook. `cwd` is the folder git runs the hook in (the root of the committing checkout). */
export function hookEnvs(cwd: string, env: NodeJS.ProcessEnv): HookEnvs {
  const clean = { ...env };
  for (const key of REPO_VARS) Reflect.deleteProperty(clean, key);
  const index = env.GIT_INDEX_FILE;
  const checkout = index === undefined || index === '' ? clean : { ...clean, GIT_INDEX_FILE: resolve(cwd, index) };
  return { checkout, clean };
}

/** Whether a failure `where` (`<file>` or `<file>:<line>...`) points at one of the files. */
export function pointsAt(where: string, files: readonly string[]): boolean {
  return files.some((file) => where === file || where.startsWith(`${file}:`));
}

/** Whether a `where` `<folder>:1` names a folder that holds one of the files (in it or below it). */
export function folderHolds(where: string, files: readonly string[]): boolean {
  if (!where.endsWith(':1')) return false;
  const folder = where.slice(0, -':1'.length);
  return files.some((file) => folder === '.' || file.startsWith(`${folder}/`));
}

/**
 * The game repo pre-commit hook: `ogw meta sync <game> --staged`, then the static check.
 * A failure whose `where` points at a staged file, and an absence failure whose `where` `<folder>:1` holds a staged
 * file, block the commit. meta sync, the staged file list and the static check's read of the staged changes use the
 * index of the commit; the rest of the static check runs without the repo variables of the hook, so its temporary
 * worktrees use their own index.
 */
export async function runPreCommit(io: CliIo, gameName: string, deps: PreCommitDeps): Promise<number> {
  const envs = hookEnvs(io.cwd, io.env);
  const ctx = createContext({ ...io, env: envs.clean });
  const metaCode = await deps.ogw(['meta', 'sync', gameName, '--staged'], { ...io, env: envs.checkout });
  if (metaCode !== 0) {
    ctx.log(`ogw meta sync ${gameName} --staged failed`);
    return metaCode;
  }
  const game = await ctx.game(gameName);
  const staged = await stagedPaths(game.root, { env: envs.checkout });
  const { result, absent } = await deps.staticCheck(ctx, game, { stagedEnv: envs.checkout });
  const blocking: CheckFailure[] = result.failures.filter(
    (failure) => pointsAt(failure.where, staged) || (absent.includes(failure) && folderHolds(failure.where, staged)),
  );
  for (const failure of blocking) ctx.log(`${failure.where}: ${failure.message}`);
  return blocking.length > 0 ? 1 : 0;
}

/**
 * The hook process. Removes the repo variables of the hook from `process.env` too, because git calls that take no
 * environment use `process.env`. Returns the exit code.
 */
export async function hookMain(gameName: string, deps: PreCommitDeps): Promise<number> {
  const env = { ...process.env };
  for (const key of REPO_VARS) Reflect.deleteProperty(process.env, key);
  const write = (text: string): void => {
    process.stderr.write(text);
  };
  const io: CliIo = { cwd: process.cwd(), env, stdin: () => Promise.resolve(''), stdout: write, stderr: write };
  return runPreCommit(io, gameName, deps).catch((error: unknown) => {
    write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  });
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Path of the script the hook runs. */
export const PRE_COMMIT_MAIN = fileURLToPath(new URL('./pre-commit-main.ts', import.meta.url));

export function hookScript(game: string): string {
  return [
    '#!/bin/sh',
    `# ogw pre-commit hook of game ${game}`,
    `exec node --disable-warning=ExperimentalWarning ${shellQuote(PRE_COMMIT_MAIN)} ${shellQuote(game)}`,
    '',
  ].join('\n');
}

/**
 * Writes the pre-commit hook into `hooks/` of the repo's git common dir and sets the repo's own `core.hooksPath`
 * to that folder, so a global `core.hooksPath` neither receives the hook nor hides it. Returns the hook path.
 */
export async function installHook(root: string, game: string, env: NodeJS.ProcessEnv): Promise<string> {
  const hooks = join(await commonDir(root, { env }), 'hooks');
  await mkdir(hooks, { recursive: true });
  const path = join(hooks, 'pre-commit');
  await writeFileAtomic(path, hookScript(game));
  await chmod(path, 0o755);
  await git(root, ['config', '--local', 'core.hooksPath', hooks], { env });
  return path;
}
