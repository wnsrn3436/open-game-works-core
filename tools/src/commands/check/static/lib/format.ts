/** Format arguments of text (`data` `### format`). */

export interface FormatArg {
  name: string;
  /** Formatter after `:`, or null. */
  formatter: string | null;
}

/** Format arguments of a text; input prompt tokens `{action:<action>}` are not format arguments. */
export function formatArgs(text: string): FormatArg[] {
  const out: FormatArg[] = [];
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
    const inner = m[1] as string;
    if (inner.startsWith('action:')) continue;
    const colon = inner.indexOf(':');
    out.push(colon === -1 ? { name: inner, formatter: null } : { name: inner.slice(0, colon), formatter: inner.slice(colon + 1) });
  }
  return out;
}

const PARTICLES = new Set(['은/는', '이/가', '을/를', '와/과', '으로/로']);

/** Value kinds a formatter accepts. */
export function acceptedKinds(formatter: string | null): Set<'integer' | 'real' | 'string'> {
  if (formatter === null || PARTICLES.has(formatter)) return new Set(['integer', 'real', 'string']);
  if (formatter === 'n') return new Set(['integer', 'real']);
  if (formatter === 'compact') return new Set(['integer', 'string']);
  if (formatter.startsWith('plural:')) return new Set(['integer', 'real']);
  if (['ordinal', 'date', 'datetime', 'duration'].includes(formatter)) return new Set(['integer']);
  return new Set();
}
