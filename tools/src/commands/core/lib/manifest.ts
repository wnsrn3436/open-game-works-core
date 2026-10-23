import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readJsonIfExists } from '../../../lib/fsx.ts';
import { sha256File } from './archive.ts';
import type { Manifest } from './assets.ts';

function isAssetMap(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string');
}

/**
 * Checks a release folder against its `manifest.json`: the version, and the SHA-256 of every asset.
 * Folders (extracted assets) are not assets. Returns one line per problem; empty when it matches.
 */
export async function verifyRelease(dir: string, version: string): Promise<string[]> {
  const manifest = await readJsonIfExists<Partial<Record<keyof Manifest, unknown>>>(join(dir, 'manifest.json')).catch(() => null);
  if (!isAssetMap(manifest?.assets)) return ['manifest.json is missing or invalid'];
  const problems: string[] = [];
  if (manifest.version !== version) problems.push(`manifest.json version is ${JSON.stringify(manifest.version)}, not ${version}`);
  for (const [name, hash] of Object.entries(manifest.assets)) {
    const file = join(dir, name);
    if (!exists(file)) problems.push(`${name} is missing`);
    else if ((await sha256File(file)) !== hash) problems.push(`${name} does not match its SHA-256 in manifest.json`);
  }
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name !== 'manifest.json' && !(entry.name in manifest.assets)) {
      problems.push(`${entry.name} is not in manifest.json`);
    }
  }
  return problems;
}

/** File of `open-game-works-core-impl/` that holds the highest core schema version `storage` applies. */
export const CORE_SCHEMA_VERSION_FILE = 'server/core/storage/core-schema-version';

/**
 * `manifest.json` `coreSchemaVersion`: the integer line of `server/core/storage/core-schema-version`,
 * 0 when the file does not exist.
 */
export async function readCoreSchemaVersion(implDir: string): Promise<number> {
  const file = join(implDir, CORE_SCHEMA_VERSION_FILE);
  if (!exists(file)) return 0;
  const text = await readFile(file, 'utf8');
  const match = /^(0|[1-9]\d*)\n?$/.exec(text);
  if (!match) throw new OgwError(`${CORE_SCHEMA_VERSION_FILE} must be one line with an integer of 0 or more: ${JSON.stringify(text)}`);
  return Number(match[1]);
}
