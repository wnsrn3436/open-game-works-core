import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// loop.ts first: loading the original api.ts loads loop.ts, which then would bind the original placeholderFailures
import { gameChecks, type CheckSet } from '../../../../src/commands/check/lib/loop.ts';
import { placeholderFailures, type CheckResult } from '../../../../src/commands/check/api.ts';
import { botPlaytest } from '../../../../src/commands/check/lib/bot-playtest.ts';
import { performanceChecks } from '../../../../src/commands/check/lib/performance.ts';
import { regressionTest } from '../../../../src/commands/check/lib/regression.ts';
import { rowSimulationCheck } from '../../../../src/commands/check/lib/row-simulation.ts';
import { uiQualityCheck } from '../../../../src/commands/check/lib/ui-quality.ts';
import { staticCheck } from '../../../../src/commands/check/static-api.ts';
import type { Context } from '../../../../src/lib/command.ts';
import type { GameRepo } from '../../../../src/lib/game.ts';
import type { GameSettings } from '../../../../src/lib/settings.ts';
import { mergedCoreSettings } from '../../../../src/commands/generate/api.ts';
import { importClient } from '../../../../src/commands/check/lib/engine.ts';
import { inJob, type SpanLine, type StepLine } from '../../../../src/lib/spans.ts';

vi.mock('../../../../src/commands/check/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/check/api.ts')>()),
  placeholderFailures: vi.fn(),
}));
vi.mock('../../../../src/commands/check/lib/bot-playtest.ts', () => ({ BOT_PLAYTEST_POLL_MS: 200, botPlaytest: vi.fn(), readScenario: vi.fn(() => Promise.resolve('no scenario')) }));
vi.mock('../../../../src/commands/check/lib/performance.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/check/lib/performance.ts')>()),
  performanceChecks: vi.fn(),
}));
vi.mock('../../../../src/commands/check/lib/regression.ts', () => ({ regressionTest: vi.fn() }));
vi.mock('../../../../src/commands/check/lib/row-simulation.ts', () => ({ rowSimulationCheck: vi.fn() }));
vi.mock('../../../../src/commands/check/lib/ui-quality.ts', () => ({ uiQualityCheck: vi.fn() }));
vi.mock('../../../../src/commands/check/static-api.ts', () => ({ staticCheck: vi.fn() }));
vi.mock('../../../../src/commands/check/lib/engine.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/check/lib/engine.ts')>()),
  importClient: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../../../../src/commands/generate/api.ts', () => ({
  gameModules: vi.fn(() => Promise.resolve({ client: [], server: [] })),
  mergedCoreSettings: vi.fn(() => Promise.resolve({})),
}));

function pass(name: string, platform: string | null = null): CheckResult {
  return { name, platform, result: 'pass', failures: [], warnings: [] };
}

const ctx = { settings: () => Promise.resolve({ maxConcurrentInstances: 2, performanceLeaseWaitTimeoutMs: 1234 }), workspace: () => Promise.resolve({ root: '/ws' }) } as unknown as Context;
const game = { name: 'g', root: '/nowhere', commonDir: '/nowhere/.git' } as GameRepo;
const UI_QUALITY = { settleLimitMs: 0, maxFontSizes: 4, minFontSize: 18, minContrast: 4.5, minLargeContrast: 3, maxEmptyShare: 0.6, minTouchTarget: 48 };
const settings = { buildPlatforms: ['ios', 'web'], targetFps: 60, loadingTimeLimitMs: 1000, rowSimulationSeeds: 2, uiQuality: UI_QUALITY } as GameSettings;
const options = { godot: 'godot', pollMs: 1, sampleMs: 1, probe: { sample: () => Promise.resolve(null) } } as unknown as Parameters<typeof gameChecks>[3];

function names(set: CheckSet): Promise<[string, string | null][]> {
  return gameChecks(ctx, game, settings, options, { root: '/nowhere', dir: null, relative: false }, set).then((checks) => checks.map((c) => [c.name, c.platform]));
}

beforeEach(() => {
  vi.mocked(regressionTest).mockReset().mockResolvedValue(pass('regression test'));
  vi.mocked(staticCheck).mockReset().mockResolvedValue(pass('static check'));
  vi.mocked(botPlaytest).mockReset().mockResolvedValue([pass('no blocker'), pass('full flow')]);
  vi.mocked(performanceChecks).mockReset().mockImplementation((_c, _g, platforms) => Promise.resolve(platforms.map((p) => pass('performance', p))));
  vi.mocked(uiQualityCheck).mockReset().mockImplementation((_c, _g, platform) => Promise.resolve(pass('UI quality', platform)));
  vi.mocked(rowSimulationCheck).mockReset().mockResolvedValue(pass('row simulation'));
  vi.mocked(placeholderFailures).mockReset().mockResolvedValue([]);
});

describe('gameChecks', () => {
  it('core try runs the six checks of update core in CHECK_ORDER, without no placeholder and row simulation', async () => {
    expect(await names('core try')).toEqual([
      ['regression test', null],
      ['static check', null],
      ['no blocker', null],
      ['full flow', null],
      ['performance', 'ios'],
      ['performance', 'web'],
      ['UI quality', 'ios'],
      ['UI quality', 'web'],
    ]);
    expect(placeholderFailures).not.toHaveBeenCalled();
    expect(rowSimulationCheck).not.toHaveBeenCalled();
    expect(vi.mocked(uiQualityCheck).mock.calls.map((c) => c[3].quality)).toEqual([UI_QUALITY, UI_QUALITY]);
  });

  it('names its import step apart from the import step of an instance start, and in core try apart from that of ogw check', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ogw-spans-')), 'j.spans.jsonl');
    await inJob('j', file, async () => {
      await names('all');
      await names('core try');
    });
    const steps = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as SpanLine);
    const imports = steps.filter((line): line is StepLine => 'name' in line && line.end !== null && line.name.endsWith('import'));
    expect(imports.map((line) => line.name)).toEqual(['check import', 'core try import']);
  });

  it('measures the performance of every platform profile under one hold of the performance lease of this host', async () => {
    await names('core try');
    expect(vi.mocked(performanceChecks).mock.calls.map((c) => [c[2], c[4].lease])).toEqual([
      [['ios', 'web'], { base: '/ws/.ogw/generation/performance-lease', waitMs: 1234 }],
    ]);
    vi.mocked(performanceChecks).mockClear();
    await names('fun');
    expect(performanceChecks).not.toHaveBeenCalled();
  });

  it('gives the regression test the run and start limits of the merged core settings of the game', async () => {
    vi.mocked(mergedCoreSettings).mockResolvedValue({ 'UnitTestCore.runTimeLimitMs': 30_000, 'UnitTestCore.startTimeLimitMs': 120_000 });
    await names('core try');
    expect(vi.mocked(regressionTest).mock.calls[0]?.[3]).toMatchObject({ runTimeLimitMs: 30_000, startTimeLimitMs: 120_000 });
    vi.mocked(mergedCoreSettings).mockResolvedValue({});
  });

  it('measures performance only once every other instance work of the check has ended, the work alongside the checks included', async () => {
    const pending: { name: string; resolve: () => void }[] = [];
    const later = <T>(name: string, value: T): Promise<T> =>
      new Promise<T>((resolve) => {
        pending.push({
          name,
          resolve: () => {
            resolve(value);
          },
        });
      });
    // a turn of the event loop: what a settled promise starts has started by then
    const turn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));
    vi.mocked(botPlaytest).mockImplementation(() => later('bot playtest', [pass('no blocker'), pass('full flow')]));
    vi.mocked(uiQualityCheck).mockImplementation((_c, _g, platform) => later(`UI quality ${platform}`, pass('UI quality', platform)));
    vi.mocked(rowSimulationCheck).mockImplementation(() => later('row simulation', pass('row simulation')));
    const alongside = vi.fn<(instance: unknown) => Promise<void>>(() => later('alongside', undefined));
    const checks = gameChecks(ctx, game, settings, options, { root: '/nowhere', dir: null, relative: false }, 'all', [{ name: 'beside', work: alongside }]);
    while (pending.length < 5) await turn();
    for (const name of ['bot playtest', 'UI quality ios', 'row simulation', 'UI quality web', 'alongside']) {
      for (let i = 0; i < 5; i++) await turn();
      expect(performanceChecks).not.toHaveBeenCalled();
      pending.find((p) => p.name === name)?.resolve();
    }
    expect((await checks).map((c) => [c.name, c.platform])).toEqual([
      ['regression test', null],
      ['static check', null],
      ['no blocker', null],
      ['full flow', null],
      ['performance', 'ios'],
      ['performance', 'web'],
      ['UI quality', 'ios'],
      ['UI quality', 'web'],
      ['no placeholder', null],
      ['row simulation', null],
    ]);
    expect(performanceChecks).toHaveBeenCalledTimes(1);
    // the work alongside takes its instances within the slots of the check
    expect(alongside.mock.calls[0]?.[0]).toBe(vi.mocked(botPlaytest).mock.calls[0]?.[3]);
  });

  it('logs the failure of each work beside the checks under the name of that work, and the checks go on', async () => {
    const logs: string[] = [];
    const logged = { ...ctx, log: (line: string) => logs.push(line) } as Context;
    const checks = await gameChecks(logged, game, settings, options, { root: '/nowhere', dir: null, relative: false }, 'all', [
      { name: 'shared telemetry runs', work: () => Promise.reject(new Error('no baseline worktree')) },
      { name: 'fix test proof', work: () => Promise.reject(new Error('defects.json gone')) },
      { name: 'quiet', work: () => Promise.resolve() },
    ]);
    expect(logs).toEqual(['shared telemetry runs: no baseline worktree', 'fix test proof: defects.json gone']);
    expect(checks.map((c) => c.name)).toContain('performance');
  });

  it('runs the regression test and no placeholder beside the import of the checkout, and the static check and the instances after it', async () => {
    const turn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));
    let finish: (failure: string | null) => void = () => undefined;
    vi.mocked(importClient).mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve;
    }));
    const checks = gameChecks(ctx, game, settings, options, { root: '/nowhere', dir: null, relative: false }, 'all');
    for (let i = 0; i < 10; i++) await turn();
    expect(regressionTest).toHaveBeenCalledTimes(1);
    expect(placeholderFailures).toHaveBeenCalledTimes(1);
    for (const waiting of [staticCheck, botPlaytest, uiQualityCheck, rowSimulationCheck, performanceChecks]) expect(waiting).not.toHaveBeenCalled();
    // the client part of the regression test waits for the import itself
    const importing = vi.mocked(regressionTest).mock.calls[0]?.[3].importing;
    expect(importing).toBeInstanceOf(Promise);
    finish(null);
    expect(await importing).toBeNull();
    expect((await checks).map((c) => c.name)).toContain('row simulation');
    expect(vi.mocked(staticCheck).mock.calls[0]?.[2]).toEqual({ imported: true });
    expect(botPlaytest).toHaveBeenCalledTimes(1);
  });

  it('reads the merged core settings once', async () => {
    vi.mocked(mergedCoreSettings).mockClear();
    await names('all');
    expect(mergedCoreSettings).toHaveBeenCalledTimes(1);
  });

  it('fails with the error of an import that throws, once the work it started has ended', async () => {
    vi.mocked(importClient).mockImplementationOnce(() => Promise.reject(new Error('no engine packages')));
    await expect(names('all')).rejects.toThrow('no engine packages');
    expect(staticCheck).not.toHaveBeenCalled();
    expect(botPlaytest).not.toHaveBeenCalled();
    expect(performanceChecks).not.toHaveBeenCalled();
  });

  it('all also runs no placeholder and row simulation', async () => {
    expect((await names('all')).slice(-2)).toEqual([['no placeholder', null], ['row simulation', null]]);
    expect(placeholderFailures).toHaveBeenCalledTimes(1);
    expect(rowSimulationCheck).toHaveBeenCalledTimes(1);
  });
});
