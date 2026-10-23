import { cp, mkdir, readdir, readFile, realpath, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '../../../lib/command.ts';
import { exists } from '../../../lib/fsx.ts';
import { resolveCoreImpl } from '../../../lib/game.ts';
import { git, revParse } from '../../../lib/git.ts';
import { OgwError } from '../../../lib/errors.ts';
import { cliEntry } from '../../../lib/paths.ts';

export type Side = 'core' | 'tool';

/** The code a code check looks at. */
export interface CheckTarget {
  side: Side;
  /** Folder of the code: `open-game-works-core-impl/` (or the core worktree) or the harness repo `tools/`. */
  root: string;
  /** Root of the git checkout the code comes from. */
  repo: string;
  /** Files of `root` (tracked and untracked, not ignored), relative to `root` with `/`. */
  files: string[];
}

/** `tools/` of the ogw that runs this check: its pinned TypeScript and ESLint are the check programs. */
export function ogwTools(): string {
  return resolve(dirname(cliEntry()), '..');
}

export function ogwRequire(): NodeJS.Require {
  return createRequire(fileURLToPath(import.meta.url));
}

/** Files under `root` that git does not ignore, without `node_modules/`. */
export async function listFiles(root: string): Promise<string[]> {
  const out = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.']);
  return checkedFiles(root, out.split('\0'));
}

/** Where the code is: `coreRoot` fixes the `core` target to that checkout. */
async function targetPlace(ctx: Context, side: Side, coreRoot?: string): Promise<{ root: string; repo: string }> {
  const ws = await ctx.workspace();
  const root = side === 'core' ? (coreRoot ?? (await resolveCoreImpl(ws, ctx.cwd))) : join(ws.harness, 'tools');
  return { root, repo: side === 'core' ? root : ws.harness };
}

/** The git checkout root of the target (`targetPlace`). */
export async function targetRepo(ctx: Context, side: Side, coreRoot?: string): Promise<string> {
  return (await targetPlace(ctx, side, coreRoot)).repo;
}

/**
 * The target code in the checkout; `coreRoot` fixes the `core` target to that checkout. When a package folder has no
 * `node_modules/` of its own but `packageModules` gives one (a core worktree's tool package), the checkout's files are
 * copied into `folder` and checked there with that link: nothing is put into the checkout, where a build of the same
 * checkout would run `npm ci` through the link into the main checkout's packages.
 */
export async function checkTarget(ctx: Context, side: Side, folder: string, coreRoot?: string): Promise<CheckTarget> {
  const { root, repo } = await targetPlace(ctx, side, coreRoot);
  const files = await listFiles(root);
  // per package the node_modules/ to use; the copy is needed when one differs from what the checkout has there
  const picked = new Map<string, string | null>();
  let copyNeeded = false;
  for (const pkg of packageFolders(files)) {
    const own = join(root, pkg, 'node_modules');
    const modules = await packageModules(ctx, side, root, root, pkg);
    picked.set(pkg, modules);
    if (modules !== (exists(own) ? own : null)) copyNeeded = true;
  }
  if (!copyNeeded) return { side, root, repo, files };
  const copy = join(folder, 'code');
  for (const file of files) await cp(join(root, file), join(copy, file), { recursive: false, verbatimSymlinks: true });
  for (const [pkg, modules] of picked) if (modules !== null) await symlink(modules, join(copy, pkg, 'node_modules'), 'dir');
  return { side, root: copy, repo, files };
}

/** Files under `root` without a `node_modules/` path segment that exist (a symbolic link to nothing does not). */
function checkedFiles(root: string, paths: readonly string[]): string[] {
  return paths.filter((path) => path !== '' && !path.split('/').includes('node_modules') && exists(join(root, path))).sort();
}

/** The text of a file, or null when it is not there. */
async function textOrNull(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
}

/**
 * The `node_modules/` a package folder of the checked code links to: the checkout's, else (a core worktree, which has
 * none for the tool packages) the `open-game-works-core-impl/` main checkout's when its `package-lock.json` is the one of the
 * checked code. Null when neither has it.
 */
async function packageModules(ctx: Context, side: Side, liveRoot: string, root: string, pkg: string): Promise<string | null> {
  const own = join(liveRoot, pkg, 'node_modules');
  if (side !== 'core') return exists(own) ? own : null;
  const main = (await ctx.workspace()).coreImpl;
  if (resolve(main) === resolve(liveRoot)) return exists(own) ? own : null;
  const shared = join(main, pkg, 'node_modules');
  // a link to the main checkout's packages that an earlier check left in the checkout is not the checkout's own
  const leftover = exists(own) && exists(shared) && (await realpath(own)) === (await realpath(shared));
  if (exists(own) && !leftover) return own;
  if (!exists(shared)) return null;
  const lock = await textOrNull(join(root, pkg, 'package-lock.json'));
  return lock !== null && lock === (await textOrNull(join(main, pkg, 'package-lock.json'))) ? shared : null;
}

/**
 * The target code at `commit`, written into `folder` (a new folder of the code check): the files of the target's
 * folder at that commit, so that changes of the checkout made while the check runs are not checked. The checkout's
 * index and worktree list are not touched. A package folder gets a link to a `node_modules/` (`packageModules`),
 * which TypeScript resolves the package's imports from.
 */
export async function commitTarget(ctx: Context, side: Side, commit: string, folder: string, coreRoot?: string): Promise<CheckTarget> {
  const live = await targetPlace(ctx, side, coreRoot);
  const resolved = await revParse(live.repo, commit, { env: ctx.env });
  if (resolved === null) throw new OgwError(`commit ${commit} not found in ${live.repo}`);
  const prefix = relative(live.repo, live.root).split(sep).join('/');
  const options = { env: { ...ctx.env, GIT_INDEX_FILE: join(folder, 'index') } };
  await git(live.repo, ['read-tree', prefix === '' ? `${resolved}^{tree}` : `${resolved}:${prefix}`], options);
  const root = join(folder, 'code');
  await mkdir(root, { recursive: true });
  await git(live.repo, ['checkout-index', '--all', '--force', `--prefix=${root}/`], options);
  const listed = (await git(live.repo, ['ls-files', '-z'], options)).split('\0');
  const files = checkedFiles(root, listed);
  for (const pkg of packageFolders(files)) {
    const modules = await packageModules(ctx, side, live.root, root, pkg);
    if (modules !== null && !exists(join(root, pkg, 'node_modules'))) await symlink(modules, join(root, pkg, 'node_modules'), 'dir');
  }
  return { side, root, repo: live.repo, files };
}

/** A TypeScript declaration file: `.d.ts`, `.d.mts` or `.d.cts`. */
export function isTypeDeclaration(path: string): boolean {
  return /\.d\.[mc]?ts$/.test(path);
}

/** A TypeScript source file (`.ts`, `.mts`, `.cts`, `.tsx`), not a declaration file: type-checked and linted. */
/** A file of a benchmark game of `open-game-works-core-impl/` (`benchmark/<engine>/`). */
export function isBenchmarkPath(path: string): boolean {
  return path.startsWith('benchmark/');
}

export function isTypeScript(path: string): boolean {
  return /\.([mc]?ts|tsx)$/.test(path) && !isTypeDeclaration(path);
}

/** Folders (relative, `''` for the root) holding a `package.json`. */
export function packageFolders(files: readonly string[]): string[] {
  return files.filter((path) => posix.basename(path) === 'package.json').map((path) => posix.dirname(path).replace(/^\.$/, ''));
}

/** Engines of `client/<engine>/engine.json` in `open-game-works-core-impl/`. */
export async function coreEngines(root: string): Promise<string[]> {
  const entries = await readdir(join(root, 'client'), { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && exists(join(root, 'client', e.name, 'engine.json'))).map((e) => e.name).sort();
}
