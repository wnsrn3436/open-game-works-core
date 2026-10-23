import { OgwError } from '../../../lib/errors.ts';
import { isPlainObject, type JsonObject } from '../../../lib/json.ts';
import type { GameSettings } from '../../../lib/settings.ts';
import type { SpecModule } from './core-spec.ts';

const ENV = '<ENV>';

/** Sub-schemas that apply at the same place: the schema, its `$ref` target, and `allOf`/`anyOf`/`oneOf` members. */
function applicable(schema: unknown, root: JsonObject, depth = 0): JsonObject[] {
  if (!isPlainObject(schema) || depth > 32) return [];
  const result: JsonObject[] = [schema];
  const ref = schema.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/')) {
    let target: unknown = root;
    for (const part of ref.slice(2).split('/')) target = isPlainObject(target) ? target[part] : undefined;
    result.push(...applicable(target, root, depth + 1));
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    const members = schema[keyword];
    if (Array.isArray(members)) for (const member of members) result.push(...applicable(member, root, depth + 1));
  }
  return result;
}

/** The schema `default` at a game settings path, or undefined when the schema gives none. */
export function schemaDefault(schema: JsonObject, segments: readonly string[]): unknown {
  let current = applicable(schema, schema);
  for (const segment of segments) {
    const next: JsonObject[] = [];
    for (const s of current) {
      const properties = s.properties;
      if (isPlainObject(properties) && segment in properties) next.push(...applicable(properties[segment], schema));
    }
    current = next;
  }
  for (const s of current) if ('default' in s) return s.default;
  return undefined;
}

/** The empty value of a spec settings type (`core` skill `## core settings`). */
export function emptyValue(type: string): unknown {
  if (type.endsWith('?')) return null;
  if (type === 'string') return '';
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return false;
  if (type === 'object') return {};
  if (type.startsWith('array<')) return [];
  throw new OgwError(`unknown settings type in core spec: ${type}`);
}

function valueAt(settings: unknown, segments: readonly string[]): unknown {
  let current = settings;
  for (const segment of segments) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** The keys of a settings row key: one per environment of game settings `environments` when it has `<ENV>`. */
function rowPaths(key: string, settings: GameSettings): string[] {
  return key.includes(ENV) ? Object.keys(settings.environments ?? {}).map((env) => key.replaceAll(ENV, env)) : [key];
}

/**
 * Core-read game settings values: every `source` `game` settings row of the used modules, keyed by game
 * settings path. A path with `<ENV>` gives one entry per environment of game settings `environments`.
 */
export function coreGameValues(modules: readonly SpecModule[], settings: GameSettings, schema: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const module of modules) {
    for (const row of module.settings) {
      if (row.source !== 'game') continue;
      for (const path of rowPaths(row.key, settings)) {
        if (path in result) continue;
        const segments = path.split('.');
        const given = valueAt(settings, segments);
        const fallback = schemaDefault(schema, segments);
        result[path] = given !== undefined ? given : fallback !== undefined ? fallback : emptyValue(row.type);
      }
    }
  }
  return result;
}

/**
 * The spec settings types of a core settings type file (`client-core` Godot `## module`): the `type` of every settings
 * row of `modules` by key, a key with `<ENV>` once per environment of game settings `environments`. A key that two rows
 * give different types fails.
 */
export function coreSettingTypes(modules: readonly SpecModule[], settings: GameSettings): Record<string, string> {
  const result: Record<string, string> = {};
  for (const module of modules) {
    for (const row of module.settings) {
      for (const path of rowPaths(row.key, settings)) {
        const known = result[path];
        if (known !== undefined && known !== row.type) throw new OgwError(`core spec settings key ${row.key} has type ${known} and, in ${module.name}, type ${row.type}`);
        result[path] = row.type;
      }
    }
  }
  return result;
}
