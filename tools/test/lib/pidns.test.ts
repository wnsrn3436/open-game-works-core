// Pids of another PID namespace (the Linux play and judge sandbox) never decide liveness, kills or lock takeover.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { endJobsOfAgent, jobEnv, killJob, readJob, startJob, waitJob } from '../../src/lib/jobs.ts';
import { isStale, withLock } from '../../src/lib/lock.ts';
import { hostBootId, pidNamespace, processStartedAt, samePidNamespace } from '../../src/lib/proc.ts';
import { jobWorkspace, writeJob } from '../commands/job/helpers.ts';

/** A pid that no process has. */
const GONE = 2 ** 22 + 12_345;

describe('PID namespace of jobs', () => {
  it('is the /proc/self/ns/pid inode on Linux and null elsewhere; a record without one is of the same namespace', () => {
    expect(pidNamespace()).toEqual(process.platform === 'linux' ? expect.stringMatching(/^[0-9]+$/) : null);
    expect(samePidNamespace(undefined, '1')).toBe(true);
    expect(samePidNamespace('1', '1')).toBe(true);
    expect(samePidNamespace(null, null)).toBe(true);
    expect(samePidNamespace('1', '2')).toBe(false);
    expect(samePidNamespace(null, '2')).toBe(false);
  });

  it('does not mark a job of another namespace failed when its supervisor pid is not alive here', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'in1', supervisorPid: GONE, pidNs: '111' });
    expect((await readJob('in1', ws.env, undefined, '222')).status).toBe('running');
    expect((await readJob('in1', ws.env, undefined, '111')).status).toBe('failed');
    writeJob(ws.jobs, { id: 'old1', supervisorPid: GONE });
    expect((await readJob('old1', ws.env, undefined, '222')).status).toBe('failed');
  });

  it('does not kill by pid in another namespace', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'k1', supervisorPid: process.pid, pid: GONE, pidNs: '111' });
    await expect(killJob('k1', ws.env, 0, '222')).rejects.toThrow('PID namespace of a play or judge sandbox');
    expect(JSON.parse(readFileSync(join(ws.jobs, 'k1.json'), 'utf8'))).toMatchObject({ status: 'running' });
  });

  it('ends the running jobs of an ended agent: kills those of this namespace, marks failed those of another', async () => {
    const ws = jobWorkspace();
    const sleeper = (): ChildProcess => spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const [supervisor, command, otherSupervisor] = [sleeper(), sleeper(), sleeper()];
    const gone = (child: ChildProcess): Promise<void> =>
      new Promise((resolve) => {
        child.once('exit', () => {
          resolve();
        });
      });
    try {
      writeJob(ws.jobs, { id: 'sb1', agentJob: 'ag1', supervisorPid: 5, pidNs: '111' });
      // the start times a supervisor records: a pid is signalled only while it is the recorded process
      const startedAt = (child: ChildProcess): string | null => processStartedAt(child.pid as number);
      writeJob(ws.jobs, { id: 'out1', agentJob: 'ag1', supervisorPid: supervisor.pid ?? null, supervisorStartedAt: startedAt(supervisor), pid: command.pid ?? null, pidStartedAt: startedAt(command), pidNs: '222' });
      writeJob(ws.jobs, { id: 'other1', agentJob: 'ag2', supervisorPid: otherSupervisor.pid ?? null, supervisorStartedAt: startedAt(otherSupervisor), pidNs: '222' });
      writeJob(ws.jobs, { id: 'done1', agentJob: 'ag1', supervisorPid: 5, pidNs: '111', status: 'done', exitCode: 0, endedAt: 1 });
      // a record of the agent that is not in its index is not read
      writeJob(ws.jobs, { id: 'unlisted1', agentJob: 'ag1', supervisorPid: 5, pidNs: '111' });
      rmSync(join(ws.jobs, 'agent-jobs', 'ag1', 'unlisted1'));
      const ended = Promise.all([gone(supervisor), gone(command)]);
      await endJobsOfAgent('ag1', ws.env, '222');
      await ended;
      const status = (id: string): string => (JSON.parse(readFileSync(join(ws.jobs, `${id}.json`), 'utf8')) as { status: string }).status;
      expect([status('sb1'), status('out1'), status('other1'), status('done1'), status('unlisted1')]).toEqual(['failed', 'failed', 'running', 'done', 'running']);
      expect(otherSupervisor.exitCode).toBeNull();
      expect(existsSync(join(ws.jobs, 'agent-jobs', 'ag1'))).toBe(false);
      expect(readdirSync(join(ws.jobs, 'agent-jobs', 'ag2'))).toEqual(['other1']);
      await endJobsOfAgent('ag1', ws.env, '222');
    } finally {
      for (const child of [supervisor, command, otherSupervisor]) child.kill('SIGKILL');
    }
  });

  it('writes a job an agent starts in the index of the jobs of that agent', async () => {
    const ws = jobWorkspace();
    const id = await startJob({ argv: ['job', 'status', 'nojob'], cwd: ws.root, command: 'job status', game: null, timeLimitMs: 60_000, agentJob: 'ag4', env: ws.env });
    const other = await startJob({ argv: ['job', 'status', 'nojob'], cwd: ws.root, command: 'job status', game: null, timeLimitMs: 60_000, agentJob: null, env: ws.env });
    expect(readdirSync(join(ws.jobs, 'agent-jobs'))).toEqual(['ag4']);
    expect(readdirSync(join(ws.jobs, 'agent-jobs', 'ag4'))).toEqual([id]);
    await Promise.all([waitJob(id, 30_000, ws.env), waitJob(other, 30_000, ws.env)]);
  });

  it('passes the agent key to a job command only when the job was started from inside that agent', () => {
    const env = { PATH: '/bin', OGW_AGENT_KEY: 'ag1.nonce', OGW_JOB_ID: 'x' };
    expect(jobEnv(env, { id: 'j1', agentJob: 'ag1' })).toEqual({ PATH: '/bin', OGW_JOB_ID: 'j1', OGW_AGENT_KEY: 'ag1.nonce' });
    expect(jobEnv(env, { id: 'j2', agentJob: null })).toEqual({ PATH: '/bin', OGW_JOB_ID: 'j2' });
    expect(jobEnv(env, { id: 'j3', agentJob: 'ag10' })).toEqual({ PATH: '/bin', OGW_JOB_ID: 'j3' });
  });
});

describe('PID namespace of locks', () => {
  it('writes the owner pid, namespace and boot id, and takes over only a lock of a gone owner in the same namespace', async () => {
    const ws = jobWorkspace();
    const lock = join(ws.root, 'a.lock');
    await withLock(lock, () => {
      expect(readFileSync(join(lock, 'pid'), 'utf8').split('\n').slice(0, 3)).toEqual([String(process.pid), pidNamespace() ?? '', hostBootId() ?? '']);
      return Promise.resolve();
    });
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), `${String(GONE)}\n111\n`);
    expect(await isStale(lock, '222')).toBe(false);
    expect(await isStale(lock, '111')).toBe(true);
    writeFileSync(join(lock, 'pid'), `${String(GONE)}\n\n`);
    expect(await isStale(lock, null)).toBe(true);
    expect(await isStale(lock, '111')).toBe(false);
    // a lock written before namespaces were recorded
    writeFileSync(join(lock, 'pid'), String(GONE));
    expect(await isStale(lock, '222')).toBe(true);
    writeFileSync(join(lock, 'pid'), `${String(process.pid)}\n111\n`);
    expect(await isStale(lock, '111')).toBe(false);
  });
});
