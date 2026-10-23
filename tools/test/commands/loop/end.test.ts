import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readJob } from '../../../src/lib/jobs.ts';
import { processStartedAt } from '../../../src/lib/proc.ts';
import { withLock } from '../../../src/lib/lock.ts';
import { openRun } from '../../../src/lib/runstate.ts';
import { ogw } from '../../helpers/workspace.ts';
import { cleanup, startSleeper, startTrackedParent, waitDead } from '../../helpers/procs.ts';
import { addJob, currentRun, git, openLoopRun, readJsonFile, setupGame, write } from './helpers.ts';

const mocks = vi.hoisted(() => ({
  unfailedInstances: vi.fn(),
  stopInstance: vi.fn(),
}));

vi.mock('../../../src/commands/instance/api.ts', () => ({
  unfailedInstances: mocks.unfailedInstances,
  stopInstance: mocks.stopInstance,
  listInstances: vi.fn(() => Promise.resolve([])),
  startInstance: vi.fn(),
}));

const left: (number | undefined)[] = [];

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.unfailedInstances.mockResolvedValue([]);
  mocks.stopInstance.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup(left.splice(0));
});

const PENDING = '.git/ogw-pending-proposals.json';
const PROPOSALS = {
  'records/core-proposals/1-a.md': 'status: proposed\n## target\n',
  'records/core-proposals/2-b.md': 'status: released\nversion: 1.0.0\n',
};

describe('ogw loop end', () => {
  it('stops the run jobs, then its instances, removes agent worktrees, closes the run, and marks pending proposals', async () => {
    const g = setupGame({}, PROPOSALS);
    await openLoopRun(g, { startedAt: 5 });
    const agent = await addJob(g.ws, { meta: { role: 'resource' }, status: 'done' });
    const running = await addJob(g.ws, { command: 'check' });
    const before = await addJob(g.ws, { startedAt: 1, command: 'check' });
    const wt = join(g.ws.worktrees, 'g', `agent-${agent.id}`);
    git(g.root, 'worktree', 'add', '-q', '-b', `agent/${agent.id}`, wt);
    write(g.root, PENDING, { proposals: [{ proposalFile: 'records/core-proposals/1-a.md', version: '1.2.0' }] });
    mocks.unfailedInstances.mockImplementation(async () => {
      expect((await readJob(running.id, g.ws.env)).status).toBe('failed');
      return [
        { id: 'i1', status: 'starting', startedAt: 9 },
        { id: 'i2', status: 'running', startedAt: 5 },
        { id: 'i0', status: 'running', startedAt: 2 },
      ];
    });
    mocks.stopInstance.mockImplementation(async () => {
      expect((await currentRun(g)).closedAt).toBeNull();
    });
    const out = await ogw(g.ws, ['loop', 'end', 'g']);
    expect(out.stdout).toBe(
      [
        'closed run update-1',
        'stopped instance i1',
        'stopped instance i2',
        `stopped job ${running.id}`,
        `removed ${wt}`,
        `removed agent/${agent.id}`,
        'marked released records/core-proposals/1-a.md',
        '',
      ].join('\n'),
    );
    expect(out.code).toBe(0);
    expect(mocks.unfailedInstances).toHaveBeenCalledWith(expect.anything(), 'g');
    expect(mocks.stopInstance.mock.calls.map((c) => c[1] as string)).toEqual(['i1', 'i2']);
    expect(existsSync(wt)).toBe(false);
    expect(git(g.root, 'branch', '--list', 'agent/*')).toBe('');
    expect((await currentRun(g)).closedAt).not.toBeNull();
    expect(git(g.root, 'show', 'main:records/core-proposals/1-a.md')).toBe('status: released\nversion: 1.2.0\n## target');
    expect(existsSync(join(g.root, PENDING))).toBe(false);
    expect((await readJob(running.id, g.ws.env)).status).toBe('failed');
    expect((await readJob(before.id, g.ws.env)).status).toBe('running');
    expect((await ogw(g.ws, ['loop', 'status', 'g'])).stdout).toBe('none\n');
  });

  it('removes a locked agent worktree, and reports what it could not remove with exit 1', async () => {
    const g = setupGame();
    await openLoopRun(g, { startedAt: 5 });
    const locked = await addJob(g.ws, { meta: { role: 'resource' }, status: 'failed' });
    const kept = await addJob(g.ws, { meta: { role: 'translation' }, status: 'failed' });
    const wt = join(g.ws.worktrees, 'g', `agent-${locked.id}`);
    git(g.root, 'worktree', 'add', '-q', '-b', `agent/${locked.id}`, wt);
    // what an interrupted `git worktree add` leaves
    git(g.root, 'worktree', 'lock', '--reason', 'initializing', wt);
    // agent/<kept> is checked out in a worktree outside worktrees/<game>/agent-<id>/, so it cannot be deleted
    const other = join(g.ws.root, 'elsewhere');
    git(g.root, 'worktree', 'add', '-q', '-b', `agent/${kept.id}`, other);
    const out = await ogw(g.ws, ['loop', 'end', 'g', '--json']);
    expect(out.code).toBe(1);
    const data = JSON.parse(out.stdout) as { removed: string[]; notRemoved: { what: string; error: string }[] };
    expect(data.removed).toEqual([wt, `agent/${locked.id}`]);
    expect(data.notRemoved.map((n) => n.what)).toEqual([`agent/${kept.id}`]);
    expect(data.notRemoved[0]?.error).toContain('worktree');
    expect(existsSync(wt)).toBe(false);
    expect(git(g.root, 'branch', '--list', `agent/${locked.id}`)).toBe('');
    expect((await ogw(g.ws, ['loop', 'status', 'g'])).stdout).toBe('none\n');
  });

  it('ends the job processes, the processes they started, and agent CLI processes', async () => {
    const g = setupGame();
    await openLoopRun(g, { startedAt: 5 });
    const { parent, child } = await startTrackedParent(g.ws.root);
    const cli = startSleeper();
    left.push(parent.pid, child, cli.pid);
    const check = await addJob(g.ws, { command: 'check', pid: parent.pid, pidStartedAt: processStartedAt(parent.pid as number) });
    const agent = await addJob(g.ws, { meta: { role: 'translation', cliPid: cli.pid, cliPidStartedAt: processStartedAt(cli.pid as number) } });
    const out = await ogw(g.ws, ['loop', 'end', 'g']);
    expect(out.stdout).toBe(['closed run update-1', `stopped job ${check.id}`, `stopped job ${agent.id}`, ''].join('\n'));
    expect(await waitDead(parent.pid as number)).toBe(true);
    expect(await waitDead(child)).toBe(true);
    expect(await waitDead(cli.pid as number)).toBe(true);
  });

  it('marks what it can, keeps the proposals that fail in the pending file, and exits 1', async () => {
    const g = setupGame({}, PROPOSALS);
    await openLoopRun(g);
    write(g.root, PENDING, {
      proposals: [
        { proposalFile: 'records/core-proposals/2-b.md', version: '1.3.0' },
        { proposalFile: 'records/core-proposals/1-a.md', version: '1.2.0' },
      ],
    });
    const out = await ogw(g.ws, ['loop', 'end', 'g', '--json']);
    expect(out.code).toBe(1);
    const error = 'first line of records/core-proposals/2-b.md is not "status: proposed": "status: released"';
    expect(JSON.parse(out.stdout)).toMatchObject({
      released: ['records/core-proposals/1-a.md'],
      notReleased: [{ proposalFile: 'records/core-proposals/2-b.md', version: '1.3.0', error }],
    });
    expect(readJsonFile(g.root, PENDING)).toEqual({ proposals: [{ proposalFile: 'records/core-proposals/2-b.md', version: '1.3.0' }] });
    expect(await openRun(g.repo)).toBeNull();
    expect(git(g.root, 'show', 'main:records/core-proposals/1-a.md')).toContain('version: 1.2.0');
  });

  it('closes the run and marks the pending proposals under one run lock', async () => {
    const g = setupGame({}, PROPOSALS);
    await openLoopRun(g);
    write(g.root, PENDING, { proposals: [{ proposalFile: 'records/core-proposals/1-a.md', version: '1.2.0' }] });
    const marker = join(g.ws.root, 'lock-at-commit');
    const lock = join(g.root, '.git', 'ogw-runs.lock');
    writeFileSync(join(g.root, '.git', 'hooks', 'post-commit'), `#!/bin/sh\nif [ -d '${lock}' ]; then echo held; else echo free; fi >> '${marker}'\n`, { mode: 0o755 });
    expect((await ogw(g.ws, ['loop', 'end', 'g'])).code).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('held\n');
  });

  it('prints why a proposal was not marked', async () => {
    const g = setupGame({}, PROPOSALS);
    await openLoopRun(g);
    write(g.root, PENDING, { proposals: [{ proposalFile: 'records/core-proposals/none.md', version: '1.3.0' }] });
    const out = await ogw(g.ws, ['loop', 'end', 'g']);
    expect(out).toMatchObject({
      code: 1,
      stdout: 'closed run update-1\nnot marked released records/core-proposals/none.md 1.3.0: proposal file not found on main: records/core-proposals/none.md\n',
    });
  });

  it('reads the pending file under its lock, so a proposal deferred while the run closes is marked', async () => {
    const g = setupGame({}, PROPOSALS);
    await openLoopRun(g);
    write(g.root, 'records/core-proposals/3-c.md', 'status: proposed\n');
    git(g.root, 'checkout', '-q', 'main');
    git(g.root, 'add', '--all');
    git(g.root, 'commit', '-q', '-m', 'proposal 3');
    git(g.root, 'checkout', '-q', 'loop/update-1');
    write(g.root, PENDING, { proposals: [{ proposalFile: 'records/core-proposals/1-a.md', version: '1.2.0' }] });
    const holder = withLock(join(g.root, '.git/ogw-pending-proposals.lock'), async () => {
      while ((await openRun(g.repo)) !== null) await sleep(10);
      write(g.root, PENDING, {
        proposals: [
          { proposalFile: 'records/core-proposals/1-a.md', version: '1.2.0' },
          { proposalFile: 'records/core-proposals/3-c.md', version: '1.2.0' },
        ],
      });
    });
    const out = await ogw(g.ws, ['loop', 'end', 'g']);
    await holder;
    expect(out.stdout).toBe('closed run update-1\nmarked released records/core-proposals/1-a.md\nmarked released records/core-proposals/3-c.md\n');
    expect(existsSync(join(g.root, PENDING))).toBe(false);
  });
});
