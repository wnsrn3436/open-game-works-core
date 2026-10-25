import { beforeEach, describe, expect, it, vi } from 'vitest';
// loop.ts first: loading the original api.ts loads loop.ts, which then would bind the original placeholderFailures
import { gameChecks, type CheckSet } from '../../../../src/commands/check/lib/loop.ts';
import { placeholderFailures, type CheckResult } from '../../../../src/commands/check/api.ts';
import { botPlaytest } from '../../../../src/commands/check/lib/bot-playtest.ts';
import { performanceCheck } from '../../../../src/commands/check/lib/performance.ts';
import { regressionTest } from '../../../../src/commands/check/lib/regression.ts';
import { rowSimulationCheck } from '../../../../src/commands/check/lib/row-simulation.ts';
import { uiQualityCheck } from '../../../../src/commands/check/lib/ui-quality.ts';
import { staticCheck } from '../../../../src/commands/check/static-api.ts';
import type { Context } from '../../../../src/lib/command.ts';
import type { GameRepo } from '../../../../src/lib/game.ts';
import type { GameSettings } from '../../../../src/lib/settings.ts';

vi.mock('../../../../src/commands/check/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/check/api.ts')>()),
  placeholderFailures: vi.fn(),
}));
vi.mock('../../../../src/commands/check/lib/bot-playtest.ts', () => ({ botPlaytest: vi.fn(), readScenario: vi.fn(() => Promise.resolve('no scenario')) }));
vi.mock('../../../../src/commands/check/lib/performance.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/check/lib/performance.ts')>()),
  performanceCheck: vi.fn(),
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

const ctx = { settings: () => Promise.resolve({ maxConcurrentInstances: 2 }) } as unknown as Context;
const game = { name: 'g', root: '/nowhere' } as GameRepo;
const UI_QUALITY = { settleMs: 0, maxFontSizes: 4, minFontPx: 18, minContrast: 3, maxFlatShare: 0.85, maxEmptyShare: 0.6 };
const settings = { buildPlatforms: ['ios', 'web'], targetFps: 60, loadingTimeLimitMs: 1000, rowSimulationSeeds: 2, uiQuality: UI_QUALITY } as GameSettings;
const options = { godot: 'godot', pollMs: 1, sampleMs: 1, probe: { sample: () => Promise.resolve(null) } } as unknown as Parameters<typeof gameChecks>[3];

function names(set: CheckSet): Promise<[string, string | null][]> {
  return gameChecks(ctx, game, settings, options, { root: '/nowhere', dir: null, relative: false }, set).then((checks) => checks.map((c) => [c.name, c.platform]));
}

beforeEach(() => {
  vi.mocked(regressionTest).mockReset().mockResolvedValue(pass('regression test'));
  vi.mocked(staticCheck).mockReset().mockResolvedValue(pass('static check'));
  vi.mocked(botPlaytest).mockReset().mockResolvedValue([pass('no blocker'), pass('full flow')]);
  vi.mocked(performanceCheck).mockReset().mockImplementation((_c, _g, platform) => Promise.resolve(pass('performance', platform)));
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

  it('all also runs no placeholder and row simulation', async () => {
    expect((await names('all')).slice(-2)).toEqual([['no placeholder', null], ['row simulation', null]]);
    expect(placeholderFailures).toHaveBeenCalledTimes(1);
    expect(rowSimulationCheck).toHaveBeenCalledTimes(1);
  });
});
