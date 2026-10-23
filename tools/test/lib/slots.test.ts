import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { withSlot } from '../../src/lib/slots.ts';

describe('withSlot', () => {
  it('runs at most count callers at once and frees each slot when its caller ends', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ogw-slots-')), 'slots');
    let running = 0;
    let most = 0;
    const work = async (): Promise<number> => {
      running += 1;
      most = Math.max(most, running);
      await sleep(50);
      running -= 1;
      return 1;
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => withSlot(dir, 2, work)));
    expect(results).toEqual([1, 1, 1, 1, 1]);
    expect(most).toBe(2);
    await expect(withSlot(dir, 1, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await withSlot(dir, 1, () => Promise.resolve('free'))).toBe('free');
  });

  it('takes over a slot whose owner process is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-slots-'));
    mkdirSync(join(dir, '1'));
    // a pid no process has: the owner is gone
    writeFileSync(join(dir, '1', 'pid'), '999999999\n');
    expect(await withSlot(dir, 1, () => Promise.resolve('taken'))).toBe('taken');
  });
});
