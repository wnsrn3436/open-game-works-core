import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { OgwError } from './errors.ts';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Uint8Array;
  /** Every process has a time limit. The process tree is killed when it passes. */
  timeoutMs: number;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** stdout as raw bytes, for binary output. */
  stdoutBytes: Buffer;
  timedOut: boolean;
}

const KILL_GRACE_MS = 5000;
const SIGNAL_POLL_MS = 50;
const live = new Set<ChildProcess>();
let exitHookInstalled = false;

/**
 * The start time of process `pid` as `ps -o lstart=` gives it, or null when it is not running or `ps` cannot run (the
 * macOS sandbox, Windows). Recorded with a pid, it tells the process from a later one that reused the pid. `ps` runs
 * with `LC_ALL=C` and `TZ=UTC`, so the text does not depend on the locale or time zone of the process that asks.
 */
export function processStartedAt(pid: number): string | null {
  if (process.platform === 'win32') return null;
  const env = { ...process.env, LC_ALL: 'C', TZ: 'UTC' };
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000, env });
  const text = result.status === 0 ? result.stdout.trim() : '';
  return text === '' ? null : text;
}

/**
 * Whether the process group `pid` (a recorded group leader with start time `startedAt`) may be signalled: its leader is
 * still the recorded process, or its leader is gone. POSIX does not reuse a pid while a process group of that id has
 * members, so a group `pid` without its leader is the recorded group. A live leader whose start time differs, cannot be
 * read or was not recorded is another process. On Windows no start time is read and the tree is the recorded one.
 */
export function recordedGroup(pid: number, startedAt: unknown): boolean {
  if (process.platform === 'win32') return true;
  const now = processStartedAt(pid);
  if (now !== null) return typeof startedAt === 'string' && now === startedAt;
  return !isAlive(pid);
}

/** Signals the process group `pid` when `recordedGroup`; only the group, so a gone leader's pid is not signalled alone. */
export function killRecordedGroup(pid: number, startedAt: unknown, signal: NodeJS.Signals): void {
  if (!recordedGroup(pid, startedAt)) return;
  if (process.platform === 'win32' || isAlive(pid)) {
    killTree(pid, signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // no member of the group is left
  }
}

/** Kills a child and its process group (posix) or tree (windows). */
export function killTree(child: ChildProcess | number, signal: NodeJS.Signals = 'SIGTERM'): void {
  const pid = typeof child === 'number' ? child : child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

let cachedPidNs: string | null | undefined;

/**
 * The PID namespace of this process: the inode of `/proc/self/ns/pid` on Linux, null elsewhere. A pid means the
 * same process only to a process in the same PID namespace (the Linux play and judge sandbox has its own).
 */
export function pidNamespace(): string | null {
  if (cachedPidNs !== undefined) return cachedPidNs;
  cachedPidNs = null;
  if (process.platform === 'linux') {
    try {
      cachedPidNs = /\[([0-9]+)\]/.exec(readlinkSync('/proc/self/ns/pid'))?.[1] ?? null;
    } catch {
      // no /proc
    }
  }
  return cachedPidNs;
}

/** Whether pids recorded in PID namespace `recorded` (undefined: recorded before namespaces were) mean the same processes in `ns`. */
export function samePidNamespace(recorded: string | null | undefined, ns: string | null): boolean {
  return recorded === undefined || recorded === ns;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

/** Kills every process this ogw process started and has not seen end. */
export function killAllChildren(): void {
  for (const child of live) killTree(child, 'SIGKILL');
  live.clear();
}

/** Exit code of a process that ends on a signal: 128 plus the signal number. */
const SIGNAL_EXIT: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 130, SIGTERM: 143 };

function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * Ends this process on SIGTERM or SIGINT when no other handler of this process takes the signal: sends SIGTERM to
 * every tracked process group, sends SIGKILL to those still running after the grace time, and exits.
 */
async function endOnSignal(signal: NodeJS.Signals): Promise<void> {
  if (process.listenerCount(signal) > 1) return;
  const children = [...live];
  for (const child of children) killTree(child, 'SIGTERM');
  const deadline = Date.now() + KILL_GRACE_MS;
  while (children.some(running) && Date.now() < deadline) await sleep(SIGNAL_POLL_MS);
  killAllChildren();
  process.exit(SIGNAL_EXIT[signal] ?? 1);
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', killAllChildren);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void endOnSignal(signal);
    });
  }
}

/** Starts a tracked process in its own process group. It is killed when ogw exits. */
export function spawnTracked(cmd: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  installExitHook();
  const child = spawn(cmd, args, { ...options, detached: process.platform !== 'win32' });
  live.add(child);
  child.on('exit', () => live.delete(child));
  child.on('error', () => live.delete(child));
  return child;
}

export async function run(cmd: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawnTracked(cmd, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        killTree(child, 'SIGKILL');
      }, KILL_GRACE_MS);
    }, options.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(new OgwError(`cannot run ${cmd}: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const stdoutBytes = Buffer.concat(out);
      resolvePromise({
        code,
        signal,
        stdoutBytes,
        stdout: stdoutBytes.toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
      });
    });
    child.stdin?.on('error', () => undefined);
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

/** Like `run` but throws a OgwError when the process does not end with code 0. */
export async function runOk(cmd: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  const result = await run(cmd, args, options);
  if (result.timedOut) {
    throw new OgwError(`${cmd} ${args.join(' ')} timed out after ${String(options.timeoutMs)} ms`);
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new OgwError(`${cmd} ${args.join(' ')} failed (${String(result.code ?? result.signal)})${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

/** Finds a program on the PATH of `env` (default `process.env`). Returns the absolute path or null. */
export async function which(program: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const result = await run(finder, [program], { timeoutMs: 10_000, env }).catch(() => null);
  if (!result || result.code !== 0) return null;
  return result.stdout.split(/\r?\n/)[0]?.trim() || null;
}

/** Parent pid of a process, or null. */
export async function parentPid(pid: number): Promise<number | null> {
  if (process.platform === 'win32') {
    const result = await run(
      'powershell',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}").ParentProcessId`],
      { timeoutMs: 10_000 },
    );
    const value = Number.parseInt(result.stdout.trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  const result = await run('ps', ['-o', 'ppid=', '-p', String(pid)], { timeoutMs: 10_000 });
  const value = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Pids from `pid` up to the root, excluding `pid` itself. */
export async function ancestorPids(pid: number = process.pid): Promise<number[]> {
  const result: number[] = [];
  let current = pid;
  while (result.length < 256) {
    const parent = await parentPid(current);
    if (parent === null || parent === current || result.includes(parent)) break;
    result.push(parent);
    current = parent;
  }
  return result;
}

let cachedBootId: string | null | undefined;

/**
 * An id of the current boot of the host that does not depend on the wall clock: `kern.bootsessionuuid` on macOS,
 * `/proc/sys/kernel/random/boot_id` on Linux, null elsewhere.
 */
export function hostBootId(): string | null {
  if (cachedBootId !== undefined) return cachedBootId;
  try {
    if (process.platform === 'darwin') {
      cachedBootId = execFileSync('sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 10_000 }).trim() || null;
    } else if (process.platform === 'linux') {
      cachedBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
    } else {
      cachedBootId = null;
    }
  } catch {
    cachedBootId = null;
  }
  return cachedBootId;
}
