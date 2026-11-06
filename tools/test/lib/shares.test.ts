import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { hostBootId, pidNamespace } from '../../src/lib/proc.ts';
import { withShare } from '../../src/lib/shares.ts';
import { holdInChild, marked, markersDir, type ShareHolder } from '../helpers/share-holder.ts';

function ledger(): string {
  return join(mkdtempSync(join(tmpdir(), 'ogw-shares-')), 'ledger');
}

/** A pid whose process has ended. */
function goneProcess(): number {
  return Number(spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim());
}

/** `promise`, or `'stuck'` when it has not settled within `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | 'stuck'> {
  return Promise.race([promise, sleep(ms).then(() => 'stuck' as const)]);
}

/** A caller of this process that holds `share` until `release` is called; `started` gives what it saw when it started (`marked`). */
function holdHere(dir: string, total: number, share: number, markers: string): { started: Promise<number>; release: () => void; done: Promise<number> } {
  let release: () => void = () => undefined;
  let started: (sum: number) => void = () => undefined;
  const begun = new Promise<number>((resolve) => {
    started = resolve;
  });
  const done = withShare(dir, total, share, () => marked(markers, share, (sum) => {
    started(sum);
    return new Promise<number>((resolve) => {
      release = () => {
        resolve(sum);
      };
    });
  }));
  return {
    started: begun,
    release: () => {
      release();
    },
    done,
  };
}

describe('withShare', () => {
  const children: ShareHolder[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill();
  });
  function child(dir: string, total: number, share: number, markers: string): ShareHolder {
    const holder = holdInChild(dir, total, share, markers);
    children.push(holder);
    return holder;
  }

  it('holds at most the total with holders of other processes, and starts a waiter when a share frees', async () => {
    const dir = ledger();
    const markers = markersDir();
    const first = child(dir, 4, 3, markers);
    expect(await first.held).toBe(3);
    // a waiter in another process and one in this process: 2 does not fit beside 3
    const second = child(dir, 4, 2, markers);
    const here = holdHere(dir, 4, 2, markers);
    await sleep(1500);
    expect(second.holding()).toBe(false);
    expect(await within(here.started, 0)).toBe('stuck');
    // 1 fits beside 3 at once
    expect(await withShare(dir, 4, 1, () => marked(markers, 1, (sum) => Promise.resolve(sum)))).toBe(4);
    first.release();
    await first.exited;
    // both waiters of 2 fit in the 4 that are free now
    expect(await second.held).toBeLessThanOrEqual(4);
    expect(await here.started).toBeLessThanOrEqual(4);
    second.release();
    here.release();
    await Promise.all([second.exited, here.done]);
  });

  it('takes a share whole under the ledger lock, so takers that start at once never hold more than the total', async () => {
    const dir = ledger();
    const markers = markersDir();
    const shares = [1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3];
    const seen = await Promise.all(shares.map((share) => withShare(dir, 4, share, () => marked(markers, share, async (sum) => {
      await sleep(30);
      return sum;
    }))));
    expect(seen).toHaveLength(shares.length);
    expect(Math.max(...seen)).toBeLessThanOrEqual(4);
  });

  it('drops a holder whose process is gone', async () => {
    const dir = ledger();
    const markers = markersDir();
    const holder = child(dir, 4, 4, markers);
    await holder.held;
    const waiter = withShare(dir, 4, 1, () => Promise.resolve('ran'));
    await sleep(800);
    expect(await within(waiter, 0)).toBe('stuck');
    holder.kill();
    await holder.exited;
    expect(await within(waiter, 5000)).toBe('ran');
    // a holder folder that a process left behind when it ended
    const left = join(dir, 'holders', '4-0123456789ab');
    mkdirSync(left);
    writeFileSync(join(left, 'pid'), `${String(goneProcess())}\n${pidNamespace() ?? ''}\n${hostBootId() ?? ''}\nx\n`);
    expect(await within(withShare(dir, 4, 4, () => Promise.resolve('ran')), 5000)).toBe('ran');
    expect(existsSync(left)).toBe(false);
  });

  it('holds a share above the total as the total: it runs alone', async () => {
    const dir = ledger();
    const markers = markersDir();
    const big = holdHere(dir, 2, 5, markers);
    expect(await within(big.started, 5000)).toBe(5);
    const small = holdHere(dir, 2, 1, markers);
    await sleep(1200);
    expect(await within(small.started, 0)).toBe('stuck');
    big.release();
    await big.done;
    expect(await within(small.started, 5000)).toBe(1);
    small.release();
    await small.done;
  });

  it('runs holders and waiters of mixed shares to the end without holding more than the total', async () => {
    const dir = ledger();
    const markers = markersDir();
    const three = child(dir, 4, 3, markers);
    await three.held;
    const one = holdHere(dir, 4, 1, markers);
    await one.started;
    // waiters of 2 (another process), 3 and 3 (this process): none fits while 3 and 1 hold
    const two = child(dir, 4, 2, markers);
    const threes = [holdHere(dir, 4, 3, markers), holdHere(dir, 4, 3, markers)];
    await sleep(1200);
    expect(two.holding()).toBe(false);
    for (const waiter of threes) expect(await within(waiter.started, 0)).toBe('stuck');
    three.release();
    one.release();
    await Promise.all([three.exited, one.done]);
    // each waiter runs once the shares before it free; each lets go 300 ms after it starts
    const sums = await within(Promise.all([
      two.held.then(async (sum) => {
        await sleep(300);
        two.release();
        await two.exited;
        return sum;
      }),
      ...threes.map(async (waiter) => {
        const sum = await waiter.started;
        await sleep(300);
        waiter.release();
        await waiter.done;
        return sum;
      }),
    ]), 15_000);
    expect(sums).not.toBe('stuck');
    for (const sum of sums as number[]) expect(sum).toBeLessThanOrEqual(4);
  });
});
