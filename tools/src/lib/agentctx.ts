import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isNotFound, readJsonIfExists, writeJsonAtomic } from './fsx.ts';
import { AGENT_KEY_ENV, JobNotFound, jobsDir, onJobEnd, readJob, updateJob, type JobRecord } from './jobs.ts';

/** null for a job whose record is gone; any other read error is not "no agent". */
function gone(error: unknown): null {
  if (error instanceof JobNotFound) return null;
  throw error;
}
import { withLock } from './lock.ts';
import { withoutExtension } from './paths.ts';
import { ancestorPids, pidNamespace, samePidNamespace } from './proc.ts';
import type { Role } from './settings.ts';

/** Fields `ogw agent` keeps in the `meta` of its job. */
export interface AgentJobMeta {
  role: Role;
  /** pid of the agent CLI process. */
  cliPid: number | null;
  /** SHA-256 (hex) of the nonce of the agent key the agent CLI got (`newAgentKey`). */
  keyHash?: string;
  /** Absolute path of the result file. */
  output: string;
  /** Absolute path of the run log. */
  runLog: string;
  [key: string]: unknown;
}

export interface AgentContext {
  job: JobRecord;
  meta: AgentJobMeta;
}

export interface RunLogEntry {
  command: string;
  startedAt: number;
  exitCode: number | null;
  summary: unknown;
  /** Set for a command started with `--background`. */
  job?: string;
}

export interface RunLog {
  runs: RunLogEntry[];
  [key: string]: unknown;
}

function asAgent(job: JobRecord): AgentContext | null {
  if (job.command !== 'agent' || job.status !== 'running') return null;
  const meta = job.meta as Partial<AgentJobMeta>;
  if (typeof meta.role !== 'string' || typeof meta.runLog !== 'string') return null;
  return { job, meta: meta as AgentJobMeta };
}

/** Folder of the index of agent jobs whose agent CLI may be running: one empty file per job id. */
async function runningAgentsDir(env: NodeJS.ProcessEnv): Promise<string> {
  return join(await jobsDir(env), 'running-agents');
}

/**
 * Adds an agent job to the index of running agents. `ogw agent` calls it before it starts the agent CLI, and for play
 * and judge also right after it starts the job.
 */
export async function markAgentRunning(id: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dir = await runningAgentsDir(env);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, id), '');
}

async function unmarkAgentRunning(id: string, env: NodeJS.ProcessEnv): Promise<void> {
  await rm(join(await runningAgentsDir(env), id), { force: true });
}

/** The agents of the index whose job is running; index entries of jobs that are not running are removed. */
export async function runningAgents(env: NodeJS.ProcessEnv, ns: string | null = pidNamespace()): Promise<AgentContext[]> {
  let ids: string[];
  try {
    ids = await readdir(await runningAgentsDir(env));
  } catch (error) {
    // no agent has run yet; another read error is not "no running agent"
    if (isNotFound(error)) return [];
    throw error;
  }
  const agents: AgentContext[] = [];
  for (const id of ids) {
    const job = await readJob(id, env, undefined, ns).catch(gone);
    const agent = job === null ? null : asAgent(job);
    if (agent) agents.push(agent);
    else if (job === null || job.status !== 'running') await unmarkAgentRunning(id, env);
  }
  return agents.sort((a, b) => a.job.startedAt - b.job.startedAt || a.job.id.localeCompare(b.job.id));
}

/**
 * The agent CLI ended: the job leaves the index of running agents, and background jobs the agent started no longer
 * change its run log, so a job still running then keeps `exitCode` null. Runs under the run log lock.
 */
export async function agentCliEnded(id: string, env: NodeJS.ProcessEnv = process.env, knownRunLog?: string): Promise<void> {
  // `ogw agent` passes the run log path it set before the agent CLI started, not one read back from the record
  const runLog = knownRunLog ?? (await readJob(id, env)).meta.runLog;
  const end = async (): Promise<void> => {
    await updateJob(id, (j) => {
      j.meta.cliEnded = true;
    }, env);
    await unmarkAgentRunning(id, env);
  };
  if (typeof runLog === 'string') await withLock(`${runLog}.lock`, end);
  else await end();
}

function nonceHash(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

/**
 * A new agent key for agent job `id`: `value` goes to the agent CLI in `OGW_AGENT_KEY`, and only `hash` (of the
 * secret nonce) goes in the job record, so reading job records does not give the key of another agent.
 */
export function newAgentKey(id: string): { value: string; hash: string } {
  const nonce = randomBytes(32).toString('base64url');
  return { value: `${id}.${nonce}`, hash: nonceHash(nonce) };
}

/** The running agent whose key is `OGW_AGENT_KEY`, or null. */
async function agentByKey(env: NodeJS.ProcessEnv, ns: string | null): Promise<AgentContext | null> {
  const key = env[AGENT_KEY_ENV];
  const dot = key?.indexOf('.') ?? -1;
  if (key === undefined || dot <= 0) return null;
  const id = key.slice(0, dot);
  if (!/^[0-9a-z]+$/.test(id)) return null;
  const job = await readJob(id, env, undefined, ns).catch(gone);
  const agent = job === null ? null : asAgent(job);
  const recorded = agent?.meta.keyHash;
  if (agent === null || typeof recorded !== 'string') return null;
  const given = Buffer.from(nonceHash(key.slice(dot + 1)), 'hex');
  const expected = Buffer.from(recorded, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected) ? agent : null;
}

/**
 * The running agent this process belongs to: an agent whose CLI process is an ancestor of this process (pids of
 * this process's PID namespace only), else the agent whose key is in `OGW_AGENT_KEY`. The key reaches the
 * processes of a sandboxed agent CLI, where ancestor pids are not usable, and the background jobs an agent started.
 * Only the agents in the index of running agents are read for the ancestors, not every job record.
 */
export async function agentContext(env: NodeJS.ProcessEnv = process.env, ns: string | null = pidNamespace()): Promise<AgentContext | null> {
  const local = (await runningAgents(env, ns)).filter((a) => a.meta.cliPid !== null && samePidNamespace(a.job.pidNs, ns));
  if (local.length > 0) {
    // `ps` cannot run in the macOS sandbox: the key identifies the agent there
    const ancestors = new Set(await ancestorPids().catch(() => []));
    const byAncestry = local.find((a) => ancestors.has(a.meta.cliPid as number));
    if (byAncestry) return byAncestry;
  }
  return agentByKey(env, ns);
}

/** Path of the run log next to a result file: `<name without extension>-runs.json`. */
export function runLogPath(output: string): string {
  return `${withoutExtension(output)}-runs.json`;
}

async function changeRunLog(path: string, change: (log: RunLog) => void): Promise<void> {
  await withLock(`${path}.lock`, async () => {
    const log = (await readJsonIfExists<RunLog>(path)) ?? { runs: [] };
    change(log);
    await writeJsonAtomic(path, log);
  });
}

/** Adds a run log entry and returns its index. */
export async function appendRunLog(agent: AgentContext, entry: RunLogEntry): Promise<number> {
  let index = -1;
  await changeRunLog(agent.meta.runLog, (log) => {
    index = log.runs.push(entry) - 1;
  });
  return index;
}

export async function finishRunLog(agent: AgentContext, index: number, exitCode: number, summary: unknown): Promise<void> {
  await changeRunLog(agent.meta.runLog, (log) => {
    const entry = log.runs[index];
    if (entry) {
      entry.exitCode = exitCode;
      entry.summary = summary;
    }
  });
}

/** Adds fields at the top level of the run log, for example the translation counts. */
export async function addRunLogFields(path: string, fields: Record<string, unknown>): Promise<void> {
  await changeRunLog(path, (log) => {
    Object.assign(log, fields);
  });
}

/**
 * When a background job an agent started ends while the agent CLI still runs, its run log entry gets the exit code
 * and summary. After the agent CLI ended the run log is not changed: it may be committed, or its folder removed.
 */
export async function recordJobEnd(id: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const job = await readJob(id, env);
  const agentId = job.agentJob;
  if (!agentId) return;
  const open = (agent: JobRecord | null): agent is JobRecord => agent?.status === 'running' && agent.meta.cliEnded !== true;
  const first = await readJob(agentId, env).catch(() => null);
  // checked before taking the lock too: the lock folder must not bring back a removed worktree folder
  if (!open(first)) return;
  const runLog = first.meta.runLog;
  if (typeof runLog !== 'string') return;
  await withLock(`${runLog}.lock`, async () => {
    const agent = await readJob(agentId, env).catch(() => null);
    if (!open(agent) || agent.meta.runLog !== runLog) return;
    const log = await readJsonIfExists<RunLog>(runLog);
    const entry = log?.runs.find((e) => e.job === id);
    if (!log || !entry) return;
    entry.exitCode = job.exitCode;
    entry.summary = job.summary;
    await writeJsonAtomic(runLog, log);
  });
}

onJobEnd.push(recordJobEnd);
