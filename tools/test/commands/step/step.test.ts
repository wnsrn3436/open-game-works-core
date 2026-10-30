import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newMarks } from '../../../src/commands/step/step.ts';
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

let runner: Runner;
let id: string;
/** `started_at` of the fake client's telemetry: `device ms` is the ms since then. */
const startedAt = Date.now() - 60_000;
const telemetry = { started_at: startedAt, inputs: [], rewards: [], marks: [], idle_spans: [], goal_intervals: [], scene_loads: [], dropped: 0 };
/** stdout with each `device ms <n>` of a step line written as `device ms <d>`. */
const plain = (stdout: string): string => stdout.replace(/: device ms [0-9]+/g, ': device ms <d>');
const stepCount = (): number => runner.requests('main').filter((r) => r.command === 'step').length;

/** Runs `ogw step` with the given step effects of the fake client, and returns the run and the number of steps sent. */
async function stepWith(effects: unknown[], args: string[]): Promise<{ code: number; stdout: string; stderr: string; steps: number }> {
  runner.config({ clients: { main: { stepEffects: effects } }, telemetry, seq: Math.random() });
  const before = stepCount();
  const run = await ogw(runner.ws, ['step', id, ...args]);
  return { ...run, steps: stepCount() - before };
}

beforeAll(async () => {
  runner = setupRunner();
  id = await startFor(runner);
  expect((await ogw(runner.ws, ['step-mode', id, 'on'])).code).toBe(0);
});

afterAll(async () => {
  await stopAll(runner);
});

describe('ogw step --count --capture', () => {
  it('advances one step by default and reads telemetry once before and once after it', async () => {
    const reads = (): number => runner.requests('main').filter((r) => r.command === 'get_telemetry').length;
    const before = reads();
    const run = await stepWith([], ['100']);
    expect(run).toMatchObject({ code: 0, steps: 1 });
    expect(plain(run.stdout)).toBe('step 1/1: advanced 100 ms: main: device ms <d>\n');
    expect(reads() - before).toBe(2);
  });

  it('advances n steps of ms each with one telemetry read per step', async () => {
    const reads = (): number => runner.requests('main').filter((r) => r.command === 'get_telemetry').length;
    const before = reads();
    const run = await stepWith([], ['100', '--count', '3']);
    expect(run).toMatchObject({ code: 0, steps: 3 });
    expect(plain(run.stdout)).toBe(
      'step 1/3: advanced 100 ms: main: device ms <d>\nstep 2/3: advanced 200 ms: main: device ms <d>\nstep 3/3: advanced 300 ms: main: device ms <d>\n',
    );
    expect(reads() - before).toBe(4);
    expect(runner.requests('main').filter((r) => r.command === 'step').slice(-3).map((r) => r.args)).toEqual([['100'], ['100'], ['100']]);
  });

  it('captures the screen after each step into captures/', async () => {
    const sent = runner.requests('main').length;
    const run = await stepWith([], ['50', '--count', '3', '--capture', '--json']);
    expect(run.code).toBe(0);
    const data = JSON.parse(run.stdout) as { steps: { index: number; advancedMs: number; clients: string[]; capture: string }[] };
    expect(data.steps.map((s) => [s.index, s.advancedMs, s.clients])).toEqual([
      [1, 50, ['main']],
      [2, 100, ['main']],
      [3, 150, ['main']],
    ]);
    const paths = data.steps.map((s) => s.capture);
    expect(new Set(paths).size).toBe(3);
    for (const path of paths) {
      expect(path).toMatch(new RegExp(`^${join(runner.root, 'captures', id)}-[0-9]+\\.jpg$`));
      expect(readFileSync(path).subarray(2).toString()).toBe('JPG-main');
    }
    // each capture comes after the step of its index and before the next step
    const order = runner
      .requests('main')
      .slice(sent)
      .map((r) => r.command)
      .filter((c) => c === 'step' || c === 'capture_screen');
    expect(order).toEqual(['step', 'capture_screen', 'step', 'capture_screen', 'step', 'capture_screen']);
  });

  it('prints with --state the content state of main after every step, the last included', async () => {
    const run = await stepWith([{ state: { content: { stack: { x: 10 } } } }, { state: { content: { stack: { x: 20 } } } }], ['50', '--count', '2', '--state']);
    expect(run).toMatchObject({ code: 0, steps: 2 });
    expect(plain(run.stdout)).toBe(
      'step 1/2: advanced 50 ms: main: device ms <d>: content {"stack":{"x":10}}\nstep 2/2: advanced 100 ms: main: device ms <d>: content {"stack":{"x":20}}\n',
    );
  });

  it('captures a .png from a core that does not take the format', async () => {
    runner.config({ clients: { main: { pngOnly: true } }, telemetry, seq: Math.random() });
    const run = await ogw(runner.ws, ['step', id, '50', '--capture']);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toMatch(/\.png$/);
  });

  it('stops when the scene changes', async () => {
    const run = await stepWith([{}, { state: { scene_key: 'battle' } }], ['100', '--count', '5']);
    expect(run).toMatchObject({ code: 0, steps: 2 });
    expect(plain(run.stdout)).toBe(
      'step 1/5: advanced 100 ms: main: device ms <d>\nstep 2/5: advanced 200 ms: main: device ms <d>\nstopped after step 2/5: scene changed:  -> battle\n',
    );
  });

  it('stops when the popup list or the panel list changes', async () => {
    const popup = await stepWith([{ state: { popups: ['reward'] } }], ['100', '--count', '5', '--json']);
    expect(popup.steps).toBe(1);
    expect(JSON.parse(popup.stdout)).toMatchObject({ stopped: { after: 1, reasons: ['popups changed: [] -> [reward]'] } });
    const panel = await stepWith([{}, {}, { state: { panels: ['shop'] } }], ['100', '--count', '5']);
    expect(panel.steps).toBe(3);
    expect(panel.stdout.split('\n').at(-2)).toBe('stopped after step 3/5: panels changed: [] -> [shop]');
  });

  it.each(['Fail', 'Reward', 'Goal', 'Restart'])('stops when a %s mark appears', async (kind) => {
    const run = await stepWith([{}, { marks: [{ at: 5, play_at: 5, kind }] }], ['100', '--count', '4']);
    expect(run).toMatchObject({ code: 0, steps: 2 });
    expect(run.stdout.split('\n').at(-2)).toBe(`stopped after step 2/4: mark: ${kind}`);
  });

  it('does not stop on a Response mark or an unchanged state', async () => {
    const run = await stepWith([{ marks: [{ at: 5, play_at: 5, kind: 'Response' }] }, { state: { in_transition: false } }], ['100', '--count', '3']);
    expect(run).toMatchObject({ code: 0, steps: 3 });
    expect(run.stdout).not.toContain('stopped');
  });

  it('stops and reports a failed step with exit code 1', async () => {
    const run = await stepWith([{}, { fail: 'game time is paused' }], ['100', '--count', '4', '--capture']);
    expect(run.code).toBe(1);
    expect(run.steps).toBe(2);
    const lines = run.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^step 1\/4: advanced 100 ms: main: device ms [0-9]+: .+\.jpg$/);
    expect(lines[1]).toBe('step 2/4: main: step failed: "game time is paused"');
  });

  it('reports a step that failed while a popup opened as ended early with the reason, and exits 0', async () => {
    const timeLimit = 'the command went over its time limit';
    const run = await stepWith([{}, { state: { popups: ['levelup'] }, fail: timeLimit }], ['100', '--count', '4', '--capture', '--json']);
    expect(run).toMatchObject({ code: 0, steps: 2 });
    const data = JSON.parse(run.stdout) as { steps: { index: number; advancedMs: number; endedEarly?: boolean; capture?: string }[]; stopped: unknown; failed?: unknown };
    expect(data.failed).toBeUndefined();
    expect(data.steps.map((s) => [s.index, s.advancedMs, s.endedEarly === true])).toEqual([
      [1, 100, false],
      [2, 100, true],
    ]);
    expect(data.steps[1]?.capture).toMatch(/\.jpg$/);
    // the fake keeps its state between tests, so the list before the change is whatever the last test left
    expect(data.stopped).toEqual({
      after: 2,
      reasons: [expect.stringMatching(/^popups changed: \[.*\] -> \[levelup\]$/), `ended early: main: step failed: "${timeLimit}"`],
    });
    const text = await stepWith([{ state: { popups: ['pause'] }, fail: timeLimit }], ['100', '--count', '3']);
    expect(text.code).toBe(0);
    expect(plain(text.stdout)).toBe(
      `step 1/3: ended early: main: device ms <d>\nstopped after step 1/3: popups changed: [levelup] -> [pause]; ended early: main: step failed: "${timeLimit}"\n`,
    );
  });

  it('reports a step that failed while only a stop mark was added as ended early, with the mark on that step', async () => {
    const timeLimit = 'the command went over its time limit';
    const fail = { at: startedAt + 7000, play_at: 700, kind: 'Fail' };
    const run = await stepWith([{}, { marks: [fail], fail: timeLimit }], ['100', '--count', '4', '--json']);
    expect(run).toMatchObject({ code: 0, steps: 2 });
    const data = JSON.parse(run.stdout) as { steps: { endedEarly?: boolean; marks: unknown[] }[]; stopped: unknown; failed?: unknown };
    expect(data.failed).toBeUndefined();
    expect(data.steps[1]).toMatchObject({ endedEarly: true, marks: [{ kind: 'Fail', playMs: 700 }] });
    expect(data.stopped).toEqual({ after: 2, reasons: ['mark: Fail', `ended early: main: step failed: "${timeLimit}"`] });
  });

  it('prints after every step, the last included, the device ms that ogw telemetry --summary reports', async () => {
    const from = Date.now() - startedAt;
    const run = await stepWith([], ['100', '--count', '3', '--json']);
    const summary = await ogw(runner.ws, ['telemetry', id, '--summary']);
    const to = Number(/^- device ms: ([0-9]+)$/m.exec(summary.stdout)?.[1]);
    const steps = (JSON.parse(run.stdout) as { steps: { index: number; deviceMs: number; marks: unknown[] }[] }).steps;
    expect(steps.map((s) => s.index)).toEqual([1, 2, 3]);
    let previous = from;
    for (const s of steps) {
      expect(s.deviceMs).toBeGreaterThanOrEqual(previous);
      expect(s.marks).toEqual([]);
      previous = s.deviceMs;
    }
    expect(to).toBeGreaterThanOrEqual(previous);
    expect(to - from).toBeLessThan(60_000);
  });

  it('lists on each step the marks added during that step, with their QACore play_at as play ms', async () => {
    // play_at differs from at - started_at, so the play ms printed must come from play_at
    const mark = (offset: number, kind: string) => ({ at: startedAt + offset, play_at: offset / 10, kind });
    const run = await stepWith([{ marks: [mark(1000, 'Response'), mark(1200, 'Response')] }, {}, { marks: [mark(3000, 'Goal')] }], ['100', '--count', '4', '--json']);
    expect(run).toMatchObject({ code: 0, steps: 3 });
    const data = JSON.parse(run.stdout) as { steps: { marks: unknown[] }[]; stopped: unknown };
    expect(data.steps.map((s) => s.marks)).toEqual([
      [
        { kind: 'Response', playMs: 100 },
        { kind: 'Response', playMs: 120 },
      ],
      [],
      [{ kind: 'Goal', playMs: 300 }],
    ]);
    expect(data.stopped).toEqual({ after: 3, reasons: ['mark: Goal'] });
    const text = await stepWith([{}, { marks: [mark(5000, 'Reward')] }], ['100', '--count', '2']);
    expect(plain(text.stdout)).toBe('step 1/2: advanced 100 ms: main: device ms <d>\nstep 2/2: advanced 200 ms: main: device ms <d>: mark Reward at play ms 500\n');
  });

  it('prints play ms unknown for a mark without play_at', async () => {
    const run = await stepWith([{ marks: [{ at: startedAt + 1000, kind: 'Response' }] }], ['100', '--json']);
    expect((JSON.parse(run.stdout) as { steps: { marks: unknown[] }[] }).steps[0]?.marks).toEqual([{ kind: 'Response', playMs: null }]);
    const text = await stepWith([{ marks: [{ at: startedAt + 2000, kind: 'Response' }] }], ['100']);
    expect(plain(text.stdout)).toBe('step 1/1: advanced 100 ms: main: device ms <d>: mark Response at play ms unknown\n');
  });

  it('rejects an invalid --count', async () => {
    expect((await ogw(runner.ws, ['step', id, '100', '--count', '0'])).stderr).toContain('invalid --count: 0');
    expect((await ogw(runner.ws, ['step', id, '100', '--count', '2.5'])).stderr).toContain('invalid --count: 2.5');
  });
});

describe('ogw step --stream', () => {
  it('runs each stdin line as the single step or input command would, and writes one JSON line per line with its exit code and data', async () => {
    runner.config({ clients: { main: { stepEffects: [] } }, telemetry, seq: Math.random() });
    const sentBefore = runner.requests('main').length;
    const stdin = 'step\n\nstep 2\r\ninput tap 10 20\ninput no_such_input\njump\nstep 0\nstep';
    const run = await ogw(runner.ws, ['step', id, '50', '--stream', '--state'], { stdin });
    const lines = run.stdout.trimEnd().split('\n').map((line) => JSON.parse(line) as { exit: number; data?: { steps?: { index: number; advancedMs: number; content?: unknown }[] }; error?: string });
    expect(lines).toHaveLength(7);
    expect(lines[0]).toMatchObject({ exit: 0, data: { steps: [{ index: 1, advancedMs: 50 }] } });
    expect(lines[0]?.data?.steps?.[0]).toHaveProperty('content');
    expect(lines[1]?.data?.steps?.map((s) => [s.index, s.advancedMs])).toEqual([
      [1, 50],
      [2, 100],
    ]);
    expect(lines[2]).toMatchObject({ exit: 0, data: { ok: true } });
    expect(lines[3]).toEqual({ exit: 1, error: 'no_such_input is not an input command; see ogw input --help' });
    expect(lines[4]?.error).toContain('not a stream line: jump');
    expect(lines[5]).toMatchObject({ exit: 1, error: 'invalid step count: 0' });
    expect(lines[6]).toMatchObject({ exit: 0, data: { steps: [{ index: 1 }] } });
    // a failed line fails the call; the lines after it still run
    expect(run.code).toBe(1);
    const sent = runner.requests('main').slice(sentBefore);
    expect(sent.filter((r) => r.command === 'step').map((r) => r.args)).toEqual([['50'], ['50'], ['50'], ['50']]);
    expect(sent.filter((r) => r.command === 'tap').map((r) => r.args)).toEqual([['10', '20']]);
  });

  it('gives text the rest of its line as one argument, and writes only JSON lines also with --json', async () => {
    runner.config({ clients: { main: { stepEffects: [] } }, telemetry, seq: Math.random() });
    const sentBefore = runner.requests('main').length;
    const run = await ogw(runner.ws, ['step', id, '50', '--stream', '--json'], { stdin: 'input text hello  world \nstep\n' });
    expect(run.code).toBe(0);
    const lines = run.stdout.trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line) as unknown)).toHaveLength(3);
    expect(lines.at(-1)).toBe('{}');
    expect(runner.requests('main').slice(sentBefore).filter((r) => r.command === 'text').map((r) => r.args)).toEqual([['hello  world ']]);
  });

  it('exits 0 when every line passed, and does not take --count', async () => {
    runner.config({ clients: { main: { stepEffects: [] } }, telemetry, seq: Math.random() });
    expect(await ogw(runner.ws, ['step', id, '50', '--stream'], { stdin: 'step\nstep 3\n' })).toMatchObject({ code: 0, stderr: '' });
    expect((await ogw(runner.ws, ['step', id, '50', '--stream', '--count', '2'], { stdin: 'step\n' })).stderr).toContain('--count does not go with --stream');
  });
});

describe('newMarks', () => {
  const mark = (at: number, kind = 'Goal') => ({ at, play_at: at, kind });

  it('returns the marks added after the earlier list, also when the oldest were dropped', () => {
    expect(newMarks([mark(1), mark(2)], [mark(1), mark(2), mark(3)])).toEqual([mark(3)]);
    expect(newMarks([mark(1), mark(2)], [mark(2), mark(3), mark(4)])).toEqual([mark(3), mark(4)]);
    expect(newMarks([mark(1), mark(1)], [mark(1), mark(1), mark(1)])).toEqual([mark(1)]);
    expect(newMarks([mark(1)], [mark(1)])).toEqual([]);
    expect(newMarks([], [mark(1, 'Fail')])).toEqual([mark(1, 'Fail')]);
  });
});
