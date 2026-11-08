import { describe, expect, it } from 'vitest';
import { Slots } from '../../../../src/commands/check/lib/instances.ts';
import { shareUnits, UnitQueue } from '../../../../src/commands/check/lib/units.ts';

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('Slots.spare', () => {
  it('takes only a slot that is free, and tells its holder once when an acquire has to wait', async () => {
    const slots = new Slots(2);
    const told: string[] = [];
    const a = slots.spare(() => told.push('a'));
    expect(a).not.toBeNull();
    await slots.acquire();
    expect(slots.spare(() => told.push('b'))).toBeNull();
    let got = false;
    const waiting = slots.acquire().then(() => {
      got = true;
    });
    expect(told).toEqual(['a']);
    expect(slots.contended).toBe(true);
    a?.();
    a?.();
    await waiting;
    expect(got).toBe(true);
    expect(slots.contended).toBe(false);
    expect(slots.spare(() => undefined)).toBeNull();
  });
});

describe('shareUnits', () => {
  it('starts a helper on a slot that becomes free later, and the helpers end before helpers() does', async () => {
    const slots = new Slots(2);
    await slots.acquire();
    const queue = new UnitQueue(6);
    const ran: [string, number][] = [];
    const shared = shareUnits(slots, queue, async (next) => {
      for (let i = next(); i !== null; i = next()) {
        ran.push(['helper', i]);
        await sleep(5);
      }
    }, () => undefined);
    const first = (async (): Promise<void> => {
      for (let i = shared.claim(); i !== null; i = shared.claim()) {
        ran.push(['first', i]);
        await sleep(5);
      }
    })();
    // the first runner claimed unit 0; the one slot left went to a helper at once
    await turn();
    expect(ran.map(([who]) => who).sort()).toEqual(['first', 'helper']);
    await first;
    await shared.helpers();
    expect(ran.map(([, i]) => i).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    // every spare slot is back: both are free again after the other holder releases its own
    slots.release();
    expect(slots.spare(() => undefined)).not.toBeNull();
    expect(slots.spare(() => undefined)).not.toBeNull();
  });

  it('starts helpers when a held slot is freed while units are left', async () => {
    const slots = new Slots(1);
    const queue = new UnitQueue(4);
    const helpers: number[] = [];
    // the first runner holds no slot of its own here: the one slot is held by other work until it is freed
    await slots.acquire();
    const shared = shareUnits(slots, queue, async (next) => {
      for (let i = next(); i !== null; i = next()) {
        helpers.push(i);
        await sleep(5);
      }
    }, () => undefined);
    const first = (async (): Promise<void> => {
      for (let i = shared.claim(); i !== null; i = shared.claim()) await sleep(20);
    })();
    await turn();
    expect(helpers).toEqual([]);
    slots.release();
    await first;
    await shared.helpers();
    expect(helpers.length).toBeGreaterThan(0);
  });

  it('starts no helper after one failed, and the units stay for the runner of the caller', async () => {
    const slots = new Slots(4);
    const queue = new UnitQueue(5);
    const failures: string[] = [];
    let starts = 0;
    const shared = shareUnits(slots, queue, () => {
      starts++;
      return Promise.reject(new Error('no instance'));
    }, (error) => failures.push((error as Error).message));
    const mine: number[] = [];
    for (let i = shared.claim(); i !== null; i = shared.claim()) {
      mine.push(i);
      await sleep(2);
    }
    await shared.helpers();
    expect(mine).toEqual([0, 1, 2, 3, 4]);
    // the first claim started four helpers at once (four units left, four free slots); none started after they failed
    expect(starts).toBe(4);
    expect(failures).toEqual(['no instance', 'no instance', 'no instance', 'no instance']);
  });

  it('a helper gives its slot back after the unit it runs once other work of the check waits for a slot', async () => {
    const slots = new Slots(2);
    // the slot of the runner of the caller
    await slots.acquire();
    const queue = new UnitQueue(4);
    const ran: number[] = [];
    const ends: (() => void)[] = [];
    const shared = shareUnits(slots, queue, async (next) => {
      for (let i = next(); i !== null; i = next()) {
        ran.push(i);
        await new Promise<void>((resolve) => ends.push(resolve));
      }
    }, () => undefined);
    expect(shared.claim()).toBe(0);
    await turn();
    // the helper on the free slot runs unit 1
    expect(ran).toEqual([1]);
    let got = false;
    const other = slots.acquire().then(() => {
      got = true;
    });
    await turn();
    expect(got).toBe(false);
    ends.shift()?.();
    await turn();
    await turn();
    // it claimed no unit after the one it ran, and the waiting work got the slot
    expect(ran).toEqual([1]);
    expect(got).toBe(true);
    await other;
    await shared.helpers();
    expect([shared.claim(), shared.claim(), shared.claim()]).toEqual([2, 3, null]);
  });

  it('a helper that is still starting stops once other work of the check waits for a slot', async () => {
    const slots = new Slots(2);
    await slots.acquire();
    const queue = new UnitQueue(3);
    const signals: AbortSignal[] = [];
    const shared = shareUnits(slots, queue, (_next, signal) => {
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('stopped'));
        });
      });
    }, () => {
      throw new Error('a stopped helper is no failure');
    });
    expect(shared.claim()).toBe(0);
    expect(signals).toHaveLength(1);
    const other = slots.acquire();
    expect(signals[0]?.aborted).toBe(true);
    // the stopped helper gave its slot back to the waiting work
    await other;
    await shared.helpers();
    expect([shared.claim(), shared.claim(), shared.claim()]).toEqual([1, 2, null]);
  });

  it('stopAfter stops the helpers that are getting ready, and no unit after it is claimed', async () => {
    const slots = new Slots(2);
    const queue = new UnitQueue(5);
    const signals: AbortSignal[] = [];
    const shared = shareUnits(slots, queue, (_next, signal) => {
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('stopped'));
        });
      });
    }, () => {
      throw new Error('a stopped helper is no failure');
    });
    expect(shared.claim()).toBe(0);
    expect(signals).toHaveLength(2);
    shared.stopAfter(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(shared.claim()).toBeNull();
    await shared.helpers();
  });
});
