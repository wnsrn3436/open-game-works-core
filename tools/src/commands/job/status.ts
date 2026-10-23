import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { readJob, type JobRecord } from '../../lib/jobs.ts';

const MODULE_RESULTS: readonly string[] = ['pass', 'fail', 'skipped'];

/** Per-module results a `ogw core test` job keeps in `meta.modules`; null for any other job. */
function moduleResults(job: JobRecord): Record<string, string> | null {
  if (job.command !== 'core test') return null;
  const modules = job.meta.modules;
  if (typeof modules !== 'object' || modules === null || Array.isArray(modules)) return null;
  const results: Record<string, string> = {};
  for (const [name, result] of Object.entries(modules)) {
    if (typeof result === 'string' && MODULE_RESULTS.includes(result)) results[name] = result;
  }
  return results;
}

export const status: CommandDef = {
  name: ['job', 'status'],
  usage: 'ogw job status <id>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const job = await readJob(positional(args, 0, 'job id'), ctx.env);
    const modules = moduleResults(job);
    const lines: string[] = [job.status];
    if (modules) for (const [name, result] of Object.entries(modules)) lines.push(`${name} ${result}`);
    return { text: lines.join('\n'), data: { id: job.id, status: job.status, exitCode: job.exitCode, modules } };
  },
};
