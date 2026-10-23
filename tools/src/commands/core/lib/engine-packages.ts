// GUT and the plugins of `engine.json` whose name does not start with `ogw-` (`client-core` Godot `## engine version`).
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists } from '../../../lib/fsx.ts';
import { withLock } from '../../../lib/lock.ts';
import { sha256File } from '../../env/lib/files.ts';
import { dataDir } from '../../env/lib/host.ts';
import { net } from '../../env/lib/net.ts';
import { extractArchive } from './archive.ts';
import type { EngineJson, EnginePlugin } from './impl.ts';

/** An `engine.json` item the harness tool downloads: `gut`, or a `plugins` item not named `ogw-`. */
export interface EnginePackage {
  name: string;
  url?: unknown;
  sha256?: unknown;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** True for a `plugins` item built by the core agent (its files come from `client-<engine>-plugins.zip`). */
export function isCorePlugin(plugin: EnginePlugin): boolean {
  return plugin.name.startsWith('ogw-');
}

/** `plugins` items whose `platforms` hold `platform`, in `engine.json` order. */
export function pluginsFor(engineJson: EngineJson, platform: string): EnginePlugin[] {
  return (engineJson.plugins ?? []).filter((plugin) => Array.isArray(plugin.platforms) && plugin.platforms.includes(platform));
}

/** The `gut` item of `engine.json` as a package named `gut`. */
export function gutPackage(engineJson: EngineJson): EnginePackage {
  const gut: unknown = engineJson.gut;
  if (typeof gut !== 'object' || gut === null || Array.isArray(gut)) throw new OgwError('engine.json has no gut item');
  return { ...gut, name: 'gut' };
}

function pinned(item: EnginePackage): { url: string; sha256: string } {
  const url = typeof item.url === 'string' ? item.url : '';
  const sha256 = typeof item.sha256 === 'string' ? item.sha256 : '';
  if (url === '' || !SHA256.test(sha256)) {
    throw new OgwError(`engine.json item ${item.name} has no url or sha256. Run ogw core pin-engine`);
  }
  return { url, sha256 };
}

/**
 * The project root inside an extracted zip: the zip root, or its one folder when the root holds that folder alone and
 * no `addons/` (a GitHub tag archive wraps everything in `<repo>-<tag>/`).
 */
export async function zipProjectRoot(files: string): Promise<string> {
  const entries = await readdir(files, { withFileTypes: true });
  const only = entries[0];
  if (entries.length !== 1 || only === undefined || !only.isDirectory()) return files;
  // a wrapper folder (a tag archive) holds the project root folders; a project root path such as `ios/` is no wrapper
  const inside = join(files, only.name);
  return ['addons', 'ios', 'android'].some((name) => exists(join(inside, name))) ? inside : files;
}

/**
 * Folder with the contents of the zip of a package, downloaded once into the host data folder and
 * checked against its `sha256`. Paths below it are relative to the engine project root (`zipProjectRoot`).
 */
export async function packageDir(ctx: Context, item: EnginePackage): Promise<string> {
  const { url, sha256 } = pinned(item);
  const base = join(await dataDir(ctx), 'engine-packages', sha256);
  const files = join(base, 'files');
  if (exists(files)) return zipProjectRoot(files);
  await mkdir(base, { recursive: true });
  await withLock(join(base, 'lock'), async () => {
    if (exists(files)) return;
    const zip = join(base, 'download.zip');
    try {
      await net().download(url, zip);
      const actual = await sha256File(zip);
      if (actual !== sha256) throw new OgwError(`SHA-256 of ${item.name} from ${url} is ${actual}, not ${sha256}`);
      await extractArchive(zip, files);
    } finally {
      await rm(zip, { force: true });
    }
  });
  return zipProjectRoot(files);
}

/** Copies the files of a package into the engine project, keeping their project-root paths. */
export async function installPackage(ctx: Context, item: EnginePackage, projectDir: string): Promise<void> {
  await cp(await packageDir(ctx, item), projectDir, { recursive: true });
}
