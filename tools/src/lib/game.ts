import { join } from 'node:path';
import { OgwError } from './errors.ts';
import { exists } from './fsx.ts';
import { commonDir, topLevel } from './git.ts';
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
  if (below && below.length >= 2 && below[0] !== '_core') {
    if (below[0] !== name) {
      throw new OgwError(`running inside a worktree of game ${String(below[0])}, not ${name}`);
    }
    root = await topLevel(cwd, { env });
    inWorktree = true;
  }
  return { name, root, mainRoot, commonDir: await commonDir(mainRoot, { env }), inWorktree };
}

/** When cwd is inside `worktrees/_core/<id>/`, that worktree is `open-game-works-core-impl/`. */
export async function resolveCoreImpl(ws: Workspace, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const below = segmentsBelow(ws.worktrees, cwd);
  if (below && below.length >= 2 && below[0] === '_core') return topLevel(cwd, { env });
  return ws.coreImpl;
}
