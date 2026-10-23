import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJsonAtomic } from '../../src/lib/fsx.ts';
import { hostBootId, jobPaths, killJob, readJob, type JobRecord } from '../../src/lib/jobs.ts';
import { isAlive, processStartedAt } from '../../src/lib/proc.ts';
import { cleanup, ended, startSleeper, startTrackedParent, waitDead } from '../helpers/procs.ts';

const left: (number | undefined)[] = [];

afterEach(() => {
  cleanup(left.splice(0));
});

function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'ogw-kill-')));
}

describe('an ogw process on SIGTERM', () => {
  it('stops the processes it started in their own process groups and exits with 143', async () => {
    const { parent, child } = await startTrackedParent(tempDir());
    left.push(parent.pid, child);
    expect(isAlive(child)).toBe(true);
    process.kill(parent.pid as number, 'SIGTERM');
    expect(await ended(parent)).toEqual({ code: 143, signal: null });
    expect(await waitDead(child)).toBe(true);
  });

  it('leaves the signal to another handler of the process', async () => {
    const { parent, child } = await startTrackedParent(tempDir(), { ownHandler: true });
    left.push(parent.pid, child);
    process.kill(parent.pid as number, 'SIGTERM');
    await sleep(500);
    expect(isAlive(parent.pid as number)).toBe(true);
    expect(isAlive(child)).toBe(true);
  });
});

async function writeJob(env: NodeJS.ProcessEnv, fields: Partial<JobRecord>): Promise<JobRecord> {
  const job: JobRecord = {
    id: `k${String(Date.now())}${String(Math.random()).slice(2, 8)}`,
    argv: [],
    cwd: '/',
    command: 'check',
    game: 'g',
    startedAt: Date.now(),
    endedAt: null,
    status: 'running',
    exitCode: null,
    supervisorPid: null,
    pid: null,
    timeLimitMs: 1000,
    agentJob: null,
    summary: null,
    meta: {},
    ...fields,
  };
  await writeJsonAtomic((await jobPaths(job.id, env)).record, job);
  return job;
}

describe('processStartedAt', () => {
  it.runIf(process.platform !== 'win32')('gives the same text whatever the locale and time zone of the process that asks', () => {
    const sleeper = startSleeper();
    left.push(sleeper.pid);
    const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
    try {
      process.env.TZ = 'Asia/Seoul';
      process.env.LC_ALL = 'ko_KR.UTF-8';
      const seoul = processStartedAt(sleeper.pid as number);
      process.env.TZ = 'America/Los_Angeles';
      process.env.LC_ALL = 'C';
      expect(processStartedAt(sleeper.pid as number)).toBe(seoul);
      expect(seoul).not.toBeNull();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });
});

describe('killJob', () => {
  it('ends the command process, the processes it started, and the agent CLI process tree', async () => {
    const dir = tempDir();
    const env = { ...process.env, OGW_JOBS_DIR: join(dir, 'jobs') };
    const { parent, child } = await startTrackedParent(dir);
    const cli = startSleeper();
    left.push(parent.pid, child, cli.pid);
    const job = await writeJob(env, { pid: parent.pid, pidStartedAt: processStartedAt(parent.pid as number), meta: { cliPid: cli.pid, cliPidStartedAt: processStartedAt(cli.pid as number) } });
    await killJob(job.id, env);
    expect(await ended(parent)).toEqual({ code: 143, signal: null });
    expect(await waitDead(child)).toBe(true);
    expect(await waitDead(cli.pid as number)).toBe(true);
    expect((await readJob(job.id, env)).status).toBe('failed');
  });

  it('sends SIGKILL to a command process still running after the grace time', async () => {
    const dir = tempDir();
    const env = { ...process.env, OGW_JOBS_DIR: join(dir, 'jobs') };
    const { parent } = await startTrackedParent(dir, { ignoreTerm: true });
    left.push(parent.pid);
    const job = await writeJob(env, { pid: parent.pid, pidStartedAt: processStartedAt(parent.pid as number) });
    const start = Date.now();
    await killJob(job.id, env, 300);
    expect(Date.now() - start).toBeGreaterThanOrEqual(300);
    expect(await ended(parent)).toEqual({ code: null, signal: 'SIGKILL' });
    expect((await readJob(job.id, env)).status).toBe('failed');
  });

  it('kills a member of the command process group that outlives SIGTERM after the group leader ended', async () => {
    const dir = tempDir();
    const env = { ...process.env, OGW_JOBS_DIR: join(dir, 'jobs') };
    const leader = spawn('sh', ['-c', '(trap "" TERM; sleep 60) & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const member = await new Promise<number>((done) => leader.stdout.once('data', (data: Buffer) => {
      done(Number(data.toString().trim()));
    }));
    left.push(leader.pid, member);
    const job = await writeJob(env, { pid: leader.pid, pidStartedAt: processStartedAt(leader.pid as number) });
    await killJob(job.id, env, 300);
    expect(await waitDead(member)).toBe(true);
    expect((await readJob(job.id, env)).status).toBe('failed');
  });

  it('records a job failed and kills its command when another process reused the supervisor pid', async () => {
    const dir = tempDir();
    const env = { ...process.env, OGW_JOBS_DIR: join(dir, 'jobs') };
    const reused = startSleeper();
    const command = startSleeper();
    left.push(reused.pid, command.pid);
    const job = await writeJob(env, {
      supervisorPid: reused.pid,
      supervisorStartedAt: 'Thu Jan  1 00:00:00 1970',
      pid: command.pid,
      pidStartedAt: processStartedAt(command.pid as number),
      bootId: hostBootId(),
    });
    expect((await readJob(job.id, env)).status).toBe('failed');
    expect(await waitDead(command.pid as number)).toBe(true);
    expect(isAlive(reused.pid as number)).toBe(true);
  });

  it('gives the members of a group whose leader is gone the SIGTERM grace time before SIGKILL', async () => {
    const dir = tempDir();
    const env = { ...process.env, OGW_JOBS_DIR: join(dir, 'jobs') };
    // the leader ends at once on SIGTERM; its member ends 300 ms after its own SIGTERM
    const leader = spawn('sh', ['-c', '(trap "sleep 0.3; exit 0" TERM; while :; do sleep 0.05; done) & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const member = await new Promise<number>((done) => leader.stdout.once('data', (data: Buffer) => {
      done(Number(data.toString().trim()));
    }));
    left.push(leader.pid, member);
    const job = await writeJob(env, { pid: leader.pid, pidStartedAt: processStartedAt(leader.pid as number) });
    const memberEnded = new Promise<string>((resolve) => {
      const poll = setInterval(() => {
        if (!isAlive(member)) {
          clearInterval(poll);
          resolve('gone');
        }
      }, 20);
    });
    const started = Date.now();
    await killJob(job.id, env, 3000);
    expect(await memberEnded).toBe('gone');
    // it ended by its own SIGTERM handler within the grace time, not by an early SIGKILL
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('leaves a job running while its live supervisor has no recorded start time, or its start time cannot be read', async () => {
    const dir = tempDir();
    const env = { ...process.env, OGW_JOBS_DIR: join(dir, 'jobs') };
    const supervisor = startSleeper();
    const command = startSleeper();
    left.push(supervisor.pid, command.pid);
    const unrecorded = await writeJob(env, { supervisorPid: supervisor.pid, supervisorStartedAt: null, pid: command.pid, pidStartedAt: processStartedAt(command.pid as number), bootId: hostBootId() });
    expect((await readJob(unrecorded.id, env)).status).toBe('running');
    // a `ps` that cannot run (the macOS sandbox): a recorded start time that cannot be read now is not a reused pid
    const recorded = await writeJob(env, { supervisorPid: supervisor.pid, supervisorStartedAt: processStartedAt(supervisor.pid as number), pid: command.pid, pidStartedAt: processStartedAt(command.pid as number), bootId: hostBootId() });
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ''}`;
    try {
      expect((await readJob(recorded.id, env)).status).toBe('running');
    } finally {
      process.env.PATH = path;
    }
    expect(isAlive(command.pid as number)).toBe(true);
  });

  it('leaves a live command and agent CLI alone when their start times cannot be read, and records the job failed', async () => {
    const dir = tempDir();
    const env = { ...process.env, OGW_JOBS_DIR: join(dir, 'jobs') };
    const command = startSleeper();
    const cli = startSleeper();
    left.push(command.pid, cli.pid);
    // the supervisor is gone; the recorded start times are right, but `ps` cannot run (the macOS sandbox)
    const job = await writeJob(env, {
      supervisorPid: 2 ** 22 + 12347,
      pid: command.pid,
      pidStartedAt: processStartedAt(command.pid as number),
      meta: { cliPid: cli.pid, cliPidStartedAt: processStartedAt(cli.pid as number) },
      bootId: hostBootId(),
    });
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ''}`;
    try {
      expect((await readJob(job.id, env)).status).toBe('failed');
    } finally {
      process.env.PATH = path;
    }
    await sleep(200);
    expect(isAlive(command.pid as number)).toBe(true);
    expect(isAlive(cli.pid as number)).toBe(true);
  });

  it('does nothing to a job that ended', async () => {
    const dir = tempDir();
    const env = { ...process.env, OGW_JOBS_DIR: join(dir, 'jobs') };
    const cli = startSleeper();
    left.push(cli.pid);
    const job = await writeJob(env, { status: 'done', exitCode: 0, meta: { cliPid: cli.pid } });
    await killJob(job.id, env);
    expect(isAlive(cli.pid as number)).toBe(true);
    expect((await readJob(job.id, env)).status).toBe('done');
  });
});
