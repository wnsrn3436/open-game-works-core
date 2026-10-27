import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coreRelease, extractedAsset } from '../../../src/commands/core/api.ts';
import { bulletStartsWith, deployBullets, bulletsByStart, HUMAN_PREP } from '../../../src/commands/game/lib/human-prep.ts';
import { ogw, makeGame, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { CORE_SETTINGS, validGameSettings, writeRelease } from '../settings/fixtures.ts';
import type { GameSettingsFixture } from '../settings/fixtures.ts';

vi.mock('../../../src/commands/core/api.ts', () => ({
  coreRelease: vi.fn(),
  coreReleaseOfGame: vi.fn(),
  extractedAsset: vi.fn(),
  remoteReleaseVersions: vi.fn(),
  markProposalReleased: vi.fn(),
}));

type Settings = GameSettingsFixture;

let ws: TestWorkspace;

/** The `engine.json` plugins of the release, whose `client-godot-plugins.zip` holds each `<plugin>/<platform>/`. */
function writePlugins(dir: string, plugins: { name: string; platforms: string[] }[]): void {
  writeFileSync(join(dir, 'engine.json'), JSON.stringify({ godot: '4.5.1.stable', plugins }));
  for (const { name, platforms } of plugins) for (const platform of platforms) mkdirSync(join(dir, name, platform), { recursive: true });
}

beforeEach(() => {
  ws = makeWorkspace();
  const release = writeRelease(join(ws.root, 'release'));
  vi.mocked(coreRelease).mockResolvedValue(release);
  // every asset of the release extracts to its folder
  vi.mocked(extractedAsset).mockResolvedValue(release.dir);
  writePlugins(release.dir, [{ name: 'ogw-secure-storage', platforms: ['android', 'ios', 'macos', 'windows', 'linux'] }]);
});

function writeSettings(settings: Settings): void {
  if (existsSync(join(ws.games, 'mygame'))) writeFileSync(join(ws.games, 'mygame', 'settings.json'), JSON.stringify(settings));
  else makeGame(ws, 'mygame', { 'settings.json': settings });
}

async function check(change: (s: Settings) => void = () => undefined, extra: string[] = []) {
  const settings = validGameSettings();
  change(settings);
  writeSettings(settings);
  return ogw(ws, ['game', 'check', 'mygame', '--build', ...extra]);
}

async function errors(change: (s: Settings) => void): Promise<string[]> {
  const run = await check(change);
  expect(run.code).toBe(1);
  return run.stdout.trim().split('\n');
}

const mobileScreen = { name: 'phone', window: [1080, 2400], fillMode: 'Crop', notch: [0, 100, 0, 50], keyboard: 900 };

describe('ogw game check', () => {
  it('passes valid settings', async () => {
    const run = await check();
    expect(run).toEqual({ code: 0, stdout: 'pass\n', stderr: '' });
    expect(vi.mocked(coreRelease).mock.calls[0]?.[1]).toBe('1.2.0');
  });

  it('with --build, needs the native plugins of STG and PROD builds of the build platforms in the core release', async () => {
    const dir = join(ws.root, 'release');
    writePlugins(dir, [{ name: 'ogw-secure-storage', platforms: ['linux'] }, { name: 'ogw-iap-apple', platforms: ['ios'] }]);
    expect(await errors((s) => {
      s.buildPlatforms = ['linux', 'macos'];
      s.signing = { macos: { certificate: 'c', certificatePassword: 'p', provisioningProfile: 'pp', notaryApiKey: 'n' } };
      s.macosNotary = { keyId: 'K', issuerId: 'I' };
      s.appleTeamId = 'ABCDE12345';
    })).toEqual([
      'native plugin: STG macos needs native plugin ogw-secure-storage: engine.json of core 1.2.0 has no ogw-secure-storage for macos',
      'native plugin: PROD macos needs native plugin ogw-secure-storage: engine.json of core 1.2.0 has no ogw-secure-storage for macos',
    ]);
    expect((await ogw(ws, ['game', 'check', 'mygame'])).code).toBe(0);
    // the provisioning profile part reads a secret value, which the build host checks: no signing secret is stored here
    writePlugins(dir, [{ name: 'ogw-secure-storage', platforms: ['linux', 'macos'] }]);
    expect((await ogw(ws, ['game', 'check', 'mygame', '--build'])).stdout).toBe('pass\n');
  });

  it('needs provisioningProfile in signing.macos, by the keys of the macos signing table', async () => {
    expect(await errors((s) => {
      s.signing = { macos: { certificate: 'c', certificatePassword: 'p', notaryApiKey: 'n' } };
      s.macosNotary = { keyId: 'K', issuerId: 'I' };
      s.appleTeamId = 'ABCDE12345';
    })).toEqual(['signing.macos: keys must be certificate, certificatePassword, notaryApiKey, provisioningProfile']);
  });

  it('gives the errors as JSON', async () => {
    const settings = validGameSettings();
    delete settings.appId;
    makeGame(ws, 'mygame', { 'settings.json': settings });
    const run = await ogw(ws, ['game', 'check', 'mygame', '--build', '--json']);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({ errors: ['appId: missing'] });
  });

  it('needs the build stage values only with --build', async () => {
    const settings = validGameSettings();
    delete settings.appId;
    (settings.environments.DEV as { deploy?: unknown }).deploy = undefined;
    settings.buildPlatforms = ['web'];
    settings.sourceLanguage = 'ja';
    makeGame(ws, 'mygame', { 'settings.json': settings });
    const setup = await ogw(ws, ['game', 'check', 'mygame']);
    expect(setup.code).toBe(1);
    // a build stage value that is there but wrong is still an error
    expect(setup.stdout).toBe('sourceLanguage: ja is not in supportedLanguages\nenvironments.PROD.corsAllowedOrigins: must have https://cdn.example.com\n');
    const build = await ogw(ws, ['game', 'check', 'mygame', '--build']);
    expect(build.stdout).toContain('appId: missing\n');
    expect(build.stdout).toContain('environments.DEV.deploy: missing\n');
    expect(build.stdout).toContain('environments.DEV.cdnR2: missing\n');
    const list = await ogw(ws, ['settings', 'list', 'game', 'mygame', '--missing']);
    expect(list.stdout).not.toContain('appId');
  });

  it('checks the game settings schema', async () => {
    expect(await errors((s) => (s.appId = 'Bad'))).toEqual(['appId: must match pattern "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)+$"']);
    expect(await errors((s) => (s.engine = 'unity'))).toEqual(['engine: must be equal to one of the allowed values ("godot")']);
    expect(await errors((s) => (s.extra = 1))).toEqual(['(root): must NOT have additional properties (extra)']);
  });

  it('checks that sourceLanguage is in supportedLanguages', async () => {
    expect(await errors((s) => (s.sourceLanguage = 'ja'))).toEqual(['sourceLanguage: ja is not in supportedLanguages']);
    expect(await errors((s) => (s.supportedLanguages = ['ko']))).toEqual(['sourceLanguage: en is not in supportedLanguages']);
  });

  it('checks signing keys against the engine signing table', async () => {
    const android = (keys: Record<string, string>) => (s: Settings) => {
      s.buildPlatforms = ['android'];
      s.androidKeyAlias = 'key';
      s.uiCheckScreens = [mobileScreen];
      s.signing = { android: keys };
    };
    expect((await check(android({ keystore: 'ks', password: 'pw' }))).code).toBe(0);
    expect(await errors(android({ keystore: 'ks' }))).toEqual(['signing.android: keys must be keystore, password']);
    expect(await errors(android({ keystore: 'ks', password: 'pw', extra: 'x' }))).toEqual(['signing.android: keys must be keystore, password']);
  });

  it('needs signing of android, windows and macos for the STG and PROD builds, and the platform value with signing', async () => {
    const desktop = await errors((s) => {
      s.buildPlatforms = ['android', 'windows', 'macos'];
      s.uiCheckScreens = [mobileScreen];
    });
    expect(desktop).toEqual(['signing.android: missing', 'signing.windows: missing', 'signing.macos: missing']);
    expect(await errors((s) => {
      s.buildPlatforms = ['linux'];
      s.signing = { android: { keystore: 'ks', password: 'pw' }, windows: { clientSecret: 'cs' }, macos: { certificate: 'c', certificatePassword: 'p', provisioningProfile: 'pp', notaryApiKey: 'n' } };
    })).toEqual(['androidKeyAlias: missing', 'trustedSigning: missing', 'macosNotary: missing', 'appleTeamId: missing']);
    // ios needs signing in every environment
    expect(await errors((s) => {
      s.buildPlatforms = ['ios'];
      s.appleTeamId = 'ABCDE12345';
      s.uiCheckScreens = [mobileScreen];
    })).toEqual(['signing.ios: missing']);
  });

  it('reads the windows key without the parenthesized code spans', async () => {
    const run = await check((s) => {
      s.buildPlatforms = ['windows'];
      const uuid = '01234567-89ab-cdef-0123-456789abcdef';
      s.trustedSigning = { endpoint: 'https://eus.codesigning.azure.net', account: 'a', certificateProfile: 'p', tenantId: uuid, clientId: uuid };
      s.signing = { windows: { clientSecret: 'cs' } };
    });
    expect(run.stdout).toBe('pass\n');
  });

  it('fails when the engine has no build document', async () => {
    const run = await check((s) => {
      s.signing = {};
      s.engine = 'godot';
    });
    expect(run.code).toBe(0);
    writeFileSync(join(ws.harness, 'skills', 'build', 'engines', 'godot.md'), '# godot\n');
    const settings = validGameSettings();
    settings.signing = {};
    writeFileSync(join(ws.games, 'mygame', 'settings.json'), JSON.stringify(settings));
    const broken = await ogw(ws, ['game', 'check', 'mygame']);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain('no signing table in');
  });

  it('checks that coreModules are modules of their side', async () => {
    expect(await errors((s) => (s.coreModules = { client: ['auth', 'NopeCore'], server: ['UICore'.toLowerCase(), 'item-ledger'] }))).toEqual([
      'coreModules.client.0: must match pattern "^[A-Z][A-Za-z]*Core$"',
      'coreModules.client: auth is not a client module of core 1.2.0',
      'coreModules.client: NopeCore is not a client module of core 1.2.0',
      'coreModules.server: uicore is not a server module of core 1.2.0',
    ]);
    expect(await errors((s) => (s.coreModules = { client: ['UICore', 'QACore'], server: ['cheat'] }))).toEqual([
      'coreModules.client: QACore is a module only DEV code depends on; runs with DEV code prepare it without coreModules',
      'coreModules.server: cheat is a module only DEV code depends on; runs with DEV code prepare it without coreModules',
    ]);
  });

  it('checks uiCheckScreens keyboards', async () => {
    expect(await errors((s) => (s.uiCheckScreens[0].keyboard = 720))).toEqual(['uiCheckScreens.0.keyboard: must be less than the window height 720']);
    expect((await check((s) => (s.uiCheckScreens[0].keyboard = 719))).code).toBe(0);
    const mobile = await errors((s) => {
      s.buildPlatforms = ['android'];
      s.androidKeyAlias = 'key';
      s.signing = { android: { keystore: 'ks', password: 'pw' } };
    });
    expect(mobile).toEqual(['uiCheckScreens: android or ios needs a screen with keyboard 1 or more']);
  });

  it('checks adminOperators', async () => {
    expect(
      await errors((s) => s.environments.DEV.adminOperators.push({ name: 'ogw', roles: ['read'], secret: 'x' })),
    ).toEqual(['environments.DEV.adminOperators: operator names repeat']);
    expect(await errors((s) => (s.environments.STG.adminOperators[0].name = 'ops'))).toEqual([
      'environments.STG.adminOperators: operator ogw is missing',
    ]);
    expect(await errors((s) => s.environments.DEV.adminOperators[0].roles.push('privacy'))).toEqual([
      'environments.DEV.adminOperators: operator ogw must not have role privacy',
    ]);
    expect(await errors((s) => (s.environments.PROD.adminOperators[0].roles = ['read', 'ops']))).toEqual([
      'environments.PROD.adminOperators: PROD operator ogw must have only role read',
    ]);
  });

  it('checks consent.ageBandBoundaries against the merged core settings', async () => {
    const band = 'consent.ageBandBoundaries';
    const ascending = `${band}: must be ascending integers from 1 to auth.maxAgeYears 120 without repeats`;
    expect(await errors((s) => (s.consent.ageBandBoundaries = [13, 16, 14]))).toEqual([ascending]);
    expect(await errors((s) => (s.consent.ageBandBoundaries = [13, 16, 121]))).toEqual([ascending]);
    expect(await errors((s) => (s.consent.ageBandBoundaries = [13, 13, 16]))).toEqual([`${band}: must NOT have duplicate items (items ## 1 and 0 are identical)`, ascending]);
    expect(await errors((s) => (s.consent.ageBandBoundaries = [16]))).toEqual([`${band}: must have 13`]);
    expect(await errors((s) => (s.consent.minimumAge = 15))).toEqual([`${band}: must have 15`]);
    expect(await errors((s) => (s.purchaseLimits = { monthlyBelowAge: { '17': 100 } }))).toEqual([`${band}: must have 17`]);
    expect(await errors((s) => (s.core = { 'auth.childAgeYears': 12 }))).toEqual([`${band}: must have 12`]);
    expect(await errors((s) => (s.core = { 'auth.maxAgeYears': 18 }))).toEqual([
      `${band}: must be ascending integers from 1 to auth.maxAgeYears 18 without repeats`,
    ]);
    expect((await check((s) => (s.consent.minimumAge = 14))).code).toBe(0);
  });

  it('fails when the core release has no auth.maxAgeYears', async () => {
    const dir = join(ws.root, 'release');
    const settings = { ...CORE_SETTINGS } as Record<string, unknown>;
    delete settings['auth.maxAgeYears'];
    writeFileSync(join(dir, 'core-settings.json'), JSON.stringify(settings));
    writeFileSync(join(dir, 'core-settings.schema.json'), JSON.stringify({ type: 'object' }));
    const run = await check();
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('core settings auth.maxAgeYears is not a number\n');
  });

  it('checks that the push night window is not empty', async () => {
    expect(await errors((s) => (s.pushConsent = { nightStartMinute: 480 }))).toEqual(['pushConsent: nightStartMinute and nightEndMinute must differ']);
    expect((await check((s) => (s.pushConsent = { nightStartMinute: 481 }))).code).toBe(0);
  });

  it('checks DEV and STG deploy on one host', async () => {
    const sameHost = (s: Settings) => (s.environments.STG.deploy.host = s.environments.DEV.deploy.host);
    expect(
      await errors((s) => {
        sameHost(s);
        s.environments.STG.deploy.dir = '/srv/dev';
      }),
    ).toEqual([
      'environments: DEV and STG deploy on the same host need different deploy.dir',
      'environments: DEV and STG deploy on the same host need different deploy.port',
    ]);
    expect(await errors((s) => sameHost(s))).toEqual(['environments: DEV and STG deploy on the same host need different deploy.port']);
    expect(
      await errors((s) => {
        sameHost(s);
        s.environments.STG.deploy.port = 8081;
        s.environments.STG.deploy.dir = '/srv/dev';
      }),
    ).toEqual(['environments: DEV and STG deploy on the same host need different deploy.dir']);
    expect(
      (
        await check((s) => {
          sameHost(s);
          s.environments.STG.deploy.port = 8081;
        })
      ).code,
    ).toBe(0);
  });

  it('checks login-apple next to login-google for ios', async () => {
    const ios = (s: Settings) => {
      s.buildPlatforms = ['ios'];
      s.environments.DEV.adapters['login-google'] = 'fake';
    };
    const list = await errors(ios);
    expect(list).toContain('environments.DEV.adapters.login-apple: missing');
    expect(list.filter((e) => e.includes('login-apple'))).toHaveLength(1);
    const withApple = await errors((s) => {
      ios(s);
      s.environments.DEV.adapters['login-apple'] = 'fake';
    });
    expect(withApple.filter((e) => e.includes('login-apple'))).toEqual([]);
  });

  it('checks web settings', async () => {
    const web = (s: Settings) => (s.buildPlatforms = ['web']);
    expect(await errors(web)).toEqual([
      'environments.DEV.adapters.cdn: missing',
      'environments.DEV.cdnR2: missing',
      'environments.DEV.devAllowedCidrs: missing',
      'environments.STG.adapters.cdn: missing',
      'environments.STG.cdnR2: missing',
      'environments.PROD.corsAllowedOrigins: must have https://cdn.example.com',
    ]);
    const full = (s: Settings) => {
      web(s);
      for (const env of ['DEV', 'STG', 'PROD'] as const) {
        s.environments[env].adapters.cdn = 'cdn-r2';
        s.environments[env].cdnR2 = { accountId: 'a', bucket: 'b', accessKeyId: 'k', publicBaseUrl: 'https://cdn.example.com/game' };
        s.environments[env].corsAllowedOrigins = ['https://cdn.example.com'];
        s.environments[env].secrets.cdn = `cdn-${env}`;
      }
      s.environments.DEV.devAllowedCidrs = ['10.0.0.0/8'];
    };
    expect((await check(full)).stdout).toBe('pass\n');
    expect(
      await errors((s) => {
        full(s);
        s.environments.STG.adapters.cdn = 'fake';
        delete s.environments.STG.cdnR2;
        delete s.environments.STG.secrets.cdn;
      }),
    ).toEqual(['environments.STG.adapters.cdn: must be cdn-r2 for web', 'environments.STG.cdnR2: missing']);
  });

  it('checks the desktop Google login secret', async () => {
    const desktop = (s: Settings) => {
      s.environments.DEV.adapters['login-google'] = 'login-google';
      s.loginGoogle = { serverClientId: 'server', desktopClientId: 'desktop' };
    };
    expect(await errors(desktop)).toEqual(['environments.DEV.secrets.loginGoogleDesktop: missing']);
    expect(
      (
        await check((s) => {
          desktop(s);
          s.environments.DEV.secrets.loginGoogleDesktop = 'lgd';
        })
      ).code,
    ).toBe(0);
  });

  it('checks game settings core against the core settings schema and constraints', async () => {
    expect(await errors((s) => (s.core = { 'NetworkCore.requestTimeoutMs': -1 }))).toEqual(['core.NetworkCore.requestTimeoutMs: must be >= 0']);
    expect(await errors((s) => (s.core = { 'Nope.key': 1 }))).toEqual(['core: must NOT have additional properties (Nope.key)']);
    expect(await errors((s) => (s.core = { 'NetworkCore.requestTimeoutMs': 15001 }))).toEqual([
      'core.NetworkCore.requestTimeoutMs × 2 must be at most core.InputBlockCore.maxDurationMs',
    ]);
    expect((await check((s) => (s.core = { 'NetworkCore.requestTimeoutMs': 15000 }))).code).toBe(0);
    expect(await errors((s) => (s.core = { 'InputBlockCore.maxDurationMs': true }))).toEqual([
      'core.InputBlockCore.maxDurationMs: must be integer',
      'core.NetworkCore.requestTimeoutMs × 2 must be at most core.InputBlockCore.maxDurationMs',
    ]);
  });

  it('checks the TURN adapter when realtime is relay only', async () => {
    const relay = (s: Settings) => (s.core = { 'BootstrapCore.realtimeRelayOnly': true });
    expect(await errors(relay)).toEqual([
      'environments.DEV.adapters.turn: missing',
      'environments.STG.adapters.turn: missing',
      'environments.PROD.adapters.turn: missing',
    ]);
    // the setup stage leaves the build stage environments to the build check
    expect((await ogw(ws, ['game', 'check', 'mygame'])).stdout).toBe('pass\n');
    const withTurn = await check((s) => {
      relay(s);
      for (const env of ['DEV', 'STG', 'PROD'] as const) s.environments[env].adapters.turn = 'fake';
    });
    expect(withTurn.stdout).toBe('pass\n');
  });
});

describe('ogw game check --defaults', () => {
  it('lists schema defaults and core settings defaults the game does not write', async () => {
    const run = await check((s) => (s.core = { 'UICore.theme': { color: 'red' }, 'auth.maxAgeYears': 100 }), ['--defaults']);
    expect(run.code).toBe(0);
    const lines = run.stdout.trim().split('\n');
    expect(lines).toContain('sourceLanguage = "en" (schema default)');
    expect(lines).toContain('loopIterationLimit = 20 (schema default)');
    expect(lines).toContain('environments.DEV.containerLog.maxBytes = 104857600 (schema default)');
    expect(lines).toContain('uiCheckScreens.0.keyboard = 0 (schema default)');
    expect(lines).toContain('consent.ageBandBoundaries = [13,14,16,18,19] (schema default)');
    expect(lines).toContain('core.NetworkCore.requestTimeoutMs = 10000 (core settings)');
    expect(lines).toContain('core.UICore.theme.size = 2 (core settings)');
    expect(lines.some((l) => l.startsWith('core.UICore.theme.color'))).toBe(false);
    expect(lines.some((l) => l.startsWith('core.auth.maxAgeYears'))).toBe(false);
    expect(lines.some((l) => l.startsWith('appId'))).toBe(false);
  });

  it('gives the list as JSON', async () => {
    makeGame(ws, 'mygame', { 'settings.json': validGameSettings() });
    const run = await ogw(ws, ['game', 'check', 'mygame', '--defaults', '--json']);
    const data = JSON.parse(run.stdout) as { defaults: { path: string; value: unknown; source: string }[] };
    expect(data.defaults).toContainEqual({ path: 'gamepadSupported', value: false, source: 'schema default' });
    expect(data.defaults).toContainEqual({ path: 'core.BootstrapCore.realtimeRelayOnly', value: false, source: 'core settings' });
  });

  it('fails without coreVersion', async () => {
    const run = await check((s) => delete s.coreVersion, ['--defaults']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('game settings have no coreVersion\n');
  });
});

function bulletOf(start: string): string {
  const markdown = readFileSync(join(ws.harness, 'skills', 'build', 'SKILL.md'), 'utf8');
  const lines = markdown.split('\n');
  const i = lines.findIndex((l) => l.startsWith(`- ${start}`));
  const out = [lines[i] as string];
  for (const line of lines.slice(i + 1)) {
    if (!line.startsWith('  ')) break;
    out.push(line);
  }
  return out.join('\n');
}

describe('ogw game check --human-prep', () => {
  it('gives the deploy bullets that apply to each environment', async () => {
    const run = await check(() => undefined, ['--human-prep']);
    expect(run.code).toBe(0);
    const deploy = bulletOf(HUMAN_PREP[0]?.start ?? '');
    const cdn = bulletOf(HUMAN_PREP[2]?.start ?? '');
    expect(run.stdout).toBe(`## DEV\n${deploy}\n\n## STG\n${deploy}\n\n## PROD\n${cdn}\n`);
    // ogw deploy writes the secret files: the person prepares the SSH key, not the files
    expect(deploy).not.toContain('secrets/<secret name>');
    expect(deploy).toContain('`authorized_keys`');
  });

  it('applies every adapter condition', async () => {
    const run = await check((s) => {
      s.environments.DEV.adapters = {
        turn: 'turn-coturn',
        ads: 'ads-admob',
        'login-google': 'login-google',
        analytics: 'analytics-ga4',
        'iap-apple': 'iap-apple-sandbox',
      };
      s.environments.STG.adapters = { 'iap-apple': 'iap-apple', 'iap-google': 'fake' };
      s.environments.PROD.adapters = { 'iap-google': 'iap-google', 'iap-apple': 'fake', turn: 'fake', ads: 'fake' };
    }, ['--human-prep', '--json']);
    const data = JSON.parse(run.stdout) as { humanPrep: Record<string, string[]> };
    const entry = (b: string) => HUMAN_PREP.findIndex((h) => bulletStartsWith(b, h.start));
    const bullets = (env: string) => data.humanPrep[env]?.map(entry);
    expect(bullets('DEV')).toEqual([0, 1, 3, 4, 5, 6, 8]);
    expect(bullets('STG')).toEqual([0, 6, 8]);
    expect(bullets('PROD')).toEqual([7, 8]);
    const iapGoogle = data.humanPrep.PROD?.[0] ?? '';
    expect(iapGoogle).toBe(bulletOf(HUMAN_PREP[7]?.start ?? ''));
    expect(iapGoogle.split('\n')).toHaveLength(4);
  });

  it('prints both lists with --defaults', async () => {
    const run = await check(() => undefined, ['--defaults', '--human-prep']);
    expect(run.stdout).toMatch(/\(core settings\)\n\n## DEV\n- The `host`/);
  });

  it('prints nothing when a start text does not find exactly one bullet', async () => {
    const path = join(ws.harness, 'skills', 'build', 'SKILL.md');
    const markdown = readFileSync(path, 'utf8');
    const cdn = bulletOf(HUMAN_PREP[2]?.start ?? '');
    writeFileSync(path, markdown.replace(cdn, `${cdn}\n${cdn}`));
    const run = await check(() => undefined, ['--human-prep']);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe(`build skill ## deploy has 2 bullets that start with: ${HUMAN_PREP[2]?.start ?? ''}\n`);
  });

  it('finds each English start text', () => {
    const markdown = ['## deploy', ...HUMAN_PREP.map((h, i) => `- ${h.start} ${String(i)}`), ''].join('\n');
    const found = bulletsByStart(deployBullets(markdown));
    expect([...found.values()]).toEqual(HUMAN_PREP.map((h, i) => `- ${h.start} ${String(i)}`));
  });

  it('finds each start text exactly once in the real build skill', () => {
    const markdown = readFileSync(join(ws.harness, 'skills', 'build', 'SKILL.md'), 'utf8');
    expect(bulletsByStart(deployBullets(markdown)).size).toBe(HUMAN_PREP.length);
  });

  it('fails without a deploy section', () => {
    expect(() => deployBullets('# build\n- a\n')).toThrow('build skill has no ## deploy section');
    expect(deployBullets('## deploy\n- a\n  - b\n\n- c\nplain\n  - d\n## next\n- e\n')).toEqual(['- a\n  - b', '- c']);
  });
});
