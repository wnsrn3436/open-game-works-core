import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { releaseFolder, removeIfStale, takeFolder } from './lock.ts';

const POLL_MS = 2000;

/**
 * Runs `fn` holding one of `count` slots in `dir`: at most `count` callers across processes run their `fn` at once.
 * A slot is a folder `<dir>/<n>` with the owner pid and its PID namespace inside, as a `withLock` lock; a slot whose
 * owner process is gone is taken over. Waits without a time limit for a free slot.
 */
export async function withSlot<T>(dir: string, count: number, fn: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  const slot = await takeSlot(dir, count);
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
    await sleep(POLL_MS);
  }
}
