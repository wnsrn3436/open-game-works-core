import { readFile } from 'node:fs/promises';
import { OgwError } from '../../../lib/errors.ts';
import { whenNotFound } from '../../../lib/fsx.ts';
import { jobPaths, type JobRecord } from '../../../lib/jobs.ts';
import type { SpanLine, StepLine, WaitLine } from '../../../lib/spans.ts';

/** A wait of a span: on a lock, slot or ledger, from `start` to `end`. */
export interface TimeWait {
  on: string;
  start: number;
  end: number;
  /** No end line: the wait still ran when its job ended (or runs now). */
  open: boolean;
}

/** A span of a time tree (ogw.md `## time`): a job span, a step span, or the run span of `--run`. */
export interface TimeSpan {
  /** `<job>` for a job span, `<job>/<span id>` for a step span, `run <run>` for a run span. */
  key: string;
  kind: 'job' | 'step' | 'run';
  /** The job the span is of; empty for a run span. */
  job: string;
  game: string | null;
  name: string;
  start: number;
  end: number;
  /** No end: a step span without its end line, a job still running; `end` is then the end of its job, or now. */
  open: boolean;
  /** A step span that ended by throwing, a job that ended `failed`. */
  failed: boolean;
  children: TimeSpan[];
  waits: TimeWait[];
}

/** The name of a job span: `ogw <command>`, and the role for an `ogw agent` job. */
export function jobSpanName(job: Pick<JobRecord, 'command' | 'meta'>): string {
  const role = job.meta.role;
  return job.command === 'agent' && typeof role === 'string' ? `ogw agent ${role}` : `ogw ${job.command}`;
}

/** Whether `value` is a step line (a string `name`) or a wait line (a string `wait`) of the spans file format. */
function validLine(value: unknown): value is SpanLine {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const line = value as Record<string, unknown>;
  const parent = line.parent === null || typeof line.parent === 'string';
  const end = line.end === null || typeof line.end === 'number';
  const kind = typeof line.name === 'string' || typeof line.wait === 'string';
  return typeof line.id === 'string' && parent && typeof line.start === 'number' && end && kind;
}

/**
 * The lines of a spans file by id, the last line of an id (its end line) over the first; none when there is no file. A
 * line that is not a span or wait line fails with its file and line number.
 */
export async function readSpanLines(path: string): Promise<Map<string, SpanLine>> {
  const text = await readFile(path, 'utf8').catch(whenNotFound(''));
  const lines = new Map<string, SpanLine>();
  text.split('\n').forEach((raw, index) => {
    if (raw === '') return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new OgwError(`${path}:${String(index + 1)}: not a span line: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!validLine(value)) throw new OgwError(`${path}:${String(index + 1)}: not a span line`);
    lines.set(value.id, value);
  });
  return lines;
}

/** The records and spans files a tree is made from, with the spans files read at most once. */
export interface TimeSource {
  records: ReadonlyMap<string, JobRecord>;
  /** The jobs each job started (`parentJob`), in start order. */
  children: ReadonlyMap<string, readonly JobRecord[]>;
  now: number;
  spans(id: string): Promise<Map<string, SpanLine>>;
}

export function timeSource(records: readonly JobRecord[], env: NodeJS.ProcessEnv, now: number = Date.now()): TimeSource {
  const byId = new Map(records.map((record) => [record.id, record]));
  const children = new Map<string, JobRecord[]>();
  for (const record of [...records].sort((a, b) => a.startedAt - b.startedAt)) {
    const parent = record.parentJob;
    if (typeof parent !== 'string') continue;
    children.set(parent, [...(children.get(parent) ?? []), record]);
  }
  const read = new Map<string, Promise<Map<string, SpanLine>>>();
  return {
    records: byId,
    children,
    now,
    spans: (id) => {
      let lines = read.get(id);
      if (lines === undefined) {
        lines = jobPaths(id, env).then((paths) => readSpanLines(paths.spans));
        read.set(id, lines);
      }
      return lines;
    },
  };
}

/** The end of a job: when it ended, or now while it runs. */
function jobEnd(job: JobRecord, now: number): number {
  return job.endedAt ?? now;
}

function stepSpan(job: JobRecord, line: StepLine, end: number): TimeSpan {
  return {
    key: `${job.id}/${line.id}`,
    kind: 'step',
    job: job.id,
    game: job.game,
    name: line.name,
    start: line.start,
    end: line.end ?? end,
    open: line.end === null,
    failed: line.failed === true,
    children: [],
    waits: [],
  };
}

function waitOf(line: WaitLine, end: number): TimeWait {
  return { on: line.wait, start: line.start, end: line.end ?? end, open: line.end === null };
}

/** The span a line or child job with `parent` (a span id of `job`, or null) goes in; fails for an id without a line. */
function parentOf(root: TimeSpan, steps: ReadonlyMap<string, TimeSpan>, parent: string | null | undefined, what: string): TimeSpan {
  if (parent === null || parent === undefined) return root;
  const span = steps.get(parent);
  if (span === undefined) throw new OgwError(`job ${root.job}: ${what} is in span ${parent}, which its spans file does not hold`);
  return span;
}

function byStart(a: TimeSpan, b: TimeSpan): number {
  return a.start - b.start || a.key.localeCompare(b.key);
}

/**
 * The span tree of a job: its job span from its record, the step spans and waits of its spans file, and the trees of
 * the jobs it started under the step span that ran when each started.
 */
export async function jobTree(source: TimeSource, job: JobRecord, seen: Set<string> = new Set()): Promise<TimeSpan> {
  seen.add(job.id);
  const end = jobEnd(job, source.now);
  const root: TimeSpan = {
    key: job.id,
    kind: 'job',
    job: job.id,
    game: job.game,
    name: jobSpanName(job),
    start: job.startedAt,
    end,
    open: job.endedAt === null,
    failed: job.status === 'failed',
    children: [],
    waits: [],
  };
  const lines = [...(await source.spans(job.id)).values()];
  const steps = new Map<string, TimeSpan>();
  for (const line of lines) if ('name' in line) steps.set(line.id, stepSpan(job, line, end));
  for (const line of lines) {
    if ('name' in line) parentOf(root, steps, line.parent, `span ${line.id}`).children.push(steps.get(line.id) as TimeSpan);
    else parentOf(root, steps, line.parent, `wait ${line.id}`).waits.push(waitOf(line, end));
  }
  for (const child of source.children.get(job.id) ?? []) {
    if (seen.has(child.id)) continue;
    parentOf(root, steps, child.parentSpan, `job ${child.id}`).children.push(await jobTree(source, child, seen));
  }
  for (const span of [root, ...steps.values()]) {
    span.children.sort(byStart);
    span.waits.sort((a, b) => a.start - b.start);
  }
  return root;
}

/** Every span of a tree, the tree's root first, parents before their children. */
export function spansOf(root: TimeSpan): TimeSpan[] {
  const out: TimeSpan[] = [];
  const visit = (span: TimeSpan): void => {
    out.push(span);
    for (const child of span.children) visit(child);
  };
  visit(root);
  return out;
}
