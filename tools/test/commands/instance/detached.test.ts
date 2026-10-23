import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { instanceFolder, listRecords, takesSlot, writeRecord, type InstanceRecord } from '../../../src/commands/instance/lib/records.ts';
import { stopInstancesOfAgent } from '../../../src/commands/instance/api.ts';
import { createContext } from '../../../src/lib/command.ts';
import { hostBootId } from '../../../src/lib/jobs.ts';
import { isAlive, killTree } from '../../../src/lib/proc.ts';
import { ogw } from '../../helpers/workspace.ts';
import { setupRunner } from './runner.ts';

vi.mock('../../../src/commands/generate/api.ts', async () => (await import('./mocks/apis.ts')).generate);
vi.mock('../../../src/commands/data/api.ts', async () => (await import('./mocks/apis.ts')).data);
vi.mock('../../../src/commands/core/api.ts', async () => (await import('./mocks/apis.ts')).core);
vi.mock('../../../src/commands/env/api.ts', async () => (await import('./mocks/apis.ts')).env);

describe('detached supervisor', () => {
  it('runs in its own process and reports a server process that ends before it takes requests', async () => {
    const runner = setupRunner();
    const run = await ogw(runner.ws, ['instance', 'start', 'g', '--json']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('instance start failed: the server process ended before it took requests');
    expect(JSON.parse(run.stdout)).toMatchObject({ data: { reason: 'start' } });
    expect(await listRecords(runner.ws.env)).toEqual([]);
  });

  it('stop cleans up an instance whose supervisor is gone', async () => {
    const runner = setupRunner();
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid as number;
    const record: InstanceRecord = {
      id: 'deadsup1',
      game: 'g',
      root: runner.root,
      mainRoot: runner.root,
      worktree: null,
      commit: '',
      platform: 'android',
      status: 'running',
      error: null,
      failure: null,
      startedAt: Date.now(),
      ownerPid: 999_999,
      supervisorPid: 999_998,
      serverUrl: '',
      adminSecret: '',
      control: { port: 1, token: 't' },
      pids: { server: pid },
      exited: {},
      container: null,
      plan: null,
    };
    await writeRecord(record, runner.ws.env);
    const folder = await instanceFolder('deadsup1', runner.ws.env);
    expect((await ogw(runner.ws, ['instance', 'stop', 'deadsup1'])).code).toBe(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(pid)).toBe(false);
    expect(await listRecords(runner.ws.env)).toEqual([]);
    expect(existsSync(join(folder, 'x'))).toBe(false);
  });

  it('stops every instance an agent started, and no other', async () => {
    const runner = setupRunner();
    const make = (id: string, agentJob: string | null, status: InstanceRecord['status']): InstanceRecord => ({
      id,
      game: 'g',
      root: runner.root,
      mainRoot: runner.root,
      worktree: null,
      commit: '',
      platform: 'macos',
      status,
      error: null,
      failure: null,
      startedAt: Date.now(),
      ownerPid: 999_999,
      agentJob,
      supervisorPid: null,
      serverUrl: '',
      adminSecret: '',
      control: null,
      pids: {},
      exited: {},
      container: null,
      plan: null,
    });
    for (const record of [make('agentrun1', 'jobA', 'running'), make('agentrun2', 'jobA', 'failed'), make('otherjob1', 'jobB', 'running'), make('lead0001', null, 'running')]) {
      await writeRecord(record, runner.ws.env);
    }
    const ctx = createContext({ cwd: runner.root, env: runner.ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    expect(await stopInstancesOfAgent(ctx, 'jobA')).toEqual(['agentrun1', 'agentrun2']);
    expect((await listRecords(runner.ws.env)).map((r) => r.id).sort()).toEqual(['lead0001', 'otherjob1']);
  });

  it('stop does not kill the pids of an instance of an earlier boot of the host, and it takes no slot', async () => {
    expect(hostBootId()).not.toBeNull();
    const runner = setupRunner();
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid as number;
    try {
      const record: InstanceRecord = {
        id: 'oldboot1',
        game: 'g',
        root: runner.root,
        mainRoot: runner.root,
        worktree: null,
        commit: '',
        platform: 'android',
        status: 'running',
        error: null,
        failure: null,
        startedAt: Date.now(),
        ownerPid: pid,
        // A pid reused after the reboot by an unrelated process.
        supervisorPid: pid,
        bootId: 'an-earlier-boot',
        serverUrl: '',
        adminSecret: '',
        control: { port: 1, token: 't' },
        pids: { server: pid },
        exited: {},
        container: null,
        plan: null,
      };
      expect(takesSlot(record)).toBe(false);
      expect(takesSlot({ ...record, bootId: hostBootId() })).toBe(true);
      await writeRecord(record, runner.ws.env);
      expect((await ogw(runner.ws, ['instance', 'stop', 'oldboot1'])).code).toBe(0);
      await new Promise((r) => setTimeout(r, 200));
      expect(isAlive(pid)).toBe(true);
      expect(await listRecords(runner.ws.env)).toEqual([]);
    } finally {
      killTree(pid, 'SIGKILL');
    }
  });
});
