import { readdir, rename, rm, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readJson } from '../../../lib/fsx.ts';
import { loadGameSettings, type ToolDownload } from '../../../lib/settings.ts';
import { extractedAsset, publishedRelease } from '../../core/api.ts';
import { archiveKind, extractArchive, findFile } from './files.ts';
import { dataDir, safeSegment, type HostPlatform } from './host.ts';
import { installItem, makeRunnable, readMarker, type DownloadedFile, type InstallResult } from './install.ts';

export interface BuildTool {
  platform: string;
  hosts: string[];
  name: string;
  version: string;
  versionCommand: string;
  downloads?: ToolDownload[];
}

export interface EngineJson {
  downloads?: ToolDownload[];
  buildTools?: BuildTool[];
  [key: string]: unknown;
}

/** An `engine.json` and where it came from. */
export interface EngineSource {
  engine: string;
  version: string;
  json: EngineJson;
  /** `game <name>` (its core version release) or `open-game-works-core-impl`. */
  from: string;
  /** Game settings `buildPlatforms` of the game, for a game source. */
  buildPlatforms: string[] | null;
}

interface EngineAdapter {
  /** `engine.json` field holding the engine version. */
  versionField: string;
  /** Arguments that make the engine print its version. */
  versionArgs: string[];
  /** Places the checked downloads in `dir` and returns the executable path, or null when the download has none. */
  install(ctx: Context, version: string, files: DownloadedFile[], dir: string): Promise<string | null>;
}

/**
 * Folder where Godot looks for the self-contained mode file `_sc_` and keeps `editor_data/`: the folder that
 * holds `Godot.app` when the executable is `<name>.app/Contents/MacOS/<exe>` (writing into the signed bundle
 * breaks its code signature), otherwise the folder of the executable.
 */
export function godotDataRoot(exe: string): string {
  const exeDir = dirname(exe);
  const contents = dirname(exeDir);
  if (basename(exeDir) === 'MacOS' && basename(contents) === 'Contents') return dirname(dirname(contents));
  return exeDir;
}

/** The Godot editor executable of a download: the macOS bundle executable, or the Linux or Windows editor build. */
export function isGodotExecutable(name: string, rel: string): boolean {
  if (rel.endsWith('.app/Contents/MacOS/Godot')) return true;
  return name.startsWith('Godot_v') && (name.endsWith('.x86_64') || name.endsWith('_win64.exe'));
}

async function installGodot(ctx: Context, version: string, files: DownloadedFile[], dir: string): Promise<string | null> {
  const editor = files.filter((f) => f.download.platform !== 'any');
  const templates = files.filter((f) => f.download.platform === 'any');
  for (const f of editor) await extractArchive(f.file, join(dir, 'editor'), ctx.env);
  const exe = await findFile(join(dir, 'editor'), isGodotExecutable);
  if (exe === null) return null;
  // Self-contained mode: editor settings and export templates live in `editor_data/` of the data root.
  const root = godotDataRoot(exe);
  await writeFile(join(root, '_sc_'), '');
  for (const f of templates) {
    const unpacked = join(dir, 'templates-unpacked');
    await extractArchive(f.file, unpacked, ctx.env);
    const target = join(root, 'editor_data', 'export_templates', version);
    await mkdir(dirname(target), { recursive: true });
    await rename(join(unpacked, 'templates'), target);
    await rm(unpacked, { recursive: true, force: true });
  }
  return exe;
}

const ADAPTERS: Record<string, EngineAdapter> = {
  godot: { versionField: 'godot', versionArgs: ['--headless', '--version'], install: installGodot },
};

export function engineAdapter(engine: string): EngineAdapter {
  const adapter = ADAPTERS[engine];
  if (!adapter) throw new OgwError(`not defined: engine ${engine} (version field, install layout, version command)`);
  return adapter;
}

export function engineVersionOf(engine: string, json: EngineJson): string {
  const value = json[engineAdapter(engine).versionField];
  if (typeof value !== 'string' || value === '') throw new OgwError(`engine.json of ${engine} has no ${engineAdapter(engine).versionField} version`);
  return value;
}

/** An `engine.json` source that could not be read, and why. */
export interface EngineSourceFailure {
  /** `game <name>` or `open-game-works-core-impl/client/<engine>`. */
  from: string;
  reason: string;
}

export interface EngineSources {
  sources: EngineSource[];
  failures: EngineSourceFailure[];
}

/** The `engine.json` of a game's core version: the published release, whatever harness settings `useLocalCore` is. */
async function gameEngineSource(ctx: Context, root: string, name: string): Promise<EngineSource | null> {
  if (!exists(join(root, 'settings.json'))) return null;
  const settings = await loadGameSettings(root);
  const { engine, coreVersion } = settings;
  if (typeof engine !== 'string' || typeof coreVersion !== 'string') return null;
  const release = await publishedRelease(ctx, coreVersion);
  const dir = await extractedAsset(ctx, release, `client-${engine}.zip`);
  const json = await readJson<EngineJson>(join(dir, 'engine.json'));
  return { engine, version: engineVersionOf(engine, json), json, from: `game ${name}`, buildPlatforms: settings.buildPlatforms ?? [] };
}

async function gameEngineSources(ctx: Context, into: EngineSources): Promise<void> {
  const ws = await ctx.workspace();
  if (!exists(ws.games)) return;
  for (const entry of (await readdir(ws.games, { withFileTypes: true })).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const source = await gameEngineSource(ctx, join(ws.games, entry.name), entry.name);
      if (source) into.sources.push(source);
    } catch (error) {
      into.failures.push({ from: `game ${entry.name}`, reason: (error as Error).message });
    }
  }
}

async function coreImplEngineSources(ctx: Context, into: EngineSources): Promise<void> {
  const client = join((await ctx.workspace()).coreImpl, 'client');
  if (!exists(client)) return;
  for (const entry of (await readdir(client, { withFileTypes: true })).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(client, entry.name, 'engine.json');
    if (!exists(file)) continue;
    try {
      const json = await readJson<EngineJson>(file);
      into.sources.push({ engine: entry.name, version: engineVersionOf(entry.name, json), json, from: 'open-game-works-core-impl', buildPlatforms: null });
    } catch (error) {
      into.failures.push({ from: `open-game-works-core-impl/client/${entry.name}`, reason: (error as Error).message });
    }
  }
}

/**
 * Every `engine.json` whose engine and programs this host gets: the core version release of each game in
 * `games/`, and `open-game-works-core-impl/client/<engine>/engine.json`. A source that cannot be read is a failure
 * and does not stop the others.
 */
export async function engineSources(ctx: Context): Promise<EngineSources> {
  const result: EngineSources = { sources: [], failures: [] };
  await gameEngineSources(ctx, result);
  await coreImplEngineSources(ctx, result);
  return result;
}

export async function engineDir(ctx: Context, engine: string, version: string): Promise<string> {
  return join(await dataDir(ctx), 'engines', safeSegment(engine), safeSegment(version));
}

export async function buildToolDir(ctx: Context, name: string, version: string): Promise<string> {
  return join(await dataDir(ctx), 'build-tools', safeSegment(name), safeSegment(version));
}

/** Downloads of this host for an engine: the host platform and `any`. */
export function hostDownloads(downloads: readonly ToolDownload[] | undefined, platform: HostPlatform | null): ToolDownload[] {
  return (downloads ?? []).filter((d) => d.platform === platform || d.platform === 'any');
}

/** Installs an engine from `downloads`: the source's downloads of this host (`hostDownloads`). */
export async function installEngine(ctx: Context, source: EngineSource, downloads: ToolDownload[]): Promise<InstallResult> {
  const adapter = engineAdapter(source.engine);
  if (!downloads.some((d) => d.platform !== 'any')) return { installed: false, mismatches: [], reason: 'engine.json has no download for this host' };
  const dir = await engineDir(ctx, source.engine, source.version);
  return installItem({
    dir,
    name: source.engine,
    version: source.version,
    downloads,
    mismatchReason: 'SHA-256 differs from engine.json',
    notFoundReason: `${source.engine} executable not found in the download`,
    place: (files) => adapter.install(ctx, source.version, files, dir),
  });
}

/** `buildTools` of an engine.json that this host needs and can download. */
export function downloadableBuildTools(json: EngineJson, platform: HostPlatform | null): BuildTool[] {
  return (json.buildTools ?? []).filter((t) => platform !== null && t.hosts.includes(platform) && (t.downloads ?? []).length > 0);
}

/** Installs a build tool from `download`: its download of this host (`downloadFor`), or null when there is none. */
export async function installBuildTool(ctx: Context, tool: BuildTool, download: ToolDownload | null): Promise<InstallResult> {
  if (!download) return { installed: false, mismatches: [], reason: 'no download for this host' };
  const dir = await buildToolDir(ctx, tool.name, tool.version);
  const programName = tool.versionCommand.trim().split(/\s+/)[0] ?? '';
  return installItem({
    dir,
    name: tool.name,
    version: tool.version,
    downloads: [download],
    mismatchReason: 'SHA-256 differs from engine.json',
    notFoundReason: `program ${programName} not found in the download`,
    place: async ([downloaded]) => {
      const file = (downloaded as DownloadedFile).file;
      if (archiveKind(file) === null) return makeRunnable(file, ctx.env);
      await extractArchive(file, join(dir, 'files'), ctx.env);
      return findFile(join(dir, 'files'), (name) => name === programName || name === `${programName}.exe`);
    },
  });
}

/** Absolute path of the installed engine executable, or null. */
export async function installedEngine(ctx: Context, engine: string, version: string): Promise<string | null> {
  const dir = await engineDir(ctx, engine, version);
  const marker = await readMarker(dir);
  if (!marker || marker.version !== version) return null;
  return join(dir, marker.program);
}
