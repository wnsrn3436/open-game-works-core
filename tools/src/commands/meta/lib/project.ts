import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { readJson } from '../../../lib/fsx.ts';
import { resolveCoreImpl } from '../../../lib/game.ts';
import { loadGameSettings } from '../../../lib/settings.ts';
import { coreReleaseOfGame, extractedAsset } from '../../core/api.ts';

/** A Godot project whose engine meta files `ogw meta sync` keeps in line. */
export interface MetaProject {
  /** Root of the git checkout that holds the project. */
  repo: string;
  /** The Godot project folder. */
  dir: string;
  /** Checkout-relative folders whose files the project sees (`client` and `resource` of a game). */
  areas: string[];
  /** Godot version the project uses. */
  godotVersion: () => Promise<string>;
}

async function godotVersion(engineJson: string): Promise<string> {
  const value = (await readJson<{ godot?: unknown }>(engineJson)).godot;
  if (typeof value !== 'string') throw new OgwError(`no godot version in ${engineJson}`);
  return value;
}

/** `open-game-works-core-impl/client/godot/`, in the core worktree when the command runs inside one. */
export async function coreProject(ctx: Context): Promise<MetaProject> {
  const repo = await resolveCoreImpl(await ctx.workspace(), ctx.cwd);
  const dir = join(repo, 'client', 'godot');
  return { repo, dir, areas: ['client/godot'], godotVersion: () => godotVersion(join(dir, 'engine.json')) };
}

/** `client/` of the game checkout; the Godot version comes from the core release `engine.json`. */
export async function gameProject(ctx: Context, name: string): Promise<MetaProject> {
  const game = await ctx.game(name);
  const engine = (await loadGameSettings(game.root)).engine;
  if (engine !== 'godot') throw new OgwError(`not defined: engine meta files of engine ${String(engine)}`);
  return {
    repo: game.root,
    dir: join(game.root, 'client'),
    areas: ['client', 'resource'],
    godotVersion: async () => {
      const client = await extractedAsset(ctx, await coreReleaseOfGame(ctx, game), 'client-godot.zip');
      return godotVersion(join(client, 'engine.json'));
    },
  };
}

const NOT_ENGINE: readonly string[] = ['.godot/', 'addons/', 'android/', 'ios/plugins/', 'plugins/'];

/** An engine meta file: a `.uid` or `.import` file. */
export function isMetaFile(path: string): boolean {
  return path.endsWith('.uid') || path.endsWith('.import');
}

/** Meta files `ogw generate` writes (`client-core` Godot `## engine meta file`), which `ogw meta sync` leaves alone. */
const GENERATED_META: readonly string[] = ['resource/resources.csv.import'];

/** A meta file of the project that `ogw meta sync` lines up with its source: not one `ogw generate` writes. */
export function isSyncedMeta(project: MetaProject, path: string): boolean {
  return isMetaFile(path) && isProjectFile(project, path) && !(project.areas.includes('resource') && GENERATED_META.includes(path));
}

/** The source file of a meta file: its path without `.uid` or `.import`. */
export function sourceOf(meta: string): string {
  return meta.replace(/\.(uid|import)$/, '');
}

/**
 * The path as the Godot project sees it (`res://` relative), or null when the project does not see it.
 * A game's `resource/` is seen through the `client/resource` link.
 */
export function projectPath(project: MetaProject, path: string): string | null {
  if (project.areas.includes('resource') && path.startsWith('resource/')) return path;
  const area = project.areas[0] as string;
  return path.startsWith(`${area}/`) ? path.slice(area.length + 1) : null;
}

/** Inside the project and not below `.godot/`, `addons/`, `android/`, `ios/plugins/`, `plugins/`. */
export function isProjectFile(project: MetaProject, path: string): boolean {
  const seen = projectPath(project, path);
  return seen !== null && !NOT_ENGINE.some((prefix) => seen.startsWith(prefix));
}

/**
 * An engine resource (`client-core` Godot `## engine meta file`): a non-meta file the project sees, other than the core
 * project's `engine.json`, which Godot does not read.
 */
export function isEngineResource(project: MetaProject, path: string): boolean {
  if (!project.areas.includes('resource') && projectPath(project, path) === 'engine.json') return false;
  return isProjectFile(project, path) && !isMetaFile(path);
}
