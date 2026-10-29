import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectPositionals, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { writeFileAtomic } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { commitPaths } from '../../lib/git.ts';
import { readJob, type JobRecord } from '../../lib/jobs.ts';
import { changeOpenRun, requireOpenRun, type RunState } from '../../lib/runstate.ts';
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

/** A request file not given to a resource sub-agent while an install job of methods its keys need runs. */
interface Held {
  input: string;
  methods: string[];
}

/** An install job dispatch started or took in this run for a method, and how it ended: `running`, or `failed` when the method is still not installed. */
interface Install {
  method: string;
  job: string;
  /** The command of the job, `ogw generation install [<method>]`. */
  command: string;
  state: 'running' | 'failed';
}

/** The methods not installed on this host that some key of the request file needs (`blockingMethods`), in first-seen order. */
async function heldBy(ctx: Context, game: GameRepo, file: string): Promise<string[]> {
  const methods: string[] = [];
  for (const key of requestFileKeys(await readFile(file, 'utf8').catch(() => ''))) {
    for (const method of await blockingMethods(ctx, game, key)) if (!methods.includes(method)) methods.push(method);
  }
  return methods;
}

/**
 * The install of a method a request file needs, once per run: the install job recorded in the run, else a new one
 * (`installMethodJob`) recorded there. A recorded job that ended while the method is still not installed is `failed`,
 * and is not started again in the run. A job that cannot start is `failed` too.
 */
async function installOf(ctx: Context, game: GameRepo, method: string): Promise<Install> {
  const recorded = loopData(await requireOpenRun(game)).installs.find((i) => i.method === method);
  if (recorded) {
    const job = await readJob(recorded.job, ctx.env).catch(() => null);
    const command = `ogw ${(job?.argv ?? ['generation', 'install', method]).join(' ')}`;
    return { method, job: recorded.job, command, state: job?.status === 'running' ? 'running' : 'failed' };
  }
  try {
    const { job, argv } = await installMethodJob(ctx, method);
    await changeOpenRun(game, (run) => {
      loopData(run).installs.push({ method, job });
    });
    return { method, job, command: `ogw ${argv.join(' ')}`, state: 'running' };
  } catch (error) {
    return { method, job: '', command: `not started: ${(error instanceof Error ? error.message : String(error)).split('\n', 1)[0] as string}`, state: 'failed' };
  }
}

/**
 * Starts a resource job per request file never given to one. A file with a key whose methods are not installed on this
 * host (`heldBy`) waits while an install job of those methods runs: a sub-agent would make none of those keys, and its
 * run counts toward `backgroundRetryLimit` of `--pending`. Once each such install has failed, the file goes to a
 * sub-agent, which makes the other keys and reports those it cannot make.
 */
async function startResources(ctx: Context, game: GameRepo, run: RunState, jobs: readonly JobRecord[]): Promise<{ started: Started[]; held: Held[]; installs: Install[] }> {
  const used = new Set(agentJobsOf(jobs, ['resource']).map(inputOf));
  const started: Started[] = [];
  const held: Held[] = [];
  const installs = new Map<string, Install>();
  for (const file of await requestFiles(game, run)) {
    if (used.has(file)) continue;
    const waiting: string[] = [];
    for (const method of await heldBy(ctx, game, file)) {
      if (!installs.has(method)) installs.set(method, await installOf(ctx, game, method));
      if (installs.get(method)?.state === 'running') waiting.push(method);
    }
    if (waiting.length > 0) {
      held.push({ input: file, methods: waiting });
      continue;
    }
    started.push({ job: await startAgentJob(ctx, { role: 'resource', game: game.name, input: file }), role: 'resource', input: file });
  }
  return { started, held, installs: [...installs.values()] };
}

function installLine(install: Install): string {
  if (install.state === 'running') return `${install.job} ${install.command}`;
  if (install.job === '') return `install failed ${install.method}: ${install.command}`;
  return `install failed ${install.method}: ${install.command} (job ${install.job}: ogw job status ${install.job})`;
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
      ...installs.map(installLine),
      ...leftOut.map(leftOutLine),
    ];
    return { text: lines.length > 0 ? lines.join('\n') : 'nothing to dispatch', data: { started, held, installs, leftOut } };
  },
};
