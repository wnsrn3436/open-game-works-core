import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { exists } from '../../../lib/fsx.ts';
import { jobsDir, readJob, updateJob, type JobRecord } from '../../../lib/jobs.ts';
import type { Context } from '../../../lib/command.ts';
import type { AgentSettings, HarnessSettings, Role } from '../../../lib/settings.ts';
import { runHarnessSettings } from '../../loop/lib/harness-pin.ts';
import type { AgentSession } from './cli-command.ts';
import type { AgentUsage, SessionUsage } from './usage.ts';

/** Roles that work in a game: every role except `core` and `review`. */
export const GAME_ROLES: readonly Role[] = [
  'content',
  'resource',
  'translation',
  'play',
  'judge',
  'server-hardening',
  'client-hardening',
];

/**
 * The roles whose result file has fix rounds (ogw.md `### result format` of `## agent`): the roles with a result format
 * check whose agent CLI keeps a session. Play and judge keep none.
 */
export const FIX_ROUND_ROLES: readonly Role[] = ['content', 'server-hardening', 'client-hardening', 'review'];

/** Roles that work in a new worktree of the game repo. */
export const GAME_WORKTREE_ROLES: readonly Role[] = ['resource', 'translation', 'server-hardening', 'client-hardening'];

/** Where the agent works. */
export type AgentPlace =
  | { kind: 'checkout'; dir: string }
  | { kind: 'game-worktree'; checkout: string; worktrees: string; branch: string; baseCommit: string }
  | { kind: 'core-worktree'; coreImpl: string; worktrees: string; baseCommit: string }
  | { kind: 'tool-worktree'; harness: string; baseCommit: string }
  | { kind: 'temp'; dir: string; checkout: string }
  /** seed: the folder `ogw regress refresh` made, which holds the input and result file and which the refresh removes. */
  | { kind: 'seed'; dir: string };

/** Review fields of a review agent job, read from the review input. */
export interface ReviewOf {
  side: 'core' | 'tool' | 'spec';
  target: string;
  round: number;
}

/**
 * Everything `ogw agent` keeps in the job `meta`. `role`, `cliPid`, `output` and `runLog` are the
 * foundation's `AgentJobMeta`; `runLog` is set when the job record is made, and `output` once the result file path
 * is known.
 */
export interface AgentMeta {
  role: Role;
  cliPid: number | null;
  /** Start time of `cliPid` (`processStartedAt`). */
  cliPidStartedAt?: string | null;
  /** SHA-256 of the nonce of the agent key (`newAgentKey`), set before the agent CLI starts. */
  keyHash?: string;
  output?: string;
  runLog?: string;
  game: string | null;
  /** The `--input` file as given, absolute. */
  input: string;
  /** The input of the task: `input`, or for a retry the input of the first job of its chain. Names the result file. */
  taskInput: string;
  /** The input file passed to the agent, absolute: `input`, or for play and judge `<folder>/input/input.json`. */
  agentInput: string;
  run: string | null;
  iteration: number | null;
  /** Order of this role's agent in the iteration (play, judge), 1-based. */
  k: number | null;
  modules: string[];
  place: AgentPlace;
  /** Folder the agent CLI starts in. */
  folder: string | null;
  /** Result file path relative to the worktree, for roles whose worktree is made when the job starts. */
  outputRel: string | null;
  /** play, judge: where the result file goes when the agent ends. */
  finalOutput: string | null;
  /** play, judge: where `captures/` goes when the agent ends. */
  evidence: string | null;
  /** play, judge: instance ids in the input. */
  instances: string[];
  /** translation: the language. */
  language: string | null;
  review: ReviewOf | null;
  /** Worktree and branch made for the agent. */
  worktree: string | null;
  branch: string | null;
  /** `ogw agent merge` merged this job. */
  merged: boolean;
  /** First job of the chain of retries this job belongs to, and its number in the chain (0: not a retry). */
  retryRoot: string;
  retryNumber: number;
  /** Set when the agent CLI ended: whether the agent wrote the result file (a file left at that path before does not count). */
  outputWritten?: boolean;
  /** Set when `ogw agent merge` has committed the merge, before it removes the worktree and sets `merged`. */
  mergeCommitted?: boolean;
  /** The agent CLI, model and effort that replace the role's harness settings `agents.<role>`; absent or null: those. */
  agent?: AgentSettings | null;
  /** content: the k of a variant agent of `ogw loop variants` (ogw.md `## loop variants`); absent or null otherwise. */
  variant?: number | null;
  /** content, translation: the seed-run of `--seed-run` (ogw.md `## agent`); absent or null otherwise. */
  seedRun?: { records: string; iteration: number } | null;
  /** A role with fix rounds: the session of the job (ogw.md `## agent`), which a new Codex session gets from its first run. */
  session?: AgentSession | null;
  /** spec review: the lines of what `ogw agent wait` wrote to the spec debt lists, once (`recordSpecDebt`). */
  debtLines?: string[];
  /** Set when the agent CLI ended: the usage of the job (ogw.md `### usage` of `## agent`). */
  usage?: AgentUsage;
  /** A job with a session: the token counts and cost of the session that the usage line of its last run printed. */
  sessionUsage?: SessionUsage;
  [key: string]: unknown;
}

/**
 * Harness settings of an agent job: for a job of a game, with the run settings of the open loop run of that game
 * (ogw.md `## loop start`).
 */
export async function jobHarnessSettings(ctx: Context, meta: Pick<AgentMeta, 'game'>): Promise<HarnessSettings> {
  return typeof meta.game === 'string' ? runHarnessSettings(ctx, await ctx.game(meta.game)) : ctx.settings();
}

/** The agent CLI, model and effort of the job: its own, else harness settings `agents.<role>`. */
export function jobAgentSettings(meta: AgentMeta, fromSettings: () => AgentSettings): AgentSettings {
  return meta.agent ?? fromSettings();
}

export function agentMeta(job: JobRecord): AgentMeta {
  if (job.command !== 'agent' || typeof job.meta.role !== 'string') throw new OgwError(`not an ogw agent job: ${job.id}`);
  return job.meta as AgentMeta;
}

export async function readAgentJob(id: string, env: NodeJS.ProcessEnv): Promise<{ job: JobRecord; meta: AgentMeta }> {
  const job = await readJob(id, env);
  return { job, meta: agentMeta(job) };
}

export async function changeAgentMeta(id: string, env: NodeJS.ProcessEnv, change: (meta: AgentMeta) => void): Promise<AgentMeta> {
  const job = await updateJob(id, (j) => {
    change(j.meta as AgentMeta);
  }, env);
  return agentMeta(job);
}

/** The result file when the agent wrote it, else null. */
export function resultFile(meta: AgentMeta): string | null {
  if (meta.outputWritten === false) return null;
  const output = meta.finalOutput ?? meta.output;
  if (output !== undefined && output !== '' && exists(output)) return output;
  // a merged core agent's worktree is removed: its result file is in the open-game-works-core-impl/ checkout
  const merged = meta.merged || meta.mergeCommitted === true ? mergedOutput(meta) : null;
  return merged !== null && exists(merged) ? merged : null;
}

/**
 * Where the result file is once `ogw agent merge` has merged the agent's work: for an agent in a core worktree,
 * the same path in the `open-game-works-core-impl/` checkout (the worktree is removed), else `output`.
 */
export function mergedOutput(meta: AgentMeta): string | null {
  if (meta.place.kind === 'core-worktree' && meta.outputRel !== null) return join(meta.place.coreImpl, meta.outputRel);
  return meta.output ?? null;
}

/** The folder of the jobs folder that holds every `ogw agent` job's agent CLI output and stdout and stderr files. */
export const AGENT_LOG_FOLDER = 'agent-logs';

export async function agentLogsDir(env: NodeJS.ProcessEnv): Promise<string> {
  return join(await jobsDir(env), AGENT_LOG_FOLDER);
}

/** The file the agent CLI output of a `ogw agent` job goes to. */
export async function agentCliLog(id: string, env: NodeJS.ProcessEnv): Promise<string> {
  return join(await agentLogsDir(env), `${id}.cli.log`);
}
