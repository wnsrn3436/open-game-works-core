import { isDeepStrictEqual } from 'node:util';
import { formatCsv, onHeader, parseRecords } from './csv.ts';

/** The result of a key-wise merge: the merged value, or the path of the first key both sides changed differently. */
export type JsonMerge = { value: unknown } | { conflict: string };

function isNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A JSON schema `required` list holds names in no order: each side's additions and removals all apply. Null otherwise. */
function mergeRequired(base: unknown, ours: unknown, theirs: unknown, key: string | null): string[] | null {
  if (key !== 'required' || !isNames(ours) || !isNames(theirs) || (base !== undefined && !isNames(base))) return null;
  const removed = new Set((base ?? []).filter((name) => !ours.includes(name) || !theirs.includes(name)));
  return [...new Set([...ours, ...theirs])].filter((name) => !removed.has(name));
}

/** The three-way pick of a merge: the side that changed, the common value when both changed it alike, else `conflict`. */
export function pick3<T>(base: T, ours: T, theirs: T, equal: (a: T, b: T) => boolean): T | 'conflict' {
  if (equal(ours, theirs) || equal(base, theirs)) return ours;
  if (equal(base, ours)) return theirs;
  return 'conflict';
}

/** The value when one side changed it or both changed it to the same value, else undefined. */
function oneSided(base: unknown, ours: unknown, theirs: unknown): { value: unknown } | undefined {
  const picked = pick3<unknown>(base, ours, theirs, isDeepStrictEqual);
  return picked === 'conflict' ? undefined : { value: picked };
}

/**
 * Merges two changes of a JSON value key by key (ogw.md `## agent merge`): a key one side changed takes that side's
 * value, a key both changed to the same value takes it, and a key both changed differently is merged the same way inside
 * when both values are objects; a JSON schema `required` list of both sides takes every name either side added or kept and
 * drops the names either side removed; anything else is a conflict. A key a side removed counts as changed to absent. Keys keep the
 * order of `ours`, then the keys only `theirs` has.
 */
export function mergeJson(base: unknown, ours: unknown, theirs: unknown, options: { schema?: boolean } = {}, path = '', key: string | null = null): JsonMerge {
  const simple = oneSided(base, ours, theirs);
  if (simple !== undefined) return simple;
  // only a JSON schema has `required` lists; a core settings key may end in `.required` and holds a value
  const names = options.schema === true ? mergeRequired(base, ours, theirs, key) : null;
  if (names !== null) return { value: names };
  if (!isObject(ours) || !isObject(theirs)) return { conflict: path === '' ? '(root)' : path };
  const from = isObject(base) ? base : {};
  const merged: Record<string, unknown> = {};
  for (const key of [...new Set([...Object.keys(ours), ...Object.keys(theirs)])]) {
    const result = mergeJson(from[key], ours[key], theirs[key], options, path === '' ? key : `${path}.${key}`, key);
    if ('conflict' in result) return result;
    if (result.value !== undefined) merged[key] = result.value;
  }
  return { value: merged };
}

/** The result of a row-wise CSV merge: the merged text, or why it cannot merge. */
export type CsvRowMerge = { text: string } | { conflict: string };

/**
 * Merges two changes of a CSV file row by row (ogw.md `## agent merge`, core test data). The first `headerRows` records
 * are the header and the last of them names the columns. The three tables are put on one header with every column of
 * the three (the columns of `ours`, then the ones only another has; a missing cell is empty), then every row either side
 * added goes in and every row either side removed goes out, in the order of `ours` with the rows only `theirs` added
 * after. A header that names one column twice is a conflict, and so are a column of base a side removed or renamed and
 * two rows of one `id(key)` value.
 */
export function mergeCsvRows(base: string, ours: string, theirs: string, headerRows = 1): CsvRowMerge {
  const tables = [base, ours, theirs].map((text) => {
    const records = parseRecords(text);
    const head = records.slice(0, headerRows);
    return { head, names: head.at(-1) ?? [], rows: records.slice(headerRows) };
  }) as [CsvTables, CsvTables, CsvTables];
  if (tables.some((table) => new Set(table.names).size !== table.names.length)) return { conflict: 'a header names a column twice' };
  // only added columns merge: a side that removed or renamed a column of base would lose or misplace cells
  const dropped = tables[0].names.find((name) => !tables[1].names.includes(name) || !tables[2].names.includes(name));
  if (dropped !== undefined) return { conflict: `a side removed or renamed the column ${dropped}` };
  const names = [...new Set([...tables[1].names, ...tables[2].names, ...tables[0].names])];
  const head = mergeHead(tables, names, headerRows);
  if (typeof head === 'string') return { conflict: head };
  const [b, o, t] = tables.map((table) => table.rows.map((row) => onHeader(names, table.names, row))) as [string[][], string[][], string[][]];
  const keyOf = (row: string[]): string => JSON.stringify(row);
  const [inBase, inOurs, inTheirs] = [new Set(b.map(keyOf)), new Set(o.map(keyOf)), new Set(t.map(keyOf))];
  const removedByTheirs = new Set([...inBase].filter((key) => !inTheirs.has(key)));
  const rows = o.filter((row) => !removedByTheirs.has(keyOf(row)));
  for (const row of t) if (!inBase.has(keyOf(row)) && !inOurs.has(keyOf(row))) rows.push(row);
  const twice = twiceKey(head, rows);
  if (twice !== null) return { conflict: `both sides have a row of key ${twice}` };
  const eol = ours.includes('\r\n') ? '\r\n' : '\n';
  return { text: formatCsv({ header: head[0] ?? [], rows: [...head.slice(1), ...rows], eol }) };
}

/**
 * The header rows on `names`: each cell above the name row of a column merges three-way like a row cell (a side that
 * changed it wins; both changed differently is a conflict, named in the returned text). A column a side lacks takes the
 * cell of a side that has it.
 */
function mergeHead(tables: readonly [CsvTables, CsvTables, CsvTables], names: readonly string[], headerRows: number): string[][] | string {
  const cellOf = (table: CsvTables, name: string, i: number): string | undefined =>
    table.names.includes(name) ? (table.head[i]?.[table.names.indexOf(name)] ?? '') : undefined;
  const head: string[][] = [];
  for (let i = 0; i < headerRows; i += 1) {
    const row: string[] = [];
    for (const name of names) {
      const [b, o, t] = tables.map((table) => cellOf(table, name, i));
      // a side that lacks the column changed nothing in it
      const cell = o === undefined ? (t ?? b ?? '') : t === undefined ? o : (pick3<string | undefined>(b, o, t, (x, y) => x === y) ?? '');
      if (cell === 'conflict') return `the header of column ${name} changed on both sides`;
      row.push(cell);
    }
    head.push(row);
  }
  return head;
}

/** The first value that two rows have in the `id(key)` column (header row 3 is the type row of a data table), or null. */
function twiceKey(head: readonly string[][], rows: readonly string[][]): string | null {
  const column = head.length === 4 ? (head[2] ?? []).indexOf('id(key)') : -1;
  if (column === -1) return null;
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row[column] ?? '';
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}

interface CsvTables {
  head: string[][];
  names: string[];
  rows: string[][];
}
