import { tableCells } from '../../check/static/lib/specs.ts';
import { isMetric } from '../../telemetry/lib/metrics.ts';

/** A row of a `design.md` target table with its cells as written (backquotes removed). */
export interface TargetRow {
  /** 1-based line in `design.md`. */
  line: number;
  metric: string;
  min: string;
  max: string;
  data: string;
}

const SECTIONS = new Set(['## feel targets', '## tuning targets']);

function unquote(cell: string): string {
  return cell.replace(/^`(.*)`$/, '$1').trim();
}

/**
 * Rows of the `## feel targets` and `## tuning targets` tables (game-design `## design doc`) in document order.
 * A section ends at any heading. A table is a run of `|` lines; its first line is the header, read by column name.
 * Tables without a `metric` column are not target tables.
 */
export function targetRows(doc: string): TargetRow[] {
  const out: TargetRow[] = [];
  let inSection = false;
  let columns: string[] | null = null;
  doc.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (/^#+ /.test(line)) {
      inSection = SECTIONS.has(line);
      columns = null;
      return;
    }
    if (!inSection || !line.startsWith('|')) {
      if (!line.startsWith('|')) columns = null;
      return;
    }
    const cells = tableCells(line);
    if (columns === null) {
      columns = cells.map((c) => unquote(c).toLowerCase());
      return;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) return;
    const cols = columns;
    if (!cols.includes('metric')) return;
    const get = (name: string): string => unquote(cells[cols.indexOf(name)] ?? '');
    out.push({ line: i + 1, metric: get('metric'), min: get('min'), max: get('max'), data: get('data') });
  });
  return out;
}

/** What is wrong with a target row: a metric outside the metric names, a non-integer min or max, min greater than max. */
export function rowProblems(row: TargetRow): string[] {
  const out: string[] = [];
  if (!isMetric(row.metric)) out.push(`\`${row.metric}\` is not a metric name`);
  const minOk = /^-?[0-9]+$/.test(row.min);
  const maxOk = /^-?[0-9]+$/.test(row.max);
  if (!minOk) out.push(`min \`${row.min}\` of \`${row.metric}\` is not an integer`);
  if (!maxOk) out.push(`max \`${row.max}\` of \`${row.metric}\` is not an integer`);
  if (minOk && maxOk && BigInt(row.min) > BigInt(row.max)) out.push(`min ${row.min} of \`${row.metric}\` is greater than max ${row.max}`);
  return out;
}
