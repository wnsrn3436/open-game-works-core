import { describe, expect, it } from 'vitest';
import { inOrder, pooled } from '../../src/lib/pool.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('pooled', () => {
  it('runs at most limit at a time and keeps the order of the items', async () => {
    let running = 0;
    let most = 0;
    const results = await pooled([30, 5, 20, 1, 10, 2], 3, async (ms, i) => {
      running++;
      most = Math.max(most, running);
      await sleep(ms);
      running--;
      return `${String(i)}:${String(ms)}`;
    });
    expect(results).toEqual(['0:30', '1:5', '2:20', '3:1', '4:10', '5:2']);
    expect(most).toBe(3);
  });

  it('starts no item after one failed and throws the failure of the first failed item in order', async () => {
    const started: number[] = [];
    await expect(pooled([0, 1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n);
      // item 1 fails after item 0 does: the failure of item 0 is the one thrown
      await sleep(n === 0 ? 10 : 1);
      if (n <= 1) throw new Error(`item ${String(n)}`);
      return n;
    })).rejects.toThrow('item 0');
    expect(started).toEqual([0, 1]);
    expect(await pooled([], 4, () => Promise.resolve(1))).toEqual([]);
  });
});

describe('inOrder', () => {
  it('takes the results in item order while the work of the next items runs, at most ahead of them', async () => {
    let running = 0;
    let most = 0;
    const taken: number[] = [];
    // later items end sooner: the takes still come in item order
    await inOrder([0, 1, 2, 3, 4, 5, 6, 7], 4, async (n) => {
      running++;
      most = Math.max(most, running);
      await sleep(2 + 3 * (7 - n));
      running--;
      return n;
    }, (n) => {
      taken.push(n);
    });
    expect(taken).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(most).toBe(4);
  });

  it('throws the failure of an item at its turn, after the items before it were taken', async () => {
    const taken: number[] = [];
    await expect(inOrder([0, 1, 2, 3], 4, async (n) => {
      await sleep(n === 1 ? 5 : 1);
      if (n === 1 || n === 3) throw new Error(`item ${String(n)}`);
      return n;
    }, (n) => {
      taken.push(n);
    })).rejects.toThrow('item 1');
    expect(taken).toEqual([0]);
  });
});
