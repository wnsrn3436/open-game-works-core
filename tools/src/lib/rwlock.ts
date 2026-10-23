import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { OgwError } from './errors.ts';
import { isStale, ownerText, withLock } from './lock.ts';

const READERS_POLL_MS = 500;

/**
 * A reader/writer file lock: the writer lock folder `base`, the folder `<base>-readers` with one entry per reader, and the
 * folder `<base>-writers` with one entry per writer that waits for the writer lock. A writer waits, holding the writer
 * lock, until no live reader is left, so readers that start meanwhile wait for it. Readers and `withWriterLock` that start
 * while a writer waits for the writer lock let it go first, so back-to-back readers do not keep it out.
 */
export interface RwLock {
  base: string;
  waitMs: number;
}

/** The reader entry of each lock this process reads, with the count of its readers; the last one to end removes it. */
const held = new Map<string, { count: number; entry: Promise<() => Promise<void>> }>();

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
    if (!reads) await noLiveEntries(writersDir(lock), deadline, `writers waiting for ${lock.base}`);
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
  if (reading === undefined) {
    reading = { count: 0, entry: afterWaitingWriters(lock, () => addReader(lock), false) };
    held.set(lock.base, reading);
    // a failed take leaves no entry: the next reader tries again
    reading.entry.catch(() => held.delete(lock.base));
  }
  reading.count += 1;
  const shared = reading;
  try {
    await shared.entry;
    return await fn();
  } finally {
    shared.count -= 1;
    if (shared.count === 0) {
      if (held.get(lock.base) === shared) held.delete(lock.base);
      await shared.entry.then((release) => release(), () => undefined);
    }
  }
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
  for (const name of await readdir(dir).catch(() => [])) {
    const entry = join(dir, name);
    if (await isStale(entry)) await rm(entry, { recursive: true, force: true });
    else live += 1;
  }
  return live;
}

async function noLiveEntries(dir: string, deadline: number, what: string): Promise<void> {
  while ((await liveEntries(dir)) > 0) {
    if (Date.now() >= deadline) throw new OgwError(`${what} did not end in time`);
    await sleep(READERS_POLL_MS);
  }
}

async function noReaders(lock: RwLock): Promise<void> {
  await noLiveEntries(readersDir(lock), Date.now() + lock.waitMs, `readers of ${lock.base}`);
}
