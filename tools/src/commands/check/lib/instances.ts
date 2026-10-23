import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { listInstances, startInstance, stopInstance, type InstanceInfo, type InstanceOptions } from '../../instance/api.ts';
import { instanceFolder, readRecord } from '../../instance/lib/records.ts';
import { writeEvidence, type Evidence } from './evidence.ts';

/** At most `size` holders at a time; the rest wait in order. */
export class Slots {
  private free: number;
  private readonly waiting: (() => void)[] = [];

  constructor(size: number) {
    this.free = size;
  }

  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.free++;
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
  for (const name of (await readdir(folder).catch(() => [] as string[])).filter((n) => n.endsWith('.log')).sort()) {
    const path = await writeEvidence(evidence, `instance-${id}/${name}`, await readFile(join(folder, name)));
    if (path !== null) kept.push(path);
  }
  if (process.platform !== 'darwin') return kept;
  const record = await readRecord(id, ctx.env).catch(() => null);
  const clients = new Set(Object.entries(record?.pids ?? {}).filter(([name]) => name !== 'server').map(([, pid]) => pid));
  if (clients.size === 0) return kept;
  const reports = join(ctx.env.HOME ?? homedir(), 'Library', 'Logs', 'DiagnosticReports');
  for (const name of (await readdir(reports).catch(() => [] as string[])).filter((n) => CRASH_REPORT.test(n)).sort()) {
    const file = join(reports, name);
    if (record !== null && (await stat(file)).mtimeMs < record.startedAt) continue;
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
  const keep = async (id: string): Promise<void> => {
    if (evidence === undefined) return;
    await keepInstanceLogs(ctx, id, evidence).catch((error: unknown) => {
      ctx.log(`cannot keep the logs of instance ${id}: ${(error as Error).message}`);
    });
  };
  await slots.acquire();
  try {
    const instance = await startInstance(ctx, options, { beforeFailedStop: keep });
    let failed = false;
    try {
      return await work(instance);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (failed || (evidence !== undefined && (await clientEnded(ctx, instance).catch(() => false)))) await keep(instance.id);
      await stopInstance(ctx, instance.id).catch((error: unknown) => {
        ctx.log(`cannot stop instance ${instance.id}: ${(error as Error).message}`);
      });
    }
  } finally {
    slots.release();
  }
}
