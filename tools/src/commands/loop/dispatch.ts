import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expectPositionals, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { writeFileAtomic } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { commitPaths } from '../../lib/git.ts';
import type { JobRecord } from '../../lib/jobs.ts';
import type { RunState } from '../../lib/runstate.ts';
import { startAgentJob } from '../agent/api.ts';
import { placeholderFailures } from '../check/api.ts';
import { isRequestFileName, requestPendingResources, requestPlace } from '../resource/api.ts';
import { agentJobsOf, failWhenContentRunning, inputOf, runJobs } from './lib/jobs.ts';
import { abs, loopData, openTarget, runRel } from './lib/run.ts';

const USAGE = 'ogw loop dispatch <game>';

/**
 * Resource request files of the run: loop run `records/loops/<run>/resource-requests/<unix ms>.md`, build run
 * `records/hardening/<env>-<version>-resource-<unix ms>.md`.
 */
async function requestFiles(game: GameRepo, run: RunState): Promise<string[]> {
  const place = requestPlace(run);
  const dir = join(game.root, place.dir);
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .filter((n) => isRequestFileName(place, n))
    .sort()
    .map((n) => join(dir, n));
}

/** Languages with a `translation_missing` or `translation_stale` failure, in first-seen order. */
export function translationLanguages(messages: readonly string[]): string[] {
  const languages: string[] = [];
  for (const message of messages) {
    const language = /^translation_(?:missing|stale) (\S+)/.exec(message)?.[1];
    if (language !== undefined && !languages.includes(language)) languages.push(language);
  }
  return languages;
}

interface Started {
  job: string;
  role: 'resource' | 'translation';
  input: string;
}

async function startResources(ctx: Context, game: GameRepo, run: RunState, jobs: readonly JobRecord[]): Promise<Started[]> {
  const used = new Set(agentJobsOf(jobs, ['resource']).map(inputOf));
  const started: Started[] = [];
  for (const file of await requestFiles(game, run)) {
    if (used.has(file)) continue;
    started.push({ job: await startAgentJob(ctx, { role: 'resource', game: game.name, input: file }), role: 'resource', input: file });
  }
  return started;
}

/**
 * Languages that have a translation task in the run not merged by `ogw loop sync`: a job sync has not handled,
 * or a task sync gave up.
 */
export function unmergedLanguages(run: RunState, jobs: readonly JobRecord[]): Set<string> {
  const data = loopData(run);
  const merged = new Set(data.merges.map((m) => m.job));
  const gaveUp = new Set(data.tasks.filter((t) => t.gaveUp).flatMap((t) => t.jobs));
  const languages = new Set<string>();
  for (const job of agentJobsOf(jobs, ['translation'])) {
    const language = job.meta.language;
    if (typeof language !== 'string' || merged.has(job.id) || job.meta.merged === true) continue;
    if (!data.handled.includes(job.id) || gaveUp.has(job.id)) languages.add(language);
  }
  return languages;
}

async function startTranslations(ctx: Context, game: GameRepo, run: RunState, jobs: readonly JobRecord[]): Promise<Started[]> {
  const failures = await placeholderFailures(ctx, game);
  const busy = unmergedLanguages(run, jobs);
  const started: Started[] = [];
  for (const language of translationLanguages(failures.map((f) => f.message))) {
    if (busy.has(language)) continue;
    const rel = runRel(run, `translation-input-${language}-${String(Date.now())}.md`);
    await writeFileAtomic(abs(game, rel), `${language}\n`);
    await commitPaths(game.root, [rel], `loop ${run.name}: translation input ${language}`, { env: ctx.env });
    const input = abs(game, rel);
    started.push({ job: await startAgentJob(ctx, { role: 'translation', game: game.name, input }), role: 'translation', input });
  }
  return started;
}

export const loopDispatch: CommandDef = {
  name: ['loop', 'dispatch'],
  usage: USAGE,
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const { game, run } = await openTarget(ctx, positional(args, 0, 'game'));
    failWhenContentRunning(await runJobs(ctx, game, run));
    await requestPendingResources(ctx, game);
    const jobs = await runJobs(ctx, game, run);
    const started = [...(await startResources(ctx, game, run, jobs)), ...(await startTranslations(ctx, game, run, jobs))];
    return {
      text: started.length > 0 ? started.map((s) => `${s.job} ${s.role} ${s.input}`).join('\n') : 'nothing to dispatch',
      data: { started },
    };
  },
};
