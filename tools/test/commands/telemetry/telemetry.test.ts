import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { summaryLines, telemetrySummary } from '../../../src/commands/telemetry/api.ts';
import { compareRepeatedTelemetry, compareTelemetry, distance, failureIsNone, formatComparison, freeScenes } from '../../../src/commands/telemetry/lib/compare.ts';
import { isMetric, median, metricValue, toTelemetry, windowTelemetry, type Telemetry } from '../../../src/commands/telemetry/lib/metrics.ts';
import { createContext } from '../../../src/lib/command.ts';
import { ogw } from '../../helpers/workspace.ts';
import { setupRunner, startFor, stopAll, type Runner } from '../instance/runner.ts';

vi.mock('../../../src/commands/generate/api.ts', async () => (await import('../instance/mocks/apis.ts')).generate);
vi.mock('../../../src/commands/data/api.ts', async () => (await import('../instance/mocks/apis.ts')).data);
vi.mock('../../../src/commands/core/api.ts', async () => (await import('../instance/mocks/apis.ts')).core);
vi.mock('../../../src/commands/env/api.ts', async () => (await import('../instance/mocks/apis.ts')).env);
vi.mock('../../../src/commands/instance/lib/spawn.ts', () => import('../instance/mocks/spawn.ts'));
vi.mock('../../../src/commands/instance/lib/launch.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/commands/instance/lib/launch.ts')>();
  return { ...real, ...(await import('../instance/mocks/apis.ts')).launchOverrides(real) };
});

function telemetry(patch: Partial<Telemetry> = {}): Telemetry {
  return { started_at: 1000, inputs: [], rewards: [], marks: [], idle_spans: [], goal_intervals: [], scene_loads: [], dropped: 0, ...patch };
}

const input = (at: number, latency: number | null, feedback: Record<string, number> = {}) => ({ at, command: 'tap', latency_ms: latency, feedback });

describe('metrics', () => {
  it('takes the lower middle median', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([4, 1, 3, 2])).toBe(2);
    expect(median([3, 1, 2])).toBe(2);
  });

  it('computes every metric of the game-design table', () => {
    const a = telemetry({
      inputs: [input(1100, 50, { Sound: 1, Tween: 2 }), input(1200, null), input(1300, 30, { Sound: 1 }), input(1400, 70)],
      rewards: [
        { at: 1500, play_at: 500, kind: 'Item', id: 1, amount: 1 },
        { at: 1900, play_at: 900, kind: 'Item', id: 1, amount: 1 },
        { at: 2500, play_at: 1500, kind: 'Mark', id: 2, amount: 1 },
      ],
      marks: [
        { at: 1600, play_at: 600, kind: 'Fail' },
        { at: 1700, play_at: 700, kind: 'Goal' },
        { at: 1900, play_at: 900, kind: 'Restart' },
        { at: 2000, play_at: 1000, kind: 'Fail' },
        { at: 2100, play_at: 1100, kind: 'Restart' },
        { at: 2200, play_at: 1200, kind: 'Fail' },
      ],
      idle_spans: [
        { start_at: 1000, end_at: 1100, duration_ms: 100 },
        { start_at: 1400, end_at: 2200, duration_ms: 800 },
        { start_at: 3000, end_at: null },
      ],
      goal_intervals: [
        { start_at: 1000, end_at: 1700, duration_ms: 700, input_count: 3 },
        { start_at: 1700, end_at: 2700, duration_ms: 1000, input_count: 9 },
      ],
      scene_loads: [
        { at: 1000, scene_key: 'scene/a', duration_ms: 300 },
        { at: 1050, scene_key: 'scene/b', duration_ms: 900 },
      ],
    });
    const b = telemetry({ started_at: 0, rewards: [{ at: 100, play_at: 100, kind: 'Item', id: 1, amount: 1 }], marks: [] });
    const s = [{ telemetry: a, state: { content: { gold: 10, name: 'x' } } }, { telemetry: b, state: { content: { gold: 30 } } }];
    expect(metricValue('input_latency_ms', s)).toBe(50);
    expect(metricValue('no_response_permille', s)).toBe(250);
    expect(metricValue('feedback_per_input', s)).toBe(0);
    expect(metricValue('feedback_per_input', [{ telemetry: telemetry({ inputs: [input(1, 1, { Sound: 1, Tween: 2 }), input(2, 1, { Sound: 1 }), input(3, 1)] }), state: {} }])).toBe(1);
    // the kinds of feedback, not how many events: more sounds per input is not more feel; at most the 5 kinds
    expect(metricValue('feedback_per_input', [{ telemetry: telemetry({ inputs: [input(1, 1, { Sound: 3 }), input(2, 1, { Sound: 7, Tween: 0 })] }), state: {} }])).toBe(1);
    const all = { Sound: 1, CameraShake: 1, ScreenEffect: 1, Tween: 1, Effect: 1, Other: 1 };
    expect(metricValue('feedback_per_input', [{ telemetry: telemetry({ inputs: [input(1, 1, all)] }), state: {} }])).toBe(5);
    expect(metricValue('first_reward_ms', s)).toBe(100);
    expect(metricValue('reward_interval_ms', s)).toBe(400);
    expect(metricValue('goal_interval_ms', s)).toBe(700);
    expect(metricValue('goal_input_count', s)).toBe(3);
    expect(metricValue('fail_count', s)).toBe(0);
    expect(metricValue('fail_count', [s[0] as never])).toBe(3);
    // no input between a Fail mark and its Restart mark: nothing restarted it
    expect(metricValue('restart_delay_ms', s)).toBeNull();
    // the played time (play_at, duration_ms), not the device time, which also runs while a step scene waits
    const stepped = telemetry({
      started_at: 1000,
      inputs: [input(2000, 1), input(7000, 1), input(8500, 1)],
      marks: [{ at: 2000, play_at: 500, kind: 'Fail' }, { at: 9000, play_at: 1500, kind: 'Restart' }],
      rewards: [{ at: 5000, play_at: 800, kind: 'Item', id: 1, amount: 1 }, { at: 12000, play_at: 2800, kind: 'Item', id: 1, amount: 1 }],
    });
    // restart delay: from the input that restarted (the last one after the Fail mark) to the Restart mark
    expect(metricValue('restart_delay_ms', [{ telemetry: stepped, state: {} }])).toBe(500);
    expect(metricValue('first_reward_ms', [{ telemetry: stepped, state: {} }])).toBe(800);
    expect(metricValue('reward_interval_ms', [{ telemetry: stepped, state: {} }])).toBe(2000);
    const spans = telemetry({
      inputs: [input(1000, 1)],
      idle_spans: [{ start_at: 2000, end_at: 12000, duration_ms: 3000 }],
      goal_intervals: [{ start_at: 0, end_at: 20000, duration_ms: 4000, input_count: 2 }],
    });
    expect(metricValue('idle_span_ms', [{ telemetry: spans, state: {} }])).toBe(3000);
    expect(metricValue('goal_interval_ms', [{ telemetry: spans, state: {} }])).toBe(4000);
    expect(metricValue('idle_span_ms', s)).toBe(800);
    expect(metricValue('scene_load_ms', s)).toBe(900);
    expect(metricValue('content.gold', s)).toBe(10);
    expect(metricValue('content.name', s)).toBeNull();
    const empty = [{ telemetry: telemetry(), state: {} }];
    for (const m of ['input_latency_ms', 'no_response_permille', 'first_reward_ms', 'scene_load_ms', 'restart_delay_ms', 'content.x']) {
      expect(metricValue(m, empty)).toBeNull();
    }
    expect(metricValue('idle_span_ms', empty)).toBe(0);
    // without play_at or duration_ms there is no played time: the five metrics are unknown, not device time
    const unplayed = [{
      telemetry: telemetry({
        inputs: [input(1000, 1)],
        marks: [{ at: 2000, kind: 'Fail' }, { at: 9000, kind: 'Restart' }],
        rewards: [{ at: 5000, kind: 'Item', id: 1, amount: 1 }, { at: 12000, kind: 'Item', id: 1, amount: 1 }],
        idle_spans: [{ start_at: 2000, end_at: 12000 }],
        goal_intervals: [{ start_at: 0, end_at: 20000, input_count: 2 }],
      }),
      state: {},
    }];
    for (const m of ['first_reward_ms', 'reward_interval_ms', 'goal_interval_ms', 'idle_span_ms']) {
      expect(metricValue(m, unplayed)).toBeNull();
    }
    expect(metricValue('idle_span_ms', [{ telemetry: telemetry({ idle_spans: [{ start_at: 0, end_at: null }] }), state: {} }])).toBe(0);
    // spans before the first input are the wait before play, and an instance without input has none of its own
    expect(metricValue('idle_span_ms', [{ telemetry: telemetry({ idle_spans: [{ start_at: 0, end_at: 900, duration_ms: 900 }] }), state: {} }])).toBe(0);
    expect(() => metricValue('fun', s)).toThrow('unknown metric: fun');
    expect(isMetric('content.hp')).toBe(true);
    expect(isMetric('content.')).toBe(false);
    expect(isMetric('goal_interval_ms')).toBe(true);
  });

  it('leaves out the time of free scenes when the play guide has another mode', () => {
    // title (free) from 1000, play (step) from 4000; the agent read the title screen for 3000 ms
    const t = telemetry({
      started_at: 1000,
      inputs: [input(1500, 1), input(4100, 1)],
      rewards: [{ at: 6000, play_at: 3500, kind: 'Item', id: 1, amount: 1 }],
      idle_spans: [{ start_at: 2000, end_at: 2400, duration_ms: 400 }, { start_at: 5000, end_at: 5700, duration_ms: 700 }],
      goal_intervals: [{ start_at: 1000, end_at: 7000, duration_ms: 4000, input_count: 2 }],
      scene_loads: [{ at: 1000, scene_key: 'scene/title/title', duration_ms: 10 }, { at: 4000, scene_key: 'scene/play/play', duration_ms: 10 }],
    });
    const sample = [{ telemetry: t, state: {} }];
    const free = new Set(['scene/title/title']);
    expect([metricValue('first_reward_ms', sample, free), metricValue('first_reward_ms', sample)]).toEqual([500, 3500]);
    expect([metricValue('goal_interval_ms', sample, free), metricValue('goal_interval_ms', sample)]).toEqual([1000, 4000]);
    expect([metricValue('idle_span_ms', sample, free), metricValue('idle_span_ms', sample)]).toEqual([700, 400]);
    // a window keeps the scene loaded before it: a span at its start is still in that scene
    expect(metricValue('idle_span_ms', [{ telemetry: windowTelemetry(t, 900, 1500), state: {} }], free)).toBe(0);
    expect(metricValue('idle_span_ms', [{ telemetry: windowTelemetry(t, 3900, 5000), state: {} }], free)).toBe(700);
    expect(metricValue('first_reward_ms', [{ telemetry: windowTelemetry(t, 3900, 5500), state: {} }], free)).toBe(500);
  });

  it('reads the free scenes of ## play mode', () => {
    const guide = (rows: string[]) => ['## failure', 'none', '', '## play mode', '', '| scene | mode | step ms |', '|---|---|---|', ...rows, '', '- note'].join('\n');
    expect(freeScenes(guide(['| `scene/title/title` | `free` | |', '| `scene/play/play` | `step` | 50 |', '| scene/lobby | free | |']))).toEqual(
      new Set(['scene/title/title', 'scene/lobby']),
    );
    // every scene free: nothing is left out
    expect(freeScenes(guide(['| `scene/title/title` | `free` | |', '| `scene/battle/battle` | `free` | |']))).toBeNull();
    expect(freeScenes('## play mode\nnone\n')).toBeNull();
    expect(freeScenes('## goal\nx\n')).toBeNull();
  });

  it('reads telemetry loosely and cuts a window', () => {
    expect(toTelemetry({ started_at: 5 })).toEqual(telemetry({ started_at: 5 }));
    expect(() => toTelemetry(null)).toThrow('telemetry is not a JSON object');
    expect(() => toTelemetry({})).toThrow('telemetry has no started_at');
    const t = telemetry({
      inputs: [input(1099, 1), input(1100, 2), input(1199, 3), input(1200, 4)],
      marks: [{ at: 1150, kind: 'Fail' }],
      rewards: [{ at: 1300, kind: 'Item', id: 1, amount: 1 }],
      idle_spans: [{ start_at: 1100, end_at: 1500, duration_ms: 400 }],
      goal_intervals: [{ start_at: 1000, end_at: 1150, input_count: 1 }],
      scene_loads: [{ at: 1100, scene_key: 'a', duration_ms: 1 }],
    });
    const w = windowTelemetry(t, 100, 200);
    expect(w.inputs.map((i) => i.latency_ms)).toEqual([2, 3]);
    expect(w.marks).toHaveLength(1);
    expect(w.rewards).toHaveLength(0);
    expect(w.idle_spans).toHaveLength(1);
    expect(w.goal_intervals).toHaveLength(0);
    expect(w.scene_loads).toHaveLength(1);
  });
});

describe('compare', () => {
  it('measures d and picks winner and margin per element', () => {
    expect(distance(0, 0)).toBe(0);
    expect(distance(100, 80)).toBeCloseTo(0.2);
    expect(distance(-10, 10)).toBe(2);
    const fast = telemetry({ inputs: [input(1100, 100, { Sound: 1 })], rewards: [{ at: 1, play_at: 1, kind: 'Item', id: 1, amount: 1 }, { at: 101, play_at: 101, kind: 'Item', id: 1, amount: 1 }] });
    const slow = telemetry({ inputs: [input(1100, 103, { Sound: 2, Tween: 1 })], rewards: [{ at: 1, play_at: 1, kind: 'Item', id: 1, amount: 1 }, { at: 161, play_at: 161, kind: 'Item', id: 1, amount: 1 }] });
    const result = compareTelemetry(fast, slow, false);
    expect(result.map((e) => [e.element, e.winner, e.margin])).toEqual([
      ['game feel', 'B', 'decisive'],
      ['tension and release', 'no telemetry', ''],
      ['progression', 'A', 'decisive'],
      ['one more run', 'no telemetry', ''],
      ['no friction', 'indistinguishable', ''],
      ['presentation', 'no telemetry', ''],
    ]);
    expect(result[0]?.metrics).toEqual([
      // a latency difference of one frame (17 ms) or less is no difference
      { metric: 'input_latency_ms', a: 100, b: 103, d: 0 },
      { metric: 'feedback_per_input', a: 1, b: 2, d: 0.5 },
    ]);
    const near = compareTelemetry(telemetry({ inputs: [input(1, 100)] }), telemetry({ inputs: [input(1, 104)] }), true);
    expect(near.map((e) => e.winner)).toEqual(['indistinguishable', 'n/a', 'no telemetry', 'n/a', 'indistinguishable', 'no telemetry']);
    const frame = [117, 118].map((b) => compareTelemetry(telemetry({ inputs: [input(1, 100)] }), telemetry({ inputs: [input(1, b)] }), false)[0]);
    expect(frame.map((e) => [e?.metrics[0]?.d, e?.winner, e?.margin])).toEqual([[0, 'indistinguishable', ''], [18 / 118, 'A', 'clear']]);
    const margins = [220, 260, 400].map((b) => compareTelemetry(telemetry({ inputs: [input(1, 200)] }), telemetry({ inputs: [input(1, b)] }), false)[0]);
    expect(margins.map((e) => [e?.winner, e?.margin])).toEqual([
      ['A', 'slight'],
      ['A', 'clear'],
      ['A', 'decisive'],
    ]);
    // d exactly on a bound takes the upper side: 0.05 is not indistinguishable, 0.15 is clear, 0.30 is decisive
    const bounds = [950, 850, 700].map((b) => compareTelemetry(telemetry({ inputs: [input(1, 1000)] }), telemetry({ inputs: [input(1, b)] }), false)[0]);
    expect(bounds.map((e) => [e?.metrics[0]?.d, e?.winner, e?.margin])).toEqual([
      [0.05, 'B', 'slight'],
      [0.15, 'B', 'clear'],
      [0.3, 'B', 'decisive'],
    ]);
    expect(formatComparison(near.slice(0, 2))).toBe(
      'game feel: winner indistinguishable\n  input_latency_ms: A 100, B 104, d 0\n  feedback_per_input: A 0, B 0, d 0\ntension and release: winner n/a',
    );
    expect(formatComparison([{ element: 'x', metrics: [{ metric: 'm', a: null, b: 2, d: null }], winner: 'A', margin: 'clear' }])).toBe(
      'x: winner A, margin clear\n  m: A none, B 2, d none',
    );
  });

  it('lets the instance with no idle span win no friction', () => {
    const goal = (n: number) => ({ start_at: 0, end_at: 1, input_count: n });
    const a = telemetry({ goal_intervals: [goal(12)] });
    const b = telemetry({ inputs: [input(0, 10)], idle_spans: [{ start_at: 0, end_at: 5000, duration_ms: 5000 }, { start_at: 9000, end_at: 15000, duration_ms: 6000 }], goal_intervals: [goal(8)] });
    const noFriction = compareTelemetry(a, b, false)[4];
    expect(noFriction?.metrics[0]).toEqual({ metric: 'idle_span_ms', a: 0, b: 5000, d: 1 });
    expect([noFriction?.winner, noFriction?.margin]).toEqual(['A', 'decisive']);
  });

  it('leaves out of no friction the wait before the judge played the second instance', () => {
    const goal = { start_at: 0, end_at: 1, input_count: 5 };
    // A is played first; B waits 300000 ms untouched, then is played the same way
    const a = telemetry({ started_at: 0, inputs: [input(10, 5)], idle_spans: [{ start_at: 2000, end_at: 3000, duration_ms: 1000 }, { start_at: 301000, end_at: null }], goal_intervals: [goal] });
    const b = telemetry({ started_at: 0, inputs: [input(300000, 5)], idle_spans: [{ start_at: 1000, end_at: 300000, duration_ms: 299000 }, { start_at: 302000, end_at: null }], goal_intervals: [goal] });
    const noFriction = compareTelemetry(a, b, false)[4];
    expect(noFriction?.metrics[0]).toEqual({ metric: 'idle_span_ms', a: 1000, b: 0, d: 1 });
    expect([noFriction?.winner, noFriction?.margin]).toEqual(['B', 'decisive']);
  });

  it('keeps in no friction an idle span of a window that starts after the first input', () => {
    const goal = { start_at: 0, end_at: 1, input_count: 5 };
    // in A's window a scene loads at 60500 and the game takes no input until 70500
    const a = telemetry({
      started_at: 0,
      inputs: [input(100, 5), input(59000, 5), input(70500, 5)],
      idle_spans: [{ start_at: 60500, end_at: 70500, duration_ms: 10000 }],
      goal_intervals: [goal],
    });
    const b = telemetry({ started_at: 0, inputs: [input(100, 5), input(59000, 5), input(61000, 5), input(61500, 5)], goal_intervals: [goal] });
    const whole = compareTelemetry(a, b, false)[4];
    const windowed = compareTelemetry(windowTelemetry(a, 60000, 90000), windowTelemetry(b, 60000, 90000), false)[4];
    for (const noFriction of [whole, windowed]) {
      expect(noFriction?.metrics[0]).toEqual({ metric: 'idle_span_ms', a: 10000, b: 0, d: 1 });
      expect([noFriction?.winner, noFriction?.margin]).toEqual(['B', 'decisive']);
    }
    // a window of an instance with no input at all still has no idle span of its own
    expect(metricValue('idle_span_ms', [{ telemetry: windowTelemetry(telemetry({ started_at: 0, idle_spans: [{ start_at: 61000, end_at: 70000, duration_ms: 9000 }] }), 60000, 90000), state: {} }])).toBe(0);
  });

  it('leaves out of no friction the idle spans of each game\'s free scenes', () => {
    const goal = { start_at: 0, end_at: 1, input_count: 5 };
    const loads = [{ at: 0, scene_key: 'lobby', duration_ms: 1 }, { at: 10000, scene_key: 'play', duration_ms: 1 }];
    // A's agent waited 8000 ms in the lobby; B waited in play
    const a = telemetry({ started_at: 0, inputs: [input(100, 5)], idle_spans: [{ start_at: 1000, end_at: 9000, duration_ms: 8000 }], goal_intervals: [goal], scene_loads: loads });
    const b = telemetry({ started_at: 0, inputs: [input(100, 5)], idle_spans: [{ start_at: 11000, end_at: 19000, duration_ms: 8000 }], goal_intervals: [goal], scene_loads: loads });
    const free = new Set(['lobby']);
    const noFriction = compareTelemetry(a, b, false, free, free)[4];
    expect(noFriction?.metrics[0]).toEqual({ metric: 'idle_span_ms', a: 0, b: 8000, d: 1 });
    expect(compareTelemetry(a, b, false)[4]?.winner).toBe('indistinguishable');
  });

  it('reads ## failure of a play guide', () => {
    expect(failureIsNone('# g\n## failure\n\nnone\n\n## input lock window\nx')).toBe(true);
    expect(failureIsNone('## failure\nfall into a pit\n')).toBe(false);
    expect(failureIsNone('## goal\nnone\n')).toBe(false);
    expect(failureIsNone('## failure\nnone')).toBe(true);
    expect(failureIsNone('## failure\nnone\n### part\nmore')).toBe(false);
    expect(failureIsNone('## failure\nnone\n# part\nmore')).toBe(true);
    expect(failureIsNone('## failure\n\n')).toBe(false);
  });
});

describe('ogw telemetry', () => {
  let runner: Runner;
  let a: string;
  let b: string;

  beforeAll(async () => {
    runner = setupRunner();
    a = await startFor(runner);
    b = await startFor(runner, ['--platform', 'ios']);
  });

  afterAll(async () => {
    await stopAll(runner);
  });

  it('prints the telemetry and its summary', async () => {
    const started = Date.now() - 60_000;
    const t = telemetry({
      started_at: started,
      marks: [{ at: started + 1, kind: 'Fail' }, { at: started + 2, kind: 'Restart' }, { at: started + 3, kind: 'Fail' }],
      scene_loads: [{ at: started, scene_key: 'scene/title', duration_ms: 1 }, { at: started + 5, scene_key: 'scene/battle', duration_ms: 1 }],
    });
    runner.config({ telemetry: t });
    const json = await ogw(runner.ws, ['telemetry', a]);
    expect(JSON.parse(json.stdout)).toEqual(t);
    const run = await ogw(runner.ws, ['telemetry', a, '--summary']);
    const lines = run.stdout.trim().split('\n');
    expect(Number(lines[0]?.replace('- device ms: ', ''))).toBeGreaterThanOrEqual(60_000);
    expect(lines.slice(1)).toEqual(['- scenes: scene/title, scene/battle', '- fail: 2', '- restart: 1']);
    const ctx = createContext({ cwd: runner.ws.root, env: runner.ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    expect((await telemetrySummary(ctx, a)).slice(1)).toEqual(lines.slice(1));
    expect(summaryLines(t, started + 7)[0]).toBe('- device ms: 7');
  });

  it('fails when get_telemetry fails', async () => {
    runner.config({ clients: { main: { fail: { get_telemetry: 'no' } } } });
    const run = await ogw(runner.ws, ['telemetry', a]);
    expect(run.stderr).toContain('get_telemetry failed: "no"');
    runner.config({});
  });

  it('compares two instances, each in its own window, with play guides', async () => {
    const base = Date.now();
    runner.config({
      telemetryByInstance: {
        [a]: telemetry({ started_at: base, inputs: [input(base + 50, 10), input(base + 500, 300), input(base + 600, 300)] }),
        [b]: telemetry({ started_at: base + 1000, inputs: [input(base + 1050, 200), input(base + 1450, 40)] }),
      },
    });
    const guide = join(runner.ws.root, 'guide.md');
    writeFileSync(guide, '## failure\nnone\n');
    const all = await ogw(runner.ws, ['telemetry', 'compare', a, b, '--json']);
    const elements = (JSON.parse(all.stdout) as { elements: { element: string; winner: string }[] }).elements;
    expect(elements[0]).toMatchObject({ element: 'game feel', winner: 'B' });
    const windows = ['--from-a', '0', '--to-a', '100', '--from-b', '400', '--to-b', '500'];
    const windowed = await ogw(runner.ws, ['telemetry', 'compare', a, b, ...windows, '--guide-b', guide]);
    expect(windowed.stdout).toContain('game feel: winner A, margin decisive\n  input_latency_ms: A 10, B 40, d 0.75');
    expect(windowed.stdout).toContain('tension and release: winner n/a');
    expect(windowed.stdout).toContain('one more run: winner n/a');
    // either guide with ## failure none makes the two elements n/a; guides with a failure do not
    const failing = join(runner.ws.root, 'failing.md');
    writeFileSync(failing, '## failure\nfall into a pit\n');
    const guideA = (await ogw(runner.ws, ['telemetry', 'compare', a, b, '--guide-a', guide, '--guide-b', failing])).stdout;
    expect(guideA).toContain('tension and release: winner n/a');
    expect(guideA).toContain('one more run: winner n/a');
    const both = (await ogw(runner.ws, ['telemetry', 'compare', a, b, '--guide-a', failing, '--guide-b', failing])).stdout;
    expect(both).toContain('tension and release: winner no telemetry');
    expect(both).toContain('one more run: winner no telemetry');
    const fail = async (args: string[]) => (await ogw(runner.ws, ['telemetry', 'compare', a, b, ...args])).stderr;
    expect(await fail(['--from-a', '5'])).toContain('--from-a and --to-a go together');
    expect(await fail(['--to-b', '5'])).toContain('--from-b and --to-b go together');
    expect(await fail(['--from-a', '0', '--to-a', '5'])).toContain('the windows of A and B go together');
    expect(await fail(['--from-a', 'x', '--to-a', '1', '--from-b', '0', '--to-b', '1'])).toContain('invalid --from-a: x');
  });
});

describe('compareRepeatedTelemetry', () => {
  const goals = (counts: number[]) => ({ started_at: 0, inputs: [], rewards: [], marks: [], idle_spans: [], goal_intervals: counts.map((input_count, i) => ({ start_ms: i * 1000, end_ms: i * 1000 + 500, input_count })), scene_loads: [], dropped: 0 }) as never;

  it('counts no difference when the runs of the two sides overlap', () => {
    const noFriction = compareRepeatedTelemetry([goals([20]), goals([13])], [goals([14]), goals([16])], false)[4];
    expect(noFriction?.winner).toBe('indistinguishable');
    expect(noFriction?.metrics.find((m) => m.metric === 'goal_input_count')).toMatchObject({ a: 16.5, b: 15, d: 0, runs: { a: [20, 13], b: [14, 16] } });
  });

  it('counts no difference when the gap between the runs is not larger than the spread of a side', () => {
    // same commit in a real calibration: feedback 1 1 1 against 2 2 3
    const noFriction = compareRepeatedTelemetry([goals([1]), goals([1]), goals([1])], [goals([2]), goals([2]), goals([3])], false)[4];
    expect(noFriction?.winner).toBe('indistinguishable');
    expect(noFriction?.metrics.find((m) => m.metric === 'goal_input_count')?.d).toBe(0);
  });

  it('counts the difference of the means when the runs are apart', () => {
    const noFriction = compareRepeatedTelemetry([goals([10]), goals([11])], [goals([20]), goals([22])], false)[4];
    expect(noFriction?.winner).toBe('A');
    expect(formatComparison([noFriction as never])).toContain('(runs A 10 11, B 20 22)');
  });
});
