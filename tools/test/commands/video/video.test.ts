import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listRecords } from '../../../src/commands/instance/lib/records.ts';
import { atempoChain, encodeArgs, videoTiming } from '../../../src/commands/video/video.ts';
import { ogw, sh } from '../../helpers/workspace.ts';
import { mockState } from '../instance/mocks/state.ts';
import { setupRunner, stopAll, type Runner } from '../instance/runner.ts';

vi.mock('../../../src/commands/generate/api.ts', async () => (await import('../instance/mocks/apis.ts')).generate);
vi.mock('../../../src/commands/data/api.ts', async () => (await import('../instance/mocks/apis.ts')).data);
vi.mock('../../../src/commands/core/api.ts', async () => (await import('../instance/mocks/apis.ts')).core);
vi.mock('../../../src/commands/env/api.ts', async () => (await import('../instance/mocks/apis.ts')).env);
vi.mock('../../../src/commands/instance/lib/spawn.ts', () => import('../instance/mocks/spawn.ts'));
vi.mock('../../../src/commands/instance/lib/launch.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/commands/instance/lib/launch.ts')>();
  return { ...real, ...(await import('../instance/mocks/apis.ts')).launchOverrides(real) };
});

const GOAL = { path: 'telemetry.goal_intervals', op: 'count_gte', value: 1 };
const SCENARIO = { steps: [{ kind: 'setup', command: 'f.cheat', timeoutMs: 1000 }, { kind: 'auto', command: 'f.bot_next_input', until: GOAL, timeoutMs: 5000 }, { kind: 'save', timeoutMs: 1000 }], goal: GOAL };

/** A fake ffmpeg: the frame count read prints `frames` frames; the encode records its arguments and writes the mp4. */
function fakeFfmpeg(runner: Runner, frames: number): string {
  const path = join(runner.logDir, 'ffmpeg');
  writeFileSync(
    path,
    `#!/bin/sh\ncase "$*" in\n  *"-f null"*) echo "frame=  ${String(frames)} fps=0" >&2;;\n  *) printf '%s\\n' "$@" > "${join(runner.logDir, 'encode.args')}"; for last; do :; done; printf mp4 > "$last";;\nesac\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

let runner: Runner | null = null;
afterEach(async () => {
  if (runner) await stopAll(runner);
  runner = null;
  videoTiming.tailMs = 5000;
});

describe('ogw video', () => {
  it('records the client main, runs only the first auto step, stops the instance and writes a retimed mp4', async () => {
    runner = setupRunner({ files: { 'client/dev/bot/scenario.json': SCENARIO }, settings: { baseResolution: [1280, 720] } });
    runner.config({
      clients: { default: { commands: ['f.bot_next_input'], sequences: { 'f.bot_next_input': [{ ok: true, result: { command: 'tap_anchor', args: ['card'] } }, { ok: true, result: null }] } } },
      telemetry: { started_at: 0, inputs: [], rewards: [], marks: [], idle_spans: [], goal_intervals: [{}], scene_loads: [], dropped: 0 },
    });
    videoTiming.tailMs = 10;
    // 600 frames: 10 s of game time, far more than the wall time of this run
    mockState.ffmpeg = fakeFfmpeg(runner, 600);
    const out = await ogw(runner.ws, ['video', 'g', '--language', 'en']);
    expect(out.stderr).toBe('');
    const path = out.stdout.trim();
    expect(path.startsWith(join(runner.root, 'builds', 'videos'))).toBe(true);
    expect(readdirSync(join(runner.root, 'builds', 'videos'))).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).toBe('mp4');
    const main = JSON.parse(readFileSync(join(runner.logDir, 'main.args.json'), 'utf8')) as string[];
    expect(main).toEqual(expect.arrayContaining(['--write-movie', '--fixed-fps', '60', '--resolution', '1280x720']));
    const commands = readFileSync(join(runner.logDir, 'main.jsonl'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { command: string }).command);
    // the language, then the bot; not the setup or save steps of the scenario
    expect(commands).toContain('set_language');
    expect(commands).toContain('tap_anchor');
    expect(commands).not.toContain('f.cheat');
    expect(commands).not.toContain('restart');
    const encode = readFileSync(join(runner.logDir, 'encode.args'), 'utf8');
    expect(encode).toMatch(/setpts=0\.\d+\*PTS/);
    expect(encode).toContain('libx264');
    expect(await listRecords(runner.ws.env)).toEqual([]);
  });

  it('records the --commit worktree, names the mp4 by that commit, and records the tail after the bot', async () => {
    runner = setupRunner({ files: { 'client/dev/bot/scenario.json': SCENARIO }, settings: { baseResolution: [1280, 720] } });
    runner.config({
      clients: { default: { commands: ['f.bot_next_input'], sequences: { 'f.bot_next_input': [{ ok: true, result: { command: 'tap_anchor', args: ['card'] } }, { ok: true, result: null }] } } },
      telemetry: { started_at: 0, inputs: [], rewards: [], marks: [], idle_spans: [], goal_intervals: [{}], scene_loads: [], dropped: 0 },
    });
    videoTiming.tailMs = 1500;
    mockState.ffmpeg = fakeFfmpeg(runner, 60);
    const sha = sh(runner.root, 'git', ['rev-parse', 'HEAD']).trim();
    let main: string[] = [];
    const out = await ogw(runner.ws, ['video', 'g', '--commit', sha, '--json']);
    expect(out.stderr).toBe('');
    const data = JSON.parse(out.stdout) as { path: string; wallMs: number };
    expect(basename(data.path).startsWith(`${sha.slice(0, 7)}-`)).toBe(true);
    main = JSON.parse(readFileSync(join(runner.logDir, 'main.args.json'), 'utf8')) as string[];
    expect(main[main.indexOf('--path') + 1]).toMatch(/instance-[^/]+\/client$/);
    // the recording went on for the tail after the last input of the bot: wallMs ends when the instance is stopped
    const taps = readFileSync(join(runner.logDir, 'main.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { command: string; at: number }).filter((e) => e.command === 'tap_anchor');
    // the fake client writes main.args.json when it starts, the moment the movie maker starts its file
    const movieStart = statSync(join(runner.logDir, 'main.args.json')).mtimeMs;
    expect(movieStart + data.wallMs - (taps.at(-1)?.at ?? 0)).toBeGreaterThanOrEqual(1500);
  });

  it('fails without an auto step and still stops the instance; fails without ffmpeg before it starts one', async () => {
    runner = setupRunner({ files: { 'client/dev/bot/scenario.json': { steps: [{ kind: 'setup', command: 'f.cheat', timeoutMs: 1000 }], goal: GOAL } }, settings: { baseResolution: [1280, 720] } });
    mockState.ffmpeg = fakeFfmpeg(runner, 60);
    const noAuto = await ogw(runner.ws, ['video', 'g']);
    expect(noAuto.code).toBe(1);
    expect(noAuto.stderr).toContain('client/dev/bot/scenario.json has no auto step');
    expect(await listRecords(runner.ws.env)).toEqual([]);
    mockState.ffmpeg = null;
    const noFfmpeg = await ogw(runner.ws, ['video', 'g']);
    expect(noFfmpeg.stderr).toContain('ffmpeg (harness settings tools.ffmpeg) is not on this host');
    expect(existsSync(join(runner.logDir, 'main.args.json'))).toBe(true);
    expect(await listRecords(runner.ws.env)).toEqual([]);
  });
});

describe('video retime', () => {
  it('retimes only past the tolerance and chains atempo within 0.5 to 2', () => {
    expect(encodeArgs('r.avi', 'o.mp4', 10_000, 10_100)).not.toContain('-vf');
    const slow = encodeArgs('r.avi', 'o.mp4', 10_000, 5_000);
    expect(slow[slow.indexOf('-vf') + 1]).toBe('setpts=0.500000*PTS');
    expect(slow[slow.indexOf('-af') + 1]).toBe('atempo=2.000000');
    expect(atempoChain(5)).toBe('atempo=2,atempo=2,atempo=1.250000');
    expect(atempoChain(0.2)).toBe('atempo=0.5,atempo=0.5,atempo=0.800000');
  });
});
