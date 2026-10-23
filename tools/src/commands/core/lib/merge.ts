function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Core settings overlay (`core` SKILL `## core settings`): objects merge key by key,
 * arrays and other values are replaced whole.
 */
export function overlay(base: unknown, top: unknown): unknown {
  if (!isObject(base) || !isObject(top)) return structuredClone(top);
  const out: Record<string, unknown> = structuredClone(base);
  for (const [key, value] of Object.entries(top)) out[key] = key in out ? overlay(out[key], value) : structuredClone(value);
  return out;
}
