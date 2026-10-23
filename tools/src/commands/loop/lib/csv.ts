import type { CsvTable } from '../../agent/lib/csv.ts';

/** Rows by the value of the key columns joined with a NUL. */
export function rowsByKey(csv: CsvTable, keys: readonly string[]): Map<string, string[]> {
  const indexes = keys.map((k) => csv.header.indexOf(k));
  const map = new Map<string, string[]>();
  if (indexes.some((i) => i < 0)) return map;
  for (const row of csv.rows) map.set(indexes.map((i) => row[i] ?? '').join('\u0000'), row);
  return map;
}
