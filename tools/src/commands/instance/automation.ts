import { mkdir } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import type { Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { writeFileAtomic } from '../../lib/fsx.ts';
import { LIMITS } from '../../lib/limits.ts';
import { msArgument } from './lib/qa.ts';
import { readPlayAccess, readRecord } from './lib/records.ts';
import { imageExtension } from './lib/captures.ts';

export interface AutomationResponse {
  ok: boolean;
  result: unknown;
  /** Decoded `bytes` of the response; empty when none. */
  bytes: Buffer;
  /** `capture_video` frames (image bytes) in order; empty when `framesDir` took them. */
  frames: Buffer[];
  /** Files the frames were written to when `framesDir` was given, in order. */
  framePaths?: string[];
}

/** Which client of the instance: the client that is not a bot client, or a bot client by name. */
export type ClientRef = 'main' | `opponent_${number}` | 'social';

/**
 * Which token a request uses (ogw.md `## runner`). `play`: the restricted token of the play access file, which
 * the play and judge sandbox can read; the play commands use it. `full`: the full control token of the instance
 * record.
 */
export type Access = 'full' | 'play';

export interface AutomationOptions {
  /** Default `full`. */
  access?: Access;
  /** Write `capture_video` frames as `frame-NNNNN.<jpg or png>` files (`n` in 5 digits) into this folder instead of returning them. */
  framesDir?: string;
  /** Time limit of the request; default from `QACore.commandTimeoutMs` and the ms argument. */
  timeoutMs?: number;
  /** Called once the request is handed to the operating system, before its answer. */
  onSent?: () => void;
}

/** Runner-side time limit of a request: `QACore.commandTimeoutMs`, the ms argument (qa-core `### command`), and a margin. */
export function requestTimeoutMs(commandTimeoutMs: number, command: string, args: readonly string[]): number {
  return commandTimeoutMs + msArgument(command, args) + LIMITS.shortMs;
}

interface Running {
  port: number;
  token: string;
  commandTimeoutMs: number;
}

async function running(ctx: Context, instanceId: string, access: Access): Promise<Running> {
  if (access === 'play') {
    const play = await readPlayAccess(instanceId, ctx.env);
    return { port: play.port, token: play.token, commandTimeoutMs: play.commandTimeoutMs };
  }
  const record = await readRecord(instanceId, ctx.env);
  if (record.status !== 'running' || !record.control || !record.plan) {
    throw new OgwError(`instance ${instanceId} is not running (${record.status})`);
  }
  return { port: record.control.port, token: record.control.token, commandTimeoutMs: record.plan.commandTimeoutMs };
}

/** POSTs a JSON body to the control channel of a supervisor and returns its JSON answer. */
export function controlCall(
  port: number,
  token: string,
  path: string,
  body: unknown,
  timeoutMs: number,
  onSent?: () => void,
): Promise<unknown> {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': payload.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timer);
          let value: unknown = null;
          try {
            value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            value = null;
          }
          if (res.statusCode === 200) resolvePromise(value);
          else reject(new OgwError(errorOf(value) ?? `instance control ${path} failed (${String(res.statusCode)})`));
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new OgwError(`instance control ${path} timed out after ${String(timeoutMs)} ms`));
    }, timeoutMs);
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error instanceof OgwError ? error : new OgwError(`instance control ${path}: ${error.message}`));
    });
    if (onSent) req.on('finish', onSent);
    req.end(payload);
  });
}

function errorOf(value: unknown): string | null {
  if (typeof value === 'object' && value !== null && typeof (value as { error?: unknown }).error === 'string') {
    return (value as { error: string }).error;
  }
  return null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Sends one QACore automation channel request to a client of a running instance (full token unless `options.access`). */
export async function automationRequest(
  ctx: Context,
  instanceId: string,
  command: string,
  args: string[],
  client: ClientRef = 'main',
  options: AutomationOptions = {},
): Promise<AutomationResponse> {
  const access = options.access ?? 'full';
  const { port, token, commandTimeoutMs } = await running(ctx, instanceId, access);
  const timeoutMs = options.timeoutMs ?? requestTimeoutMs(commandTimeoutMs, command, args);
  // the supervisor writes frames only for the full token; with the play token this process writes them
  const supervisorFrames = options.framesDir !== undefined && access === 'full';
  const body = { client, command, args, timeoutMs, ...(supervisorFrames ? { framesDir: options.framesDir } : {}) };
  const answer = (await controlCall(port, token, '/request', body, timeoutMs + LIMITS.shortMs, options.onSent)) as Record<string, unknown>;
  const response: AutomationResponse = {
    ok: answer.ok === true,
    result: answer.result ?? null,
    bytes: Buffer.from(typeof answer.bytes === 'string' ? answer.bytes : '', 'base64'),
    frames: strings(answer.frames).map((f) => Buffer.from(f, 'base64')),
    framePaths: strings(answer.framePaths),
  };
  if (options.framesDir === undefined || supervisorFrames) return response;
  return { ...response, frames: [], framePaths: await writeFrames(options.framesDir, response.frames) };
}

/** Writes frames as `frame-NNNNN.jpg` or `.png` by their bytes (`n` in 5 digits) into `dir` and returns their paths in order. */
async function writeFrames(dir: string, frames: readonly Buffer[]): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const paths: string[] = [];
  for (const [n, image] of frames.entries()) {
    const path = join(dir, `frame-${String(n).padStart(5, '0')}${imageExtension(image)}`);
    await writeFileAtomic(path, image);
    paths.push(path);
  }
  return paths;
}

export interface RestartOptions {
  /** The command that restarts the client: `restart` (default) or `set_language`. */
  command?: 'restart' | 'set_language';
  args?: string[];
  /** Time limit of the new boot reaching `Done`; default the program time limit. */
  timeoutMs?: number;
}

/**
 * Sends `restart` (or `set_language`) to a client and returns its `get_state` once the new boot reached `Done`: the
 * runner waits for the new automation channel connection, then for `boot_stage` `Done`.
 */
export async function restartClient(
  ctx: Context,
  instanceId: string,
  client: ClientRef = 'main',
  options: RestartOptions = {},
): Promise<Record<string, unknown>> {
  const { port, token } = await running(ctx, instanceId, 'full');
  const timeoutMs = options.timeoutMs ?? LIMITS.programMs;
  const body = { client, timeoutMs, command: options.command ?? 'restart', args: options.args ?? [] };
  return (await controlCall(port, token, '/restart', body, timeoutMs + LIMITS.shortMs)) as Record<string, unknown>;
}

/** Bot loop control of `ogw step-mode` and `ogw step`, with the play token. */
export async function botControl(
  ctx: Context,
  instanceId: string,
  action: 'pause' | 'resume' | 'stepping',
  body: Record<string, unknown> = {},
): Promise<void> {
  const { port, token } = await running(ctx, instanceId, 'play');
  const path = action === 'stepping' ? '/stepping' : `/bots/${action}`;
  await controlCall(port, token, path, body, LIMITS.programMs);
}
