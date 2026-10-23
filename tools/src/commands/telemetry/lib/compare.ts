import { sectionLines } from '../../build/lib/markdown.ts';
import { metricValue, type Telemetry } from './metrics.ts';

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

/** `ogw telemetry compare`: per element the metric values, d, winner and margin. */
export function compareTelemetry(a: Telemetry, b: Telemetry, noFailure: boolean): ElementComparison[] {
  return ELEMENTS.map(({ element, metrics, failureOnly }) => {
    const rows = metrics.map((metric) => {
      const va = metricValue(metric, [{ telemetry: a, state: {} }]);
      const vb = metricValue(metric, [{ telemetry: b, state: {} }]);
      return { metric, a: va, b: vb, d: va !== null && vb !== null ? distance(va, vb) : null };
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

function num(value: number | null): string {
  if (value === null) return 'none';
  return String(Math.round(value * 1000) / 1000);
}

export function formatComparison(elements: readonly ElementComparison[]): string {
  const lines: string[] = [];
  for (const e of elements) {
    const verdict = e.margin === '' ? `winner ${e.winner}` : `winner ${e.winner}, margin ${e.margin}`;
    lines.push(`${e.element}: ${verdict}`);
    for (const m of e.metrics) lines.push(`  ${m.metric}: A ${num(m.a)}, B ${num(m.b)}, d ${num(m.d)}`);
  }
  return lines.join('\n');
}
