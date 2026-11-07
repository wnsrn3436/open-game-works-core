import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { exists } from '../../../lib/fsx.ts';
import { FILE_IO, pooled } from '../../../lib/pool.ts';
import { coreReleaseOfGame, extractedAsset } from '../../core/api.ts';
import { absence, at, finding, folderOf, type Finding, type StaticContext } from './lib/context.ts';
import { gameEngine } from './lib/engine.ts';

/**
 * core diff: `client/core/` and `server/core/` differ from the game's core version release (the `core/` folder of
 * `client-<engine>.zip`, which `ogw generate` mirrors to `client/core/`, and `server.tgz`), or from the assets built
 * from `open-game-works-core-impl/` when harness settings `useLocalCore` is true.
 */
export const NAME = 'core diff';

/** Files below a folder, relative with `/`. */
export async function walk(dir: string): Promise<string[]> {
  if (!exists(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort();
}

/** Differences between a game folder and the release folder, one finding per file, in file order; files are compared several at a time. */
export async function compareFolders(gameDir: string, releaseDir: string, label: string, version: string): Promise<Finding[]> {
  const [gameFiles, releaseFiles] = await Promise.all([walk(gameDir), walk(releaseDir)]);
  const releaseSet = new Set(releaseFiles);
  const gameSet = new Set(gameFiles);
  const found = await pooled([...new Set([...gameFiles, ...releaseFiles])].sort(), FILE_IO, async (rel): Promise<Finding | null> => {
    const where = at(`${label}${rel}`, 1);
    if (!gameSet.has(rel)) return absence(NAME, folderOf(`${label}${rel}`), `${label}${rel} missing; core ${version} has it`);
    if (!releaseSet.has(rel)) return finding(NAME, where, `not in core ${version}`);
    const [a, b] = await Promise.all([readFile(join(gameDir, rel)), readFile(join(releaseDir, rel))]);
    return a.equals(b) ? null : finding(NAME, where, `differs from core ${version}`);
  });
  return found.filter((f): f is Finding => f !== null);
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const engine = await gameEngine(sc);
  const release = await coreReleaseOfGame(sc.ctx, sc.game);
  const version = release.local ? `${release.version} (open-game-works-core-impl)` : release.version;
  const [client, server] = await Promise.all([
    extractedAsset(sc.ctx, release, `client-${engine}.zip`),
    extractedAsset(sc.ctx, release, 'server.tgz'),
  ]);
  const results = await Promise.all([
    compareFolders(join(sc.root, 'client', 'core'), join(client, 'core'), 'client/core/', version),
    compareFolders(join(sc.root, 'server', 'core'), server, 'server/core/', version),
  ]);
  return results.flat();
}
