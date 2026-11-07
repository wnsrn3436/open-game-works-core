import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { takeWaits, taking } from '../../../lib/spans.ts';
import { whenNotFound } from '../../../lib/fsx.ts';
import { listInstances, startInstance, stopInstance, type InstanceInfo, type InstanceOptions } from '../../instance/api.ts';
import { instanceFolder, readRecord } from '../../instance/lib/records.ts';
import { writeEvidence, type Evidence } from './evidence.ts';

/** The name of a wait for a free instance slot of a check (ogw.md `## time`). */
export const CHECK_SLOTS = 'check instance slots';

/**
 * At most `size` holders at a time; the rest wait in order. A spare holder (`spare`) takes only a slot that is free
 * while no holder waits, and is told when a holder comes to wait, so that it gives the slot back.
 */
export class Slots {
  private free: number;
  private readonly waiting: (() => void)[] = [];
  /** What each spare holder is told once when an `acquire` has to wait. */
  private readonly spares = new Set<() => void>();
  /** Called each time a slot becomes free while no holder waits. */
  private readonly watchers = new Set<() => void>();

  constructor(size: number) {
    this.free = size;
  }

  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    const told = [...this.spares];
    this.spares.clear();
    for (const tell of told) tell();
    await taking(CHECK_SLOTS, () => {
      takeWaits();
      return new Promise<void>((resolve) => this.waiting.push(resolve));
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.free++;
    for (const watcher of [...this.watchers]) watcher();
  }

  /**
   * Takes a slot that is free now, without waiting, and returns the function that frees it; null when none is free (a
   * free slot means that no holder waits). `wanted` is called once when, while it is held, an `acquire` has to wait.
   */
  spare(wanted: () => void): (() => void) | null {
    if (this.free === 0) return null;
    this.free--;
    this.spares.add(wanted);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.spares.delete(wanted);
      this.release();
    };
  }

  /** Whether an `acquire` waits now. */
  get contended(): boolean {
    return this.waiting.length > 0;
  }

  /** Calls `watcher` each time a slot becomes free while no holder waits, until the returned function is called. */
  watch(watcher: () => void): () => void {
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  }
}

/** macOS crash reports of the engine: `~/Library/Logs/DiagnosticReports/Godot*.ips`. */
const CRASH_REPORT = /^Godot.*\.ips$/;

/** The `pid` of a macOS crash report (`.ips`: a JSON header line, then a JSON body with `"pid"`); null when it has none. */
export function crashReportPid(text: string): number | null {
  const match = /"pid"\s*:\s*(\d+)/.exec(text);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Keeps the logs of an instance (the `*.log` files of its folder) and the engine crash reports of its client
 * processes (a `.ips` whose `pid` is one of them) as evidence in `instance-<id>/`, before the instance and its folder go
 * away. Returns the evidence paths.
 */
export async function keepInstanceLogs(ctx: Context, id: string, evidence: Evidence): Promise<string[]> {
  if (evidence.dir === null) return [];
  const kept: string[] = [];
  const folder = await instanceFolder(id, ctx.env);
  for (const name of (await readdir(folder).catch(whenNotFound([] as string[]))).filter((n) => n.endsWith('.log')).sort()) {
    const path = await writeEvidence(evidence, `instance-${id}/${name}`, await readFile(join(folder, name)));
    if (path !== null) kept.push(path);
  }
  if (process.platform !== 'darwin') return kept;
  const record = await readRecord(id, ctx.env);
  const clients = new Set(Object.entries(record.pids).filter(([name]) => name !== 'server').map(([, pid]) => pid));
  if (clients.size === 0) return kept;
  const reports = join(ctx.env.HOME ?? homedir(), 'Library', 'Logs', 'DiagnosticReports');
  for (const name of (await readdir(reports).catch(whenNotFound([] as string[]))).filter((n) => CRASH_REPORT.test(n)).sort()) {
    const file = join(reports, name);
    if ((await stat(file)).mtimeMs < record.startedAt) continue;
    const text = await readFile(file);
    const pid = crashReportPid(text.toString('utf8'));
    if (pid === null || !clients.has(pid)) continue;
    const path = await writeEvidence(evidence, `instance-${id}/${name}`, text);
    if (path !== null) kept.push(path);
  }
  return kept;
}

/** Whether a client process of the running instance has ended. */
async function clientEnded(ctx: Context, instance: InstanceInfo): Promise<boolean> {
  const current = (await listInstances(ctx, { game: instance.game })).find((i) => i.id === instance.id);
  return current !== undefined && Object.keys(current.exited).some((name) => name !== 'server');
}

/**
 * Starts an instance within the slots, runs `work` on it, and always stops it and frees the slot. With `evidence`, when
 * the start fails, `work` throws or a client process of the instance has ended, keeps the instance logs first
 * (`keepInstanceLogs`).
 */
export async function withInstance<T>(
  ctx: Context,
  slots: Slots,
  options: InstanceOptions,
  work: (instance: InstanceInfo) => Promise<T>,
  evidence?: Evidence,
): Promise<T> {
  await slots.acquire();
  try {
    return await onInstance(ctx, options, work, evidence);
  } finally {
    slots.release();
  }
}

/**
 * {@link withInstance} for a caller that already holds its slot (a spare slot of `Slots.spare`). Once `signal` is
 * aborted, a start that has not ended stops and fails.
 */
export async function onInstance<T>(
  ctx: Context,
  options: InstanceOptions,
  work: (instance: InstanceInfo) => Promise<T>,
  evidence?: Evidence,
  signal?: AbortSignal,
): Promise<T> {
  const keep = async (id: string): Promise<void> => {
    if (evidence === undefined) return;
    await keepInstanceLogs(ctx, id, evidence).catch((error: unknown) => {
      ctx.log(`cannot keep the logs of instance ${id}: ${(error as Error).message}`);
    });
  };
  const instance = await startInstance(ctx, options, signal === undefined ? { beforeFailedStop: keep } : { beforeFailedStop: keep, signal });
  let failed = false;
  try {
    return await work(instance);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // when whether a client ended cannot be read, the instance is stopped all the same and then that error is thrown
    const ended: { value: boolean; error?: unknown } =
      failed || evidence === undefined
        ? { value: failed }
        : await clientEnded(ctx, instance).then(
            (value) => ({ value }),
            (error: unknown) => ({ value: false, error }),
          );
    if (ended.value) await keep(instance.id);
    await stopInstance(ctx, instance.id).catch((error: unknown) => {
      ctx.log(`cannot stop instance ${instance.id}: ${(error as Error).message}`);
    });
    if ('error' in ended) throw ended.error;
  }
}
