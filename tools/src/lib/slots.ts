import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { releaseFolder, removeIfStale, takeFolder } from './lock.ts';
import { takeWaits, taking } from './spans.ts';

const POLL_MS = 2000;

/**
 * Runs `fn` holding one of `count` slots in `dir`: at most `count` callers across processes run their `fn` at once.
 * A slot is a folder `<dir>/<n>` with the owner pid and its PID namespace inside, as a `withLock` lock; a slot whose
 * owner process is gone is taken over. Waits without a time limit for a free slot; a take that finds no free slot at its
 * first pass is a wait on `dir` (ogw.md `## time`).
 */
export async function withSlot<T>(dir: string, count: number, fn: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  const slot = await taking(dir, () => takeSlot(dir, count));
  try {
    return await fn();
  } finally {
    await releaseFolder(slot);
  }
}

async function takeSlot(dir: string, count: number): Promise<string> {
  for (;;) {
    for (let n = 1; n <= count; n += 1) {
      const slot = join(dir, String(n));
      if (await takeFolder(slot)) return slot;
      await removeIfStale(slot);
    }
    takeWaits();
    await sleep(POLL_MS);
  }
}
