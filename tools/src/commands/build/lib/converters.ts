/**
 * The converter list file the contract tool generates (`contract` tool.md `## generation target`) and the
 * converters a PROD build added after the last PROD build (`build` `## build report` `## converters`).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { exists } from '../../../lib/fsx.ts';
import { showFile } from '../../../lib/git.ts';

export const CONVERTERS_FILE = 'server/generated/contract/converters.json';

export interface Converter {
  kind: string;
  fromVersion: number;
}

/** The entries of a converter list file text; an absent file is an empty list. */
export function parseConverters(text: string | null, where: string): Converter[] {
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OgwError(`${where}: not JSON`);
  }
  if (!Array.isArray(parsed)) throw new OgwError(`${where}: not a JSON array`);
  return parsed.map((item: unknown, i) => {
    const entry = item as { kind?: unknown; from_version?: unknown } | null;
    const kind = entry?.kind;
    const fromVersion = entry?.from_version;
    if (typeof kind !== 'string' || typeof fromVersion !== 'number' || !Number.isInteger(fromVersion)) {
      throw new OgwError(`${where}: entry ${String(i)} is not {"kind": <string>, "from_version": <integer>}`);
    }
    return { kind, fromVersion };
  });
}

/** The converter list of a checkout. */
export async function convertersOf(root: string): Promise<Converter[]> {
  const file = join(root, CONVERTERS_FILE);
  return parseConverters(exists(file) ? await readFile(file, 'utf8') : null, CONVERTERS_FILE);
}

/** The converter list at a commit of the game repo. */
export async function convertersAt(root: string, commit: string): Promise<Converter[]> {
  const bytes = await showFile(root, commit, CONVERTERS_FILE);
  return parseConverters(bytes === null ? null : bytes.toString('utf8'), `${commit}:${CONVERTERS_FILE}`);
}

/** Entries of `current` that `last` does not have, in the order of `current`. */
export function addedConverters(last: readonly Converter[], current: readonly Converter[]): Converter[] {
  const before = new Set(last.map((c) => `${c.kind}\0${String(c.fromVersion)}`));
  return current.filter((c) => !before.has(`${c.kind}\0${String(c.fromVersion)}`));
}
