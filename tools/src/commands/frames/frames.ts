import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expectPositionals, nonNegativeInt, positional, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists } from '../../lib/fsx.ts';
import { LIMITS } from '../../lib/limits.ts';
import { runOk } from '../../lib/proc.ts';
import { toolProgram } from '../env/api.ts';
import { capturesDir } from '../instance/lib/captures.ts';

export interface Frame {
  ms: number;
  path: string;
}

/** The ms range [from, to) of the video to extract; `to` null means until the end. */
export interface FrameRange {
  from: number;
  to: number | null;
}

/** ffmpeg time duration of `ms` in seconds. */
function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

/**
 * Extracts one frame every `everyMs` of `range` from the video into `dir` as `<ms>.png`. `ms` is measured from the
 * start of the video. The frame of `<ms>` is the one on screen at that ms, the last frame whose pts is at or before it:
 * - `-noaccurate_seek` keeps the frames between the keyframe before `from` and `from`, with pts below 0, so the frame
 *   on screen at `from` reaches the filter (the accurate seek drops every frame with pts below `from`).
 * - `start_time=0` puts output slot 0 on `from`, so the image2 sequence number of each file is its slot.
 * - `round=up` puts each slot on the last frame whose pts is at or before the slot time (the default `near` takes a
 *   frame up to `everyMs / 2` later).
 */
export async function extractFrames(ffmpeg: string, video: string, everyMs: number, dir: string, range: FrameRange = { from: 0, to: null }): Promise<Frame[]> {
  const raw = join(dir, 'raw');
  await mkdir(raw, { recursive: true });
  const seek = range.from > 0 ? ['-ss', seconds(range.from), '-noaccurate_seek'] : [];
  const length = range.to === null ? [] : ['-t', seconds(range.to - range.from)];
  await runOk(
    ffmpeg,
    ['-nostdin', '-loglevel', 'error', ...seek, '-i', video, ...length, '-vf', `fps=1000/${String(everyMs)}:round=up:start_time=0`, '-start_number', '0', join(raw, '%d.png')],
    { timeoutMs: LIMITS.programMs },
  );
  const names = await readdir(raw);
  const other = names.find((n) => !/^[0-9]+\.png$/.test(n));
  if (other !== undefined) throw new OgwError(`ffmpeg wrote a file that is not a numbered frame: ${other}`);
  const frames: Frame[] = [];
  for (const name of names.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))) {
    const ms = range.from + Number.parseInt(name, 10) * everyMs;
    if (range.to !== null && ms >= range.to) continue;
    const path = join(dir, `${String(ms).padStart(9, '0')}.png`);
    await rename(join(raw, name), path);
    frames.push({ ms, path });
  }
  await rm(raw, { recursive: true, force: true });
  return frames;
}

export const frames: CommandDef = {
  name: ['frames'],
  usage: 'ogw frames <video> --every <ms> [--from <ms>] [--to <ms>]',
  options: { every: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const video = resolve(ctx.cwd, positional(args, 0, 'video'));
    const every = nonNegativeInt(args, 'every');
    if (every === undefined || every < 1) throw new OgwError(`usage: ${this.usage}`);
    const from = nonNegativeInt(args, 'from') ?? 0;
    const to = nonNegativeInt(args, 'to') ?? null;
    if (to !== null && to <= from) throw new OgwError(`--to ${String(to)} is not after --from ${String(from)}`);
    if (!exists(video)) throw new OgwError(`video not found: ${video}`);
    const ffmpeg = await toolProgram(ctx, 'ffmpeg');
    if (ffmpeg === null) throw new OgwError('ffmpeg (harness settings tools.ffmpeg) is not on this host: run update env');
    const captures = await capturesDir(ctx, null);
    await mkdir(captures, { recursive: true });
    const dir = await mkdtemp(join(captures, 'frames-'));
    try {
      const list = await extractFrames(ffmpeg, video, every, dir, { from, to });
      return { text: list.map((f) => `${String(f.ms)} ${f.path}`).join('\n'), data: { frames: list } };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  },
};
