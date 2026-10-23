/** A markdown table: header cells and rows, each with the 1-based line number of the file. */
export interface MdTable {
  /** `##` heading the table is under. */
  section: string;
  header: string[];
  rows: { line: number; cells: string[] }[];
}

/** Cells of a markdown table line (`| a | b |`), trimmed. */
export function tableCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((cell) => cell.trim());
}

/** Text without the backticks of code spans. */
export function stripTicks(text: string): string {
  return text.replace(/`/g, '');
}

/** Every table of a markdown text outside code fences. */
export function markdownTables(text: string): MdTable[] {
  const lines = text.split(/\r?\n/);
  const tables: MdTable[] = [];
  let section = '';
  let fence = false;
  let current: MdTable | null = null;
  lines.forEach((line, index) => {
    if (line.startsWith('```')) fence = !fence;
    if (fence) return;
    if (line.startsWith('## ')) section = line.slice(3).trim();
    const isRow = line.trim().startsWith('|');
    if (!isRow) {
      current = null;
      return;
    }
    if (current === null) {
      current = { section, header: tableCells(line).map(stripTicks), rows: [] };
      tables.push(current);
    } else if (!/^\|?\s*:?-{3,}/.test(line.trim())) {
      current.rows.push({ line: index + 1, cells: tableCells(line) });
    }
  });
  return tables;
}

/** Text of code spans in a cell, in order. */
export function codeSpans(cell: string): string[] {
  return [...cell.matchAll(/`([^`]*)`/g)].map((m) => m[1] as string);
}
