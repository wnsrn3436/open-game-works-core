import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { agentContext, markAgentRunning, runLogPath } from '../../../lib/agentctx.ts';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readText, whenNotFound } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { currentBranch, git, head, revParse } from '../../../lib/git.ts';
import { newId } from '../../../lib/ids.ts';
import { listJobs, startJob } from '../../../lib/jobs.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { isInside, withoutExtension } from '../../../lib/paths.ts';
import { changeOpenRun, openRun, requireOpenRun, type RunState } from '../../../lib/runstate.ts';
import { ROLES, type AgentSettings, type HarnessSettings, type Role } from '../../../lib/settings.ts';
import { hardeningRecordName, parseHardeningRecordName } from '../../build/lib/names.ts';
import { moduleSpecs } from '../../review/lib/definitions.ts';
import { parseReviewInput, targetSlug } from '../../review/lib/input.ts';
import { TOOLS } from '../../core/lib/tools.ts';
import { coreSpecDependencies } from './order.ts';
import { newAgentFolder } from './files.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';
import { AGENT_LOG_FOLDER, FIX_ROUND_ROLES, GAME_ROLES, jobHarnessSettings, type AgentMeta } from './meta.ts';
import { preparePlayInput } from './play-input.ts';
import { agentCli, agentSettings, defaultConfigFolder, type AgentCli, type AgentSession } from './cli-command.ts';
import { iterationKind } from '../../loop/lib/run.ts';
import { readMark } from '../../regress/lib/mark.ts';

export interface AgentRequest {
  role: string;
  game?: string;
  modules?: string[];
  input: string;
  /** Set for `ogw agent retry`. */
  retryRoot?: string;
  retryNumber?: number;
  /** `ogw agent retry`: the input of the first job of the retry chain, which names the result file. */
  taskInput?: string;
  /**
   * review: the commit the review worktree is made at (`ogw review next` passes the round's start commit). Without
   * it, main of `open-game-works-core-impl/` (core) or HEAD of the harness repo (tool).
   */
  baseCommit?: string;
  /** The agent CLI, model and effort instead of harness settings `agents.<role>`. */
  agent?: AgentSettings;
  /** judge of `ogw judge calibrate`: starts without a run, with this result file and evidence folder. */
  calibration?: CalibrationPlace;
  /** judge of `ogw loop variants`: in the open run, with this result file and evidence folder under `records/loops/<run>/`. */
  runPlace?: CalibrationPlace;
  /** content: the k of a variant agent of `ogw loop variants`, which works in its own worktree. */
  variant?: number;
  /** content, translation: outside a run, in a game with the regression mark (ogw.md `## agent`, `### seed-run`). */
  seedRun?: SeedRun;
  /** seed: the folder `ogw regress refresh` made for the agent, which holds its input (ogw.md `### seed agent`). */
  seedPlace?: string;
}

/** The seed-run records `records/loops/<records>/` and the iteration of `ogw agent --seed-run <records>:<n>`. */
export interface SeedRun {
  records: string;
  iteration: number;
}

/** `<records>:<n>` of `--seed-run`: a run-name-like folder name and an iteration of 1 or more. */
export function parseSeedRun(value: string): SeedRun {
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*):([1-9][0-9]*)$/.exec(value);
  if (match === null) throw new OgwError(`--seed-run takes <records>:<iteration>, e.g. regress-1:1: ${value}`);
  return { records: match[1] as string, iteration: Number(match[2]) };
}

/**
 * Where a judge agent of `ogw judge calibrate` puts its result file and captures (ogw.md `## agent`): absolute paths
 * under `records/calibration/` and `builds/calibration/` of the game repo checkout.
 */
export interface CalibrationPlace {
  output: string;
  evidence: string;
}

function checkRequest(request: AgentRequest): Role {
  const role = ROLES.find((r) => r === request.role);
  if (!role) throw new OgwError(`unknown role: ${request.role}`);
  const gameRole = GAME_ROLES.includes(role);
  if (gameRole && request.game === undefined) throw new OgwError(`--game is required for role ${role}`);
  if (!gameRole && request.game !== undefined) throw new OgwError(`--game is not given to role ${role}`);
  if (role !== 'core' && (request.modules ?? []).length > 0) throw new OgwError('--module is given only to role core');
  checkPlaces(role, request);
  checkSeedPlace(role, request);
  return role;
}

/** A calibration place and a run place go only to a judge, and a variant only to a content agent. */
function checkPlaces(role: Role, request: AgentRequest): void {
  if (request.calibration !== undefined && role !== 'judge') throw new OgwError('a calibration place is given only to role judge');
  if (request.runPlace !== undefined && (role !== 'judge' || request.calibration !== undefined)) throw new OgwError('a run place is given only to role judge, without a calibration place');
  if (request.variant !== undefined && (role !== 'content' || !Number.isInteger(request.variant) || request.variant < 1)) throw new OgwError('a variant is a positive integer given only to role content');
  if (request.seedRun !== undefined && ((role !== 'content' && role !== 'translation') || request.variant !== undefined)) throw new OgwError('--seed-run is given only to role content or translation, without a variant');
}

/** The seed agent starts only with its folder, which `ogw regress refresh` makes (ogw.md `## agent`). */
function checkSeedPlace(role: Role, request: AgentRequest): void {
  if (role === 'seed' && request.seedPlace === undefined) throw new OgwError('the seed agent starts only in ogw regress refresh, which makes its folder');
  if (role !== 'seed' && request.seedPlace !== undefined) throw new OgwError('a seed folder is given only to role seed');
}

/**
 * `--module` names a tool, a module of the `## module` tables of the harness `client-core` and `server-core` skills, or a
 * module of `core-spec/` on main of `open-game-works-core-impl/`. A job with another name could not be merged.
 */
async function checkModules(ctx: Context, modules: readonly string[]): Promise<void> {
  if (modules.length === 0) return;
  const ws = await ctx.workspace();
  const known = new Set<string>([...TOOLS, ...(await moduleSpecs(ws.harness)).map((spec) => spec.module)]);
  const main = await revParse(ws.coreImpl, 'main', { env: ctx.env });
  if (main !== null) for (const name of (await coreSpecDependencies(ws.coreImpl, main, { skipInvalid: true })).keys()) known.add(name);
  const unknown = modules.filter((module) => !known.has(module));
  if (unknown.length > 0) throw new OgwError(`unknown module: ${unknown.join(', ')} (--module takes module and tool names, separated by spaces)`);
}

function baseMeta(role: Role, input: string, taskInput: string, request: AgentRequest): AgentMeta {
  return {
    role,
    cliPid: null,
    game: request.game ?? null,
    input,
    taskInput,
    agentInput: input,
    run: null,
    iteration: null,
    k: null,
    modules: request.modules ?? [],
    place: { kind: 'checkout', dir: '' },
    folder: null,
    outputRel: null,
    finalOutput: null,
    evidence: null,
    instances: [],
    language: null,
    review: null,
    worktree: null,
    branch: null,
    merged: false,
    retryRoot: request.retryRoot ?? '',
    retryNumber: request.retryNumber ?? 0,
    agent: request.agent ?? null,
    variant: request.variant ?? null,
    seedRun: request.seedRun ?? null,
  };
}

/** The time limit of an agent job: harness settings `loop.playTimeLimitMs` and `loop.judgeTimeLimitMs` for play and judge. */
function agentTimeLimitMs(settings: HarnessSettings, role: Role): number {
  if (role !== 'play' && role !== 'judge') return LIMITS.jobMs;
  return role === 'play' ? settings.loop.playTimeLimitMs : settings.loop.judgeTimeLimitMs;
}

async function launchJob(ctx: Context, meta: AgentMeta, id?: string): Promise<string> {
  const caller = await agentContext(ctx.env);
  const jobId = id ?? newId();
  // the record holds the run log from its start: a job without one is no agent to `agentContext` and the index of running agents
  meta.runLog = await runLogPath(jobId, ctx.env);
  const settings = await jobHarnessSettings(ctx, meta);
  // a fix round continues the session of the job (ogw.md `## agent`): a new Claude Code session starts with its id; a new
  // Codex session gets its id from the first run
  if (meta.session === undefined && FIX_ROUND_ROLES.includes(meta.role) && agentCli(meta.agent ?? agentSettings(settings, meta.role)) === 'claude-code') {
    meta.session = { id: randomUUID(), resume: false };
  }
  return startJob({
    argv: ['agent', '__run'],
    cwd: ctx.cwd,
    command: 'agent',
    game: meta.game,
    timeLimitMs: agentTimeLimitMs(settings, meta.role),
    agentJob: caller?.job.id ?? null,
    meta,
    env: ctx.env,
    logFolder: AGENT_LOG_FOLDER,
    id: jobId,
  });
}

async function branchOf(game: GameRepo): Promise<{ branch: string; baseCommit: string }> {
  const branch = await currentBranch(game.root);
  if (branch === null) throw new OgwError(`${game.root} is not on a branch`);
  return { branch, baseCommit: await head(game.root) };
}

function relativeInRepo(root: string, path: string, what: string): string {
  if (!isInside(root, path)) throw new OgwError(`${what} is not inside ${root}: ${path}`);
  return relative(root, path);
}

/**
 * Language of a translation input: the file holds the language; its name may hold the unix ms. A retry passes the
 * input of the first job of its chain; a `## previous attempt` section after the language is also accepted.
 */
async function translationOutput(input: string, run: Pick<RunState, 'name'>): Promise<{ language: string; rel: string }> {
  const text = await readText(input);
  const previous = /^## previous attempt$/m.exec(text);
  const language = (previous === null ? text : text.slice(0, previous.index)).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(language)) throw new OgwError(`translation input does not hold one language: ${input}`);
  const named = /^translation-input-(.+)-(\d+)\.md$/.exec(basename(input));
  const ms = named?.[1] === language ? (named[2] as string) : String(Date.now());
  return { language, rel: join('records', 'loops', run.name, `translation-${language}-${ms}.md`) };
}

async function hardeningOutput(game: GameRepo, role: Role, run: RunState): Promise<string> {
  if (run.kind !== 'build' || run.env === null || run.version === null) throw new OgwError(`role ${role} runs only in a build run`);
  const { env, version } = run;
  const side = role === 'server-hardening' ? 'server' : 'client';
  const listed = await git(game.root, ['ls-tree', '--name-only', 'HEAD', 'records/hardening/']);
  const count = listed.split('\n').filter((path) => parseHardeningRecordName(basename(path), env, version)?.side === side).length;
  return join('records', 'hardening', hardeningRecordName(env, version, side, count + 1));
}

async function worktreeOutput(game: GameRepo, role: Role, input: string, run: RunState, meta: AgentMeta): Promise<string> {
  if (role === 'resource') {
    const rel = relativeInRepo(game.root, input, 'resource request file');
    return `${withoutExtension(rel)}-result.md`;
  }
  if (role === 'translation') {
    const { language, rel } = await translationOutput(input, run);
    meta.language = language;
    return rel;
  }
  return hardeningOutput(game, role, run);
}

/** The result file and evidence folder of a play or judge agent of the open run: `<role>-<iteration>-<k>`. */
async function runPlace(ctx: Context, game: GameRepo, role: 'play' | 'judge', run: RunState, meta: AgentMeta): Promise<CalibrationPlace> {
  const k = await nextOrder(ctx, game, role, run);
  const name = `${role}-${String(run.iteration)}-${String(k)}`;
  meta.k = k;
  return { output: join(game.root, 'records', 'loops', run.name, `${name}.md`), evidence: join(game.root, 'records', 'loops', run.name, 'evidence', name) };
}

/** A run place of a judge of `ogw loop variants`: a `.md` result file in `records/loops/<run>/` and an evidence folder in its `evidence/`. */
function checkRunPlace(game: GameRepo, run: RunState, place: CalibrationPlace): CalibrationPlace {
  const folder = join(game.root, 'records', 'loops', run.name);
  const evidence = join(folder, 'evidence');
  if (dirname(place.output) !== folder || !place.output.endsWith('.md')) throw new OgwError(`a run result file is a .md file in ${folder}: ${place.output}`);
  if (dirname(place.evidence) !== evidence) throw new OgwError(`a run evidence folder is in ${evidence}: ${place.evidence}`);
  return place;
}

/** A calibration place inside the calibration folders of the game repo checkout; fails otherwise. */
function checkCalibrationPlace(game: GameRepo, place: CalibrationPlace): CalibrationPlace {
  const records = join(game.root, 'records', 'calibration');
  const builds = join(game.root, 'builds', 'calibration');
  if (!isInside(records, place.output) || place.output === records || !place.output.endsWith('.md')) throw new OgwError(`a calibration result file is a .md file under ${records}: ${place.output}`);
  if (!isInside(builds, place.evidence) || place.evidence === builds) throw new OgwError(`a calibration evidence folder is under ${builds}: ${place.evidence}`);
  return place;
}

async function startPlayJudge(
  ctx: Context,
  game: GameRepo,
  role: 'play' | 'judge',
  run: RunState | null,
  meta: AgentMeta,
  given: { calibration?: CalibrationPlace; runPlace?: CalibrationPlace } = {},
): Promise<string> {
  const folder = await newAgentFolder(role, ctx.env);
  let id: string;
  try {
    const prepared = await preparePlayInput(role, meta.input, folder);
    meta.agentInput = prepared.input;
    meta.instances = prepared.instances;
    meta.folder = folder;
    meta.place = { kind: 'temp', dir: folder, checkout: game.root };
    const place =
      given.calibration !== undefined
        ? checkCalibrationPlace(game, given.calibration)
        : given.runPlace !== undefined
          ? checkRunPlace(game, run as RunState, given.runPlace)
          : await runPlace(ctx, game, role, run as RunState, meta);
    meta.output = join(folder, basename(place.output));
    meta.finalOutput = place.output;
    meta.evidence = place.evidence;
    id = await launchJob(ctx, meta);
  } catch (error) {
    // no job runs in the folder: remove it (ogw.md `## temp folder`)
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
  // in the index of running agents from the start of its job, so that `ogw command` refuses its instances
  await markAgentRunning(id, ctx.env);
  return id;
}

/** What `ogw agent` keeps in the run state `data.agent`: the last order `k` of each `<role>-<iteration>`. */
interface RunAgentData {
  order: Record<string, number>;
}

/**
 * The order `k` of a new play or judge agent in the iteration, counted in the open run state. A run whose state has
 * no count yet takes the counts from the agent jobs of the run once.
 */
export async function nextOrder(ctx: Context, game: GameRepo, role: 'play' | 'judge', started: RunState): Promise<number> {
  return changeOpenRun(game, async (run) => {
    if (run.name !== started.name) throw new OgwError(`the open run of game ${game.name} changed from ${started.name} to ${run.name}`);
    let data = run.data.agent as RunAgentData | undefined;
    if (data === undefined) {
      const order: Record<string, number> = {};
      for (const job of await listJobs(ctx.env)) {
        const meta = job.meta;
        if (job.command !== 'agent' || meta.game !== game.name || meta.run !== run.name || typeof meta.k !== 'number') continue;
        const key = `${String(meta.role)}-${String(meta.iteration)}`;
        order[key] = Math.max(order[key] ?? 0, meta.k);
      }
      data = { order };
      run.data.agent = data;
    }
    const key = `${role}-${String(started.iteration)}`;
    const k = (data.order[key] ?? 0) + 1;
    data.order[key] = k;
    return k;
  });
}

/** Whether Claude Code keeps the session file of `id`: `projects/<project folder>/<id>.jsonl` of its config folder. */
async function claudeSessionKept(env: NodeJS.ProcessEnv, id: string): Promise<boolean> {
  const projects = join(defaultConfigFolder('claude-code', env), 'projects');
  const folders = await readdir(projects).catch(whenNotFound([] as string[]));
  return folders.some((folder) => exists(join(projects, folder, `${id}.jsonl`)));
}

/** Whether Codex keeps the session file of `id`: a file under `sessions/` of its config folder named `rollout-...<id>...`. */
async function codexSessionKept(env: NodeJS.ProcessEnv, id: string): Promise<boolean> {
  const entries = await readdir(join(defaultConfigFolder('codex', env), 'sessions'), { recursive: true, withFileTypes: true }).catch(whenNotFound([]));
  return entries.some((entry) => entry.isFile() && entry.name.startsWith('rollout-') && entry.name.includes(id));
}

/** Whether the agent CLI `cli` keeps the session file of session id `id` in its default config folder (ogw.md `## agent`). */
export async function sessionKept(cli: AgentCli, env: NodeJS.ProcessEnv, id: string): Promise<boolean> {
  return cli === 'claude-code' ? claudeSessionKept(env, id) : codexSessionKept(env, id);
}

/** The session of the content agent of iteration `n - 1` of the run that is not a variant agent: its last job's, when it kept one. */
async function previousContentSession(ctx: Context, game: GameRepo, run: RunState): Promise<string | null> {
  const previous = (await listJobs(ctx.env))
    .filter(
      (job) =>
        job.command === 'agent' &&
        job.meta.role === 'content' &&
        job.meta.game === game.name &&
        job.meta.run === run.name &&
        job.meta.iteration === run.iteration - 1 &&
        (job.meta.variant ?? null) === null,
    )
    .sort((a, b) => a.startedAt - b.startedAt)
    .at(-1);
  const session = previous?.meta.session as AgentSession | null | undefined;
  return session === undefined || session === null ? null : session.id;
}

/**
 * The session of a content agent (ogw.md `## agent`): in a fun iteration whose previous iteration is a fun iteration of
 * the run, the session of the previous content agent continued, when its agent CLI keeps its file; else a new session,
 * which for Codex has no id until its first run prints it (null).
 */
async function contentSession(ctx: Context, game: GameRepo, run: RunState, meta: AgentMeta, settings: HarnessSettings): Promise<AgentSession | null> {
  const cli = agentCli(meta.agent ?? agentSettings(settings, 'content'));
  const continues = meta.retryNumber === 0 && (meta.variant ?? null) === null && run.iteration > 1 && iterationKind(run, run.iteration) === 'fun' && iterationKind(run, run.iteration - 1) === 'fun';
  const previous = continues ? await previousContentSession(ctx, game, run) : null;
  if (previous !== null && (await sessionKept(cli, ctx.env, previous))) return { id: previous, resume: true };
  return cli === 'claude-code' ? { id: randomUUID(), resume: false } : null;
}

/**
 * A content agent or translation sub-agent of a seed-run (ogw.md `## agent`): outside a run, in a game with the
 * regression mark, with the seed-run records in place of the run folder and a new session.
 */
async function startSeedRunAgent(ctx: Context, game: GameRepo, role: Role, meta: AgentMeta, seedRun: SeedRun): Promise<string> {
  if ((await readMark(game.commonDir)) === null) throw new OgwError(`--seed-run starts only in a regression state or fix repo of ogw regress, not in ${game.name}`);
  const open = await openRun(game);
  if (open !== null) throw new OgwError(`game ${game.name} has an open run ${open.name}; --seed-run starts outside a run`);
  meta.run = seedRun.records;
  meta.iteration = seedRun.iteration;
  const records = join('records', 'loops', seedRun.records);
  if (role === 'content') {
    meta.place = { kind: 'checkout', dir: game.root };
    meta.folder = game.root;
    meta.output = join(game.root, records, `content-${String(seedRun.iteration)}.md`);
    const cli = agentCli(meta.agent ?? agentSettings(await jobHarnessSettings(ctx, meta), 'content'));
    meta.session = cli === 'claude-code' ? { id: randomUUID(), resume: false } : null;
    return launchJob(ctx, meta);
  }
  const { branch, baseCommit } = await branchOf(game);
  meta.place = { kind: 'game-worktree', checkout: game.root, worktrees: (await ctx.workspace()).worktrees, branch, baseCommit };
  const { language, rel } = await translationOutput(meta.taskInput, { name: seedRun.records });
  meta.language = language;
  meta.outputRel = rel;
  return launchJob(ctx, meta);
}

async function startGameAgent(ctx: Context, role: Role, meta: AgentMeta, request: AgentRequest): Promise<string> {
  const game = await ctx.game(meta.game as string);
  if (request.seedRun !== undefined) return startSeedRunAgent(ctx, game, role, meta, request.seedRun);
  // a judge of `ogw judge calibrate` has no run; every other game agent works in the open run
  if (request.calibration !== undefined) return startPlayJudge(ctx, game, 'judge', null, meta, { calibration: request.calibration });
  const run = await requireOpenRun(game);
  meta.run = run.name;
  meta.iteration = run.iteration;
  if (role === 'play' || role === 'judge') return startPlayJudge(ctx, game, role, run, meta, request.runPlace === undefined ? {} : { runPlace: request.runPlace });
  if (role === 'content' && request.variant !== undefined) {
    // a variant agent works in its own worktree of the work branch HEAD, as a resource agent does
    const { branch, baseCommit } = await branchOf(game);
    meta.place = { kind: 'game-worktree', checkout: game.root, worktrees: (await ctx.workspace()).worktrees, branch, baseCommit };
    meta.outputRel = join('records', 'loops', run.name, `content-${String(run.iteration)}-v${String(request.variant)}.md`);
    meta.session = await contentSession(ctx, game, run, meta, await jobHarnessSettings(ctx, meta));
    return launchJob(ctx, meta);
  }
  if (role === 'content') {
    meta.place = { kind: 'checkout', dir: game.root };
    meta.folder = game.root;
    meta.output = join(game.root, 'records', 'loops', run.name, `content-${String(run.iteration)}.md`);
    meta.session = await contentSession(ctx, game, run, meta, await jobHarnessSettings(ctx, meta));
    return launchJob(ctx, meta);
  }
  const { branch, baseCommit } = await branchOf(game);
  meta.place = { kind: 'game-worktree', checkout: game.root, worktrees: (await ctx.workspace()).worktrees, branch, baseCommit };
  meta.outputRel = await worktreeOutput(game, role, meta.taskInput, run, meta);
  return launchJob(ctx, meta);
}

/** The commands a core agent input names (`core` command `## command`). */
export const CORE_INPUT_COMMANDS = ['create contract tool', 'create server core', 'create client core', 'update core', 'review fix'] as const;

/** The `<command>` of the report path: the first line `command: <command>` of a core agent input, spaces made `-`. */
export function coreCommand(input: string): string {
  const first = input.split(/\r?\n/, 1)[0] ?? '';
  const command = /^command: (.+)$/.exec(first)?.[1]?.trim();
  if (command === undefined || !(CORE_INPUT_COMMANDS as readonly string[]).includes(command)) {
    throw new OgwError(`the first line of a core agent input is not \`command: <command>\` with one of ${CORE_INPUT_COMMANDS.join(', ')}: ${first}`);
  }
  return command.replace(/ /g, '-');
}

async function mainHead(coreImpl: string): Promise<string> {
  const commit = await revParse(coreImpl, 'main');
  if (commit === null) throw new OgwError(`${coreImpl} has no branch main`);
  return commit;
}

async function startCoreOrReview(ctx: Context, role: Role, meta: AgentMeta, baseCommit: string | undefined): Promise<string> {
  const ws = await ctx.workspace();
  const text = await readText(meta.input);
  if (role === 'core') {
    meta.place = { kind: 'core-worktree', coreImpl: ws.coreImpl, worktrees: ws.worktrees, baseCommit: await mainHead(ws.coreImpl) };
    // the job id keeps apart the reports of core agents started in the same millisecond
    const id = newId();
    meta.outputRel = join('records', `${String(Date.now())}-${coreCommand(text)}-${id}.md`);
    return launchJob(ctx, meta, id);
  }
  const review = parseReviewInput(text);
  meta.review = review;
  const name = review.side === 'spec' ? `spec-${targetSlug(review.target)}.md` : `${targetSlug(review.target)}-${String(review.round)}.md`;
  if (review.side === 'core') {
    meta.place = { kind: 'core-worktree', coreImpl: ws.coreImpl, worktrees: ws.worktrees, baseCommit: baseCommit ?? (await mainHead(ws.coreImpl)) };
    meta.outputRel = join('records', 'review', name);
    return launchJob(ctx, meta);
  }
  meta.place = { kind: 'tool-worktree', harness: ws.harness, baseCommit: baseCommit ?? (await head(ws.harness, { env: ctx.env })) };
  meta.output = join(await newPrivateTempFolder('ogw-review-file-', ctx.env), name);
  return launchJob(ctx, meta);
}

/**
 * The seed agent (ogw.md `## agent`, `### seed agent`): in the folder `ogw regress refresh` made, which holds its input,
 * with the result file `result.md` there; outside any run, with no session.
 */
function startSeedAgent(ctx: Context, meta: AgentMeta, folder: string): Promise<string> {
  if (!isInside(folder, meta.input) || meta.input === folder) throw new OgwError(`the input of the seed agent is not in its folder ${folder}: ${meta.input}`);
  meta.place = { kind: 'seed', dir: folder };
  meta.folder = folder;
  meta.output = join(folder, SEED_RESULT_FILE);
  return launchJob(ctx, meta);
}

/** The result file of the seed agent in its folder. */
export const SEED_RESULT_FILE = 'result.md';

/** `ogw agent <role> ...`: checks the request, prepares the agent's folder and input, and starts its job. */
export async function startAgent(ctx: Context, request: AgentRequest): Promise<string> {
  const role = checkRequest(request);
  await checkModules(ctx, request.modules ?? []);
  const input = resolve(ctx.cwd, request.input);
  if (!exists(input)) throw new OgwError(`input file not found: ${input}`);
  const taskInput = request.taskInput === undefined ? input : resolve(ctx.cwd, request.taskInput);
  const meta = baseMeta(role, input, taskInput, request);
  if (request.baseCommit !== undefined && role !== 'review') throw new OgwError('a base commit is given only to role review');
  if (role === 'seed') return startSeedAgent(ctx, meta, resolve(ctx.cwd, request.seedPlace as string));
  return GAME_ROLES.includes(role) ? startGameAgent(ctx, role, meta, request) : startCoreOrReview(ctx, role, meta, request.baseCommit);
}
