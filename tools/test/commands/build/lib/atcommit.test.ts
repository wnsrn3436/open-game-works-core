import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { dataVersionsAt } from '../../../../src/commands/build/lib/atcommit.ts';
import { tagCommit } from '../../../../src/commands/build/lib/names.ts';
import { commitAll, makeGame, makeWorkspace, sh } from '../../../helpers/workspace.ts';
import { ctxOf, GAME_SETTINGS, makeRelease, toolCalls, write } from '../../generate/helpers.ts';

vi.mock('../../../../src/commands/core/api.ts', async () => (await import('../../generate/helpers.ts')).coreApiMock);
vi.mock('../../../../src/commands/generate/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/generate/api.ts')>()),
  runGenerate: vi.fn(() => Promise.resolve()),
}));

describe('dataVersionsAt', () => {
  it('builds an older commit without comparing it to the PROD data tag, once per commit', async () => {
    const ws = makeWorkspace();
    const release = makeRelease(ws, '1.0.0');
    const root = makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS, 'data/version.txt': 'p1-d1' });
    sh(root, 'git', ['tag', 'dev-0.1.0']);
    write(join(root, 'data', 'version.txt'), 'p1-d2');
    commitAll(root, 'a row the old app lacks');
    sh(root, 'git', ['tag', 'prod-0.2.0']);
    const ctx = ctxOf(ws);
    const game = await ctx.game('g');
    const commit = await tagCommit(root, 'dev-0.1.0');
    expect((await dataVersionsAt(ctx, game, commit)).client).toBe('p1-d1');
    expect((await dataVersionsAt(ctx, game, commit)).server).toBe('p1-d1');
    const calls = toolCalls(release, 'data-tool.tgz');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain('--binary');
    expect(calls[0]?.args).not.toContain('--previous');
    expect(sh(root, 'git', ['worktree', 'list']).trim().split('\n')).toHaveLength(1);
  });
});
