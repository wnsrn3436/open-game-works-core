import { AsyncLocalStorage } from 'node:async_hooks';
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
 */
class SpanFile {
  readonly path: string;
  #fd: number | null = null;
  failure: Error | null = null;

  constructor(path: string) {
    this.path = path;
  }

  write(line: SpanLine): void {
    if (this.failure !== null) return;
    try {
      this.#fd ??= openSync(this.path, 'a');
      writeSync(this.#fd, `${JSON.stringify(line)}\n`);
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
    }
  }

  close(): void {
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

/** A span or wait id unique in a spans file: the pid of the writing process and a count. */
function nextId(): string {
  lastId += 1;
  return `${process.pid.toString(36)}.${lastId.toString(36)}`;
}

/**
 * Runs the command of job `job`, whose steps and waits go to the spans file `path` (ogw.md `## time`), in its step span
 * `parent` (null: the job span; a process that another process of the job started, such as an instance supervisor, goes
 * on in the span that started it). When a line could not be written, the command fails with that error once `fn` ends;
 * a failure of `fn` itself stays its result.
 */
export async function inJob<T>(job: string, path: string, fn: () => Promise<T>, parent: string | null = null): Promise<T> {
  const file = new SpanFile(path);
  let value: T;
  try {
    value = await storage.run({ job, file, span: parent, take: null }, fn);
  } finally {
    file.close();
  }
  if (file.failure !== null) throw new OgwError(`cannot write the spans file ${path}: ${file.failure.message}`);
  return value;
}

/**
 * The step span `job start` of the command process of a job: from `startedAt` of its job record, before its supervisor
 * started it, to the start of its command (ogw.md `## time`).
 */
export function jobStart(path: string, startedAt: number): void {
  const file = new SpanFile(path);
  const line: StepLine = { id: nextId(), name: 'job start', parent: null, start: startedAt, end: Date.now() };
  file.write({ ...line, end: null });
  file.write(line);
  file.close();
  if (file.failure !== null) throw new OgwError(`cannot write the spans file ${path}: ${file.failure.message}`);
}

/** Runs `fn` outside the job of this async context, as the work of another process runs (e.g. an instance supervisor). */
export function outsideJob<T>(fn: () => T): T {
  return storage.exit(fn);
}

/** The job and step span that run in this async context; null outside a job. */
export function spanContext(): { job: string; span: string | null } | null {
  const store = storage.getStore();
  return store === undefined ? null : { job: store.job, span: store.span };
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
