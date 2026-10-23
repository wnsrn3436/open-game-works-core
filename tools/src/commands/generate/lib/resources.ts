import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { exists } from '../../../lib/fsx.ts';
import { isPlainObject } from '../../../lib/json.ts';
import { parseTable } from '../../data/lib/csv.ts';
import { engineType, isEngineType } from '../../resource/lib/godot.ts';
import { compareBytes } from './core-spec.ts';

export interface ResourceRow {
  key: string;
  spec: string;
  license: string;
  source: string;
  attribution: string;
}

export function readResourceRows(text: string | null, file: string): ResourceRow[] {
  if (text === null) return [];
  return parseTable(text, file).rows.map(({ values }) => ({
    key: values.key ?? '',
    spec: values.spec ?? '',
    license: values.license ?? '',
    source: values.source ?? '',
    attribution: values.attribution ?? '',
  }));
}

/** `variants` of a `spec` cell; 1 when absent (`resource` skill `### spec`). */
export function variantCount(spec: string): number {
  for (const item of spec.split(';')) {
    const [name, value] = item.split('=');
    if (name === 'variants') {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 1) throw new OgwError(`invalid variants in spec: ${spec}`);
      return count;
    }
  }
  return 1;
}

/**
 * File extension of a resource key in the Godot project (`engineType`). For a type with several extensions (`font`),
 * the extension of the file that exists.
 */
export function godotExtension(key: string, resourceDir: string): string {
  const type = key.slice(0, key.indexOf('/'));
  if (!isEngineType('godot', type)) throw new OgwError(`unknown resource type in key ${key}`);
  const extensions = engineType('godot', type).extensions;
  if (extensions.length === 1) return extensions[0] as string;
  for (const ext of extensions) if (exists(join(resourceDir, `${key}${ext}`))) return ext;
  throw new OgwError(`no ${extensions.join(' or ')} file for resource key ${key}`);
}

/** One value of the resource key list file. */
export interface ResourceKeyEntry {
  path: string;
  variants: number;
}

/**
 * `res://generated/resource_keys.json`: resource key → `{"path": "res://resource/<key>.<extension>", "variants": n}`,
 * in `resources.csv` row order. `n` is the `spec` `variants`, 1 when absent.
 */
export function godotResourceKeys(rows: readonly ResourceRow[], resourceDir: string): Record<string, ResourceKeyEntry> {
  const result: Record<string, ResourceKeyEntry> = {};
  for (const row of rows) {
    result[row.key] = { path: `res://resource/${row.key}${godotExtension(row.key, resourceDir)}`, variants: variantCount(row.spec) };
  }
  return result;
}

/** Engine paths of the files of a resource key list value: `path`, or for 2 or more variants `<path without extension>.<n>.<extension>`. */
export function resourceKeyPaths(entry: ResourceKeyEntry): string[] {
  if (entry.variants < 2) return [entry.path];
  const dot = entry.path.lastIndexOf('.');
  const paths: string[] = [];
  for (let n = 1; n <= entry.variants; n++) paths.push(`${entry.path.slice(0, dot)}.${String(n)}${entry.path.slice(dot)}`);
  return paths;
}

/** Name of the resource key constant: the key in upper case with `/` replaced by `__`. */
export function resourceKeyConstant(key: string): string {
  return key.toUpperCase().replaceAll('/', '__');
}

function constants(keys: readonly string[]): [string, string][] {
  const named = new Map<string, string>();
  for (const key of [...keys].sort(compareBytes)) {
    const name = resourceKeyConstant(key);
    const other = named.get(name);
    if (other !== undefined) throw new OgwError(`resource keys ${other} and ${key} have the same constant name ${name}`);
    named.set(name, key);
  }
  return [...named];
}

/** `res://generated/resource_key.gd`: `class_name ResourceKey` with one `String` constant per resource key. */
export function resourceKeyGd(keys: readonly string[]): string {
  const lines = constants(keys).map(([name, key]) => `const ${name}: String = ${JSON.stringify(key)}`);
  return `class_name ResourceKey\nextends RefCounted\n${lines.length > 0 ? `\n${lines.join('\n')}\n` : ''}`;
}

/** `server/generated/resource_key.ts`: one exported `string` constant per resource key. */
export function resourceKeyTs(keys: readonly string[]): string {
  const lines = constants(keys).map(([name, key]) => `export const ${name}: string = ${JSON.stringify(key)};\n`);
  return lines.length > 0 ? lines.join('') : 'export {};\n';
}

export interface LicenseComponent {
  name: string;
  version: string;
  license: string;
  url: string;
  notice: string;
  platforms: string[];
  modules: string[];
}

export interface LicenseManifest {
  components: LicenseComponent[];
  texts: Record<string, string>;
}

function parseManifest(value: unknown, file: string): LicenseManifest {
  const manifest = value as Partial<LicenseManifest> | null;
  if (!isPlainObject(manifest) || !Array.isArray(manifest.components) || !isPlainObject(manifest.texts)) {
    throw new OgwError(`invalid license manifest: ${file}`);
  }
  return manifest as LicenseManifest;
}

/** The game's license manifest (`core` skill `command.md` `## license manifest`). */
export function gameLicenses(
  release: unknown,
  file: string,
  usedModules: ReadonlySet<string>,
  rows: readonly ResourceRow[],
  buildPlatforms: readonly string[],
): LicenseManifest {
  const core = parseManifest(release, file);
  const components = core.components.filter(
    (c) => c.modules.length === 0 || c.modules.some((m) => usedModules.has(m)),
  );
  const groups = new Map<string, { keys: string[]; row: ResourceRow }>();
  for (const row of rows) {
    if (row.attribution === '') continue;
    const id = JSON.stringify([row.attribution, row.license, row.source]);
    const group = groups.get(id) ?? { keys: [], row };
    group.keys.push(row.key);
    groups.set(id, group);
  }
  const resourceComponents = [...groups.values()].map(
    ({ keys, row }): LicenseComponent => ({
      name: keys.sort(compareBytes).join(', '),
      version: '',
      license: row.license,
      url: row.source,
      notice: row.attribution,
      platforms: [...buildPlatforms],
      modules: [],
    }),
  );
  resourceComponents.sort((a, b) => compareBytes(a.name, b.name));
  return { components: [...components, ...resourceComponents], texts: core.texts };
}
