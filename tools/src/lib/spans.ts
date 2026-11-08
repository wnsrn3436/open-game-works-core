import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';
import { OgwError } from './errors.ts';

/**
 * A line of the spans file of a job (ogw.md `## time`): a step span or a wait. Each is written once when it starts,
 * with `end` null, and once more when it ends.
 */
export type SpanLine = StepLine | WaitLine;

/** A step of a job's command. */
export interface StepLine {
  id: string;
  name: string;
  /** Id of the step span it runs in; null: the job span. */
  parent: string | null;
  start: number;
  end: number | null;
  /** The step ended by throwing. */
  failed?: true;
}

/** A wait on a lock, slot or ledger: the take that did not succeed at its first try, until it took it or gave up. */
export interface WaitLine {
  id: string;
  /** The path of the lock, slot folder or ledger folder waited on. */
  wait: string;
  /** Id of the step span the wait is in; null: the job span. */
  parent: string | null;
  start: number;
  end: number | null;
}

/**
 * The spans file of the job a process runs: opened at the first line, appended to with one write per line. A line that
 * cannot be written is kept as `failure` and no line is written after it, so that the step, lock, slot or share that
 * wrote it goes on as without a job (a take lets go of what it took); `inJob` fails the command with it when it ends.
 * Once closed, it writes no line: the work a command left running after its end (an event handler of a process it
 * started) records nothing.
 */
class SpanFile {
  readonly path: string;
  #fd: number | null = null;
  #closed = false;
  failure: Error | null = null;

  constructor(path: string) {
    this.path = path;
  }

  /** Whether every line so far was written: a span whose start was not written is no parent a child can name. */
  get written(): boolean {
    return this.failure === null;
  }

  write(line: SpanLine): void {
    if (this.failure !== null || this.#closed) return;
    try {
      this.#fd ??= openSync(this.path, 'a');
      writeSync(this.#fd, `${JSON.stringify(line)}\n`);
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#fd === null) return;
    closeSync(this.#fd);
    this.#fd = null;
  }
}

/** A take that runs (`taking`): the wait of the lock, slot or ledger `on`, written once the take fails a first time. */
interface Take {
  on: string;
  start: number;
  parent: string | null;
  /** Id of its wait line; null while the take has not failed. */
  id: string | null;
}

interface Store {
  job: string;
  file: SpanFile;
  /** The innermost step span that runs; null: the job span. */
  span: string | null;
  take: Take | null;
}

const storage = new AsyncLocalStorage<Store>();
let lastId = 0;
/** What tells the lines of this process apart from those of another process with the same pid in one spans file. */
const processTag = randomBytes(3).toString('hex');

/**
 * A span or wait id unique in a spans file: the pid of the writing process, a tag of its own, and a count. Many processes
 * write one spans file (the instance supervisors and the side commands of a job), and a long job outlives pids.
 */
function nextId(): string {
  lastId += 1;
  return `${process.pid.toString(36)}${processTag}.${lastId.toString(36)}`;
}

/**
 * The environment variables that give a process that a step span of a job started that step span (ogw.md `## time`):
 * the job in `OGW_PARENT_JOB` and the step span, absent for the job span, in `OGW_PARENT_SPAN`.
 */
export const PARENT_JOB_ENV = 'OGW_PARENT_JOB';
export const PARENT_SPAN_ENV = 'OGW_PARENT_SPAN';

/** The job and step span (null: the job span) whose spans file a process writes in, given by its environment. */
export interface SpanParent {
  job: string;
  span: string | null;
}

/**
 * `env` for a process whose steps and waits go in the step span or job that runs in this async context (a side command
 * of `ogw regress`); outside a job, `env` without them.
 */
export function withSpanParent(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rest = Object.fromEntries(Object.entries(env).filter(([name]) => name !== PARENT_JOB_ENV && name !== PARENT_SPAN_ENV));
  const from = spanContext();
  if (from === null) return rest;
  return { ...rest, [PARENT_JOB_ENV]: from.job, ...(from.span === null ? {} : { [PARENT_SPAN_ENV]: from.span }) };
}

/**
 * The parent that `env` gives this process (`withSpanParent`), taken out of `env`, which it changes, so that the
 * processes this one starts do not write in that span; null when it gives none.
 */
export function takeSpanParent(env: NodeJS.ProcessEnv): SpanParent | null {
  const { OGW_PARENT_JOB: job, OGW_PARENT_SPAN: span } = env;
  delete env.OGW_PARENT_JOB;
  delete env.OGW_PARENT_SPAN;
  if (job === undefined || job === '') return null;
  return { job, span: span === undefined || span === '' ? null : span };
}

/** The name of the step span from the start of a job to the start of its command (ogw.md `## time`). */
export const JOB_START = 'job start';

/** How `inJob` runs: in which span, with which `job start`, and what a line it cannot write does. */
export interface InJobOptions {
  /** The step span it goes on in; null or absent: the job span. A process that another process of the job started goes on in the span that started it. */
  parent?: string | null;
  /** `startedAt` of the job record: the command process its supervisor started first writes the step span `job start` from it. */
  startedAt?: number;
  /**
   * `fail`: the command fails with the error once `fn` ends; `leave`: the failure is left to the command of the job,
   * which writes the same file (an instance supervisor, whose boot goes on).
   */
  writeFailure?: 'fail' | 'leave';
}

/**
 * Runs the command of job `job`, whose steps and waits go to the spans file `path` (ogw.md `## time`). When a line could
 * not be written, the command fails with that error once `fn` ends, unless `writeFailure` is `leave`; a failure of `fn`
 * itself stays its result.
 */
export async function inJob<T>(job: string, path: string, fn: () => Promise<T>, options: InJobOptions = {}): Promise<T> {
  const file = new SpanFile(path);
  if (options.startedAt !== undefined) {
    const line: StepLine = { id: nextId(), name: JOB_START, parent: null, start: options.startedAt, end: null };
    file.write(line);
    file.write({ ...line, end: Date.now() });
  }
  let value: T;
  try {
    value = await storage.run({ job, file, span: options.parent ?? null, take: null }, fn);
  } finally {
    file.close();
  }
  if (file.failure !== null && options.writeFailure !== 'leave') throw new OgwError(`cannot write the spans file ${path}: ${file.failure.message}`);
  return value;
}

/** Runs `fn` outside the job of this async context, as the work of another process runs (e.g. an instance supervisor). */
export function outsideJob<T>(fn: () => T): T {
  return storage.exit(fn);
}

/**
 * The job and step span that run in this async context; null outside a job. After a line could not be written the span
 * is the job span: the start of a later span may not be in the file.
 */
export function spanContext(): { job: string; span: string | null } | null {
  const store = storage.getStore();
  if (store === undefined) return null;
  return { job: store.job, span: store.file.written ? store.span : null };
}

/** Runs `fn` as the step span `name` of the step span or job that runs; outside a job it only runs `fn`. */
export async function span<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const open = openSpan(name);
  let value: T;
  try {
    value = await open.run(fn);
  } catch (error) {
    open.end(true);
    throw error;
  }
  open.end();
  return value;
}

/**
 * A step span whose start and end are not those of one call: a step of work that goes on across polls and tasks (e.g.
 * a play or judge of `ogw loop evaluate` from its first instance start to its result). `run` runs work in it, so that
 * the steps, waits and jobs of that work are in it; `end` ends it once, `failed` when the step failed.
 */
export interface OpenSpan {
  run<T>(fn: () => Promise<T>): Promise<T>;
  end(failed?: boolean): void;
}

/** Starts the step span `name` in the step span or job that runs; outside a job it records nothing. */
export function openSpan(name: string): OpenSpan {
  const store = storage.getStore();
  if (store === undefined) return { run: (fn) => fn(), end: () => undefined };
  const line: StepLine = { id: nextId(), name, parent: store.span, start: Date.now(), end: null };
  store.file.write(line);
  const inside: Store = { ...store, span: line.id, take: null };
  let ended = false;
  return {
    run: (fn) => storage.run(inside, fn),
    end: (failed = false) => {
      if (ended) return;
      ended = true;
      store.file.write({ ...line, end: Date.now(), ...(failed ? { failed: true as const } : {}) });
    },
  };
}

/**
 * Runs `take`, the take of the lock, slot or ledger `on`. When it calls `takeWaits`, the time from the start of `take`
 * to its end is a wait on `on` of the step span that runs. A take inside another take (a ledger lock of a share, the
 * writer lock of a reader) is part of the wait of the outer one: its `takeWaits` starts the wait of the outer take.
 */
export async function taking<T>(on: string, take: () => Promise<T>): Promise<T> {
  const store = storage.getStore();
  if (store === undefined || store.take !== null) return take();
  const current: Take = { on, start: Date.now(), parent: store.span, id: null };
  try {
    return await storage.run({ ...store, take: current }, take);
  } finally {
    if (current.id !== null) store.file.write({ id: current.id, wait: on, parent: current.parent, start: current.start, end: Date.now() });
  }
}

/**
 * Starts a wait on `on` that is not the take of one call (e.g. the groups of `ogw loop evaluate` waiting across polls for
 * room among the instances of the host), in the step span that runs; `end` ends it once. Outside a job it records
 * nothing; inside a take it is part of the wait of that take.
 */
export function openWait(on: string): { end: () => void } {
  const store = storage.getStore();
  if (store === undefined || store.take !== null) return { end: () => undefined };
  const line: WaitLine = { id: nextId(), wait: on, parent: store.span, start: Date.now(), end: null };
  store.file.write(line);
  let ended = false;
  return {
    end: () => {
      if (ended) return;
      ended = true;
      store.file.write({ ...line, end: Date.now() });
    },
  };
}

/** The take that runs did not succeed at this try: its wait starts at the start of the take (written once). */
export function takeWaits(): void {
  const store = storage.getStore();
  const current = store?.take;
  if (store === undefined || current === null || current === undefined || current.id !== null) return;
  current.id = nextId();
  store.file.write({ id: current.id, wait: current.on, parent: current.parent, start: current.start, end: null });
}
