import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { updateJob } from '../../../src/lib/jobs.ts';
import { ogw } from '../../helpers/workspace.ts';
import { addJob, commit, git, openBuildRun, openLoopRun, read, setRun, setupGame, write } from './helpers.ts';

const mocks = vi.hoisted(() => ({
  listInstances: vi.fn(),
  stopInstance: vi.fn(),
  agentOutcome: vi.fn(),
  mergeAgentJobs: vi.fn(),
}));

vi.mock('../../../src/commands/instance/api.ts', () => ({ listInstances: mocks.listInstances, stopInstance: mocks.stopInstance, startInstance: vi.fn() }));
vi.mock('../../../src/commands/agent/api.ts', () => ({
  agentOutcome: mocks.agentOutcome,
  mergeAgentJobs: mocks.mergeAgentJobs,
  retryAgentJob: vi.fn(),
  startAgentJob: vi.fn(),
}));

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.listInstances.mockResolvedValue([]);
  mocks.stopInstance.mockResolvedValue(undefined);
});

describe('ogw loop resume', () => {
  it('ends at end 5 when merge/<run> is merged into main', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 2 });
    git(g.root, 'checkout', '-q', '-b', 'merge/update-1');
    write(g.root, 'm.txt', 'm');
    commit(g.root);
    git(g.root, 'checkout', '-q', 'main');
    git(g.root, 'merge', '-q', '--no-ff', '-m', 'm', 'merge/update-1');
    const out = await ogw(g.ws, ['loop', 'resume', 'g']);
    expect(out).toMatchObject({ code: 0, stdout: 'resume at: end 5\n' });
    expect(git(g.root, 'branch', '--show-current')).toBe('main');
    expect(mocks.listInstances).not.toHaveBeenCalled();
  });

  it('checks out the run branch, stashes changes, stops instances, syncs, and finds the step', async () => {
    const g = setupGame();
    await openLoopRun(g, { startedAt: 5 });
    git(g.root, 'checkout', '-q', 'main');
    git(g.root, 'branch', 'merge/update-1', 'main');
    write(g.root, 'stray.txt', 'x');
    const worker = await addJob(g.ws, { meta: { role: 'resource', input: '/r/1.md' }, status: 'done' });
    mocks.agentOutcome.mockResolvedValue({ status: 'done', output: '/o' });
    mocks.mergeAgentJobs.mockResolvedValue({ merged: [worker.id], failed: [] });
    mocks.listInstances.mockResolvedValue([{ id: 'i1', startedAt: 1 }]);
    const out = await ogw(g.ws, ['loop', 'resume', 'g']);
    expect(out.stdout).toBe(['stashed uncommitted changes', 'checked out loop/update-1', 'stopped instance i1', `merged ${worker.id}`, 'resume at: start 2', ''].join('\n'));
    expect(git(g.root, 'branch', '--show-current')).toBe('loop/update-1');
    expect(git(g.root, 'stash', 'list')).toContain('ogw loop resume update-1');
    expect(mocks.stopInstance).toHaveBeenCalledWith(expect.anything(), 'i1');
    expect(mocks.listInstances).toHaveBeenCalledWith(expect.anything(), { game: 'g' });
  });

  it('gives the iteration step from the records', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 2 });
    expect((await ogw(g.ws, ['loop', 'resume', 'g'])).stdout).toBe('checked out loop/update-1\nnothing to sync\nresume at: iteration 2 1\n');
    write(g.root, 'records/loops/update-1/content-2.md', 'r');
    commit(g.root);
    expect((await ogw(g.ws, ['loop', 'resume', 'g'])).stdout).toContain('resume at: iteration 2 2\n');
    write(g.root, 'records/loops/update-1/iteration-2.md', 'r');
    commit(g.root);
    expect((await ogw(g.ws, ['loop', 'resume', 'g'])).stdout).toContain('resume at: iteration 2 8\n');
  });

  it('waits for jobs other than resource and translation and fails while one still runs', async () => {
    const g = setupGame({ jobWaitTimeoutMs: 50 });
    await openLoopRun(g, { startedAt: 5 });
    await addJob(g.ws, { meta: { role: 'translation', input: '/t.md' } });
    mocks.agentOutcome.mockResolvedValue({ status: 'running', output: null });
    await addJob(g.ws, { command: 'check', status: 'done' });
    expect((await ogw(g.ws, ['loop', 'resume', 'g'])).stdout).toContain('resume at: start 2');
    const check = await addJob(g.ws, { command: 'check' });
    const out = await ogw(g.ws, ['loop', 'resume', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(`job ${check.id} is still running; run ogw loop resume again`);
  });

  it('waits for a running content agent job before it stashes and checks out, then goes on', async () => {
    const g = setupGame({ jobWaitTimeoutMs: 30_000 });
    await openLoopRun(g, { startedAt: 5, iteration: 1 });
    write(g.root, 'client/edit.gd', 'half done');
    const content = await addJob(g.ws, { meta: { role: 'content', input: '/c.md' } });
    let during: { branch: string; edit: boolean } | null = null;
    const timer = setTimeout(() => {
      during = { branch: git(g.root, 'branch', '--show-current'), edit: existsSync(join(g.root, 'client/edit.gd')) };
      void updateJob(content.id, (job) => {
        job.status = 'done';
        job.endedAt = Date.now();
      }, g.ws.env);
    }, 300);
    const out = await ogw(g.ws, ['loop', 'resume', 'g']);
    clearTimeout(timer);
    expect(out.code).toBe(0);
    expect(during).toEqual({ branch: 'loop/update-1', edit: true });
    expect(out.stdout).toBe(
      [`waited for job ${content.id}`, 'stashed uncommitted changes', 'checked out loop/update-1', 'nothing to sync', 'resume at: iteration 1 1', ''].join('\n'),
    );
  });

  it('gives the build step', async () => {
    const g = setupGame();
    await openBuildRun(g, { iteration: 1 });
    expect((await ogw(g.ws, ['loop', 'resume', 'g'])).stdout).toContain('resume at: build 2\n');
    git(g.root, 'tag', 'stg-0.2.0');
    expect((await ogw(g.ws, ['loop', 'resume', 'g'])).stdout).toContain('resume at: build 7\n');
    write(g.root, 'records/loops/build-stg-0.2.0/end.md', 'report');
    commit(g.root);
    expect((await ogw(g.ws, ['loop', 'resume', 'g'])).stdout).toContain('resume at: build end\n');
    expect(read(g.root, 'records/loops/build-stg-0.2.0/end.md')).toBe('report');
    const p = setupGame();
    await openBuildRun(p, { env: 'PROD', name: 'build-prod-0.2.0' });
    expect((await ogw(p.ws, ['loop', 'resume', 'g'])).stdout).toContain('resume at: build 5\n');
    git(p.root, 'checkout', '-q', 'main');
    write(p.root, 'records/loops/build-prod-0.2.0/end.md', 'report on main');
    commit(p.root);
    await setRun(p, () => undefined);
    expect((await ogw(p.ws, ['loop', 'resume', 'g'])).stdout).toContain('resume at: build end\n');
    const u = setupGame();
    await openBuildRun(u, { name: 'build-stg-0.2.0-bundle-1', version: '0.2.0-bundle-1' });
    git(u.root, 'tag', 'stg-0.2.0');
    expect((await ogw(u.ws, ['loop', 'resume', 'g'])).stdout).toContain('resume at: build 2\n');
    git(u.root, 'tag', 'stg-0.2.0-bundle-1');
    expect((await ogw(u.ws, ['loop', 'resume', 'g'])).stdout).toContain('resume at: build 7\n');
  });

  it('gives build 6 when main HEAD is the build finish merge of this run without the tag', async () => {
    const g = setupGame();
    await openBuildRun(g);
    write(g.root, 'records/hardening/stg-0.2.0-server-1.md', '## changes\n');
    commit(g.root);
    git(g.root, 'checkout', '-q', 'main');
    git(g.root, 'merge', '-q', '--no-ff', '--no-edit', '-m', 'merge by hand', 'build/stg-0.2.0');
    expect((await ogw(g.ws, ['loop', 'resume', 'g'])).stdout).toContain('resume at: build 2\n');
    git(g.root, 'checkout', '-q', 'main');
    git(g.root, 'reset', '-q', '--hard', 'HEAD^');
    git(g.root, 'merge', '-q', '--no-ff', '--no-edit', '-m', 'build: merge build/stg-0.2.0', 'build/stg-0.2.0');
    const merge = git(g.root, 'rev-parse', 'main');
    expect((await ogw(g.ws, ['loop', 'resume', 'g'])).stdout).toContain('resume at: build 6\n');
    const finish = await ogw(g.ws, ['build', 'finish', 'g']);
    expect(finish).toMatchObject({ code: 0, stdout: `stg-0.2.0 ${merge}\n` });
    expect((await ogw(g.ws, ['loop', 'resume', 'g'])).stdout).toContain('resume at: build 7\n');
  });
});
