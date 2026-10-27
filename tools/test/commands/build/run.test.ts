import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as tar from 'tar';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildRunResult } from '../../../src/commands/build/lib/buildrun.ts';
import { devicePerformance } from '../../../src/commands/build/lib/device-performance.ts';
import { buildBundle, buildPlatforms } from '../../../src/commands/build/lib/platform.ts';
import { webSmoke } from '../../../src/commands/build/lib/web-smoke.ts';
import { placeholderFailures } from '../../../src/commands/check/api.ts';
import { staticCheck } from '../../../src/commands/check/static-api.ts';
import { runContract } from '../../../src/commands/contract/api.ts';
import { coreRelease, coreReleaseOfGame, extractedAsset } from '../../../src/commands/core/api.ts';
import { runData } from '../../../src/commands/data/api.ts';
import { gameModules, mergedCoreSettings, moduleFilesWithoutDev } from '../../../src/commands/generate/api.ts';
import type { GameRepo } from '../../../src/lib/game.ts';
import { ogw, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { commit, fakeBin, gameSettings, git, openBuildRun, setSecrets, setupGame, write } from './helpers.ts';

vi.mock('../../../src/commands/check/static-api.ts', () => ({ staticCheck: vi.fn() }));
vi.mock('../../../src/commands/check/api.ts', async (orig) => ({ ...(await orig<object>()), placeholderFailures: vi.fn() }));
vi.mock('../../../src/commands/contract/api.ts', async (orig) => ({ ...(await orig<object>()), runContract: vi.fn() }));
vi.mock('../../../src/commands/data/api.ts', async (orig) => ({ ...(await orig<object>()), runData: vi.fn() }));
vi.mock('../../../src/commands/generate/api.ts', async (orig) => ({ ...(await orig<object>()), gameModules: vi.fn(), mergedCoreSettings: vi.fn(), moduleFilesWithoutDev: vi.fn() }));
vi.mock('../../../src/commands/core/api.ts', async (orig) => ({ ...(await orig<object>()), coreRelease: vi.fn(), coreReleaseOfGame: vi.fn(), extractedAsset: vi.fn() }));
vi.mock('../../../src/commands/build/lib/platform.ts', () => ({ buildPlatforms: vi.fn(), buildBundle: vi.fn() }));
vi.mock('../../../src/commands/build/lib/web-smoke.ts', async (orig) => {
  const real = await orig<typeof import('../../../src/commands/build/lib/web-smoke.ts')>();
  return { ...real, webSmoke: vi.fn(real.webSmoke) };
});
vi.mock('../../../src/commands/build/lib/device-performance.ts', async (orig) => {
  const real = await orig<typeof import('../../../src/commands/build/lib/device-performance.ts')>();
  return { ...real, devicePerformance: vi.fn(real.devicePerformance) };
});

const DOCKER = `case "$1 $2" in
  "login ghcr.io") cat > /dev/null;;
  "buildx build") case "$*" in *type=tar,dest=*) for a; do case "$a" in type=tar,dest=*) cp "$FAKE_IMAGE_TAR" "\${a#type=tar,dest=}";; esac; done; for last; do :; done; cp "$last/generated/core_settings.json" "$FAKE_DIR/tar_core_settings.json"; cp "$last/generated/server_modules.json" "$FAKE_DIR/tar_server_modules.json"; exit 0;; esac; for last; do :; done; cp "$last/generated/core_settings.json" "$FAKE_DIR/server_core_settings.json"; ls "$last" > "$FAKE_DIR/server_ls"; echo "$last" > "$FAKE_DIR/server_context";;
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
  vi.mocked(staticCheck).mockResolvedValue({ name: 'static check', platform: null, result: 'pass', failures: [], warnings: [] });
  vi.mocked(placeholderFailures).mockResolvedValue([]);
  vi.mocked(runContract).mockResolvedValue({ exitCode: 0, violations: [], stderr: '' });
  vi.mocked(gameModules).mockResolvedValue({ client: [], server: [] });
  vi.mocked(mergedCoreSettings).mockResolvedValue({ 'admin-api.switchCacheMs': 1000, 'matchmaker.reportMarginMs': 500 });
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
    expect(calls).toContain(`docker buildx build --platform linux/amd64 --file ${join(context, 'core/Dockerfile')} --label ogw.compat_client_data_version= --tag ghcr.io/example/game-server:dev-0.1.0 --push ${context}`);
    expect(JSON.parse(readFileSync(join(fakeDir, 'server_core_settings.json'), 'utf8'))).toEqual({ a: 1, 'environments.DEV.serverUrl': 'd', environments: { DEV: 1 } });
    expect(readFileSync(join(fakeDir, 'server_ls'), 'utf8').split('\n').filter(Boolean)).toEqual(['build', 'core', 'generated']);
    // DEV keeps the prepared modules of `ogw generate`: the DEV module cheat stays
    expect(vi.mocked(moduleFilesWithoutDev)).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, 'server/generated/core_settings.json'), 'utf8'))).toMatchObject({ 'environments.PROD.serverUrl': 'p' });
    expect(vi.mocked(staticCheck).mock.calls[0]?.[2]).toEqual({ debugText: false });
    expect(out.stdout).toContain('check device performance: unknown\n  harness settings testDevices has no android device');
    expect(out.stdout).toContain('server image ghcr.io/example/game-server:dev-0.1.0@sha256:pushed');
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

  it('fails the secret check on a leaking artifact', async () => {
    const ws = makeWorkspace();
    const { dir, env } = prepare(ws);
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
    expect(r.checks.slice(-2)).toEqual([
      { name: 'device performance', result: 'unknown', details: ['the build has no android platform'] },
      { name: 'web smoke', result: 'warn', details: ['no blocker: step 2: softlock'] },
    ]);
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
    expect(readFileSync(join(ws.root, 'fake-bin', 'calls.log'), 'utf8')).toMatch(/docker buildx build --platform linux\/amd64 --file \S+\/core\/Dockerfile --output type=tar,dest=\S+\/image\.tar \S+\/server\n/);
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
