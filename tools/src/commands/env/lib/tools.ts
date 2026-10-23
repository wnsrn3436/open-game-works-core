import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { run, runOk } from '../../../lib/proc.ts';
import type { PythonToolPin, ToolDownload, ToolPin } from '../../../lib/settings.ts';
import { archiveKind, extractArchive, findFile } from './files.ts';
import { dataDir, hostPlatform, safeSegment, type HostPlatform } from './host.ts';
import { InstallFailure, installItem, makeRunnable, readMarker, venvProgram, type InstallResult } from './install.ts';

export type ToolName = 'blender' | 'chromium' | 'gdtoolkit' | 'ffmpeg' | 'placeholderFont';
export const TOOL_NAMES: readonly ToolName[] = ['blender', 'placeholderFont', 'chromium', 'gdtoolkit', 'ffmpeg'];

/** The download of a pin for this host: the host platform first, then `any`. */
export function downloadFor(downloads: readonly ToolDownload[], platform: HostPlatform | null): ToolDownload | null {
  return downloads.find((d) => d.platform === platform) ?? downloads.find((d) => d.platform === 'any') ?? null;
}

export async function toolDir(ctx: Context, name: ToolName, pin: ToolPin): Promise<string> {
  return join(await dataDir(ctx), 'tools', name, safeSegment(pin.version));
}

const PROGRAM_NAMES: Record<Exclude<ToolName, 'gdtoolkit' | 'placeholderFont'>, readonly string[]> = {
  blender: ['Blender', 'blender', 'blender.exe'],
  chromium: ['chrome-headless-shell', 'chrome-headless-shell.exe'],
  ffmpeg: ['ffmpeg', 'ffmpeg.exe'],
};

/** Files a tool pin installs on this host: the download, then the `dependencies` of this host and `any`. */
export function pinFiles(pin: ToolPin | PythonToolPin, platform: HostPlatform | null): ToolDownload[] | null {
  const download = downloadFor(pin.downloads, platform);
  if (!download) return null;
  const dependencies = 'dependencies' in pin ? pin.dependencies.filter((d) => d.platform === platform || d.platform === 'any') : [];
  return [download, ...dependencies];
}

/** Installed program of a tool pin on this host, or null when it is not installed as pinned. */
export async function installedToolProgram(ctx: Context, name: ToolName, pin: ToolPin | PythonToolPin | undefined): Promise<string | null> {
  if (!pin) return null;
  const files = pinFiles(pin, hostPlatform(ctx.env));
  if (!files) return null;
  const dir = await toolDir(ctx, name, pin);
  const marker = await readMarker(dir);
  if (!marker || marker.sha256.join(',') !== files.map((f) => f.sha256).join(',')) return null;
  return join(dir, marker.program);
}

/** gdtoolkit: an isolated environment of the pin's Python with the wheels installed without dependencies. */
async function placePythonTool(ctx: Context, pin: PythonToolPin, wheels: string[], dir: string): Promise<string> {
  const venv = join(dir, 'venv');
  const options = { env: ctx.env, timeoutMs: LIMITS.programMs };
  await runOk('uv', ['venv', '--quiet', '--python', pin.python, venv], options);
  const windows = hostPlatform(ctx.env) === 'windows-x64';
  await runOk('uv', ['pip', 'install', '--quiet', '--no-deps', '--python', venvProgram(venv, 'python', windows), ...wheels], options);
  return venvProgram(venv, 'gdlint', windows);
}

/** ffmpeg must have the `libvorbis` encoder (`tools.ffmpeg` `description`). */
export async function hasLibvorbis(ctx: Context, ffmpeg: string): Promise<boolean> {
  const result = await run(ffmpeg, ['-hide_banner', '-encoders'], { env: ctx.env, timeoutMs: LIMITS.shortMs }).catch(() => null);
  return result !== null && result.code === 0 && /\slibvorbis\s/.test(result.stdout);
}

async function placeProgram(ctx: Context, name: ToolName, file: string, dir: string): Promise<string | null> {
  if (name === 'placeholderFont') return file;
  const names = PROGRAM_NAMES[name as keyof typeof PROGRAM_NAMES];
  if (archiveKind(file) !== null) {
    const files = join(dir, 'files');
    await extractArchive(file, files, ctx.env);
    return findFile(files, (base) => names.includes(base));
  }
  return makeRunnable(file, ctx.env);
}

async function placeTool(ctx: Context, name: ToolName, pin: ToolPin | PythonToolPin, paths: string[], dir: string): Promise<string | null> {
  const program = 'python' in pin ? await placePythonTool(ctx, pin, paths, dir) : await placeProgram(ctx, name, paths[0] as string, dir);
  if (program !== null && name === 'ffmpeg' && !(await hasLibvorbis(ctx, program))) throw new InstallFailure('ffmpeg has no libvorbis encoder');
  return program;
}

/** Installs a harness settings `tools` program pin into `.ogw/tools/<name>/<version>/`. */
export async function installTool(ctx: Context, name: ToolName, pin: ToolPin | PythonToolPin): Promise<InstallResult> {
  const files = pinFiles(pin, hostPlatform(ctx.env));
  if (!files) return { installed: false, mismatches: [], reason: `no download for this host` };
  const dir = await toolDir(ctx, name, pin);
  return installItem({
    dir,
    name,
    version: pin.version,
    downloads: files,
    mismatchReason: 'SHA-256 differs from the pin',
    notFoundReason: `program of ${name} not found in the download`,
    place: (downloaded) => placeTool(ctx, name, pin, downloaded.map((d) => d.file), dir),
  });
}

export function postgresImage(pin: { tag: string; digest: string }): string {
  return `postgres:${pin.tag}@${pin.digest}`;
}

/** True when the pinned `postgres` image is in this host's Docker. */
export async function postgresPresent(ctx: Context, pin: { tag: string; digest: string }): Promise<boolean> {
  const result = await run('docker', ['image', 'inspect', `postgres@${pin.digest}`], { env: ctx.env, timeoutMs: LIMITS.shortMs }).catch(() => null);
  return result !== null && result.code === 0;
}

/** `docker pull postgres:<tag>@<digest>`. */
export async function pullPostgres(ctx: Context, pin: { tag: string; digest: string }): Promise<InstallResult> {
  const result = await run('docker', ['pull', postgresImage(pin)], { env: ctx.env, timeoutMs: LIMITS.programMs }).catch(
    (error: unknown) => ({ code: 1, stderr: (error as Error).message, stdout: '', timedOut: false }),
  );
  if (result.code === 0) return { installed: true, mismatches: [], reason: null };
  return { installed: false, mismatches: [], reason: (result.stderr || result.stdout).trim() || 'docker pull failed' };
}
