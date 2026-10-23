import type { CommandResult } from '../../../lib/command.ts';
import { EXIT_STILL_RUNNING } from '../../../lib/errors.ts';
import { readJob, waitJob, type JobStatus } from '../../../lib/jobs.ts';
import { agentMeta, resultFile } from './meta.ts';

export interface Outcome {
  status: JobStatus;
  /** The result file when the agent left it. */
  output: string | null;
}

/** Status of an agent job: `failed` also when it ended without a result file. */
export async function outcomeOf(id: string, env: NodeJS.ProcessEnv): Promise<Outcome> {
  const job = await readJob(id, env);
  const output = resultFile(agentMeta(job));
  if (job.status === 'done' && output === null) return { status: 'failed', output: null };
  return { status: job.status, output };
}

/** `ogw agent wait <id>`: the result file path, `running` on timeout, or `failed` with what the job printed. */
export async function agentWait(id: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  const waited = await waitJob(id, timeoutMs, env);
  if (!waited.finished) return { exitCode: EXIT_STILL_RUNNING, text: 'running', data: { status: 'running' } };
  const output = resultFile(agentMeta(waited.job));
  if (waited.job.status === 'done' && output !== null) return { text: output, data: { status: 'done', output } };
  const text = ['failed', waited.stdout.trim(), waited.stderr.trim()].filter((part) => part !== '').join('\n');
  const exitCode = waited.job.exitCode === null || waited.job.exitCode === 0 ? 1 : waited.job.exitCode;
  return { exitCode, text, data: { status: 'failed', output, stdout: waited.stdout, stderr: waited.stderr } };
}
