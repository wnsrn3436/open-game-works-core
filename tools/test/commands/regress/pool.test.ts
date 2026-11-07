import { describe, expect, it } from 'vitest';
import { checkGate, every, regressPool } from '../../../src/commands/regress/lib/pool.ts';

/** A check that ends when `end` is called; `started` says whether it started. */
function held(): { started: boolean; end: () => void; work: () => Promise<string> } {
  let end = (): void => undefined;
  const check = {
    started: false,
    end: () => {
      end();
    },
    work: () =>
      new Promise<string>((resolve) => {
        check.started = true;
        end = () => {
          resolve('done');
        };
      }),
  };
  return check;
}

/** Lets the promises that can go on go on. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('the check gate of a regress command', () => {
  it('runs checks without performance together, and a check with performance alone, before the checks that came while it waited', async () => {
    const gate = checkGate();
    const [a, b, perf, c] = [held(), held(), held(), held()];
    const runs = [gate.run(false, a.work), gate.run(false, b.work)];
    await settle();
    expect([a.started, b.started]).toEqual([true, true]);
    runs.push(gate.run(true, perf.work));
    runs.push(gate.run(false, c.work));
    await settle();
    // the check with performance waits for the checks running, and the one that came after it waits for it
    expect([perf.started, c.started]).toEqual([false, false]);
    a.end();
    await settle();
    expect([perf.started, c.started]).toEqual([false, false]);
    b.end();
    await settle();
    expect([perf.started, c.started]).toEqual([true, false]);
    perf.end();
    await settle();
    expect(c.started).toBe(true);
    c.end();
    expect(await Promise.all(runs)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('runs two checks with performance one after the other, and goes on after a check that throws', async () => {
    const gate = checkGate();
    const [first, second] = [held(), held()];
    const failed = gate.run(true, () => Promise.reject(new Error('check failed')));
    const runs = [gate.run(true, first.work), gate.run(true, second.work)];
    await expect(failed).rejects.toThrow('check failed');
    await settle();
    expect([first.started, second.started]).toEqual([true, false]);
    first.end();
    await settle();
    expect(second.started).toBe(true);
    second.end();
    expect(await Promise.all(runs)).toEqual(['done', 'done']);
  });
});

describe('every', () => {
  it('throws the first failure only once every piece of work has ended', async () => {
    const slow = held();
    let ended = false;
    const all = every([Promise.reject(new Error('first')), slow.work().then((v) => ((ended = true), v)), Promise.reject(new Error('second'))]);
    const outcome = all.then(
      () => 'resolved',
      (error: unknown) => `${(error as Error).message} ${String(ended)}`,
    );
    await settle();
    slow.end();
    expect(await outcome).toBe('first true');
    expect(await every([Promise.resolve(1), Promise.resolve('a')])).toEqual([1, 'a']);
  });
});

describe('the pool of a regress command', () => {
  it('runs at most its limit of work at a time, in the order the work came', async () => {
    const pool = regressPool(2);
    const [a, b, c, d] = [held(), held(), held(), held()];
    const runs = [pool.work(a.work), pool.check(true, b.work), pool.work(c.work), pool.work(d.work)];
    await settle();
    // a check with performance takes a slot like any work: its measurement keeps the host quiet through the lease
    expect([a.started, b.started, c.started, d.started]).toEqual([true, true, false, false]);
    b.end();
    await settle();
    expect([c.started, d.started]).toEqual([true, false]);
    a.end();
    await settle();
    expect(d.started).toBe(true);
    c.end();
    d.end();
    expect(await Promise.all(runs)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('merges into one game one at a time, and into different games together, keeping no slot while a merge waits', async () => {
    const pool = regressPool(3);
    const [g1, g1b, g2, other] = [held(), held(), held(), held()];
    const runs = [pool.merge('g1', g1.work), pool.merge('g1', g1b.work), pool.merge('g2', g2.work), pool.work(other.work)];
    await settle();
    expect([g1.started, g1b.started, g2.started, other.started]).toEqual([true, false, true, true]);
    g1.end();
    await settle();
    expect(g1b.started).toBe(true);
    for (const h of [g1b, g2, other]) h.end();
    expect(await Promise.all(runs)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('with alone, runs a check with performance while no other check runs', async () => {
    const pool = regressPool(4, true);
    const [a, perf] = [held(), held()];
    const runs = [pool.check(false, a.work), pool.check(true, perf.work)];
    await settle();
    expect([a.started, perf.started]).toEqual([true, false]);
    a.end();
    await settle();
    expect(perf.started).toBe(true);
    perf.end();
    expect(await Promise.all(runs)).toEqual(['done', 'done']);
  });
});
