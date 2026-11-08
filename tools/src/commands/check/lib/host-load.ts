import { readdir, readFile } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { isNotFound } from '../../../lib/fsx.ts';
import { run } from '../../../lib/proc.ts';
import { listInstances } from '../../instance/api.ts';
import { readRecord } from '../../instance/lib/records.ts';
import type { HostLoad } from '../api.ts';

/** CPU time counters of the whole host, in ms. */
export interface CpuTimes {
  idle: number;
  total: number;
}

/** One process of the host and the CPU time it has used. */
export interface ProcessCpu {
  pid: number;
  ppid: number;
  /** Start time of the process as the platform gives it, so that a later process that reuses the pid is another process. */
  start: string;
  /** User and system CPU time of all threads of the process since it started, in ms. */
  cpuMs: number;
}

export interface HostProbe {
  cpuTimes(): CpuTimes;
  /** Every process of the host with its CPU time; null when this platform or this reading cannot be read. */
  processes(): Promise<ProcessCpu[] | null>;
  /** The supervisor pid of instance `id`; null when its record has none. */
  supervisorPid(id: string): Promise<number | null>;
  /** Memory use of the host in %: the memory that is not available (`hostMemoryPercent`). */
  memoryPercent(): number | Promise<number>;
  /** Instances the runner has started and not stopped. */
  instances(): Promise<number>;
}

/** CPU time in ms of a macOS `ps -o time` value, `[[dd-]hh:]mm:ss.cc` (the minutes can pass 59); null when it is not one. */
export function psCpuMs(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) return null;
  const [, days = '0', hours = '0', minutes = '0', seconds = '0', fraction = ''] = match;
  const whole = ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
  return Math.round((whole + (fraction === '' ? 0 : Number(`0.${fraction}`))) * 1000);
}

/** The processes of `ps -A -o pid=,ppid=,time=,lstart=` output; a line that is not one is skipped. */
export function parsePs(text: string): ProcessCpu[] {
  const out: ProcessCpu[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line);
    const cpuMs = match?.[3] === undefined ? null : psCpuMs(match[3]);
    if (match === null || cpuMs === null) continue;
    out.push({ pid: Number(match[1]), ppid: Number(match[2]), start: (match[4] ?? '').replace(/\s+/g, ' '), cpuMs });
  }
  return out;
}

/**
 * The process of a Linux `/proc/<pid>/stat` text: ppid is field 4, utime and stime fields 14 and 15 in clock ticks,
 * starttime field 22. The command name (field 2) is in parentheses and may hold spaces and parentheses, so the fields
 * are counted after its last `)`. Null when the text is not one.
 */
export function parseProcStat(text: string, ticksPerSecond: number): ProcessCpu | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const after = text.slice(close + 1).trim().split(/\s+/);
  /** Field `n` (from 1) of the stat text; the fields after the command name start at field 3. */
  const field = (n: number): string => after[n - 3] ?? '';
  const [pid, ppid, utime, stime, start] = [text.slice(0, open).trim(), field(4), field(14), field(15), field(22)];
  if (![pid, ppid, utime, stime, start].every((v) => /^\d+$/.test(v))) return null;
  return { pid: Number(pid), ppid: Number(ppid), start, cpuMs: ((Number(utime) + Number(stime)) * 1000) / ticksPerSecond };
}

/**
 * A reading of the host that failed (ogw.md `### host load`: the CPU time of the instance in that second is then 0): a
 * program that could not run or a system error (an error with an errno `code`). Another error is rethrown.
 */
function failedReading(error: unknown): null {
  if (error instanceof OgwError || typeof (error as { code?: unknown } | null)?.code === 'string') return null;
  throw error;
}

/** A `/proc/<pid>/stat` of a process that ended while it was read (its folder is gone): left out. Another error is rethrown. */
function processEnded(error: unknown): null {
  if (isNotFound(error) || (error as { code?: unknown } | null)?.code === 'ESRCH') return null;
  throw error;
}

/**
 * The processes of a Linux proc folder (`/proc`); a process that ended while it was read is left out. Null when the
 * folder cannot be read (`failedReading`).
 */
export async function procProcesses(procRoot: string, ticksPerSecond: number): Promise<ProcessCpu[] | null> {
  const names = await readdir(procRoot).catch(failedReading);
  if (names === null) return null;
  const read = await Promise.all(
    names.filter((n) => /^\d+$/.test(n)).map((n) => readFile(join(procRoot, n, 'stat'), 'utf8').then((t) => parseProcStat(t, ticksPerSecond), processEnded)),
  );
  return read.filter((p): p is ProcessCpu => p !== null);
}

let cachedTicks: Promise<number | null> | undefined;

/** `getconf CLK_TCK`: the clock ticks per second of `/proc/<pid>/stat`; null when it cannot be read. */
function clockTicks(): Promise<number | null> {
  cachedTicks ??= run('getconf', ['CLK_TCK'], { timeoutMs: 10_000 }).then(
    (r) => {
      const value = Number(r.stdout.trim());
      return r.code === 0 && Number.isInteger(value) && value > 0 ? value : null;
    },
    failedReading,
  );
  return cachedTicks;
}

/**
 * Every process of this host with its CPU time: `ps` on macOS (`time` in centiseconds), `/proc/<pid>/stat` on Linux
 * (`ps` there gives `time` in whole seconds). Null on another platform and when the reading fails.
 */
async function hostProcesses(): Promise<ProcessCpu[] | null> {
  if (process.platform === 'darwin') {
    const env = { ...process.env, LC_ALL: 'C', TZ: 'UTC' };
    const result = await run('ps', ['-A', '-o', 'pid=,ppid=,time=,lstart='], { timeoutMs: 10_000, env }).catch(failedReading);
    return result?.code === 0 ? parsePs(result.stdout) : null;
  }
  if (process.platform === 'linux') {
    const ticks = await clockTicks();
    return ticks === null ? null : procProcesses('/proc', ticks);
  }
  return null;
}

/** The memory use of `os.freemem` (%): on Linux free counts the available memory (`MemAvailable`), on macOS only the free pages. */
function freePagesPercent(): number {
  return (1 - freemem() / totalmem()) * 100;
}

/**
 * The memory use of the host (%), as the share of its memory that is not available (ogw.md `### host load`). On macOS
 * that is 100 minus `kern.memorystatus_level`, the free share of the system that counts the memory it takes back at once
 * (file cache, inactive and purgeable pages), which `os.freemem` leaves out; a failed reading gives the share of the free
 * pages, which is higher, so a busy host is never read as a quiet one. Elsewhere it is `os.freemem` (`MemAvailable` on Linux).
 */
export async function hostMemoryPercent(env: NodeJS.ProcessEnv, read: (env: NodeJS.ProcessEnv) => Promise<string | null> = memorystatusLevel): Promise<number> {
  if (process.platform !== 'darwin') return freePagesPercent();
  const text = await read(env);
  const level = text === null ? Number.NaN : Number(text.trim());
  if (!Number.isInteger(level) || level < 0 || level > 100) return freePagesPercent();
  return 100 - level;
}

/** `kern.memorystatus_level` of macOS, or null when it cannot be read (`failedReading`). */
async function memorystatusLevel(env: NodeJS.ProcessEnv): Promise<string | null> {
  const result = await run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level'], { timeoutMs: 5_000, env }).catch(failedReading);
  return result === null || result.code !== 0 ? null : result.stdout;
}

export function hostProbe(ctx: Context): HostProbe {
  return {
    cpuTimes() {
      let idle = 0;
      let total = 0;
      for (const cpu of cpus()) {
        const t = cpu.times;
        idle += t.idle;
        total += t.user + t.nice + t.sys + t.idle + t.irq;
      }
      return { idle, total };
    },
    processes: hostProcesses,
    supervisorPid: async (id) => (await readRecord(id, ctx.env)).supervisorPid ?? null,
    memoryPercent: () => hostMemoryPercent(ctx.env),
    instances: async () => (await listInstances(ctx)).length,
  };
}

/** The identity of a process across readings: its pid and start time. */
function processKey(p: ProcessCpu): string {
  return `${String(p.pid)} ${p.start}`;
}

/** The pids of process `root` and its descendants among `processes`. */
export function treePids(processes: readonly ProcessCpu[], root: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const p of processes) {
    const siblings = children.get(p.ppid);
    if (siblings === undefined) children.set(p.ppid, [p.pid]);
    else siblings.push(p.pid);
  }
  const tree = new Set<number>();
  const next = [root];
  for (let pid = next.pop(); pid !== undefined; pid = next.pop()) {
    if (tree.has(pid)) continue;
    tree.add(pid);
    next.push(...(children.get(pid) ?? []));
  }
  return tree;
}

/** The processes of one reading, by `processKey`. */
export type ProcessReading = ReadonlyMap<string, ProcessCpu>;

export function processReading(processes: readonly ProcessCpu[]): ProcessReading {
  return new Map(processes.map((p) => [processKey(p), p]));
}

/**
 * The CPU time in ms that process `root` and its descendants in reading `after` used since reading `before`. Only a
 * process seen in both readings (same pid and start time) counts: the CPU time of a process in the second it started
 * or ended is not counted. 0 without both readings or a root.
 */
export function treeCpuMs(before: ProcessReading | null, after: ProcessReading | null, root: number | null): number {
  if (before === null || after === null || root === null) return 0;
  const tree = treePids([...after.values()], root);
  let used = 0;
  for (const [key, p] of after) {
    const last = before.get(key);
    if (last !== undefined && tree.has(p.pid)) used += Math.max(0, p.cpuMs - last.cpuMs);
  }
  return used;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** One CPU reading: the host counters, and the processes when there is an instance. */
interface CpuReading {
  host: CpuTimes;
  processes: ProcessReading | null;
}

/**
 * ogw.md `### host load`: reads the host every `intervalMs` until `stop`. With `instance`, the CPU time that the
 * supervisor process of that instance and its descendants used is not counted as host CPU use. A failed reading of the
 * processes is a reading without them (`failedReading`); any other error of a reading stops the readings and `stop`
 * throws it (`settle` returns it). The readings end once: a later `stop` or `settle` reads nothing more.
 */
export class HostLoadSampler {
  private readonly probe: HostProbe;
  private readonly instance: string | null;
  private readonly timer: NodeJS.Timeout;
  private last: CpuReading | null = null;
  private root: number | null = null;
  private cpuMax = 0;
  private memoryMax = 0;
  private instancesMax = 0;
  private pending: Promise<void>;
  /** The error that stopped the readings; `stop` throws it. */
  private failure: { error: unknown } | null = null;
  private stopped: Promise<void> | null = null;

  constructor(probe: HostProbe, intervalMs: number, instance: string | null = null) {
    this.probe = probe;
    this.instance = instance;
    this.pending = this.guarded(() => this.readCpu());
    this.timer = setInterval(() => {
      this.pending = this.pending.then(() => this.guarded(() => this.sample()));
    }, intervalMs);
  }

  /** Runs a reading unless one failed; a failure is kept for `stop` (a rejection nobody waits for would end the process). */
  private async guarded(reading: () => Promise<void>): Promise<void> {
    if (this.failure !== null) return;
    try {
      await reading();
    } catch (error) {
      this.failure = { error };
      clearInterval(this.timer);
    }
  }

  /** The supervisor pid of the instance, read until it is known: it stays for the life of the instance. */
  private async supervisor(): Promise<number | null> {
    if (this.instance === null || this.root !== null) return this.root;
    this.root = await this.probe.supervisorPid(this.instance);
    return this.root;
  }

  /** Takes a CPU reading and keeps the maximum of the host CPU use outside the instance since the last one. */
  private async readCpu(): Promise<void> {
    const root = await this.supervisor();
    const processes = root === null ? null : await this.probe.processes().catch(failedReading);
    const now: CpuReading = { host: this.probe.cpuTimes(), processes: processes === null ? null : processReading(processes) };
    const last = this.last;
    this.last = now;
    if (last === null) return;
    const total = now.host.total - last.host.total;
    if (total <= 0) return;
    const used = total - (now.host.idle - last.host.idle);
    // the processes are read just before the host counters, so the instance share can pass the host use by a little
    const outside = Math.max(used - treeCpuMs(last.processes, now.processes, root), 0);
    this.cpuMax = Math.max(this.cpuMax, (outside / total) * 100);
  }

  private async sample(): Promise<void> {
    await this.readCpu();
    this.memoryMax = Math.max(this.memoryMax, await this.probe.memoryPercent());
    const instances = await this.probe.instances();
    this.instancesMax = Math.max(this.instancesMax, instances);
  }

  /** Ends the readings after a last one; once, however often it is called. */
  private halt(): Promise<void> {
    this.stopped ??= (async (): Promise<void> => {
      clearInterval(this.timer);
      await this.pending;
      await this.guarded(() => this.sample());
    })();
    return this.stopped;
  }

  /** Takes a last reading and returns the maxima; throws the error that stopped the readings. */
  async stop(): Promise<HostLoad> {
    const { hostLoad, error } = await this.settle();
    if (error !== null) throw error.value;
    return hostLoad;
  }

  /**
   * Ends the readings as `stop` does and returns the maxima of the readings taken, with the error that stopped them
   * (null when none did) instead of throwing it.
   */
  async settle(): Promise<{ hostLoad: HostLoad; error: { value: unknown } | null }> {
    await this.halt();
    const hostLoad = { cpuMaxPercent: round(this.cpuMax), memoryMaxPercent: round(this.memoryMax), instancesMax: this.instancesMax };
    return { hostLoad, error: this.failure === null ? null : { value: this.failure.error } };
  }
}
