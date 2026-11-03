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

/** The metrics whose values are decimals (`game-design` `## metrics`). */
const DECIMAL_METRICS: readonly string[] = ['feedback_per_input', 'feedback_share'];

/** What is wrong with a target row: a metric outside the metric names, a min or max of the wrong kind, min greater than max. */
export function rowProblems(row: TargetRow): string[] {
  const out: string[] = [];
  if (!isMetric(row.metric)) out.push(`\`${row.metric}\` is not a metric name`);
  const decimal = DECIMAL_METRICS.includes(row.metric);
  const shape = decimal ? /^-?[0-9]+(\.[0-9]+)?$/ : /^-?[0-9]+$/;
  const kind = decimal ? 'a number' : 'an integer';
  const minOk = shape.test(row.min);
  const maxOk = shape.test(row.max);
  if (!minOk) out.push(`min \`${row.min}\` of \`${row.metric}\` is not ${kind}`);
  if (!maxOk) out.push(`max \`${row.max}\` of \`${row.metric}\` is not ${kind}`);
  if (minOk && maxOk && Number(row.min) > Number(row.max)) out.push(`min ${row.min} of \`${row.metric}\` is greater than max ${row.max}`);
  return out;
}
