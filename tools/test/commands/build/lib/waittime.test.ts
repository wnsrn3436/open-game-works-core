import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { matchWaitMs } from '../../../../src/commands/build/lib/waittime.ts';
import { coreRelease } from '../../../../src/commands/core/api.ts';
import { worktreeAdd } from '../../../../src/lib/git.ts';
import { createContext } from '../../../../src/lib/command.ts';
import { makeWorkspace } from '../../../helpers/workspace.ts';
import { commit, gameRepo, git, setupGame, write } from '../helpers.ts';

vi.mock('../../../../src/commands/core/api.ts', async (orig) => ({ ...(await orig<object>()), coreRelease: vi.fn() }));
vi.mock('../../../../src/lib/git.ts', async (orig) => {
  const real = await orig<typeof import('../../../../src/lib/git.ts')>();
  return { ...real, worktreeAdd: vi.fn(real.worktreeAdd) };
});

describe('matchWaitMs', () => {
  it('reads the data, game settings core and the release core settings of the last PROD build from git, without a worktree', async () => {
    const ws = makeWorkspace();
    const release = join(ws.root, 'release');
    write(release, 'core-settings.json', { 'matchmaker.reportMarginMs': 500, 'admin-api.switchCacheMs': 1000 });
    vi.mocked(coreRelease).mockImplementation((_ctx, version) => Promise.resolve({ version, dir: release, local: false }));
    const dir = setupGame(ws, 'g', { core: { 'admin-api.switchCacheMs': 2000 } }, {
      'data/tables/match_mode.csv': ',,,\n,All,All,All\n,id,duration,duration\nid,prepare_time,max_duration,x\n[duel],10s,2m,\n',
    });
    const prod = commit(dir, 'prod');
    git(dir, 'tag', 'prod-0.1.0');
    // the checkout moves on: the last PROD build is read at its commit
    write(dir, 'data/tables/match_mode.csv', ',,,\n,All,All,All\n,id,duration,duration\nid,prepare_time,max_duration,x\n[duel],10s,9m,\n');
    commit(dir, 'longer match');
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const head = git(dir, 'rev-parse', prod).trim();
    // 10 s + 2 min + 500 ms margin, plus the game's 2000 ms switch cache over the release's 1000 ms
    expect(await matchWaitMs(ctx, await gameRepo(ws), head, ['matchmaker'])).toBe(130_500 + 2000);
    expect(vi.mocked(coreRelease).mock.calls.at(-1)?.[1]).toBe('1.0.0');
    expect(vi.mocked(worktreeAdd)).not.toHaveBeenCalled();
    expect(await matchWaitMs(ctx, await gameRepo(ws), head, ['routing'])).toBeNull();
  });
});
