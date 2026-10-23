import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readText } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { worktreeAdd } from '../../../lib/git.ts';
import { newId } from '../../../lib/ids.ts';
import { loadGameSettings } from '../../../lib/settings.ts';
import { runData } from '../api.ts';

/**
 * The data tool binary build of a checkout without `ogw generate` (the caller ran it or does not run it).
 * Throws `<headline>`, the tool's output lines and stderr when it fails.
 */
export async function binaryBuild(ctx: Context, game: GameRepo, headline = 'data tool binary build failed'): Promise<void> {
  const data = await runData(ctx, game, { binary: true, generate: false });
  if (data.exitCode === 0) return;
  const lines = data.lines.map((line) => line.text);
  throw new OgwError([headline, ...lines, data.stderr.trim()].filter((l) => l !== '').join('\n'));
}

export interface DataVersions {
  client: string;
  server: string;
  /** `server/build/data/client_data_version`, or '' when absent. */
  clientForServer: string;
  /** `server/build/data/compat_client_data_version`, or '' when absent. */
  compat: string;
}

async function readOr(path: string, fallback: string): Promise<string> {
  return exists(path) ? (await readText(path)).trim() : fallback;
}

/** Data versions in `client/build/data/` and `server/build/data/` of a checkout. */
export async function readDataVersions(root: string): Promise<DataVersions> {
  return {
    client: await readOr(join(root, 'client', 'build', 'data', 'data_version'), ''),
    server: await readOr(join(root, 'server', 'build', 'data', 'data_version'), ''),
    clientForServer: await readOr(join(root, 'server', 'build', 'data', 'client_data_version'), ''),
    compat: await readOr(join(root, 'server', 'build', 'data', 'compat_client_data_version'), ''),
  };
}

export interface CommitBuild {
  /** The worktree holding the binary build. */
  dir: string;
  versions: DataVersions;
}

/**
 * A binary build of the commit `rev` (named `label` in messages) in a new worktree under `worktrees/<game>/`, with the
 * data tool of the published release of that commit's core version, also with harness settings `useLocalCore`. It
 * runs no `ogw generate` and no comparison with the PROD data tag: the data of an older commit may lack what newer
 * PROD data has. The worktree is pushed to `made` once it exists; the caller removes it.
 */
export async function binaryBuildAt(ctx: Context, game: GameRepo, rev: string, label: string, made: string[]): Promise<CommitBuild> {
  const dir = join((await ctx.workspace()).worktrees, game.name, newId());
  await worktreeAdd(game.root, dir, rev, undefined, { env: ctx.env });
  made.push(dir);
  if (typeof (await loadGameSettings(dir)).coreVersion !== 'string') throw new OgwError(`no coreVersion in settings.json at ${label}`);
  const data = await runData(ctx, { ...game, root: dir, inWorktree: true }, { binary: true, generate: false, prodCompare: false, published: true });
  if (data.exitCode !== 0) {
    const output = [...data.lines.map((line) => line.text), data.stderr.trim()].filter((line) => line !== '');
    throw new OgwError([`binary build of ${label} failed (${String(data.exitCode)})`, ...output].join('\n'));
  }
  return { dir, versions: await readDataVersions(dir) };
}
