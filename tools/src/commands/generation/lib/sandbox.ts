import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, realpath } from 'node:fs/promises';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { run } from '../../../lib/proc.ts';
import { dockerBlocked, localSocketsBlocked, userServicesBlocked } from '../../agent/lib/cli-command.ts';

export interface SandboxRun {
  code: number | null;
  timedOut: boolean;
  jobMs: number;
  maxMemoryBytes: number | null;
  /** stderr lines that report an access the sandbox blocked. */
  blocked: string[];
  stderr: string;
}

/**
 * macOS Seatbelt profile: no network, writes only inside `writable`, and unix sockets only inside `writable` (no
 * connection to the Docker daemon, the SSH agent or another service of this host).
 */
export function seatbeltProfile(writable: readonly string[]): string {
  const paths = writable.map((p) => `(subpath ${JSON.stringify(p)})`).join(' ');
  const sockets = writable.map((p) => `(local unix-socket (subpath ${JSON.stringify(p)})) (remote unix-socket (subpath ${JSON.stringify(p)}))`).join(' ');
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    ...(sockets === '' ? [] : [`(allow network* ${sockets})`]),
    '(deny file-write*)',
    `(allow file-write* ${paths} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (subpath "/dev/fd"))`,
  ].join('\n');
}

const BLOCKED = /operation not permitted|read-only file system|permission denied|network is unreachable|nodename nor servname|temporary failure in name resolution|sandbox/i;

export function blockedLines(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && BLOCKED.test(l) && !/maximum resident set size/i.test(l));
}

/** Peak memory from `/usr/bin/time -l` (macOS, bytes) or `/usr/bin/time -v` (Linux, kbytes). */
export function maxMemory(stderr: string): number | null {
  const mac = /^\s*(\d+)\s+maximum resident set size/m.exec(stderr);
  if (mac) return Number(mac[1]);
  const linux = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(stderr);
  return linux ? Number(linux[1]) * 1024 : null;
}

/** Lines of stderr that `callError` keeps. */
export const ERROR_LINES = 20;

/**
 * The last `ERROR_LINES` lines of the stderr of a sandboxed call without what `/usr/bin/time` appends: from its last
 * `<n> real <n> user <n> sys` line (macOS) or `Command exited with non-zero status` / `Command being timed:` line
 * (Linux) on. Null when nothing is left.
 */
export function callError(stderr: string): string | null {
  const lines = stderr.split(/\r?\n/);
  const time = lines.findLastIndex((l) => /^\s*[\d.]+\s+real\s+[\d.]+\s+user\s+[\d.]+\s+sys\s*$/.test(l) || /^\s*Command being timed:/.test(l));
  let end = time === -1 ? lines.length : time;
  if (end > 0 && /^\s*Command exited with non-zero status/.test(lines[end - 1] ?? '')) end--;
  const kept = lines.slice(0, end);
  while (kept.length > 0 && (kept.at(-1) ?? '').trim() === '') kept.pop();
  return kept.length === 0 ? null : kept.slice(-ERROR_LINES).join('\n');
}

/**
 * GPU device nodes of this Linux host (`/dev/nvidia*` and `/dev/dri`) that the sandbox binds, so the call sees CUDA
 * and the GPU the way the host does.
 */
export async function gpuDevices(dev = '/dev'): Promise<string[]> {
  const names = await readdir(dev).catch(() => []);
  return names
    .filter((name) => name.startsWith('nvidia') || name === 'dri')
    .sort()
    .map((name) => `${dev}/${name}`);
}

/** Linux: the unix sockets and socket folders of this host that the sandbox hides. */
export interface HiddenSockets {
  folders: string[];
  files: string[];
}

/**
 * Linux: the existing unix sockets and socket folders a sandboxed call must not connect to, by their real path: the
 * Docker daemon, the SSH agent, tmux and the user's services, as the agent sandbox lists them (`tools/ogw.md`
 * `## agent`). `--unshare-net` already cuts abstract sockets; a read-only bind does not stop a connection to a
 * socket file. Other OS: none.
 */
export function hiddenSockets(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): HiddenSockets {
  if (platform !== 'linux') return { folders: [], files: [] };
  const lists = [dockerBlocked(env), localSocketsBlocked(env), userServicesBlocked(env, process.getuid?.() ?? null, platform)];
  const existing = (paths: string[]): string[] => [...new Set(paths.filter((p) => existsSync(p)).map((p) => realpathSync(p)))];
  return { folders: existing(lists.flatMap((l) => l.socketFolders ?? [])), files: existing(lists.flatMap((l) => l.sockets ?? [])) };
}

/**
 * The sandboxed command line: macOS Seatbelt or Linux bubblewrap, under `/usr/bin/time`. On Linux the new `/dev` holds
 * only the basic nodes, and each of `devices` (the host GPU nodes) is bound into it; each `hidden` folder is an empty
 * tmpfs and each `hidden` file is `/dev/null`, before the writable folders are bound.
 */
export function wrapped(
  cmd: string,
  args: readonly string[],
  writable: readonly string[],
  platform: NodeJS.Platform = process.platform,
  devices: readonly string[] = [],
  hidden: HiddenSockets = { folders: [], files: [] },
): { cmd: string; args: string[] } {
  if (platform === 'darwin') {
    return { cmd: '/usr/bin/time', args: ['-l', 'sandbox-exec', '-p', seatbeltProfile(writable), cmd, ...args] };
  }
  if (platform === 'linux') {
    const gpu = devices.flatMap((p) => ['--dev-bind', p, p]);
    const hide = [...hidden.folders.flatMap((p) => ['--tmpfs', p]), ...hidden.files.flatMap((p) => ['--ro-bind', '/dev/null', p])];
    const binds = writable.flatMap((p) => ['--bind', p, p]);
    return {
      cmd: '/usr/bin/time',
      args: ['-v', 'bwrap', '--ro-bind', '/', '/', '--dev', '/dev', ...gpu, '--proc', '/proc', ...hide, ...binds, '--unshare-net', '--die-with-parent', '--', cmd, ...args],
    };
  }
  throw new OgwError(`the sandbox runs only on macOS and Linux, not on ${platform}`);
}

/**
 * Runs a program with the network blocked and writes allowed only inside `writable`, and measures its
 * time and peak memory. `TMPDIR` points inside the first writable folder; `env` is added to the environment.
 */
export async function runSandboxed(
  ctx: Context,
  cmd: string,
  args: readonly string[],
  writable: readonly string[],
  timeoutMs: number,
  env: Readonly<Record<string, string>> = {},
): Promise<SandboxRun> {
  const real: string[] = [];
  for (const dir of writable) {
    await mkdir(dir, { recursive: true });
    real.push(await realpath(dir));
  }
  const tmp = `${real[0] as string}/tmp`;
  await mkdir(tmp, { recursive: true });
  const linux = process.platform === 'linux';
  const call = wrapped(cmd, args, real, process.platform, linux ? await gpuDevices() : [], hiddenSockets(ctx.env));
  const started = Date.now();
  const result = await run(call.cmd, call.args, { env: { ...ctx.env, TMPDIR: tmp, ...env }, timeoutMs });
  const jobMs = Date.now() - started;
  return { code: result.code, timedOut: result.timedOut, jobMs, maxMemoryBytes: maxMemory(result.stderr), blocked: blockedLines(result.stderr), stderr: result.stderr };
}

export async function isEmptyDir(dir: string): Promise<boolean> {
  const entries = await readdir(dir).catch(() => []);
  return entries.length === 0;
}
