import { existsSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setNet } from '../../../src/commands/env/lib/net.ts';
import {
  gameCoreSpec,
  gameModules,
  generateCheckout,
  mergedCoreSettings,
  mergeReleaseSettings,
  moduleFilesWithoutDev,
  planGenerate,
  runGenerate,
} from '../../../src/commands/generate/api.ts';
import { applyPlan } from '../../../src/commands/generate/lib/apply.ts';
import { hostPlatform } from '../../../src/commands/core/lib/impl.ts';
import { appNameSource, localizedAppNames } from '../../../src/commands/generate/lib/project.ts';
import { ogw, makeGame, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { ctxOf, fakeNet, GAME_SETTINGS, makeRelease, SERVED, sha256Of, storedZip, write } from './helpers.ts';

vi.mock('../../../src/commands/core/api.ts', async () => (await import('./helpers.ts')).coreApiMock);

const RTC_URL = 'https://example.test/webrtc-native.zip';
const RTC_ZIP = storedZip({ 'addons/webrtc/webrtc.gdextension': 'rtc' });
SERVED.set(RTC_URL, RTC_ZIP);
let downloads = new Map<string, number>();

beforeEach(() => {
  downloads = new Map();
  setNet(fakeNet(downloads));
});

afterEach(() => {
  setNet(null);
});

const RESOURCES = [
  'key,description,spec,status,method,source,license,attribution,sha256,text_key,speaker,text_hash',
  'app_icon/main,i,size=1024x1024,placeholder,,,,,,,,',
  'scene/lobby/main,s,,final,,,,,,,,',
  'bgm/battle,b,length=1000,final,m,https://a,CC-BY-4.0,Ann,,,,',
  'icon/sword,i,size=1x1,final,m,https://a,CC-BY-4.0,Ann,,,,',
].join('\n');

const RESERVED_STRING = '"desc",,,\nAll,All,,\nid(key),tstring<id>,,\nid,text,,\n[app_name],내 게임,,\n[other],x,,\n';

function setup(files: Record<string, string | object> = {}): { ws: TestWorkspace; root: string; release: string } {
  const ws = makeWorkspace();
  const host = hostPlatform();
  const release = makeRelease(ws, '1.0.0', {
    plugins: {
      [`ogw-secure-storage/${host}/addons/ogw-secure-storage/lib.gdextension`]: 'ext',
      'ogw-iap-google/android/addons/ogw-iap-google/x.aar': 'aar',
    },
    enginePlugins: [
      { name: 'ogw-secure-storage', version: '1.0.0', platforms: ['android', host], url: 'u', sha256: 's' },
      { name: 'ogw-iap-google', version: '1.0.0', platforms: ['android'], url: 'u', sha256: 's' },
      { name: 'webrtc-native', version: '1.1.0', platforms: [host], url: RTC_URL, sha256: sha256Of(RTC_ZIP) },
      { name: 'ads-sdk', version: '2.0.0', platforms: ['android'], url: 'https://example.test/missing.zip', sha256: '' },
    ],
  });
  const root = makeGame(ws, 'g', {
    'settings.json': GAME_SETTINGS,
    'resource/resources.csv': RESOURCES,
    'data/system/reserved_string.csv': RESERVED_STRING,
    'data/translations/en.csv': 'key,source,source_hash,current_hash,text\nreserved_string.text.[app_name],내 게임,h,h,My Game\n',
    'data/translations/zh-Hans.csv': 'key,source,source_hash,current_hash,text\nreserved_string.text.[app_name],내 게임,,h,\n',
    'data/tables/level.csv': '',
    'client/features/match/sim/board.gd': 'var r := GameData.LevelTable.get_row(1)\nvar s := GameData.FriendLimitTable\n',
    'client/dev/features/match/match_dev.gd': 'class_name MatchDev\n',
    'client/boot/project_settings.cfg': '[input]\njump={\n"deadzone": 0.5,\n"events": []\n}\n',
    ...files,
  });
  return { ws, root, release };
}

describe('planGenerate', () => {
  it('plans every output', async () => {
    const { ws, root, release } = setup();
    const ctx = ctxOf(ws);
    const plan = await planGenerate(ctx, await ctx.game('g'));
    const file = (path: string): string => String(plan.files.get(path));
    expect(file('server/generated/core_settings.json')).toBe(file('client/generated/core_settings.json'));
    // the prepared modules of a dev run: the used modules and their DEV modules QACore (with UICore, which only QACore
    // needs), cheat (with server-time)
    expect(JSON.parse(file('client/generated/core_settings.json'))).toEqual({
      'NetworkCore.retryCount': 5,
      'NetworkCore.timeouts': { connectMs: 1000, readMs: 9000 },
      firstScene: 'scene/lobby/main',
      gamepadSupported: false,
      maxResolution: null,
      appId: '',
      titleScene: '',
      uiCheckScreens: [],
      'environments.DEV.serverUrl': 'https://dev',
      'environments.STG.serverUrl': '',
      'environments.PROD.serverUrl': 'https://prod',
      'environments.DEV.devAllowedCidrs': [],
      'environments.STG.devAllowedCidrs': [],
      'environments.PROD.devAllowedCidrs': [],
    });
    // the core settings type file: the spec type of each settings row of the prepared modules, by key
    expect(JSON.parse(file('client/generated/core_settings_types.json'))).toEqual({
      firstScene: 'string',
      gamepadSupported: 'boolean',
      maxResolution: 'array<integer>?',
      appId: 'string',
      titleScene: 'string',
      uiCheckScreens: 'array<object>',
      'NetworkCore.retryCount': 'integer',
      'environments.DEV.serverUrl': 'string',
      'environments.STG.serverUrl': 'string',
      'environments.PROD.serverUrl': 'string',
      'environments.DEV.devAllowedCidrs': 'array<string>',
      'environments.STG.devAllowedCidrs': 'array<string>',
      'environments.PROD.devAllowedCidrs': 'array<string>',
    });
    expect(plan.files.has('server/generated/core_settings_types.json')).toBe(false);
    expect(JSON.parse(file('client/generated/resource_keys.json'))).toEqual({
      'app_icon/main': { path: 'res://resource/app_icon/main.png', variants: 1 },
      'scene/lobby/main': { path: 'res://resource/scene/lobby/main.tscn', variants: 1 },
      'bgm/battle': { path: 'res://resource/bgm/battle.ogg', variants: 1 },
      'icon/sword': { path: 'res://resource/icon/sword.png', variants: 1 },
    });
    expect(file('server/generated/resource_keys.json')).toBe(file('client/generated/resource_keys.json'));
    expect(file('client/generated/resource_key.gd')).toContain('\nconst APP_ICON__MAIN: String = "app_icon/main"\nconst BGM__BATTLE: String = "bgm/battle"\n');
    expect(file('server/generated/resource_key.ts')).toContain('export const SCENE__LOBBY__MAIN: string = "scene/lobby/main";\n');
    expect(file('client/generated/core_modules.gd')).toContain(
      '\t\t_entry("LogCore", LogCore.init, LogCore.release, LogCore.is_initialized),\n\t\t_entry("EventCore", EventCore.init, EventCore.release, EventCore.is_initialized),\n\t\t_entry("NetworkCore", NetworkCore.init, NetworkCore.release, NetworkCore.is_initialized),\n\t]',
    );
    expect(JSON.parse(file('server/generated/server_modules.json'))).toEqual(['auth', 'cheat', 'friend', 'migration', 'routing', 'server-time', 'storage', 'user-snapshot-clone']);
    const licenses = JSON.parse(file('client/generated/licenses.json')) as { components: { name: string }[]; texts: object };
    expect(licenses.components.map((c) => c.name)).toEqual(['Godot Engine', 'net-lib', 'bgm/battle, icon/sword']);
    expect(licenses.texts).toEqual({ MIT: 'MIT text', 'BSD-3-Clause': 'BSD text' });
    // friend_limit is a core spec table with no file in data/tables or data/system, so it is not listed.
    expect(file('data/simulation_tables.csv')).toBe('table\nlevel\n');
    expect(file('client/dev/generated/dev_registration.gd')).toContain('\tMatchDev.register()\n');
    expect(file('server/generated/tick_changed_versions.ts')).toBe('export const TickChangedVersions: readonly string[] = [];\n');
    const project = file('client/project.godot');
    expect(project).toContain('config/name="내 게임"');
    expect(project).toContain('config/name_localized={\n"ko": "내 게임",\n"en": "My Game",\n"zh_Hans": "내 게임"\n}');
    expect(project).toContain('\njump={\n');
    expect(project).toContain('window/handheld/orientation=5');
    expect(file('client/boot/boot.gd')).toContain('BootstrapCore.start_boot.call_deferred(ContentBoot.new())');
    expect(file('client/.gitignore')).toBe('addons/\nandroid/\nios/plugins/\n.godot/\n');
    expect(plan.files.has('client/boot/boot.tscn')).toBe(true);
    // Godot's skip import mode: the resource list file is neither imported as a translation CSV nor exported
    expect(file('resource/resources.csv.import')).toBe('[remap]\n\nimporter="skip"\n');
    expect(plan.links).toEqual([{ path: 'client/resource', target: '../resource' }]);
    expect(plan.mirrors).toEqual([
      { source: join(release, 'extracted', 'client-godot.zip', 'core'), target: 'client/core' },
      { source: join(release, 'extracted', 'server.tgz'), target: 'server/core' },
    ]);
    const packages = join(ws.root, '.ogw', 'engine-packages');
    expect(plan.overlays).toEqual([
      { source: join(packages, sha256Of(SERVED.get('https://example.test/gut-9.4.0.zip') as Buffer), 'files'), target: 'client' },
      { source: join(release, 'extracted', 'client-godot-plugins.zip', 'ogw-secure-storage', hostPlatform()), target: 'client' },
      { source: join(packages, sha256Of(RTC_ZIP), 'files'), target: 'client' },
    ]);
    const applied = await applyPlan(root, plan);
    expect(applied.written).toContain('client/core/log_core/log_core.gd');
    expect(readFileSync(join(root, 'server', 'core', 'Dockerfile'), 'utf8')).toBe('FROM x\n');
    expect(existsSync(join(root, 'client', 'addons', 'ogw-secure-storage', 'lib.gdextension'))).toBe(true);
    expect(existsSync(join(root, 'client', 'addons', 'ogw-iap-google'))).toBe(false);
    expect(readFileSync(join(root, 'client', 'addons', 'gut', 'gut_cmdln.gd'), 'utf8')).toBe('extends SceneTree\n');
    expect(readFileSync(join(root, 'client', 'addons', 'webrtc', 'webrtc.gdextension'), 'utf8')).toBe('rtc');
    expect(existsSync(join(packages, sha256Of(RTC_ZIP), 'download.zip'))).toBe(false);
    await planGenerate(ctx, await ctx.game('g'));
    expect([...downloads.values()]).toEqual([1, 1]);
    expect(readlinkSync(join(root, 'client', 'resource'))).toBe('../resource');
  });

  it('writes the variant count of a resource key and only GUT without plugins', async () => {
    const ws = makeWorkspace();
    makeRelease(ws, '1.0.0');
    makeGame(ws, 'g', {
      'settings.json': { ...GAME_SETTINGS, supportedLanguages: undefined },
      'resource/resources.csv': 'key,spec\nsfx/hit,length=100;variants=3\n',
    });
    const ctx = ctxOf(ws);
    const plan = await planGenerate(ctx, await ctx.game('g'));
    expect(plan.overlays.map((o) => o.source.endsWith('files'))).toEqual([true]);
    expect(JSON.parse(String(plan.files.get('client/generated/resource_keys.json')))).toEqual({
      'sfx/hit': { path: 'res://resource/sfx/hit.wav', variants: 3 },
    });
    expect(String(plan.files.get('client/project.godot'))).toContain('config/name=""');
    expect(String(plan.files.get('client/project.godot'))).toContain('config/name_localized={}');
  });

  it('works without resources.csv', async () => {
    const ws = makeWorkspace();
    makeRelease(ws, '1.0.0');
    makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS });
    const ctx = ctxOf(ws);
    const plan = await planGenerate(ctx, await ctx.game('g'));
    expect(String(plan.files.get('client/generated/resource_keys.json'))).toBe('{}\n');
    expect(String(plan.files.get('server/generated/resource_key.ts'))).toBe('export {};\n');
    expect(plan.files.has('resource/resources.csv.import')).toBe(false);
  });

  it('fails on an unpinned plugin, a SHA-256 mismatch, a failed download and a missing plugin build', async () => {
    const host = hostPlatform();
    const cases: [object[], string][] = [
      [[{ name: 'rtc', platforms: [host], url: RTC_URL, sha256: '' }], 'engine.json item rtc has no url or sha256. Run ogw core pin-engine'],
      [[{ name: 'rtc', platforms: [host], sha256: sha256Of(RTC_ZIP) }], 'engine.json item rtc has no url or sha256'],
      [[{ name: 'rtc', platforms: [host], url: RTC_URL, sha256: 'a'.repeat(64) }], `SHA-256 of rtc from ${RTC_URL} is ${sha256Of(RTC_ZIP)}, not ${'a'.repeat(64)}`],
      [[{ name: 'rtc', platforms: [host], url: 'https://example.test/none.zip', sha256: 'b'.repeat(64) }], 'download failed (404): https://example.test/none.zip'],
      [[{ name: 'ogw-x', platforms: [host], url: 'u', sha256: 's' }], `client-godot-plugins.zip of core 1.0.0 has no ogw-x/${host}/`],
    ];
    for (const [enginePlugins, message] of cases) {
      const ws = makeWorkspace();
      makeRelease(ws, '1.0.0', { enginePlugins, plugins: { 'ogw-y/linux/a': 'a' } });
      makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS });
      const ctx = ctxOf(ws);
      await expect(planGenerate(ctx, await ctx.game('g'))).rejects.toThrow(message);
      expect(existsSync(join(ws.root, '.ogw', 'engine-packages', 'a'.repeat(64), 'files'))).toBe(false);
    }
  });

  it('fails without a gut item', async () => {
    const ws = makeWorkspace();
    const release = makeRelease(ws, '1.0.0');
    write(join(release, 'extracted', 'client-godot.zip', 'engine.json'), { godot: '4.5.1.stable', plugins: [] });
    makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS });
    const ctx = ctxOf(ws);
    await expect(planGenerate(ctx, await ctx.game('g'))).rejects.toThrow('engine.json has no gut item');
  });

  it('fails on another engine, a bad baseResolution, a bad project_settings.cfg and a bad core settings file', async () => {
    const ws = makeWorkspace();
    const release = makeRelease(ws, '1.0.0');
    const ctx = ctxOf(ws);
    makeGame(ws, 'a', { 'settings.json': { ...GAME_SETTINGS, engine: 'unity' } });
    await expect(planGenerate(ctx, await ctx.game('a'))).rejects.toThrow('not defined: engine rules for engine unity');
    makeGame(ws, 'b', { 'settings.json': { ...GAME_SETTINGS, baseResolution: [1] } });
    await expect(planGenerate(ctx, await ctx.game('b'))).rejects.toThrow('game settings baseResolution is missing or invalid');
    makeGame(ws, 'c', { 'settings.json': GAME_SETTINGS, 'client/boot/project_settings.cfg': '[application]\nconfig/name="x"\n' });
    await expect(planGenerate(ctx, await ctx.game('c'))).rejects.toThrow(
      'client/boot/project_settings.cfg:2: key application/config/name is not allowed',
    );
    write(join(release, 'core-settings.json'), []);
    makeGame(ws, 'd', { 'settings.json': GAME_SETTINGS });
    await expect(planGenerate(ctx, await ctx.game('d'))).rejects.toThrow('core settings file is not a JSON object');
  });
});

describe('runGenerate and ogw generate', () => {
  it('write the outputs, then nothing when the bytes are the same', async () => {
    const { ws, root } = setup();
    const ctx = ctxOf(ws);
    const first = await generateCheckout(ctx, await ctx.game('g'));
    expect(first.written).toEqual(expect.arrayContaining([
      'client/project.godot',
      'client/generated/core_modules.gd',
      'client/generated/resource_key.gd',
      'server/generated/core_settings.json',
      'server/generated/server_modules.json',
      'server/generated/resource_keys.json',
      'server/generated/resource_key.ts',
      'client/addons/gut/gut_cmdln.gd',
    ]));
    expect(existsSync(join(root, '.git', 'ogw-generate.lock'))).toBe(false);
    expect(await generateCheckout(ctx, await ctx.game('g'))).toEqual({ written: [], removed: [] });
    await runGenerate(ctx, await ctx.game('g'));
    const run = await ogw(ws, ['generate', 'g']);
    expect(run.code).toBe(0);
    expect((await ogw(ws, ['generate'])).stderr).toContain('usage: ogw generate <game>');
  });

  it('generates a folder that is not a git checkout', async () => {
    const { ws, root } = setup();
    rmSync(join(root, '.git'), { recursive: true, force: true });
    const applied = await generateCheckout(ctxOf(ws), { name: 'bench', root, mainRoot: root, commonDir: join(root, '.git'), inWorktree: false });
    expect(applied.written).toContain('client/project.godot');
    expect(existsSync(join(root, '.ogw-generate.lock'))).toBe(false);
  });

  it('waits for the generate lock of the checkout', async () => {
    const { ws, root } = setup();
    const ctx = ctxOf(ws);
    write(join(root, '.git', 'ogw-generate.lock', 'pid'), String(process.pid));
    const pending = generateCheckout(ctx, await ctx.game('g')).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(join(root, 'client', 'project.godot'))).toBe(false);
    sh(root, 'rm', ['-rf', join(root, '.git', 'ogw-generate.lock')]);
    expect(await pending).toEqual(expect.objectContaining({ removed: [] }));
    expect(existsSync(join(root, 'client', 'project.godot'))).toBe(true);
  });
});

describe('mergedCoreSettings and gameModules', () => {
  it('merge the release core settings with game settings core and list used modules by side', async () => {
    const { ws, release } = setup();
    const ctx = ctxOf(ws);
    const game = await ctx.game('g');
    expect(await mergedCoreSettings(ctx, game)).toEqual({
      'NetworkCore.retryCount': 5,
      'NetworkCore.timeouts': { connectMs: 1000, readMs: 9000 },
    });
    expect(await mergeReleaseSettings(release, 'not an object')).toEqual({
      'NetworkCore.retryCount': 3,
      'NetworkCore.timeouts': { connectMs: 1000, readMs: 2000 },
    });
    expect(await gameModules(ctx, game)).toEqual({
      client: ['BootstrapCore', 'EventCore', 'LogCore', 'NetworkCore', 'UtilCore'],
      server: ['auth', 'friend', 'migration', 'routing', 'storage', 'user-snapshot-clone'],
    });
    const spec = await gameCoreSpec(ctx, game);
    expect(spec.version).toBe('1.0.0');
    expect(spec.modules.find((m) => m.name === 'UtilCore')?.lifecycle).toBe(false);
  });
});

describe('moduleFilesWithoutDev', () => {
  it('makes the STG and PROD core settings file and server module list of the used modules only', async () => {
    const { ws } = setup();
    const ctx = ctxOf(ws);
    const files = await moduleFilesWithoutDev(ctx, await ctx.game('g'));
    expect(JSON.parse(files.serverModules)).toEqual(['auth', 'friend', 'migration', 'routing', 'storage', 'user-snapshot-clone']);
    expect(JSON.parse(files.coreSettings)).toEqual({
      'NetworkCore.retryCount': 5,
      'NetworkCore.timeouts': { connectMs: 1000, readMs: 9000 },
      firstScene: 'scene/lobby/main',
      gamepadSupported: false,
      maxResolution: null,
      appId: '',
      'environments.DEV.serverUrl': 'https://dev',
      'environments.STG.serverUrl': '',
      'environments.PROD.serverUrl': 'https://prod',
    });
  });
});

describe('app name', () => {
  it('reads the source text and translations, falling back to the source text', async () => {
    const { root } = setup();
    expect(await appNameSource(root)).toBe('내 게임');
    expect(await localizedAppNames(root, ['ko', 'en', 'ja'], '내 게임')).toEqual([
      ['ko', '내 게임'],
      ['en', 'My Game'],
      ['ja', '내 게임'],
    ]);
    const { root: other } = setup({ 'data/system/reserved_string.csv': '"d",\nAll,All\nid(key),tstring<id>\nid,text\n[x],y\n' });
    expect(await appNameSource(other)).toBe('');
  });
});
