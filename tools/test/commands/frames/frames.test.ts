import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ogw, makeWorkspace } from '../../helpers/workspace.ts';
import { fakeAgentJob } from '../instance/agents.ts';
import { mockState, resetMocks } from '../instance/mocks/state.ts';

vi.mock('../../../src/commands/env/api.ts', async () => (await import('../instance/mocks/apis.ts')).env);

/** A fake ffmpeg that writes numbered PNGs (`%d`) to its output folder and records its arguments. */
function fakeFfmpeg(dir: string, exit = 0, numbers = ['0', '1', '2']): string {
  const path = join(dir, 'ffmpeg');
  writeFileSync(
    path,
    `#!/bin/sh\necho "$@" > "${join(dir, 'ffmpeg.args')}"\nfor last; do :; done\nout=$(dirname "$last")\n` +
      `for n in ${numbers.join(' ')}; do printf "F$n" > "$out/$n.png"; done\nexit ${String(exit)}\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

/**
 * A fake ffmpeg that models the frame selection of ffmpeg 9: the video is JSON `{"pts": [<frame pts ms>...],
 * "keyEvery": <n>, "endMs": <ms>}` and the PNG of each output file holds the source frame index.
 * - input `-ss <s>`: the accurate seek keeps the frames with pts at or after `s`; with `-noaccurate_seek` it keeps the
 *   frames from the last keyframe at or before `s`. Either way pts become pts − `s`.
 * - `fps=<rate>:round=up[:start_time=0]`: a frame's slot is ceil(pts ÷ slot length). The first slot is 0 with
 *   `start_time=0`, else the first frame's slot. Each slot gets the last frame whose slot is at or before it, until
 *   the video end or output `-t`.
 * - the image2 muxer numbers files by sequence from `-start_number`.
 */
function modelFfmpeg(dir: string): string {
  const path = join(dir, 'ffmpeg');
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const at = (k) => a.indexOf(k);
const iIn = at('-i');
const before = a.slice(0, iIn);
const after = a.slice(iIn + 2);
const video = JSON.parse(fs.readFileSync(a[iIn + 1], 'utf8'));
const ss = before.includes('-ss') ? Number(before[before.indexOf('-ss') + 1]) * 1000 : 0;
const accurate = !before.includes('-noaccurate_seek');
const t = after.includes('-t') ? Number(after[after.indexOf('-t') + 1]) * 1000 : Infinity;
const vf = after[after.indexOf('-vf') + 1];
const m = /^fps=1000\\/([0-9]+):round=up(:start_time=0)?$/.exec(vf);
if (!m) { process.stderr.write('unknown filter ' + vf); process.exit(1); }
const every = Number(m[1]);
let first = 0;
if (ss > 0) {
  if (accurate) first = video.pts.findIndex((p) => p >= ss);
  else for (let i = 0; i < video.pts.length; i += video.keyEvery) if (video.pts[i] <= ss) first = i;
}
const frames = [];
for (let i = first; i < video.pts.length; i++) frames.push({ i, slot: Math.ceil((video.pts[i] - ss) / every) });
let slot = m[2] ? 0 : frames[0].slot;
const out = after[after.length - 1];
let n = Number(after[after.indexOf('-start_number') + 1]);
while (slot * every < Math.min(t, video.endMs - ss)) {
  let shown = null;
  for (const f of frames) if (f.slot <= slot) shown = f;
  if (shown === null) shown = frames[0];
  fs.writeFileSync(out.replace('%d', String(n)), 'F' + String(shown.i));
  n++;
  slot++;
}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe('ogw frames', () => {
  it('writes a frame every ms into captures/ of the judge agent folder', async () => {
    resetMocks();
    const ws = makeWorkspace();
    const tools = mkdtempSync(join(tmpdir(), 'ogw-ff-'));
    mockState.ffmpeg = fakeFfmpeg(tools);
    const video = join(ws.root, 'ref.mp4');
    writeFileSync(video, 'video');
    const folder = mkdtempSync(join(tmpdir(), 'ogw-judge-'));
    const remove = await fakeAgentJob(ws.env, 'agentjudge3', { role: 'judge', cliPid: process.ppid, folder });
    try {
      const run = await ogw(ws, ['frames', 'ref.mp4', '--every', '500', '--json']);
      expect(run.code).toBe(0);
      const frames = (JSON.parse(run.stdout) as { frames: { ms: number; path: string }[] }).frames;
      expect(frames.map((f) => f.ms)).toEqual([0, 500, 1000]);
      expect(frames[2]?.path).toMatch(new RegExp(`^${join(folder, 'captures', 'frames-')}[A-Za-z0-9]+/000001000\\.png$`));
      expect(readFileSync(frames[1]?.path ?? '', 'utf8')).toBe('F1');
      expect(readdirSync(join(frames[0]?.path ?? '', '..'))).toEqual(['000000000.png', '000000500.png', '000001000.png']);
      expect(readFileSync(join(tools, 'ffmpeg.args'), 'utf8')).toContain(`-i ${video} -vf fps=1000/500:round=up:start_time=0 -start_number 0`);
      expect(readFileSync(join(tools, 'ffmpeg.args'), 'utf8')).toMatch(/%d\.png\n$/);
      const text = await ogw(ws, ['frames', video, '--every', '250']);
      expect(text.stdout.split('\n')[1]).toMatch(/^250 .*000000250\.png$/);
      // parallel calls in the same millisecond each get their own folder
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      const both = await Promise.all([1, 2].map(() => ogw(ws, ['frames', video, '--every', '100', '--json']))).finally(() => {
        now.mockRestore();
      });
      const dirs = both.map((r) => dirname((JSON.parse(r.stdout) as { frames: { path: string }[] }).frames[0]?.path ?? ''));
      expect(new Set(dirs).size).toBe(2);
      for (const d of dirs) expect(readdirSync(d)).toEqual(['000000000.png', '000000100.png', '000000200.png']);
    } finally {
      remove();
    }
  });

  it('keeps frames past index 999999 and extracts only the --from --to range with ms from the video start', async () => {
    resetMocks();
    const ws = makeWorkspace();
    const tools = mkdtempSync(join(tmpdir(), 'ogw-ff-'));
    mockState.ffmpeg = fakeFfmpeg(tools, 0, ['999999', '1000000', '1000001']);
    writeFileSync(join(ws.root, 'long.mp4'), 'video');
    const folder = mkdtempSync(join(tmpdir(), 'ogw-judge-'));
    const remove = await fakeAgentJob(ws.env, 'agentjudge5', { role: 'judge', cliPid: process.ppid, folder });
    try {
      const long = await ogw(ws, ['frames', 'long.mp4', '--every', '1', '--json']);
      expect((JSON.parse(long.stdout) as { frames: { ms: number }[] }).frames.map((f) => f.ms)).toEqual([999999, 1000000, 1000001]);
      mockState.ffmpeg = fakeFfmpeg(tools);
      const run = await ogw(ws, ['frames', 'long.mp4', '--every', '500', '--from', '2000', '--to', '3000', '--json']);
      expect(run.code).toBe(0);
      expect((JSON.parse(run.stdout) as { frames: { ms: number }[] }).frames.map((f) => f.ms)).toEqual([2000, 2500]);
      expect(readFileSync(join(tools, 'ffmpeg.args'), 'utf8')).toContain('-ss 2.000 -noaccurate_seek -i ' + join(ws.root, 'long.mp4') + ' -t 1.000 -vf fps=1000/500:round=up:start_time=0');
      const to = await ogw(ws, ['frames', 'long.mp4', '--every', '500', '--to', '700', '--json']);
      expect((JSON.parse(to.stdout) as { frames: { ms: number }[] }).frames.map((f) => f.ms)).toEqual([0, 500]);
      expect(readFileSync(join(tools, 'ffmpeg.args'), 'utf8')).toContain('-i ' + join(ws.root, 'long.mp4') + ' -t 0.700 -vf');
      // --from alone: from that ms to the video end
      const from = await ogw(ws, ['frames', 'long.mp4', '--every', '500', '--from', '2000', '--json']);
      expect((JSON.parse(from.stdout) as { frames: { ms: number }[] }).frames.map((f) => f.ms)).toEqual([2000, 2500, 3000]);
      const fromArgs = readFileSync(join(tools, 'ffmpeg.args'), 'utf8');
      expect(fromArgs).toContain('-ss 2.000 -noaccurate_seek -i ' + join(ws.root, 'long.mp4') + ' -vf fps=1000/500:round=up:start_time=0');
      expect(fromArgs).not.toContain(' -t ');
      expect((await ogw(ws, ['frames', 'long.mp4', '--every', '500', '--from', '700', '--to', '700'])).stderr).toContain(
        '--to 700 is not after --from 700',
      );
      expect((await ogw(ws, ['frames', 'long.mp4', '--every', '500', '--from', '-1'])).code).not.toBe(0);
    } finally {
      remove();
    }
  });

  it('labels each frame with the ms it is on screen when --from is not on a frame pts', async () => {
    resetMocks();
    const ws = makeWorkspace();
    mockState.ffmpeg = modelFfmpeg(mkdtempSync(join(tmpdir(), 'ogw-ff-')));
    const pts = (fps: number, ms: number): number[] => Array.from({ length: Math.ceil((ms * fps) / 1000) }, (_, i) => (i * 1000) / fps);
    writeFileSync(join(ws.root, 'v30.json'), JSON.stringify({ pts: pts(30, 4000), keyEvery: 30, endMs: 4000 }));
    writeFileSync(join(ws.root, 'v2997.json'), JSON.stringify({ pts: pts(30000 / 1001, 4000), keyEvery: 30, endMs: 4000 }));
    const folder = mkdtempSync(join(tmpdir(), 'ogw-judge-'));
    const remove = await fakeAgentJob(ws.env, 'agentjudge6', { role: 'judge', cliPid: process.ppid, folder });
    /** label → the source frame index each file holds */
    const shown = async (args: string[]): Promise<[number, number][]> => {
      const run = await ogw(ws, ['frames', ...args, '--json']);
      expect(run.code).toBe(0);
      return (JSON.parse(run.stdout) as { frames: { ms: number; path: string }[] }).frames.map((f) => [f.ms, Number(readFileSync(f.path, 'utf8').slice(1))]);
    };
    /** the index of the last frame whose pts is at or before `ms` */
    const onScreen = (fps: number, ms: number): number => Math.floor((ms * fps) / 1000 + 1e-9);
    try {
      expect(await shown(['v30.json', '--every', '500', '--from', '1010', '--to', '3010'])).toEqual(
        [1010, 1510, 2010, 2510].map((ms) => [ms, onScreen(30, ms)]),
      );
      expect(await shown(['v30.json', '--every', '500', '--from', '1340', '--to', '2340'])).toEqual([
        [1340, 40],
        [1840, 55],
      ]);
      expect(await shown(['v2997.json', '--every', '100', '--from', '2345', '--to', '2645'])).toEqual(
        [2345, 2445, 2545].map((ms) => [ms, onScreen(30000 / 1001, ms)]),
      );
      expect(await shown(['v30.json', '--every', '1000'])).toEqual([0, 1000, 2000, 3000].map((ms) => [ms, onScreen(30, ms)]));
      expect(await shown(['v30.json', '--every', '500', '--from', '2900'])).toEqual([2900, 3400, 3900].map((ms) => [ms, onScreen(30, ms)]));
    } finally {
      remove();
    }
  });

  it('checks its arguments, ffmpeg and the captures folder', async () => {
    resetMocks();
    const ws = makeWorkspace();
    writeFileSync(join(ws.root, 'v.mp4'), 'v');
    expect((await ogw(ws, ['frames', 'v.mp4'])).stderr).toContain('usage: ogw frames <video> --every <ms>');
    expect((await ogw(ws, ['frames', 'v.mp4', '--every', '0'])).stderr).toContain('usage');
    expect((await ogw(ws, ['frames', 'v.mp4', '--every', '1.5'])).stderr).toContain('invalid --every: 1.5');
    expect((await ogw(ws, ['frames', 'v.mp4', '--every', '10', '--from', '99999999999999999'])).stderr).toContain('invalid --from: 99999999999999999');
    expect((await ogw(ws, ['frames', 'none.mp4', '--every', '10'])).stderr).toContain('video not found');
    expect((await ogw(ws, ['frames', 'v.mp4', '--every', '10'])).stderr).toContain('ffmpeg');
    mockState.ffmpeg = fakeFfmpeg(mkdtempSync(join(tmpdir(), 'ogw-ff-')));
    expect((await ogw(ws, ['frames', 'v.mp4', '--every', '10'])).stderr).toContain(
      'not defined: the captures folder of ogw frames outside a play or judge agent',
    );
    const folder = mkdtempSync(join(tmpdir(), 'ogw-play-'));
    mockState.ffmpeg = fakeFfmpeg(mkdtempSync(join(tmpdir(), 'ogw-ff-')), 1);
    const remove = await fakeAgentJob(ws.env, 'agentplay4', { role: 'play', cliPid: process.ppid, folder });
    try {
      const run = await ogw(ws, ['frames', 'v.mp4', '--every', '10']);
      expect(run.code).not.toBe(0);
      expect(existsSync(join(folder, 'captures')) ? readdirSync(join(folder, 'captures')) : []).toEqual([]);
    } finally {
      remove();
    }
  });
});
