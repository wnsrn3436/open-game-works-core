import { OgwError } from '../../../lib/errors.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { git, gitRaw } from '../../../lib/git.ts';
import { parseCsv } from './csv.ts';
import { keyFiles, LIST_PATH, parseKey, readList, type ResourceRow } from './list.ts';

export interface FirstFinal {
  key: string;
  /** File paths relative to the checkout: one file, or the variant files in `<n>` order. */
  files: string[];
}

interface Commit {
  sha: string;
  parents: string[];
}

async function commitsFromHead(root: string, env: NodeJS.ProcessEnv): Promise<Commit[]> {
  const hasHead = await gitRaw(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { env });
  if (hasHead.code !== 0) return [];
  const out = await git(root, ['rev-list', '--topo-order', '--reverse', '--parents', 'HEAD'], { env });
  return out
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, ...parents] = line.split(' ');
      return { sha: sha as string, parents };
    });
}

/**
 * `key` → `status` of a `resources.csv` from history. Only the `key` and `status` columns are read. A file that is not
 * CSV or has no such columns gives no status; a key on several rows has no status.
 */
export function historicalStatuses(text: string): Map<string, string> {
  const statuses = new Map<string, string>();
  let rows: string[][];
  try {
    rows = parseCsv(text, LIST_PATH);
  } catch (error) {
    if (error instanceof OgwError) return statuses;
    throw error;
  }
  const header = rows[0] ?? [];
  const keyAt = header.indexOf('key');
  const statusAt = header.indexOf('status');
  if (keyAt < 0 || statusAt < 0) return statuses;
  const repeated = new Set<string>();
  for (const row of rows.slice(1)) {
    const key = row[keyAt];
    const status = row[statusAt];
    if (key === undefined || status === undefined) continue;
    if (statuses.has(key)) repeated.add(key);
    statuses.set(key, status);
  }
  for (const key of repeated) statuses.delete(key);
  return statuses;
}

/** Contents of blobs, read in one `git cat-file --batch` process. */
async function readBlobs(root: string, blobs: readonly string[], env: NodeJS.ProcessEnv): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  if (blobs.length === 0) return texts;
  const result = await gitRaw(root, ['cat-file', '--batch'], { input: blobs.map((b) => `${b}\n`).join(''), env });
  if (result.timedOut || result.code !== 0) throw new OgwError(`git cat-file --batch failed: ${result.stderr.trim()}`);
  const out = result.stdoutBytes;
  let at = 0;
  while (at < out.length) {
    const end = out.indexOf(0x0a, at);
    if (end < 0) throw new OgwError('git cat-file --batch: output ends inside a header');
    const [blob, kind, size] = out.subarray(at, end).toString('utf8').split(' ');
    if (kind !== 'blob' || size === undefined) throw new OgwError(`git cat-file --batch: unexpected header for ${blob ?? ''}`);
    const start = end + 1;
    texts.set(blob as string, out.subarray(start, start + Number(size)).toString('utf8'));
    at = start + Number(size) + 1;
  }
  return texts;
}

/** Status of each key in `resources.csv` at each commit; reads each distinct file once. */
async function statusAt(root: string, commits: readonly Commit[], env: NodeJS.ProcessEnv): Promise<Map<string, Map<string, string>>> {
  const input = commits.map((c) => `${c.sha}:${LIST_PATH}\n`).join('');
  const out = commits.length === 0 ? '' : await git(root, ['cat-file', '--batch-check'], { input, env });
  const blobOf = new Map<string, string>();
  for (const [i, line] of out.split('\n').filter((l) => l.length > 0).entries()) {
    const [blob, kind] = line.split(' ');
    if (kind === 'blob') blobOf.set((commits[i] as Commit).sha, blob as string);
  }
  const texts = await readBlobs(root, [...new Set(blobOf.values())], env);
  const parsed = new Map<string, Map<string, string>>();
  for (const [blob, text] of texts) parsed.set(blob, historicalStatuses(text));
  const result = new Map<string, Map<string, string>>();
  for (const commit of commits) {
    const blob = blobOf.get(commit.sha);
    result.set(commit.sha, (blob === undefined ? undefined : parsed.get(blob)) ?? new Map<string, string>());
  }
  return result;
}

/** `ogw resource first-final` (`production.md` `## first final`). */
export async function firstFinal(game: GameRepo, by: { name: string } | { speaker: string }, env: NodeJS.ProcessEnv): Promise<FirstFinal | null> {
  const rows = await readList(game.root);
  const chosen = rows.filter((row) => row.status === 'final' && ('name' in by ? parseKey(row.key)?.name === by.name : row.speaker === by.speaker));
  if (chosen.length === 0) return null;
  const commits = await commitsFromHead(game.root, env);
  const statuses = await statusAt(game.root, commits, env);
  // A commit changes a row to `final` when the row is `final` there and in none of its parents.
  const position = (row: ResourceRow): number => {
    let last = commits.length;
    commits.forEach((commit, i) => {
      const final = (sha: string): boolean => statuses.get(sha)?.get(row.key) === 'final';
      if (final(commit.sha) && !commit.parents.some(final)) last = i;
    });
    return last;
  };
  const ordered = chosen.map((row) => ({ row, at: position(row) })).sort((a, b) => a.at - b.at || (a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0));
  const first = (ordered[0] as { row: ResourceRow }).row;
  const files = (await keyFiles(game.root, first.key)).map((f) => f.path);
  if (files.length === 0) throw new OgwError(`${first.key}: no file resource/${first.key}.<extension>`);
  return { key: first.key, files };
}
