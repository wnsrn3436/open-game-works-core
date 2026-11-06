import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isStale, releaseFolder, takeFolder, withLockWithin } from './lock.ts';

const POLL_MS = 500;
/** The name of a holder folder: its share, then a random id. */
const HOLDER = /^([1-9][0-9]*)-[0-9a-f]+$/;

/**
 * Runs `fn` holding `share` of the `total` units of the ledger `dir`: the callers of all processes on this host together
 * hold at most `total` at once. A share above `total` is `total`, so it runs alone. A holder is a folder
 * `<dir>/holders/<share>-<id>` with its owner file inside, as a `withLock` lock; it is made under the ledger lock
 * `<dir>/lock` only when the live holders leave room for the whole share, so a share is taken whole or not at all and
 * partial holders never wait for each other. A holder whose process is gone counts for nothing and is removed. Waits
 * without a time limit.
 */
export async function withShare<T>(dir: string, total: number, share: number, fn: () => Promise<T>): Promise<T> {
  const units = Math.max(1, total);
  const holder = await takeShare(dir, units, Math.max(1, Math.min(share, units)));
  try {
    return await fn();
  } finally {
    await releaseFolder(holder);
  }
}

async function takeShare(dir: string, total: number, share: number): Promise<string> {
  const holders = join(dir, 'holders');
  await mkdir(holders, { recursive: true });
  for (;;) {
    // a look without the lock first, so the waiters that do not fit keep off it
    if ((await held(holders, false)) + share <= total) {
      const taken = await withLockWithin(join(dir, 'lock'), async () => {
        if ((await held(holders, true)) + share > total) return null;
        const holder = join(holders, `${String(share)}-${randomBytes(6).toString('hex')}`);
        return (await takeFolder(holder)) ? holder : null;
      }, POLL_MS);
      if (taken.ran && taken.value !== null) return taken.value;
    }
    await sleep(POLL_MS);
  }
}

/**
 * The units the live holders in `holders` hold. With `prune` (only under the ledger lock), the folder of each holder whose
 * process is gone is removed. A holder that ends while it is read counts: it was there.
 */
async function held(holders: string, prune: boolean): Promise<number> {
  let sum = 0;
  for (const name of await readdir(holders)) {
    const share = HOLDER.exec(name)?.[1];
    if (share === undefined) continue;
    const holder = join(holders, name);
    if (await isStale(holder)) {
      if (prune) await rm(holder, { recursive: true, force: true });
      continue;
    }
    sum += Number(share);
  }
  return sum;
}
