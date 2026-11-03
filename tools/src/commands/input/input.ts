import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { flag, positional, str, type CommandDef, type CommandResult, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { readText } from '../../lib/fsx.ts';
import { budgetRule, checkPlayBudget, notedBudget, noteBudget, releasesHeld, type PlayBudget } from '../agent/lib/play-budget.ts';
import { recordVideo, takesFormat, type VideoCapture, videoDir } from '../capture/capture.ts';
import { automationRequest } from '../instance/automation.ts';
import { inputHelp, inputHoldMs, isPlayInput } from '../instance/lib/qa.ts';
import { readPlayAccess } from '../instance/lib/records.ts';

/** The play commands send with the play token (ogw.md `## runner`). */
const PLAY = { access: 'play' } as const;

export interface ScriptStep {
  atMs: number;
  command: string;
  args: string[];
}

export interface StepResult extends ScriptStep {
  /** Unix ms the input was put in. */
  sentAt: number;
  ok: boolean;
  result: unknown;
}

function scriptError(what: string): OgwError {
  return new OgwError(`invalid timed input script: ${what}`);
}

function readScriptStep(value: unknown, index: number, previous: number): ScriptStep {
  const where = `step ${String(index + 1)}`;
  if (typeof value !== 'object' || value === null) throw scriptError(`${where} is not an object`);
  const step = value as Record<string, unknown>;
  const at = step.atMs;
  if (typeof at !== 'number' || !Number.isInteger(at) || at < previous) {
    throw scriptError(`${where} atMs is not an integer of at least ${String(previous)}`);
  }
  if (typeof step.command !== 'string' || !isPlayInput(step.command)) {
    throw scriptError(`${where} command is not an input command: ${String(step.command)}`);
  }
  const args = step.args ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw scriptError(`${where} args is not a list of strings`);
  return { atMs: at, command: step.command, args };
}

/**
 * Reads a timed input script `{"steps": [{"atMs", "command", "args"}, ...]}`. A step starts no earlier than the
 * step before ends (its `atMs` plus `inputHoldMs` at the client `targetFps`), since the client puts one
 * input in at a time.
 */
export function parseScript(text: string, targetFps: number): ScriptStep[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw scriptError('not JSON');
  }
  const steps = (value as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw scriptError('no steps');
  let previous = 0;
  return steps.map((step, i) => {
    const read = readScriptStep(step, i, previous);
    previous = read.atMs + inputHoldMs(read.command, read.args, targetFps);
    return read;
  });
}

/** Length of the video of a script: from the first step until the last input ended and `feedbackWindowMs` passed. */
export function videoSpanMs(steps: readonly ScriptStep[], feedbackWindowMs: number, targetFps: number): number {
  const first = steps[0] as ScriptStep;
  const last = steps[steps.length - 1] as ScriptStep;
  return Math.max(1, last.atMs - first.atMs + inputHoldMs(last.command, last.args, targetFps) + feedbackWindowMs);
}

/**
 * `click_anchor`: a left mouse click at the center of the anchor, the mouse form of `tap_anchor` for a game played with
 * keys and the mouse (`game-loop` instance.md `## play`). `get_anchor`, then `mouse_down` and `mouse_up` of `left` back
 * to back; it fails as `tap_anchor` does when the anchor is not there or not visible (modal covered included).
 */
export async function clickAnchor(ctx: Context, instanceId: string, args: readonly string[]): Promise<{ ok: boolean; result: unknown }> {
  if (args.length < 1 || args.length > 2) return { ok: false, result: 'click_anchor takes an anchor name and an optional anchor key' };
  const found = await automationRequest(ctx, instanceId, 'get_anchor', [...args], 'main', PLAY);
  if (!found.ok) return { ok: false, result: found.result };
  const anchor = found.result as { found?: unknown; visible?: unknown; rect?: unknown } | null;
  const rect: unknown[] = Array.isArray(anchor?.rect) ? anchor.rect : [];
  if (anchor?.found !== true || anchor.visible !== true || rect.length !== 4 || !rect.every((v) => typeof v === 'number')) {
    return { ok: false, result: 'the anchor is not there or not visible' };
  }
  const [x, y, w, h] = rect as [number, number, number, number];
  const at = [String(x + w / 2), String(y + h / 2)];
  const down = await automationRequest(ctx, instanceId, 'mouse_down', ['left', ...at], 'main', PLAY);
  if (!down.ok) return { ok: false, result: down.result };
  const up = await automationRequest(ctx, instanceId, 'mouse_up', ['left', ...at], 'main', PLAY);
  return { ok: up.ok, result: up.result };
}

/** Puts one input of `ogw input` in: a tool input, or an input command sent as it is. */
async function sendInput(ctx: Context, instanceId: string, command: string, args: readonly string[]): Promise<{ ok: boolean; result: unknown }> {
  if (command === 'click_anchor') return clickAnchor(ctx, instanceId, args);
  const response = await automationRequest(ctx, instanceId, command, [...args], 'main', PLAY);
  return { ok: response.ok, result: response.result };
}

async function mainStepMode(ctx: Context, instanceId: string): Promise<boolean> {
  const response = await automationRequest(ctx, instanceId, 'get_state', [], 'main', PLAY);
  if (!response.ok) throw new OgwError(`get_state failed: ${JSON.stringify(response.result)}`);
  return (response.result as Record<string, unknown> | null)?.step_mode === true;
}

/** Length and folder of the script video, checked against `QACore.videoMaxMs` before any input is put in. */
async function prepareVideo(ctx: Context, instanceId: string, steps: readonly ScriptStep[], targetFps: number): Promise<{ ms: number; dir: string; format: boolean }> {
  const access = await readPlayAccess(instanceId, ctx.env);
  const windowMs = access.feedbackWindowMs;
  const maxMs = access.videoMaxMs;
  if (windowMs === null) throw new OgwError('core settings has no QACore.feedbackWindowMs');
  if (maxMs === null) throw new OgwError('core settings has no QACore.videoMaxMs');
  const ms = videoSpanMs(steps, windowMs, targetFps);
  if (ms > maxMs) {
    throw new OgwError(`the video of the script is ${String(ms)} ms, over QACore.videoMaxMs ${String(maxMs)}; split the script`);
  }
  // found before the script starts, so that the first input is not late by a capture
  return { ms, dir: await videoDir(ctx, instanceId), format: await takesFormat(ctx, instanceId) };
}

export interface ScriptRun {
  results: StepResult[];
  video: VideoCapture | null;
  /** Why the video failed; null when it did not fail or there is no video. */
  videoError: string | null;
  /** The refusal of the steps the play budget stopped; null when it stopped none. */
  refusal: string | null;
}

/** Game settings `targetFps` in the play access of the instance: the client frame rate the script times `text` with. */
export async function instanceTargetFps(ctx: Context, instanceId: string): Promise<number> {
  const fps = (await readPlayAccess(instanceId, ctx.env)).targetFps;
  if (fps === null) throw new OgwError(`instance ${instanceId} has no targetFps in its plan; start it again`);
  return fps;
}

/** The refusal when `budget` stops a step whose time is unix ms `at`, else null: past it only the release of a held input goes in. */
function budgetRefusal(budget: PlayBudget | null, at: number, step: ScriptStep): string | null {
  return budget !== null && Math.max(at, Date.now()) >= budget.endsAt && !releasesHeld([step.command, ...step.args]) ? budget.refusal : null;
}

/** The video of a script once it ended, or why it failed. */
async function endVideo(recording: Promise<VideoCapture> | null): Promise<Pick<ScriptRun, 'video' | 'videoError'>> {
  if (recording === null) return { video: null, videoError: null };
  try {
    return { video: await recording, videoError: null };
  } catch (error) {
    return { video: null, videoError: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Puts the steps in at their `atMs` from the start, in real time, without waiting for anyone else. The first step that
 * is not a release starts the play budget when it is sent. A step the budget stops is not sent and not waited for, and
 * the steps after it still run: one of them can release a held input.
 */
export async function runScript(ctx: Context, instanceId: string, steps: readonly ScriptStep[], video: boolean, targetFps: number): Promise<ScriptRun> {
  if (await mainStepMode(ctx, instanceId)) throw new OgwError('the client is in step mode; turn it off with ogw step-mode first');
  const prepared = video ? await prepareVideo(ctx, instanceId, steps, targetFps) : null;
  // found before the script starts, so that the first input is not late by it
  let unnoted = await budgetRule(ctx, instanceId);
  let budget = unnoted === null ? null : await notedBudget(unnoted);
  const start = Date.now();
  let recording: Promise<VideoCapture> | null = null;
  const results: StepResult[] = [];
  let refusal: string | null = null;
  for (const step of steps) {
    const stopped = budgetRefusal(budget, start + step.atMs, step);
    if (stopped !== null) {
      refusal = stopped;
      continue;
    }
    const wait = start + step.atMs - Date.now();
    if (wait > 0) await sleep(wait);
    if (prepared !== null && recording === null) {
      const sent = Promise.withResolvers<null>();
      recording = recordVideo(ctx, instanceId, prepared.ms, prepared.dir, prepared.format, () => {
        sent.resolve(null);
      });
      // the first input goes after the capture_video request, so the video starts before it
      await Promise.race([sent.promise, recording.then(() => null, () => null)]);
    }
    const sentAt = Date.now();
    if (unnoted !== null && !releasesHeld([step.command, ...step.args])) {
      budget = await noteBudget(unnoted, sentAt);
      unnoted = null;
      // another call can have started the budget while this step waited
      const late = budgetRefusal(budget, sentAt, step);
      if (late !== null) {
        refusal = late;
        continue;
      }
    }
    try {
      const response = await sendInput(ctx, instanceId, step.command, step.args);
      results.push({ ...step, sentAt, ok: response.ok, result: response.result });
    } catch (error) {
      // the client or the control channel is gone (a crash): this step is the last one put in
      results.push({ ...step, sentAt, ok: false, result: { error: error instanceof Error ? error.message : String(error) } });
      break;
    }
  }
  return { results, refusal, ...(await endVideo(recording)) };
}

/** One input command on the main client, as `ogw input <instance> <command> <argument...>` puts it in. */
export function singleInput(ctx: Context, instanceId: string, command: string, args: string[]): Promise<CommandResult> {
  if (!isPlayInput(command)) {
    return Promise.reject(new OgwError(`${command} is not an input command; see ogw input --help`));
  }
  return sendInput(ctx, instanceId, command, args).then((data) => ({ exitCode: data.ok ? 0 : 1, text: JSON.stringify(data), data }));
}

export const input: CommandDef = {
  name: ['input'],
  usage: 'ogw input <instance> <command> <argument...> | ogw input <instance> --script <file> [--video] | ogw input --help',
  options: { script: { type: 'string' }, video: { type: 'boolean' }, help: { type: 'boolean' } },
  async run(ctx, args) {
    if (flag(args, 'help')) return { text: inputHelp(), data: { help: inputHelp() } };
    const instanceId = positional(args, 0, 'instance');
    const script = str(args, 'script');
    if (script === undefined) {
      await checkPlayBudget(ctx, args.positionals.slice(1), instanceId);
      if (flag(args, 'video')) throw new OgwError('--video goes with --script');
      return singleInput(ctx, instanceId, positional(args, 1, 'input command'), args.positionals.slice(2));
    }
    if (args.positionals.length !== 1) throw new OgwError(`usage: ${this.usage}`);
    const fps = await instanceTargetFps(ctx, instanceId);
    const steps = parseScript(await readText(resolve(ctx.cwd, script)), fps);
    const { results, video, videoError, refusal } = await runScript(ctx, instanceId, steps, flag(args, 'video'), fps);
    const lines = results.map((r) => `${String(r.atMs)} ${String(r.sentAt)} ${r.command} ${r.ok ? 'ok' : 'failed'} ${JSON.stringify(r.result)}`);
    const notSent = steps.length - results.length;
    if (notSent > 0) lines.push(`not sent: ${String(notSent)} steps${refusal === null ? '' : `: ${refusal}`}`);
    if (video) lines.push(`video: ${video.dir}`);
    if (videoError !== null) lines.push(`video failed: ${videoError}`);
    return {
      exitCode: results.every((r) => r.ok) && notSent === 0 && videoError === null ? 0 : 1,
      text: lines.join('\n'),
      data: { steps: results, notSent, refusal, video: video ? { path: video.dir, frames: video.frames, result: video.result } : null, videoError },
    };
  },
};
