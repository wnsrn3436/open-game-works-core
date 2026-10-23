import { cp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { exists, formatJson, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import { sha256File, writeTgz, writeZip, type ArchiveEntry } from './archive.ts';
import {
  corePlugins,
  enginesOf,
  pluginDistDir,
  readCoreSpecDir,
  readEngineJson,
  workingFiles,
  type EngineJson,
} from './impl.ts';
import { readCoreSchemaVersion } from './manifest.ts';
import { isServerCoreTest } from './server-layout.ts';
import { implementedTools, stageToolPackage, type ToolName } from './tools.ts';
import { engineAssetRules } from './undefined.ts';
import { byteCompare } from '../../../lib/order.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';

/** `manifest.json` of a core release. */
export interface Manifest {
  version: string;
  /** SHA-256 (lower-case hex) of every asset other than `manifest.json`. */
  assets: Record<string, string>;
  coreSchemaVersion: number;
}

export interface BuildOptions {
  /** Release URL of an asset. When given, `ogw-` plugin entries get the URL and SHA-256 of the plugins zip. */
  assetUrl?: (asset: string) => string;
  /** Environment of the tool builds (`npm`); the process environment when not given. */
  env?: NodeJS.ProcessEnv;
}

export interface BuiltAssets {
  manifest: Manifest;
  /** `engine.json` text per engine as it went into `client-<engine>.zip`. */
  engineJson: Map<string, string>;
}

function relBelow(file: string, prefix: string): string {
  return file.slice(prefix.length);
}

/** `core-spec.json`: `core-spec/` merged in module name byte order. */
async function writeCoreSpecJson(implDir: string, version: string, outDir: string): Promise<boolean> {
  if (!exists(join(implDir, 'core-spec'))) return false;
  const modules = await readCoreSpecDir(implDir);
  await writeJsonAtomic(join(outDir, 'core-spec.json'), { version, modules });
  await writeJsonAtomic(
    join(outDir, 'core-settings-constraints.json'),
    modules.flatMap((module) => module.settingsConstraints),
  );
  return true;
}

async function copyIfExists(source: string, target: string): Promise<boolean> {
  if (!exists(source)) return false;
  await cp(source, target);
  return true;
}

/** `client-godot-plugins.zip`: `plugins/<plugin>/dist/<platform>/` as `<plugin>/<platform>/`. */
async function godotPluginsZip(implDir: string, engineJson: EngineJson, outFile: string): Promise<void> {
  const entries: ArchiveEntry[] = [];
  for (const plugin of corePlugins(engineJson)) {
    for (const platform of plugin.platforms ?? []) {
      const prefix = pluginDistDir('godot', plugin.name, platform);
      for (const file of await workingFiles(implDir, prefix)) {
        entries.push({ name: `${plugin.name}/${platform}/${relBelow(file, prefix)}`, source: join(implDir, file) });
      }
    }
  }
  await writeZip(outFile, entries);
}

/** `client-godot.zip`: `core/` without `core/<module folder>/tests/`, and `engine.json`. */
async function godotClientZip(implDir: string, engineJsonFile: string, outFile: string): Promise<void> {
  const prefix = 'client/godot/';
  const entries: ArchiveEntry[] = [{ name: 'engine.json', source: engineJsonFile }];
  for (const file of await workingFiles(implDir, `${prefix}core/`)) {
    const name = relBelow(file, prefix);
    if (name.split('/')[2] === 'tests') continue;
    entries.push({ name, source: join(implDir, file) });
  }
  await writeZip(outFile, entries);
}

async function engineAssets(
  implDir: string,
  engine: string,
  work: string,
  outDir: string,
  options: BuildOptions,
): Promise<string> {
  if (engine !== 'godot') engineAssetRules(engine);
  const engineJson = await readEngineJson(implDir, engine);
  if (corePlugins(engineJson).length > 0) {
    const asset = `client-${engine}-plugins.zip`;
    await godotPluginsZip(implDir, engineJson, join(outDir, asset));
    if (options.assetUrl) {
      const sha256 = await sha256File(join(outDir, asset));
      for (const plugin of corePlugins(engineJson)) {
        plugin.url = options.assetUrl(asset);
        plugin.sha256 = sha256;
      }
    }
  }
  const text = formatJson(engineJson);
  const engineJsonFile = join(work, `engine-${engine}.json`);
  await writeFileAtomic(engineJsonFile, text);
  await godotClientZip(implDir, engineJsonFile, join(outDir, `client-${engine}.zip`));
  return text;
}

async function folderZip(implDir: string, relDir: string, outFile: string): Promise<boolean> {
  if (!exists(join(implDir, relDir))) return false;
  const prefix = `${relDir}/`;
  const files = await workingFiles(implDir, prefix);
  await writeZip(outFile, files.map((file) => ({ name: relBelow(file, prefix), source: join(implDir, file) })));
  return true;
}

async function serverTgz(implDir: string, outFile: string): Promise<boolean> {
  if (!exists(join(implDir, 'server', 'core'))) return false;
  const prefix = 'server/core/';
  const names = (await workingFiles(implDir, prefix)).map((file) => relBelow(file, prefix)).filter((name) => !isServerCoreTest(name));
  await writeTgz(outFile, join(implDir, 'server', 'core'), names);
  return true;
}

async function filesBelow(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) out.push(...(await filesBelow(join(dir, entry.name), `${name}/`)));
    else out.push(name);
  }
  return out;
}

async function toolTgz(env: NodeJS.ProcessEnv, implDir: string, tool: ToolName, work: string, outFile: string): Promise<void> {
  const stage = join(work, tool);
  await stageToolPackage(env, implDir, tool, stage);
  if (exists(join(implDir, 'proto'))) await cp(join(implDir, 'proto'), join(stage, 'proto'), { recursive: true });
  await writeTgz(outFile, stage, (await filesBelow(stage)).sort(byteCompare));
}

async function writeManifest(implDir: string, version: string, outDir: string): Promise<Manifest> {
  const names = (await readdir(outDir)).filter((name) => name !== 'manifest.json').sort(byteCompare);
  const assets: Record<string, string> = {};
  for (const name of names) assets[name] = await sha256File(join(outDir, name));
  const manifest: Manifest = { version, assets, coreSchemaVersion: await readCoreSchemaVersion(implDir) };
  await writeJsonAtomic(join(outDir, 'manifest.json'), manifest);
  return manifest;
}

/**
 * Builds the release assets of `open-game-works-core-impl/` (`core` command.md `## version and release`) from
 * its working tree into `outDir`, the assets that exist for this checkout.
 */
export async function buildAssets(implDir: string, version: string, outDir: string, options: BuildOptions = {}): Promise<BuiltAssets> {
  const work = await newPrivateTempFolder('ogw-core-assets-', options.env ?? process.env);
  try {
    const engineJson = new Map<string, string>();
    for (const engine of await enginesOf(implDir)) {
      engineJson.set(engine, await engineAssets(implDir, engine, work, outDir, options));
      await folderZip(implDir, `benchmark/${engine}`, join(outDir, `benchmark-${engine}.zip`));
    }
    await serverTgz(implDir, join(outDir, 'server.tgz'));
    for (const tool of implementedTools(implDir)) {
      await toolTgz(options.env ?? process.env, implDir, tool, work, join(outDir, `${tool}.tgz`));
    }
    await copyIfExists(join(implDir, 'settings', 'core-settings.json'), join(outDir, 'core-settings.json'));
    await copyIfExists(join(implDir, 'settings', 'core-settings.schema.json'), join(outDir, 'core-settings.schema.json'));
    await writeCoreSpecJson(implDir, version, outDir);
    await copyIfExists(join(implDir, 'licenses.json'), join(outDir, 'licenses.json'));
    const manifest = await writeManifest(implDir, version, outDir);
    return { manifest, engineJson };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
