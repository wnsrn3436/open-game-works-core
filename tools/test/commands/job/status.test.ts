import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { isAlive, processStartedAt } from '../../../src/lib/proc.ts';
import { hostBootId, killJob, readJob, startJob, SUPERVISOR_START_GRACE_MS, updateJob, waitJob } from '../../../src/lib/jobs.ts';
import { ogw } from '../../helpers/workspace.ts';
import { jobWorkspace, writeJob } from './helpers.ts';

describe('ogw job status', () => {
  it('prints the status of a running job', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'abc1' });
    expect(await ogw(ws, ['job', 'status', 'abc1'])).toMatchObject({ code: 0, stdout: 'running\n' });
  });

  it('prints done and failed jobs and gives the JSON form', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'd1', status: 'done', exitCode: 0, endedAt: 5 });
    writeJob(ws.jobs, { id: 'f1', status: 'failed', exitCode: 3, endedAt: 5 });
    expect((await ogw(ws, ['job', 'status', 'd1'])).stdout).toBe('done\n');
    const json = await ogw(ws, ['job', 'status', 'f1', '--json']);
    expect(JSON.parse(json.stdout)).toEqual({ id: 'f1', status: 'failed', exitCode: 3, modules: null });
  });

  it('records a running job whose supervisor is gone as failed', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'gone1', supervisorPid: 2 ** 22 + 12345 });
    expect((await ogw(ws, ['job', 'status', 'gone1'])).stdout).toBe('failed\n');
    const job = await readJob('gone1', ws.env);
    expect(job.status).toBe('failed');
    expect(job.endedAt).toBeTypeOf('number');
  });

  it('records a running job that never got a supervisor pid as failed once the start grace time passed', async () => {
    const ws = jobWorkspace();
    // the process that wrote the record died, or could not spawn the supervisor, before it recorded its pid
    writeJob(ws.jobs, { id: 'nosup1', supervisorPid: null, startedAt: Date.now() - SUPERVISOR_START_GRACE_MS - 1000 });
    writeJob(ws.jobs, { id: 'nosup2', supervisorPid: null });
    expect((await ogw(ws, ['job', 'status', 'nosup1'])).stdout).toBe('failed\n');
    expect(await ogw(ws, ['job', 'wait', 'nosup1', '--timeout', '0'])).toMatchObject({ code: 1 });
    expect((await ogw(ws, ['job', 'status', 'nosup2'])).stdout).toBe('running\n');
  });

  it('prints the result of each finished module of a core test job', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'ct1', command: 'core test', meta: { modules: { routing: 'pass', shop: 'fail', mailbox: 'skipped' } } });
    const run = await ogw(ws, ['job', 'status', 'ct1']);
    expect(run.stdout).toBe('running\nrouting pass\nshop fail\nmailbox skipped\n');
    const json = JSON.parse((await ogw(ws, ['job', 'status', 'ct1', '--json'])).stdout) as { modules: unknown };
    expect(json.modules).toEqual({ routing: 'pass', shop: 'fail', mailbox: 'skipped' });
  });

  it('prints module results only for a core test job and only pass, fail and skipped', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'ag1', command: 'agent', meta: { role: 'core', modules: ['shop', 'mailbox'] } });
    writeJob(ws.jobs, { id: 'ag2', command: 'agent', meta: { role: 'content', modules: [] } });
    writeJob(ws.jobs, { id: 'ck1', command: 'check', meta: { modules: { shop: 'pass' } } });
    writeJob(ws.jobs, { id: 'ct2', command: 'core test', meta: { modules: { shop: 'pass', mailbox: 'running', x: 3 } } });
    writeJob(ws.jobs, { id: 'ct3', command: 'core test', meta: { modules: ['shop'] } });
    expect((await ogw(ws, ['job', 'status', 'ag1'])).stdout).toBe('running\n');
    expect(JSON.parse((await ogw(ws, ['job', 'status', 'ag1', '--json'])).stdout)).toMatchObject({ modules: null });
    expect(JSON.parse((await ogw(ws, ['job', 'status', 'ag2', '--json'])).stdout)).toMatchObject({ modules: null });
    expect((await ogw(ws, ['job', 'status', 'ck1'])).stdout).toBe('running\n');
    expect(JSON.parse((await ogw(ws, ['job', 'status', 'ck1', '--json'])).stdout)).toMatchObject({ modules: null });
    expect((await ogw(ws, ['job', 'status', 'ct2'])).stdout).toBe('running\nshop pass\n');
    expect((await ogw(ws, ['job', 'status', 'ct3'])).stdout).toBe('running\n');
  });

  it('ignores a modules field that is not an object', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'm2', command: 'core test', meta: { modules: 'x' } });
    writeJob(ws.jobs, { id: 'm3', command: 'core test', meta: { modules: null } });
    expect((await ogw(ws, ['job', 'status', 'm2'])).stdout).toBe('running\n');
    expect((await ogw(ws, ['job', 'status', 'm3'])).stdout).toBe('running\n');
  });

  it('fails for an unknown or invalid job id and for a wrong argument count', async () => {
    const ws = jobWorkspace();
    const missing = await ogw(ws, ['job', 'status', 'nope1']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe('job not found: nope1\n');
    const invalid = await ogw(ws, ['job', 'status', '../x']);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toBe('invalid job id: ../x\n');
    expect(await ogw(ws, ['job', 'status'])).toMatchObject({ code: 1, stderr: 'usage: ogw job status <id>\n' });
    expect(await ogw(ws, ['job', 'status', 'a', 'b'])).toMatchObject({ code: 1, stderr: 'usage: ogw job status <id>\n' });
  });

  it('kills the command process tree of a job whose supervisor is gone', async () => {
    const ws = jobWorkspace();
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const pid = child.pid as number;
    try {
      writeJob(ws.jobs, { id: 'orphan1', supervisorPid: 2 ** 22 + 12346, pid, pidStartedAt: processStartedAt(pid) });
      expect((await ogw(ws, ['job', 'status', 'orphan1'])).stdout).toBe('failed\n');
      for (let i = 0; i < 50 && isAlive(pid); i++) await sleep(100);
      expect(isAlive(pid)).toBe(false);
    } finally {
      if (isAlive(pid)) process.kill(-pid, 'SIGKILL');
    }
  });

  it('does not kill a pid that another process reused, or one recorded without its start time', async () => {
    const ws = jobWorkspace();
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const pid = child.pid as number;
    try {
      // the recorded start time is of the process that had the pid before
      writeJob(ws.jobs, { id: 'reused1', supervisorPid: 2 ** 22 + 12346, pid, pidStartedAt: 'Thu Jan  1 00:00:00 1970' });
      expect((await ogw(ws, ['job', 'status', 'reused1'])).stdout).toBe('failed\n');
      writeJob(ws.jobs, { id: 'unknown1', supervisorPid: 2 ** 22 + 12346, pid });
      expect((await ogw(ws, ['job', 'status', 'unknown1'])).stdout).toBe('failed\n');
      await sleep(200);
      expect(isAlive(pid)).toBe(true);
    } finally {
      process.kill(-pid, 'SIGKILL');
    }
  });

  it('does not kill an agent CLI pid that another process reused or that was recorded without its start time', async () => {
    const ws = jobWorkspace();
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const pid = child.pid as number;
    try {
      writeJob(ws.jobs, { id: 'clireused1', supervisorPid: 2 ** 22 + 12346, meta: { cliPid: pid, cliPidStartedAt: 'Thu Jan  1 00:00:00 1970' } });
      expect((await ogw(ws, ['job', 'status', 'clireused1'])).stdout).toBe('failed\n');
      writeJob(ws.jobs, { id: 'cliunknown1', supervisorPid: 2 ** 22 + 12346, meta: { cliPid: pid } });
      expect((await ogw(ws, ['job', 'status', 'cliunknown1'])).stdout).toBe('failed\n');
      // killJob of a job whose supervisor runs: the same check
      writeJob(ws.jobs, { id: 'clikill1', supervisorPid: null, meta: { cliPid: pid, cliPidStartedAt: 'Thu Jan  1 00:00:00 1970' } });
      await killJob('clikill1', ws.env, 100);
      expect((await readJob('clikill1', ws.env)).status).toBe('failed');
      await sleep(200);
      expect(isAlive(pid)).toBe(true);
    } finally {
      process.kill(-pid, 'SIGKILL');
    }
  });

  it('records a job from an earlier boot of the host as failed without killing its pids', async () => {
    const ws = jobWorkspace();
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const pid = child.pid as number;
    try {
      writeJob(ws.jobs, { id: 'boot1', pid, bootId: 'an-earlier-boot' });
      expect((await ogw(ws, ['job', 'status', 'boot1'])).stdout).toBe('failed\n');
      const job = await readJob('boot1', ws.env);
      expect(job.status).toBe('failed');
      expect(job.endedAt).toBeTypeOf('number');
      await sleep(200);
      expect(isAlive(pid)).toBe(true);
    } finally {
      process.kill(-pid, 'SIGKILL');
    }
  });

  it('keeps a job of this boot with a live supervisor running, also long past its time limit', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'slept1', startedAt: 1000, timeLimitMs: 500, bootId: 'boot-a' });
    expect((await readJob('slept1', ws.env, 'boot-a')).status).toBe('running');
    expect((await readJob('slept1', ws.env, 'boot-b')).status).toBe('failed');
  });

  it('skips the boot check when either boot id is unknown', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'old1', bootId: undefined });
    writeJob(ws.jobs, { id: 'old2', bootId: null });
    writeJob(ws.jobs, { id: 'old3', bootId: 'boot-a' });
    expect((await readJob('old1', ws.env, 'boot-b')).status).toBe('running');
    expect((await readJob('old2', ws.env, 'boot-b')).status).toBe('running');
    expect((await readJob('old3', ws.env, null)).status).toBe('running');
  });

  it('reads a boot id of this host that stays the same', () => {
    const id = hostBootId();
    if (process.platform === 'darwin' || process.platform === 'linux') expect(id).toMatch(/^[0-9A-Fa-f-]{36}$/);
    expect(hostBootId()).toBe(id);
  });

  it('records the start times of the supervisor and the command process', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'other2' });
    // the command waits on a job that runs until the test ends it, so it is still running when its record is read
    const id = await startJob({ argv: ['job', 'wait', 'other2', '--timeout', '60000'], cwd: ws.root, command: 'job wait', game: null, timeLimitMs: 60_000, agentJob: null, env: ws.env });
    // waits for the supervisor to record the command pid; on a loaded host (load average 45) that took over 5 s
    const deadline = Date.now() + 40_000;
    while ((await readJob(id, ws.env)).pid === null && Date.now() < deadline) await sleep(50);
    const job = await readJob(id, ws.env);
    expect(job.pid).not.toBeNull();
    expect(job.status).toBe('running');
    expect(job.pidStartedAt).toBe(processStartedAt(job.pid as number));
    expect(job.supervisorStartedAt).toBe(processStartedAt(job.supervisorPid as number));
    expect(typeof job.pidStartedAt).toBe('string');
    await updateJob('other2', (other) => {
      other.status = 'done';
      other.exitCode = 0;
      other.endedAt = Date.now();
    }, ws.env);
    await waitJob(id, 20_000, ws.env);
  }, 60_000);

  it('leaves a job that is no longer running as it is when its command ends', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'other1' });
    const id = await startJob({
      argv: ['job', 'wait', 'other1', '--timeout', '1500'],
      cwd: ws.root,
      command: 'job wait',
      game: null,
      timeLimitMs: 60_000,
      agentJob: null,
      env: ws.env,
    });
    await updateJob(id, (job) => {
      job.status = 'failed';
      job.endedAt = 7;
    }, ws.env);
    for (let i = 0; i < 100 && (await readJob(id, ws.env)).pid === null; i++) await sleep(50);
    await sleep(3000);
    const job = await readJob(id, ws.env);
    expect(job).toMatchObject({ status: 'failed', endedAt: 7, exitCode: null });
    await waitJob(id, 1000, ws.env);
  });
});
