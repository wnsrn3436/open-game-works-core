/**
 * Sides of the regression suite (ogw.md `### side` of `## regress`): a harness worktree per side, its side tool, and the
 * side commands that `ogw regress run` and `ogw regress refresh` run with it.
 */
import { rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { EXIT_STILL_RUNNING, OgwError } from '../../../lib/errors.ts';
import { readJsonIfExists, writeJsonAtomic } from '../../../lib/fsx.ts';
import { worktreeAdd, worktreeRemove } from '../../../lib/git.ts';
import { newId } from '../../../lib/ids.ts';
import { JobNotFound, readJob } from '../../../lib/jobs.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { run, type RunResult } from '../../../lib/proc.ts';
import type { AgentSettings } from '../../../lib/settings.ts';
import { SIDE_WORKTREES } from '../../agent/lib/launch.ts';
import type { AgentUsage } from '../../agent/lib/usage.ts';
import { sameDependencies } from '../../code/lib/proof.ts';
import type { RegressCheckFile } from './keys.ts';

export type SideName = 'before' | 'after';

/** What a side is given: its commit and the agent settings that replace harness settings `agents.<role>`. */
export interface SideSpec {
  name: SideName;
  commit: string;
  agents: Record<string, AgentSettings>;
}

/** What `ogw regress side` prints. */
export interface SideInfo {
  commit: string;
  coreVersion: string | null;
  promptBytes: { content: number; translation: number };
  agents: Record<string, AgentSettings>;
  /**
   * The instances of regress games that the side tool starts hold the performance lease (ogw.md `### performance lease`);
   * absent for a side tool from before, whose checks with performance run alone (`### regress run`).
   */
  instanceLease?: true;
  /**
   * The heavy steps of the checks of regress games that the side tool runs hold the performance lease (ogw.md
   * `### performance lease`); absent for a side tool from before. Two sides of which only one has it keep the coarse rule
   * of `### regress run`.
   */
  stepLease?: true;
}

export interface Side extends SideSpec {
  /** The side worktree; null for the harness repo itself, whose side commands run in this process. */
  worktree: string | null;
  info: SideInfo | null;
  /** Why the side is `unknown`; null for a side that runs. */
  unknown: string | null;
}

/** The output of one side command. */
export interface SideOutput {
  code: number;
  stdout: string;
  stderr: string;
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1) ?? '';
}

/**
 * Runs `ogw <argv>` with the side tool (ogw.md `### side`): the side worktree's tool with `OGW_HARNESS_ROOT` and
 * `OGW_WORKSPACE_ROOT` set, or this harness in this process for the harness repo itself.
 */
export async function sideOgw(ctx: Context, side: Side, argv: readonly string[], timeoutMs: number = LIMITS.jobMs): Promise<SideOutput> {
  const env: NodeJS.ProcessEnv = { ...ctx.env };
  // the side command is no part of the job of this command
  delete env.OGW_JOB_ID;
  if (side.worktree === null) {
    const [{ commandsFor }, { runCli }] = await Promise.all([import('../../lazy.ts'), import('../../../lib/cli.ts')]);
    let stdout = '';
    let stderr = '';
    const code = await runCli(await commandsFor(argv[0]), argv, {
      cwd: (await ctx.workspace()).root,
      env,
      stdin: () => Promise.resolve(''),
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    return { code, stdout, stderr };
  }
  const ws = await ctx.workspace();
  const result: RunResult = await run(join(side.worktree, 'tools', 'bin', 'ogw'), argv, {
    cwd: ws.root,
    env: { ...env, OGW_HARNESS_ROOT: side.worktree, OGW_WORKSPACE_ROOT: ws.root },
    timeoutMs,
  });
  return { code: result.timedOut ? 1 : (result.code ?? 1), stdout: result.stdout, stderr: result.timedOut ? `timed out after ${String(timeoutMs)} ms` : result.stderr };
}

/** The JSON a side command printed with `--json`, or the reason it gave none. */
export async function sideJson(ctx: Context, side: Side, argv: readonly string[], dataOnFailure = false): Promise<{ data: unknown } | { error: string }> {
  const out = await sideOgw(ctx, side, [...argv, '--json']);
  let data: unknown;
  try {
    data = JSON.parse(out.stdout);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { error: `ogw ${argv.slice(0, 2).join(' ')} exit ${String(out.code)}: ${lastLine(out.stderr) || lastLine(out.stdout)}` };
  }
  const message = (data as { error?: unknown } | null)?.error;
  // a command whose failure has data of its own (`ogw agent wait` of a failed job) gives it with `dataOnFailure`
  if (out.code !== 0 && out.code !== EXIT_STILL_RUNNING && (!dataOnFailure || message !== undefined)) {
    return { error: `ogw ${argv.slice(0, 2).join(' ')} exit ${String(out.code)}: ${typeof message === 'string' ? message : lastLine(out.stderr)}` };
  }
  return { data };
}

/** The harness repo itself as a side: its side commands run in this process (`ogw regress refresh`, `ogw regress seed`). */
export function harnessSide(commit: string): Side {
  return { name: 'after', commit, agents: {}, worktree: null, info: null, unknown: null };
}

/**
 * Makes a side (ogw.md `### side`): its worktree under `worktrees/_harness/`, its `tools/node_modules`, its
 * `settings.local.json`, and the information of `ogw regress side`. A step that fails makes the side `unknown`.
 */
export async function makeSide(ctx: Context, spec: SideSpec): Promise<Side> {
  const ws = await ctx.workspace();
  const worktree = join(ws.worktrees, SIDE_WORKTREES, newId());
  const side: Side = { ...spec, worktree, info: null, unknown: null };
  try {
    await worktreeAdd(ws.harness, worktree, spec.commit, undefined, { env: ctx.env });
  } catch (error) {
    return { ...side, worktree: null, unknown: `the side worktree of ${spec.commit} could not be made: ${lastLine((error as Error).message)}` };
  }
  const tools = join(worktree, 'tools');
  if (await sameDependencies(ws.harness, spec.commit, ctx.env)) await symlink(join(ws.harness, 'tools', 'node_modules'), join(tools, 'node_modules'), 'dir');
  else {
    const installed = await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: tools, env: ctx.env, timeoutMs: LIMITS.programMs });
    if (installed.code !== 0) return { ...side, unknown: `npm ci of ${spec.commit} failed: ${lastLine(installed.stderr || installed.stdout)}` };
  }
  const local = (await readJsonIfExists<Record<string, unknown>>(join(ws.harness, 'settings.local.json'))) ?? {};
  const agents = { ...((local.agents ?? {}) as Record<string, unknown>), ...spec.agents };
  if (Object.keys(local).length > 0 || Object.keys(agents).length > 0) await writeJsonAtomic(join(worktree, 'settings.local.json'), { ...local, ...(Object.keys(agents).length > 0 ? { agents } : {}) });
  const info = await sideJson(ctx, side, ['regress', 'side']);
  if ('error' in info) return { ...side, unknown: `the side tool of ${spec.commit} does not run ogw regress side: ${info.error}` };
  return { ...side, info: info.data as SideInfo };
}

/** Removes the worktree of a side. */
export async function removeSide(ctx: Context, side: Side): Promise<void> {
  if (side.worktree === null) return;
  const ws = await ctx.workspace();
  await worktreeRemove(ws.harness, side.worktree, { env: ctx.env });
  await rm(side.worktree, { recursive: true, force: true });
}

export interface CheckRequest {
  game: string;
  commit: string;
  out: string;
  /** Only these checks; null for every check. */
  checks: readonly string[] | null;
  performance: boolean;
  /** `<records>:<n>` of the fix test proof, or null. */
  proof: string | null;
}

/** `ogw regress check` with the side tool: the check file, or why it could not be made. */
export async function sideCheck(ctx: Context, side: Side, request: CheckRequest): Promise<{ file: RegressCheckFile; minutes: number } | { error: string }> {
  const argv = ['regress', 'check', request.game, '--commit', request.commit, '--out', request.out];
  if (request.checks !== null) argv.push('--check', ...request.checks);
  if (request.performance) argv.push('--performance');
  if (request.proof !== null) argv.push('--proof', request.proof);
  const started = Date.now();
  const out = await sideJson(ctx, side, argv);
  if ('error' in out) return out;
  return { file: out.data as RegressCheckFile, minutes: (Date.now() - started) / 60_000 };
}

export interface ProbeResult {
  result: 'pass' | 'fail' | 'unknown';
  reason: string | null;
}

/** `ogw regress probe` with the side tool; a probe that could not run is `unknown`. */
export async function sideProbe(ctx: Context, side: Side, request: { game: string; commit: string; oracle: string; out: string }): Promise<ProbeResult> {
  const out = await sideJson(ctx, side, ['regress', 'probe', request.game, '--commit', request.commit, '--oracle', request.oracle, '--out', request.out]);
  return 'error' in out ? { result: 'unknown', reason: out.error } : (out.data as ProbeResult);
}

/** What a fixer job of a seed-run gave. */
export interface FixerRun {
  job: string | null;
  status: 'done' | 'failed';
  output: string | null;
  reason: string | null;
}

/** `ogw agent <role> --seed-run ... --background` and `ogw agent wait` with the side tool. */
export async function sideAgent(ctx: Context, side: Side, request: { role: 'content' | 'translation'; game: string; input: string; seedRun: string }): Promise<FixerRun> {
  const started = await sideJson(ctx, side, ['agent', request.role, '--game', request.game, '--input', request.input, '--seed-run', request.seedRun, '--background']);
  if ('error' in started) return { job: null, status: 'failed', output: null, reason: started.error };
  const job = (started.data as { job: string }).job;
  for (;;) {
    const waited = await sideJson(ctx, side, ['agent', 'wait', job], true);
    if ('error' in waited) return { job, status: 'failed', output: null, reason: waited.error };
    const answer = waited.data as { status: string; output?: string | null; stderr?: string };
    if (answer.status === 'running') continue;
    if (answer.status === 'done') return { job, status: 'done', output: answer.output ?? null, reason: null };
    return { job, status: 'failed', output: answer.output ?? null, reason: `agent job ${job} failed${answer.stderr === undefined || answer.stderr.trim() === '' ? '' : `: ${lastLine(answer.stderr)}`}` };
  }
}

/** `ogw agent merge <id>` with the side tool; the reason when it did not merge. */
export async function sideMerge(ctx: Context, side: Side, job: string): Promise<string | null> {
  const out = await sideOgw(ctx, side, ['agent', 'merge', job]);
  return out.code === 0 ? null : `ogw agent merge ${job}: ${lastLine(out.stderr) || lastLine(out.stdout)}`;
}

/** The usage and times of an `ogw agent` job from its record in the jobs folder, which every side shares. */
export interface JobFacts {
  usage: AgentUsage | null;
  startedAt: number;
  endedAt: number | null;
}

/** The facts of job `id`; a job without a record (removed with the jobs folder) has no usage and no time. */
export async function jobFacts(ctx: Context, id: string): Promise<JobFacts> {
  const job = await readJob(id, ctx.env).catch((error: unknown) => {
    if (error instanceof JobNotFound) return null;
    throw error;
  });
  if (job === null) return { usage: null, startedAt: 0, endedAt: 0 };
  const usage = (job.meta.usage as AgentUsage | undefined) ?? null;
  return { usage, startedAt: job.startedAt, endedAt: job.endedAt };
}

/** Fails when the two sides do not share a harness core version (ogw.md `### side`). */
export function requireSameCore(before: SideInfo, after: SideInfo): string {
  if (before.coreVersion === null || before.coreVersion !== after.coreVersion) {
    const tag = (v: string | null): string => (v === null ? 'no core-v tag' : `core-v${v}`);
    throw new OgwError(`the sides have different harness core versions: before ${before.commit} (${tag(before.coreVersion)}), after ${after.commit} (${tag(after.coreVersion)}); compare commits of one core-v<version> tag, whose states ogw regress refresh made`);
  }
  return before.coreVersion;
}
