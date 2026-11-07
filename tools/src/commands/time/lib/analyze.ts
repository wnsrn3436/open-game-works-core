import type { HarnessSettings } from '../../../lib/settings.ts';
import { JOB_START } from '../../../lib/spans.ts';
import { spansOf, type TimeSpan } from './tree.ts';

export type TimeCriteria = HarnessSettings['time'];

/** The span length in ms. */
export function lengthOf(span: Pick<TimeSpan, 'start' | 'end'>): number {
  return Math.max(0, span.end - span.start);
}

/** The ms that the union of `intervals`, each cut to `[from, to)`, covers. */
export function unionMs(intervals: readonly { start: number; end: number }[], from: number, to: number): number {
  const cut = intervals
    .map((i) => ({ start: Math.max(from, i.start), end: Math.min(to, i.end) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let open: { start: number; end: number } | null = null;
  for (const interval of cut) {
    if (open !== null && interval.start <= open.end) open.end = Math.max(open.end, interval.end);
    else {
      if (open !== null) total += open.end - open.start;
      open = { ...interval };
    }
  }
  return open === null ? total : total + open.end - open.start;
}

/** The self time of a span: its length less the time its child spans cover. */
export function selfMs(span: TimeSpan): number {
  return lengthOf(span) - unionMs(span.children, span.start, span.end);
}

/** A span of the critical path, with its depth below the root. */
export interface PathEntry {
  span: TimeSpan;
  depth: number;
}

/**
 * The child spans whose ends decide the end of `span`, in time order: from the end of `span` back, the child that ended
 * last at or before the cursor, after which the cursor moves to that child's start.
 */
export function decidingChildren(span: TimeSpan): TimeSpan[] {
  const chain: TimeSpan[] = [];
  let cursor = span.end;
  let left = span.children;
  for (;;) {
    let last: TimeSpan | null = null;
    for (const child of left) if (child.end <= cursor && (last === null || child.end > last.end)) last = child;
    if (last === null) return chain.reverse();
    chain.push(last);
    cursor = last.start;
    const picked = last;
    left = left.filter((child) => child !== picked);
  }
}

/** The critical path of a tree: the root, then each deciding child followed by its own critical path. */
export function criticalPath(root: TimeSpan): PathEntry[] {
  const out: PathEntry[] = [];
  const visit = (span: TimeSpan, depth: number): void => {
    out.push({ span, depth });
    for (const child of decidingChildren(span)) visit(child, depth + 1);
  };
  visit(root, 0);
  return out;
}

/** The spans of the tree with the largest self time, largest first, at most `count`. */
export function largestSelf(root: TimeSpan, count: number): { span: TimeSpan; ms: number }[] {
  return spansOf(root)
    .map((span) => ({ span, ms: selfMs(span) }))
    .sort((a, b) => b.ms - a.ms || a.span.key.localeCompare(b.span.key))
    .slice(0, count);
}

/** The total wait per lock, slot or ledger over `spans`, largest first. */
export function waitTotals(spans: readonly TimeSpan[]): { on: string; ms: number; count: number }[] {
  const totals = new Map<string, { ms: number; count: number }>();
  for (const span of spans) {
    for (const wait of span.waits) {
      const total = totals.get(wait.on) ?? { ms: 0, count: 0 };
      totals.set(wait.on, { ms: total.ms + lengthOf(wait), count: total.count + 1 });
    }
  }
  return [...totals].map(([on, t]) => ({ on, ...t })).sort((a, b) => b.ms - a.ms || a.on.localeCompare(b.on));
}

/** The spans of the job of the job span `job` in its tree: its job span and its step spans, not the jobs it started. */
export function ownSpans(job: TimeSpan): TimeSpan[] {
  const out: TimeSpan[] = [];
  const visit = (span: TimeSpan): void => {
    out.push(span);
    for (const child of span.children) if (child.kind === 'step' && child.job === job.job) visit(child);
  };
  visit(job);
  return out;
}

export type TimeFlag =
  | { flag: 'wait'; job: string; name: string; on: string; ms: number; wallMs: number; share: number }
  | { flag: 'idle'; job: string; name: string; ms: number; wallMs: number; share: number }
  | { flag: 'outlier'; job: string; key: string; name: string; ms: number; median: number; count: number };

/** `wait`: the waits of the job's own spans on one lock, slot or ledger add up to at least `waitShare` of its wall time. */
export function waitFlags(job: TimeSpan, criteria: TimeCriteria): TimeFlag[] {
  const wall = lengthOf(job);
  if (wall === 0) return [];
  return waitTotals(ownSpans(job))
    .filter((total) => total.ms >= criteria.waitShare * wall)
    .map((total) => ({ flag: 'wait', job: job.job, name: job.name, on: total.on, ms: total.ms, wallMs: wall, share: total.ms / wall }));
}

/**
 * `idle`: the wall time of a job that has a step span other than `job start`, less the union of its child spans (step spans and the jobs it
 * started) and of the waits of its job span, is at least `idleShare` of its wall time.
 */
export function idleFlags(job: TimeSpan, criteria: TimeCriteria): TimeFlag[] {
  const wall = lengthOf(job);
  if (wall === 0 || !job.children.some((child) => child.kind === 'step' && child.name !== JOB_START)) return [];
  const idle = wall - unionMs([...job.children, ...job.waits], job.start, job.end);
  if (idle < criteria.idleShare * wall) return [];
  return [{ flag: 'idle', job: job.job, name: job.name, ms: idle, wallMs: wall, share: idle / wall }];
}

/** A finished span of the same name and game: when it ended and how long it took. */
export interface Sample {
  end: number;
  ms: number;
}

/** The median of `values` (not empty): the middle value, or the mean of the two middle values. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** The fewest earlier spans of a name for which `outlier` judges a span. */
export const OUTLIER_MIN_HISTORY = 5;

/**
 * `outlier`: a span that ended lasts more than `outlierRatio` times the median of the last `history` spans of its name
 * and game that ended, without failing, at or before its start (`samples`, in end order), when there are at least
 * `OUTLIER_MIN_HISTORY` of them.
 */
export function outlierFlag(span: TimeSpan, samples: readonly Sample[], criteria: TimeCriteria): TimeFlag[] {
  if (span.kind === 'run' || span.open) return [];
  const earlier = samples.filter((sample) => sample.end <= span.start).slice(-criteria.history);
  if (earlier.length < OUTLIER_MIN_HISTORY) return [];
  const mid = median(earlier.map((sample) => sample.ms));
  const ms = lengthOf(span);
  if (ms <= criteria.outlierRatio * mid) return [];
  return [{ flag: 'outlier', job: span.job, key: span.key, name: span.name, ms, median: mid, count: earlier.length }];
}

/** The flags of a tree: `wait` and `idle` of each job span, `outlier` of each job and step span. */
export function flagsOf(root: TimeSpan, history: (span: TimeSpan) => readonly Sample[], criteria: TimeCriteria): TimeFlag[] {
  const spans = spansOf(root);
  const jobs = spans.filter((span) => span.kind === 'job');
  return [
    ...jobs.flatMap((job) => waitFlags(job, criteria)),
    ...jobs.flatMap((job) => idleFlags(job, criteria)),
    ...spans.flatMap((span) => outlierFlag(span, history(span), criteria)),
  ];
}
