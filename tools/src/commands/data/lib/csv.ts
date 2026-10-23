import { formatCsvCell, parseCsvRecords } from '../../../lib/csv.ts';

/** One CSV record with the 1-based line its first field starts on. */
export interface CsvRecord {
  fields: string[];
  line: number;
  /** Offsets of the record text in the parsed text, without the line break. */
  start: number;
  end: number;
}

/** Parses RFC 4180 CSV (`parseCsvRecords`). A trailing line break ends the last record. */
export function parseCsv(text: string, file: string): CsvRecord[] {
  return parseCsvRecords(text, file).map(({ cells, line, start, end }) => ({ fields: cells, line, start, end }));
}

export interface CsvRow {
  values: Record<string, string>;
  line: number;
  start: number;
  end: number;
}

/** A CSV with a one-line header: rows as objects keyed by header name. */
export interface CsvTable {
  header: string[];
  rows: CsvRow[];
  /** The parsed text. */
  text: string;
}

export function parseTable(text: string, file: string): CsvTable {
  const records = parseCsv(text, file);
  const header = records[0]?.fields ?? [];
  const rows = records.slice(1).map((record) => {
    const values: Record<string, string> = {};
    header.forEach((name, i) => (values[name] = record.fields[i] ?? ''));
    return { values, line: record.line, start: record.start, end: record.end };
  });
  return { header, rows, text };
}

/** The table text with the given rows written from their `values`; other bytes stay as they were. */
export function rewriteRows(table: CsvTable, rows: readonly CsvRow[]): string {
  let text = table.text;
  for (const row of [...rows].sort((a, b) => b.start - a.start)) {
    const record = table.header.map((name) => formatCsvCell(row.values[name] ?? '')).join(',');
    text = text.slice(0, row.start) + record + text.slice(row.end);
  }
  return text;
}
