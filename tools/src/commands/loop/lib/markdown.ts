/** Markdown helpers for the records the loop commands read and write. */

import { section } from '../../../lib/markdown.ts';

export { section };

/** Section text without leading and trailing blank lines; null when the heading is missing. */
export function sectionText(text: string, heading: string): string | null {
  const lines = section(text, heading);
  if (lines === null) return null;
  return trimBlank(lines).join('\n');
}

export function trimBlank(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] as string).trim() === '') start++;
  while (end > start && (lines[end - 1] as string).trim() === '') end--;
  return lines.slice(start, end);
}

/** Splits a table row on `|` that are not escaped with `\`. */
export function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch === '\\' && body[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');
}

export interface Table {
  header: string[];
  rows: { cells: string[]; line: number }[];
}

/**
 * The first table in `lines`. `line` of a row is its index in `lines`.
 * Header cells lose their code span backticks.
 */
export function parseTable(lines: readonly string[]): Table | null {
  for (let i = 0; i + 1 < lines.length; i++) {
    const head = lines[i] as string;
    if (!head.trim().startsWith('|') || !isSeparator(lines[i + 1] as string)) continue;
    const header = splitRow(head).map(unquote);
    const rows: Table['rows'] = [];
    for (let j = i + 2; j < lines.length && (lines[j] as string).trim().startsWith('|'); j++) {
      rows.push({ cells: splitRow(lines[j] as string), line: j });
    }
    return { header, rows };
  }
  return null;
}

/** Removes one surrounding code span. */
export function unquote(text: string): string {
  const t = text.trim();
  return t.length >= 2 && t.startsWith('`') && t.endsWith('`') ? t.slice(1, -1) : t;
}

export function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

export function renderTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
  ];
  return lines.join('\n');
}

/** Column index by header name (backticks removed, case-insensitive); -1 when missing. */
export function column(table: Table, name: string): number {
  return table.header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
}

export function cell(row: { cells: string[] }, index: number): string {
  return index < 0 ? '' : unquote(row.cells[index] ?? '');
}

/** Builds a markdown document from `## heading` and body pairs, in order. */
export function document(sections: readonly (readonly [string, string])[]): string {
  return sections.map(([heading, body]) => `## ${heading}\n\n${body.trim() === '' ? 'none' : body.trim()}\n`).join('\n');
}
