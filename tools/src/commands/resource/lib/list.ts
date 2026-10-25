import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { exists, isNotFound } from '../../../lib/fsx.ts';
import { formatCsv, parseCsv, parseTable } from './csv.ts';

/** `resource/resources.csv` columns (`resource` skill `## resource list`). */
export const COLUMNS = [
  'key',
  'description',
  'spec',
  'status',
  'method',
  'source',
  'license',
  'attribution',
  'sha256',
  'text_key',
  'speaker',
  'text_hash',
] as const;

export type Column = (typeof COLUMNS)[number];
export type ResourceRow = Record<Column, string>;
export type Status = 'placeholder' | 'requested' | 'final' | 'temporary';

export const LIST_PATH = 'resource/resources.csv';
export const STATUSES: readonly string[] = ['placeholder', 'requested', 'final', 'temporary'];
/** Statuses of a row whose file is a made resource, not the tool's placeholder. */
export const MADE: readonly string[] = ['final', 'temporary'];

/** Resource types (`resource` skill `## resource key`). */
export const TYPES: readonly string[] = [
  'image', 'sprite_sheet', 'texture_atlas', 'icon', 'background', 'nine_slice',
  'model', 'rig', 'material', 'texture', 'skybox',
  'sprite_animation', 'rig_animation_2d', 'animation_3d', 'tween',
  'particle', 'shader',
  'sfx', 'bgm', 'voice',
  'haptic',
  'font',
  'tileset',
  'scene',
  'prefab',
  'app_icon', 'splash',
];

/** Types whose rows are `final` from the start. */
export const ALWAYS_FINAL: readonly string[] = ['scene', 'prefab', 'tween'];
export const SOUND_TYPES: readonly string[] = ['sfx', 'bgm', 'voice'];

const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export function isSnakeCase(value: string): boolean {
  return SNAKE.test(value);
}

export interface ParsedKey {
  type: string;
  /** `<name>`: snake_case words joined by `/`. */
  name: string;
  /** The last word of `<name>`. */
  last: string;
}

/** Parses `<type>/<name>`; null when the key does not have that form. */
export function parseKey(key: string): ParsedKey | null {
  const slash = key.indexOf('/');
  if (slash === -1) return null;
  const type = key.slice(0, slash);
  const name = key.slice(slash + 1);
  const words = name.split('/');
  if (!TYPES.includes(type) || !words.every(isSnakeCase)) return null;
  return { type, name, last: words[words.length - 1] as string };
}

export function requireKey(key: string): ParsedKey {
  const parsed = parseKey(key);
  if (!parsed) throw new OgwError(`invalid resource key: ${key}`);
  return parsed;
}

export function emptyRow(key: string): ResourceRow {
  const row = {} as ResourceRow;
  for (const column of COLUMNS) row[column] = '';
  row.key = key;
  return row;
}

/** Reads `resource/resources.csv` of a checkout. A missing file is an empty list. */
export async function readList(root: string): Promise<ResourceRow[]> {
  let text: string;
  try {
    text = await readFile(join(root, LIST_PATH), 'utf8');
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return parseList(text, LIST_PATH);
}

export function parseList(text: string, where: string): ResourceRow[] {
  const table = parseTable(text, where);
  if (table.header.join(',') !== COLUMNS.join(',')) {
    throw new OgwError(`${where}: header must be ${COLUMNS.join(',')}`);
  }
  const rows = table.records as ResourceRow[];
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    if (seen.has(row.key)) throw new OgwError(`${where}:${String(table.lines[i])}: duplicate key ${row.key}`);
    seen.add(row.key);
  });
  return rows;
}

/** Keys of the rows of a `resource/resources.csv` text whose `license` is `unknown`, in file order. */
export function unknownLicenseKeys(text: string): string[] {
  const [header, ...rows] = parseCsv(text, LIST_PATH);
  const key = header?.indexOf('key') ?? -1;
  const license = header?.indexOf('license') ?? -1;
  if (license < 0) return [];
  return rows.filter((row) => row[license] === 'unknown').map((row) => row[key] ?? '');
}

/** Keys of the rows of a `resource/resources.csv` text whose `status` is `temporary`, in file order. */
export function temporaryKeys(text: string): string[] {
  const [header, ...rows] = parseCsv(text, LIST_PATH);
  const key = header?.indexOf('key') ?? -1;
  const status = header?.indexOf('status') ?? -1;
  if (status < 0) return [];
  return rows.filter((row) => row[status] === 'temporary').map((row) => row[key] ?? '');
}

export function formatList(rows: readonly ResourceRow[]): string {
  return formatCsv([[...COLUMNS], ...rows.map((row) => COLUMNS.map((column) => row[column]))]);
}

export function findRow(rows: readonly ResourceRow[], key: string): ResourceRow | undefined {
  return rows.find((row) => row.key === key);
}

/** A file of a resource key: `resource/<key>.<extension>` or variant `resource/<key>.<n>.<extension>`. */
export interface KeyFile {
  /** Path relative to the checkout. */
  path: string;
  variant: number | null;
  extension: string;
}

function keyDir(key: string): string {
  return `resource/${key.slice(0, key.lastIndexOf('/'))}`;
}

/** Files of a resource key among paths relative to the checkout, variants in `<n>` order. */
export function keyFilesIn(key: string, paths: readonly string[]): KeyFile[] {
  const prefix = `resource/${key}`;
  const pattern = /^(?:\.([0-9]+))?\.([A-Za-z0-9]+)$/;
  const files: KeyFile[] = [];
  for (const path of [...paths].sort()) {
    if (!path.startsWith(`${prefix}.`)) continue;
    const match = pattern.exec(path.slice(prefix.length));
    if (!match) continue;
    files.push({ path, variant: match[1] === undefined ? null : Number(match[1]), extension: `.${match[2] as string}` });
  }
  return files.sort((a, b) => (a.variant ?? 0) - (b.variant ?? 0) || (a.path < b.path ? -1 : 1));
}

/** Files of a resource key in a checkout, variants in `<n>` order. */
export async function keyFiles(root: string, key: string): Promise<KeyFile[]> {
  const dir = keyDir(key);
  let entries: string[];
  try {
    entries = await readdir(join(root, dir));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return keyFilesIn(key, entries.map((entry) => `${dir}/${entry}`));
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** `sha256` cell: the file SHA-256, or for several variant files the SHA-256 of their hex digests joined in order. */
export function listSha(files: readonly Uint8Array[]): string {
  if (files.length === 1) return sha256Hex(files[0] as Uint8Array);
  return sha256Hex(files.map((data) => sha256Hex(data)).join(''));
}

/** Path of a resource key's file. */
export function keyPath(key: string, extension: string, variant: number | null = null): string {
  return variant === null ? `resource/${key}${extension}` : `resource/${key}.${String(variant)}${extension}`;
}

export function existsIn(root: string, path: string): boolean {
  return exists(join(root, path));
}
