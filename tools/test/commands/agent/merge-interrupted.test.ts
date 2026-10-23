import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OgwError } from '../../../src/lib/errors.ts';
import { readJob } from '../../../src/lib/jobs.ts';
import { ogw, commitAll, makeWorkspace } from '../../helpers/workspace.ts';
import { CORE_TEST_PASSED, fakeAgentCli, runAgent } from './helpers.ts';

// a merge that ends after the worktree is removed and before the job is marked merged (a kill, a time limit)
vi.mock('../../../src/lib/git.ts', async (importOriginal) => {
  const git = await importOriginal<typeof import('../../../src/lib/git.ts')>();
  return {
    ...git,
    worktreeRemove: async (cwd: string, path: string, options?: Parameters<typeof git.worktreeRemove>[2]) => {
      await git.worktreeRemove(cwd, path, options);
      throw new OgwError('the merge ended here');
    },
  };
});

describe('ogw agent merge ended after the worktree is removed', () => {
  it('leaves the result file of a core agent job found in the open-game-works-core-impl/ checkout', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'core-spec', 'routing.json'), JSON.stringify({ name: 'routing', dependencies: [] }));
    commitAll(ws.coreImpl, 'spec');
    writeFileSync(join(ws.root, 'in.md'), 'command: create server core\n');
    const fake = fakeAgentCli(
      ws,
      `fs.mkdirSync('server', { recursive: true }); fs.writeFileSync('server/routing.ts', 'export {};\\n'); fs.writeFileSync(output, 'r'); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'routing', '--no-verify']); ${CORE_TEST_PASSED}`,
    );
    const { id, waited } = await runAgent(ws, ['core', '--module', 'routing', '--input', join(ws.root, 'in.md')], fake.env);
    expect(waited.code).toBe(0);
    const run = await ogw(ws, ['agent', 'merge', id]);
    expect(run.stdout).toContain(`not merged ${id}: error: the merge ended here`);
    const { meta } = await readJob(id, ws.env);
    expect(existsSync(meta.worktree as string)).toBe(false);
    expect(meta.merged).toBe(false);
    expect((await ogw(ws, ['agent', 'status', id])).stdout.split('\n')[0]).toBe('done');
  });
});
