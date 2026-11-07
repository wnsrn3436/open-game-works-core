import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { OgwError } from './errors.ts';
import { exists, whenNotFound } from './fsx.ts';
import { commonDir, gitRaw, topLevel } from './git.ts';
import { segmentsBelow } from './paths.ts';
import type { Workspace } from './settings.ts';

export interface GameRepo {
  name: string;
  /** The checkout the command works in: the main checkout, or the game worktree the command runs in. */
  root: string;
  /** `games/<game>/`. */
  mainRoot: string;
  /** git common dir shared by the main checkout and all worktrees. */
  commonDir: string;
  /** True when `root` is a worktree under `worktrees/<game>/`. */
  inWorktree: boolean;
}

/** A game name is one folder name. */
const GAME_NAME = /^[^./\\][^/\\]*$/;

/**
 * Finds the game repo. Inside `worktrees/<game>/<id>/` the worktree is the game repo.
 * Running inside another game's worktree is an error.
 */
export async function resolveGame(ws: Workspace, name: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<GameRepo> {
  if (!GAME_NAME.test(name)) throw new OgwError(`invalid game name: ${name}`);
  const mainRoot = join(ws.games, name);
  if (!exists(join(mainRoot, '.git'))) throw new OgwError(`game repo not found: ${mainRoot}`);
  const below = segmentsBelow(ws.worktrees, cwd);
  let root = mainRoot;
  let inWorktree = false;
  // core and side worktrees (`_core`, `_harness`) are no game worktrees: a side tool runs its commands from its own
  if (below && below.length >= 2 && below[0] !== '_core' && below[0] !== '_harness') {
    if (below[0] !== name) {
      throw new OgwError(`running inside a worktree of game ${String(below[0])}, not ${name}`);
    }
    root = await topLevel(cwd, { env });
    inWorktree = true;
  }
  return { name, root, mainRoot, commonDir: await commonDir(mainRoot, { env }), inWorktree };
}

/** The nearest folder from `cwd` up that is a core tree: it holds `core-spec/` and `settings/core-settings.json`. */
function coreTreeOf(cwd: string): string | null {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (exists(join(dir, 'core-spec')) && exists(join(dir, 'settings', 'core-settings.json'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

async function realOf(path: string): Promise<string> {
  return realpath(path).catch(whenNotFound(resolve(path)));
}

/** The top of the git worktree of `coreImpl`'s repo that holds `cwd`, or null when `cwd` is in no worktree of that repo. */
async function coreWorktreeOf(coreImpl: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (!exists(join(coreImpl, '.git'))) return null;
  const here = await gitRaw(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir'], { env });
  if (here.code !== 0) return null;
  const [top, common] = here.stdout.trim().split('\n');
  if (top === undefined || common === undefined) return null;
  const implCommon = await commonDir(coreImpl, { env });
  return (await realOf(resolve(cwd, common))) === (await realOf(implCommon)) ? top : null;
}

/**
 * The core checkout (ogw.md `## core spec and core test`): the git worktree of `open-game-works-core-impl/` that holds
 * `cwd` (a worktree under `worktrees/_core/<id>/`, or any other), else the main checkout. A core tree that holds `cwd`
 * and is no such worktree fails, naming the command that makes it one.
 */
export async function resolveCoreImpl(ws: Workspace, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const below = segmentsBelow(ws.worktrees, cwd);
  if (below && below.length >= 2 && below[0] === '_core') return topLevel(cwd, { env });
  const worktree = await coreWorktreeOf(ws.coreImpl, cwd, env);
  if (worktree !== null) return worktree;
  const tree = coreTreeOf(cwd);
  if (tree !== null) {
    throw new OgwError(`${tree} is a core tree that is not a git worktree of ${ws.coreImpl}; a core command works in a worktree of it: git -C ${ws.coreImpl} worktree add <folder>`);
  }
  return ws.coreImpl;
}
