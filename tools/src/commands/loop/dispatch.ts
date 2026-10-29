import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectPositionals, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { writeFileAtomic } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { commitPaths } from '../../lib/git.ts';
import type { JobRecord } from '../../lib/jobs.ts';
import type { RunState } from '../../lib/runstate.ts';
import { startAgentJob } from '../agent/api.ts';
import { placeholderFailures } from '../check/api.ts';
import { blockingMethods, installMethodJob } from '../generation/api.ts';
import { isRequestFileName, leftOutLine, requestFileKeys, requestPendingResources, requestPlace } from '../resource/api.ts';
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

/** A request file not given to a resource sub-agent because methods its keys need are not installed on this host. */
interface Held {
  input: string;
  methods: string[];
}

/** An `ogw generation install` job a held request file waits for. */
interface Install {
  job: string;
  method: string;
}

/** The methods not installed on this host that some key of the request file needs (`blockingMethods`), in first-seen order. */
async function heldBy(ctx: Context, game: GameRepo, file: string): Promise<string[]> {
  const methods: string[] = [];
  for (const key of requestFileKeys(await readFile(file, 'utf8'))) {
    for (const method of await blockingMethods(ctx, game, key)) if (!methods.includes(method)) methods.push(method);
  }
  return methods;
}

/**
 * Starts a resource job per request file never given to one, except a file held by methods not installed on this host:
 * a sub-agent would make none of its keys, and each such run counts toward `backgroundRetryLimit` of `--pending`. For
 * each method a held file needs, an `ogw generation install <method>` job runs, and a later dispatch starts the file.
 */
async function startResources(ctx: Context, game: GameRepo, run: RunState, jobs: readonly JobRecord[]): Promise<{ started: Started[]; held: Held[]; installs: Install[] }> {
  const used = new Set(agentJobsOf(jobs, ['resource']).map(inputOf));
  const started: Started[] = [];
  const held: Held[] = [];
  for (const file of await requestFiles(game, run)) {
    if (used.has(file)) continue;
    const methods = await heldBy(ctx, game, file);
    if (methods.length > 0) {
      held.push({ input: file, methods });
      continue;
    }
    started.push({ job: await startAgentJob(ctx, { role: 'resource', game: game.name, input: file }), role: 'resource', input: file });
  }
  const installs: Install[] = [];
  for (const method of [...new Set(held.flatMap((h) => h.methods))]) installs.push({ job: await installMethodJob(ctx, method), method });
  return { started, held, installs };
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
    const { leftOut } = await requestPendingResources(ctx, game);
    const jobs = await runJobs(ctx, game, run);
    const resources = await startResources(ctx, game, run, jobs);
    const started = [...resources.started, ...(await startTranslations(ctx, game, run, jobs))];
    const { held, installs } = resources;
    const lines = [
      ...started.map((s) => `${s.job} ${s.role} ${s.input}`),
      ...held.map((h) => `held ${h.input}: ${h.methods.join(', ')} not installed on this host`),
      ...installs.map((i) => `${i.job} generation install ${i.method}`),
      ...leftOut.map(leftOutLine),
    ];
    return { text: lines.length > 0 ? lines.join('\n') : 'nothing to dispatch', data: { started, held, installs, leftOut } };
  },
};
