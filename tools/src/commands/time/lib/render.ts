import { lengthOf, type TimeFlag } from './analyze.ts';
import type { TimeReport } from './report.ts';
import type { TimeSpan } from './tree.ts';

/** A duration as `1h 02m 03s`, `4m 05s`, `12.3s` or `340ms`. */
export function formatMs(ms: number): string {
  const whole = Math.round(ms);
  if (whole < 1000) return `${String(whole)}ms`;
  if (whole < 60_000) return `${(whole / 1000).toFixed(1)}s`;
  const seconds = Math.round(whole / 1000);
  const two = (n: number): string => String(n).padStart(2, '0');
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${String(h)}h ${two(m)}m ${two(s)}s` : `${String(m)}m ${two(s)}s`;
}

/** A share as a percent with one decimal. */
export function formatShare(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/** A span as `<name> (<key>)`, with `, running` or `, failed`. */
function label(span: TimeSpan): string {
  const state = span.open ? ', running' : span.failed ? ', failed' : '';
  return span.kind === 'run' ? `${span.name}${state ? ` (${state.slice(2)})` : ''}` : `${span.name} (${span.key}${state})`;
}

function flagLine(flag: TimeFlag, report: TimeReport): string {
  const c = report.criteria;
  switch (flag.flag) {
    case 'wait':
      return `wait: ${flag.name} (${flag.job}) waited ${formatMs(flag.ms)} on ${flag.on}, ${formatShare(flag.share)} of its wall time ${formatMs(flag.wallMs)} (time.waitShare ${String(c.waitShare)})`;
    case 'idle':
      return `idle: ${flag.name} (${flag.job}) spent ${formatMs(flag.ms)} in no step span, started job or wait, ${formatShare(flag.share)} of its wall time ${formatMs(flag.wallMs)} (time.idleShare ${String(c.idleShare)})`;
    case 'outlier':
      return `outlier: ${flag.name} (${flag.key}) took ${formatMs(flag.ms)}, more than ${String(c.outlierRatio)} times the median ${formatMs(flag.median)} of its last ${String(flag.count)} earlier spans (time.outlierRatio)`;
  }
}

/** The lines of `ogw time` (ogw.md `## time`). */
export function renderReport(report: TimeReport): string {
  const root = report.root;
  const wall = lengthOf(root);
  const share = (ms: number): string => (wall === 0 ? '-' : formatShare(ms / wall));
  const lines = [
    `${label(root)}: wall time ${formatMs(wall)}, ${new Date(root.start).toISOString()} to ${new Date(root.end).toISOString()}`,
    '',
    'critical path:',
    ...report.path.map(({ span, depth }) => `  ${'  '.repeat(depth)}${formatMs(lengthOf(span))} ${share(lengthOf(span))} ${label(span)}`),
    '',
    'largest self time:',
    ...report.self.map(({ span, ms }) => `  ${formatMs(ms)} ${share(ms)} ${label(span)}`),
    '',
    'waits:',
    ...(report.waits.length === 0 ? ['  none'] : report.waits.map((w) => `  ${formatMs(w.ms)} ${share(w.ms)} ${w.on} (${String(w.count)} ${w.count === 1 ? 'wait' : 'waits'})`)),
    '',
    'flags:',
    ...(report.flags.length === 0 ? ['  none'] : report.flags.map((flag) => `  ${flagLine(flag, report)}`)),
  ];
  return lines.join('\n');
}

/**
 * The body of the `## time` section of a record (ogw.md `## time`): the wall time, the spans of depth 1 of the critical
 * path, and one line per flag, or `- flags: none`.
 */
export function timeSection(report: TimeReport): string {
  const wall = lengthOf(report.root);
  const share = (ms: number): string => (wall === 0 ? '-' : formatShare(ms / wall));
  const top = report.path.filter((entry) => entry.depth === 1).map(({ span }) => `${label(span)} ${formatMs(lengthOf(span))} ${share(lengthOf(span))}`);
  return [
    `- wall time: ${formatMs(wall)}`,
    `- critical path: ${top.length === 0 ? 'none' : top.join('; ')}`,
    ...(report.flags.length === 0 ? ['- flags: none'] : report.flags.map((flag) => `- flag: ${flagLine(flag, report)}`)),
  ].join('\n');
}

/** A span of the `--json` form: the span with its waits as `{on, ms}` and its child spans, by key. */
export interface SpanData {
  key: string;
  kind: TimeSpan['kind'];
  job: string;
  name: string;
  parent: string | null;
  start: number;
  end: number;
  open: boolean;
  failed: boolean;
  waits: { on: string; start: number; ms: number; open: boolean }[];
  children: SpanData[];
}

function spanData(span: TimeSpan, parent: string | null): SpanData {
  return {
    key: span.key,
    kind: span.kind,
    job: span.job,
    name: span.name,
    parent,
    start: span.start,
    end: span.end,
    open: span.open,
    failed: span.failed,
    waits: span.waits.map((w) => ({ on: w.on, start: w.start, ms: lengthOf(w), open: w.open })),
    children: span.children.map((child) => spanData(child, span.key)),
  };
}

/** The `--json` form of `ogw time`. */
export function reportData(report: TimeReport): unknown {
  return {
    root: spanData(report.root, null),
    wallMs: lengthOf(report.root),
    criticalPath: report.path.map(({ span, depth }) => ({ key: span.key, name: span.name, depth, start: span.start, end: span.end, ms: lengthOf(span) })),
    selfTime: report.self.map(({ span, ms }) => ({ key: span.key, name: span.name, ms })),
    waits: report.waits,
    flags: report.flags,
    criteria: report.criteria,
  };
}
