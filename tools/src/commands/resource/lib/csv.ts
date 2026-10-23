import { formatCsvLine, parseCsvRows } from '../../../lib/csv.ts';
import { OgwError } from '../../../lib/errors.ts';

/** Parses RFC 4180 CSV text (`parseCsvRecords`) into rows of cells. A trailing line break ends the last row. */
export function parseCsv(text: string, where: string): string[][] {
  return parseCsvRows(text, where);
}

/** Formats rows as CSV with LF line ends and a trailing line break. */
export function formatCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => formatCsvLine(row, '\n')).join('');
}

/** A table read as records by column name. */
export interface Table {
  header: string[];
  records: Record<string, string>[];
  /** File line of each record (1-based). */
  lines: number[];
}

/** Reads a CSV with `headerRows` header rows; the column names are the last header row. */
export function parseTable(text: string, where: string, headerRows = 1): Table {
  const rows = parseCsv(text, where);
  if (rows.length < headerRows) throw new OgwError(`${where}: missing header`);
  const header = rows[headerRows - 1] as string[];
  const lines: number[] = [];
  const records = rows.slice(headerRows).map((row, index) => {
    const line = index + headerRows + 1;
    if (row.length !== header.length) {
      throw new OgwError(`${where}:${String(line)}: ${String(row.length)} cells, header has ${String(header.length)}`);
    }
    lines.push(line);
    const record: Record<string, string> = {};
    header.forEach((name, i) => {
      record[name] = row[i] as string;
    });
    return record;
  });
  return { header, records, lines };
}
