import { describe, expect, it } from 'vitest';
import { withInputLatency, type BotRun } from '../../../../src/commands/loop/lib/shared-telemetry.ts';

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
