import { pick3 } from './jsonmerge.ts';
import { column, formatCsv, onHeader, parseCsv, type CsvTable } from './csv.ts';

/** Merged file text (`null`: no file), or the reason of a conflict. */
export type RowMerge = { text: string | null } | { conflict: string };

type Row = Record<string, string>;

interface Keyed {
  table: CsvTable;
  keys: string[];
  byKey: Map<string, Row>;
}

function toRow(header: readonly string[], cells: readonly string[]): Row {
  const row: Row = {};
  header.forEach((name, i) => {
    row[name] = cells[i] ?? '';
  });
  return row;
}

/** The rows of a file by key; a header without one of the key `columns` throws `OgwError`, as a file that is not CSV does. */
function keyed(text: string | null, columns: readonly string[], keyOf: (row: Row) => string): Keyed | null {
  if (text === null) return null;
  const table = parseCsv(text);
  for (const name of columns) column(table, name);
  const keys: string[] = [];
  const byKey = new Map<string, Row>();
  for (const cells of table.rows) {
    const row = toRow(table.header, cells);
    const key = keyOf(row);
    keys.push(key);
    byKey.set(key, row);
  }
  return { table, keys, byKey };
}

const KEY = ['key'];

function byKey(row: Row): string {
  return row.key ?? '';
}

function same(a: Row | undefined, b: Row | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function render(table: CsvTable, rows: Row[]): string {
  return formatCsv({ header: table.header, eol: table.eol, rows: rows.map((row) => onHeader(table.header, Object.keys(row), Object.values(row))) });
}

/** Three-way pick of one row: `undefined` is an absent row. */
function pickRow(base: Row | undefined, ours: Row | undefined, theirs: Row | undefined): Row | undefined | 'conflict' {
  return pick3(base, ours, theirs, same);
}

/** Keys of the branch in its order, then keys only the sub-agent has in its order. */
function keyOrder(ours: Keyed | null, theirs: Keyed | null): string[] {
  const own = ours?.keys ?? [];
  const known = new Set(own);
  return [...own, ...(theirs?.keys ?? []).filter((key) => !known.has(key))];
}

/**
 * `resource/resources.csv`: rows matched by `key`. A key both sides changed to different rows is a conflict.
 */
export function mergeResources(base: string | null, ours: string | null, theirs: string | null): RowMerge {
  const b = keyed(base, KEY, byKey);
  const o = keyed(ours, KEY, byKey);
  const t = keyed(theirs, KEY, byKey);
  const shape = o ?? t;
  if (!shape) return { text: null };
  if (o && t && o.table.header.join(',') !== t.table.header.join(',')) return { conflict: 'resource/resources.csv: header differs' };
  const rows: Row[] = [];
  for (const key of keyOrder(o, t)) {
    const picked = pickRow(b?.byKey.get(key), o?.byKey.get(key), t?.byKey.get(key));
    if (picked === 'conflict') return { conflict: `resource/resources.csv: key ${key} changed on both sides` };
    if (picked) rows.push(picked);
  }
  return { text: render(shape.table, rows) };
}

/**
 * Takes the cells the sub-agent changed into the branch's row. Returns the name of a cell both changed,
 * or null. `conflictOnBoth` makes any cell both changed a conflict, even to the same value.
 */
function takeCells(result: Row, base: Row | undefined, theirs: Row, cells: readonly string[], conflictOnBoth: boolean): string | null {
  for (const cell of cells) {
    if (!(cell in theirs)) continue;
    const before = base?.[cell] ?? '';
    const mine = result[cell] ?? '';
    const sub = theirs[cell] ?? '';
    if (sub === before) continue;
    if (mine !== before && (conflictOnBoth || mine !== sub)) return cell;
    result[cell] = sub;
  }
  return null;
}

/**
 * `data/translations/<language>.csv`: rows by `key`. Rows, their order and `source` come from the branch;
 * `text` and `source_hash` from the sub-agent. Both sides changing `text` or `source_hash` of a key is a conflict.
 */
export function mergeTranslation(path: string, base: string | null, ours: string | null, theirs: string | null): RowMerge {
  const o = keyed(ours, KEY, byKey);
  if (!o) return { text: null };
  const b = keyed(base, KEY, byKey);
  const t = keyed(theirs, KEY, byKey);
  const rows: Row[] = [];
  for (const key of o.keys) {
    const result = { ...(o.byKey.get(key) as Row) };
    const sub = t?.byKey.get(key);
    if (sub) {
      const clash = takeCells(result, b?.byKey.get(key), sub, ['text', 'source_hash'], true);
      if (clash !== null) return { conflict: `${path}: ${clash} of key ${key} changed on both sides` };
    }
    rows.push(result);
  }
  return { text: render(o.table, rows) };
}

const GLOSSARY_FIXED = new Set(['source', 'id_name', 'note', 'source_hash']);
const GLOSSARY_KEY = ['source', 'id_name'];

function glossaryKey(row: Row): string {
  return JSON.stringify([row.source ?? '', row.id_name ?? '']);
}

/** Language columns of `data/glossary.csv`. */
export function glossaryLanguages(header: readonly string[]): string[] {
  return header.filter((name) => !GLOSSARY_FIXED.has(name));
}

/**
 * `data/glossary.csv`: rows by (`source`, `id_name`). Rows, `source`, `id_name`, `note` come from the branch;
 * `<language>` cells from the sub-agent. Both sides changing a cell to different values is a conflict.
 */
export function mergeGlossary(base: string | null, ours: string | null, theirs: string | null): RowMerge {
  const o = keyed(ours, GLOSSARY_KEY, glossaryKey);
  if (!o) return { text: null };
  const b = keyed(base, GLOSSARY_KEY, glossaryKey);
  const t = keyed(theirs, GLOSSARY_KEY, glossaryKey);
  const languages = glossaryLanguages(o.table.header);
  const rows: Row[] = [];
  for (const key of o.keys) {
    const result = { ...(o.byKey.get(key) as Row) };
    const sub = t?.byKey.get(key);
    if (sub) {
      const clash = takeCells(result, b?.byKey.get(key), sub, languages, false);
      if (clash !== null) return { conflict: `data/glossary.csv: ${clash} of ${key} changed on both sides` };
    }
    rows.push(result);
  }
  return { text: render(o.table, rows) };
}

/** Rows of `after` whose `cell` differs from the same row of `before` (a missing row counts as empty). */
function changedCells(before: Keyed | null, after: Keyed | null, cell: string): number {
  if (!after) return 0;
  let count = 0;
  for (const key of after.keys) {
    const row = after.byKey.get(key) as Row;
    if ((row[cell] ?? '') !== (before?.byKey.get(key)?.[cell] ?? '')) count++;
  }
  return count;
}

export interface TranslationFiles {
  /** `data/translations/<language>.csv` text by language; `undefined` for a file that is not UTF-8. */
  translations: Map<string, string | undefined>;
  /** `null` when there is none, `undefined` when it is not UTF-8. */
  glossary: string | null | undefined;
}

/** `keyed`, or `undefined` for a file that is not CSV (`undefined` text: not UTF-8). */
function keyedOrBroken(text: string | null | undefined, columns: readonly string[], keyOf: (row: Row) => string): Keyed | null | undefined {
  if (text === undefined) return undefined;
  try {
    return keyed(text, columns, keyOf);
  } catch {
    return undefined;
  }
}

/**
 * Per language: rows whose `text` changed in its translation file and rows whose language cell changed in the
 * glossary. A language whose translation file or glossary is not CSV on either side has no counts: `ogw data` reports it.
 */
export function translationCounts(before: TranslationFiles, after: TranslationFiles): Record<string, { text: number; glossary: number }> {
  const glossaryBefore = keyedOrBroken(before.glossary, GLOSSARY_KEY, glossaryKey);
  const glossaryAfter = keyedOrBroken(after.glossary, GLOSSARY_KEY, glossaryKey);
  const languages = new Set<string>([...before.translations.keys(), ...after.translations.keys()]);
  for (const table of [glossaryBefore, glossaryAfter]) {
    if (table) for (const language of glossaryLanguages(table.table.header)) languages.add(language);
  }
  const counts: Record<string, { text: number; glossary: number }> = {};
  for (const language of [...languages].sort()) {
    const textBefore = keyedOrBroken(before.translations.has(language) ? before.translations.get(language) : null, KEY, byKey);
    const textAfter = keyedOrBroken(after.translations.has(language) ? after.translations.get(language) : null, KEY, byKey);
    if ([textBefore, textAfter, glossaryBefore, glossaryAfter].includes(undefined)) continue;
    counts[language] = {
      text: changedCells(textBefore ?? null, textAfter ?? null, 'text'),
      glossary: changedCells(glossaryBefore ?? null, glossaryAfter ?? null, language),
    };
  }
  return counts;
}
