import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { JobNotFound, listJobs, type JobRecord } from '../../../lib/jobs.ts';
import { jobsOfRun, listRuns, type RunState } from '../../../lib/runstate.ts';
import { criticalPath, flagsOf, largestSelf, waitTotals, type PathEntry, type Sample, type TimeCriteria, type TimeFlag } from './analyze.ts';
import { jobSpanName, jobTree, spansOf, timeSource, type TimeSource, type TimeSpan } from './tree.ts';

/** How many spans `largest self time` lists. */
export const SELF_TIME_COUNT = 10;

/** What `ogw time` prints for a tree (ogw.md `## time`). */
export interface TimeReport {
  root: TimeSpan;
  path: PathEntry[];
  self: { span: TimeSpan; ms: number }[];
  waits: { on: string; ms: number; count: number }[];
  flags: TimeFlag[];
  criteria: TimeCriteria;
}

/**
 * The finished spans of each name of the jobs of `game` on this host, in end order: the job spans of the jobs that
 * ended `done`, and the step spans that ended without failing.
 */
async function samplesOf(source: TimeSource, game: string | null): Promise<Map<string, Sample[]>> {
  const samples = new Map<string, Sample[]>();
  const add = (name: string, start: number, end: number): void => {
    const list = samples.get(name) ?? [];
    list.push({ end, ms: end - start });
    samples.set(name, list);
  };
  for (const job of source.records.values()) {
    if (job.game !== game) continue;
    if (job.status === 'done' && job.endedAt !== null) add(jobSpanName(job), job.startedAt, job.endedAt);
    for (const line of (await source.spans(job.id)).values()) {
      if ('name' in line && line.end !== null && line.failed !== true) add(line.name, line.start, line.end);
    }
  }
  for (const list of samples.values()) list.sort((a, b) => a.end - b.end);
  return samples;
}

async function reportOf(source: TimeSource, root: TimeSpan, criteria: TimeCriteria): Promise<TimeReport> {
  const games = [...new Set(spansOf(root).filter((span) => span.kind !== 'run').map((span) => span.game))];
  const byGame = new Map<string | null, Map<string, Sample[]>>();
  for (const game of games) byGame.set(game, await samplesOf(source, game));
  const history = (span: TimeSpan): readonly Sample[] => byGame.get(span.game)?.get(span.name) ?? [];
  return {
    root,
    path: criticalPath(root),
    self: largestSelf(root, SELF_TIME_COUNT),
    waits: waitTotals(spansOf(root)),
    flags: flagsOf(root, history, criteria),
    criteria,
  };
}

/** The time report of job `id`: its tree with the jobs it started. */
export async function jobReport(ctx: Context, id: string): Promise<TimeReport> {
  const records = await listJobs(ctx.env);
  const job = records.find((record) => record.id === id);
  if (job === undefined) throw new JobNotFound(`job not found: ${id}`);
  const source = timeSource(records, ctx.env);
  return reportOf(source, await jobTree(source, job), (await ctx.settings()).time);
}

/** The start of iteration `n` of a run: the start of its first `ogw agent` job of that iteration; null when none. */
function iterationStart(jobs: readonly JobRecord[], run: RunState, n: number): number | null {
  const starts = jobs.filter((job) => job.command === 'agent' && job.meta.run === run.name && job.meta.iteration === n).map((job) => job.startedAt);
  return starts.length === 0 ? null : Math.min(...starts);
}

/**
 * The window of a run, or of iteration `n` of it: to the start of the next iteration, else the close of the run, else
 * now (`open`).
 */
function windowOf(jobs: readonly JobRecord[], run: RunState, n: number | null, now: number): { start: number; end: number; open: boolean } {
  const close = run.closedAt ?? now;
  const open = run.closedAt === null;
  if (n === null) return { start: run.startedAt, end: close, open };
  const start = iterationStart(jobs, run, n);
  if (start === null) throw new OgwError(`iteration ${String(n)} of run ${run.name} has no ogw agent job`);
  const later = jobs
    .filter((job) => job.command === 'agent' && job.meta.run === run.name && typeof job.meta.iteration === 'number' && job.meta.iteration > n)
    .map((job) => job.startedAt);
  return later.length === 0 ? { start, end: close, open } : { start, end: Math.min(...later), open: false };
}

/**
 * The time report of a run of `game`, or of iteration `iteration` of it: a run span over the window, holding the trees
 * of the jobs of the run that started in the window and that no job of them started.
 */
export async function runReport(ctx: Context, game: string, runName: string, iteration: number | null): Promise<TimeReport> {
  const repo = await ctx.game(game);
  const run = (await listRuns(repo)).find((r) => r.name === runName);
  if (run === undefined) throw new OgwError(`no run ${runName} in game ${repo.name}`);
  const records = await listJobs(ctx.env);
  const source = timeSource(records, ctx.env);
  const window = windowOf(records, run, iteration, source.now);
  const jobs = jobsOfRun(run, records, repo.name).filter((job) => job.startedAt >= window.start && job.startedAt < window.end);
  const ids = new Set(jobs.map((job) => job.id));
  const seen = new Set<string>();
  const children: TimeSpan[] = [];
  for (const job of jobs.filter((j) => typeof j.parentJob !== 'string' || !ids.has(j.parentJob))) {
    if (!seen.has(job.id)) children.push(await jobTree(source, job, seen));
  }
  const root: TimeSpan = {
    key: `run ${run.name}`,
    kind: 'run',
    job: '',
    game: repo.name,
    name: iteration === null ? `run ${run.name}` : `run ${run.name} iteration ${String(iteration)}`,
    start: window.start,
    end: window.end,
    open: window.open,
    failed: false,
    children,
    waits: [],
  };
  return reportOf(source, root, (await ctx.settings()).time);
}
