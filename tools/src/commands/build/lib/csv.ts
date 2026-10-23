import { parseCsv, type Row } from '../../../lib/datatable.ts';

export { dataRows, parseCsv, type Row } from '../../../lib/datatable.ts';

/** A file with one header row (for example `resources.csv`): rows as objects. */
export function headerRows(text: string): Row[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  return rows.filter((r) => r.some((c) => c !== '')).map((r) => Object.fromEntries(header.map((name, i) => [name, r[i] ?? ''])));
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** A `duration` cell (`1d2h30m`, `500ms`) in ms; null when it is not one. */
export function parseDuration(cell: string): number | null {
  const text = cell.trim();
  if (text === '') return null;
  let total = 0;
  let rest = text;
  while (rest.length > 0) {
    const m = /^(\d+)(ms|s|m|h|d)/.exec(rest);
    if (!m) return null;
    total += Number(m[1]) * (UNIT_MS[m[2] as string] as number);
    rest = rest.slice(m[0].length);
  }
  return total;
}
