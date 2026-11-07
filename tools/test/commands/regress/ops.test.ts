import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coreRelease } from '../../../src/commands/core/api.ts';
import { stateSettings } from '../../../src/commands/regress/lib/ops.ts';
import { makeGame, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { validGameSettings, writeRelease } from '../settings/fixtures.ts';
import { ctxOf } from './helpers.ts';

vi.mock('../../../src/commands/core/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/core/api.ts')>()),
  coreRelease: vi.fn(),
}));

let ws: TestWorkspace;
let root: string;

beforeEach(() => {
  ws = makeWorkspace();
  vi.mocked(coreRelease).mockResolvedValue(writeRelease(join(ws.root, 'release')));
  const settings: Record<string, unknown> = validGameSettings();
  // two screens of a game made before pixelRatio was required, and a missing value that the content agent writes
  settings.uiCheckScreens = [
    { name: 'macbook_air_13', window: [1440, 900], fillMode: 'Letterbox', notch: [0, 0, 0, 0] },
    { name: 'macbook_pro_14_notch', window: [3024, 1964], fillMode: 'Letterbox', notch: [0, 74, 0, 0] },
  ];
  delete settings.titleScene;
  root = makeGame(ws, 'ogw-regress-lc', { 'settings.json': settings });
  // the hook of the state, which the commit of the values skips
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho refused >&2\nexit 1\n');
  chmodSync(hook, 0o755);
});

const screens = (): unknown => (JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')) as { uiCheckScreens: { pixelRatio?: number }[] }).uiCheckScreens.map((s) => s.pixelRatio);
const subject = (): string => sh(root, 'git', ['log', '-1', '--format=%s']).trim();

describe('stateSettings', () => {
  it('writes and commits the values, and names the missing values that are not the content agent\'s', async () => {
    const ctx = ctxOf(ws);
    const game = await ctx.game('ogw-regress-lc');
    expect(await stateSettings(ctx, game, { 'uiCheckScreens.0.pixelRatio': 1 }, '2.0.0')).toEqual({ ok: false, text: 'missing: uiCheckScreens.1.pixelRatio' });
    expect(screens()).toEqual([1, undefined]);
    expect(subject()).toBe('regress refresh 2.0.0: state settings');
    expect(sh(root, 'git', ['status', '--porcelain']).trim()).toBe('');
    // the missing titleScene is written by the content agent: it does not stop the refresh
    expect(await stateSettings(ctx, game, { 'uiCheckScreens.0.pixelRatio': 1, 'uiCheckScreens.1.pixelRatio': 2 }, '2.0.0')).toEqual({ ok: true, text: 'set' });
    expect(screens()).toEqual([1, 2]);
    const head = sh(root, 'git', ['rev-parse', 'HEAD']);
    expect(await stateSettings(ctx, game, { 'uiCheckScreens.0.pixelRatio': 1, 'uiCheckScreens.1.pixelRatio': 2 }, '2.0.0')).toEqual({ ok: true, text: 'none' });
    expect(await stateSettings(ctx, game, {}, '2.0.0')).toEqual({ ok: true, text: 'none' });
    expect(sh(root, 'git', ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('writes nothing when ogw settings set refuses a value', async () => {
    const ctx = ctxOf(ws);
    const game = await ctx.game('ogw-regress-lc');
    const head = sh(root, 'git', ['rev-parse', 'HEAD']);
    const written = await stateSettings(ctx, game, { 'uiCheckScreens.0.pixelRatio': 1, 'uiCheckScreens.1.pixelRatio': -1 }, '2.0.0');
    expect(written.ok).toBe(false);
    expect(written.text).toMatch(/^failed: .*pixelRatio/);
    expect(screens()).toEqual([undefined, undefined]);
    expect(sh(root, 'git', ['rev-parse', 'HEAD'])).toBe(head);
  });
});
