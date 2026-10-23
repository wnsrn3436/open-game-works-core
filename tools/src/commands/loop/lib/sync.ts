import { setTimeout as sleep } from 'node:timers/promises';
import type { Context } from '../../../lib/command.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { git, head } from '../../../lib/git.ts';
import { waitJob, type JobRecord } from '../../../lib/jobs.ts';
import { changeOpenRun, requireOpenRun, type RunState } from '../../../lib/runstate.ts';
import { agentOutcome, mergeAgentJobs, retryAgentJob, startAgentJob } from '../../agent/api.ts';
import { agentJobsOf, failWhenContentRunning, inputOf, roleOf, runJobs } from './jobs.ts';
import { loopData, type LoopData, type TaskState } from './run.ts';

export const WORKER_ROLES = ['resource', 'translation'] as const;

export const syncDeps = { pollMs: 5000 };

export interface SyncResult {
  merged: string[];
  given: { from: string; job: string; input: string }[];
  gaveUp: { input: string; lastFailure: string }[];
  /** Done jobs whose merge failed for a reason other than a conflict or a `ogw data` failure; left unhandled. */
  failed: { job: string; failure: string }[];
}

/** The first input of a task: a retry input `<name>-retry-<n>.md` belongs to `<name>.md`. */
export function taskInput(input: string): string {
  return input.replace(/-retry-\d+(\.[^./\\]+)$/, '$1');
}

function taskOf(data: LoopData, job: JobRecord): TaskState {
  const found = data.tasks.find((task) => task.jobs.includes(job.id));
  if (found) return found;
  const input = taskInput(inputOf(job) ?? job.id);
  const byInput = data.tasks.find((task) => task.input === input);
  if (byInput) {
    byInput.jobs.push(job.id);
    return byInput;
  }
  const task: TaskState = {
    role: roleOf(job) === 'translation' ? 'translation' : 'resource',
    input,
    jobs: [job.id],
    retries: 0,
    gaveUp: false,
    lastFailure: null,
  };
  data.tasks.push(task);
  return task;
}

/** Why an ended job gave no result: a `done` job ended without a result file, any other job failed. */
async function failureText(ctx: Context, job: JobRecord): Promise<string> {
  const ended = await waitJob(job.id, 0, ctx.env);
  const lastLine = `${ended.stderr}\n${ended.stdout}`.split('\n').map((l) => l.trim()).filter((l) => l !== '').pop();
  const what = ended.job.status === 'done' ? `job ${job.id} ended without a result file` : `job ${job.id} failed (exit ${String(ended.job.exitCode)})`;
  return lastLine ? `${what}: ${lastLine}` : what;
}

interface Step {
  merge?: { job: string; role: 'resource' | 'translation'; before: string; after: string };
  start?: string;
  failure?: string;
  /** The job stays unhandled: its merge failed for a reason a new job does not fix. */
  unhandled?: boolean;
}

/** Reasons of a failed `ogw agent merge` that `ogw loop sync` gives to a new job with the same input. */
const REDO_REASONS = ['conflict', 'data'];

/** A merge failure on one line: the reason and the detail (conflicting paths, `ogw data` ERROR lines). */
export function mergeFailureText(id: string, reason: string, detail: string): string {
  const lines = detail.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return `merge of job ${id} failed: ${reason}${lines.length > 0 ? `: ${lines.join('; ')}` : ''}`;
}

/** The merge commit `ogw agent merge <id>` made on the checkout branch: its first parent and itself. */
async function earlierMerge(ctx: Context, game: GameRepo, job: JobRecord, role: 'resource' | 'translation'): Promise<Step['merge'] | null> {
  const line = (await git(game.root, ['log', '-n', '1', '--format=%H %P', `--grep=^ogw agent merge ${job.id}$`, 'HEAD'], { env: ctx.env })).trim();
  const [after, before] = line.split(' ');
  return after !== undefined && before !== undefined && after !== '' ? { job: job.id, role, before, after } : null;
}

/**
 * Merges a done job. On a conflict or a `ogw data` failure starts the same role with the same input; a job merged
 * before is recorded as merged; any other failure leaves the job unhandled.
 */
async function mergeOrRedo(ctx: Context, game: GameRepo, job: JobRecord, task: TaskState, limit: number): Promise<Step> {
  const before = await head(game.root, { env: ctx.env });
  const outcome = await mergeAgentJobs(ctx, [job.id]);
  if (outcome.merged.includes(job.id)) return { merge: { job: job.id, role: task.role, before, after: await head(game.root, { env: ctx.env }) } };
  const failed = outcome.failed.find((f) => f.id === job.id) ?? { id: job.id, reason: 'not merged', detail: '' };
  if (failed.reason === 'already merged') {
    const merge = await earlierMerge(ctx, game, job, task.role);
    if (merge) return { merge };
  }
  const failure = mergeFailureText(job.id, failed.reason, failed.detail);
  if (!REDO_REASONS.includes(failed.reason)) return { failure, unhandled: true };
  if (task.retries >= limit) return { failure };
  const input = inputOf(job) ?? task.input;
  return { start: await startAgentJob(ctx, { role: task.role, game: game.name, input }), failure };
}

async function handle(ctx: Context, game: GameRepo, job: JobRecord, task: TaskState, limit: number): Promise<Step | null> {
  const outcome = await agentOutcome(ctx, job.id);
  if (outcome.status === 'running') return null;
  if (outcome.status === 'done' && outcome.output !== null) return mergeOrRedo(ctx, game, job, task, limit);
  const failure = await failureText(ctx, job);
  if (task.retries >= limit) return { failure };
  return { start: await retryAgentJob(ctx, job.id), failure };
}

function apply(run: RunState, job: JobRecord, step: Step, result: SyncResult): void {
  const data = loopData(run);
  const task = taskOf(data, job);
  data.handled.push(job.id);
  if (step.merge) {
    data.merges.push(step.merge);
    result.merged.push(job.id);
    return;
  }
  task.lastFailure = step.failure ?? null;
  if (step.start) {
    task.retries++;
    task.jobs.push(step.start);
    result.given.push({ from: job.id, job: step.start, input: task.input });
  } else {
    task.gaveUp = true;
    result.gaveUp.push({ input: task.input, lastFailure: task.lastFailure ?? '' });
  }
}

/**
 * One pass over the resource and translation jobs of the run. Returns whether a worker job still runs.
 * `unhandled` holds the jobs whose merge failed earlier in this sync; they are not tried again.
 */
export async function syncOnce(ctx: Context, game: GameRepo, result: SyncResult, unhandled: Set<string>): Promise<boolean> {
  const limit = (await ctx.settings()).backgroundRetryLimit;
  const jobs = await runJobs(ctx, game, await requireOpenRun(game));
  failWhenContentRunning(jobs);
  let running = false;
  for (const job of agentJobsOf(jobs, WORKER_ROLES)) {
    const data = loopData(await requireOpenRun(game));
    if (data.handled.includes(job.id) || unhandled.has(job.id)) continue;
    const task = taskOf(data, job);
    const step = await handle(ctx, game, job, task, limit);
    if (step === null) {
      running = true;
      continue;
    }
    if (step.unhandled === true) {
      const failure = step.failure ?? '';
      unhandled.add(job.id);
      result.failed.push({ job: job.id, failure });
      await changeOpenRun(game, (open) => {
        const stuck = loopData(open).stuck;
        stuck.splice(0, stuck.length, ...stuck.filter((s) => s.job !== job.id), { job: job.id, failure });
      });
      continue;
    }
    if (step.start) running = true;
    await changeOpenRun(game, (open) => {
      apply(open, job, step, result);
      const stuck = loopData(open).stuck;
      stuck.splice(0, stuck.length, ...stuck.filter((s) => s.job !== job.id));
    });
  }
  return running;
}

export async function sync(ctx: Context, game: GameRepo, wait: boolean): Promise<SyncResult> {
  const result: SyncResult = { merged: [], given: [], gaveUp: [], failed: [] };
  const unhandled = new Set<string>();
  while ((await syncOnce(ctx, game, result, unhandled)) && wait) await sleep(syncDeps.pollMs);
  return result;
}

export function syncText(result: SyncResult): string {
  const lines = [
    ...result.merged.map((id) => `merged ${id}`),
    ...result.given.map((g) => `given again ${g.from} -> ${g.job} ${g.input}`),
    ...result.gaveUp.map((g) => `not given again ${g.input}: ${g.lastFailure}`),
    ...result.failed.map((f) => `not merged ${f.job}: ${f.failure}`),
  ];
  return lines.length > 0 ? lines.join('\n') : 'nothing to sync';
}
