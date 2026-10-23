import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleText, openHeadless } from '../../../../src/commands/build/lib/chromium.ts';
import { buildCheckOf, clientCheckTiming, didNotRun, serveFolder, type ClientCheckInput } from '../../../../src/commands/build/lib/client-check.ts';
import { devicePerformance } from '../../../../src/commands/build/lib/device-performance.ts';
import { webSmoke } from '../../../../src/commands/build/lib/web-smoke.ts';
import { coreReleaseOfGame, extractedAsset } from '../../../../src/commands/core/api.ts';
import { runData } from '../../../../src/commands/data/api.ts';
import { requireEngine, toolProgram } from '../../../../src/commands/env/api.ts';
import { lanAddress, udpReaches } from '../../../../src/commands/env/lib/hostcheck.ts';
import { gameModules } from '../../../../src/commands/generate/api.ts';
import { startInstance, stopInstance, type InstanceInfo } from '../../../../src/commands/instance/api.ts';
import { automationRequest } from '../../../../src/commands/instance/automation.ts';
import { ClientChannel } from '../../../../src/commands/instance/lib/channel.ts';
import { createContext } from '../../../../src/lib/command.ts';
import { makeWorkspace, type TestWorkspace } from '../../../helpers/workspace.ts';
import { commit, fakeBin, gameRepo, gameSettings, setSecrets, setupGame, write } from '../helpers.ts';

vi.mock('../../../../src/commands/core/api.ts', async (orig) => ({ ...(await orig<object>()), coreReleaseOfGame: vi.fn(), extractedAsset: vi.fn() }));
vi.mock('../../../../src/commands/env/api.ts', async (orig) => ({ ...(await orig<object>()), requireEngine: vi.fn(), toolProgram: vi.fn() }));
vi.mock('../../../../src/commands/env/lib/hostcheck.ts', async (orig) => ({ ...(await orig<object>()), udpReaches: vi.fn(), lanAddress: vi.fn() }));
vi.mock('../../../../src/commands/data/api.ts', async (orig) => ({ ...(await orig<object>()), runData: vi.fn() }));
vi.mock('../../../../src/commands/generate/api.ts', async (orig) => ({ ...(await orig<object>()), gameModules: vi.fn() }));
vi.mock('../../../../src/commands/instance/api.ts', () => ({
  startInstance: vi.fn(),
  stopInstance: vi.fn(),
  instanceProcesses: vi.fn(() => Promise.resolve({ server: true, clients: [] })),
  instanceServerLog: vi.fn(() => Promise.resolve('{"level":"info","message":"up"}\n')),
}));
vi.mock('../../../../src/commands/instance/automation.ts', () => ({
  automationRequest: vi.fn(),
  restartClient: async (...args: Parameters<typeof import('../../check/helpers.ts').fakeRestartClient>) => (await import('../../check/helpers.ts')).fakeRestartClient(...args),
}));

const fakes = join(dirname(fileURLToPath(import.meta.url)), '..', 'fakes');
const GOAL = { path: 'telemetry.goal_intervals', op: 'count_gte', value: 1 };
const SCENARIO = { steps: [{ kind: 'input', command: 'tap', args: ['1', '2'], timeoutMs: 3000 }], goal: GOAL };
/** Fake Godot: the check export copies `generated/launch_values.json` to the output file and keeps the preset. */
const GODOT = `case "$*" in
  *--export-*) cp "$3/export_presets.cfg" "$FAKE_DIR/preset.cfg"; [ -f "$3/generated/build_info.json" ] && touch "$FAKE_DIR/build-info"; for last; do :; done; if [ -z "$FAKE_NO_OUTPUT" ]; then cp "$3/generated/launch_values.json" "$last"; case "$last" in *.html) printf 'const CACHE_VERSION = "v1";\n' > "$(dirname "$last")/index.service.worker.js";; esac; fi;;
esac`;
/** Fake adb: the app is the fake client started with the launch values of the installed apk. */
const ADB = (node: string) => `case "$3" in
  install) cp "$5" "$FAKE_DIR/installed.apk";;
  shell) case "$4" in
    monkey) [ -n "$FAKE_APP_EXITS" ] && exit 0; "${node}" "${join(fakes, 'fake-launch.ts')}" "$FAKE_DIR/installed.apk" > /dev/null 2>&1 & echo $! > "$FAKE_DIR/app.pid";;
    pidof) [ -f "$FAKE_DIR/app.pid" ] && kill -0 "$(cat "$FAKE_DIR/app.pid")" 2>/dev/null && cat "$FAKE_DIR/app.pid" || exit 1;;
  esac;;
  uninstall) [ -f "$FAKE_DIR/app.pid" ] && kill "$(cat "$FAKE_DIR/app.pid")"; rm -f "$FAKE_DIR/app.pid";;
esac`;

let channel: ClientChannel | null = null;

interface Setup {
  ws: TestWorkspace;
  dir: string;
  input: ClientCheckInput;
  bin: { env: NodeJS.ProcessEnv; log: string; bin: string };
  config: (value: Record<string, unknown>) => void;
  requests: () => string[];
}

function fakeInstance(platform: string): InstanceInfo {
  const ch = channel as ClientChannel;
  return {
    id: 'i1', game: 'g', root: '', commit: '', platform, serverUrl: 'http://127.0.0.1:4321', adminSecret: 'a', startedAt: 0, fixture: false, clients: [], exited: {}, serverLog: '',
    external: { automationPort: ch.port, automationToken: ch.token, devAccess: 'DEV-ACCESS', devAccount: 'main' },
  };
}

async function setup(patch: Record<string, unknown> = {}, extraEnv: NodeJS.ProcessEnv = {}, harness: Record<string, unknown> = {}): Promise<Setup> {
  const ws = makeWorkspace({ testDevices: [{ platform: 'android', serial: 'emulator-5554' }], ...harness });
  const settings = {
    ...gameSettings(),
    buildPlatforms: ['android', 'web'],
    targetFps: 30,
    loadingTimeLimitMs: 5000,
    androidKeyAlias: 'upload',
    signing: { android: { keystore: 'ks', password: 'pw' } },
    ...patch,
  };
  const dir = setupGame(ws, 'g', settings, { 'client/dev/bot/scenario.json': SCENARIO, 'client/project.godot': '[application]\n\nconfig/name="G"\n', 'resource/app_icon/main.png': 'png', 'client/core/web/service-worker.js': 'const CACHE_VERSION = "___GODOT_VERSION___";\n// ogw\n' });
  commit(dir, 'client');
  setSecrets(ws, { 'ogw/g/signing/ks': Buffer.from('KEYSTORE').toString('base64'), 'ogw/g/signing/pw': 'pw' });
  const bin = fakeBin(ws, { godot: GODOT, adb: ADB(process.execPath), ffmpeg: 'for last; do :; done; printf png > "$last"' });
  const config = join(bin.bin, 'client-config.json');
  writeFileSync(config, '{}');
  const env = { ...ws.env, ...bin.env, FAKE_DIR: bin.bin, FAKE_LOG_DIR: bin.bin, FAKE_GODOT_CONFIG: config, ...extraEnv };
  const ctx = createContext({ cwd: ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
  vi.mocked(requireEngine).mockResolvedValue(join(bin.bin, 'godot'));
  vi.mocked(toolProgram).mockImplementation((_c, tool) => Promise.resolve(tool === 'chromium' ? join(bin.bin, 'chromium') : join(bin.bin, 'ffmpeg')));
  writeFileSync(join(bin.bin, 'chromium'), `#!/bin/sh\nexec "${process.execPath}" "${join(fakes, 'fake-chromium.ts')}" "$@"\n`, { mode: 0o755 });
  const release = join(ws.root, 'release');
  write(release, 'engine.json', { godot: '4.5.1.stable' });
  vi.mocked(coreReleaseOfGame).mockResolvedValue({ version: '1.0.0', dir: release, local: false });
  vi.mocked(extractedAsset).mockResolvedValue(release);
  const game = await gameRepo(ws);
  const input: ClientCheckInput = { ctx, game, env: 'DEV', version: '0.1.0', exportVersion: '0.1.0', settings, platforms: ['android', 'web'] };
  return {
    ws,
    dir,
    input,
    bin,
    config: (value) => {
      writeFileSync(config, JSON.stringify(value));
    },
    requests: () =>
      existsSync(join(bin.bin, 'main.jsonl'))
        ? readFileSync(join(bin.bin, 'main.jsonl'), 'utf8').trim().split('\n').map((l) => {
          const r = JSON.parse(l) as { command: string; args: string[] };
          return [r.command, ...r.args].join(' ');
        })
        : [],
  };
}

function chromiumCalls(s: Setup): Record<string, unknown>[] {
  const path = join(s.bin.bin, 'chromium.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : [];
}

beforeEach(() => {
  clientCheckTiming.pollMs = 20;
  clientCheckTiming.bootLimitMs = 4000;
  vi.mocked(runData).mockResolvedValue({ exitCode: 0, lines: [], stderr: '' });
  vi.mocked(gameModules).mockResolvedValue({ client: [], server: [] });
  vi.mocked(lanAddress).mockReturnValue('192.168.0.9');
  vi.mocked(udpReaches).mockResolvedValue(true);
  vi.mocked(startInstance).mockReset();
  vi.mocked(startInstance).mockImplementation(async (_ctx, options) => {
    channel = new ClientChannel('main');
    await channel.listen();
    return fakeInstance(options.platform ?? '');
  });
  vi.mocked(stopInstance).mockReset();
  vi.mocked(stopInstance).mockImplementation(async () => {
    await channel?.close();
  });
  vi.mocked(automationRequest).mockImplementation(async (_ctx, _id, command, args, _client, options) => {
    const response = await (channel as ClientChannel).request(command, args, options?.timeoutMs ?? 3000);
    return { ...response, framePaths: [] };
  });
});

afterEach(async () => {
  await channel?.close();
  channel = null;
});

describe('build check helpers', () => {
  it('joins console arguments', () => {
    expect(consoleText({ args: [{ value: 'a' }, { value: 2 }, { description: 'Object' }, {}, 3] })).toBe('a 2 Object  ');
    expect(consoleText({})).toBe('');
  });

  it('turns check results into one build check', () => {
    const r = (name: string, result: 'pass' | 'fail' | 'unknown', where = 'step 1') => ({ name, platform: null, result, failures: result === 'pass' ? [] : [{ where, message: 'm', evidence: [] }], warnings: [] });
    expect(buildCheckOf('web smoke', 'STG', [r('no blocker', 'pass'), r('full flow', 'fail')])).toEqual({ name: 'web smoke', result: 'fail', details: ['full flow: step 1: m'] });
    expect(buildCheckOf('web smoke', 'DEV', [r('no blocker', 'unknown'), r('full flow', 'fail')]).result).toBe('warn');
    expect(buildCheckOf('web smoke', 'STG', [r('no blocker', 'unknown'), r('full flow', 'pass')])).toEqual({ name: 'web smoke', result: 'unknown', details: ['no blocker: step 1: m'] });
    expect(buildCheckOf('device performance', 'STG', [r('performance', 'fail', '')])).toEqual({ name: 'device performance', result: 'fail', details: ['m'] });
    expect(buildCheckOf('x', 'STG', [r('a', 'pass')])).toEqual({ name: 'x', result: 'pass', details: [] });
    // a check that did not run blocks STG and PROD, and warns in DEV
    expect(didNotRun('web smoke', 'STG', new Error('boom'))).toEqual({ name: 'web smoke', result: 'fail', details: ['web smoke did not run: boom'] });
    expect(didNotRun('web smoke', 'DEV', new Error('boom')).result).toBe('warn');
    expect(didNotRun('web smoke', 'STG', 'text').details).toEqual(['web smoke did not run: text']);
    expect(() => didNotRun('web smoke', 'STG', new Error('not defined: x'))).toThrow('not defined: x');
  });

  it('serves a folder on loopback with content types and nothing outside it', async () => {
    const s = await setup();
    write(s.ws.root, 'site/index.html', '<html>');
    write(s.ws.root, 'site/g.wasm', 'wasm');
    write(s.ws.root, 'secret.txt', 'no');
    const host = await serveFolder(join(s.ws.root, 'site'));
    const get = (path: string, method = 'GET') =>
      new Promise<{ status: number; type: string | undefined; body: string }>((resolve, reject) => {
        const req = request(`${host.url}${path}`, { method }, (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body });
          });
        });
        req.on('error', reject);
        req.end();
      });
    expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/);
    expect(await get('/index.html?x=1')).toEqual({ status: 200, type: 'text/html; charset=utf-8', body: '<html>' });
    expect(await get('/')).toMatchObject({ status: 200, body: '<html>' });
    expect(await get('/g.wasm')).toMatchObject({ status: 200, type: 'application/wasm' });
    expect((await get('/../secret.txt')).status).toBe(404);
    expect((await get('/%2e%2e/secret.txt')).status).toBe(404);
    expect((await get('/none.js')).status).toBe(404);
    expect((await get('/index.html', 'POST')).status).toBe(404);
    await host.close();
  });

  it('opens a page with a CPU throttle; fails when the browser ends, does not start, or refuses the throttle or the page', async () => {
    const s = await setup({}, { FAKE_CHROMIUM_CONSOLE: '[]' });
    const host = await serveFolder(s.ws.root);
    write(s.ws.root, 'index.html', '{}');
    const page = await openHeadless(s.input.ctx, join(s.bin.bin, 'chromium'), `${host.url}/index.html`, 6);
    expect(page.ended()).toBeNull();
    expect(page.openedAt).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(page.console).toEqual(['boot 1 Object  ']);
    const calls = chromiumCalls(s);
    expect((calls[0]?.argv as string[]).filter((a) => !a.startsWith('--user-data-dir='))).toEqual([
      '--headless', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', 'about:blank',
    ]);
    expect(calls.filter((c) => typeof c.method === 'string').map((c) => [c.method, c.sessionId ?? null])).toEqual([
      ['Target.createTarget', null], ['Target.attachToTarget', null], ['Runtime.enable', 'S1'], ['Page.enable', 'S1'], ['Emulation.setCPUThrottlingRate', 'S1'], ['Page.navigate', 'S1'],
    ]);
    expect(calls.find((c) => c.method === 'Emulation.setCPUThrottlingRate')?.params).toEqual({ rate: 6 });
    expect(calls.find((c) => c.method === 'Target.attachToTarget')?.params).toEqual({ targetId: 'T1', flatten: true });
    expect(calls.find((c) => c.page !== undefined)).toMatchObject({ status: 200, type: 'text/html; charset=utf-8', root: 200, post: 404 });
    const profile = ((calls[0]?.argv as string[]).find((a) => a.startsWith('--user-data-dir=')) ?? '').slice('--user-data-dir='.length);
    await page.close();
    expect(page.ended()).toBe('closed');
    expect(existsSync(profile)).toBe(false);
    s.input.ctx.env.FAKE_CHROMIUM_EXIT = '3';
    await expect(openHeadless(s.input.ctx, join(s.bin.bin, 'chromium'), `${host.url}/index.html`, 1)).rejects.toThrow('headless browser ended with 3');
    delete s.input.ctx.env.FAKE_CHROMIUM_EXIT;
    await expect(openHeadless(s.input.ctx, join(s.ws.root, 'no-chromium'), `${host.url}/index.html`, 1)).rejects.toThrow('headless browser did not start');
    s.input.ctx.env.FAKE_CHROMIUM_THROTTLE_ERROR = '1';
    await expect(openHeadless(s.input.ctx, join(s.bin.bin, 'chromium'), `${host.url}/index.html`, 1)).rejects.toThrow('DevTools: no throttle');
    delete s.input.ctx.env.FAKE_CHROMIUM_THROTTLE_ERROR;
    s.input.ctx.env.FAKE_CHROMIUM_NAV_ERROR = '1';
    await expect(openHeadless(s.input.ctx, join(s.bin.bin, 'chromium'), `${host.url}/index.html`, 1)).rejects.toThrow('did not open: net::ERR_CONNECTION_REFUSED');
    await host.close();
  });

  it('marks a crashed page', async () => {
    const s = await setup({}, { FAKE_CHROMIUM_CRASH: '1' });
    const host = await serveFolder(s.ws.root);
    write(s.ws.root, 'index.html', '{}');
    const page = await openHeadless(s.input.ctx, join(s.bin.bin, 'chromium'), `${host.url}/index.html`, 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(page.ended()).toBe('browser page crashed');
    await page.close();
    await host.close();
  });
});

describe('web smoke', () => {
  it('passes: DEV web export with launch values, headless browser with the throttle, bot playtest, first loading ms', async () => {
    const s = await setup();
    s.config({ telemetry: { goal_intervals: [{}], scene_loads: [] } });
    const result = await webSmoke(s.input);
    expect(result?.check).toEqual({ name: 'web smoke', result: 'pass', details: [] });
    expect(result?.loadingMs).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(startInstance).mock.calls[0]?.[1]).toEqual({ game: 'g', client: 'none', externalClient: true, platform: 'web' });
    expect(vi.mocked(stopInstance)).toHaveBeenCalledWith(s.input.ctx, 'i1');
    const values = JSON.parse(readFileSync(join(s.bin.bin, 'page-launch-values.json'), 'utf8')) as Record<string, string>;
    expect(values).toEqual({
      OGW_SERVER_URL: 'http://127.0.0.1:4321', OGW_INSTANCE_ID: 'i1', OGW_AUTOMATION_PORT: String(channel?.port), OGW_AUTOMATION_TOKEN: channel?.token,
      OGW_PLATFORM: 'web', OGW_DEV_ACCESS: 'DEV-ACCESS', OGW_DEV_ACCOUNT: 'main',
    });
    expect(chromiumCalls(s).find((c) => c.method === 'Emulation.setCPUThrottlingRate')?.params).toEqual({ rate: 4 });
    const preset = readFileSync(join(s.bin.bin, 'preset.cfg'), 'utf8');
    expect(preset).toContain('name="web-dev"\nplatform="Web"\n');
    expect(preset).toContain('exclude_filter="tests/*,addons/gut/*"\n');
    expect(existsSync(join(s.bin.bin, 'build-info'))).toBe(false);
    expect(readFileSync(s.bin.log, 'utf8')).toMatch(/godot --headless --path \S+\/client --export-debug web-dev \S+\/\.ogw-check\/web\/index\.html\n/);
    expect(s.requests()).toContain('tap 1 2');
    expect(readFileSync(join(s.dir, 'builds/dev-0.1.0/web-smoke/console.log'), 'utf8')).toBe('boot 1 Object  \n');
    expect(readdirSync(join(s.ws.worktrees, 'g'))).toEqual([]);
  });

  it('fails on an error line in the browser console; warns in DEV', async () => {
    const s = await setup({}, { FAKE_CHROMIUM_CONSOLE: JSON.stringify(['1\terror\tnet\tconnection lost\t']) });
    s.config({ telemetry: { goal_intervals: [{}] } });
    const dev = await webSmoke(s.input);
    expect(dev?.check.result).toBe('warn');
    expect(dev?.check.details).toEqual(['no blocker: boot: client main error log: 1\terror\tnet\tconnection lost\t', 'full flow: boot: the scenario did not start']);
    expect(dev?.loadingMs).toBeNull();
    const stg = await webSmoke({ ...s.input, env: 'STG' });
    expect(stg?.check.result).toBe('fail');
  });

  it('fails when the boot halts, the page crashes, or the scenario misses the goal', async () => {
    const s = await setup();
    s.config({ clients: { main: { state: { boot_stage: 'Halted' } } } });
    expect((await webSmoke(s.input))?.check.details[0]).toBe('no blocker: boot: boot_stage is Halted');
    s.config({ telemetry: { goal_intervals: [] } });
    const missed = await webSmoke({ ...s.input, env: 'STG' });
    expect(missed?.check).toEqual({ name: 'web smoke', result: 'fail', details: ['full flow: step 1: goal is not true after the last step'] });
    expect(missed?.loadingMs).not.toBeNull();
    const crash = await setup({}, { FAKE_CHROMIUM_CRASH: '1' });
    crash.config({ clients: { main: { bootStages: ['Loading', 'Loading', 'Loading', 'Loading', 'Loading', 'Loading', 'Loading', 'Loading', 'Loading', 'Loading'] } } });
    const crashed = await webSmoke({ ...crash.input, env: 'STG' });
    expect(crashed?.check.details[0]).toBe('no blocker: boot: client process main ended: browser page crashed');
  });

  it('fails as not run to the end (DEV warns) when the scenario stops without a blocker', async () => {
    const s = await setup();
    // an auto step whose bot function answers no input command stops the run with no blocker
    writeFileSync(join(s.dir, 'client/dev/bot/scenario.json'), JSON.stringify({ steps: [{ kind: 'auto', command: 'f.bot_next_input', timeoutMs: 3000, until: GOAL }], goal: GOAL }));
    s.config({ clients: { main: { results: { 'f.bot_next_input': { ok: true, result: 5 } } } }, telemetry: { goal_intervals: [] } });
    const stg = await webSmoke({ ...s.input, env: 'STG' });
    expect(stg?.check.result).toBe('fail');
    expect(stg?.check.details).toEqual([
      'web smoke did not run to the end: no blocker: step 1: f.bot_next_input returned no input command: 5',
      'web smoke did not run to the end: full flow: step 1: f.bot_next_input returned no input command: 5',
    ]);
    expect((await webSmoke(s.input))?.check.result).toBe('warn');
  });

  it('fails when the client does not boot within webSmokeBootTimeoutMs; is unknown when Chromium is missing or the instance does not start', async () => {
    const s = await setup({}, {}, { webSmokeBootTimeoutMs: 300 });
    s.config({ clients: { main: { exitOnStart: 0 } } });
    const timeout = await webSmoke({ ...s.input, env: 'STG' });
    expect(timeout?.check).toEqual({
      name: 'web smoke', result: 'fail',
      details: ['no blocker: boot: the client did not reach boot_stage Done within 300 ms', 'full flow: boot: the scenario did not start'],
    });
    expect(timeout?.loadingMs).toBeNull();
    expect((await webSmoke({ ...s.input, env: 'DEV' }))?.check.result).toBe('warn');
    vi.mocked(toolProgram).mockResolvedValue(null);
    expect(await webSmoke({ ...s.input, env: 'STG' })).toEqual({ check: { name: 'web smoke', result: 'fail', details: ['web smoke did not run: harness settings tools.chromium is not on this host'] }, loadingMs: null });
    vi.mocked(toolProgram).mockResolvedValue('chromium');
    vi.mocked(startInstance).mockRejectedValueOnce(new Error('no instance slot'));
    expect((await webSmoke(s.input))?.check).toEqual({ name: 'web smoke', result: 'warn', details: ['web smoke did not run: no instance slot'] });
    vi.mocked(startInstance).mockRejectedValueOnce(new Error('not defined: how the runner starts the server process'));
    await expect(webSmoke(s.input)).rejects.toThrow('not defined: how the runner starts the server process');
    await expect(webSmoke({ ...s.input, settings: { ...s.input.settings, engine: 'unity' } })).rejects.toThrow('not defined: the check export of engine unity');
    expect(vi.mocked(stopInstance)).toHaveBeenCalledTimes(3);
  });

  it('is skipped without web, and fails without a scenario or when the export makes no output', async () => {
    const s = await setup({}, { FAKE_NO_OUTPUT: '1' });
    expect(await webSmoke({ ...s.input, platforms: ['android'] })).toBeNull();
    const out = await webSmoke({ ...s.input, env: 'STG' });
    expect(out?.check).toEqual({ name: 'web smoke', result: 'fail', details: ['web smoke did not run: export of web made no index.html'] });
    const { rmSync } = await import('node:fs');
    rmSync(join(s.dir, 'client/dev/bot/scenario.json'));
    const missing = await webSmoke({ ...s.input, env: 'STG' });
    expect(missing?.check).toEqual({
      name: 'web smoke', result: 'fail',
      details: ['no blocker: client/dev/bot/scenario.json:1: client/dev/bot/scenario.json does not exist', 'full flow: client/dev/bot/scenario.json:1: client/dev/bot/scenario.json does not exist'],
    });
  });
});

describe('device performance', () => {
  it('is unknown without android or without a test device, and fails without a scenario', async () => {
    const s = await setup();
    expect(await devicePerformance({ ...s.input, platforms: ['web'] })).toEqual({ name: 'device performance', result: 'unknown', details: ['the build has no android platform'] });
    const none = createContext({ cwd: s.ws.root, env: { ...s.input.ctx.env }, stdin: () => Promise.resolve(''), stderr: () => undefined });
    vi.spyOn(none, 'settings').mockResolvedValue({ ...(await s.input.ctx.settings()), testDevices: [] });
    expect(await devicePerformance({ ...s.input, ctx: none })).toEqual({ name: 'device performance', result: 'unknown', details: ['harness settings testDevices has no android device'] });
    await expect(devicePerformance({ ...s.input, settings: { ...s.input.settings, appId: '' } })).rejects.toThrow('game settings appId is not set');
    const { rmSync } = await import('node:fs');
    rmSync(join(s.dir, 'client/dev/bot/scenario.json'));
    expect(await devicePerformance({ ...s.input, env: 'STG' })).toEqual({ name: 'device performance', result: 'fail', details: ['client/dev/bot/scenario.json:1: client/dev/bot/scenario.json does not exist'] });
    expect(startInstance).not.toHaveBeenCalled();
  });

  it('passes: apk with launch values, adb install and reverse, launch, fps per scene, uninstall', async () => {
    const s = await setup();
    vi.mocked(gameModules).mockResolvedValue({ client: ['RealtimeCore', 'QualityCore'], server: [] });
    s.config({ clients: { main: { state: { scene_key: 'battle' }, results: { get_stats: { ok: true, result: { fps: 60 } } } } }, telemetry: { goal_intervals: [{}], scene_loads: [{ scene_key: 'battle', duration_ms: 100 }] } });
    const check = await devicePerformance(s.input);
    expect(check).toEqual({ name: 'device performance', result: 'pass', details: [] });
    expect(vi.mocked(udpReaches).mock.calls[0]?.slice(1)).toEqual(['emulator-5554', '192.168.0.9']);
    expect(vi.mocked(startInstance).mock.calls[0]?.[1]).toEqual({ game: 'g', client: 'none', externalClient: true, platform: 'android' });
    const values = JSON.parse(readFileSync(join(s.bin.bin, 'installed.apk'), 'utf8')) as Record<string, string>;
    expect(values).toMatchObject({ OGW_SERVER_URL: 'http://127.0.0.1:4321', OGW_PLATFORM: 'android', OGW_DEV_ACCESS: 'DEV-ACCESS', OGW_DEV_ACCOUNT: 'main', OGW_INSTANCE_ID: 'i1' });
    const port = values.OGW_AUTOMATION_PORT ?? '';
    const adb = readFileSync(s.bin.log, 'utf8').split('\n').filter((l) => l.startsWith('adb '));
    expect(adb[0]).toMatch(/^adb -s emulator-5554 install -r \S+\/\.ogw-check\/android\/g\.apk$/);
    expect(adb.slice(1, 4)).toEqual([
      'adb -s emulator-5554 reverse tcp:4321 tcp:4321',
      `adb -s emulator-5554 reverse tcp:${port} tcp:${port}`,
      'adb -s emulator-5554 shell monkey -p com.example.game -c android.intent.category.LAUNCHER 1',
    ]);
    expect(adb).toContain('adb -s emulator-5554 shell pidof com.example.game');
    expect(adb.slice(-3)).toEqual(['adb -s emulator-5554 uninstall com.example.game', 'adb -s emulator-5554 reverse --remove tcp:4321', `adb -s emulator-5554 reverse --remove tcp:${port}`]);
    expect(readFileSync(join(s.bin.bin, 'preset.cfg'), 'utf8')).toContain('name="android-dev"\nplatform="Android"\n');
    expect(s.requests().slice(0, 2)).toEqual(['get_state', 'extract_logs']);
    expect(s.requests()).toContain('get_stats');
    expect(s.requests()).toContain('set_quality_level High');
    expect(JSON.parse(readFileSync(join(s.dir, 'builds/dev-0.1.0/device-performance/samples.json'), 'utf8'))).toEqual({
      device: 'emulator-5554', samples: { battle: [60] }, scene_loads: [{ scene_key: 'battle', duration_ms: 100 }],
    });
    expect(vi.mocked(stopInstance)).toHaveBeenCalledTimes(1);
  });

  it('fails below targetFps (DEV warns), and fails as not run to the end (DEV warns) when the scenario stops or set_quality_level fails', async () => {
    const s = await setup();
    s.config({ clients: { main: { state: { scene_key: 'lobby' }, results: { get_stats: { ok: true, result: { fps: 20 } } } } }, telemetry: { goal_intervals: [{}], scene_loads: [] } });
    expect(await devicePerformance(s.input)).toEqual({
      name: 'device performance', result: 'warn',
      details: ['lobby: fps 5 percentile 20 is below targetFps 30 (1 samples)'],
    });
    expect((await devicePerformance({ ...s.input, env: 'STG' })).result).toBe('fail');
    s.config({ clients: { main: { fail: { tap: 'no tap' } } } });
    expect(await devicePerformance({ ...s.input, env: 'STG' })).toEqual({ name: 'device performance', result: 'fail', details: ['device performance did not run to the end: step 1: scenario stopped: tap returned ok false: "no tap"'] });
    expect((await devicePerformance(s.input)).result).toBe('warn');
    vi.mocked(gameModules).mockResolvedValue({ client: ['QualityCore'], server: [] });
    s.config({ clients: { main: { fail: { set_quality_level: 'no' } } } });
    expect(await devicePerformance({ ...s.input, env: 'STG' })).toEqual({ name: 'device performance', result: 'fail', details: ['device performance did not run to the end: set_quality_level High failed: "no"'] });
  });

  it('is unknown when UDP does not reach the host, the app ends, or the client logs an error', async () => {
    const s = await setup();
    vi.mocked(gameModules).mockResolvedValue({ client: ['RealtimeCore'], server: [] });
    vi.mocked(udpReaches).mockResolvedValue(false);
    expect(await devicePerformance(s.input)).toEqual({ name: 'device performance', result: 'unknown', details: ['UDP from test device emulator-5554 does not reach this host'] });
    vi.mocked(lanAddress).mockReturnValue(null);
    expect((await devicePerformance(s.input)).details).toEqual(['UDP from test device emulator-5554 does not reach this host']);
    vi.mocked(lanAddress).mockReturnValue('192.168.0.2');
    vi.mocked(udpReaches).mockResolvedValue(null);
    expect(await devicePerformance({ ...s.input, env: 'STG' })).toEqual({ name: 'device performance', result: 'fail', details: ['device performance did not run: the UDP check from test device emulator-5554 could not run'] });
    expect((await devicePerformance(s.input)).result).toBe('warn');
    vi.mocked(lanAddress).mockReturnValue(null);
    expect(existsSync(join(s.bin.bin, 'preset.cfg'))).toBe(false);
    expect(vi.mocked(stopInstance)).toHaveBeenCalledTimes(4);
    vi.mocked(gameModules).mockResolvedValue({ client: [], server: [] });
    s.input.ctx.env.FAKE_APP_EXITS = '1';
    // an app that does not boot on the device is a blocker: it fails STG and PROD, and warns in DEV
    expect(await devicePerformance({ ...s.input, env: 'STG' })).toEqual({ name: 'device performance', result: 'fail', details: ['boot: client process main ended'] });
    expect((await devicePerformance(s.input)).result).toBe('warn');
    delete s.input.ctx.env.FAKE_APP_EXITS;
    s.config({ logs: [{ path: 'log/log_1.txt', content: '1\terror\tsave\tdisk full\t\n' }] });
    expect((await devicePerformance(s.input)).details).toEqual(['boot: client main error log: 1\terror\tsave\tdisk full\t']);
    // a client log that cannot be read is not a log without error lines
    s.config({ clients: { main: { fail: { extract_logs: 'no logs' } } } });
    const unreadable = await devicePerformance({ ...s.input, env: 'STG' });
    expect(unreadable.result).toBe('fail');
    expect(unreadable.details[0]).toMatch(/^device performance did not run: client main log could not be read/);
    s.config({});
    vi.mocked(startInstance).mockRejectedValueOnce(new Error('no slot'));
    expect((await devicePerformance(s.input)).details).toEqual(['device performance did not run: no slot']);
  });
});
