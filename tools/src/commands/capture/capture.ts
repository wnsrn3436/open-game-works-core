import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expectPositionals, positional, str, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { writeFileAtomic } from '../../lib/fsx.ts';
import { automationRequest } from '../instance/automation.ts';
import { AGENT_CAPTURE_FORMAT, captureStem, capturesDir, imageExtension } from '../instance/lib/captures.ts';

export interface VideoCapture {
  dir: string;
  frames: string[];
  result: unknown;
}

/** The new folder `<stem>-video/` of `captures/` a `capture_video` of the instance writes its frames to. */
export async function videoDir(ctx: Context, instanceId: string): Promise<string> {
  return join(await capturesDir(ctx, instanceId), `${captureStem(instanceId, Date.now())}-video`);
}

/** `capture_video` of `ms` into `dir` (from `videoDir`); the folder is removed when it fails. */
export async function recordVideo(ctx: Context, instanceId: string, ms: number, dir: string, onSent?: () => void): Promise<VideoCapture> {
  try {
    const response = await automationRequest(ctx, instanceId, 'capture_video', [String(ms), AGENT_CAPTURE_FORMAT], 'main', {
      access: 'play',
      framesDir: dir,
      ...(onSent ? { onSent } : {}),
    });
    if (!response.ok) throw new OgwError(`capture_video failed: ${JSON.stringify(response.result)}`);
    return { dir, frames: response.framePaths ?? [], result: response.result };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/** `capture_video` of `ms` into a new folder `<stem>-video/` of `captures/`; the folder is removed when it fails. */
export async function captureVideo(ctx: Context, instanceId: string, ms: number): Promise<VideoCapture> {
  return recordVideo(ctx, instanceId, ms, await videoDir(ctx, instanceId));
}

let lastCaptureAt = 0;

/** `capture_screen` of the client that is not a bot client, written to `captures/<instance id>-<unix ms>.jpg` (`.png` from a core that sends PNG); returns the path. */
export async function captureScreen(ctx: Context, instanceId: string): Promise<string> {
  const response = await automationRequest(ctx, instanceId, 'capture_screen', [AGENT_CAPTURE_FORMAT], 'main', { access: 'play' });
  if (!response.ok) throw new OgwError(`capture_screen failed: ${JSON.stringify(response.result)}`);
  // two captures of one process in the same ms get different names
  lastCaptureAt = Math.max(Date.now(), lastCaptureAt + 1);
  const path = join(await capturesDir(ctx, instanceId), `${captureStem(instanceId, lastCaptureAt)}${imageExtension(response.bytes)}`);
  await writeFileAtomic(path, response.bytes);
  return path;
}

export const capture: CommandDef = {
  name: ['capture'],
  usage: 'ogw capture <instance> [--video <ms>]',
  options: { video: { type: 'string' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const instanceId = positional(args, 0, 'instance');
    const video = str(args, 'video');
    if (video !== undefined) {
      if (!/^[0-9]+$/.test(video) || Number(video) < 1) throw new OgwError(`invalid --video: ${video}`);
      const result = await captureVideo(ctx, instanceId, Number(video));
      return { text: result.dir, data: { path: result.dir, frames: result.frames, result: result.result } };
    }
    const path = await captureScreen(ctx, instanceId);
    return { text: path, data: { path } };
  },
};
