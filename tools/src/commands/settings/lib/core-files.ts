import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readJson } from '../../../lib/fsx.ts';
import { coreRelease } from '../../core/api.ts';
import { requireSupportedCore } from '../../core/lib/harness-core.ts';
import { isPlainObject, type JsonObject } from './json-path.ts';

export interface SettingsConstraint {
  left: string;
  factor: number;
  right: string;
}

export interface SpecModule {
  name: string;
  side: string;
  /** Modules only the module's DEV code depends on. */
  devDependencies?: string[];
  settingsConstraints?: SettingsConstraint[];
}

/** The core release files that settings commands read. */
export interface CoreFiles {
  version: string;
  /** `core-settings.json`: core settings default values. */
  settings: JsonObject;
  /** `core-settings.schema.json`. */
  schema: JsonObject;
  /** `core-settings-constraints.json`. */
  constraints: SettingsConstraint[];
  /** `modules` of `core-spec.json`. */
  modules: SpecModule[];
}

/** The JSON object in the file; fails when the file holds another JSON value. */
export async function readObject(path: string): Promise<JsonObject> {
  const value = await readJson(path);
  if (!isPlainObject(value)) throw new OgwError(`not a JSON object: ${path}`);
  return value;
}

async function readArray<T>(path: string): Promise<T[]> {
  const value = await readJson(path);
  if (!Array.isArray(value)) throw new OgwError(`not a JSON array: ${path}`);
  return value as T[];
}

/**
 * Core settings defaults, schema, constraints and modules of the core release `version`, the `coreVersion` of the game
 * settings of `game`, which this harness must support (AGENTS.md `## repo`).
 */
export async function coreFiles(ctx: Context, version: string, game = 'the game'): Promise<CoreFiles> {
  await requireSupportedCore(ctx, game, version);
  const release = await coreRelease(ctx, version);
  const spec = await readObject(join(release.dir, 'core-spec.json'));
  return {
    version,
    settings: await readObject(join(release.dir, 'core-settings.json')),
    schema: await readObject(join(release.dir, 'core-settings.schema.json')),
    constraints: await readArray<SettingsConstraint>(join(release.dir, 'core-settings-constraints.json')),
    modules: Array.isArray(spec.modules) ? (spec.modules as SpecModule[]) : [],
  };
}

/** Settings constraints of the module files in `open-game-works-core-impl/core-spec/`; none when the folder is missing. */
export async function implConstraints(coreImpl: string): Promise<SettingsConstraint[]> {
  const dir = join(coreImpl, 'core-spec');
  if (!exists(dir)) return [];
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  const out: SettingsConstraint[] = [];
  for (const file of files) {
    const module = await readObject(join(dir, file));
    if (Array.isArray(module.settingsConstraints)) out.push(...(module.settingsConstraints as SettingsConstraint[]));
  }
  return out;
}

/** Keys of a core settings schema. */
export function coreKeys(schema: JsonObject): string[] {
  return isPlainObject(schema.properties) ? Object.keys(schema.properties) : [];
}

/** The longest key that equals `text` or that `text` starts with followed by `.`. */
export function matchCoreKey(keys: readonly string[], text: string): string | null {
  let best: string | null = null;
  for (const key of keys) {
    if ((text === key || text.startsWith(`${key}.`)) && (best === null || key.length > best.length)) best = key;
  }
  return best;
}
