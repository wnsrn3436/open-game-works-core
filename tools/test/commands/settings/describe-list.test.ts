import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coreRelease } from '../../../src/commands/core/api.ts';
import { firstSentence } from '../../../src/commands/settings/lib/schema-nav.ts';
import { ogw, makeGame, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { writeCoreImpl } from './core-impl.ts';
import { schemaDescription, validGameSettings, writeRelease, type GameSettingsFixture } from './fixtures.ts';

vi.mock('../../../src/commands/core/api.ts', () => ({
  coreRelease: vi.fn(),
  coreReleaseOfGame: vi.fn(),
  extractedAsset: vi.fn(),
  remoteReleaseVersions: vi.fn(),
  markProposalReleased: vi.fn(),
}));

type Settings = GameSettingsFixture;

let ws: TestWorkspace;
let gameSchema: unknown;

beforeEach(() => {
  ws = makeWorkspace();
  vi.mocked(coreRelease).mockResolvedValue(writeRelease(join(ws.root, 'release')));
  makeGame(ws, 'mygame', { 'settings.json': validGameSettings() });
  gameSchema = JSON.parse(readFileSync(join(ws.harness, 'schemas', 'game-settings.schema.json'), 'utf8')) as unknown;
});

function writeGame(settings: Settings): void {
  writeFileSync(join(ws.games, 'mygame', 'settings.json'), JSON.stringify(settings));
}

const describeCmd = (...argv: string[]) => ogw(ws, ['settings', 'describe', ...argv]);
const list = (...argv: string[]) => ogw(ws, ['settings', 'list', ...argv]);

describe('ogw settings describe', () => {
  it('gives description, type and x-owner', async () => {
    const run = await describeCmd('game', 'mygame', 'titleScene');
    expect(run.stdout).toBe(`path: titleScene\ndescription: ${schemaDescription(gameSchema, 'properties', 'titleScene')}\ntype: string\nx-owner: content\n`);
  });

  it('gives allowed values and default', async () => {
    const cdn = await describeCmd('game', 'mygame', 'environments.DEV.adapters.cdn');
    expect(cdn.stdout).toBe('path: environments.DEV.adapters.cdn\nallowed: "fake" | "cdn-r2"\n');
    const limit = (await describeCmd('game', 'mygame', 'loopIterationLimit')).stdout.split('\n');
    expect(limit).toContain('type: integer');
    expect(limit).toContain('allowed: minimum 1');
    expect(limit).toContain('default: 20');
    expect(limit.some((l) => l.startsWith('x-owner'))).toBe(false);
    const url = (await describeCmd('game', 'mygame', 'environments.PROD.serverUrl')).stdout.split('\n');
    expect(url).toContain('allowed: pattern ^https://, format uri');
  });

  it('follows $ref and items', async () => {
    const secret = (await describeCmd('game', 'mygame', 'environments.DEV.adminOperators.0.secret')).stdout.split('\n');
    expect(secret).toContain('type: string');
    expect(secret).toContain('allowed: pattern ^[A-Za-z0-9][A-Za-z0-9._-]*$');
    const keyboard = (await describeCmd('game', 'mygame', 'uiCheckScreens.3.keyboard')).stdout.split('\n');
    expect(keyboard).toContain('default: 0');
    const map = (await describeCmd('game', 'mygame', 'purchaseLimits.monthlyBelowAge.13')).stdout.split('\n');
    expect(map).toContain('allowed: minimum 1');
    const signing = (await describeCmd('game', 'mygame', 'signing.android.keystore')).stdout.split('\n');
    expect(signing).toContain('type: string');
  });

  it('inherits x-owner and reads core settings keys from the release schema', async () => {
    expect((await describeCmd('game', 'mygame', 'coreModules.client')).stdout).toContain('x-owner: content\n');
    expect((await describeCmd('game', 'mygame', 'core.NetworkCore.requestTimeoutMs')).stdout).toBe(
      'path: core.NetworkCore.requestTimeoutMs\ndescription: Request timeout. In ms.\ntype: integer\nallowed: minimum 0\nx-owner: human\n',
    );
    expect((await describeCmd('game', 'mygame', 'core.InputBlockCore.maxDurationMs')).stdout).toContain('x-owner: content\n');
    expect((await describeCmd('game', 'mygame', 'core.UICore.theme.size')).stdout).toBe(
      'path: core.UICore.theme.size\ntype: integer\nallowed: minimum 1\ndefault: 2\nx-owner: content\n',
    );
  });

  it('describes harness and core targets', async () => {
    const measured = await describeCmd('harness', 'measured.flux2-klein');
    // `hosts` is empty: no host has an entry, so the path is not under one
    expect(measured.stdout).toContain('path: measured.flux2-klein\n');
    expect(measured.stdout).toContain('x-owner: tool\n');
    expect(measured.stdout).toContain('type: array\n');
    expect((await describeCmd('harness', 'playInstances')).stdout).toContain('default: 3\n');
    writeCoreImpl(ws);
    expect((await describeCmd('core', 'UICore.theme.dark')).stdout).toBe('path: UICore.theme.dark\ndescription: Dark theme.\ntype: boolean\ndefault: false\n');
  });

  it('gives JSON', async () => {
    const run = await ogw(ws, ['settings', 'describe', 'game', 'mygame', 'environments.DEV.adapters.cdn', '--json']);
    expect(JSON.parse(run.stdout)).toEqual({
      path: 'environments.DEV.adapters.cdn',
      description: null,
      type: null,
      allowed: { enum: ['fake', 'cdn-r2'] },
      default: null,
      xOwner: null,
    });
  });

  it('fails for a path the schema does not have', async () => {
    expect(await describeCmd('game', 'mygame', 'environments.DEV.nope')).toEqual({ code: 1, stdout: '', stderr: 'not a settings path: environments.DEV.nope\n' });
    expect((await describeCmd('game', 'mygame')).stderr).toBe('usage: ogw settings describe <harness|game <game>|core> <path>\n');
  });
});

describe('ogw settings list', () => {
  it('lists every schema path with the first sentence of its description', async () => {
    const lines = (await list('harness')).stdout.trim().split('\n');
    const harnessSchema = JSON.parse(readFileSync(join(ws.harness, 'schemas', 'harness-settings.schema.json'), 'utf8')) as unknown;
    expect(lines).toContain(`jobWaitTimeoutMs: ${firstSentence(schemaDescription(harnessSchema, 'properties', 'jobWaitTimeoutMs'))}`);
    expect(lines).toContain('$schema');
    expect(lines.some((l) => l.startsWith('paths.coreImpl'))).toBe(true);
    expect(lines.some((l) => l.startsWith('resourceGeneration.'))).toBe(false);
    const host = (keys: string[]): string => firstSentence(schemaDescription(harnessSchema, '$defs', 'host', 'properties', ...keys));
    expect(lines).toContain(`maxConcurrentInstances: ${host(['maxConcurrentInstances'])}`);
    expect(lines).toContain(`playInstances: ${host(['playInstances'])}`);
    expect(lines).toContain(`measured: ${host(['measured'])}`);
    expect(lines.some((l) => l.startsWith('name'))).toBe(false);
    const tool = JSON.parse((await ogw(ws, ['settings', 'list', 'harness', '--owner', 'tool', '--json'])).stdout) as { paths: { path: string }[] };
    expect(tool.paths.map((p) => p.path)).toEqual(['measured']);
  });

  it('lists game settings paths with core settings keys', async () => {
    const lines = (await list('game', 'mygame')).stdout.trim().split('\n');
    expect(lines).toContain('environments.DEV.deploy.host: SSH host name or address');
    expect(lines).toContain('core.NetworkCore.requestTimeoutMs: Request timeout.');
    expect(lines).toContain('core.UICore.theme.color: Color name.');
    expect(lines).toContain('core.UICore.theme.size');
    expect(lines.at(-1)).toBe('core.UICore.theme.dark: Dark theme.');
  });

  it('leaves core settings keys out without coreVersion', async () => {
    const settings = validGameSettings();
    delete settings.coreVersion;
    writeGame(settings);
    const lines = (await list('game', 'mygame')).stdout.trim().split('\n');
    expect(lines.some((l) => l.startsWith('core.'))).toBe(false);
    expect(lines.some((l) => l.startsWith('core:'))).toBe(true);
  });

  it('filters by x-owner', async () => {
    const run = await ogw(ws, ['settings', 'list', 'game', 'mygame', '--owner', 'content', '--json']);
    const paths = (JSON.parse(run.stdout) as { paths: { path: string; xOwner: string }[] }).paths;
    expect(paths.every((p) => p.xOwner === 'content')).toBe(true);
    const names = paths.map((p) => p.path);
    expect(names).toEqual([
      'coreModules',
      'coreModules.client',
      'coreModules.server',
      'dailyResetOffsetMs',
      'titleScene',
      'firstScene',
      'loadingScreen',
      'cutsceneView',
      'tutorialView',
      'termsPopup',
      'agePopup',
      'privacyPopup',
      'pushConsentPopup',
      'privacy',
      'privacy.contentData',
      'core',
      'core.InputBlockCore.maxDurationMs',
      'core.BootstrapCore.realtimeRelayOnly',
      'core.auth.maxAgeYears',
      'core.auth.childAgeYears',
      'core.auth.digitalConsentAgeYears',
      'core.UICore.theme',
      'core.UICore.theme.color',
      'core.UICore.theme.size',
      'core.UICore.theme.dark',
    ]);
    expect((await list('game', 'mygame', '--owner', 'human')).stdout).toBe('core.NetworkCore.requestTimeoutMs: Request timeout.\n');
  });

  it('lists missing setup stage values, including values a condition requires, and no build stage value', async () => {
    const settings = validGameSettings();
    delete settings.appId;
    delete settings.baseResolution;
    settings.buildPlatforms = ['web', 'android'];
    settings.consent = { ...settings.consent, ageConfirmation: true };
    writeGame(settings);
    const lines = (await list('game', 'mygame', '--missing')).stdout.trim().split('\n');
    expect(lines).toEqual([
      `agePopup: ${firstSentence(schemaDescription(gameSchema, 'properties', 'agePopup'))}`,
      `baseResolution: ${firstSentence(schemaDescription(gameSchema, 'properties', 'baseResolution'))}`,
    ]);
    // the build stage values (appId, signing, androidKeyAlias, the web environment values) are left to the build check
    expect((await ogw(ws, ['game', 'check', 'mygame', '--build'])).stdout).toContain('appId: missing\n');
  });

  it('lists missing values of harness and core targets', async () => {
    expect(await list('harness', '--missing')).toEqual({ code: 0, stdout: '', stderr: '' });
    writeCoreImpl(ws);
    const schemaPath = join(ws.coreImpl, 'settings', 'core-settings.schema.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as { required?: string[]; properties: Record<string, unknown> };
    schema.required = ['NetworkCore.requestTimeoutMs', 'Other.key'];
    schema.properties['Other.key'] = { type: 'string', description: 'Other. More.', 'x-owner': 'human' };
    writeFileSync(schemaPath, JSON.stringify(schema));
    expect((await list('core', '--missing')).stdout).toBe('Other.key: Other.\n');
    expect((await list('core', '--owner', 'human')).stdout).toBe('NetworkCore.requestTimeoutMs: Request timeout.\nOther.key: Other.\n');
  });

  it('checks the arguments', async () => {
    expect((await list('harness', 'extra')).stderr).toBe('usage: ogw settings list <harness|game <game>|core> [--owner <owner>] [--missing]\n');
  });
});

describe('firstSentence', () => {
  it('cuts at the first period followed by white space', () => {
    expect(firstSentence('One. Two. Three')).toBe('One.');
    expect(firstSentence('예: ghcr.io/a 끝')).toBe('예: ghcr.io/a 끝');
    expect(firstSentence('Line one.\nLine two')).toBe('Line one.');
    expect(firstSentence('Ends here.')).toBe('Ends here.');
    expect(firstSentence(undefined)).toBe('');
  });
});
