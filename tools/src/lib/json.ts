export type JsonObject = Record<string, unknown>;

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
