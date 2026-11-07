/** The guards of a seed-run (ogw.md `### seed-run` of `## regress`): what its fixer must not change. */
import { matchesGlob } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { git, showFile } from '../../../lib/git.ts';
import { parseCsv } from '../../data/lib/csv.ts';
import { translationRowState, translationTable } from '../../data/lib/translation-state.ts';
import type { FrozenColumns } from './repo.ts';

/** The paths every fixer must not change besides the `frozen` of its seed. */
export const ALWAYS_FROZEN: readonly string[] = ['records/setup/**', 'brief.md'];

/** The test cases of a test file: `func test_` of GDScript, `it(` and `test(` of TypeScript. */
export function testCount(path: string, text: string): number {
  if (path.endsWith('.gd')) return [...text.matchAll(/^\s*func\s+test_/gm)].length;
  return [...text.matchAll(/(?<![A-Za-z0-9_.$])(?:it|test)(?:\.(?:only|each\([^)]*\)))?\s*\(/g)].length;
}

function isTestFile(path: string): boolean {
  return (path.startsWith('client/tests/') && path.endsWith('.gd')) || (path.startsWith('server/tests/') && /\.test\.ts$/.test(path));
}

async function lines(ctx: Context, repo: string, args: readonly string[]): Promise<string[]> {
  return (await git(repo, args, { env: ctx.env })).split('\n').filter((line) => line !== '');
}

async function textAt(ctx: Context, repo: string, commit: string, path: string): Promise<string | null> {
  return (await showFile(repo, commit, path, { env: ctx.env }))?.toString('utf8') ?? null;
}

/** The translation rows of a language at a commit by key, or an empty map without the file. */
async function translationRows(ctx: Context, repo: string, commit: string, path: string): Promise<Map<string, Record<string, string>>> {
  const text = await textAt(ctx, repo, commit, path);
  if (text === null) return new Map();
  try {
    return new Map(translationTable(text, path).rows.map((row) => [row.values.key ?? '', row.values]));
  } catch (error) {
    if (error instanceof OgwError) return new Map();
    throw error;
  }
}

/** The header rows of a data table: 4 for `data/tables/` and `data/system/`, 1 for other files (`data` skill `## CSV format`). */
function headerRows(path: string): number {
  return /^data\/(?:tables|system)\//.test(path) ? 4 : 1;
}

/** The cells of a data table by row key (the first column) and column name (the last header row). */
function tableCells(path: string, text: string | null): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  if (text === null) return out;
  let rows: string[][];
  try {
    rows = parseCsv(text, path).map((record) => record.fields);
  } catch {
    return out;
  }
  const names = rows[headerRows(path) - 1] ?? [];
  for (const row of rows.slice(headerRows(path))) out.set(row[0] ?? '', new Map(names.map((name, i) => [name, row[i] ?? ''])));
  return out;
}

/** The frozen cells that changed: per frozen table, the cells of matching columns whose value changed, by row key. */
async function frozenCellChanges(ctx: Context, repo: string, seeded: string, final: string, frozen: readonly FrozenColumns[], changed: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const item of frozen.filter((f) => changed.includes(f.file))) {
    const before = tableCells(item.file, await textAt(ctx, repo, seeded, item.file));
    const after = tableCells(item.file, await textAt(ctx, repo, final, item.file));
    for (const [key, cells] of before) {
      for (const [name, value] of cells) {
        if (!item.columns.some((glob) => matchesGlob(name, glob))) continue;
        const now = after.get(key)?.get(name);
        if (now !== value) out.push(`frozen ${item.file} ${key} ${name}`);
      }
    }
  }
  return out;
}

/**
 * The guard violations from the seeded commit to the final commit: changed paths that match `frozen` or
 * `ALWAYS_FROZEN`, test files of the seeded commit with fewer tests, and for a translation fixer the rows whose `text`
 * changed and that were neither missing nor stale on the seeded commit.
 */
export async function guardViolations(ctx: Context, repo: string, seeded: string, final: string, seed: { frozen: readonly string[]; frozenColumns: readonly FrozenColumns[] }, translation: boolean): Promise<string[]> {
  if (seeded === final) return [];
  const changed = await lines(ctx, repo, ['diff', '--name-only', '--no-renames', seeded, final]);
  const globs = [...ALWAYS_FROZEN, ...seed.frozen];
  const out = changed.filter((path) => globs.some((glob) => matchesGlob(path, glob))).map((path) => `frozen ${path}`);
  out.push(...(await frozenCellChanges(ctx, repo, seeded, final, seed.frozenColumns, changed)));
  for (const path of await lines(ctx, repo, ['ls-tree', '-r', '--name-only', seeded, 'client/tests', 'server/tests'])) {
    if (!isTestFile(path) || !changed.includes(path)) continue;
    const before = testCount(path, (await textAt(ctx, repo, seeded, path)) ?? '');
    const after = testCount(path, (await textAt(ctx, repo, final, path)) ?? '');
    if (after < before) out.push(`fewer tests ${path}: ${String(before)} to ${String(after)}`);
  }
  if (!translation) return out;
  for (const path of changed.filter((p) => /^data\/translations\/[^/]+\.csv$/.test(p))) {
    const before = await translationRows(ctx, repo, seeded, path);
    const after = await translationRows(ctx, repo, final, path);
    for (const [key, row] of before) {
      const now = after.get(key);
      if (now !== undefined && now.text !== row.text && translationRowState(row) === null) out.push(`translation ${path} ${key}`);
    }
  }
  return out;
}
