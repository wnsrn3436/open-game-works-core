import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as tar from 'tar';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildRunResult } from '../../../src/commands/build/lib/buildrun.ts';
import type { MeasureGate } from '../../../src/commands/build/lib/client-check.ts';
import { startJob } from '../../../src/lib/jobs.ts';
import { devicePerformance } from '../../../src/commands/build/lib/device-performance.ts';
import { buildBundle, buildPlatforms } from '../../../src/commands/build/lib/platform.ts';
import { saveSchemaCheck } from '../../../src/commands/build/lib/saveschema.ts';
import { appCheckLimit } from '../../../src/commands/build/lib/update.ts';
import { repeatTest } from '../../../src/commands/build/lib/repeat-test.ts';
import { soakTest } from '../../../src/commands/build/lib/soak-test.ts';
import { webSmoke } from '../../../src/commands/build/lib/web-smoke.ts';
import { placeholderFailures } from '../../../src/commands/check/api.ts';
import { staticCheck } from '../../../src/commands/check/static-api.ts';
import { runContract } from '../../../src/commands/contract/api.ts';
import { coreRelease, coreReleaseOfGame, extractedAsset } from '../../../src/commands/core/api.ts';
import { runData } from '../../../src/commands/data/api.ts';
import { gameModules, mergeReleaseSettings, moduleFilesWithoutDev } from '../../../src/commands/generate/api.ts';
import type { GameRepo } from '../../../src/lib/game.ts';
import { ogw, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { commit, fakeBin, gameSettings, git, openBuildRun, setSecrets, setupGame, write } from './helpers.ts';

vi.mock('../../../src/commands/check/static-api.ts', () => ({ staticCheck: vi.fn() }));
vi.mock('../../../src/commands/check/api.ts', async (orig) => ({ ...(await orig<object>()), placeholderFailures: vi.fn() }));
vi.mock('../../../src/commands/contract/api.ts', async (orig) => ({ ...(await orig<object>()), runContract: vi.fn() }));
vi.mock('../../../src/commands/data/api.ts', async (orig) => ({ ...(await orig<object>()), runData: vi.fn() }));
vi.mock('../../../src/commands/generate/api.ts', async (orig) => ({ ...(await orig<object>()), gameModules: vi.fn(), mergeReleaseSettings: vi.fn(), moduleFilesWithoutDev: vi.fn() }));
vi.mock('../../../src/commands/core/api.ts', async (orig) => ({ ...(await orig<object>()), coreRelease: vi.fn(), coreReleaseOfGame: vi.fn(), extractedAsset: vi.fn() }));
vi.mock('../../../src/commands/build/lib/platform.ts', () => ({ buildPlatforms: vi.fn(), buildBundle: vi.fn() }));
vi.mock('../../../src/commands/build/lib/web-smoke.ts', async (orig) => {
  const real = await orig<typeof import('../../../src/commands/build/lib/web-smoke.ts')>();
  return { ...real, webSmoke: vi.fn(real.webSmoke) };
});
vi.mock('../../../src/commands/build/lib/repeat-test.ts', async (orig) => ({ ...(await orig<object>()), repeatTest: vi.fn() }));
vi.mock('../../../src/commands/build/lib/soak-test.ts', async (orig) => ({ ...(await orig<object>()), soakTest: vi.fn() }));
vi.mock('../../../src/commands/build/lib/device-performance.ts', async (orig) => {
  const real = await orig<typeof import('../../../src/commands/build/lib/device-performance.ts')>();
  return { ...real, devicePerformance: vi.fn(real.devicePerformance) };
});
vi.mock('../../../src/commands/build/lib/saveschema.ts', async (orig) => {
  const real = await orig<typeof import('../../../src/commands/build/lib/saveschema.ts')>();
  return { ...real, saveSchemaCheck: vi.fn(real.saveSchemaCheck) };
});
// the late checks job of a DEV build is started, not run: `ogw build late` has its own tests
vi.mock('../../../src/lib/jobs.ts', async (orig) => ({ ...(await orig<object>()), startJob: vi.fn(() => Promise.resolve('late-job')) }));

const DOCKER = `case "$1 $2" in
  "login ghcr.io") cat > /dev/null;;
  "buildx build") case "$*" in *type=cacheonly*) touch "$FAKE_DIR/warmed"; [ -n "$FAKE_WARM_FAIL" ] && { echo "cache build failed" >&2; exit 1; }; [ -n "$FAKE_WARM_HANG" ] && { echo $$ > "$FAKE_DIR/warm.pid"; while :; do sleep 0.1; done; }; exit 0;; *type=tar,dest=*) for a; do case "$a" in type=tar,dest=*) cp "$FAKE_IMAGE_TAR" "\${a#type=tar,dest=}";; esac; done; for last; do :; done; cp "$last/generated/core_settings.json" "$FAKE_DIR/tar_core_settings.json"; cp "$last/generated/server_modules.json" "$FAKE_DIR/tar_server_modules.json"; exit 0;; esac; for last; do :; done; cp "$last/generated/core_settings.json" "$FAKE_DIR/server_core_settings.json"; ls "$last" > "$FAKE_DIR/server_ls"; echo "$last" > "$FAKE_DIR/server_context";;
  "buildx imagetools") case "$*" in *Manifest*) echo '{"digest":"sha256:pushed"}';; *) echo '{"config":{"Labels":{"ogw.compat_client_data_version":"'"$FAKE_LABEL"'"}}}';; esac;;
esac`;
const GH = `case "$1 $2" in "auth token") echo tok;; "api user") echo me;; esac`;

let release = '';

/** `ogw data` fake: data versions come from `data/version.txt` of the checkout. */
function fakeData(): void {
  vi.mocked(runData).mockImplementation((_ctx, repo: GameRepo) => {
    const versionFile = join(repo.root, 'data', 'version.txt');
    const [protocol, hash] = (existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : 'p1 d1').split(' ');
    const v = `${String(protocol)}-${String(hash)}`;
    write(repo.root, 'client/build/data/data_version', v);
    write(repo.root, 'client/build/data/items.bin', `items ${v}`);
    write(repo.root, 'server/build/data/data_version', v);
    write(repo.root, 'server/build/data/client_data_version', v);
    if (existsSync(join(repo.root, 'data', 'compat.txt'))) write(repo.root, 'server/build/data/compat_client_data_version', readFileSync(join(repo.root, 'data', 'compat.txt'), 'utf8').trim());
    return Promise.resolve({ exitCode: 0, lines: [], stderr: '' });
  });
}

beforeEach(() => {
  // the web checks after web smoke pass; their own tests run them
  vi.mocked(repeatTest).mockImplementation((input) => Promise.resolve(input.platforms.includes('web') && input.env !== 'PROD' ? { name: 'repeat test', result: 'pass', details: [] } : null));
  vi.mocked(soakTest).mockImplementation((input) => Promise.resolve(input.platforms.includes('web') && input.env !== 'PROD' ? { name: 'soak test', result: 'pass', details: [] } : null));
  vi.mocked(staticCheck).mockResolvedValue({ name: 'static check', platform: null, result: 'pass', failures: [], warnings: [] });
  vi.mocked(placeholderFailures).mockResolvedValue([]);
  vi.mocked(runContract).mockResolvedValue({ exitCode: 0, violations: [], stderr: '' });
  vi.mocked(gameModules).mockResolvedValue({ client: [], server: [] });
  vi.mocked(mergeReleaseSettings).mockResolvedValue({ 'admin-api.switchCacheMs': 1000, 'matchmaker.reportMarginMs': 500 });
  vi.mocked(moduleFilesWithoutDev).mockReset();
  vi.mocked(moduleFilesWithoutDev).mockResolvedValue({ coreSettings: '{"b": 2, "environments.STG.serverUrl": "s", "environments.PROD.serverUrl": "p"}\n', serverModules: '["routing"]\n' });
  vi.mocked(coreReleaseOfGame).mockImplementation(() => Promise.resolve({ version: '1.0.0', dir: release, local: false }));
  vi.mocked(coreRelease).mockImplementation((_c, version) => Promise.resolve({ version, dir: join(release, version), local: false }));
  vi.mocked(extractedAsset).mockImplementation(() => Promise.resolve(release));
  vi.mocked(buildPlatforms).mockImplementation((_ctx, input) => {
    for (const p of input.platforms) write(join(input.outDir, p), `g.${p}`, 'binary');
    return Promise.resolve({ artifacts: input.platforms.map((p) => ({ platform: p, path: `builds/${input.env.toLowerCase()}-${input.version}/${p}` })), devCode: [] });
  });
  vi.mocked(buildBundle).mockResolvedValue([]);
  fakeData();
});

function prepare(ws: TestWorkspace, patch: Record<string, unknown> = {}): { dir: string; env: NodeJS.ProcessEnv; log: string } {
  release = join(ws.root, 'release');
  mkdirSync(join(release, '1.0.0'), { recursive: true });
  const cdnRow = { dataType: 'none', description: 'cdn', source: 'cdn-r2', purposes: [], linked: false, tracking: false, shared: false, optional: false, platforms: [], condition: null };
  writeFileSync(join(release, 'core-spec.json'), JSON.stringify({ modules: [{ name: 'game-update', side: 'server', adapters: ['cdn-r2'], collectedData: [cdnRow] }] }));
  writeFileSync(join(release, '1.0.0', 'manifest.json'), JSON.stringify({ coreSchemaVersion: 4 }));
  // check `native plugin`: every asset of the release extracts to `release`
  writeFileSync(join(release, 'engine.json'), JSON.stringify({ plugins: [{ name: 'ogw-secure-storage', platforms: ['android', 'linux'] }] }));
  for (const platform of ['android', 'linux']) mkdirSync(join(release, 'ogw-secure-storage', platform), { recursive: true });
  const dir = setupGame(ws, 'g', { ...patch }, {
    'data/version.txt': 'p1 d1',
    'server/core/Dockerfile': 'FROM node',
    'server/node_modules/x/index.js': 'x',
    'server/generated/core_settings.json': { a: 1, 'environments.DEV.serverUrl': 'd', 'environments.PROD.serverUrl': 'p', environments: { DEV: 1, STG: 2 } },
    'server/generated/server_modules.json': ['cheat', 'routing'],
  });
  setSecrets(ws, { 'ogw/g/DEV/devAccess': 'DEV-ACCESS-VALUE', 'ogw/g/DEV/db': 'DB-CONNECTION' });
  const bin = fakeBin(ws, { docker: DOCKER, gh: GH });
  return { dir, env: { ...bin.env, FAKE_LABEL: '', FAKE_DIR: bin.bin }, log: bin.log };
}

function result(dir: string, name: string): BuildRunResult {
  return JSON.parse(readFileSync(join(dir, 'builds', name, 'build-run.json'), 'utf8')) as BuildRunResult;
}

describe('build run', () => {
  it('needs an open build run and its branch', async () => {
    const ws = makeWorkspace();
    const { dir } = prepare(ws);
    expect((await ogw(ws, ['build', 'run', 'g'])).stderr).toContain('no open build run');
    await openBuildRun(ws, dir);
    git(dir, 'checkout', '--quiet', 'main');
    expect((await ogw(ws, ['build', 'run', 'g'])).stderr).toContain('the checkout is on main, not the build branch build/dev-0.1.0');
  });

  it('builds DEV: checks, privacy, platforms, server image, update folder', async () => {
    const ws = makeWorkspace();
    const { dir, env, log } = prepare(ws, { buildPlatforms: ['linux', 'android'] });
    await openBuildRun(ws, dir, { platforms: ['linux', 'android'] });
    const out = await ogw(ws, ['build', 'run', 'g'], { env });
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    const r = result(dir, 'dev-0.1.0');
    expect(r.checks.map((c) => `${c.name}:${c.result}`)).toEqual([
      'DEV code:pass', 'license:pass', 'adapter:pass', 'admob:pass', 'banned word:pass', 'privacy:pass', 'native plugin:pass', 'secret:pass', 'placeholder:pass', 'device performance:unknown',
    ]);
    expect(r.artifacts).toEqual([{ platform: 'linux', path: 'builds/dev-0.1.0/linux' }, { platform: 'android', path: 'builds/dev-0.1.0/android' }]);
    expect(r.serverImage).toEqual({ name: 'ghcr.io/example/game-server', tag: 'dev-0.1.0', digest: 'sha256:pushed' });
    expect(r.serverDataVersions).toEqual({ client_data_version: 'p1-d1', compat_client_data_version: '' });
    expect([r.compatibilityBase, r.protocolChange, r.matchWaitMs, r.converters, r.coreSchema]).toEqual(['none', null, null, null, null]);
    const update = JSON.parse(readFileSync(join(dir, 'builds/dev-0.1.0/update/update.json'), 'utf8')) as { apps: string[]; data_version: string };
    expect(update).toMatchObject({ apps: ['0.1.0'], data_version: 'p1-d1' });
    expect(readFileSync(join(dir, 'builds/dev-0.1.0/privacy/google-play.md'), 'utf8')).toContain('No data is collected.');
    const calls = readFileSync(log, 'utf8');
    const fakeDir = join(ws.root, 'fake-bin');
    const context = readFileSync(join(fakeDir, 'server_context'), 'utf8').trim();
    expect(context).toMatch(/ogw-server-image-[^/]+\/server$/);
    expect(existsSync(context)).toBe(false);
    expect(calls).toContain(`docker buildx build --platform linux/amd64 --file ${join(context, 'core/Dockerfile')} --build-arg OGW_ENV=DEV --label ogw.compat_client_data_version= --tag ghcr.io/example/game-server:dev-0.1.0 --push ${context}`);
    expect(JSON.parse(readFileSync(join(fakeDir, 'server_core_settings.json'), 'utf8'))).toEqual({ a: 1, 'environments.DEV.serverUrl': 'd', environments: { DEV: 1 } });
    expect(readFileSync(join(fakeDir, 'server_ls'), 'utf8').split('\n').filter(Boolean)).toEqual(['build', 'core', 'generated']);
    // DEV keeps the prepared modules of `ogw generate`: the DEV module cheat stays
    expect(vi.mocked(moduleFilesWithoutDev)).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, 'server/generated/core_settings.json'), 'utf8'))).toMatchObject({ 'environments.PROD.serverUrl': 'p' });
    expect(vi.mocked(staticCheck).mock.calls[0]?.[2]).toEqual({ debugText: false });
    expect(out.stdout).toContain('check device performance: unknown\n  harness settings testDevices has no android device');
    expect(out.stdout).toContain('server image ghcr.io/example/game-server:dev-0.1.0@sha256:pushed');
  });

  it('builds the STG server image for STG: the image it pushes holds no DEV code', async () => {
    const ws = makeWorkspace();
    const { dir, env, log } = prepare(ws, { privacy: { contentData: [] } });
    await openBuildRun(ws, dir, { env: 'STG', version: '0.2.0', platforms: ['linux'] });
    expect((await ogw(ws, ['build', 'run', 'g'], { env })).stderr).toBe('');
    expect(result(dir, 'stg-0.2.0').serverImage).toEqual({ name: 'ghcr.io/example/game-server', tag: 'stg-0.2.0', digest: 'sha256:pushed' });
    const context = readFileSync(join(ws.root, 'fake-bin', 'server_context'), 'utf8').trim();
    expect(readFileSync(log, 'utf8')).toContain(`docker buildx build --platform linux/amd64 --file ${join(context, 'core/Dockerfile')} --build-arg OGW_ENV=STG --label ogw.compat_client_data_version= --tag ghcr.io/example/game-server:stg-0.2.0 --push ${context}`);
  });

  it('builds the server image into the build cache beside the platform build, and pushes it with the same arguments after the artifact checks', async () => {
    const ws = makeWorkspace();
    const { dir, env, log } = prepare(ws);
    await openBuildRun(ws, dir, { platforms: ['linux'] });
    const warmed = join(ws.root, 'fake-bin', 'warmed');
    let warmedDuringExport = false;
    vi.mocked(buildPlatforms).mockImplementation(async (_ctx, input) => {
      // the platform build ends when the image has been built beside it (or after 5 s): built after it, it would not be
      for (let i = 0; i < 250 && !existsSync(warmed); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      warmedDuringExport = existsSync(warmed);
      write(join(input.outDir, 'linux'), 'g.x86_64', 'binary');
      return { artifacts: [{ platform: 'linux', path: 'builds/dev-0.1.0/linux' }], devCode: [] };
    });
    const out = await ogw(ws, ['build', 'run', 'g'], { env });
    expect([out.code, out.stderr]).toEqual([0, '']);
    expect(warmedDuringExport).toBe(true);
    const builds = readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('docker buildx build')).map((l) => l.replace(/\S*\/ogw-server-image-[^/\s]+/g, '<context>'));
    const args = 'docker buildx build --platform linux/amd64 --file <context>/server/core/Dockerfile --build-arg OGW_ENV=DEV --label ogw.compat_client_data_version= --tag ghcr.io/example/game-server:dev-0.1.0';
    expect(builds).toEqual([`${args} --output type=cacheonly <context>/server`, `${args} --push <context>/server`]);
    expect(result(dir, 'dev-0.1.0').serverImage).toEqual({ name: 'ghcr.io/example/game-server', tag: 'dev-0.1.0', digest: 'sha256:pushed' });
  });

  it('checks the earlier app versions of the environment for update.json together, at most one per CPU of this host', async () => {
    const ws = makeWorkspace();
    const { dir, env } = prepare(ws);
    for (const version of ['0.1.0', '0.1.1', '0.1.2']) {
      write(dir, 'notes.txt', version);
      commit(dir, version);
      git(dir, 'tag', `dev-${version}`);
    }
    await openBuildRun(ws, dir, { version: '0.2.0', platforms: ['linux'] });
    const real = vi.mocked(runData).getMockImplementation() as typeof runData;
    let building = 0;
    let mostBuilding = 0;
    vi.mocked(runData).mockImplementation(async (ctx, repo, options) => {
      // the data build of an app version runs in its own worktree
      if (!repo.inWorktree) return real(ctx, repo, options);
      building += 1;
      mostBuilding = Math.max(mostBuilding, building);
      // longer than a git worktree add, which the worktree lock of the repo runs one at a time
      await new Promise((resolve) => setTimeout(resolve, 500));
      building -= 1;
      return real(ctx, repo, options);
    });
    const cpus = appCheckLimit.count;
    appCheckLimit.count = () => 2;
    try {
      expect((await ogw(ws, ['build', 'run', 'g'], { env })).stderr).toBe('');
    } finally {
      appCheckLimit.count = cpus;
    }
    expect(mostBuilding).toBe(2);
    const update = JSON.parse(readFileSync(join(dir, 'builds/dev-0.2.0/update/update.json'), 'utf8')) as { apps: string[] };
    expect(update.apps).toEqual(['0.2.0', '0.1.0', '0.1.1', '0.1.2']);
  });

  it('stops before building when a check fails, and records human checks', async () => {
    const ws = makeWorkspace();
    const settings = gameSettings();
    const environments = settings.environments as Record<string, Record<string, unknown>>;
    (environments.STG as Record<string, unknown>).adapters = { cdn: 'fake' };
    const { dir, env } = prepare(ws, { environments });
    await openBuildRun(ws, dir, { env: 'STG', version: '0.2.0', platforms: ['linux'] });
    vi.mocked(staticCheck).mockResolvedValue({ name: 'static check', platform: null, result: 'fail', failures: [{ where: 'client/x.gd:3', message: 'debug text "TODO"', evidence: [] }], warnings: [] });
    const out = await ogw(ws, ['build', 'run', 'g'], { env });
    expect(out.code).toBe(1);
    const r = result(dir, 'stg-0.2.0');
    expect(r.checks.find((c) => c.name === 'debug text')).toEqual({ name: 'debug text', result: 'fail', details: ['client/x.gd:3: debug text "TODO"'] });
    expect(r.human).toEqual([{ check: 'adapter', targets: ['environments.STG.adapters.cdn'] }]);
    expect(r.artifacts).toEqual([]);
    expect(buildPlatforms).not.toHaveBeenCalled();
    expect(out.stdout).toContain('human check adapter: environments.STG.adapters.cdn');
  });

  it('fails the secret check on a leaking artifact, and pushes no server image', async () => {
    const ws = makeWorkspace();
    const { dir, env, log } = prepare(ws);
    await openBuildRun(ws, dir, { platforms: ['linux'] });
    vi.mocked(buildPlatforms).mockImplementation((_c, input) => {
      write(join(input.outDir, 'linux'), 'g.pck', 'has DB-CONNECTION and DEV-ACCESS-VALUE');
      return Promise.resolve({ artifacts: [{ platform: 'linux', path: 'builds/dev-0.1.0/linux' }], devCode: [] });
    });
    const out = await ogw(ws, ['build', 'run', 'g'], { env });
    expect(out.code).toBe(1);
    // the DEV devAccess value is allowed only inside the package's build info file
    expect(result(dir, 'dev-0.1.0').checks.find((c) => c.name === 'secret')).toEqual({
      name: 'secret', result: 'fail', details: ['builds/dev-0.1.0/linux/g.pck: secret db', 'builds/dev-0.1.0/linux/g.pck: secret devAccess'],
    });
    expect(result(dir, 'dev-0.1.0').serverImage).toBeNull();
    // the image build into the cache stops with the failed artifacts; nothing is pushed
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').not.toContain('--push');
    expect(existsSync(join(dir, 'builds/dev-0.1.0/update'))).toBe(false);
    // a cache build that failed beside the blocked artifacts is no error of the run: the blocked build needs no image
    const warmed = join(ws.root, 'fake-bin', 'warmed');
    vi.mocked(buildPlatforms).mockImplementation(async (_c, input) => {
      for (let i = 0; i < 250 && !existsSync(warmed); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      write(join(input.outDir, 'linux'), 'g.pck', 'has DB-CONNECTION');
      return { artifacts: [{ platform: 'linux', path: 'builds/dev-0.1.0/linux' }], devCode: [] };
    });
    const failed = await ogw(ws, ['build', 'run', 'g'], { env: { ...env, FAKE_WARM_FAIL: '1' } });
    expect(existsSync(warmed)).toBe(true);
    expect([failed.code, failed.stderr]).toEqual([1, '']);
    expect(result(dir, 'dev-0.1.0').checks.find((c) => c.name === 'secret')?.details).toEqual(['builds/dev-0.1.0/linux/g.pck: secret db']);
  });

  it('stops the cache build of the server image and the checks of the earlier app versions when the artifacts leak a secret', { timeout: 30_000 }, async () => {
    const ws = makeWorkspace();
    const { dir, env, log } = prepare(ws);
    for (const version of ['0.1.0', '0.1.1', '0.1.2', '0.1.3']) {
      write(dir, 'notes.txt', version);
      commit(dir, version);
      git(dir, 'tag', `dev-${version}`);
    }
    await openBuildRun(ws, dir, { version: '0.2.0', platforms: ['linux'] });
    const real = vi.mocked(runData).getMockImplementation() as typeof runData;
    let appBuilds = 0;
    vi.mocked(runData).mockImplementation(async (ctx, repo, options) => {
      // the data build of an earlier app version, in its own worktree
      if (repo.inWorktree) {
        appBuilds += 1;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return real(ctx, repo, options);
    });
    const fake = join(ws.root, 'fake-bin');
    vi.mocked(buildPlatforms).mockImplementation(async (_c, input) => {
      // the artifact leaks while the cache build runs, which ends only when it is killed
      for (let i = 0; i < 250 && !existsSync(join(fake, 'warm.pid')); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      write(join(input.outDir, 'linux'), 'g.pck', 'has DB-CONNECTION');
      return { artifacts: [{ platform: 'linux', path: 'builds/dev-0.1.0/linux' }], devCode: [] };
    });
    const cpus = appCheckLimit.count;
    appCheckLimit.count = () => 1;
    let out: Awaited<ReturnType<typeof ogw>>;
    try {
      out = await ogw(ws, ['build', 'run', 'g'], { env: { ...env, FAKE_WARM_HANG: '1' } });
    } finally {
      appCheckLimit.count = cpus;
    }
    expect([out.code, out.stderr]).toEqual([1, '']);
    expect(result(dir, 'dev-0.2.0').checks.find((c) => c.name === 'secret')?.details).toEqual(['builds/dev-0.2.0/linux/g.pck: secret db']);
    // the cache build was killed, and nothing was pushed
    const pid = Number(readFileSync(join(fake, 'warm.pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(readFileSync(log, 'utf8')).not.toContain('--push');
    // one app version at a time: after the leak no other one starts
    expect(appBuilds).toBeLessThanOrEqual(2);
    expect(result(dir, 'dev-0.2.0').serverImage).toBeNull();
  });

  it('records web smoke with its first loading ms; a DEV warning does not block, a STG failure does', async () => {
    const ws = makeWorkspace();
    const environments = gameSettings().environments as Record<string, Record<string, unknown>>;
    (environments.DEV as Record<string, unknown>).adapters = { cdn: 'cdn-r2' };
    const { dir, env } = prepare(ws, { buildPlatforms: ['web'], environments });
    await openBuildRun(ws, dir, { platforms: ['web'] });
    vi.mocked(webSmoke).mockResolvedValueOnce({ check: { name: 'web smoke', result: 'warn', details: ['no blocker: step 2: softlock'] }, loadingMs: 1234 });
    const out = await ogw(ws, ['build', 'run', 'g'], { env });
    expect(result(dir, 'dev-0.1.0').checks.filter((c) => c.result === 'fail')).toEqual([]);
    expect([out.code, out.stderr]).toEqual([0, '']);
    const r = result(dir, 'dev-0.1.0');
    // a build without android has no device performance check; a DEV build leaves repeat test and soak test to its late checks job
    expect(r.checks.at(-1)).toEqual({ name: 'web smoke', result: 'warn', details: ['no blocker: step 2: softlock'] });
    expect(r.checks.some((c) => c.name === 'device performance' || c.name === 'repeat test' || c.name === 'soak test')).toBe(false);
    expect(r.lateChecks?.names).toEqual(['repeat test', 'soak test']);
    expect(r.webSmokeLoadingMs).toBe(1234);
    expect(out.stdout).toContain('check web smoke: warn\n  no blocker: step 2: softlock');
    expect(out.stdout).toContain('web smoke first loading ms 1234');
    expect(vi.mocked(webSmoke).mock.calls[0]?.[0]).toMatchObject({ env: 'DEV', version: '0.1.0', exportVersion: '0.1.0', platforms: ['web'] });
    expect(vi.mocked(devicePerformance).mock.calls[0]?.[0]).toMatchObject({ platforms: ['web'] });

    vi.mocked(buildPlatforms).mockClear();
    const stg = makeWorkspace();
    const second = prepare(stg, { buildPlatforms: ['web'] });
    await openBuildRun(stg, second.dir, { env: 'STG', version: '0.2.0', platforms: ['web'] });
    vi.mocked(webSmoke).mockResolvedValueOnce({ check: { name: 'web smoke', result: 'fail', details: ['full flow: step 3: goal is not true after the last step'] }, loadingMs: 900 });
    const failed = await ogw(stg, ['build', 'run', 'g'], { env: second.env });
    expect(failed.code).toBe(1);
    expect(result(second.dir, 'stg-0.2.0')).toMatchObject({ webSmokeLoadingMs: 900, artifacts: [] });
    expect(buildPlatforms).not.toHaveBeenCalled();
  });

  it('hands a DEV web build over without its repeat test and soak test: a late checks job on the build commit runs them, started after the platform build and the push; a blocked build starts none', async () => {
    const ws = makeWorkspace();
    const environments = gameSettings().environments as Record<string, Record<string, unknown>>;
    (environments.DEV as Record<string, unknown>).adapters = { cdn: 'cdn-r2' };
    const { dir, env, log } = prepare(ws, { buildPlatforms: ['web'], environments });
    await openBuildRun(ws, dir, { platforms: ['web'] });
    const order: string[] = [];
    vi.mocked(buildPlatforms).mockImplementation((_c, input) => {
      order.push('platform build');
      write(join(input.outDir, 'web'), 'index.html', 'page');
      return Promise.resolve({ artifacts: [{ platform: 'web', path: 'builds/dev-0.1.0/web' }], devCode: [] });
    });
    vi.mocked(startJob).mockClear();
    vi.mocked(startJob).mockImplementation((options) => {
      order.push(`job ${options.argv.join(' ')}`, `pushed before: ${String(readFileSync(log, 'utf8').includes('--push'))}`);
      return Promise.resolve('late-job');
    });
    const repeats = vi.mocked(repeatTest).mock.calls.length;
    const soaks = vi.mocked(soakTest).mock.calls.length;
    const out = await ogw(ws, ['build', 'run', 'g'], { env });
    expect([out.code, out.stderr]).toEqual([0, '']);
    // the run itself runs neither: its hand-off does not wait for them
    expect([vi.mocked(repeatTest).mock.calls.length, vi.mocked(soakTest).mock.calls.length]).toEqual([repeats, soaks]);
    const head = git(dir, 'rev-parse', 'HEAD');
    expect(order).toEqual(['platform build', `job build late g --commit ${head}`, 'pushed before: true']);
    expect(vi.mocked(startJob).mock.calls[0]?.[0]).toMatchObject({ command: 'build late', game: 'g' });
    expect(result(dir, 'dev-0.1.0').lateChecks).toEqual({ names: ['repeat test', 'soak test'], job: 'late-job', commit: head });
    expect(out.stdout).toContain('check repeat test: pending\ncheck soak test: pending\nlate checks job late-job');
    // a DEV build that a check blocks goes back to the loop: it starts no late checks job
    vi.mocked(startJob).mockClear();
    vi.mocked(staticCheck).mockResolvedValueOnce({ name: 'static check', platform: null, result: 'fail', failures: [{ where: 'client/x.gd:3', message: 'DEV reference dev/bot.gd', evidence: [] }], warnings: [] });
    expect((await ogw(ws, ['build', 'run', 'g'], { env })).code).toBe(1);
    expect(vi.mocked(startJob)).not.toHaveBeenCalled();
    expect(result(dir, 'dev-0.1.0').lateChecks ?? null).toBeNull();
  });

  it('runs the build-time checks that run no game together with the instances and exports of the measurements; the measured runs after them: device performance and web smoke together, repeat test after web smoke, soak test after both; a STG failure blocks', async () => {
    const ws = makeWorkspace();
    const environments = gameSettings().environments as Record<string, Record<string, unknown>>;
    (environments.STG as Record<string, unknown>).adapters = { cdn: 'cdn-r2' };
    const { dir, env } = prepare(ws, { buildPlatforms: ['web', 'android'], environments, privacy: { contentData: [] } });
    vi.mocked(gameModules).mockResolvedValue({ client: [], server: ['game-update'] });
    // a PROD tag: the backward compatibility check runs the contract tool
    git(dir, 'tag', 'prod-0.0.9');
    await openBuildRun(ws, dir, { env: 'STG', version: '0.2.0', platforms: ['web', 'android'] });
    const order: string[] = [];
    // the checks that run no game, and the instances and exports of the two measurements
    const load = ['static check', 'placeholder', 'contract', 'device performance export', 'web smoke export'];
    const started = new Set<string>();
    // a part that runs no game ends only when every other one has started (or after 5 s): run one after another, they would not
    const allStarted = async (): Promise<void> => {
      for (let i = 0; i < 250 && !load.every((name) => started.has(name)); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    };
    // device performance outlasts web smoke and the repeat test: the soak test waits for it too
    // the Gradle export outlasts the other parts that run no game: the measured runs wait for it
    const lasts: Record<string, number> = { 'device performance': 400, 'repeat test': 100, 'device performance export': 300 };
    const step = async (name: string): Promise<void> => {
      order.push(`${name} start`);
      started.add(name);
      if (load.includes(name)) await allStarted();
      await new Promise((resolve) => setTimeout(resolve, lasts[name] ?? 20));
      order.push(`${name} end`);
    };
    const traced = <T>(name: string, value: T) => async (): Promise<T> => {
      await step(name);
      return value;
    };
    // a measurement makes its instance and export, waits at its gate, then runs
    const measured = <T>(name: string, value: T) => async (_input: unknown, gate?: MeasureGate): Promise<T> => {
      await step(`${name} export`);
      gate?.exported();
      expect(await gate?.measure).toBeNull();
      await step(name);
      return value;
    };
    vi.mocked(staticCheck).mockImplementationOnce(traced('static check', { name: 'static check', platform: null, result: 'pass' as const, failures: [], warnings: [] }));
    vi.mocked(placeholderFailures).mockImplementationOnce(traced('placeholder', []));
    vi.mocked(runContract).mockImplementationOnce(traced('contract', { exitCode: 0, violations: [], stderr: '' }));
    vi.mocked(devicePerformance).mockImplementationOnce(measured('device performance', { name: 'device performance', result: 'pass' as const, details: [] }));
    vi.mocked(webSmoke).mockImplementationOnce(measured('web smoke', { check: { name: 'web smoke', result: 'pass' as const, details: [] }, loadingMs: 10 }));
    vi.mocked(repeatTest).mockImplementationOnce(traced('repeat test', { name: 'repeat test', result: 'pass' as const, details: [] }));
    vi.mocked(soakTest).mockImplementationOnce(traced('soak test', { name: 'soak test', result: 'pass' as const, details: [] }));
    const out = await ogw(ws, ['build', 'run', 'g'], { env });
    expect([out.code, out.stderr]).toEqual([0, '']);
    const at = (event: string): number => order.indexOf(event);
    const loadEnd = Math.min(...load.map((name) => at(`${name} end`)));
    const lastLoadEnd = Math.max(...load.map((name) => at(`${name} end`)));
    // the parts that run no game start before any of them ends: the Gradle export of device performance with them
    for (const name of load) expect(at(`${name} start`)).toBeLessThan(loadEnd);
    // the measured runs start after all of those ended; device performance and web smoke overlap as before
    for (const name of ['device performance', 'web smoke', 'repeat test', 'soak test']) expect(at(`${name} start`)).toBeGreaterThan(lastLoadEnd);
    expect(Math.max(at('device performance start'), at('web smoke start'))).toBeLessThan(Math.min(at('device performance end'), at('web smoke end')));
    expect(at('repeat test start')).toBeGreaterThan(at('web smoke end'));
    expect(at('soak test start')).toBeGreaterThan(Math.max(at('device performance end'), at('repeat test end')));
    const checks = result(dir, 'stg-0.2.0').checks.map((c) => `${c.name}:${c.result}`);
    expect(checks.slice(-6)).toEqual(['placeholder:pass', 'device performance:pass', 'web smoke:pass', 'repeat test:pass', 'soak test:pass', 'backward compatibility:pass']);
    expect(vi.mocked(repeatTest).mock.calls[0]?.[0]).toMatchObject({ env: 'STG', version: '0.2.0', exportVersion: '0.2.0', platforms: ['web', 'android'] });

    vi.mocked(buildPlatforms).mockClear();
    const stg = makeWorkspace();
    const second = prepare(stg, { buildPlatforms: ['web'] });
    await openBuildRun(stg, second.dir, { env: 'STG', version: '0.2.0', platforms: ['web'] });
    vi.mocked(soakTest).mockResolvedValueOnce({ name: 'soak test', result: 'fail', details: ['tick 42: softlock {"kind":"NoResponse"}'] });
    const failed = await ogw(stg, ['build', 'run', 'g'], { env: second.env });
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain('check soak test: fail\n  tick 42: softlock {"kind":"NoResponse"}');
    expect(buildPlatforms).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'device performance', platform: 'android' },
    { name: 'web smoke', platform: 'web' },
  ])('does not build STG when check $name is unknown, and prints its reason', async ({ name, platform }) => {
    const ws = makeWorkspace();
    const environments = gameSettings().environments as Record<string, Record<string, unknown>>;
    (environments.STG as Record<string, unknown>).adapters = { cdn: 'cdn-r2' };
    const { dir, env } = prepare(ws, { buildPlatforms: [platform], environments, privacy: { contentData: [] } });
    vi.mocked(gameModules).mockResolvedValue({ client: [], server: ['game-update'] });
    await openBuildRun(ws, dir, { env: 'STG', version: '0.2.0', platforms: [platform] });
    const unknown = { name, result: 'unknown' as const, details: [`${name}: export failed: godot exited with code 1`] };
    if (name === 'device performance') vi.mocked(devicePerformance).mockResolvedValueOnce(unknown);
    else vi.mocked(webSmoke).mockResolvedValueOnce({ check: unknown, loadingMs: null });
    vi.mocked(buildPlatforms).mockClear();
    const out = await ogw(ws, ['build', 'run', 'g'], { env });
    expect([out.code, out.stderr]).toEqual([1, '']);
    const r = result(dir, 'stg-0.2.0');
    // the unknown is the only check that does not pass
    expect(r.checks.filter((c) => c.result !== 'pass')).toEqual([unknown]);
    expect([r.human, r.artifacts, r.serverImage]).toEqual([[], [], null]);
    expect(buildPlatforms).not.toHaveBeenCalled();
    expect(out.stdout).toContain(`check ${name}: unknown\n  ${name}: export failed: godot exited with code 1`);
  });

  it('does not build DEV when check backward compatibility, which warns in no DEV build, is unknown', async () => {
    const ws = makeWorkspace();
    const { dir, env } = prepare(ws);
    write(dir, 'server/generated/contract/game_contract.ts', 'export const CONTRACT_VERSION = 1;\n');
    commit(dir, 'contract 1');
    git(dir, 'tag', 'prod-0.1.0');
    write(dir, 'server/generated/contract/game_contract.ts', 'export const CONTRACT_VERSION = 2;\n');
    commit(dir, 'contract 2');
    await openBuildRun(ws, dir, { version: '0.2.0', platforms: ['linux'] });
    vi.mocked(saveSchemaCheck).mockResolvedValueOnce({ failures: [], unknownKinds: ['QuestUserState'] });
    vi.mocked(buildPlatforms).mockClear();
    const out = await ogw(ws, ['build', 'run', 'g'], { env });
    expect([out.code, out.stderr]).toEqual([1, '']);
    expect(vi.mocked(saveSchemaCheck).mock.calls.at(-1)?.[0]).toMatchObject({ currentVersion: 2 });
    const r = result(dir, 'dev-0.2.0');
    const reason = 'save schema: unknown: no sampled QuestUserState record has a contract version below 2';
    expect(r.checks.filter((c) => c.result !== 'pass')).toEqual([{ name: 'backward compatibility', result: 'unknown', details: [reason] }]);
    expect([r.human, r.artifacts, r.serverImage]).toEqual([[], [], null]);
    expect(buildPlatforms).not.toHaveBeenCalled();
    expect(out.stdout).toContain(`check backward compatibility: unknown\n  ${reason}`);
  });

  it('gives a bundle patch build the app version for the check exports', async () => {
    const ws = makeWorkspace();
    const { dir, env } = prepare(ws, { buildPlatforms: ['android'] });
    git(dir, 'tag', 'dev-0.1.0');
    await openBuildRun(ws, dir, { version: '0.1.0-bundle-1', bundleFor: '0.1.0', platforms: ['android'] });
    vi.mocked(devicePerformance).mockResolvedValueOnce({ name: 'device performance', result: 'pass', details: [] });
    const out = await ogw(ws, ['build', 'run', 'g'], { env });
    expect(out.stderr).toBe('');
    expect(vi.mocked(devicePerformance).mock.calls.at(-1)?.[0]).toMatchObject({ version: '0.1.0-bundle-1', exportVersion: '0.1.0' });
    expect(result(dir, 'dev-0.1.0-bundle-1').checks.find((c) => c.name === 'device performance')?.result).toBe('pass');
  });

  it('compares with the last PROD build: compatibility, protocol change, apps, match wait', async () => {
    const ws = makeWorkspace();
    const { dir, env } = prepare(ws);
    write(dir, 'data/tables/match_mode.csv', ',,,\n,All,All,All\n,id,duration,duration\nid,prepare_time,max_duration,x\n[duel],10s,2m,\n');
    write(dir, 'data/tables/play_session_mode.csv', ',\nAll,All\nid,duration\nid,max_duration\n[run],5m\n');
    commit(dir, 'tables');
    git(dir, 'tag', 'prod-0.1.0');
    git(dir, 'tag', 'dev-0.1.0');
    write(dir, 'data/version.txt', 'p2 d2');
    write(dir, 'data/compat.txt', 'p1-d1');
    commit(dir, 'protocol change');
    git(dir, 'tag', 'dev-0.1.5');
    vi.mocked(gameModules).mockResolvedValue({ client: [], server: ['play-session', 'matchmaker'] });
    vi.mocked(runContract).mockResolvedValue({ exitCode: 1, violations: ['contract/game.proto:3:1 ERROR field removed'], stderr: '' });
    await openBuildRun(ws, dir, { version: '0.2.0' });
    const failed = await ogw(ws, ['build', 'run', 'g'], { env });
    expect(failed.code).toBe(1);
    expect(result(dir, 'dev-0.2.0').checks.find((c) => c.name === 'backward compatibility')).toEqual({
      name: 'backward compatibility', result: 'fail', details: ['contract: contract/game.proto:3:1 ERROR field removed'],
    });
    vi.mocked(runContract).mockResolvedValue({ exitCode: 0, violations: [], stderr: '' });
    expect((await ogw(ws, ['build', 'run', 'g'], { env })).code).toBe(0);
    const r = result(dir, 'dev-0.2.0');
    expect(r.compatibilityBase).toBe('prod-0.1.0');
    expect(r.protocolChange).toEqual({ client_data_version: 'p2-d2', compat_client_data_version: 'p1-d1' });
    expect(r.matchWaitMs).toBe(300_000 + 1000);
    // the contract tool writes generation targets: it runs in its own worktree of the build branch HEAD, not in the checkout the other checks read
    const contractRepo = vi.mocked(runContract).mock.calls.at(-1)?.[1];
    expect(contractRepo?.inWorktree).toBe(true);
    expect(contractRepo?.root.startsWith(join(ws.worktrees, 'g'))).toBe(true);
    const update = JSON.parse(readFileSync(join(dir, 'builds/dev-0.2.0/update/update.json'), 'utf8')) as { apps: string[] };
    expect(update.apps).toEqual(['0.2.0', '0.1.5']);
  });

  it('PROD uses the STG image and records core schema and the converters added after the last PROD build', async () => {
    const ws = makeWorkspace();
    const settings = gameSettings();
    const environments = settings.environments as Record<string, Record<string, unknown>>;
    (environments.PROD as Record<string, unknown>).adapters = { cdn: 'cdn-r2' };
    const { dir, env } = prepare(ws, { environments, privacy: { contentData: [] } });
    vi.mocked(gameModules).mockResolvedValue({ client: [], server: ['game-update'] });
    await openBuildRun(ws, dir, { env: 'PROD', version: '1.0.0' });
    const out = await ogw(ws, ['build', 'run', 'g'], { env });
    expect(out.stderr).toBe('');
    const r = result(dir, 'prod-1.0.0');
    expect(r.serverImage).toEqual({ name: 'ghcr.io/example/game-server', tag: 'stg-1.0.0', digest: 'sha256:pushed' });
    expect(r.converters).toEqual([]);
    expect(r.coreSchema).toEqual({ last: null, current: 4 });
    expect(vi.mocked(staticCheck).mock.calls[0]?.[2]).toEqual({ debugText: true });
    git(dir, 'tag', 'prod-0.9.0', 'main');
    const after = await ogw(ws, ['build', 'run', 'g'], { env: { ...env, FAKE_LABEL: 'stale' } });
    expect(result(dir, 'prod-1.0.0').checks.find((c) => c.name === 'backward compatibility')?.details).toEqual([
      'server image: ghcr.io/example/game-server:stg-1.0.0 label ogw.compat_client_data_version differs from compat_client_data_version',
    ]);
    expect(after.code).toBe(1);
    mkdirSync(join(release, '0.9.0'), { recursive: true });
    writeFileSync(join(release, '0.9.0', 'manifest.json'), JSON.stringify({ coreSchemaVersion: 3 }));
    const again = await ogw(ws, ['build', 'run', 'g'], { env });
    expect(again.stderr).toBe('');
    expect(result(dir, 'prod-1.0.0').converters).toEqual([]);
    expect(result(dir, 'prod-1.0.0').coreSchema).toEqual({ last: 4, current: 4 });
    git(dir, 'tag', '-d', 'prod-0.9.0');
    const lastSettings = { ...settings, environments, privacy: { contentData: [] }, coreVersion: '0.9.0' };
    write(dir, 'settings.json', `${JSON.stringify(lastSettings, null, 2)}\n`);
    write(dir, 'server/generated/contract/converters.json', JSON.stringify([{ kind: 'QuestUserState', from_version: 1 }]));
    commit(dir, 'prod 0.9.0');
    git(dir, 'tag', 'prod-0.9.0');
    git(dir, 'checkout', '--quiet', 'HEAD~1', '--', 'settings.json');
    write(dir, 'server/generated/contract/converters.json', JSON.stringify([
      { kind: 'QuestUserState', from_version: 1 }, { kind: 'QuestUserState', from_version: 2 }, { kind: 'ShopServerState', from_version: 2 },
    ]));
    commit(dir, 'converters');
    expect((await ogw(ws, ['build', 'run', 'g'], { env })).stderr).toBe('');
    expect(result(dir, 'prod-1.0.0').converters).toEqual([{ kind: 'QuestUserState', fromVersion: 2 }, { kind: 'ShopServerState', fromVersion: 2 }]);
    expect(result(dir, 'prod-1.0.0').coreSchema).toEqual({ last: 3, current: 4 });
    write(dir, 'server/generated/contract/converters.json', '{}');
    commit(dir, 'broken list');
    expect((await ogw(ws, ['build', 'run', 'g'], { env })).stderr).toContain('server/generated/contract/converters.json: not a JSON array');
  });

  it('runs the data check with --strict and stops with every line on a data error that is not a compatibility error', async () => {
    const ws = makeWorkspace();
    const { dir, env } = prepare(ws);
    await openBuildRun(ws, dir, { platforms: ['linux'] });
    expect((await ogw(ws, ['build', 'run', 'g'], { env })).code).toBe(0);
    expect(vi.mocked(runData).mock.calls[0]?.[2]).toEqual({ binary: true, strict: true });
    const lines = [
      { level: 'ERROR' as const, code: 'protocol_change', where: 'data/tables/a.csv:1:1', message: 'x', text: 'data/tables/a.csv:1:1 ERROR protocol_change x' },
      { level: 'ERROR' as const, code: 'value_type', where: 'data/tables/a.csv:5:2', message: 'y', text: 'data/tables/a.csv:5:2 ERROR value_type y' },
    ];
    vi.mocked(runData).mockResolvedValueOnce({ exitCode: 1, lines, stderr: '' });
    const out = await ogw(ws, ['build', 'run', 'g'], { env });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('ogw data failed:\ndata/tables/a.csv:1:1 ERROR protocol_change x\ndata/tables/a.csv:5:2 ERROR value_type y');
  });

  it('removes the build-run.json of an earlier attempt, so a run that stops with an error leaves none', async () => {
    const ws = makeWorkspace();
    const { dir, env } = prepare(ws);
    await openBuildRun(ws, dir, { platforms: ['linux'] });
    vi.mocked(staticCheck).mockResolvedValueOnce({ name: 'static check', platform: null, result: 'fail', failures: [{ where: 'client/x.gd:3', message: 'DEV reference dev/bot.gd', evidence: [] }], warnings: [] });
    expect((await ogw(ws, ['build', 'run', 'g'], { env })).code).toBe(1);
    expect(result(dir, 'dev-0.1.0').checks.find((c) => c.name === 'DEV code')?.result).toBe('fail');
    vi.mocked(buildPlatforms).mockRejectedValueOnce(new Error('export failed'));
    const out = await ogw(ws, ['build', 'run', 'g'], { env });
    expect(out.code).not.toBe(0);
    expect(existsSync(join(dir, 'builds/dev-0.1.0/build-run.json'))).toBe(false);
  });

  it('fails DEV code for STG when the server image or a client package holds DEV code', async () => {
    const ws = makeWorkspace();
    const { dir, env } = prepare(ws, { privacy: { contentData: [] } });
    write(dir, 'server/dev/cheat.ts', 'export {};');
    write(dir, 'server/core/auth/dev/fake.ts', 'export {};');
    commit(dir, 'dev code');
    const image = join(ws.root, 'image');
    write(image, 'app/dev/cheat.ts', 'x');
    write(image, 'app/core/auth/index.ts', 'x');
    const imageTar = join(ws.root, 'image.tar');
    await tar.c({ file: imageTar, cwd: image }, ['app']);
    await openBuildRun(ws, dir, { env: 'STG', version: '0.2.0', platforms: ['linux'] });
    const stg = { ...env, FAKE_IMAGE_TAR: imageTar };
    const out = await ogw(ws, ['build', 'run', 'g'], { env: stg });
    expect(out.code).toBe(1);
    expect(result(dir, 'stg-0.2.0').checks.find((c) => c.name === 'DEV code')).toEqual({ name: 'DEV code', result: 'fail', details: ['server image holds DEV code: server/dev/cheat.ts'] });
    expect(buildPlatforms).not.toHaveBeenCalled();
    // the arguments of the image that the build pushes: that build takes every step from the cache of this one
    expect(readFileSync(join(ws.root, 'fake-bin', 'calls.log'), 'utf8')).toMatch(
      /docker buildx build --platform linux\/amd64 --file \S+\/core\/Dockerfile --build-arg OGW_ENV=STG --label ogw\.compat_client_data_version= --tag ghcr\.io\/example\/game-server:stg-0\.2\.0 --output type=tar,dest=\S+\/image\.tar \S+\/server\n/,
    );
    // the STG build context has the core settings file and server module list of the used modules, without DEV modules
    expect(JSON.parse(readFileSync(join(ws.root, 'fake-bin', 'tar_core_settings.json'), 'utf8'))).toEqual({ b: 2, 'environments.STG.serverUrl': 's' });
    expect(JSON.parse(readFileSync(join(ws.root, 'fake-bin', 'tar_server_modules.json'), 'utf8'))).toEqual(['routing']);
    expect(JSON.parse(readFileSync(join(dir, 'server/generated/server_modules.json'), 'utf8'))).toEqual(['cheat', 'routing']);

    write(image, 'app/dev/cheat.ts', '');
    await tar.c({ file: imageTar, cwd: image }, ['app/core']);
    vi.mocked(buildPlatforms).mockImplementation((_c, input) => Promise.resolve({ artifacts: [{ platform: 'linux', path: `builds/stg-${input.version}/linux` }], devCode: ['linux/g.pck holds DEV code: dev/bot.gd'] }));
    const client = await ogw(ws, ['build', 'run', 'g'], { env: stg });
    expect(client.code).toBe(1);
    expect(result(dir, 'stg-0.2.0').checks.find((c) => c.name === 'DEV code')).toEqual({ name: 'DEV code', result: 'fail', details: ['linux/g.pck holds DEV code: dev/bot.gd'] });
    expect(result(dir, 'stg-0.2.0').serverImage).toBeNull();
  });

  it('lists in update.json only app versions that have, with their latest bundle, every resource key the data names', async () => {
    const ws = makeWorkspace();
    const { dir, env } = prepare(ws);
    const list = (keys: string[]): string => `key,sha256,license\n${keys.map((k) => `${k},s,own`).join('\n')}\n`;
    write(dir, 'resource/resources.csv', list(['icon_a']));
    commit(dir, 'resources');
    git(dir, 'tag', 'dev-0.1.0');
    git(dir, 'tag', 'dev-0.1.5');
    write(dir, 'resource/resources.csv', list(['icon_a', 'icon_b']));
    commit(dir, 'icon b');
    git(dir, 'tag', 'dev-0.1.0-bundle-1');
    write(dir, 'data/tables/item.csv', ',,\nAll,Client,Server\nid,reskey,string\nid,icon,note\n[sword],icon_b,icon_c\n#[old],icon_x,\n');
    commit(dir, 'item');
    await openBuildRun(ws, dir, { version: '0.2.0', platforms: ['linux'] });
    expect((await ogw(ws, ['build', 'run', 'g'], { env })).stderr).toBe('');
    const update = JSON.parse(readFileSync(join(dir, 'builds/dev-0.2.0/update/update.json'), 'utf8')) as { apps: string[] };
    expect(update.apps).toEqual(['0.2.0', '0.1.0']);
  });

  it('builds a bundle patch without data: no server image and no update folder', async () => {
    const ws = makeWorkspace();
    const { dir, env } = prepare(ws);
    git(dir, 'tag', 'dev-0.1.0');
    await openBuildRun(ws, dir, { version: '0.1.0-bundle-1', bundleFor: '0.1.0', data: { build: { retries: 0, bundle: 1, startCommit: 'x' } } });
    vi.mocked(buildBundle).mockResolvedValue(['bundle holds code: res://resource/a.gd']);
    const failed = await ogw(ws, ['build', 'run', 'g'], { env });
    expect(failed.code).toBe(1);
    expect(result(dir, 'dev-0.1.0-bundle-1').checks.at(-1)).toEqual({ name: 'bundle', result: 'fail', details: ['bundle holds code: res://resource/a.gd'] });
    vi.mocked(buildBundle).mockResolvedValue([]);
    expect((await ogw(ws, ['build', 'run', 'g'], { env })).code).toBe(0);
    expect(vi.mocked(buildBundle).mock.calls.at(-1)?.[1]).toMatchObject({ appVersion: '0.1.0', withData: false });
    expect(result(dir, 'dev-0.1.0-bundle-1').serverImage).toBeNull();
    expect(existsSync(join(dir, 'builds/dev-0.1.0-bundle-1/update'))).toBe(false);
  });
});
