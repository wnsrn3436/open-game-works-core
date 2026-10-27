import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ogw } from '../../helpers/workspace.ts';
import { addJob, git, openBuildRun, setupGame, write } from './helpers.ts';

const mocks = vi.hoisted(() => ({ listInstances: vi.fn() }));

vi.mock('../../../src/commands/instance/api.ts', () => ({ listInstances: mocks.listInstances, startInstance: vi.fn(), stopInstance: vi.fn() }));

beforeEach(() => {
  mocks.listInstances.mockReset().mockResolvedValue([]);
});

describe('ogw loop status of a build run', () => {
  it('prints kind build, the main commit the build branch was made from, and the build run records', async () => {
    const g = setupGame();
    const base = git(g.root, 'rev-parse', 'main');
    await openBuildRun(g, { iteration: 1, startedAt: 5 });
    write(g.root, 'game.txt', 'hardened');
    git(g.root, 'add', '--all');
    git(g.root, 'commit', '--quiet', '-m', 'hardening');
    write(g.root, 'records/loops/build-stg-0.2.0/iteration-1.md', '## commit\n');
    write(g.root, 'records/loops/update-1/iteration-2.md', '## commit\n');
    git(g.root, 'add', '--all');
    git(g.root, 'commit', '--quiet', '-m', 'records');
    const job = await addJob(g.ws, { meta: { role: 'resource' }, status: 'done' });
    mocks.listInstances.mockResolvedValue([{ id: 'i1', startedAt: 7 }]);
    const out = await ogw(g.ws, ['loop', 'status', 'g']);
    expect(out).toMatchObject({
      code: 0,
      stdout: [
        'run: build-stg-0.2.0',
        'kind: build',
        'iteration: 1',
        'iteration kind: completeness',
        `base commit: ${base}`,
        'last iteration record: records/loops/build-stg-0.2.0/iteration-1.md',
        `job ${job.id} resource done not merged`,
        'instance i1',
        '',
      ].join('\n'),
    });
    const json = JSON.parse((await ogw(g.ws, ['loop', 'status', 'g', '--json'])).stdout) as Record<string, unknown>;
    expect(json).toMatchObject({ run: 'build-stg-0.2.0', kind: 'build', iteration: 1, baseCommit: base, lastRecord: 'records/loops/build-stg-0.2.0/iteration-1.md' });
  });
});
