import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { agentContext, markAgentRunning, runLogPath } from '../../../lib/agentctx.ts';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readText } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { currentBranch, git, head, revParse } from '../../../lib/git.ts';
import { newId } from '../../../lib/ids.ts';
import { listJobs, startJob } from '../../../lib/jobs.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { isInside, withoutExtension } from '../../../lib/paths.ts';
import { changeOpenRun, requireOpenRun, type RunState } from '../../../lib/runstate.ts';
import { ROLES, type AgentSettings, type HarnessSettings, type Role } from '../../../lib/settings.ts';
import { hardeningRecordName, parseHardeningRecordName } from '../../build/lib/names.ts';
import { moduleSpecs } from '../../review/lib/definitions.ts';
import { parseReviewInput, targetSlug } from '../../review/lib/input.ts';
import { TOOLS } from '../../core/lib/tools.ts';
import { coreSpecDependencies } from './order.ts';
import { newAgentFolder } from './files.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';
import { AGENT_LOG_FOLDER, GAME_ROLES, type AgentMeta } from './meta.ts';
import { preparePlayInput } from './play-input.ts';
import { agentCli, agentSettings, type AgentSession } from './cli-command.ts';
import { iterationKind } from '../../loop/lib/run.ts';

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
  if (request.calibration !== undefined && role !== 'judge') throw new OgwError('a calibration place is given only to role judge');
  return role;
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
  };
}

async function launchJob(ctx: Context, meta: AgentMeta, id?: string): Promise<string> {
  const caller = await agentContext(ctx.env);
  return startJob({
    argv: ['agent', '__run'],
    cwd: ctx.cwd,
    command: 'agent',
    game: meta.game,
    timeLimitMs: LIMITS.jobMs,
    agentJob: caller?.job.id ?? null,
    meta,
    env: ctx.env,
    logFolder: AGENT_LOG_FOLDER,
    ...(id === undefined ? {} : { id }),
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
async function translationOutput(input: string, run: RunState): Promise<{ language: string; rel: string }> {
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

/** A calibration place inside the calibration folders of the game repo checkout; fails otherwise. */
function checkCalibrationPlace(game: GameRepo, place: CalibrationPlace): CalibrationPlace {
  const records = join(game.root, 'records', 'calibration');
  const builds = join(game.root, 'builds', 'calibration');
  if (!isInside(records, place.output) || place.output === records || !place.output.endsWith('.md')) throw new OgwError(`a calibration result file is a .md file under ${records}: ${place.output}`);
  if (!isInside(builds, place.evidence) || place.evidence === builds) throw new OgwError(`a calibration evidence folder is under ${builds}: ${place.evidence}`);
  return place;
}

async function startPlayJudge(ctx: Context, game: GameRepo, role: 'play' | 'judge', run: RunState | null, meta: AgentMeta, calibration?: CalibrationPlace): Promise<string> {
  const folder = await newAgentFolder(role, ctx.env);
  let id: string;
  try {
    const prepared = await preparePlayInput(role, meta.input, folder);
    meta.agentInput = prepared.input;
    meta.instances = prepared.instances;
    meta.folder = folder;
    meta.place = { kind: 'temp', dir: folder, checkout: game.root };
    const place = calibration === undefined ? await runPlace(ctx, game, role, run as RunState, meta) : checkCalibrationPlace(game, calibration);
    meta.output = join(folder, basename(place.output));
    meta.runLog = runLogPath(meta.output);
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

/** The default config folder of Claude Code: `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  const set = env.CLAUDE_CONFIG_DIR;
  return set !== undefined && set !== '' ? set : join(env.HOME ?? homedir(), '.claude');
}

/** Whether Claude Code keeps the session file of `id`: `projects/<project folder>/<id>.jsonl` of its config folder. */
export async function claudeSessionKept(env: NodeJS.ProcessEnv, id: string): Promise<boolean> {
  const projects = join(claudeConfigDir(env), 'projects');
  const folders = await readdir(projects).catch(() => [] as string[]);
  return folders.some((folder) => exists(join(projects, folder, `${id}.jsonl`)));
}

/** The session of the content agent of iteration `n - 1` of the run: its last job's, when it kept one. */
async function previousContentSession(ctx: Context, game: GameRepo, run: RunState): Promise<string | null> {
  const previous = (await listJobs(ctx.env))
    .filter((job) => job.command === 'agent' && job.meta.role === 'content' && job.meta.game === game.name && job.meta.run === run.name && job.meta.iteration === run.iteration - 1)
    .sort((a, b) => a.startedAt - b.startedAt)
    .at(-1);
  const session = previous?.meta.session as AgentSession | null | undefined;
  return session === undefined || session === null ? null : session.id;
}

/**
 * The Claude Code session of a content agent (`game-loop` `## sub-agent`): in a fun iteration whose previous iteration
 * is a fun iteration of the run, the session of the previous content agent continued, when its file is kept; else a
 * new session. null when the content agent CLI is not Claude Code.
 */
async function contentSession(ctx: Context, game: GameRepo, run: RunState, meta: AgentMeta, settings: HarnessSettings): Promise<AgentSession | null> {
  if (agentCli(meta.agent ?? agentSettings(settings, 'content')) !== 'claude-code') return null;
  const continues = meta.retryNumber === 0 && run.iteration > 1 && iterationKind(run, run.iteration) === 'fun' && iterationKind(run, run.iteration - 1) === 'fun';
  const previous = continues ? await previousContentSession(ctx, game, run) : null;
  if (previous !== null && (await claudeSessionKept(ctx.env, previous))) return { id: previous, resume: true };
  return { id: randomUUID(), resume: false };
}

async function startGameAgent(ctx: Context, role: Role, meta: AgentMeta, calibration?: CalibrationPlace): Promise<string> {
  const game = await ctx.game(meta.game as string);
  // a judge of `ogw judge calibrate` has no run; every other game agent works in the open run
  if (calibration !== undefined) return startPlayJudge(ctx, game, 'judge', null, meta, calibration);
  const run = await requireOpenRun(game);
  meta.run = run.name;
  meta.iteration = run.iteration;
  if (role === 'play' || role === 'judge') return startPlayJudge(ctx, game, role, run, meta);
  if (role === 'content') {
    meta.place = { kind: 'checkout', dir: game.root };
    meta.folder = game.root;
    meta.output = join(game.root, 'records', 'loops', run.name, `content-${String(run.iteration)}.md`);
    meta.runLog = runLogPath(meta.output);
    meta.session = await contentSession(ctx, game, run, meta, await ctx.settings());
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
  meta.runLog = runLogPath(meta.output);
  return launchJob(ctx, meta);
}

/** `ogw agent <role> ...`: checks the request, prepares the agent's folder and input, and starts its job. */
export async function startAgent(ctx: Context, request: AgentRequest): Promise<string> {
  const role = checkRequest(request);
  await checkModules(ctx, request.modules ?? []);
  const input = resolve(ctx.cwd, request.input);
  if (!exists(input)) throw new OgwError(`input file not found: ${input}`);
  const taskInput = request.taskInput === undefined ? input : resolve(ctx.cwd, request.taskInput);
  const meta = baseMeta(role, input, taskInput, request);
  if (request.baseCommit !== undefined && role !== 'review') throw new OgwError('a base commit is given only to role review');
  return GAME_ROLES.includes(role) ? startGameAgent(ctx, role, meta, request.calibration) : startCoreOrReview(ctx, role, meta, request.baseCommit);
}
