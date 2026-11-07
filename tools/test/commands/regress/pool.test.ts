import { describe, expect, it } from 'vitest';
import { checkGate } from '../../../src/commands/regress/lib/pool.ts';

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
