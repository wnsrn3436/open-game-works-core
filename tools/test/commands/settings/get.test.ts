import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coreRelease } from '../../../src/commands/core/api.ts';
import { ogw, makeGame, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { CORE_SCHEMA, CORE_SETTINGS, CORE_VERSION, readHarnessSettingsFile, validGameSettings, writeRelease } from './fixtures.ts';
import { writeCoreImpl } from './core-impl.ts';

vi.mock('../../../src/commands/core/api.ts', () => ({
  coreRelease: vi.fn(),
  coreReleaseOfGame: vi.fn(),
  extractedAsset: vi.fn(),
  remoteReleaseVersions: vi.fn(),
  markProposalReleased: vi.fn(),
}));

let ws: TestWorkspace;

beforeEach(() => {
  ws = makeWorkspace({ jobWaitTimeoutMs: 1234 });
  vi.mocked(coreRelease).mockResolvedValue(writeRelease(join(ws.root, 'release')));
  const settings = validGameSettings();
  settings.core = { 'InputBlockCore.maxDurationMs': 40000, 'UICore.theme': { color: 'red' } };
  makeGame(ws, 'mygame', { 'settings.json': settings });
});

const get = (...argv: string[]) => ogw(ws, ['settings', 'get', ...argv]);

describe('ogw settings get', () => {
  it('prints a written value as JSON', async () => {
    expect(await get('harness', 'jobWaitTimeoutMs')).toEqual({ code: 0, stdout: '1234\n', stderr: '' });
    expect((await get('game', 'mygame', 'environments.DEV.adminOperators.0.name')).stdout).toBe('"ogw"\n');
    expect((await get('game', 'mygame', 'baseResolution')).stdout).toBe('[\n  1280,\n  720\n]\n');
  });

  it('gives value and source as JSON', async () => {
    const run = await ogw(ws, ['settings', 'get', 'game', 'mygame', 'appId', '--json']);
    expect(JSON.parse(run.stdout)).toEqual({ path: 'appId', value: 'com.example.mygame', source: 'game settings' });
  });

  it('gives the schema default of a value not written', async () => {
    expect((await get('game', 'mygame', 'loopIterationLimit')).stdout).toBe('20\nsource: schema default\n');
    expect((await get('game', 'mygame', 'pushConsent.nightStartMinute')).stdout).toBe('1260\nsource: schema default\n');
    expect((await get('game', 'mygame', 'environments.DEV.containerLog.maxBytes')).stdout).toBe('104857600\nsource: schema default\n');
    expect((await get('game', 'mygame', 'uiCheckScreens.0.keyboard')).stdout).toBe('0\nsource: schema default\n');
    const harness = readHarnessSettingsFile(join(ws.harness, 'settings.json'));
    delete harness.useLocalCore;
    writeFileSync(join(ws.harness, 'settings.json'), JSON.stringify(harness));
    expect((await get('harness', 'useLocalCore')).stdout).toBe('false\nsource: schema default\n');
  });

  it('gives a core settings key of game settings with its source', async () => {
    expect((await get('game', 'mygame', 'core.InputBlockCore.maxDurationMs')).stdout).toBe('40000\nsource: game settings\n');
    expect((await get('game', 'mygame', 'core.NetworkCore.requestTimeoutMs')).stdout).toBe('10000\nsource: core settings\n');
    expect((await get('game', 'mygame', 'core.UICore.theme.color')).stdout).toBe('"red"\nsource: game settings\n');
    expect((await get('game', 'mygame', 'core.UICore.theme.size')).stdout).toBe('2\nsource: core settings\n');
    expect((await get('game', 'mygame', 'core.UICore.theme.dark')).stdout).toBe('false\nsource: schema default\n');
    expect((await get('game', 'mygame', 'core')).stdout).toBe(
      `${JSON.stringify({ 'InputBlockCore.maxDurationMs': 40000, 'UICore.theme': { color: 'red' } }, null, 2)}\n`,
    );
  });

  it('gives an object core settings key that game settings write in part merged over the release value', async () => {
    expect((await get('game', 'mygame', 'core.UICore.theme')).stdout).toBe(
      `${JSON.stringify({ color: 'red', size: 2 }, null, 2)}\nsource: game settings over core settings\n`,
    );
    const run = await ogw(ws, ['settings', 'get', 'game', 'mygame', 'core.UICore.theme', '--json']);
    expect(JSON.parse(run.stdout)).toEqual({
      path: 'core.UICore.theme',
      value: { color: 'red', size: 2 },
      source: 'game settings over core settings',
    });
  });

  it('reads the core release of the game settings coreVersion', async () => {
    await get('game', 'mygame', 'core.NetworkCore.requestTimeoutMs');
    expect(vi.mocked(coreRelease)).toHaveBeenCalledWith(expect.anything(), CORE_VERSION);
    expect(vi.mocked(coreRelease).mock.calls.every((call) => call[1] === CORE_VERSION)).toBe(true);
  });

  it('gives no value at an array element that the used value does not have', async () => {
    expect(await get('game', 'mygame', 'uiCheckScreens.5.keyboard')).toEqual({
      code: 1,
      stdout: '',
      stderr: 'no value: uiCheckScreens.5.keyboard\n',
    });
    expect((await get('game', 'mygame', 'uiCheckScreens.1.keyboard')).stderr).toBe('no value: uiCheckScreens.1.keyboard\n');
  });

  describe('core settings keys replaced or missing', () => {
    beforeEach(() => {
      const dir = join(ws.root, 'release');
      const settings = { ...CORE_SETTINGS, 'AccessibilityCore.textScales': [800, 1000, 1200, 1500] };
      const properties = {
        ...CORE_SCHEMA.properties,
        'AccessibilityCore.textScales': { type: 'array', items: { type: 'integer', default: 7 } },
        'AccessibilityCore.extra': { items: { type: 'integer', default: 3 } },
        'AccessibilityCore.map': { type: 'object', additionalProperties: { type: 'integer', default: 4 } },
      };
      writeFileSync(join(dir, 'core-settings.json'), JSON.stringify(settings));
      writeFileSync(join(dir, 'core-settings.schema.json'), JSON.stringify({ ...CORE_SCHEMA, properties }));
    });

    const withCore = (core: Record<string, unknown>) => {
      const settings = validGameSettings();
      settings.core = core;
      writeFileSync(join(ws.games, 'mygame', 'settings.json'), JSON.stringify(settings));
    };

    it('replaces a core settings array with the game settings array', async () => {
      withCore({ 'AccessibilityCore.textScales': [1000, 1500] });
      expect(await get('game', 'mygame', 'core.AccessibilityCore.textScales.3')).toEqual({
        code: 1,
        stdout: '',
        stderr: 'no value: core.AccessibilityCore.textScales.3\n',
      });
      expect((await get('game', 'mygame', 'core.AccessibilityCore.textScales.1')).stdout).toBe('1500\nsource: game settings\n');
    });

    it('reads a core settings array element the game settings do not replace', async () => {
      withCore({});
      expect((await get('game', 'mygame', 'core.AccessibilityCore.textScales.3')).stdout).toBe('1500\nsource: core settings\n');
      expect((await get('game', 'mygame', 'core.AccessibilityCore.textScales.4')).stderr).toBe(
        'no value: core.AccessibilityCore.textScales.4\n',
      );
    });

    it('gives no schema default under a value that game settings replaced with a non-object', async () => {
      withCore({ 'UICore.theme': 'plain' });
      expect((await get('game', 'mygame', 'core.UICore.theme.size')).stderr).toBe('no value: core.UICore.theme.size\n');
      withCore({ 'UICore.theme': { color: 'red' } });
      expect((await get('game', 'mygame', 'core.UICore.theme.size')).stdout).toBe('2\nsource: core settings\n');
    });

    it('gives game settings as the source of an object the release does not hold as an object', async () => {
      withCore({ 'AccessibilityCore.map': { a: 1 } });
      expect((await get('game', 'mygame', 'core.AccessibilityCore.map')).stdout).toBe(`${JSON.stringify({ a: 1 }, null, 2)}\nsource: game settings\n`);
      withCore({ 'UICore.theme': 'plain' });
      expect((await get('game', 'mygame', 'core.UICore.theme')).stdout).toBe('"plain"\nsource: game settings\n');
      withCore({ 'AccessibilityCore.textScales': { a: 1 } });
      expect((await get('game', 'mygame', 'core.AccessibilityCore.textScales')).stdout).toBe(`${JSON.stringify({ a: 1 }, null, 2)}\nsource: game settings\n`);
    });

    it('gives no schema default for an element of an array without a value', async () => {
      expect((await get('game', 'mygame', 'core.AccessibilityCore.extra.0')).stderr).toBe('no value: core.AccessibilityCore.extra.0\n');
      expect((await get('game', 'mygame', 'core.AccessibilityCore.map.0')).stdout).toBe('4\nsource: schema default\n');
    });
  });

  it('reads the core target', async () => {
    writeCoreImpl(ws);
    expect((await get('core', 'NetworkCore.requestTimeoutMs')).stdout).toBe('10000\n');
    expect((await get('core', 'UICore.theme.size')).stdout).toBe('2\n');
    expect((await get('core', 'UICore.theme.dark')).stdout).toBe('false\nsource: schema default\n');
  });

  it('fails for a path without a value or schema', async () => {
    expect(await get('game', 'mygame', 'appleTeamId')).toEqual({ code: 1, stdout: '', stderr: 'no value: appleTeamId\n' });
    expect(await get('game', 'mygame', 'nope')).toEqual({ code: 1, stdout: '', stderr: 'not a settings path: nope\n' });
    expect(await get('game', 'mygame', 'core.Nope.key')).toEqual({ code: 1, stdout: '', stderr: 'no core settings key in core.Nope.key\n' });
    expect(await get('game', 'mygame', 'core.UICoreX')).toEqual({ code: 1, stdout: '', stderr: 'no core settings key in core.UICoreX\n' });
    expect((await get('game', 'mygame', 'a..b')).stderr).toBe('invalid settings path: a..b\n');
    expect((await get('game', 'mygame', 'core.UICore.theme.')).stderr).toBe('invalid settings path: core.UICore.theme.\n');
  });

  it('fails for a core settings key when game settings have no coreVersion', async () => {
    const settings = validGameSettings();
    delete settings.coreVersion;
    writeFileSync(join(ws.games, 'mygame', 'settings.json'), JSON.stringify(settings));
    expect((await get('game', 'mygame', 'core.UICore.theme')).stderr).toBe('game settings have no coreVersion\n');
  });

  it('checks the arguments', async () => {
    const usage = 'usage: ogw settings get <harness|game <game>|core> <path>\n';
    expect((await get()).stderr).toBe(usage);
    expect((await get('game')).stderr).toBe(usage);
    expect((await get('other', 'x')).stderr).toBe(usage);
    expect((await get('harness')).stderr).toBe(usage);
    expect((await get('harness', 'a', 'b')).stderr).toBe(usage);
    expect((await get('game', 'nogame', 'appId')).stderr).toBe(`game repo not found: ${join(ws.games, 'nogame')}\n`);
  });
});
