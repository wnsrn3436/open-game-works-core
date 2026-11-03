import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseScript, videoSpanMs } from '../../../src/commands/input/input.ts';
import { readRecord } from '../../../src/commands/instance/lib/records.ts';
import { newAgentKey } from '../../../src/lib/agentctx.ts';
import { jobsDir } from '../../../src/lib/jobs.ts';
import { ogw } from '../../helpers/workspace.ts';
import { fakeAgentJob } from '../instance/agents.ts';
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
    expect(run.stdout).toContain('tool inputs (made of get_anchor, mouse_down and mouse_up):\n  click_anchor: anchor name, anchor key');
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
    expect(readdirSync(dir)).toEqual(['frame-00000.jpg', 'frame-00001.jpg', 'frame-00002.jpg']);
    expect(readFileSync(join(dir, 'frame-00001.jpg')).subarray(2).toString()).toBe('FRAME-1');
    // 100 ms between the steps, no ms argument on the last step, QACore.feedbackWindowMs 400 of the mock core settings
    expect(runner.requests('main').find((r) => r.command === 'capture_video')?.args).toEqual(['500', 'jpg']);
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
    // the capture_screen that finds whether the core takes the format comes before the video
    expect(sent.map((r) => r.command)).toEqual(['get_state', 'capture_screen', 'capture_video', 'tap', 'drag']);
    expect(sent[2]?.args).toEqual(['750', 'jpg']);
    expect((JSON.parse(run.stdout) as { videoError: unknown }).videoError).toBeNull();
  });

  it('finds the capture format before the script starts, so the first input is not late by that capture', async () => {
    runner.config({ clients: { main: { delayMs: { capture_screen: 300 }, videoFrames: 1 } } });
    const script = join(runner.ws.root, 'timed.json');
    writeFileSync(script, JSON.stringify({ steps: [{ atMs: 0, command: 'tap', args: ['1', '1'] }, { atMs: 100, command: 'tap', args: ['1', '1'] }] }));
    const run = await ogw(runner.ws, ['input', id, '--script', script, '--video', '--json']);
    expect(run.code).toBe(0);
    const results = (JSON.parse(run.stdout) as { steps: { sentAt: number }[] }).steps;
    expect((results[1]?.sentAt ?? 0) - (results[0]?.sentAt ?? 0)).toBeGreaterThanOrEqual(80);
    runner.config({});
  });

  it('records the video in PNG frames from a core that does not take the format', async () => {
    runner.config({ clients: { main: { pngOnly: true, videoFrames: 2 } } });
    const script = join(runner.ws.root, 'old.json');
    writeFileSync(script, JSON.stringify({ steps: [{ atMs: 0, command: 'tap', args: ['1', '1'] }] }));
    const before = runner.requests('main').length;
    const run = await ogw(runner.ws, ['input', id, '--script', script, '--video', '--json']);
    expect(run.code).toBe(0);
    const video = runner.requests('main').slice(before).filter((r) => r.command === 'capture_video');
    expect(video.map((r) => r.args.length)).toEqual([1]);
    const out = JSON.parse(run.stdout) as { video: { frames: string[] } | null; videoError: unknown };
    expect(out.videoError).toBeNull();
    expect(out.video?.frames.every((f) => f.endsWith('.png'))).toBe(true);
    runner.config({});
  });

  it('covers the frames a text step of the last step types in the video', async () => {
    expect((await readRecord(id, runner.ws.env)).plan?.targetFps).toBe(60);
    const script = join(runner.ws.root, 'text.json');
    writeFileSync(script, JSON.stringify({ steps: [{ atMs: 0, command: 'text', args: ['x'.repeat(30)] }] }));
    const before = runner.requests('main').length;
    const run = await ogw(runner.ws, ['input', id, '--script', script, '--video']);
    expect(run.code).toBe(0);
    // 30 characters at 60 fps (500 ms) and QACore.feedbackWindowMs 400
    expect(runner.requests('main').slice(before).find((r) => r.command === 'capture_video')?.args).toEqual(['900', 'jpg']);
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

  it('clicks the center of a visible anchor with the left mouse button, alone and in a script', async () => {
    const anchor = (visible: boolean): Record<string, unknown> => ({ ok: true, result: { found: true, visible, rect: [100, 200, 41, 20] } });
    runner.config({ clients: { main: { results: { get_anchor: anchor(true) } } } });
    try {
      let before = runner.requests('main').length;
      expect(await ogw(runner.ws, ['input', id, 'click_anchor', 'menu_start'])).toMatchObject({ code: 0, stdout: '{"ok":true,"result":null}\n' });
      expect(runner.requests('main').slice(before).map((r) => [r.command, ...r.args])).toEqual([
        ['get_anchor', 'menu_start'],
        ['mouse_down', 'left', '120.5', '210'],
        ['mouse_up', 'left', '120.5', '210'],
      ]);
      const script = join(runner.ws.root, 'click.json');
      writeFileSync(script, JSON.stringify({ steps: [{ atMs: 0, command: 'click_anchor', args: ['shop_item', 'item_bow'] }] }));
      before = runner.requests('main').length;
      expect((await ogw(runner.ws, ['input', id, '--script', script])).code).toBe(0);
      expect(runner.requests('main').slice(before).map((r) => [r.command, ...r.args])).toEqual([
        ['get_state'],
        ['get_anchor', 'shop_item', 'item_bow'],
        ['mouse_down', 'left', '120.5', '210'],
        ['mouse_up', 'left', '120.5', '210'],
      ]);
      // an anchor that is hidden or covered is not clicked, as tap_anchor does not tap it
      runner.config({ clients: { main: { results: { get_anchor: anchor(false) } } } });
      before = runner.requests('main').length;
      expect(await ogw(runner.ws, ['input', id, 'click_anchor', 'menu_start'])).toMatchObject({ code: 1, stdout: '{"ok":false,"result":"the anchor is not there or not visible"}\n' });
      expect(runner.requests('main').slice(before).map((r) => r.command)).toEqual(['get_anchor']);
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

  describe('as a judge agent', () => {
    const BUDGET_MS = 240_000;
    const PASSED = 'the play budget of 240 s of instance';
    let jobs = 0;

    /** A judge agent whose budget on the instance has `leftMs` left, or which put in no input on it when null. */
    async function judge(leftMs: number | null): Promise<{ env: NodeJS.ProcessEnv; file: string; remove: () => void }> {
      const job = `agjudgeinput${String(++jobs)}`;
      const key = newAgentKey(job);
      const remove = await fakeAgentJob(runner.ws.env, job, { role: 'judge', cliPid: 999_999, keyHash: key.hash });
      const folder = join(await jobsDir(runner.ws.env), 'play-budget', `judge-${job}`);
      const file = join(folder, id);
      if (leftMs !== null) {
        mkdirSync(folder, { recursive: true });
        writeFileSync(file, String(Date.now() + leftMs - BUDGET_MS));
      }
      return { env: { OGW_AGENT_KEY: key.value }, file, remove };
    }

    function scriptOf(steps: unknown[]): string {
      const script = join(runner.ws.root, 'budget.json');
      writeFileSync(script, JSON.stringify({ steps }));
      return script;
    }

    const commandsSince = (before: number): string[] => runner.requests('main').slice(before).map((r) => r.command);

    /** Runs `test` with `ms` as the budget of a judge agent on an instance. */
    async function withBudget(ms: number, test: () => Promise<void>): Promise<void> {
      const file = join(runner.ws.harness, 'settings.json');
      const text = readFileSync(file, 'utf8');
      const settings = JSON.parse(text) as { loop: Record<string, unknown> };
      settings.loop.judgeInstanceBudgetMs = ms;
      writeFileSync(file, JSON.stringify(settings));
      try {
        await test();
      } finally {
        writeFileSync(file, text);
      }
    }

    it('refuses one input past the budget of the instance, without sending it, and puts in a release', async () => {
      const { env, remove } = await judge(0);
      const before = runner.requests('main').length;
      expect(await ogw(runner.ws, ['input', id, 'tap', '1', '1'], { env })).toMatchObject({ code: 1, stderr: expect.stringContaining(PASSED) as unknown });
      expect(commandsSince(before)).toEqual([]);
      expect(await ogw(runner.ws, ['input', id, 'key_up', 'A'], { env })).toMatchObject({ code: 0 });
      expect(commandsSince(before)).toEqual(['key_up']);
      remove();
    });

    it('does not send the steps of a script from where the budget ends, and does not wait for them', async () => {
      const { env, remove } = await judge(30_000);
      const script = scriptOf([{ atMs: 0, command: 'tap', args: ['1', '1'] }, { atMs: 100, command: 'key_down', args: ['A'] }, { atMs: 3_000_000, command: 'tap', args: ['1', '1'] }]);
      const before = runner.requests('main').length;
      const run = await ogw(runner.ws, ['input', id, '--script', script, '--json'], { env });
      expect(run.code).toBe(1);
      const data = JSON.parse(run.stdout) as { steps: { command: string }[]; notSent: number; refusal: string };
      expect(data.steps.map((s) => s.command)).toEqual(['tap', 'key_down']);
      expect(data.notSent).toBe(1);
      expect(data.refusal).toContain(PASSED);
      expect(commandsSince(before)).toEqual(['get_state', 'tap', 'key_down']);
      remove();
    });

    it('puts in only the release steps of a script past the budget, and says why the others are not sent', async () => {
      const { env, remove } = await judge(0);
      const script = scriptOf([{ atMs: 0, command: 'tap', args: ['1', '1'] }, { atMs: 50, command: 'key_up', args: ['A'] }, { atMs: 100, command: 'pad_axis', args: ['left_x', '0'] }, { atMs: 150, command: 'pad_axis', args: ['left_x', '1'] }]);
      const before = runner.requests('main').length;
      const run = await ogw(runner.ws, ['input', id, '--script', script], { env });
      expect(run.code).toBe(1);
      expect(run.stdout).toContain(`not sent: 2 steps: ${PASSED} ${id} has passed`);
      expect(commandsSince(before)).toEqual(['get_state', 'key_up', 'pad_axis']);
      remove();
    });

    it('runs a script of releases past the budget, and starts no budget with one', async () => {
      const script = scriptOf([{ atMs: 0, command: 'key_up', args: ['A'] }]);
      const past = await judge(0);
      expect((await ogw(runner.ws, ['input', id, '--script', script], { env: past.env })).code).toBe(0);
      past.remove();
      const fresh = await judge(null);
      expect((await ogw(runner.ws, ['input', id, '--script', script], { env: fresh.env })).code).toBe(0);
      expect(existsSync(fresh.file)).toBe(false);
      fresh.remove();
    });

    it('starts the budget of the instance with a script', async () => {
      const { env, file, remove } = await judge(null);
      const script = scriptOf([{ atMs: 0, command: 'tap', args: ['1', '1'] }]);
      expect((await ogw(runner.ws, ['input', id, '--script', script], { env })).code).toBe(0);
      expect(existsSync(file)).toBe(true);
      remove();
    });

    it('counts the budget from the first step of a script that is not a release, at the time it is sent', async () => {
      await withBudget(1000, async () => {
        const { env, file, remove } = await judge(null);
        const script = scriptOf([{ atMs: 0, command: 'key_up', args: ['A'] }, { atMs: 1000, command: 'tap', args: ['1', '1'] }, { atMs: 1100, command: 'tap', args: ['2', '2'] }, { atMs: 3_000_000, command: 'tap', args: ['3', '3'] }]);
        const before = runner.requests('main').length;
        const run = await ogw(runner.ws, ['input', id, '--script', script, '--json'], { env });
        expect(run.code).toBe(1);
        const data = JSON.parse(run.stdout) as { steps: { command: string; sentAt: number }[]; notSent: number; refusal: string };
        expect(data.steps.map((s) => s.command)).toEqual(['key_up', 'tap', 'tap']);
        expect(data.notSent).toBe(1);
        expect(data.refusal).toContain('the play budget of 1 s of instance');
        expect(Number(readFileSync(file, 'utf8'))).toBe(data.steps[1]?.sentAt);
        expect(commandsSince(before)).toEqual(['get_state', 'key_up', 'tap', 'tap']);
        remove();
      });
    });

    it('starts no budget with a script that the step mode or the video length refuses', async () => {
      const { env, file, remove } = await judge(null);
      await ogw(runner.ws, ['step-mode', id, 'on']);
      const tap = scriptOf([{ atMs: 0, command: 'tap', args: ['1', '1'] }]);
      expect((await ogw(runner.ws, ['input', id, '--script', tap], { env })).stderr).toContain('the client is in step mode');
      await ogw(runner.ws, ['step-mode', id, 'off']);
      expect(existsSync(file)).toBe(false);
      const long = scriptOf([{ atMs: 0, command: 'tap', args: ['1', '1'] }, { atMs: 1601, command: 'tap', args: ['1', '1'] }]);
      expect((await ogw(runner.ws, ['input', id, '--script', long, '--video'], { env })).stderr).toContain('over QACore.videoMaxMs');
      expect(existsSync(file)).toBe(false);
      remove();
    });

    it('does not send the first step of a script when another call started the budget and it passed during the wait', async () => {
      const { env, file, remove } = await judge(null);
      const script = scriptOf([{ atMs: 500, command: 'tap', args: ['1', '1'] }]);
      const before = runner.requests('main').length;
      const running = ogw(runner.ws, ['input', id, '--script', script, '--json'], { env });
      await sleep(100);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, String(Date.now() - BUDGET_MS));
      const run = await running;
      expect(run.code).toBe(1);
      expect(JSON.parse(run.stdout)).toMatchObject({ steps: [], notSent: 1, refusal: expect.stringContaining(PASSED) as unknown });
      expect(commandsSince(before)).toEqual(['get_state']);
      remove();
    });

    it('does not send a step written before the end of the budget when an earlier step is answered after the end', async () => {
      const { env, remove } = await judge(2000);
      runner.config({ clients: { main: { delayMs: { tap: 2500 } } } });
      try {
        const script = scriptOf([{ atMs: 0, command: 'tap', args: ['1', '1'] }, { atMs: 100, command: 'tap', args: ['2', '2'] }]);
        const before = runner.requests('main').length;
        const run = await ogw(runner.ws, ['input', id, '--script', script, '--json'], { env });
        expect(run.code).toBe(1);
        const data = JSON.parse(run.stdout) as { steps: { command: string; ok: boolean }[]; notSent: number; refusal: string };
        expect(data.steps.map((s) => [s.command, s.ok])).toEqual([['tap', true]]);
        expect(data.notSent).toBe(1);
        expect(data.refusal).toContain(PASSED);
        expect(commandsSince(before)).toEqual(['get_state', 'tap']);
      } finally {
        runner.config({ clients: { main: { fail: { tap_anchor: 'anchor not found' } } } });
      }
      remove();
    });
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
