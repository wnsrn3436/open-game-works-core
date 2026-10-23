import { formatCsvLine, parseCsvRows } from '../../../lib/csv.ts';
import { OgwError } from '../../../lib/errors.ts';

/** A CSV table (RFC 4180): the header row and the data rows. */
export interface CsvTable {
  header: string[];
  rows: string[][];
  /** Line ending of the file the table was read from. */
  eol: '\n' | '\r\n';
}

/** RFC 4180 records (`parseCsvRecords`) as rows of cells. A trailing line ending does not make an empty record. */
export function parseRecords(text: string): string[][] {
  return parseCsvRows(text);
}

export function parseCsv(text: string): CsvTable {
  const records = parseRecords(text);
  const header = records[0] ?? [];
  return { header, rows: records.slice(1), eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

export function formatCsv(table: CsvTable): string {
  return [table.header, ...table.rows].map((row) => formatCsvLine(row, table.eol)).join('');
}

/** Index of a column; fails when the header does not have it. */
export function column(table: CsvTable, name: string): number {
  const index = table.header.indexOf(name);
  if (index === -1) throw new OgwError(`CSV has no column ${name}`);
  return index;
}

/** The cells of a row of `from` columns put on the `to` columns by name; a column `from` lacks gets an empty cell. */
export function onHeader(to: readonly string[], from: readonly string[], cells: readonly string[]): string[] {
  return to.map((name) => {
    const at = from.indexOf(name);
    return at === -1 ? '' : (cells[at] ?? '');
  });
}
