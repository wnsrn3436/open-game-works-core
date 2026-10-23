import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataTable } from '../../../lib/datatable.ts';
import { OgwError } from '../../../lib/errors.ts';

/** A data table: column names (header row 4) and the data rows that are built (`id` not starting with `#`). */
export interface DataTable {
  name: string;
  columns: string[];
  rows: Record<string, string>[];
}

/** Reads `data/tables/<table>.csv` of a checkout (data `## CSV format`). */
export async function readTable(root: string, table: string): Promise<DataTable> {
  const path = join(root, 'data', 'tables', `${table}.csv`);
  const text = await readFile(path, 'utf8').catch(() => {
    throw new OgwError(`data table not found: ${path}`);
  });
  const parsed = dataTable(text);
  if (!parsed) throw new OgwError(`data table has no header: ${path}`);
  return { name: table, ...parsed };
}

/** An `int` cell; null for the cell `null`. */
export function intCell(table: string, row: Record<string, string>, column: string): number | null {
  const cell = row[column];
  if (cell === 'null') return null;
  const value = Number(cell);
  if (cell === undefined || cell === '' || !Number.isInteger(value)) {
    throw new OgwError(`${table} ${String(row.id)}: ${column} is not an integer: ${String(cell)}`);
  }
  return value;
}

export function boolCell(table: string, row: Record<string, string>, column: string): boolean {
  const cell = row[column];
  if (cell === 'true') return true;
  if (cell === 'false') return false;
  throw new OgwError(`${table} ${String(row.id)}: ${column} is not a bool: ${String(cell)}`);
}
