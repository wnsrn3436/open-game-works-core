import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readJson, readJsonIfExists } from '../../../lib/fsx.ts';
import type { Context } from '../../../lib/command.ts';
import { resolveCoreImpl } from '../../../lib/game.ts';
import { git } from '../../../lib/git.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { byteCompare } from '../../../lib/order.ts';

/** A plugin of `engine.json` `plugins`. */
export interface EnginePlugin {
  name: string;
  version?: string;
  platforms?: string[];
  url?: string;
  sha256?: string;
  [key: string]: unknown;
}

export interface EngineDownload {
  platform?: string;
  url?: string;
  sha256?: string;
  [key: string]: unknown;
}

/** The `gut` item of `engine.json`: the GUT zip. */
export interface EngineGut {
  version?: string;
  url?: string;
  sha256?: string;
  [key: string]: unknown;
}

/** `open-game-works-core-impl/client/<engine>/engine.json` (Godot: `godot` `## engine version`). */
export interface EngineJson {
  godot?: string;
  gut?: EngineGut;
  downloads?: EngineDownload[];
  plugins?: EnginePlugin[];
  buildTools?: { downloads?: EngineDownload[]; [key: string]: unknown }[];
  [key: string]: unknown;
}

/** One `core-spec/<module>.json` object (`core` command.md `## core spec file`). */
export interface CoreSpecModule {
  name: string;
  side: 'client' | 'server';
  dependencies: string[];
  optionalDependencies: string[];
  devDependencies: string[];
  settings: { key: string; type: string; source: string; owner: string }[];
  settingsConstraints: SettingsConstraint[];
  collectedData: { source: string; [key: string]: unknown }[];
  adapters: string[];
  [key: string]: unknown;
}

export interface SettingsConstraint {
  left: string;
  factor: number;
  right: string;
}

export function enginePath(implDir: string, engine: string): string {
  return join(implDir, 'client', engine);
}

/** Engines with `client/<engine>/engine.json`, in byte order. */
export async function enginesOf(implDir: string): Promise<string[]> {
  const client = join(implDir, 'client');
  if (!exists(client)) return [];
  const entries = await readdir(client, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && exists(join(client, entry.name, 'engine.json')))
    .map((entry) => entry.name)
    .sort(byteCompare);
}

export async function readEngineJson(implDir: string, engine: string): Promise<EngineJson> {
  const value = await readJson<EngineJson>(join(enginePath(implDir, engine), 'engine.json'));
  if (typeof value !== 'object' || Array.isArray(value)) throw new OgwError(`engine.json of ${engine} is not an object`);
  return value;
}

export function corePlugins(engineJson: EngineJson): EnginePlugin[] {
  return (engineJson.plugins ?? []).filter((plugin) => plugin.name.startsWith('ogw-'));
}

/** The core implementation folder of this command: the `worktrees/_core/` worktree it runs in, or `open-game-works-core-impl/`. */
export async function coreImplOf(ctx: Context): Promise<string> {
  return resolveCoreImpl(await ctx.workspace(), ctx.cwd, ctx.env);
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function asModule(value: unknown, file: string): CoreSpecModule {
  const m = value as Partial<CoreSpecModule> | null;
  const ok =
    m !== null &&
    typeof m === 'object' &&
    typeof m.name === 'string' &&
    (m.side === 'client' || m.side === 'server') &&
    stringList(m.dependencies) &&
    stringList(m.optionalDependencies) &&
    stringList(m.devDependencies);
  if (!ok) throw new OgwError(`${file}: not a core-spec module object`);
  return m as CoreSpecModule;
}

/**
 * `core-spec/*.json` of the checkout, ordered by module name bytes. A missing `core-spec/` folder gives no module, or
 * fails with `required`. With `skipInvalid`, a file that is not a module object is left out instead of failing.
 */
export async function readCoreSpecDir(implDir: string, options: { required?: boolean; skipInvalid?: boolean } = {}): Promise<CoreSpecModule[]> {
  const dir = join(implDir, 'core-spec');
  if (!exists(dir)) {
    if (options.required === true) throw new OgwError(`core-spec folder not found: ${dir}`);
    return [];
  }
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  const modules: CoreSpecModule[] = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      modules.push(asModule(await readJson(file), file));
    } catch (error) {
      if (options.skipInvalid !== true) throw error;
    }
  }
  return modules.sort((a, b) => byteCompare(a.name, b.name));
}

/** Folder of the build result of a `ogw-` plugin for one platform, relative to `open-game-works-core-impl/`. */
export function pluginDistDir(engine: string, plugin: string, platform: string): string {
  return `client/${engine}/plugins/${plugin}/dist/${platform}/`;
}

/** `open-game-works-core-impl/settings/core-settings.json`, or null when there is none. */
export async function readCoreSettings(implDir: string): Promise<Record<string, unknown> | null> {
  return readJsonIfExists<Record<string, unknown>>(join(implDir, 'settings', 'core-settings.json'));
}

/**
 * Process time limit of one engine core test run: core settings `UnitTestCore.runTimeLimitMs` (or the program time
 * limit without it) plus a startup allowance. The engine timer of `runTimeLimitMs` starts after engine boot and test
 * framework load and sends the partial result when it ends, so the process limit leaves it that time.
 */
export async function unitTestProcessLimit(implDir: string): Promise<number> {
  const value = (await readCoreSettings(implDir))?.['UnitTestCore.runTimeLimitMs'];
  return (typeof value === 'number' ? value : LIMITS.programMs) + LIMITS.shortMs;
}

/**
 * Files below `relDir` of the checkout's working tree that git tracks or would track
 * (untracked files not ignored), relative to the checkout root with `/`.
 */
export async function workingFiles(root: string, relDir: string): Promise<string[]> {
  const out = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', relDir]);
  const files = out.split('\0').filter((line) => line.length > 0);
  return [...new Set(files)].filter((file) => exists(join(root, file))).sort(byteCompare);
}

/** snake_case of a PascalCase client module name: `UICore` -> `ui_core`. */
export function moduleFolder(module: string): string {
  return module
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/** Platform name of this host OS for `engine.json` plugin targets. */
export function hostPlatform(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}
