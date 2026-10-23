import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expectPositionals, positional, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { LIMITS } from '../../lib/limits.ts';
import { run, runOk } from '../../lib/proc.ts';
import { newPrivateTempFolder } from '../../lib/secret-files.ts';
import { readScenario } from '../check/lib/bot-playtest.ts';
import { runScenario } from '../check/lib/scenario.ts';
import { toolProgram } from '../env/api.ts';
import { startInstance, stopInstance } from '../instance/api.ts';
import { restartClient } from '../instance/automation.ts';
import { MOVIE_FPS } from '../instance/lib/launch.ts';
import { START_LIMIT_MS } from '../instance/lib/supervisor.ts';

/** `tailMs`: how long the recording goes on after the first `auto` step ends, so the result screen is in it. */
export const videoTiming = { tailMs: 5000 };
/** Below this difference of the video length from the recorded wall time, the video is not retimed. */
const RETIME_TOLERANCE = 0.02;

const USAGE = 'ogw video <game> [--commit <sha>] [--language <tag>]';

/** Frame count of the video stream of `file`: the last `frame=` count of an ffmpeg copy to null. */
async function frameCount(ffmpeg: string, file: string, env: NodeJS.ProcessEnv): Promise<number> {
  const out = await run(ffmpeg, ['-hide_banner', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'], { env, timeoutMs: LIMITS.programMs });
  const counts = [...out.stderr.matchAll(/frame=\s*(\d+)/g)].map((m) => Number(m[1]));
  const last = counts.at(-1);
  if (last === undefined) throw new OgwError(`ffmpeg read no frame of ${file}: ${out.stderr.trim().split('\n').at(-1) ?? ''}`);
  return last;
}

/** ffmpeg `atempo` filters whose product is `rate`: each filter takes 0.5 to 2. */
export function atempoChain(rate: number): string {
  const parts: string[] = [];
  let left = rate;
  while (left > 2) {
    parts.push('atempo=2');
    left /= 2;
  }
  while (left < 0.5) {
    parts.push('atempo=0.5');
    left /= 0.5;
  }
  parts.push(`atempo=${left.toFixed(6)}`);
  return parts.join(',');
}

/**
 * The ffmpeg encode arguments of the mp4. The movie maker writes a frame per `1 / MOVIE_FPS` s of game time, faster or
 * slower than the wall clock; the game's waits and the bot run on the wall clock. So the video is stretched to the
 * recorded wall time when it differs by more than `RETIME_TOLERANCE`.
 */
export function encodeArgs(raw: string, out: string, videoMs: number, wallMs: number): string[] {
  const factor = wallMs / videoMs;
  const filters = Math.abs(factor - 1) > RETIME_TOLERANCE ? ['-vf', `setpts=${factor.toFixed(6)}*PTS`, '-af', atempoChain(1 / factor), '-r', String(MOVIE_FPS)] : [];
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, ...filters, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out];
}

/**
 * `ogw video`: a play video of the game. Starts an instance whose client `main` records with the engine's movie
 * maker, runs the first `auto` step of the bot playtest scenario until its `until`, records `videoTiming.tailMs` more, and
 * writes an H.264 mp4 to `builds/videos/` of the game repo.
 */
export const video: CommandDef = {
  name: ['video'],
  usage: USAGE,
  options: { commit: { type: 'string' }, language: { type: 'string' } },
  // the parts that each may take their own limit: the slot wait, the start, the bot run, the two ffmpeg runs
  background: { game: (args) => args.positionals[0] ?? null, timeLimitMs: (_args, settings) => settings.instanceWaitTimeoutMs + START_LIMIT_MS + LIMITS.jobMs + 2 * LIMITS.programMs },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const game = await ctx.game(positional(args, 0, 'game'));
    const commit = str(args, 'commit');
    const language = str(args, 'language') ?? null;
    const ffmpeg = await toolProgram(ctx, 'ffmpeg');
    if (ffmpeg === null) throw new OgwError('ffmpeg (harness settings tools.ffmpeg) is not on this host: run update env');
    const temp = await newPrivateTempFolder('ogw-video-', ctx.env);
    try {
      const raw = join(temp, 'raw.avi');
      const instance = await startInstance(ctx, { game: game.name, client: 'window', movie: { file: raw }, ...(commit === undefined ? {} : { commit }) });
      let stoppedAt: number;
      try {
        if (language !== null) {
          await restartClient(ctx, instance.id, 'main', { command: 'set_language', args: [language], timeoutMs: LIMITS.httpMs }).catch((error: unknown) => {
            throw new OgwError(`set_language ${language} did not reach boot_stage Done: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        const scenario = await readScenario(instance.root);
        if (typeof scenario === 'string') throw new OgwError(scenario);
        const auto = scenario.steps.find((s) => s.kind === 'auto');
        if (auto?.until == null) throw new OgwError('client/dev/bot/scenario.json has no auto step');
        const outcome = await runScenario(ctx, instance.id, { steps: [auto], goal: auto.until }, { pollMs: 200 });
        if (outcome.stop !== null) throw new OgwError(`the bot stopped at step ${String(outcome.stop.step)}: ${outcome.stop.message}`);
        await sleep(videoTiming.tailMs);
      } finally {
        stoppedAt = Date.now();
        await stopInstance(ctx, instance.id);
      }
      const started = (await stat(raw)).birthtimeMs;
      const frames = await frameCount(ffmpeg, raw, ctx.env);
      const outDir = join(game.root, 'builds', 'videos');
      await mkdir(outDir, { recursive: true });
      const out = join(outDir, `${(instance.commit || 'checkout').slice(0, 7)}-${String(Date.now())}.mp4`);
      const videoMs = Math.round((frames * 1000) / MOVIE_FPS);
      const wallMs = Math.round(stoppedAt - started);
      await runOk(ffmpeg, encodeArgs(raw, out, videoMs, wallMs), { env: ctx.env, timeoutMs: LIMITS.programMs });
      return { text: out, data: { path: out, commit: instance.commit, videoMs, wallMs } };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
};
