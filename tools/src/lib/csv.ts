import { OgwError } from './errors.ts';

/** One CSV record: its cells, the 1-based line it starts on, and its offsets in the parsed text without the line break. */
export interface CsvRecord {
  cells: string[];
  line: number;
  start: number;
  end: number;
}

interface Cursor {
  text: string;
  i: number;
  line: number;
  where: string | undefined;
}

function fail(c: Cursor, line: number, reason: string): never {
  throw new OgwError(c.where === undefined ? `invalid CSV: line ${String(line)}: ${reason}` : `${c.where}:${String(line)}: ${reason}`);
}

function lineBreaks(text: string): number {
  return text.match(/\r\n|\r|\n/g)?.length ?? 0;
}

function readQuoted(c: Cursor): string {
  const startLine = c.line;
  let value = '';
  c.i++;
  for (;;) {
    const at = c.text.indexOf('"', c.i);
    if (at === -1) fail(c, startLine, 'unclosed quote');
    const part = c.text.slice(c.i, at);
    c.line += lineBreaks(part);
    value += part;
    if (c.text[at + 1] === '"') {
      value += '"';
      c.i = at + 2;
      continue;
    }
    c.i = at + 1;
    return value;
  }
}

function readPlain(c: Cursor): string {
  let end = c.i;
  for (; end < c.text.length; end++) {
    const ch = c.text[end] as string;
    if (ch === ',' || ch === '\r' || ch === '\n') break;
    if (ch === '"') fail(c, c.line, 'quote inside an unquoted cell');
  }
  const value = c.text.slice(c.i, end);
  c.i = end;
  return value;
}

/** Ends a record at a line break or the end of the text. */
function endRecord(c: Cursor): void {
  const ch = c.text[c.i];
  if (ch === undefined) return;
  if (ch !== '\r' && ch !== '\n') fail(c, c.line, 'text after a quoted field');
  c.i += ch === '\r' && c.text[c.i + 1] === '\n' ? 2 : 1;
  c.line++;
}

/**
 * Parses CSV text (`data` skill `## CSV format`: RFC 4180). A leading BOM is skipped; CRLF, LF and CR end a record; a
 * line break after the last record does not make an empty one, and an empty line is a record of one empty cell. A quote
 * inside an unquoted cell, text after a closing quote and an unclosed quote throw `OgwError` naming `where` and the line.
 */
export function parseCsvRecords(text: string, where?: string): CsvRecord[] {
  const c: Cursor = { text, i: text.startsWith('\uFEFF') ? 1 : 0, line: 1, where };
  const records: CsvRecord[] = [];
  while (c.i < c.text.length) {
    const record: CsvRecord = { cells: [], line: c.line, start: c.i, end: c.i };
    for (;;) {
      record.cells.push(c.text[c.i] === '"' ? readQuoted(c) : readPlain(c));
      if (c.text[c.i] !== ',') break;
      c.i++;
    }
    record.end = c.i;
    endRecord(c);
    records.push(record);
  }
  return records;
}

/** A cell as RFC 4180 writes it: quoted when it has a quote, a comma or a line break. */
export function formatCsvCell(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/** RFC 4180 records (`parseCsvRecords`) as rows of cells. */
export function parseCsvRows(text: string, where?: string): string[][] {
  return parseCsvRecords(text, where).map((record) => record.cells);
}

/** One CSV line of the cells with its line end. */
export function formatCsvLine(row: readonly string[], eol: string): string {
  return row.map(formatCsvCell).join(',') + eol;
}
