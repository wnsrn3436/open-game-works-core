import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coreTryChecks } from '../../../src/commands/check/api.ts';
import { snapshot, withStagedWorktree } from '../../../src/commands/check/static/generated-diff.ts';
import { StaticContext } from '../../../src/commands/check/static/lib/context.ts';
import { coreReleaseOfGame } from '../../../src/commands/core/api.ts';
import { generateCheckout } from '../../../src/commands/generate/api.ts';
import type { StepLine } from '../../../src/lib/spans.ts';
import { ogw, makeGame, makeWorkspace, sh } from '../../helpers/workspace.ts';
import { writeJob } from '../job/helpers.ts';

vi.mock('../../../src/commands/generate/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/generate/api.ts')>()),
  generateCheckout: vi.fn(),
}));
vi.mock('../../../src/commands/check/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/check/api.ts')>()),
  coreTryChecks: vi.fn(),
}));
vi.mock('../../../src/commands/core/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/core/api.ts')>()),
  coreReleaseOfGame: vi.fn(),
}));

const pass = (name: string): { name: string; platform: null; result: 'pass'; failures: never[]; warnings: never[] } => ({ name, platform: null, result: 'pass', failures: [], warnings: [] });

beforeEach(() => {
  vi.mocked(generateCheckout).mockReset().mockResolvedValue({ written: [], removed: [] });
  vi.mocked(coreTryChecks).mockReset();
  vi.mocked(coreReleaseOfGame).mockReset().mockResolvedValue({ version: '1.0.0', dir: '/local-core', local: true });
});

describe('ogw core try', () => {
  it('runs the checks on a worktree of main with the local core, keeps the evidence and removes the worktree', async () => {
    const ws = makeWorkspace();
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' } });
    const head = sh(dir, 'git', ['rev-parse', 'HEAD']).trim();
    const seen: { root: string; local: boolean; evidence: string }[] = [];
    const generatedLocal: boolean[] = [];
    vi.mocked(generateCheckout).mockImplementation(async (ctx) => {
      generatedLocal.push((await ctx.settings()).useLocalCore);
      return { written: [], removed: [] };
    });
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
    expect(generatedLocal).toEqual([true]);
    expect(run.stdout).toBe(`core try g at main ${head.slice(0, 12)} with the local core\nregression test: pass\nUI quality: fail\nevidence: ${only?.evidence ?? ''}\n`);
    expect(existsSync(only?.evidence ?? '')).toBe(true);
    // the worktree is gone and the game repo is as it was
    expect(existsSync(only?.root ?? '')).toBe(false);
    expect(readdirSync(join(ws.worktrees, 'g'))).toEqual([]);
    expect(sh(dir, 'git', ['status', '--porcelain']).trim()).toBe('');
    expect(sh(dir, 'git', ['worktree', 'list']).trim().split('\n')).toHaveLength(1);
  });

  it('stages what ogw generate wrote with the local core, so the static check reads it as HEAD plus the staged changes', async () => {
    const ws = makeWorkspace();
    const dir = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' }, 'client/generated/core_settings.json': '{"A.b":1}' });
    const local: boolean[] = [];
    vi.mocked(generateCheckout).mockImplementation(async (ctx, game) => {
      local.push((await ctx.settings()).useLocalCore);
      writeFileSync(join(game.root, 'client/generated/core_settings.json'), '{"A.b":2}');
      writeFileSync(join(game.root, 'client/generated/new.gd'), 'class_name New');
      return { written: ['client/generated/core_settings.json', 'client/generated/new.gd'], removed: [] };
    });
    const staged: Map<string, Buffer>[] = [];
    vi.mocked(coreTryChecks).mockImplementation(async (ctx, game) => {
      staged.push(await withStagedWorktree(await StaticContext.create(ctx, game), (worktree) => snapshot(worktree.root)));
      return { checks: [pass('static check')], lines: ['static check: pass'] };
    });
    expect((await ogw(ws, ['core', 'try', 'g'])).code).toBe(0);
    expect(local).toEqual([true]);
    expect(staged.map((files) => [...files.entries()].map(([path, bytes]) => [path, bytes.toString()]))).toEqual([[
      ['client/generated/core_settings.json', '{"A.b":2}'],
      ['client/generated/new.gd', 'class_name New'],
    ]]);
    expect(readdirSync(join(ws.worktrees, 'g'))).toEqual([]);
    expect(sh(dir, 'git', ['status', '--porcelain']).trim()).toBe('');
  });

  it('names its steps apart from the steps of other commands, with the local core build a step of its own before the generation', async () => {
    const ws = makeWorkspace();
    makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' } });
    const jobs = join(ws.root, 'jobs');
    mkdirSync(jobs);
    writeJob(jobs, { id: 'tj1', command: 'core try', game: 'g' });
    const built: boolean[] = [];
    vi.mocked(coreReleaseOfGame).mockImplementation(async (ctx) => {
      built.push((await ctx.settings()).useLocalCore);
      return { version: '1.0.0', dir: '/local-core', local: true };
    });
    vi.mocked(coreTryChecks).mockResolvedValue({ checks: [pass('static check')], lines: ['static check: pass'] });
    expect((await ogw(ws, ['core', 'try', 'g'], { env: { ...ws.env, OGW_JOBS_DIR: jobs, OGW_JOB_ID: 'tj1' } })).code).toBe(0);
    expect(built).toEqual([true]);
    const steps = readFileSync(join(jobs, 'tj1.spans.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as StepLine);
    expect(steps.filter((line) => line.end !== null && line.parent === null).map((line) => line.name)).toEqual([
      'core try worktree',
      'local core build',
      'core try generate',
      'core try checks',
      'core try remove worktree',
    ]);
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
