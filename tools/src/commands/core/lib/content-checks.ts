import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { exists, readJsonIfExists } from '../../../lib/fsx.ts';
import { enginesOf, readEngineJson } from './impl.ts';
import { requiredTextIds } from './spec-licenses.ts';
import { byteCompare } from '../../../lib/order.ts';

interface LicenseFile {
  components?: { name?: unknown; license?: unknown }[];
  texts?: Record<string, unknown> | null;
}

/**
 * The `licenses.json` check of `ogw core test` (`core` command.md `## license manifest`). The `texts` keys it
 * needs are the ones `ogw core licenses` writes (`requiredTextIds`).
 */
export async function licenseErrors(implDir: string, harness: string): Promise<string[]> {
  const file = await readJsonIfExists<LicenseFile>(join(implDir, 'licenses.json')).catch(() => null);
  if (!file || !Array.isArray(file.components) || typeof file.texts !== 'object' || file.texts === null) return ['licenses.json is missing or invalid'];
  const errors: string[] = [];
  const names = new Set(file.components.map((c) => c.name));
  for (const engine of await enginesOf(implDir)) {
    // a `ogw-` plugin is core code: its SDKs have components, the plugin itself none
    for (const plugin of (await readEngineJson(implDir, engine)).plugins ?? []) {
      if (plugin.name.startsWith('ogw-')) {
        if (names.has(plugin.name)) errors.push(`licenses.json has a component named ${plugin.name}, an ogw- plugin of core code (engine.json plugins of ${engine})`);
      } else if (!names.has(plugin.name)) errors.push(`licenses.json has no component named ${plugin.name} (engine.json plugins of ${engine})`);
    }
  }
  const licenses = file.components.flatMap((c) => (typeof c.license === 'string' ? [c.license] : []));
  for (const id of await requiredTextIds(licenses, harness)) if (!(id in file.texts)) errors.push(`licenses.json texts has no ${id}`);
  return errors;
}

const ID_NAME = /^\[[a-z0-9_]+\]$/;

/** Strings anywhere in a JSON value whose whole value is an ID name. */
export function idNamesIn(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    if (ID_NAME.test(value)) out.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) idNamesIn(item, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) idNamesIn(item, out);
  }
  return out;
}

/**
 * The core test fixture ID name check (`core` command.md `## test`). `known` holds the ID names the core
 * test data build issued: every table `id` row and every `requirement` row the data tool made.
 */
export async function fixtureIdErrors(implDir: string, known: ReadonlySet<string>): Promise<string[]> {
  const dir = join(implDir, 'fixtures');
  if (!exists(dir)) return [];
  const errors: string[] = [];
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.json')).sort(byteCompare)) {
    const fixture = await readJsonIfExists<{ cases?: { input?: unknown; expected?: unknown }[] }>(join(dir, file)).catch(() => null);
    const names = new Set<string>();
    for (const c of fixture?.cases ?? []) {
      idNamesIn(c.input, names);
      idNamesIn(c.expected, names);
    }
    for (const name of [...names].sort(byteCompare)) {
      if (!known.has(name)) errors.push(`fixture ${file.slice(0, -'.json'.length)}: ${name} is not in the core test data`);
    }
  }
  return errors;
}
