import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { exists } from '../../../lib/fsx.ts';
import { git, gitRaw, isCheckout, listTags } from '../../../lib/git.ts';
import { OgwError } from '../../../lib/errors.ts';
import { lexGd } from '../../check/static/lib/gd-lexer.ts';
import { compareBytes } from './core-spec.ts';

/** Files below a folder, as absolute paths, without following symbolic links. A missing folder has none. */
export async function filesBelow(dir: string): Promise<string[]> {
  if (!exists(dir)) return [];
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Folders of deterministic simulation code: `client/features/<feature>/sim/` and `client/common/sim/`. */
export async function simDirs(root: string): Promise<string[]> {
  const dirs = [join(root, 'client', 'common', 'sim')];
  const features = join(root, 'client', 'features');
  if (exists(features)) {
    for (const entry of await readdir(features, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(features, entry.name, 'sim'));
    }
  }
  return dirs;
}

/** True when a game-repo-relative path is below a deterministic simulation folder. */
export function isSimPath(path: string): boolean {
  return /^client\/features\/[^/]+\/sim\//.test(path) || path.startsWith('client/common/sim/');
}

export function pascalCase(snake: string): string {
  return snake
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Names the GDScript code refers to, outside strings (triple-quoted and raw strings included) and comments:
 * `<Table>` of each `GameData.<Table>` (line breaks between the tokens included) and `GameSetting` when the accessor name appears.
 */
export function gdscriptDataRefs(text: string): { containers: string[]; gameSetting: boolean } {
  // A line break between `GameData`, `.` and the member is legal inside brackets; outside brackets it is not valid GDScript.
  const tokens = lexGd(text).tokens.filter((token) => token.type !== 'newline');
  const containers: string[] = [];
  let gameSetting = false;
  tokens.forEach((token, i) => {
    if (token.type !== 'name') return;
    if (token.text === 'GameSetting') gameSetting = true;
    const dot = tokens[i + 1];
    const member = tokens[i + 2];
    if (token.text === 'GameData' && dot?.type === 'op' && dot.text === '.' && member?.type === 'name') containers.push(member.text);
  });
  return { containers, gameSetting };
}

/**
 * Table names with a file: `data/tables/*.csv` and `data/system/*.csv` (data `## data version`: each
 * `data/simulation_tables.csv` row is one of these).
 */
export async function tableNames(root: string): Promise<string[]> {
  const names = new Set<string>();
  for (const folder of ['tables', 'system']) {
    const dir = join(root, 'data', folder);
    if (!exists(dir)) continue;
    for (const name of await readdir(dir)) if (name.endsWith('.csv')) names.add(basename(name, '.csv'));
  }
  return [...names];
}

/**
 * `data/simulation_tables.csv`: the tables whose Godot container `GameData.<Table>Table` the
 * deterministic simulation code calls, and `game_setting` when it calls the `GameSetting` accessor.
 */
export async function simulationTables(root: string, tables: readonly string[]): Promise<string> {
  const byContainer = new Map(tables.map((name) => [`${pascalCase(name)}Table`, name]));
  const found = new Set<string>();
  for (const dir of await simDirs(root)) {
    for (const file of await filesBelow(dir)) {
      if (!file.endsWith('.gd')) continue;
      const refs = gdscriptDataRefs(await readFile(file, 'utf8'));
      for (const container of refs.containers) {
        const table = byContainer.get(container);
        if (table !== undefined) found.add(table);
      }
      if (refs.gameSetting) found.add('game_setting');
    }
  }
  return ['table', ...[...found].sort(compareBytes)].join('\n') + '\n';
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** path → SHA-256 of the deterministic simulation files in the working tree. */
async function workingTreeSim(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const dir of await simDirs(root)) {
    for (const file of await filesBelow(dir)) {
      result.set(relative(root, file).split(sep).join('/'), sha256(await readFile(file)));
    }
  }
  return result;
}

/** path → SHA-256 of the deterministic simulation files at a commit. */
async function commitSim(root: string, rev: string): Promise<Map<string, string>> {
  const listing = await git(root, ['ls-tree', '-r', '-z', rev, '--', 'client/features', 'client/common/sim']);
  const blobs: { path: string; oid: string }[] = [];
  for (const entry of listing.split('\0')) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
    if (match && isSimPath(match[2] as string)) blobs.push({ oid: match[1] as string, path: match[2] as string });
  }
  const result = new Map<string, string>();
  if (blobs.length === 0) return result;
  const out = await gitRaw(root, ['cat-file', '--batch'], { input: blobs.map((b) => `${b.oid}\n`).join('') });
  if (out.code !== 0) throw new OgwError(`git cat-file failed: ${out.stderr.trim()}`);
  let offset = 0;
  for (const blob of blobs) {
    const headerEnd = out.stdoutBytes.indexOf(0x0a, offset);
    const size = Number(out.stdoutBytes.subarray(offset, headerEnd).toString('utf8').split(' ')[2]);
    const start = headerEnd + 1;
    result.set(blob.path, sha256(out.stdoutBytes.subarray(start, start + size)));
    offset = start + size + 1;
  }
  return result;
}

function sameFiles(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  return a.size === b.size && [...a].every(([path, hash]) => b.get(path) === hash);
}

const VERSION_TAG = /^(?:dev|stg|prod)-(\d+)\.(\d+)\.(\d+)$/;

export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/**
 * `server/generated/tick_changed_versions.ts`: the versions of `dev-`, `stg-`, `prod-<version>` tags whose
 * deterministic simulation files (paths and SHA-256) differ from the working tree.
 */
export async function tickChangedVersions(root: string): Promise<string> {
  const current = await workingTreeSim(root);
  const versions = new Set<string>();
  for (const tag of isCheckout(root) ? await listTags(root) : []) {
    const match = VERSION_TAG.exec(tag);
    if (!match) continue;
    if (!sameFiles(current, await commitSim(root, `refs/tags/${tag}^{commit}`))) {
      versions.add(`${match[1] as string}.${match[2] as string}.${match[3] as string}`);
    }
  }
  const list = [...versions].sort(compareVersions).map((v) => JSON.stringify(v));
  return `export const TickChangedVersions: readonly string[] = [${list.join(', ')}];\n`;
}
