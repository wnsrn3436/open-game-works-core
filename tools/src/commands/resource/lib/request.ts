import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { exists, isNotFound } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { commitPaths, gitRaw } from '../../../lib/git.ts';
import type { RunState } from '../../../lib/runstate.ts';
import { openRun } from '../../../lib/runstate.ts';
import { FileChanges } from './files.ts';
import { ALWAYS_FINAL, findRow, formatList, LIST_PATH, parseKey, readList, type ResourceRow } from './list.ts';
import { MIN_NINE_SLICE_SIDE, smallNineSlice } from './spec.ts';

export interface RequestOptions {
  /** Requested keys, or `pending`. */
  keys: string[] | 'pending';
  see: string[];
  base: string | null;
  /** Harness settings `backgroundRetryLimit`: the most request files of a key after which `--pending` stops asking again. */
  retryLimit: number;
}

export interface RequestResult {
  /** Request file path relative to the checkout; null when `--pending` found nothing. */
  path: string | null;
  keys: string[];
  /** `nine_slice` keys that `--pending` left out: the long side of their `size` is under 256. */
  leftOut: string[];
}

/** The line `ogw resource request --pending` and `ogw loop dispatch` print for a key `--pending` left out. */
export function leftOutLine(key: string): string {
  return `left out ${key}: the long side of a nine_slice size is under ${String(MIN_NINE_SLICE_SIDE)}`;
}

/** Where the run's request files are: a folder relative to the checkout and a file name prefix. */
export function requestPlace(run: RunState): { dir: string; prefix: string } {
  if (run.kind === 'loop') return { dir: `records/loops/${run.name}/resource-requests`, prefix: '' };
  if (run.env === null || run.version === null) throw new OgwError(`build run ${run.name} has no environment and version`);
  return { dir: 'records/hardening', prefix: `${run.env.toLowerCase()}-${run.version}-resource-` };
}

/** Whether `name` is a request file name in `place`: `<prefix><unix ms>.md`. */
export function isRequestFileName(place: { prefix: string }, name: string): boolean {
  return name.startsWith(place.prefix) && /^[0-9]+\.md$/.test(name.slice(place.prefix.length));
}

/** Resource keys in the `## keys` section of a request file. */
export function requestFileKeys(text: string): string[] {
  const keys: string[] = [];
  let inKeys = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      inKeys = line.trim() === '## keys';
      continue;
    }
    const key = line.trim();
    if (inKeys && key !== '' && key !== 'none') keys.push(key);
  }
  return keys;
}

/** Request files of the run that name a key, and whether each of them has its result file. */
interface WrittenKey {
  files: number;
  finished: boolean;
}

async function writtenKeys(root: string, place: { dir: string; prefix: string }): Promise<Map<string, WrittenKey>> {
  const keys = new Map<string, WrittenKey>();
  let entries: string[];
  try {
    entries = await readdir(join(root, place.dir));
  } catch (error) {
    if (isNotFound(error)) return keys;
    throw error;
  }
  for (const entry of entries.filter((e) => isRequestFileName(place, e))) {
    const finished = exists(join(root, place.dir, `${entry.slice(0, -'.md'.length)}-result.md`));
    for (const key of new Set(requestFileKeys(await readFile(join(root, place.dir, entry), 'utf8')))) {
      const written = keys.get(key) ?? { files: 0, finished: true };
      keys.set(key, { files: written.files + 1, finished: written.finished && finished });
    }
  }
  return keys;
}

function section(name: string, keys: readonly string[]): string {
  return `## ${name}\n\n${keys.length === 0 ? 'none' : keys.join('\n')}\n`;
}

export function requestFileText(keys: readonly string[], see: readonly string[], base: string | null): string {
  return [section('keys', keys), section('see', see), section('base', base === null ? [] : [base])].join('\n');
}

function checkRows(rows: readonly ResourceRow[], options: RequestOptions): string[] {
  const problems: string[] = [];
  if (options.keys !== 'pending') {
    for (const key of options.keys) {
      const row = findRow(rows, key);
      const type = parseKey(key)?.type;
      if (!row) problems.push(`${key} is not in ${LIST_PATH}`);
      else if (type !== undefined && ALWAYS_FINAL.includes(type)) problems.push(`${key}: type ${type} is not requested`);
    }
  }
  for (const key of [...options.see, ...(options.base === null ? [] : [options.base])]) {
    const row = findRow(rows, key);
    if (!row) problems.push(`${key} is not in ${LIST_PATH}`);
    else if (row.status !== 'final') problems.push(`${key} is not final`);
  }
  return problems;
}

function requestPath(root: string, place: { dir: string; prefix: string }): string {
  let ms = Date.now();
  while (exists(join(root, place.dir, `${place.prefix}${String(ms)}.md`))) ms++;
  return `${place.dir}/${place.prefix}${String(ms)}.md`;
}

/** `ogw resource request` (`resource` skill `## resource request`). */
export async function requestResources(game: GameRepo, options: RequestOptions, env: NodeJS.ProcessEnv): Promise<RequestResult> {
  const run = await openRun(game);
  if (!run) throw new OgwError(`no open run for game ${game.name}: the request file path needs a loop run or a build run`);
  const place = requestPlace(run);
  const rows = await readList(game.root);
  const problems = checkRows(rows, options);
  if (problems.length > 0) throw new OgwError(problems.join('\n'));
  const small = (row: ResourceRow): boolean => smallNineSlice(parseKey(row.key)?.type ?? '', row.spec);
  let keys: string[];
  let leftOut: string[] = [];
  if (options.keys === 'pending') {
    const written = await writtenKeys(game.root, place);
    const again = (key: string): boolean => {
      const w = written.get(key);
      return w === undefined || (w.finished && w.files <= options.retryLimit);
    };
    const due = rows.filter((r) => r.status === 'placeholder' || (r.status === 'requested' && again(r.key)) || (r.status === 'temporary' && !written.has(r.key)));
    leftOut = due.filter(small).map((r) => r.key);
    keys = due.filter((r) => !small(r)).map((r) => r.key);
  } else {
    keys = [...new Set(options.keys)];
    const refused = keys.filter((key) => small(findRow(rows, key) as ResourceRow));
    if (refused.length > 0) throw new OgwError(refused.map((key) => `${key}: the long side of a nine_slice size is ${String(MIN_NINE_SLICE_SIDE)} or more`).join('\n'));
  }
  if (keys.length === 0) return { path: null, keys, leftOut };
  for (const key of keys) {
    const row = findRow(rows, key) as ResourceRow;
    // a temporary row keeps its file until finalize replaces it
    if (row.status !== 'temporary') row.status = 'requested';
  }
  const path = requestPath(game.root, place);
  const changes = new FileChanges();
  changes.write(path, requestFileText(keys, options.see, options.base));
  changes.write(LIST_PATH, formatList(rows));
  const { undo } = await changes.apply(game.root);
  try {
    await commitPaths(game.root, [path, LIST_PATH], `resource request: ${keys.join(' ')}`, { env });
  } catch (error) {
    await gitRaw(game.root, ['reset', '--quiet', '--', path, LIST_PATH], { env });
    await undo();
    throw error;
  }
  return { path, keys, leftOut };
}
