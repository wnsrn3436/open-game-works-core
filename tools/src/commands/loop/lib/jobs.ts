import { resolve } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { listJobs, type JobRecord } from '../../../lib/jobs.ts';
import { jobsOfRun, type RunState } from '../../../lib/runstate.ts';

/** Jobs of the game started while the run is open. */
export async function runJobs(ctx: Context, game: GameRepo, run: RunState): Promise<JobRecord[]> {
  return jobsOfRun(run, await listJobs(ctx.env), game.name);
}

export function isAgentJob(job: JobRecord): boolean {
  return job.command === 'agent';
}

export function roleOf(job: JobRecord): string | null {
  const role = job.meta.role;
  return isAgentJob(job) && typeof role === 'string' ? role : null;
}

/** Absolute path of the input file of an agent job. */
export function inputOf(job: JobRecord): string | null {
  const input = job.meta.input;
  return typeof input === 'string' ? resolve(job.cwd, input) : null;
}

export function outputOf(job: JobRecord): string | null {
  const output = job.meta.output;
  return typeof output === 'string' ? output : null;
}

export function agentJobsOf(jobs: readonly JobRecord[], roles: readonly string[]): JobRecord[] {
  return jobs.filter((job) => roles.includes(roleOf(job) ?? ''));
}

/** `ogw loop dispatch` and `ogw loop sync` do nothing while the content agent of the run works. */
export function failWhenContentRunning(jobs: readonly JobRecord[]): void {
  const running = agentJobsOf(jobs, ['content']).find((job) => job.status === 'running');
  if (running) throw new OgwError(`content agent job ${running.id} is running`);
}
