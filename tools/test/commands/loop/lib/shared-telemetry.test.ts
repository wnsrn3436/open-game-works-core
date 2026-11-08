import { describe, expect, it } from 'vitest';
import { pairRuns, sideRuns, withInputLatency, type BotRun, type RunSide } from '../../../../src/commands/loop/lib/shared-telemetry.ts';

const run = (latencies: (number | null)[]): BotRun =>
  ({
    telemetry: {
      started_at: 0,
      inputs: latencies.map((latency_ms, i) => ({ at: i * 100, latency_ms, feedback: [] })),
      rewards: [],
      marks: [],
      idle_spans: [],
      goal_intervals: [],
      scene_loads: [],
      dropped: 0,
    },
    guide: null,
  }) as unknown as BotRun;

describe('withInputLatency', () => {
  it('adds the held time to every measured input latency and keeps unanswered inputs', () => {
    const held = withInputLatency(run([16, null, 33]), 150);
    expect(held.telemetry.inputs.map((i) => i.latency_ms)).toEqual([166, null, 183]);
  });

  it('returns the run unchanged without latency', () => {
    const plain = run([16]);
    expect(withInputLatency(plain, 0)).toBe(plain);
  });
});

/**
 * A fake `runOnce`: each run waits `ms` and then reaches every step unless the next of `fails` is true. It records the
 * order the runs start and end in (`s<n>` and `e<n>`, n from 0 in start order).
 */
function fakeRuns(fails: boolean[], ms = 20): { runOnce: (k: number) => Promise<BotRun | null>; events: string[]; made: () => number; ks: number[] } {
  const events: string[] = [];
  const ks: number[] = [];
  let made = 0;
  return {
    runOnce: async (k) => {
      ks.push(k);
      const n = made++;
      const fail = fails.shift() ?? false;
      events.push(`s${String(n)}`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`e${String(n)}`);
      return fail ? null : run([16]);
    },
    events,
    made: () => made,
    ks,
  };
}

describe('sideRuns', () => {
  it('makes three runs at once, then the runs that did not reach every step again together', async () => {
    const runs = fakeRuns([true, false, true]);
    expect(await sideRuns(runs.runOnce)).toHaveLength(3);
    expect(runs.made()).toBe(5);
    // the first three together, then the two missing ones together, after the first three
    expect(runs.events).toEqual(['s0', 's1', 's2', 'e0', 'e1', 'e2', 's3', 's4', 'e3', 'e4']);
    // the k-th run has random base k, the new runs counted on
    expect(runs.ks).toEqual([1, 2, 3, 4, 5]);
  });

  it('stops once three runs that reached every step can no longer be made', async () => {
    // two missing after the first round, and both new runs fail: one new run is left for two missing runs
    const runs = fakeRuns([true, true, false, true, true]);
    expect(await sideRuns(runs.runOnce)).toBeNull();
    expect(runs.made()).toBe(5);
    // three missing after the first round: the three new runs are the last chance, and one of them fails
    const last = fakeRuns([true, true, true, true, false, false]);
    expect(await sideRuns(last.runOnce)).toBeNull();
    expect(last.made()).toBe(6);
    // a new run that fails does not end the runs while the others can still make up for it
    const later = fakeRuns([true, true, false, true, false]);
    expect(await sideRuns(later.runOnce)).toHaveLength(3);
    expect(later.made()).toBe(6);
  });

  it('stops the runs on a stop that between throws', async () => {
    const runs = fakeRuns([true]);
    await expect(
      sideRuns(runs.runOnce, () => {
        throw new Error('stopped');
      }),
    ).rejects.toThrow('stopped');
    expect(runs.made()).toBe(3);
  });
});

describe('pairRuns', () => {
  it('makes the runs of both commits at once', async () => {
    let running = 0;
    let most = 0;
    const sides: RunSide[] = [];
    const ks: Record<RunSide, number[]> = { commit: [], baseline: [] };
    const result = await pairRuns(async (side, k) => {
      sides.push(side);
      ks[side].push(k);
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return run([16]);
    });
    expect(result.commit).toHaveLength(3);
    expect(result.baseline).toHaveLength(3);
    expect(most).toBe(6);
    expect(sides.filter((s) => s === 'commit')).toHaveLength(3);
    // the two commits play the same worlds run for run
    expect(ks).toEqual({ commit: [1, 2, 3], baseline: [1, 2, 3] });
  });
});
