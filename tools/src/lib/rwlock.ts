import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { OgwError } from './errors.ts';
import { whenNotFound } from './fsx.ts';
import { isStale, ownerText, withLock, withLockWithin } from './lock.ts';
import { takeWaits, taking } from './spans.ts';

const READERS_POLL_MS = 500;

/**
 * A reader/writer file lock: the writer lock folder `base`, the folder `<base>-readers` with one entry per reader, and the
 * folder `<base>-writers` with one entry per writer that waits for the writer lock. A writer waits, holding the writer
 * lock, until no live reader is left, so readers that start meanwhile wait for it. Readers and `withWriterLock` that start
 * while a writer waits for the writer lock let it go first, so back-to-back readers do not keep it out. Every wait of a
 * reader or writer, on the writer lock, on the readers or on the waiting writers, is a wait on `base` (ogw.md `## time`).
 */
export interface RwLock {
  base: string;
  waitMs: number;
}

/**
 * The reader entry of each lock this process reads, with the count of its readers; the last one to end removes it.
 * `ready` once the entry is there.
 */
const held = new Map<string, Reading>();

interface Reading {
  count: number;
  entry: Promise<() => Promise<void>>;
  ready: boolean;
}

function readersDir(lock: RwLock): string {
  return `${lock.base}-readers`;
}

function writersDir(lock: RwLock): string {
  return `${lock.base}-writers`;
}

/** Runs `fn` as the writer: no reader runs meanwhile. Until it holds the writer lock, it is a waiting writer. */
export async function withWriter<T>(lock: RwLock, fn: () => Promise<T>): Promise<T> {
  const waiting = await addEntry(writersDir(lock));
  try {
    return await withLock(lock.base, async () => {
      await waiting();
      await noReaders(lock);
      return fn();
    }, lock.waitMs);
  } finally {
    await waiting();
  }
}

/**
 * What a writer that gave up waited for: the writer lock, which another writer held, the end of the readers, or the end
 * of the other holders (`withWriterWithin`).
 */
export type WriterWait = 'writer' | 'readers' | 'others';

/**
 * `withWriter` that waits at most `lock.waitMs` in all for the writer lock, then the end of the readers, then the end of
 * the holders that `othersEnd` waits for until the deadline it gets (holders that are no reader entry, which keep off
 * while a writer holds or waits: `writerHoldsOrWaits`). When one does not come by then, it does not run `fn` and says
 * which it waited for.
 */
export async function withWriterWithin<T>(
  lock: RwLock,
  fn: () => Promise<T>,
  othersEnd: (deadline: number) => Promise<boolean> = () => Promise.resolve(true),
): Promise<{ ran: true; value: T } | { ran: false; waited: WriterWait }> {
  const deadline = Date.now() + lock.waitMs;
  const waiting = await addEntry(writersDir(lock));
  try {
    const taken = await withLockWithin(lock.base, async () => {
      await waiting();
      if (!(await taking(lock.base, () => liveEntriesEnd(readersDir(lock), deadline)))) return { ran: false as const, waited: 'readers' as const };
      if (!(await othersEnd(deadline))) return { ran: false as const, waited: 'others' as const };
      return { ran: true as const, value: await fn() };
    }, Math.max(0, deadline - Date.now()));
    return taken.ran ? taken.value : { ran: false, waited: 'writer' };
  } finally {
    await waiting();
  }
}

/**
 * Whether a writer holds the writer lock or waits for it: a holder that is no reader entry starts only when this is
 * false, so that a waiting writer goes first. A holder checks it, and starts, under a lock that the writer's `othersEnd`
 * takes too, so that the writer sees each holder that started before it held the writer lock.
 */
export async function writerHoldsOrWaits(lock: RwLock): Promise<boolean> {
  if ((await liveEntries(writersDir(lock))) > 0) return true;
  return (await stat(lock.base).catch(whenNotFound(null))) !== null && !(await isStale(lock.base));
}

/** Runs `fn` holding the writer lock without waiting for readers: writers wait, readers go on. */
export async function withWriterLock<T>(lock: RwLock, fn: () => Promise<T>): Promise<T> {
  return afterWaitingWriters(lock, fn, held.has(lock.base));
}

const LET_WRITER_GO = Symbol('let a waiting writer go');

/**
 * Runs `fn` holding the writer lock once no writer waits for it. A process that `reads` the lock (it held a reader entry
 * when the call started) does not wait for waiting writers: each of them waits for its reader.
 */
async function afterWaitingWriters<T>(lock: RwLock, fn: () => Promise<T>, reads: boolean): Promise<T> {
  const deadline = Date.now() + lock.waitMs;
  for (;;) {
    if (!reads) await noLiveEntries(lock, writersDir(lock), deadline, `writers waiting for ${lock.base}`);
    // a writer that came between the wait and the take goes first too
    const ran = await withLock(lock.base, async () => (!reads && (await liveEntries(writersDir(lock))) > 0 ? LET_WRITER_GO : { value: await fn() }), Math.max(0, deadline - Date.now()));
    if (ran !== LET_WRITER_GO) return ran.value;
  }
}


/**
 * Runs `fn` as a reader: it starts when no writer runs or waits, and writers wait for it. While this process already
 * reads the lock, another reader of it in this process goes on at once under the same entry: a reader nested in another
 * would otherwise take the writer lock and wait for a writer that waits for the outer reader. The entry stays until the
 * last reader of this process ends.
 */
export async function withReader<T>(lock: RwLock, fn: () => Promise<T>): Promise<T> {
  let reading = held.get(lock.base);
  // a reader that joins an entry still being taken waits for it as the reader that takes it does
  const joins = reading !== undefined && !reading.ready;
  if (reading === undefined) {
    reading = takeReading(lock);
    held.set(lock.base, reading);
  }
  reading.count += 1;
  const shared = reading;
  let release: (() => Promise<void>) | undefined;
  try {
    release = joins
      ? await taking(lock.base, () => {
          takeWaits();
          return shared.entry;
        })
      : await shared.entry;
    return await fn();
  } finally {
    shared.count -= 1;
    if (shared.count === 0) {
      if (held.get(lock.base) === shared) held.delete(lock.base);
      // a take that failed has no entry to remove: its failure is thrown above
      if (release !== undefined) await release();
    }
  }
}

/** The reader entry of this process for `lock`, being taken: `ready` once it is there. */
function takeReading(lock: RwLock): Reading {
  const reading: Reading = { count: 0, entry: Promise.resolve(() => Promise.resolve()), ready: false };
  // a failed take leaves no entry: the next reader tries again; each reader gets the failure
  reading.entry = taking(lock.base, () => afterWaitingWriters(lock, () => addReader(lock), false)).then(
    (release) => {
      reading.ready = true;
      return release;
    },
    (error: unknown) => {
      held.delete(lock.base);
      throw error;
    },
  );
  return reading;
}

/** Leaves a reader entry of this process; returns the function that removes it. Call it holding the writer lock. */
export async function addReader(lock: RwLock): Promise<() => Promise<void>> {
  return addEntry(readersDir(lock));
}

/** Leaves an entry of this process in `dir`; returns the function that removes it. */
async function addEntry(dir: string): Promise<() => Promise<void>> {
  const entry = join(dir, `${String(process.pid)}-${randomBytes(6).toString('hex')}`);
  await mkdir(entry, { recursive: true });
  await writeFile(join(entry, 'pid'), ownerText());
  return () => rm(entry, { recursive: true, force: true });
}

/** The live entries of `dir`. An entry whose process is gone is left over from a crash: it is removed. */
async function liveEntries(dir: string): Promise<number> {
  let live = 0;
  for (const name of await readdir(dir).catch(whenNotFound([]))) {
    const entry = join(dir, name);
    if (await isStale(entry)) await rm(entry, { recursive: true, force: true });
    else live += 1;
  }
  return live;
}

/** Waits, as a wait on `lock`, until `dir` has no live entry; fails when the deadline comes first. */
async function noLiveEntries(lock: RwLock, dir: string, deadline: number, what: string): Promise<void> {
  if (!(await taking(lock.base, () => liveEntriesEnd(dir, deadline)))) throw new OgwError(`${what} did not end in time`);
}

/** Waits until `dir` has no live entry; false when the deadline came first. The take that runs waits from the first look that finds one. */
async function liveEntriesEnd(dir: string, deadline: number): Promise<boolean> {
  while ((await liveEntries(dir)) > 0) {
    takeWaits();
    if (Date.now() >= deadline) return false;
    await sleep(READERS_POLL_MS);
  }
  return true;
}

async function noReaders(lock: RwLock): Promise<void> {
  await noLiveEntries(lock, readersDir(lock), Date.now() + lock.waitMs, `readers of ${lock.base}`);
}
