import { sectionLines } from '../../build/lib/markdown.ts';
import { cell, column, parseTable } from '../../loop/lib/markdown.ts';
import { metricValue, type FreeScenes, type Telemetry } from './metrics.ts';

/** Elements of judge `## fun judgement criteria` and the metrics of their `telemetry` column. */
export const ELEMENTS: readonly { element: string; metrics: readonly string[]; failureOnly: boolean }[] = [
  { element: 'game feel', metrics: ['input_latency_ms', 'feedback_per_input'], failureOnly: false },
  { element: 'tension and release', metrics: [], failureOnly: true },
  { element: 'progression', metrics: ['reward_interval_ms'], failureOnly: false },
  { element: 'one more run', metrics: ['restart_delay_ms'], failureOnly: true },
  { element: 'no friction', metrics: ['idle_span_ms', 'goal_input_count'], failureOnly: false },
  { element: 'presentation', metrics: [], failureOnly: false },
];

export interface MetricComparison {
  metric: string;
  a: number | null;
  b: number | null;
  /** null unless both values exist. */
  d: number | null;
  /** `compareRepeatedTelemetry`: the value of each run of `A` and of `B`. */
  runs?: { a: (number | null)[]; b: (number | null)[] };
}

export interface ElementComparison {
  element: string;
  metrics: MetricComparison[];
  winner: 'A' | 'B' | 'indistinguishable' | 'no telemetry' | 'n/a';
  margin: '' | 'slight' | 'clear' | 'decisive';
}

/** abs(A − B) ÷ max(abs(A), abs(B)); 0 when both are 0. */
export function distance(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? 0 : Math.abs(a - b) / scale;
}

function better(metric: string, a: number, b: number): 'A' | 'B' {
  const higherIsBetter = metric === 'feedback_per_input';
  return (higherIsBetter ? a > b : a < b) ? 'A' : 'B';
}

/** An `input_latency_ms` difference of at most one frame at 60 fps is not a difference. */
const FRAME_MS = 17;

function metricDistance(metric: string, a: number, b: number): number {
  if (metric === 'input_latency_ms' && Math.abs(a - b) <= FRAME_MS) return 0;
  return distance(a, b);
}

function margin(d: number): ElementComparison['margin'] {
  if (d < 0.15) return 'slight';
  if (d < 0.3) return 'clear';
  return 'decisive';
}

function judge(metrics: MetricComparison[]): Pick<ElementComparison, 'winner' | 'margin'> {
  let top: MetricComparison | null = null;
  for (const m of metrics) if (m.d !== null && (top === null || m.d > (top.d as number))) top = m;
  if (top === null) return { winner: 'no telemetry', margin: '' };
  const d = top.d as number;
  if (d < 0.05) return { winner: 'indistinguishable', margin: '' };
  return { winner: better(top.metric, top.a as number, top.b as number), margin: margin(d) };
}

/** `ogw telemetry compare`: per element the metric values, d, winner and margin. `freeA`, `freeB` come from each play guide. */
export function compareTelemetry(a: Telemetry, b: Telemetry, noFailure: boolean, freeA: FreeScenes = null, freeB: FreeScenes = null): ElementComparison[] {
  return ELEMENTS.map(({ element, metrics, failureOnly }) => {
    const rows = metrics.map((metric) => {
      const va = metricValue(metric, [{ telemetry: a, state: {} }], freeA);
      const vb = metricValue(metric, [{ telemetry: b, state: {} }], freeB);
      return { metric, a: va, b: vb, d: va !== null && vb !== null ? metricDistance(metric, va, vb) : null };
    });
    if (failureOnly && noFailure) return { element, metrics: rows, winner: 'n/a', margin: '' };
    return { element, metrics: rows, ...judge(rows) };
  });
}

function mean(values: readonly (number | null)[]): number | null {
  if (values.some((v) => v === null) || values.length === 0) return null;
  return (values as number[]).reduce((x, y) => x + y, 0) / values.length;
}

/**
 * The runs of the two sides are apart: the gap between the closest runs of `A` and of `B` is larger than the spread
 * (largest minus smallest run) of either side. Runs that only just miss each other are not apart.
 */
function apart(a: readonly number[], b: readonly number[]): boolean {
  const gap = Math.max(Math.min(...a) - Math.max(...b), Math.min(...b) - Math.max(...a));
  const spread = Math.max(Math.max(...a) - Math.min(...a), Math.max(...b) - Math.min(...b));
  return gap > spread;
}

/**
 * The comparison of several runs of `A` and of `B` (`game-loop` `## iteration` 4 shared telemetry): a metric value is
 * the mean of its runs, and `d` is 0 unless the runs of `A` and of `B` are apart, because otherwise the difference is
 * not larger than the difference between runs of one commit.
 */
export function compareRepeatedTelemetry(
  a: readonly Telemetry[],
  b: readonly Telemetry[],
  noFailure: boolean,
  freeA: FreeScenes = null,
  freeB: FreeScenes = null,
): ElementComparison[] {
  return ELEMENTS.map(({ element, metrics, failureOnly }) => {
    const rows = metrics.map((metric) => {
      const ra = a.map((t) => metricValue(metric, [{ telemetry: t, state: {} }], freeA));
      const rb = b.map((t) => metricValue(metric, [{ telemetry: t, state: {} }], freeB));
      const va = mean(ra);
      const vb = mean(rb);
      let d: number | null = null;
      if (va !== null && vb !== null) d = apart(ra as number[], rb as number[]) ? metricDistance(metric, va, vb) : 0;
      return { metric, a: va, b: vb, d, runs: { a: ra, b: rb } };
    });
    if (failureOnly && noFailure) return { element, metrics: rows, winner: 'n/a', margin: '' };
    return { element, metrics: rows, ...judge(rows) };
  });
}

/** The content under `## failure` of a play guide is `none`. */
export function failureIsNone(playGuide: string): boolean {
  const lines = sectionLines(playGuide, 'failure');
  return lines !== null && lines.length === 1 && (lines[0] as string).trim() === 'none';
}

/** The free scenes of `## play mode` of a play guide (`FreeScenes`); null when it has no scene of another mode. */
export function freeScenes(playGuide: string): FreeScenes {
  const table = parseTable(sectionLines(playGuide, 'play mode') ?? []);
  if (!table) return null;
  const sceneCol = column(table, 'scene');
  const modeCol = column(table, 'mode');
  if (sceneCol < 0 || modeCol < 0) return null;
  const free = new Set<string>();
  let other = false;
  for (const row of table.rows) {
    if (cell(row, modeCol) === 'free') free.add(cell(row, sceneCol));
    else other = true;
  }
  return other ? free : null;
}

function num(value: number | null): string {
  if (value === null) return 'none';
  return String(Math.round(value * 1000) / 1000);
}

export function formatComparison(elements: readonly ElementComparison[]): string {
  const lines: string[] = [];
  for (const e of elements) {
    const verdict = e.margin === '' ? `winner ${e.winner}` : `winner ${e.winner}, margin ${e.margin}`;
    lines.push(`${e.element}: ${verdict}`);
    for (const m of e.metrics) {
      const runs = m.runs === undefined ? '' : ` (runs A ${m.runs.a.map(num).join(' ')}, B ${m.runs.b.map(num).join(' ')})`;
      lines.push(`  ${m.metric}: A ${num(m.a)}, B ${num(m.b)}, d ${num(m.d)}${runs}`);
    }
  }
  return lines.join('\n');
}
