export type JsonObject = Record<string, unknown>;

/** A settings path split into keys. A core settings key is one segment although it holds `.`. */
export type Segments = readonly string[];

const INDEX = /^(0|[1-9][0-9]*)$/;

/** True when `segment` is an array index. */
export function isIndex(segment: string): boolean {
  return INDEX.test(segment);
}

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `override` over `base`: object values merge key by key, arrays and other values are replaced whole
 * (game settings `core` over core settings, `core` skill `## core settings`).
 */
export function mergeSettings(base: JsonObject, override: JsonObject): JsonObject;
export function mergeSettings(base: unknown, override: unknown): unknown;
export function mergeSettings(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return structuredClone(override);
  const out: JsonObject = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    out[key] = Object.hasOwn(out, key) ? mergeSettings(out[key], value) : structuredClone(value);
  }
  return out;
}

/**
 * The units of `value`: the paths into it that go down through objects only, so an array or another value is one
 * unit. An empty object holds no unit.
 */
export function valueUnits(value: unknown, prefix: Segments = []): string[][] {
  if (!isPlainObject(value)) return [[...prefix]];
  return Object.entries(value).flatMap(([key, child]) => valueUnits(child, [...prefix, key]));
}
