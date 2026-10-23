import { describe, expect, it } from 'vitest';
import { ogw } from '../../helpers/workspace.ts';
import { jobWorkspace, writeJob } from './helpers.ts';

describe('ogw job wait', () => {
  it('prints the output of a finished job and ends with its exit code', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'w1', status: 'failed', exitCode: 4, endedAt: 9 }, { stdout: 'out line\n', stderr: 'err line\n' });
    const run = await ogw(ws, ['job', 'wait', 'w1']);
    expect(run).toEqual({ code: 4, stdout: 'out line\n', stderr: 'err line\n' });
  });

  it('ends with 0 for a done job and prints nothing for empty output', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'w2', status: 'done', exitCode: 0, endedAt: 9 });
    expect(await ogw(ws, ['job', 'wait', 'w2'])).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('ends with 1 for a job that ended without an exit code', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'w3', status: 'failed', exitCode: null, endedAt: 9 }, { stdout: 'x\n' });
    expect((await ogw(ws, ['job', 'wait', 'w3'])).code).toBe(1);
  });

  it('gives the JSON form', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'w4', status: 'done', exitCode: 0, endedAt: 9 }, { stdout: 'a\n', stderr: 'b\n' });
    const run = await ogw(ws, ['job', 'wait', 'w4', '--json']);
    expect(JSON.parse(run.stdout)).toEqual({ status: 'done', exitCode: 0, stdout: 'a\n', stderr: 'b\n' });
  });

  it('prints running and ends with 75 when the timeout passes', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'r1' });
    expect(await ogw(ws, ['job', 'wait', 'r1', '--timeout', '0'])).toEqual({ code: 75, stdout: 'running\n', stderr: '' });
    const json = await ogw(ws, ['job', 'wait', 'r1', '--timeout', '0', '--json']);
    expect(json.code).toBe(75);
    expect(JSON.parse(json.stdout)).toEqual({ status: 'running' });
  });

  it('waits at most harness settings jobWaitTimeoutMs without --timeout', async () => {
    const ws = jobWorkspace({ jobWaitTimeoutMs: 0 });
    writeJob(ws.jobs, { id: 'r2' });
    expect((await ogw(ws, ['job', 'wait', 'r2'])).code).toBe(75);
  });

  it('rejects an invalid --timeout and a wrong argument count', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'r3' });
    for (const bad of ['-1', '1.5', 'abc']) {
      expect(await ogw(ws, ['job', 'wait', 'r3', `--timeout=${bad}`])).toMatchObject({ code: 1, stderr: `invalid --timeout: ${bad}\n` });
    }
    expect(await ogw(ws, ['job', 'wait'])).toMatchObject({ code: 1, stderr: 'usage: ogw job wait <id> [--timeout <ms>]\n' });
    expect((await ogw(ws, ['job', 'wait', 'nope2'])).stderr).toBe('job not found: nope2\n');
  });
});
