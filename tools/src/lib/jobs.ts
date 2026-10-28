import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { OgwError } from './errors.ts';
import { exists, isNotFound, readJsonIfExists, writeJsonAtomic } from './fsx.ts';
import { commonDir } from './git.ts';
import { newId } from './ids.ts';
import { withLock } from './lock.ts';
import { cliEntry, harnessRoot } from './paths.ts';
import { hostBootId, isAlive, killRecordedGroup, killTree, pidNamespace, processStartedAt, recordedGroup, samePidNamespace } from './proc.ts';

export type JobStatus = 'running' | 'done' | 'failed';

export interface JobRecord {
  id: string;
  /** The command argv without `--background`. */
  argv: string[];
  cwd: string;
  /** Command name words joined with a space, for example `check` or `agent`. */
  command: string;
  /** Game the job works on, when the command takes one. */
  game: string | null;
  startedAt: number;
  endedAt: number | null;
  status: JobStatus;
  exitCode: number | null;
  supervisorPid: number | null;
  /** Start time of `supervisorPid` (`processStartedAt`), recorded by the supervisor. */
  supervisorStartedAt?: string | null;
  /** pid of the command process (its own process group). */
  pid: number | null;
  /** Start time of `pid` (`processStartedAt`), so a later process that reused the pid is not killed. */
  pidStartedAt?: string | null;
  timeLimitMs: number;
  /** The agent job whose agent started this job, when started from inside an agent. */
  agentJob: string | null;
  /** Value a command reports for the agent run log when it ends. */
  summary: unknown;
  /** Boot id of the host when the job started (`hostBootId`); its pids mean nothing after another boot. */
  bootId?: string | null;
  /** PID namespace (`pidNamespace`) of `supervisorPid`, `pid` and `meta.cliPid`; they mean nothing in another one. */
  pidNs?: string | null;
  /** Folder in the jobs folder that holds the job's stdout and stderr files, when not the jobs folder itself. */
  logFolder?: string;
  /** Command-specific fields, for example the agent role, input, output and CLI pid. */
  meta: Record<string, unknown>;
}

export interface JobPaths {
  dir: string;
  record: string;
  lock: string;
}

export interface JobLogPaths {
  dir: string;
  stdout: string;
  stderr: string;
}

const POLL_MS = 500;

export async function jobsDir(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const override = env.OGW_JOBS_DIR;
  if (override) return override;
  return join(await commonDir(harnessRoot(env), { env }), 'ogw-jobs');
}

export async function jobPaths(id: string, env: NodeJS.ProcessEnv = process.env): Promise<JobPaths> {
  if (!/^[0-9a-z]+$/.test(id)) throw new OgwError(`invalid job id: ${id}`);
  const dir = await jobsDir(env);
  return {
    dir,
    record: join(dir, `${id}.json`),
    lock: join(dir, `${id}.lock`),
  };
}

/** The stdout and stderr files of a job: in its `logFolder` of the jobs folder, else in the jobs folder. */
export async function jobLogPaths(job: Pick<JobRecord, 'id' | 'logFolder'>, env: NodeJS.ProcessEnv = process.env): Promise<JobLogPaths> {
  const { dir: jobs } = await jobPaths(job.id, env);
  const dir = job.logFolder === undefined ? jobs : join(jobs, job.logFolder);
  return { dir, stdout: join(dir, `${job.id}.stdout`), stderr: join(dir, `${job.id}.stderr`) };
}

/** No record of the job: it never started or its record was removed. */
export class JobNotFound extends OgwError {}

export async function readJobRaw(id: string, env: NodeJS.ProcessEnv = process.env): Promise<JobRecord> {
  const paths = await jobPaths(id, env);
  const record = await readJsonIfExists<JobRecord>(paths.record);
  if (!record) throw new JobNotFound(`job not found: ${id}`);
  return record;
}

export { hostBootId } from './proc.ts';

/** The environment variable that carries `<agent job id>.<nonce>` to an agent CLI and the processes it starts. */
export const AGENT_KEY_ENV = 'OGW_AGENT_KEY';

/**
 * Kills the job's command process group and agent CLI process group, each only while it is the recorded group
 * (`recordedGroup`): a pid that another live process reused, or a live one whose start time cannot be read, is left.
 */
function killProcesses(job: JobRecord): void {
  if (job.pid !== null) killRecordedGroup(job.pid, job.pidStartedAt, 'SIGKILL');
  const cli = job.meta.cliPid;
  if (typeof cli === 'number') killRecordedGroup(cli, job.meta.cliPidStartedAt, 'SIGKILL');
}

/** Whether the recorded supervisor is gone: its pid is not alive, or a process with another start time has it. */
function supervisorGoneOf(job: JobRecord): boolean {
  const pid = job.supervisorPid;
  if (pid === null) return false;
  if (!isAlive(pid)) return true;
  if (typeof job.supervisorStartedAt !== 'string') return false;
  const now = processStartedAt(pid);
  return now !== null && now !== job.supervisorStartedAt;
}

function markFailed(id: string, env: NodeJS.ProcessEnv): Promise<JobRecord> {
  return updateJob(id, (job) => {
    if (job.status === 'running') {
      job.status = 'failed';
      job.endedAt = Date.now();
    }
  }, env);
}

/**
 * Time `startJob` gets from writing the `running` record to recording the supervisor pid. A record still without a
 * supervisor pid after it was written by a process that died or could not spawn the supervisor.
 */
export const SUPERVISOR_START_GRACE_MS = 60_000;

/**
 * Reads a job. A `running` job started in an earlier boot of the host is recorded as `failed`; its pids are not
 * killed, because they may now belong to other processes. A `running` job of this boot whose supervisor is gone,
 * or that has no supervisor pid `SUPERVISOR_START_GRACE_MS` after it started, is recorded as `failed` after its
 * command process tree is killed. A job whose pids are of another PID namespace than `ns` (inside or outside a play
 * or judge sandbox) is returned as recorded.
 */
export async function readJob(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  bootId: string | null = hostBootId(),
  ns: string | null = pidNamespace(),
): Promise<JobRecord> {
  const record = await readJobRaw(id, env);
  if (record.status !== 'running') return record;
  const earlierBoot = typeof record.bootId === 'string' && bootId !== null && record.bootId !== bootId;
  if (earlierBoot) return markFailed(id, env);
  if (!samePidNamespace(record.pidNs, ns)) return record;
  const supervisorGone = supervisorGoneOf(record);
  const thisBoot = typeof record.bootId === 'string' && record.bootId === bootId;
  const neverSupervised = thisBoot && record.supervisorPid === null && Date.now() - record.startedAt >= SUPERVISOR_START_GRACE_MS;
  if (supervisorGone || neverSupervised) {
    killProcesses(record);
    return markFailed(id, env);
  }
  return record;
}

/** Folder of the index of the jobs that agent job `agentJob` started: one empty file per job id. */
async function agentJobsDir(agentJob: string, env: NodeJS.ProcessEnv): Promise<string> {
  const { dir } = await jobPaths(agentJob, env);
  return join(dir, 'agent-jobs', agentJob);
}

/**
 * The play or judge agent CLI ended: the jobs that agent started and that still run end with it. A job of this PID
 * namespace is killed (`killJob`); a job of another PID namespace (a sandbox namespace) ended with that namespace and
 * is recorded as `failed`. Only the jobs in the agent's index are read, and the index is removed.
 */
export async function endJobsOfAgent(agentJob: string, env: NodeJS.ProcessEnv = process.env, ns: string | null = pidNamespace()): Promise<void> {
  const dir = await agentJobsDir(agentJob, env);
  let ids: string[];
  try {
    ids = await readdir(dir);
  } catch {
    return;
  }
  for (const id of ids) {
    const job = await readJob(id, env, hostBootId(), ns).catch((error: unknown) => {
      if (error instanceof JobNotFound) return null;
      throw error;
    });
    if (job === null || job.agentJob !== agentJob || job.status !== 'running') continue;
    if (samePidNamespace(job.pidNs, ns)) await killJob(job.id, env, KILL_GRACE_MS, ns).catch(() => undefined);
    else await markFailed(job.id, env);
  }
  await rm(dir, { recursive: true, force: true });
}

export async function updateJob(
  id: string,
  change: (job: JobRecord) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<JobRecord> {
  const paths = await jobPaths(id, env);
  return withLock(paths.lock, async () => {
    const job = await readJobRaw(id, env);
    change(job);
    await writeJsonAtomic(paths.record, job);
    return job;
  });
}

export async function listJobs(env: NodeJS.ProcessEnv = process.env, ns: string | null = pidNamespace()): Promise<JobRecord[]> {
  const dir = await jobsDir(env);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  // job records only: other files of the folder have names that are not job ids
  const ids = names.filter((name) => /^[0-9a-z]+\.json$/.test(name)).map((name) => name.slice(0, -'.json'.length));
  const jobs: JobRecord[] = [];
  for (const id of ids) {
    try {
      jobs.push(await readJob(id, env, hostBootId(), ns));
    } catch (error) {
      // a record removed after the folder was read; records are written whole (temp file and rename), so any other
      // error is a real one
      if (!(error instanceof JobNotFound)) throw error;
    }
  }
  return jobs.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}

export interface StartJobOptions {
  argv: string[];
  cwd: string;
  command: string;
  game: string | null;
  timeLimitMs: number;
  agentJob: string | null;
  meta?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  /** `JobRecord.logFolder`: a plain folder name. */
  logFolder?: string;
  /** The job id, made with `newId` by a caller that names a file after it before the job starts. */
  id?: string;
}

/**
 * Starts a command as a background job: a detached supervisor runs it, applies the time limit,
 * and records the exit code. Returns the job id.
 */
export async function startJob(options: StartJobOptions): Promise<string> {
  const env = options.env ?? process.env;
  if (options.logFolder !== undefined && !/^[0-9a-z-]+$/.test(options.logFolder)) throw new OgwError(`invalid job log folder: ${options.logFolder}`);
  const id = options.id ?? newId();
  const paths = await jobPaths(id, env);
  if (options.id !== undefined && exists(paths.record)) throw new OgwError(`job ${id} exists`);
  if (options.agentJob !== null) {
    // in the index before the record, so that `endJobsOfAgent` finds every job of the agent that has a record
    const index = await agentJobsDir(options.agentJob, env);
    await mkdir(index, { recursive: true });
    await writeFile(join(index, id), '');
  }
  const record: JobRecord = {
    id,
    argv: options.argv,
    cwd: options.cwd,
    command: options.command,
    game: options.game,
    startedAt: Date.now(),
    endedAt: null,
    status: 'running',
    exitCode: null,
    supervisorPid: null,
    bootId: hostBootId(),
    pidNs: pidNamespace(),
    pid: null,
    timeLimitMs: options.timeLimitMs,
    agentJob: options.agentJob,
    summary: null,
    ...(options.logFolder === undefined ? {} : { logFolder: options.logFolder }),
    meta: options.meta ?? {},
  };
  await writeJsonAtomic(paths.record, record);
  const supervisor = spawn(process.execPath, [...process.execArgv, cliEntry(), '__job-supervise', id], {
    cwd: options.cwd,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  supervisor.unref();
  // a spawn failure (EAGAIN, ENOMEM) also comes as an `error` event: the record is marked failed below
  supervisor.on('error', () => undefined);
  if (supervisor.pid === undefined) {
    await markFailed(id, env);
    throw new OgwError('cannot start job supervisor');
  }
  const pid = supervisor.pid;
  await updateJob(id, (job) => {
    job.supervisorPid ??= pid;
  }, env);
  return id;
}

/**
 * The environment of a job command: `OGW_JOB_ID`, and the agent key (`OGW_AGENT_KEY`) the starting process had
 * only when the job was started from inside that agent.
 */
export function jobEnv(env: NodeJS.ProcessEnv, job: Pick<JobRecord, 'id' | 'agentJob'>): NodeJS.ProcessEnv {
  const key = env[AGENT_KEY_ENV];
  const keep = job.agentJob !== null && key !== undefined && key.startsWith(`${job.agentJob}.`);
  const rest = Object.fromEntries(Object.entries(env).filter(([name]) => name !== AGENT_KEY_ENV));
  return { ...rest, OGW_JOB_ID: job.id, ...(keep ? { [AGENT_KEY_ENV]: key } : {}) };
}

/** Runs inside the supervisor process: runs the job command and records how it ended. */
export async function superviseJob(id: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const job = await updateJob(id, (j) => {
    j.supervisorPid = process.pid;
    j.supervisorStartedAt = processStartedAt(process.pid);
  }, env);
  const paths = await jobLogPaths(job, env);
  mkdirSync(paths.dir, { recursive: true });
  const out = openSync(paths.stdout, 'a');
  const err = openSync(paths.stderr, 'a');
  const child = spawn(process.execPath, [...process.execArgv, cliEntry(), ...job.argv], {
    cwd: job.cwd,
    env: jobEnv(env, job),
    detached: process.platform !== 'win32',
    stdio: ['ignore', out, err],
    windowsHide: true,
  });
  closeSync(out);
  closeSync(err);
  if (child.pid !== undefined) {
    const pid = child.pid;
    await updateJob(id, (j) => {
      j.pid = pid;
      j.pidStartedAt = processStartedAt(pid);
    }, env);
  }
  const stop = (): void => {
    killTree(child, 'SIGTERM');
    setTimeout(() => {
      killTree(child, 'SIGKILL');
    }, 5000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const timer = setTimeout(stop, job.timeLimitMs);
  const code = await new Promise<number | null>((resolvePromise) => {
    child.on('error', () => {
      resolvePromise(null);
    });
    child.on('exit', (exitCode) => {
      resolvePromise(exitCode);
    });
  });
  clearTimeout(timer);
  // children the command left behind belong to the job and end with it
  killTree(child, 'SIGKILL');
  const ended = await updateJob(id, (j) => {
    // a job `killJob` already recorded as failed stays as it was
    if (j.status !== 'running') return;
    j.endedAt = Date.now();
    j.exitCode = code;
    j.status = code === 0 ? 'done' : 'failed';
  }, env);
  // the agent CLI runs in its own process group, which the SIGKILL of the command group does not reach
  killProcesses(ended);
  for (const hook of onJobEnd) await hook(id, env).catch(() => undefined);
}

/** Hooks the supervisor runs after a job ends. The agent run log registers one. */
export const onJobEnd: ((id: string, env: NodeJS.ProcessEnv) => Promise<void>)[] = [];

export interface WaitResult {
  job: JobRecord;
  finished: boolean;
  stdout: string;
  stderr: string;
}

/** Waits until the job ends or `timeoutMs` passes. */
export async function waitJob(id: string, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await readJob(id, env);
    if (job.status !== 'running') {
      const paths = await jobLogPaths(job, env);
      // a job that wrote nothing has no output file; another read error is not an empty output
      const output = (path: string): Promise<string> => readFile(path, 'utf8').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      });
      const stdout = await output(paths.stdout);
      const stderr = await output(paths.stderr);
      return { job, finished: true, stdout, stderr };
    }
    if (Date.now() >= deadline) return { job, finished: false, stdout: '', stderr: '' };
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

/** Time a job command process gets after SIGTERM to stop the processes it started, before SIGKILL. */
export const KILL_GRACE_MS = 5000;

/** Whether process `pid` or (posix) a member of its process group is still running. */
function groupAlive(pid: number): boolean {
  if (isAlive(pid)) return true;
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

/** Waits until the process group `pid` has no member (its leader included) or `timeoutMs` passes. */
async function waitGone(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (groupAlive(pid) && Date.now() < deadline) await sleep(50);
}

/**
 * Kills a running job and records it as `failed`. The command process gets SIGTERM first so that it stops the
 * processes it started in their own process groups; then the command and agent CLI process groups get SIGKILL.
 */
export async function killJob(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  graceMs: number = KILL_GRACE_MS,
  ns: string | null = pidNamespace(),
): Promise<void> {
  const job = await readJob(id, env, hostBootId(), ns);
  if (job.status !== 'running') return;
  if (!samePidNamespace(job.pidNs, ns)) {
    throw new OgwError(`job ${id} runs in the PID namespace of a play or judge sandbox; it ends with that sandbox`);
  }
  if (job.pid !== null && recordedGroup(job.pid, job.pidStartedAt)) {
    killRecordedGroup(job.pid, job.pidStartedAt, 'SIGTERM');
    await waitGone(job.pid, graceMs);
  }
  killProcesses(job);
  if (job.supervisorPid !== null && !supervisorGoneOf(job)) killRecordedGroup(job.supervisorPid, job.supervisorStartedAt, 'SIGTERM');
  await markFailed(id, env);
}
