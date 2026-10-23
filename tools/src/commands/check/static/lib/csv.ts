import { builtRecords, parseCsvRecords, type CsvRow } from '../../../../lib/datatable.ts';

export type { CsvRow } from '../../../../lib/datatable.ts';
export { parseCsvRecords as parseCsv } from '../../../../lib/datatable.ts';

/** A `data/tables/` or `data/system/` table: 4 header rows (description, build target, type, name). */
export interface DataTable {
  path: string;
  targets: string[];
  types: string[];
  names: string[];
  /** Data rows that are built (`builtRecords`). */
  rows: CsvRow[];
}

export function parseDataTable(path: string, text: string): DataTable | null {
  const all = parseCsvRecords(text, path);
  const built = builtRecords(all);
  if (!built) return null;
  return { path, targets: all[1]?.cells ?? [], types: all[2]?.cells ?? [], names: built.names, rows: built.rows };
}

/** Cell of a data row by column name, or undefined when the column does not exist. */
export function cellOf(table: DataTable, row: CsvRow, column: string): string | undefined {
  const index = table.names.indexOf(column);
  return index === -1 ? undefined : (row.cells[index] ?? '');
}

