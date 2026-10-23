import { parseCsvRecords as csvRecords, parseCsvRows } from './csv.ts';

/** An RFC 4180 record with the 1-based line it starts on. */
export interface CsvRow {
  cells: string[];
  line: number;
}

/** RFC 4180 records (`parseCsvRecords` of `csv.ts`) with their start lines. */
export function parseCsvRecords(text: string, where?: string): CsvRow[] {
  return csvRecords(text, where).map(({ cells, line }) => ({ cells, line }));
}

/** RFC 4180 rows (`parseCsvRecords`). */
export function parseCsv(text: string): string[][] {
  return parseCsvRows(text);
}

export function isBlankRecord(row: CsvRow): boolean {
  return row.cells.every((c) => c === '');
}

/**
 * The data table row rule (`data` skill `## CSV format`): four header rows, column names on row 4; the rows that are
 * built are the records after them that are not empty and whose `id` cell does not start with `#`. Null when the
 * records have no row 4.
 */
export function builtRecords(records: readonly CsvRow[]): { names: string[]; rows: CsvRow[] } | null {
  const names = records[3]?.cells;
  if (!names) return null;
  const idIndex = Math.max(names.indexOf('id'), 0);
  return {
    names,
    rows: records.slice(4).filter((r) => !isBlankRecord(r) && !(r.cells[idIndex] ?? '').startsWith('#')),
  };
}

export type Row = Record<string, string>;

/** A data table: the column names and the rows that are built (`builtRecords`) as objects. Null when it has no row 4. */
export function dataTable(text: string): { columns: string[]; rows: Row[] } | null {
  const table = builtRecords(parseCsvRecords(text));
  if (!table) return null;
  const columns = table.names;
  return { columns, rows: table.rows.map((r) => Object.fromEntries(columns.map((name, i) => [name, r.cells[i] ?? '']))) };
}

/** The built rows of a data table; none when it has no row 4. */
export function dataRows(text: string): Row[] {
  return dataTable(text)?.rows ?? [];
}
