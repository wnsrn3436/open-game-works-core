/**
 * The job of the seed agent (ogw.md `### seed agent` of `## regress`): started in the folder the refresh made, waited
 * for, and its logs removed once read, since they hold the seed.
 */
import { rm } from 'node:fs/promises';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { jobLogPaths, readJob, waitJob } from '../../../lib/jobs.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { agentOutcome, startAgentJob } from '../../agent/api.ts';
import type { AgentSession } from '../../agent/lib/cli-command.ts';
import { agentCliLog } from '../../agent/lib/meta.ts';

/** What the seed agent job gave: its result file, or why it gave none, and the session it ran in. */
export interface SeedAgentRun {
  job: string | null;
  status: 'done' | 'failed';
  output: string | null;
  reason: string | null;
  /** The session of the job (ogw.md `## agent`), which the next round continues; null without one. */
  session: string | null;
}

/** Removes the agent CLI output and the stdout and stderr of job `id` from `agent-logs/` of the jobs folder. */
async function removeJobLogs(ctx: Context, id: string): Promise<void> {
  const logs = await jobLogPaths(await readJob(id, ctx.env), ctx.env);
  for (const path of [await agentCliLog(id, ctx.env), logs.stdout, logs.stderr]) await rm(path, { force: true });
}

/**
 * Starts the seed agent with `input` in `folder`, continuing the session `session` of the round before when it is not
 * null, and waits for it (`### seed agent` 2 and 5). A job that could not start or did not end `done` gives the reason:
 * the `failed:` line it printed, not the tail of its CLI output, which holds the seed. Its logs are removed when it has
 * ended.
 */
export async function runSeedAgent(ctx: Context, folder: string, input: string, session: string | null = null): Promise<SeedAgentRun> {
  let job: string;
  try {
    job = await startAgentJob(ctx, { role: 'seed', input, seedPlace: folder, ...(session === null ? {} : { seedSession: session }) });
  } catch (error) {
    if (!(error instanceof OgwError)) throw error;
    return { job: null, status: 'failed', output: null, reason: error.message, session: null };
  }
  try {
    for (;;) {
      const waited = await waitJob(job, LIMITS.jobMs, ctx.env);
      if (!waited.finished) continue;
      const kept = ((waited.job.meta.session ?? null) as AgentSession | null)?.id ?? null;
      const outcome = await agentOutcome(ctx, job);
      if (outcome.status === 'done' && outcome.output !== null) return { job, status: 'done', output: outcome.output, reason: null, session: kept };
      const reason = /^failed: (.*)$/m.exec(waited.stdout)?.[1] ?? `the job ended ${waited.job.status} without a result file`;
      return { job, status: 'failed', output: null, reason, session: kept };
    }
  } finally {
    await removeJobLogs(ctx, job);
  }
}
