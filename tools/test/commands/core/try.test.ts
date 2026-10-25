import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coreTryChecks } from '../../../src/commands/check/api.ts';
import { generateCheckout } from '../../../src/commands/generate/api.ts';
import { ogw, makeGame, makeWorkspace, sh } from '../../helpers/workspace.ts';

vi.mock('../../../src/commands/generate/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/generate/api.ts')>()),
  generateCheckout: vi.fn(),
}));
vi.mock('../../../src/commands/check/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/check/api.ts')>()),
  coreTryChecks: vi.fn(),
}));

const pass = (name: string): { name: string; platform: null; result: 'pass'; failures: never[]; warnings: never[] } => ({ name, platform: null, result: 'pass', failures: [], warnings: [] });

beforeEach(() => {
  vi.mocked(generateCheckout).mockReset().mockResolvedValue({ written: [], removed: [] });
  vi.mocked(coreTryChecks).mockReset();
});

describe('ogw core try', () => {
  it('runs the checks on a worktree of main with the local core, keeps the evidence and removes the worktree', async () => {
    const ws = makeWorkspace();
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' } });
    const head = sh(dir, 'git', ['rev-parse', 'HEAD']).trim();
    const seen: { root: string; local: boolean; evidence: string }[] = [];
    vi.mocked(coreTryChecks).mockImplementation(async (ctx, game, evidence) => {
      seen.push({ root: game.root, local: (await ctx.settings()).useLocalCore, evidence: evidence.root });
      expect(existsSync(join(game.root, 'settings.json'))).toBe(true);
      return { checks: [pass('regression test'), { ...pass('UI quality'), result: 'fail' as const }], lines: ['regression test: pass', 'UI quality: fail'] };
    });
    const run = await ogw(ws, ['core', 'try', 'g']);
    expect(run.code).toBe(1);
    const [only] = seen;
    expect(only?.local).toBe(true);
    expect(only?.root.startsWith(join(ws.worktrees, 'g', 'try-'))).toBe(true);
    expect(vi.mocked(generateCheckout).mock.calls[0]?.[1].root).toBe(only?.root);
    expect(run.stdout).toBe(`core try g at main ${head.slice(0, 12)} with the local core\nregression test: pass\nUI quality: fail\nevidence: ${only?.evidence ?? ''}\n`);
    expect(existsSync(only?.evidence ?? '')).toBe(true);
    // the worktree is gone and the game repo is as it was
    expect(existsSync(only?.root ?? '')).toBe(false);
    expect(readdirSync(join(ws.worktrees, 'g'))).toEqual([]);
    expect(sh(dir, 'git', ['status', '--porcelain']).trim()).toBe('');
    expect(sh(dir, 'git', ['worktree', 'list']).trim().split('\n')).toHaveLength(1);
  });

  it('exits 0 when no check fails, and removes the worktree when a step throws', async () => {
    const ws = makeWorkspace();
    makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' } });
    vi.mocked(coreTryChecks).mockResolvedValue({ checks: [pass('static check')], lines: ['static check: pass'] });
    expect((await ogw(ws, ['core', 'try', 'g'])).code).toBe(0);
    vi.mocked(generateCheckout).mockRejectedValueOnce(new Error('local core does not build'));
    const broken = await ogw(ws, ['core', 'try', 'g']);
    expect(broken).toMatchObject({ code: 1 });
    expect(broken.stderr).toContain('local core does not build');
    expect(readdirSync(join(ws.worktrees, 'g'))).toEqual([]);
  });
});
