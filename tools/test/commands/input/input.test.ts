import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseScript, videoSpanMs } from '../../../src/commands/input/input.ts';
import { readRecord } from '../../../src/commands/instance/lib/records.ts';
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

beforeAll(async () => {
  runner = setupRunner();
  runner.config({ clients: { main: { fail: { tap_anchor: 'anchor not found' } } } });
  id = await startFor(runner);
});

afterAll(async () => {
  await stopAll(runner);
});

describe('ogw input', () => {
  it('prints the help', async () => {
    const run = await ogw(runner.ws, ['input', '--help']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('input commands (QACore built-in commands with the input mark):');
    expect(run.stdout).toContain('  pad_axis: gamepad axis name, value (real)');
    expect(run.stdout).toContain('key names by engine:\n  godot: the names OS.get_keycode_string() gives, for example A, Space, Escape');
  });

  it('puts one input command in and prints ok and result', async () => {
    const run = await ogw(runner.ws, ['input', id, 'tap', '10.5', '-3']);
    expect(run).toMatchObject({ code: 0, stdout: '{"ok":true,"result":null}\n' });
    expect(runner.requests('main').at(-1)).toMatchObject({ command: 'tap', args: ['10.5', '-3'] });
  });

  it('ends with a non-zero code when the command fails', async () => {
    const run = await ogw(runner.ws, ['input', id, 'tap_anchor', 'start']);
    expect(run).toMatchObject({ code: 1, stdout: '{"ok":false,"result":"anchor not found"}\n' });
  });

  it('refuses commands without the input mark without sending them', async () => {
    const before = runner.requests('main').length;
    const run = await ogw(runner.ws, ['input', id, 'go_to_scene', 'x']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('go_to_scene is not an input command; see ogw input --help');
    expect(runner.requests('main')).toHaveLength(before);
    expect((await ogw(runner.ws, ['input', id, 'tap', '--video'])).stderr).toContain('--video goes with --script');
    expect((await ogw(runner.ws, ['input', 'nope', 'tap', '1', '1'])).stderr).toContain('instance nope is not running');
  });

  it('runs a timed input script at its times and records each step', async () => {
    const script = join(runner.ws.root, 'script.json');
    writeFileSync(script, JSON.stringify({ steps: [{ atMs: 0, command: 'key_down', args: ['A'] }, { atMs: 300, command: 'key_up', args: ['A'] }] }));
    const started = Date.now();
    const run = await ogw(runner.ws, ['input', id, '--script', script, '--json']);
    expect(run.code).toBe(0);
    const data = JSON.parse(run.stdout) as { steps: { atMs: number; sentAt: number; ok: boolean; command: string }[]; video: null };
    expect(data.steps.map((s) => [s.atMs, s.command, s.ok])).toEqual([
      [0, 'key_down', true],
      [300, 'key_up', true],
    ]);
    expect((data.steps[1]?.sentAt ?? 0) - (data.steps[0]?.sentAt ?? 0)).toBeGreaterThanOrEqual(290);
    expect((data.steps[0]?.sentAt ?? 0) - started).toBeLessThan(5000);
    expect(data.video).toBeNull();
  });

  it('records the video of the script into captures/ of the instance checkout', async () => {
    const script = join(runner.ws.root, 'video.json');
    writeFileSync(script, JSON.stringify({ steps: [{ atMs: 0, command: 'tap', args: ['1', '1'] }, { atMs: 100, command: 'tap_anchor', args: ['x'] }] }));
    const run = await ogw(runner.ws, ['input', id, '--script', script, '--video']);
    expect(run.code).toBe(1);
    const lines = run.stdout.trim().split('\n');
    expect(lines[1]).toMatch(/^100 [0-9]+ tap_anchor failed "anchor not found"$/);
    const dir = (lines[2] ?? '').replace('video: ', '');
    expect(dir.startsWith(join(runner.root, 'captures', `${id}-`))).toBe(true);
    expect(readdirSync(dir)).toEqual(['frame-00000.png', 'frame-00001.png', 'frame-00002.png']);
    expect(readFileSync(join(dir, 'frame-00001.png'), 'utf8')).toBe('FRAME-1');
    // 100 ms between the steps, no ms argument on the last step, QACore.feedbackWindowMs 400 of the mock core settings
    expect(runner.requests('main').find((r) => r.command === 'capture_video')?.args).toEqual(['500']);
  });

  it('starts the video before the first input and covers the ms of the last input', async () => {
    const script = join(runner.ws.root, 'drag.json');
    writeFileSync(
      script,
      JSON.stringify({ steps: [{ atMs: 0, command: 'tap', args: ['1', '1'] }, { atMs: 50, command: 'drag', args: ['0', '0', '9', '9', '300'] }] }),
    );
    const before = runner.requests('main').length;
    const run = await ogw(runner.ws, ['input', id, '--script', script, '--video', '--json']);
    expect(run.code).toBe(0);
    const sent = runner.requests('main').slice(before);
    expect(sent.map((r) => r.command)).toEqual(['get_state', 'capture_video', 'tap', 'drag']);
    expect(sent[1]?.args).toEqual(['750']);
    expect((JSON.parse(run.stdout) as { videoError: unknown }).videoError).toBeNull();
  });

  it('covers the frames a text step of the last step types in the video', async () => {
    expect((await readRecord(id, runner.ws.env)).plan?.targetFps).toBe(60);
    const script = join(runner.ws.root, 'text.json');
    writeFileSync(script, JSON.stringify({ steps: [{ atMs: 0, command: 'text', args: ['x'.repeat(30)] }] }));
    const before = runner.requests('main').length;
    const run = await ogw(runner.ws, ['input', id, '--script', script, '--video']);
    expect(run.code).toBe(0);
    // 30 characters at 60 fps (500 ms) and QACore.feedbackWindowMs 400
    expect(runner.requests('main').slice(before).find((r) => r.command === 'capture_video')?.args).toEqual(['900']);
  });

  it('refuses a video longer than QACore.videoMaxMs before putting any input in', async () => {
    const script = join(runner.ws.root, 'long.json');
    writeFileSync(script, JSON.stringify({ steps: [{ atMs: 0, command: 'tap', args: ['1', '1'] }, { atMs: 1601, command: 'tap', args: ['1', '1'] }] }));
    const before = runner.requests('main').length;
    const run = await ogw(runner.ws, ['input', id, '--script', script, '--video']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('the video of the script is 2001 ms, over QACore.videoMaxMs 2000');
    expect(runner.requests('main').slice(before).map((r) => r.command)).toEqual(['get_state']);
  });

  it('returns the step results with the video error when the video fails', async () => {
    runner.config({ clients: { main: { fail: { tap_anchor: 'anchor not found', capture_video: 'a capture_video is running' } } } });
    try {
      const script = join(runner.ws.root, 'busy.json');
      writeFileSync(script, JSON.stringify({ steps: [{ atMs: 0, command: 'tap', args: ['1', '1'] }, { atMs: 10, command: 'tap', args: ['2', '2'] }] }));
      const run = await ogw(runner.ws, ['input', id, '--script', script, '--video', '--json']);
      expect(run.code).toBe(1);
      const data = JSON.parse(run.stdout) as { steps: { ok: boolean }[]; video: unknown; videoError: string };
      expect(data.steps.map((s) => s.ok)).toEqual([true, true]);
      expect(data.video).toBeNull();
      expect(data.videoError).toBe('capture_video failed: "a capture_video is running"');
      const text = await ogw(runner.ws, ['input', id, '--script', script, '--video']);
      expect(text.stdout).toContain('video failed: capture_video failed: "a capture_video is running"');
    } finally {
      runner.config({ clients: { main: { fail: { tap_anchor: 'anchor not found' } } } });
    }
  });

  it('fails when the client is in step mode', async () => {
    const record = await readRecord(id, runner.ws.env);
    expect(record.status).toBe('running');
    await ogw(runner.ws, ['step-mode', id, 'on']);
    const script = join(runner.ws.root, 's.json');
    writeFileSync(script, JSON.stringify({ steps: [{ atMs: 0, command: 'tap', args: ['1', '1'] }] }));
    const run = await ogw(runner.ws, ['input', id, '--script', script]);
    expect(run.stderr).toContain('the client is in step mode');
    await ogw(runner.ws, ['step-mode', id, 'off']);
  });

  // last: the client main crashes
  it('returns the steps put in before the client crashed, and the failing step, and puts no more steps in', async () => {
    runner.config({ clients: { main: { exitOn: { key_down: 9 } } } });
    const script = join(runner.ws.root, 'crash.json');
    writeFileSync(script, JSON.stringify({ steps: [
      { atMs: 0, command: 'tap', args: ['1', '1'] },
      { atMs: 50, command: 'key_down', args: ['A'] },
      { atMs: 100, command: 'tap_anchor', args: ['x'] },
    ] }));
    const before = runner.requests('main').length;
    const run = await ogw(runner.ws, ['input', id, '--script', script, '--json']);
    expect(run.code).toBe(1);
    const data = JSON.parse(run.stdout) as { steps: { command: string; ok: boolean; sentAt: number; result: unknown }[]; notSent: number };
    expect(data.steps.map((s) => [s.command, s.ok])).toEqual([['tap', true], ['key_down', false]]);
    expect(typeof data.steps[1]?.sentAt).toBe('number');
    expect(data.steps[1]?.result).toMatchObject({ error: expect.any(String) as string });
    expect(data.notSent).toBe(1);
    expect(runner.requests('main').slice(before).map((r) => r.command)).toEqual(['get_state', 'tap', 'key_down']);
  });
});

/** The game settings targetFps default. */
const FPS = 60;

describe('timed input script', () => {
  it('rejects bad scripts', () => {
    expect(() => parseScript('x', FPS)).toThrow('invalid timed input script: not JSON');
    expect(() => parseScript('{"steps":[]}', FPS)).toThrow('no steps');
    expect(() => parseScript('{"steps":[3]}', FPS)).toThrow('step 1 is not an object');
    expect(() => parseScript('{"steps":[{"atMs":5,"command":"tap"},{"atMs":4,"command":"tap"}]}', FPS)).toThrow(
      'step 2 atMs is not an integer of at least 5',
    );
    expect(() => parseScript('{"steps":[{"atMs":-1,"command":"tap"}]}', FPS)).toThrow('step 1 atMs');
    expect(() => parseScript('{"steps":[{"atMs":0,"command":"restart"}]}', FPS)).toThrow('step 1 command is not an input command: restart');
    expect(() => parseScript('{"steps":[{"atMs":0,"command":"tap","args":[1]}]}', FPS)).toThrow('step 1 args is not a list of strings');
    expect(parseScript('{"steps":[{"atMs":0,"command":"tap"}]}', FPS)).toEqual([{ atMs: 0, command: 'tap', args: [] }]);
  });

  it('starts a step no earlier than the drag or key before it ends', () => {
    const drag = '{"atMs":0,"command":"drag","args":["0","0","100","0","1000"]}';
    expect(() => parseScript(`{"steps":[${drag},{"atMs":500,"command":"tap","args":["50","50"]}]}`, FPS)).toThrow(
      'step 2 atMs is not an integer of at least 1000',
    );
    expect(parseScript(`{"steps":[${drag},{"atMs":1000,"command":"tap","args":["50","50"]}]}`, FPS)).toHaveLength(2);
    expect(() => parseScript('{"steps":[{"atMs":10,"command":"key","args":["A","200"]},{"atMs":209,"command":"key_down","args":["B"]}]}', FPS)).toThrow(
      'step 2 atMs is not an integer of at least 210',
    );
    expect(parseScript('{"steps":[{"atMs":10,"command":"key","args":["A"]},{"atMs":10,"command":"key_down","args":["B"]}]}', FPS)).toHaveLength(2);
  });

  it('holds the input one frame per character of text', () => {
    const text = JSON.stringify({ atMs: 0, command: 'text', args: ['x'.repeat(100)] });
    // 100 characters at 60 fps: 1666.7 ms, rounded up
    expect(() => parseScript(`{"steps":[${text},{"atMs":100,"command":"tap","args":["5","5"]}]}`, FPS)).toThrow(
      'step 2 atMs is not an integer of at least 1667',
    );
    expect(parseScript(`{"steps":[${text},{"atMs":1667,"command":"tap","args":["5","5"]}]}`, FPS)).toHaveLength(2);
    // characters, not UTF-16 code units
    expect(() => parseScript(`{"steps":[{"atMs":0,"command":"text","args":["가😀"]},{"atMs":33,"command":"tap"}]}`, FPS)).toThrow('at least 34');
    expect(parseScript(`{"steps":[{"atMs":0,"command":"text","args":["ab"]},{"atMs":20,"command":"tap"}]}`, 100)).toHaveLength(2);
  });

  it('measures the script video from the first step to the end of the last input plus the feedback window', () => {
    const steps = parseScript('{"steps":[{"atMs":100,"command":"tap","args":["1","1"]},{"atMs":400,"command":"key","args":["A","250"]}]}', FPS);
    expect(videoSpanMs(steps, 500, FPS)).toBe(1050);
    const text = parseScript(JSON.stringify({ steps: [{ atMs: 0, command: 'text', args: ['x'.repeat(100)] }] }), FPS);
    expect(videoSpanMs(text, 400, FPS)).toBe(2067);
    expect(videoSpanMs(parseScript('{"steps":[{"atMs":0,"command":"tap","args":["1","1"]}]}', FPS), 0, FPS)).toBe(1);
  });
});
