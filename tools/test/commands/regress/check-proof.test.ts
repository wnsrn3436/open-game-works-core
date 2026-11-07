import { describe, expect, it, vi } from 'vitest';
import { regressChecks } from '../../../src/commands/check/check.ts';
import { rowProofs } from '../../../src/commands/check/lib/fix-proof.ts';
import type { Slots } from '../../../src/commands/check/lib/instances.ts';
import { gameChecks } from '../../../src/commands/check/lib/loop.ts';
import { makeGame, makeWorkspace } from '../../helpers/workspace.ts';
import { ctxOf } from './helpers.ts';

vi.mock('../../../src/commands/check/lib/fix-proof.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/commands/check/lib/fix-proof.ts')>();
  return { ...actual, rowProofs: vi.fn(actual.rowProofs) };
});

vi.mock('../../../src/commands/check/lib/loop.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/check/lib/loop.ts')>()),
  gameChecks: vi.fn(() => Promise.resolve([])),
  runTimeLimitMs: vi.fn(() => Promise.resolve(null)),
  startTimeLimitMs: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../../../src/commands/check/lib/engine.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/check/lib/engine.ts')>()),
  gameEngine: vi.fn(() => Promise.resolve('godot')),
}));
vi.mock('../../../src/commands/data/lib/binary-build.ts', () => ({ binaryBuild: vi.fn(() => Promise.resolve()) }));

describe('regressChecks', () => {
  it('passes the pick to the checks and reads the fix test proof of the seed-run records of the iteration', async () => {
    const ws = makeWorkspace({ maxConcurrentInstances: 4 });
    const defect = { id: 'leak', severity: 'blocker', owner: 'client content', where: 'step 2', what: 'w', why: 'w', evidence: [], source: 'check', status: 'open', refusedReason: null, repeatedDefect: 0, oscillation: 0 };
    const root = makeGame(ws, 'g', {
      'settings.json': {},
      'records/loops/regress-1-1/defects.json': { defects: [defect], previous: null, recordedBy: 'ogw regress run' },
      'records/loops/regress-1-1/content-2.md': '## defects\n\n| id | result | note |\n|---|---|---|\n| leak | fixed | `client/tests/test_a.gd::test_leak` |\n',
    });
    const ctx = ctxOf(ws);
    const game = await ctx.game('g');
    const pick = { only: new Set(['no blocker']), performance: false };
    const result = await regressChecks(ctx, game, { root, dir: null, relative: false }, pick, { records: 'regress-1-1', iteration: 2, commit: 'HEAD' });
    expect(vi.mocked(gameChecks).mock.calls[0]?.[5]).toBe(pick);
    // a defect that a check found is confirmed by the check: its proof runs no test
    expect(result.fixTestProof).toEqual([{ id: 'leak', result: 'unknown', reason: 'source check', tests: [] }]);
    expect((await regressChecks(ctx, game, { root, dir: null, relative: false }, pick, null)).fixTestProof).toEqual([]);
  });

  it('runs the fix test proof beside the checks in their slots, and the checks give the measurements a wait for it', async () => {
    const ws = makeWorkspace({ maxConcurrentInstances: 4 });
    const root = makeGame(ws, 'g', { 'settings.json': {} });
    const ctx = ctxOf(ws);
    const game = await ctx.game('g');
    let release = (): void => undefined;
    const order: string[] = [];
    vi.mocked(rowProofs).mockImplementationOnce(async (_ctx, _game, _run, _commit, _fixed, options) => {
      order.push(`proof starts${options.slots === undefined ? '' : ' in the slots of the check'}`);
      // a proof that runs after the checks ends on its own
      await Promise.race([new Promise<void>((resolve) => (release = resolve)), new Promise((resolve) => setTimeout(resolve, 1000))]);
      order.push('proof ends');
      return [{ id: 'leak', result: 'pass', reason: null, tests: [] }];
    });
    vi.mocked(gameChecks).mockImplementationOnce(async (_ctx, _game, _settings, options, _evidence, _set, alongside) => {
      order.push('checks start');
      // the proof runs while the checks run: the measurements, which wait for `alongside`, start after it
      const instance = { evidence: { root, dir: null, relative: false }, slots: options.slots as Slots, pollMs: 1 };
      const waited = Promise.all((alongside ?? []).map((beside) => beside.work(instance))).then(() => order.push('measurements'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`checks run${options.slots !== undefined && options.slots === vi.mocked(rowProofs).mock.lastCall?.[5].slots ? ' in the same slots' : ''}`);
      release();
      await waited;
      return [];
    });
    const result = await regressChecks(ctx, game, { root, dir: null, relative: false }, { only: null, performance: true }, { records: 'regress-1-1', iteration: 1, commit: 'HEAD' });
    expect(order).toEqual(['proof starts in the slots of the check', 'checks start', 'checks run in the same slots', 'proof ends', 'measurements']);
    expect(result.fixTestProof).toEqual([{ id: 'leak', result: 'pass', reason: null, tests: [] }]);
  });
});

describe('the checks of a check set', () => {
  it('runs the named checks of a regress pick, performance only when asked, and keeps the sets of the loop and core try', async () => {
    const { selectionOf } = await vi.importActual<typeof import('../../../src/commands/check/lib/loop.ts')>('../../../src/commands/check/lib/loop.ts');
    const flags = (s: ReturnType<typeof selectionOf>): string => (['bot', 'ui', 'rows', 'performance', 'placeholder'] as const).filter((k) => s[k]).join(',');
    expect(flags(selectionOf('all'))).toBe('bot,ui,rows,performance,placeholder');
    expect(flags(selectionOf('fun'))).toBe('bot');
    expect(flags(selectionOf('core try'))).toBe('bot,ui,performance');
    expect(flags(selectionOf({ only: null, performance: false }))).toBe('bot,ui,rows,placeholder');
    expect(flags(selectionOf({ only: null, performance: true }))).toBe('bot,ui,rows,performance,placeholder');
    const pick = selectionOf({ only: new Set(['full flow', 'no placeholder']), performance: true });
    expect(flags(pick)).toBe('bot,placeholder');
    expect(['regression test', 'full flow', 'no blocker'].map((name) => pick.wants(name))).toEqual([false, true, false]);
  });
});
