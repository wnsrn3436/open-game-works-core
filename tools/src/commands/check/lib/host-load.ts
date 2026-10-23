import { cpus, freemem, totalmem } from 'node:os';
import type { Context } from '../../../lib/command.ts';
import { listInstances } from '../../instance/api.ts';
import type { HostLoad } from '../api.ts';

/** CPU time counters of the whole host. */
export interface CpuTimes {
  idle: number;
  total: number;
}

export interface HostProbe {
  cpuTimes(): CpuTimes;
  /** Memory use of the host in %. */
  memoryPercent(): number;
  /** Instances the runner has started and not stopped. */
  instances(): Promise<number>;
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
    memoryPercent: () => (1 - freemem() / totalmem()) * 100,
    instances: async () => (await listInstances(ctx)).length,
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** `performance` `## host load`: reads the host every `intervalMs` until `stop`. */
export class HostLoadSampler {
  private readonly probe: HostProbe;
  private readonly timer: NodeJS.Timeout;
  private last: CpuTimes;
  private cpuMax = 0;
  private memoryMax = 0;
  private instancesMax = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(probe: HostProbe, intervalMs: number) {
    this.probe = probe;
    this.last = probe.cpuTimes();
    this.timer = setInterval(() => {
      this.pending = this.pending.then(() => this.sample());
    }, intervalMs);
  }

  private async sample(): Promise<void> {
    const now = this.probe.cpuTimes();
    const total = now.total - this.last.total;
    if (total > 0) this.cpuMax = Math.max(this.cpuMax, (1 - (now.idle - this.last.idle) / total) * 100);
    this.last = now;
    this.memoryMax = Math.max(this.memoryMax, this.probe.memoryPercent());
    const instances = await this.probe.instances().catch(() => 0);
    this.instancesMax = Math.max(this.instancesMax, instances);
  }

  /** Takes a last reading and returns the maxima. */
  async stop(): Promise<HostLoad> {
    clearInterval(this.timer);
    await this.pending;
    await this.sample();
    return { cpuMaxPercent: round(this.cpuMax), memoryMaxPercent: round(this.memoryMax), instancesMax: this.instancesMax };
  }
}
