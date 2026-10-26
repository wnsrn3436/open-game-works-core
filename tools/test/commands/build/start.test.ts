import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminCall } from '../../../src/commands/admin/api.ts';
import { coreRelease, coreReleaseOfGame, extractedAsset } from '../../../src/commands/core/api.ts';
import { requireEngine, toolProgram } from '../../../src/commands/env/api.ts';
import { gameModules } from '../../../src/commands/generate/api.ts';
import { runData } from '../../../src/commands/data/api.ts';
import { planDevStg } from '../../../src/commands/build/lib/plan.ts';
import type { GameRepo } from '../../../src/lib/game.ts';
import { OgwError } from '../../../src/lib/errors.ts';
import { ogw, makeWorkspace, testSettings, type TestWorkspace, sh } from '../../helpers/workspace.ts';
import { addSecrets, commit, fakeBin, git, openBuildRun, runsOf, setSecrets, setupGame, write } from './helpers.ts';

vi.mock('../../../src/commands/core/api.ts', async (orig) => ({ ...(await orig<object>()), coreRelease: vi.fn(), coreReleaseOfGame: vi.fn(), extractedAsset: vi.fn() }));
vi.mock('../../../src/commands/env/api.ts', async (orig) => ({ ...(await orig<object>()), requireEngine: vi.fn(), toolProgram: vi.fn() }));
vi.mock('../../../src/commands/generate/api.ts', async (orig) => ({ ...(await orig<object>()), gameModules: vi.fn() }));
vi.mock('../../../src/commands/data/api.ts', async (orig) => ({ ...(await orig<object>()), runData: vi.fn() }));
vi.mock('../../../src/commands/admin/api.ts', async (orig) => ({ ...(await orig<object>()), adminCall: vi.fn() }));
vi.mock('../../../src/commands/build/lib/plan.ts', async (orig) => {
  const original = await orig<typeof import('../../../src/commands/build/lib/plan.ts')>();
  return { ...original, planDevStg: vi.fn(original.planDevStg) };
});

const DOCKER = `case "$1 $2" in
  "image inspect") [ -n "$FAKE_NO_IMAGE" ] && exit 1; exit 0;;
  "buildx version") [ -n "$FAKE_NO_BUILDX" ] && exit 1; exit 0;;
  "login ghcr.io") cat > /dev/null; exit 0;;
  "buildx imagetools") [ -n "$FAKE_NO_REMOTE" ] && exit 1; echo '{"digest":"sha256:remote"}';;
esac`;
const GH = `case "$1 $2" in
  "auth status") echo "Token scopes: 'repo', $FAKE_SCOPE";;
  "auth token") echo tok;;
  "api user") echo me;;
esac`;

let coreDir = '';

function prepare(ws: TestWorkspace, coreSpec: object[] = [], coreSettings: object = {}): NodeJS.ProcessEnv {
  coreDir = join(ws.root, 'release');
  mkdirSync(coreDir, { recursive: true });
  writeFileSync(join(coreDir, 'core-spec.json'), JSON.stringify({ version: '1.0.0', modules: coreSpec }));
  writeFileSync(join(coreDir, 'engine.json'), JSON.stringify({ godot: '4.5.1.stable', buildTools: [] }));
  writeFileSync(join(coreDir, 'core-settings.json'), JSON.stringify(coreSettings));
  writeFileSync(join(coreDir, 'core-settings.schema.json'), JSON.stringify({ type: 'object' }));
  writeFileSync(join(coreDir, 'core-settings-constraints.json'), '[]');
  // every secret ogw deploy writes for DEV and STG (`build` `## deploy` secret file rule)
  const deployed = (env: string, names: string[]): Record<string, string> => Object.fromEntries(names.map((name) => [`ogw/g/${env}/${name}`, 's']));
  setSecrets(ws, {
    ...deployed('DEV', ['db', 'atk', 'usk', 'deploySsh', 'dbPassword', 'devAccess', 'adminOgw']),
    ...deployed('STG', ['db', 'atk', 'usk', 'deploySsh', 'dbPassword', 'adminOgw']),
    'ogw/g/PROD/adminOgw': 's',
    // the loop steps of the build run play and judge agents with Claude Code
    'ogw/harness/claude-code-oauth-token': 'token',
  });
  return { ...fakeBin(ws, { docker: DOCKER, gh: GH }).env, FAKE_SCOPE: "'write:packages'" };
}

beforeEach(() => {
  vi.mocked(coreReleaseOfGame).mockImplementation(() => Promise.resolve({ version: '1.0.0', dir: coreDir, local: false }));
  vi.mocked(coreRelease).mockImplementation(() => Promise.resolve({ version: '1.0.0', dir: coreDir, local: false }));
  vi.mocked(extractedAsset).mockImplementation(() => Promise.resolve(coreDir));
  vi.mocked(requireEngine).mockResolvedValue('/bin/godot');
  vi.mocked(toolProgram).mockResolvedValue('/bin/chromium');
  vi.mocked(gameModules).mockResolvedValue({ client: [], server: [] });
  vi.mocked(adminCall).mockResolvedValue({ user_ids: [] });
});

describe('build start preconditions', () => {
  it('refuses with useLocalCore, an open run, or changes', async () => {
    const local = makeWorkspace({ useLocalCore: true });
    setupGame(local);
    expect((await ogw(local, ['build', 'start', 'g', 'DEV'])).stderr).toContain('useLocalCore is true');

    const ws = makeWorkspace();
    const env = prepare(ws);
    const dir = setupGame(ws);
    write(dir, 'dirty.txt', 'x');
    const dirty = await ogw(ws, ['build', 'start', 'g', 'DEV'], { env });
    expect(dirty.code).toBe(1);
    expect(dirty.stderr).toContain('the checkout has changes:\n?? dirty.txt');
    commit(dir);
    await openBuildRun(ws, dir, { kind: 'loop', name: 'loop-1', env: null, version: null });
    expect((await ogw(ws, ['build', 'start', 'g', 'DEV'], { env })).stderr).toContain('open run: loop-1');
  });

  it('refuses a game whose core is not the core of the harness, before anything is made', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const dir = setupGame(ws);
    sh(ws.harness, 'git', ['tag', 'core-v1.1.0']);
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV'], { env });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('g uses core 1.0.0, and the specs of this harness are of core 1.1.0');
    expect(await runsOf(ws)).toEqual([]);
    expect(git(dir, 'branch', '--list', 'build/*')).toBe('');
  });

  it('refuses while a gameplay video of the reference is missing, before anything is made', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const dir = setupGame(ws);
    git(dir, 'rm', '-q', 'records/setup/reference/hollow.mp4');
    commit(dir);
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV'], { env });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('lacks the gameplay videos that records/setup/reference/reference.md `## video` names: hollow.mp4');
    expect(await runsOf(ws)).toEqual([]);
    expect(git(dir, 'branch', '--list', 'build/*')).toBe('');
  });

  it('reports every host problem and makes nothing', async () => {
    const ws = makeWorkspace();
    const env = { ...prepare(ws), FAKE_NO_IMAGE: '1', FAKE_NO_BUILDX: '1', FAKE_SCOPE: '' };
    setSecrets(ws, {});
    const settings = await import('./helpers.ts').then((h) => h.gameSettings());
    const environments = settings.environments as Record<string, Record<string, unknown>>;
    Object.assign(environments.DEV as Record<string, unknown>, {
      adapters: { cdn: 'cdn-r2' },
      cdnR2: { accountId: 'acct', bucket: 'game', accessKeyId: 'key', publicBaseUrl: 'https://cdn.example.com' },
      corsAllowedOrigins: ['https://cdn.example.com'],
      devAllowedCidrs: [],
      secrets: { ...((environments.DEV as Record<string, unknown>).secrets as object), cdn: 'cdn' },
    });
    const signing = { android: { keystore: 'keystore', keystorePassword: 'keystorePassword' } };
    const dir = setupGame(ws, 'g', { buildPlatforms: ['web', 'android'], postgresqlMajor: 17, environments, signing, androidKeyAlias: 'key' });
    vi.mocked(requireEngine).mockRejectedValue(new OgwError('godot 4.5.1.stable is not installed: run ogw env install-engines'));
    vi.mocked(toolProgram).mockResolvedValue(null);
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV'], { env });
    expect(out.code).toBe(1);
    for (const line of [
      'signing secret keystore (android keystore) is not in the secret store',
      'godot 4.5.1.stable is not installed: run ogw env install-engines',
      'harness settings tools.chromium is not on this host',
      'harness settings tools.postgresql tag major 18 differs from game settings postgresqlMajor 17',
      'docker buildx is not on this host',
      'the GitHub CLI login has no write:packages scope',
      'secret deploySsh of DEV is not in the secret store',
      'secret ogw/g/DEV/adminOgw is not in the secret store',
      'secret cdn of DEV is not in the secret store',
      "harness settings agents play and judge use Claude Code and harness secret claude-code-oauth-token is not in this host's secret store: make a long-lived token with `claude setup-token` and store it on one line",
    ]) expect(out.stderr).toContain(line);
    expect(out.stderr).toMatch(/^docker image postgres:[^@\s]+@sha256:[0-9a-f]+ is not on this host$/m);
    expect(git(dir, 'branch', '--list')).toBe('* main');
    expect(await runsOf(ws)).toEqual([]);
  });

  it('needs the agent login token only while play or judge uses Claude Code', async () => {
    const ws = makeWorkspace({
      agents: { ...(testSettings().agents as Record<string, object>), play: { cli: 'codex', model: 'm', effort: 'high' }, judge: { cli: 'codex', model: 'm', effort: 'high' } },
    });
    const env = prepare(ws);
    setSecrets(ws, {});
    setupGame(ws);
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV'], { env });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('secret deploySsh of DEV is not in the secret store');
    expect(out.stderr).not.toContain('claude-code-oauth-token');
  });

  it('needs every secret ogw deploy writes: each environment secret and the secret of every operator', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    setSecrets(ws, { 'ogw/g/DEV/deploySsh': 'k', 'ogw/g/DEV/adminOgw': 's' });
    const settings = await import('./helpers.ts').then((h) => h.gameSettings());
    const environments = settings.environments as Record<string, Record<string, unknown>>;
    const dev = environments.DEV as Record<string, unknown>;
    dev.adminOperators = [...(dev.adminOperators as object[]), { name: 'ops', roles: ['read'], secret: 'adminOps' }];
    const dir = setupGame(ws, 'g', { environments });
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV'], { env });
    expect(out.code).toBe(1);
    for (const key of ['db', 'accessTokenKey', 'updateSigningKey', 'dbPassword', 'devAccess']) expect(out.stderr).toContain(`secret ${key} of DEV is not in the secret store`);
    expect(out.stderr).toContain('secret of operator ops of DEV is not in the secret store');
    expect(out.stderr).not.toContain('secret deploySsh of DEV');
    expect(out.stderr).not.toContain('adminOgw');
    expect(git(dir, 'branch', '--list')).toBe('* main');
    expect(await runsOf(ws)).toEqual([]);
  });

  it('treats an empty operator ogw secret as missing, as ogw admin does', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    setSecrets(ws, { 'ogw/g/DEV/deploySsh': 'k', 'ogw/g/DEV/adminOgw': '' });
    setupGame(ws);
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV'], { env });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('secret ogw/g/DEV/adminOgw is not in the secret store');
    expect(await runsOf(ws)).toEqual([]);
  });

  it('runs the human checks on main and makes nothing when one fails', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const settings = await import('./helpers.ts').then((h) => h.gameSettings());
    const environments = settings.environments as Record<string, Record<string, unknown>>;
    (environments.DEV as Record<string, unknown>).adapters = { 'push-apns': 'push-apns' };
    (environments.DEV as Record<string, unknown>).secrets = { ...((environments.DEV as Record<string, unknown>).secrets as object), pushApns: 'pushApns' };
    const dir = setupGame(ws, 'g', { environments, pushApns: { keyId: 'KEY' }, appleTeamId: 'ABCDE12345' });
    addSecrets(ws, { 'ogw/g/DEV/pushApns': 's' });
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV', '--json'], { env });
    expect(out.code).toBe(1);
    expect(JSON.parse(out.stdout)).toEqual({
      error: 'human check adapter: environments.DEV.adapters.push-apns',
      data: { human: [{ check: 'adapter', targets: ['environments.DEV.adapters.push-apns'] }] },
    });
    expect(git(dir, 'branch', '--list')).toBe('* main');
  });
  it('refuses on a missing build stage value of the environment or outside any environment, before the host checks', async () => {
    const ws = makeWorkspace();
    const env = { ...prepare(ws), FAKE_NO_BUILDX: '1' };
    const settings = await import('./helpers.ts').then((h) => h.gameSettings());
    const environments = settings.environments as Record<string, Record<string, unknown>>;
    (environments.DEV as Record<string, unknown>).adapters = { cdn: 'cdn-r2' };
    const dir = setupGame(ws, 'g', { environments, appId: undefined });
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV', '--json'], { env });
    expect(out.code).toBe(1);
    const result = JSON.parse(out.stdout) as { error: string; data: { missing: string[] } };
    expect(result.data.missing).toEqual(['appId: missing', 'environments.DEV.cdnR2: missing', 'environments.DEV.secrets.cdn: missing']);
    expect(result.error).not.toContain('docker buildx');
    expect(git(dir, 'branch', '--list')).toBe('* main');
    expect(await runsOf(ws)).toEqual([]);
  });

  it('builds DEV android, windows and macos without signing, and needs it for ios, STG, and a DEV macos with login-apple', async () => {
    const ws = makeWorkspace();
    const env = { ...prepare(ws), OGW_HOST_PLATFORM: 'macos-arm64' };
    setupGame(ws, 'g', { buildPlatforms: ['android', 'windows', 'macos'] });
    const dev = await ogw(ws, ['build', 'start', 'g', 'DEV', '--json'], { env });
    expect(dev.code).toBe(0);
    expect(dev.stdout).not.toContain('signing');
    expect(dev.stderr).not.toContain('signing');
    const stgWs = makeWorkspace();
    const stgEnv = { ...prepare(stgWs), OGW_HOST_PLATFORM: 'macos-arm64' };
    setupGame(stgWs, 'g', { buildPlatforms: ['android', 'windows', 'macos'] });
    const stg = await ogw(stgWs, ['build', 'start', 'g', 'STG', '--json'], { env: stgEnv });
    expect((JSON.parse(stg.stdout) as { data: { missing: string[] } }).data.missing).toEqual(['signing.android: missing', 'signing.windows: missing', 'signing.macos: missing']);

    const ios = makeWorkspace();
    const iosEnv = { ...prepare(ios), OGW_HOST_PLATFORM: 'macos-arm64' };
    setupGame(ios, 'g', { buildPlatforms: ['ios'] });
    const iosOut = await ogw(ios, ['build', 'start', 'g', 'DEV', '--json'], { env: iosEnv });
    expect((JSON.parse(iosOut.stdout) as { data: { missing: string[] } }).data.missing).toEqual(['appleTeamId: missing', 'signing.ios: missing']);

    const apple = makeWorkspace();
    const appleEnv = { ...prepare(apple), OGW_HOST_PLATFORM: 'macos-arm64' };
    const settings = await import('./helpers.ts').then((h) => h.gameSettings());
    const environments = settings.environments as Record<string, Record<string, unknown>>;
    (environments.DEV as Record<string, unknown>).adapters = { 'login-apple': 'login-apple' };
    setupGame(apple, 'g', { buildPlatforms: ['macos'], environments });
    const appleOut = await ogw(apple, ['build', 'start', 'g', 'DEV', '--json'], { env: appleEnv });
    expect((JSON.parse(appleOut.stdout) as { data: { missing: string[] } }).data.missing).toContain('signing.macos: missing');
  });

  it('needs adapters.turn of the environment for a relay-only realtime game, and the PROD values at a STG build', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws, [], { 'BootstrapCore.realtimeRelayOnly': true });
    setupGame(ws);
    const dev = await ogw(ws, ['build', 'start', 'g', 'DEV', '--json'], { env });
    expect((JSON.parse(dev.stdout) as { data: { missing: string[] } }).data.missing).toEqual(['environments.DEV.adapters.turn: missing']);
    const stg = await ogw(ws, ['build', 'start', 'g', 'STG', '--json'], { env });
    expect((JSON.parse(stg.stdout) as { data: { missing: string[] } }).data.missing).toEqual(['environments.STG.adapters.turn: missing', 'environments.PROD.adapters.turn: missing']);
    expect(await runsOf(ws)).toEqual([]);
  });

  it('needs the PROD updatePublicKeys at a STG build', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const settings = await import('./helpers.ts').then((h) => h.gameSettings());
    const environments = settings.environments as Record<string, Record<string, unknown>>;
    (environments.PROD as Record<string, unknown>).updatePublicKeys = [];
    setupGame(ws, 'g', { environments });
    const out = await ogw(ws, ['build', 'start', 'g', 'STG'], { env });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('game settings environments.PROD.updatePublicKeys is missing');
    expect(await runsOf(ws)).toEqual([]);
  });

  it('ignores a missing build stage value of another environment', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const settings = await import('./helpers.ts').then((h) => h.gameSettings());
    const environments = settings.environments as Record<string, Record<string, unknown>>;
    delete (environments.PROD as Record<string, unknown>).cdnR2;
    setupGame(ws, 'g', { environments });
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV'], { env });
    expect(out.stderr).toBe('');
    expect(out.stdout).toContain('run build-dev-0.1.0\n');
  });
});

describe('build start DEV and STG', () => {
  it('starts 0.1.0 from main HEAD and opens the run', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const dir = setupGame(ws);
    const head = git(dir, 'rev-parse', 'HEAD');
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV', '--json'], { env });
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ run: 'build-dev-0.1.0', version: '0.1.0', branch: 'build/dev-0.1.0', commit: head, platforms: ['linux'] });
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('build/dev-0.1.0');
    expect(existsSync(join(dir, 'records/loops/build-dev-0.1.0'))).toBe(true);
    const [run] = await runsOf(ws);
    expect(run).toMatchObject({
      name: 'build-dev-0.1.0', kind: 'build', branch: 'build/dev-0.1.0', baseCommit: head, referenceCommit: head, env: 'DEV', version: '0.1.0',
      platforms: ['linux'], bundleFor: null, closedAt: null, data: { build: { retries: 0, bundle: null, startCommit: head } },
    });
    expect((await ogw(ws, ['loop', 'next', 'g'], { env })).stdout).toBe('iteration 1\n');
    expect((await runsOf(ws))[0]).toMatchObject({ iteration: 1, referenceCommit: head });
  });

  it('registers the run only while main is still the planned start commit', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const dir = setupGame(ws);
    const original = await vi.importActual<typeof import('../../../src/commands/build/lib/plan.ts')>('../../../src/commands/build/lib/plan.ts');
    vi.mocked(planDevStg).mockImplementationOnce(async (input) => {
      const plan = await original.planDevStg(input);
      // A command that commits to main once the plan is made, as `ogw core proposal released` does.
      write(dir, 'records/core-proposals/1-a.md', 'status: released\nversion: 1.2.0\n');
      commit(dir, 'proposal released');
      return plan;
    });
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV'], { env });
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/main moved from [0-9a-f]{40} to [0-9a-f]{40} while the build started: run build start again/);
    expect(git(dir, 'branch', '--list')).toBe('* main');
    expect(await runsOf(ws)).toEqual([]);
  });

  it('raises the patch of the highest tag, checks --version, renames a failed branch and folder', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const dir = setupGame(ws);
    git(dir, 'tag', 'stg-1.2.3');
    git(dir, 'tag', 'dev-1.0.9');
    git(dir, 'tag', 'stg-1.2.3-bundle-4');
    git(dir, 'branch', 'build/stg-1.2.4');
    write(dir, 'builds/stg-1.2.4/old.txt', 'old');
    const low = await ogw(ws, ['build', 'start', 'g', 'STG', 'linux', '--version', '1.2.3'], { env });
    expect(low.stderr).toContain('--version 1.2.3 is not higher than the highest tag version 1.2.3');
    expect((await ogw(ws, ['build', 'start', 'g', 'STG', '--version', 'x'], { env })).stderr).toContain('invalid --version: x');
    expect((await ogw(ws, ['build', 'start', 'g', 'STG', 'switch'], { env })).stderr).toContain('invalid platform: switch');
    const out = await ogw(ws, ['build', 'start', 'g', 'STG'], { env });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('run build-stg-1.2.4\nversion 1.2.4\nbranch build/stg-1.2.4\n');
    expect(git(dir, 'branch', '--list', 'build/stg-1.2.4-failed-*')).toMatch(/build\/stg-1\.2\.4-failed-\d+/);
    expect(existsSync(join(dir, 'builds/stg-1.2.4'))).toBe(false);
    const failed = readdirSync(join(dir, 'builds')).filter((name) => /^stg-1\.2\.4-failed-\d+$/.test(name));
    expect(failed).toHaveLength(1);
    expect(readFileSync(join(dir, 'builds', failed[0] as string, 'old.txt'), 'utf8')).toBe('old');
  });

  it('takes --version above the highest tag', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    setupGame(ws);
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV', '--version', '2.0.0'], { env });
    expect(out.stdout).toContain('version 2.0.0');
  });

  it('numbers bundle patches and needs the app version tag', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const dir = setupGame(ws);
    expect((await ogw(ws, ['build', 'start', 'g', 'DEV', '--bundle-for', '1.0.0', '--version', '1.0.1'], { env })).stderr).toContain('--bundle-for takes no --version');
    expect((await ogw(ws, ['build', 'start', 'g', 'DEV', '--bundle-for', '1.0.0'], { env })).stderr).toContain('tag dev-1.0.0 of the app version does not exist');
    git(dir, 'tag', 'dev-1.0.0');
    git(dir, 'tag', 'dev-1.0.0-bundle-1');
    git(dir, 'tag', 'stg-1.0.0-bundle-5');
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV', '--bundle-for', '1.0.0'], { env });
    expect(out.stdout).toContain('version 1.0.0-bundle-2\nbranch build/dev-1.0.0-bundle-2');
    expect((await runsOf(ws))[0]).toMatchObject({ bundleFor: '1.0.0', data: { build: { bundle: 2 } } });
  });
});

describe('build start PROD', () => {
  function prodGame(ws: TestWorkspace, base = 'none'): { dir: string; stg: string } {
    const dir = setupGame(ws);
    write(dir, 'records/loops/build-stg-1.1.0/end.md', `## result\n\ndone\n\n## compatibility base\n\n${base}\n`);
    const stg = commit(dir, 'stg build');
    git(dir, 'tag', 'stg-1.1.0');
    write(dir, 'later.txt', 'x');
    commit(dir, 'later');
    return { dir, stg };
  }

  it('starts from the most recent stg tag commit and checks the STG server image', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const { dir, stg } = prodGame(ws);
    const bin = fakeBin(ws, {});
    const out = await ogw(ws, ['build', 'start', 'g', 'PROD'], { env });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('run build-prod-1.1.0\nversion 1.1.0\nbranch build/prod-1.1.0');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(stg);
    expect((await runsOf(ws))[0]).toMatchObject({ baseCommit: stg, referenceCommit: stg });
    const calls = readFileSync(bin.log, 'utf8');
    expect(calls).toContain('docker login ghcr.io --username me --password-stdin');
    expect(calls).toContain('docker buildx imagetools inspect ghcr.io/example/game-server:stg-1.1.0 --format {{json .Manifest}}');
    expect(calls).not.toContain('docker buildx version');
  });

  it('checks the core of the stg tag commit, not of main, against the core of the harness', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const dir = setupGame(ws);
    write(dir, 'records/loops/build-stg-1.1.0/end.md', '## result\n\ndone\n\n## compatibility base\n\nnone\n');
    commit(dir, 'stg build');
    git(dir, 'tag', 'stg-1.1.0');
    // main moved on to a newer core after the STG build
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<string, unknown>;
    write(dir, 'settings.json', `${JSON.stringify({ ...settings, coreVersion: '1.2.0' }, null, 2)}\n`);
    commit(dir, 'core upgrade');
    fakeBin(ws, {});
    sh(ws.harness, 'git', ['tag', 'core-v1.0.0']);
    vi.mocked(coreRelease).mockClear();
    vi.mocked(coreReleaseOfGame).mockClear();
    const out = await ogw(ws, ['build', 'start', 'g', 'PROD'], { env });
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    // the host check reads engine.json of the core of the stg tag commit, not of the checkout
    expect(vi.mocked(coreRelease).mock.calls.map((c) => c[1])).toContain('1.0.0');
    expect(vi.mocked(coreRelease).mock.calls.map((c) => c[1])).not.toContain('1.2.0');
    expect(coreReleaseOfGame).not.toHaveBeenCalled();
  });

  it('stops without the STG image, with a stale compatibility base, or an existing PROD tag', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const { dir } = prodGame(ws, 'prod-0.9.0');
    const stale = await ogw(ws, ['build', 'start', 'g', 'PROD'], { env });
    expect(stale.stderr).toContain('compatibility base prod-0.9.0 is not the last PROD build none: a new STG build is needed');
    git(dir, 'tag', 'prod-0.9.0', 'main~2');
    expect((await ogw(ws, ['build', 'start', 'g', 'PROD'], { env: { ...env, FAKE_NO_REMOTE: '1' } })).stderr).toContain(
      'server image ghcr.io/example/game-server:stg-1.1.0 is not in the registry',
    );
    git(dir, 'tag', 'prod-1.1.0', 'main~1');
    expect((await ogw(ws, ['build', 'start', 'g', 'PROD'], { env })).stderr).toContain('tag prod-1.1.0 already exists');
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  });

  it('needs a stg tag on main, a missing end.md, and a version above the last PROD build', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const dir = setupGame(ws);
    expect((await ogw(ws, ['build', 'start', 'g', 'PROD'], { env })).stderr).toContain('no main commit has the stg tag');
    git(dir, 'tag', 'stg-1.0.0');
    expect((await ogw(ws, ['build', 'start', 'g', 'PROD', '--version', '1.0.0'], { env })).stderr).toContain(
      'records/loops/build-stg-1.0.0/end.md is not on main: a new STG build is needed',
    );
    git(dir, 'tag', 'prod-2.0.0');
    expect((await ogw(ws, ['build', 'start', 'g', 'PROD', '--version', '1.0.0'], { env })).stderr).toContain(
      'version 1.0.0 is not higher than the last PROD build 2.0.0',
    );
  });

  it('checks the PROD admin API when the contract version rose', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const dir = setupGame(ws, 'g', {}, { 'server/generated/contract/contract.ts': 'export const CONTRACT_VERSION = 1;\n' });
    git(dir, 'tag', 'prod-1.0.0');
    write(dir, 'server/generated/contract/contract.ts', 'export const CONTRACT_VERSION = 2;\n');
    write(dir, 'records/loops/build-stg-1.1.0/end.md', '## compatibility base\n\nprod-1.0.0\n');
    commit(dir, 'v2');
    git(dir, 'tag', 'stg-1.1.0');
    vi.mocked(adminCall).mockRejectedValueOnce(new OgwError('401 unauthorized'));
    const out = await ogw(ws, ['build', 'start', 'g', 'PROD'], { env });
    expect(out.stderr).toContain('PROD admin operation sample_user_ids failed: 401 unauthorized');
    expect(vi.mocked(adminCall).mock.calls[0]?.slice(1)).toEqual(['g', { env: 'PROD' }, 'sample_user_ids', { count: 1 }]);
    expect((await ogw(ws, ['build', 'start', 'g', 'PROD'], { env })).code).toBe(0);
  });
});

describe('build start tools and PROD bundle patches', () => {
  it('checks the build tools of the chosen platforms on this host', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    writeFileSync(join(coreDir, 'engine.json'), JSON.stringify({
      godot: '4.5.1.stable',
      buildTools: [
        { platform: 'linux', hosts: ['macos-arm64', 'linux-x64', 'windows-x64'], name: 'tool-a', version: '2.1', versionCommand: 'echo 2.1.0' },
        { platform: 'linux', hosts: ['macos-arm64', 'linux-x64', 'windows-x64'], name: 'tool-b', version: '3.0', versionCommand: 'echo 2.9' },
        { platform: 'android', hosts: ['macos-arm64', 'linux-x64', 'windows-x64'], name: 'tool-c', version: '1', versionCommand: 'false' },
      ],
    }));
    setupGame(ws);
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV'], { env });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('build tool tool-b 3.0 for linux is not on this host');
    expect(out.stderr).not.toContain('tool-a');
    expect(out.stderr).not.toContain('tool-c');
  });

  it('starts a PROD bundle patch from the stg bundle tag and skips the image check without data', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const dir = setupGame(ws, 'g', {}, { 'data/v.txt': 'p1-d1' });
    git(dir, 'tag', 'prod-1.0.0');
    write(dir, 'records/loops/build-stg-1.0.0-bundle-2/end.md', '## compatibility base\n\nprod-1.0.0\n');
    const bundle = commit(dir, 'stg bundle');
    git(dir, 'tag', 'stg-1.0.0-bundle-2');
    vi.mocked(runData).mockImplementation((_c, repo: GameRepo) => {
      const v = readFileSync(join(repo.root, 'data', 'v.txt'), 'utf8').trim();
      write(repo.root, 'client/build/data/data_version', v);
      write(repo.root, 'server/build/data/data_version', v);
      return Promise.resolve({ exitCode: 0, lines: [], stderr: '' });
    });
    const out = await ogw(ws, ['build', 'start', 'g', 'PROD', '--bundle-for', '1.0.0'], { env: { ...env, FAKE_NO_REMOTE: '1' } });
    expect(out.stderr).toBe('');
    expect(out.stdout).toContain('run build-prod-1.0.0-bundle-2\nversion 1.0.0-bundle-2\nbranch build/prod-1.0.0-bundle-2');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(bundle);
    git(dir, 'checkout', '--quiet', 'main');
    write(dir, 'data/v.txt', 'p1-d2');
    write(dir, 'records/loops/build-stg-1.0.0-bundle-3/end.md', '## compatibility base\n\nprod-1.0.0\n');
    commit(dir, 'data bundle');
    git(dir, 'tag', 'stg-1.0.0-bundle-3');
    const ws2 = await import('./helpers.ts');
    const g = await ws2.gameRepo(ws);
    const { changeRuns } = await import('../../../src/lib/runstate.ts');
    await changeRuns(g, (runs) => {
      for (const r of runs) r.closedAt = 1;
    });
    const withData = await ogw(ws, ['build', 'start', 'g', 'PROD', '--bundle-for', '1.0.0'], { env: { ...env, FAKE_NO_REMOTE: '1' } });
    expect(withData.stderr).toContain('server image ghcr.io/example/game-server:stg-1.0.0-bundle-3 is not in the registry');
  });
});

describe('build start host checks of build procedure 1', () => {
  function engineJson(buildTools: object[]): void {
    writeFileSync(join(coreDir, 'engine.json'), JSON.stringify({ godot: '4.5.1.stable', buildTools }));
  }

  it('probes an installed build tool with downloads and a version printed on stderr', async () => {
    const ws = makeWorkspace();
    const env = { ...prepare(ws), OGW_HOST_PLATFORM: 'macos-arm64' };
    const download = { platform: 'macos-arm64', url: 'https://example.com/jdk.tar.gz', sha256: 'a'.repeat(64) };
    engineJson([
      { platform: 'linux', hosts: ['macos-arm64'], name: 'jdk', version: '17', versionCommand: 'java -version', downloads: [download] },
      { platform: 'linux', hosts: ['macos-arm64'], name: 'stderr-tool', version: '21.0', versionCommand: 'stderr-tool --version' },
    ]);
    fakeBin(ws, { 'stderr-tool': 'echo "21.0.1" >&2' });
    setupGame(ws);
    const missing = await ogw(ws, ['build', 'start', 'g', 'DEV'], { env });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('build tool jdk 17 for linux is not on this host');
    expect(missing.stderr).not.toContain('stderr-tool');
    const dir = join(ws.root, '.ogw', 'build-tools', 'jdk', '17');
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'java'), '#!/bin/sh\necho \'17.0.2 2024-01-16\' >&2\n');
    chmodSync(join(dir, 'bin', 'java'), 0o755);
    writeFileSync(join(dir, 'installed.json'), JSON.stringify({ name: 'jdk', version: '17', sha256: ['a'.repeat(64)], program: 'bin/java' }));
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV'], { env });
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
  });

  it('needs a Mac host for ios and macos', async () => {
    const ws = makeWorkspace();
    const env = { ...prepare(ws), OGW_HOST_PLATFORM: 'linux-x64' };
    setupGame(ws);
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV', 'ios'], { env });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('ios and macos build only on a Mac host');
    const mac = await ogw(ws, ['build', 'start', 'g', 'DEV', 'ios'], { env: { ...env, OGW_HOST_PLATFORM: 'macos-arm64' } });
    expect(mac.stderr).not.toContain('Mac host');
  });

  it('needs every signing secret, updatePublicKeys, and the PROD operator secret once a PROD tag exists', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    setSecrets(ws, { 'ogw/g/DEV/deploySsh': 'k', 'ogw/g/DEV/adminOgw': 's', 'ogw/g/signing/keystore': 'x' });
    const settings = await import('./helpers.ts').then((h) => h.gameSettings());
    const environments = settings.environments as Record<string, Record<string, unknown>>;
    (environments.DEV as Record<string, unknown>).updatePublicKeys = [];
    const dir = setupGame(ws, 'g', { environments, buildPlatforms: ['android'], androidKeyAlias: 'key', signing: { android: { keystore: 'keystore', keystorePassword: 'keystorePassword' } } });
    git(dir, 'tag', 'prod-0.1.0');
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV'], { env });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('signing secret keystorePassword (android keystorePassword) is not in the secret store');
    expect(out.stderr).not.toContain('signing secret keystore (');
    expect(out.stderr).toContain('game settings environments.DEV.updatePublicKeys is missing');
    expect(out.stderr).toContain('secret ogw/g/PROD/adminOgw is not in the secret store');
    expect(await runsOf(ws)).toEqual([]);
  });

  it('needs the PROD operator secret when the contract version rose', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const dir = setupGame(ws, 'g', {}, { 'server/generated/contract/contract.ts': 'export const CONTRACT_VERSION = 1;\n' });
    git(dir, 'tag', 'prod-1.0.0');
    write(dir, 'server/generated/contract/contract.ts', 'export const CONTRACT_VERSION = 2;\n');
    write(dir, 'records/loops/build-stg-1.1.0/end.md', '## compatibility base\n\nprod-1.0.0\n');
    commit(dir, 'v2');
    git(dir, 'tag', 'stg-1.1.0');
    setSecrets(ws, { 'ogw/harness/claude-code-oauth-token': 'token' });
    const out = await ogw(ws, ['build', 'start', 'g', 'PROD'], { env });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('secret ogw/g/PROD/adminOgw is not in the secret store');
    expect(vi.mocked(adminCall)).not.toHaveBeenCalled();
  });
});

describe('build start settings and run registration', () => {
  it('reads the settings of main HEAD and runs the human checks on main from another branch', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const dir = setupGame(ws);
    const main = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '--quiet', '-b', 'other');
    const settings = await import('./helpers.ts').then((h) => h.gameSettings({ buildPlatforms: ['web'] }));
    const environments = settings.environments as Record<string, Record<string, unknown>>;
    (environments.DEV as Record<string, unknown>).adapters = { 'push-apns': 'push-apns' };
    write(dir, 'settings.json', settings);
    commit(dir, 'other settings');
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV', '--json'], { env });
    expect(out.stderr).toBe('');
    expect(JSON.parse(out.stdout)).toMatchObject({ branch: 'build/dev-0.1.0', commit: main, platforms: ['linux'] });
    expect((await runsOf(ws))[0]).toMatchObject({ platforms: ['linux'], baseCommit: main });
  });

  it('reads the PROD settings of the stg tag commit, not of main HEAD', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const dir = setupGame(ws);
    write(dir, 'records/loops/build-stg-1.1.0/end.md', '## compatibility base\n\nnone\n');
    const stg = commit(dir, 'stg build');
    git(dir, 'tag', 'stg-1.1.0');
    const settings = await import('./helpers.ts').then((h) => h.gameSettings({ buildPlatforms: ['linux', 'ios'] }));
    write(dir, 'settings.json', settings);
    commit(dir, 'ios on main');
    const out = await ogw(ws, ['build', 'start', 'g', 'PROD', '--json'], { env });
    expect(out.stderr).toBe('');
    expect(JSON.parse(out.stdout)).toMatchObject({ commit: stg, platforms: ['linux'] });
    expect((await runsOf(ws))[0]).toMatchObject({ platforms: ['linux'] });
  });

  it('registers the run under the run file lock and makes no branch when another run opened meanwhile', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const dir = setupGame(ws);
    const { changeRuns, newRunState } = await import('../../../src/lib/runstate.ts');
    const { gameRepo } = await import('./helpers.ts');
    const g = await gameRepo(ws);
    vi.mocked(gameModules).mockImplementationOnce(async () => {
      await changeRuns(g, (runs) => {
        runs.push(newRunState({ name: 'update-1', kind: 'loop', branch: 'loop/update-1', baseCommit: 'x' }));
      });
      return { client: [], server: [] };
    });
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV'], { env });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('open run: update-1');
    expect(git(dir, 'branch', '--list')).toBe('* main');
    expect((await runsOf(ws)).map((r) => r.name)).toEqual(['update-1']);
  });

  it('runs the human checks in a worktree of main and leaves the checkout of a run that opened meanwhile', async () => {
    const ws = makeWorkspace();
    const env = prepare(ws);
    const dir = setupGame(ws);
    const main = git(dir, 'rev-parse', 'HEAD');
    const { changeRuns, newRunState } = await import('../../../src/lib/runstate.ts');
    const { gameRepo } = await import('./helpers.ts');
    const g = await gameRepo(ws);
    let checkedRoot = '';
    vi.mocked(gameModules).mockImplementationOnce(async (_ctx, repo) => {
      checkedRoot = repo.root;
      await changeRuns(g, (runs) => {
        runs.push(newRunState({ name: 'update-1', kind: 'loop', branch: 'loop/update-1', baseCommit: main }));
      });
      git(dir, 'checkout', '--quiet', '-b', 'loop/update-1');
      return { client: [], server: [] };
    });
    const out = await ogw(ws, ['build', 'start', 'g', 'DEV'], { env });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('open run: update-1');
    expect(checkedRoot).not.toBe(dir);
    expect(existsSync(checkedRoot)).toBe(false);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('loop/update-1');
    expect(git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length).toBe(1);
    expect((await runsOf(ws)).map((r) => r.name)).toEqual(['update-1']);
  });
});
