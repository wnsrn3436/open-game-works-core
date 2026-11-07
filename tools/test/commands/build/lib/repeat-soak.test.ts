import { constants, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientCheckTiming, type ClientCheckInput } from '../../../../src/commands/build/lib/client-check.ts';
import { godotCheckExport, godotCheckPrepare } from '../../../../src/commands/build/lib/godot.ts';
import { blockerKind, repeatPlan, repeatTest, repeatVerdict, runOf, type RepeatRun } from '../../../../src/commands/build/lib/repeat-test.ts';
import {
  inversionCounts,
  SOAK,
  soakBot,
  soakPlan,
  soakSession,
  soakTest,
  soakTrends,
  soakVerdict,
  soakWindows,
  trendOf,
  type SoakTick,
  type SoakWindow,
} from '../../../../src/commands/build/lib/soak-test.ts';
import type { CheckResult } from '../../../../src/commands/check/api.ts';
import type { FpsTick } from '../../../../src/commands/check/lib/performance.ts';
import { coreReleaseOfGame, extractedAsset } from '../../../../src/commands/core/api.ts';
import { runData } from '../../../../src/commands/data/api.ts';
import { requireEngine, toolProgram } from '../../../../src/commands/env/api.ts';
import { gameModules } from '../../../../src/commands/generate/api.ts';
import { startInstance, stopInstance, type InstanceInfo } from '../../../../src/commands/instance/api.ts';
import { automationRequest } from '../../../../src/commands/instance/automation.ts';
import { ClientChannel } from '../../../../src/commands/instance/lib/channel.ts';
import { createContext } from '../../../../src/lib/command.ts';
import { makeWorkspace, type TestWorkspace } from '../../../helpers/workspace.ts';
import { commit, fakeBin, gameRepo, gameSettings, git, setupGame, write } from '../helpers.ts';

vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return { ...real, cp: vi.fn(real.cp) };
});
vi.mock('../../../../src/commands/core/api.ts', async (orig) => ({ ...(await orig<object>()), coreReleaseOfGame: vi.fn(), extractedAsset: vi.fn() }));
vi.mock('../../../../src/commands/env/api.ts', async (orig) => ({ ...(await orig<object>()), requireEngine: vi.fn(), toolProgram: vi.fn() }));
vi.mock('../../../../src/commands/data/api.ts', async (orig) => ({ ...(await orig<object>()), runData: vi.fn() }));
vi.mock('../../../../src/commands/generate/api.ts', async (orig) => ({ ...(await orig<object>()), gameModules: vi.fn() }));
vi.mock('../../../../src/commands/build/lib/godot.ts', async (orig) => {
  const real = await orig<typeof import('../../../../src/commands/build/lib/godot.ts')>();
  return { ...real, godotCheckExport: vi.fn(real.godotCheckExport), godotCheckPrepare: vi.fn(real.godotCheckPrepare) };
});
vi.mock('../../../../src/commands/instance/api.ts', () => ({
  startInstance: vi.fn(),
  stopInstance: vi.fn(),
  instanceProcesses: vi.fn(() => Promise.resolve({ server: true, clients: [] })),
  instanceServerLog: vi.fn(() => Promise.resolve('{"level":"info","message":"up"}\n')),
}));
/** Set to make the reads of the instance record by the soak session (after the scenario) fail. */
const records = vi.hoisted(() => ({ failInSoak: false }));
vi.mock('../../../../src/commands/instance/lib/records.ts', async (orig) => ({
  ...(await orig<object>()),
  // the instance record of the fake check instance: a checkout without client/generated/core_settings.json (no input gap)
  readRecord: vi.fn((id: string) =>
    records.failInSoak && (new Error().stack ?? '').includes('soakOn')
      ? Promise.reject(new Error('the instance record cannot be read'))
      : Promise.resolve({ id, root: '/nonexistent/ogw-check-instance' })),
}));
vi.mock('../../../../src/commands/instance/automation.ts', () => ({
  automationRequest: vi.fn(),
  restartClient: async (...args: Parameters<typeof import('../../check/helpers.ts').fakeRestartClient>) => (await import('../../check/helpers.ts')).fakeRestartClient(...args),
}));

const fakes = join(dirname(fileURLToPath(import.meta.url)), '..', 'fakes');
const GOAL = { path: 'telemetry.goal_intervals', op: 'count_gte', value: 1 };
const SCENARIO = { steps: [{ kind: 'auto', command: 'f.bot_next_input', args: [], until: GOAL, timeoutMs: 3000 }], goal: GOAL };
/** Fake Godot: the check export copies `generated/launch_values.json` to the output file; the import leaves a marker in `.godot/`. */
const GODOT = `case "$*" in
  *--export-*) for last; do :; done; cp "$3/generated/launch_values.json" "$last"; printf 'const CACHE_VERSION = "v1";\\n' > "$(dirname "$last")/index.service.worker.js";;
  *--import*) mkdir -p "$3/.godot" && touch -t 202001010000 "$3/.godot/imported-once";;
esac`;
const MIB = 1024 * 1024;
const TAP = { ok: true, result: { command: 'tap', args: ['1', '2'] } };
/** 10 s of frames on time at 60 fps per tick. */
const FRAMES_OK = Array<number>(625).fill(16);

/** One channel per instance; the instances that run at a time. */
const channels = new Map<string, ClientChannel>();
let running = 0;
let mostRunning = 0;
let started = 0;
const saved = { repeat: { ...repeatPlan }, soak: { ...soakPlan }, poll: clientCheckTiming.pollMs };

interface Setup {
  ws: TestWorkspace;
  dir: string;
  input: ClientCheckInput;
  bin: string;
  config: (value: Record<string, unknown>) => void;
  requests: () => string[];
}

async function setup(harness: Record<string, unknown> = {}): Promise<Setup> {
  const ws = makeWorkspace({ maxConcurrentInstances: 2, webSmokeCpuThrottleRate: 4, ...harness });
  const settings = { ...gameSettings(), buildPlatforms: ['web'], targetFps: 60 };
  const dir = setupGame(ws, 'g', settings, { 'client/dev/bot/scenario.json': SCENARIO, 'client/project.godot': '[application]\n\nconfig/name="G"\n', 'resource/app_icon/main.png': 'png', 'client/core/web/service-worker.js': 'const CACHE_VERSION = "___GODOT_VERSION___";\n' });
  commit(dir, 'client');
  const bin = fakeBin(ws, { godot: GODOT, ffmpeg: 'for last; do :; done; printf png > "$last"' });
  const config = join(bin.bin, 'client-config.json');
  writeFileSync(config, '{}');
  const env = { ...ws.env, ...bin.env, FAKE_DIR: bin.bin, FAKE_LOG_DIR: bin.bin, FAKE_GODOT_CONFIG: config };
  const ctx = createContext({ cwd: ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
  vi.mocked(requireEngine).mockResolvedValue(join(bin.bin, 'godot'));
  vi.mocked(toolProgram).mockImplementation((_c, tool) => Promise.resolve(tool === 'chromium' ? join(bin.bin, 'chromium') : join(bin.bin, 'ffmpeg')));
  writeFileSync(join(bin.bin, 'chromium'), `#!/bin/sh\nexec "${process.execPath}" "${join(fakes, 'fake-chromium.ts')}" "$@"\n`, { mode: 0o755 });
  const release = join(ws.root, 'release');
  write(release, 'engine.json', { godot: '4.5.1.stable' });
  vi.mocked(coreReleaseOfGame).mockResolvedValue({ version: '1.0.0', dir: release, local: false });
  vi.mocked(extractedAsset).mockResolvedValue(release);
  const game = await gameRepo(ws);
  return {
    ws,
    dir,
    input: { ctx, game, env: 'STG', version: '0.2.0', exportVersion: '0.2.0', settings, platforms: ['web'] },
    bin: bin.bin,
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

beforeEach(() => {
  clientCheckTiming.pollMs = 5;
  channels.clear();
  running = 0;
  mostRunning = 0;
  started = 0;
  // back to the real export and preparation that `vi.fn` wraps
  vi.mocked(godotCheckExport).mockReset();
  vi.mocked(godotCheckPrepare).mockReset();
  vi.mocked(runData).mockResolvedValue({ exitCode: 0, lines: [], stderr: '' });
  vi.mocked(gameModules).mockResolvedValue({ client: [], server: [] });
  vi.mocked(startInstance).mockReset();
  vi.mocked(startInstance).mockImplementation(async (_ctx, options) => {
    started += 1;
    const id = `i${String(started)}`;
    const channel = new ClientChannel('main');
    await channel.listen();
    channels.set(id, channel);
    running += 1;
    mostRunning = Math.max(mostRunning, running);
    const info: InstanceInfo = {
      id, game: 'g', root: '', commit: '', platform: options.platform ?? '', serverUrl: 'http://127.0.0.1:4321', adminSecret: 'a', startedAt: 0, fixture: false, clients: [], exited: {}, serverLog: '',
      external: { automationPort: channel.port, automationToken: channel.token, devAccess: 'DEV-ACCESS', devAccount: 'main' },
    };
    return info;
  });
  vi.mocked(stopInstance).mockReset();
  vi.mocked(stopInstance).mockImplementation(async (_ctx, id) => {
    running -= 1;
    await channels.get(id)?.close();
  });
  vi.mocked(automationRequest).mockImplementation(async (_ctx, id, command, args, _client, options) => {
    const channel = channels.get(id);
    if (channel === undefined) throw new Error(`no instance ${id}`);
    return { ...(await channel.request(command, args, options?.timeoutMs ?? 3000)), framePaths: [] };
  });
});

afterEach(async () => {
  Object.assign(repeatPlan, saved.repeat);
  Object.assign(soakPlan, saved.soak);
  clientCheckTiming.pollMs = saved.poll;
  for (const channel of channels.values()) await channel.close();
});

function result(name: string, value: 'pass' | 'fail' | 'unknown', message = 'm'): CheckResult {
  return { name, platform: null, result: value, failures: value === 'pass' ? [] : [{ where: 'step 2', message, evidence: [] }], warnings: [] };
}

describe('repeat test judgement', () => {
  it('names the kind of a failed run by its first no blocker failure, and a goal missed without a blocker', () => {
    expect(blockerKind('client process main ended: browser page crashed')).toBe('crash');
    expect(blockerKind('client process opponent_1 ended')).toBe('crash');
    expect(blockerKind('server process ended')).toBe('crash');
    expect(blockerKind('softlock {"kind":"NoResponse","elapsed_ms":9000}')).toBe('softlock');
    expect(blockerKind('step did not end within 3000 ms')).toBe('softlock');
    expect(blockerKind('the client did not reach boot_stage Done within 300 ms')).toBe('softlock');
    expect(blockerKind('client main error log: 1\terror\tnet\tlost\t')).toBe('error log');
    expect(blockerKind('server error log: {"level":"error"}')).toBe('error log');
    expect(blockerKind('boot_stage is Halted')).toBe('other');
    expect(blockerKind('invariant failures: f.hp')).toBe('other');
    expect(blockerKind('tap returned ok false: "no"')).toBe('other');
    expect(runOf('STG', [result('no blocker', 'fail', 'softlock {}'), result('full flow', 'fail')])).toEqual({ result: 'fail', kind: 'softlock', line: 'no blocker: step 2: softlock {}' });
    expect(runOf('STG', [result('no blocker', 'pass'), result('full flow', 'fail', 'goal is not true after the last step')])).toEqual({ result: 'fail', kind: 'failed goal', line: 'full flow: step 2: goal is not true after the last step' });
    // a failed save step: no blocker is unknown and full flow fails
    expect(runOf('STG', [result('no blocker', 'unknown'), result('full flow', 'fail')]).kind).toBe('failed goal');
    expect(runOf('STG', [result('no blocker', 'unknown', 'stopped'), result('full flow', 'unknown', 'stopped')])).toEqual({ result: 'unknown', kind: null, line: 'no blocker: step 2: stopped' });
    expect(runOf('STG', [result('no blocker', 'pass'), result('full flow', 'pass')])).toEqual({ result: 'pass', kind: null, line: '' });
  });

  it('fails with one failed run, counting each kind; is unknown with only unknown runs; DEV warns', () => {
    const pass: RepeatRun = { result: 'pass', kind: null, line: '' };
    const runs: RepeatRun[] = [pass, { result: 'fail', kind: 'crash', line: 'no blocker: boot: x' }, pass, { result: 'unknown', kind: null, line: 'did not run: no slot' }, { result: 'fail', kind: 'failed goal', line: 'full flow: step 1: g' }];
    expect(repeatVerdict('STG', runs)).toEqual({
      name: 'repeat test', result: 'fail',
      details: ['2 of 5 runs failed: crash 1, softlock 0, error log 0, failed goal 1, other 0', 'run 2: no blocker: boot: x', 'run 4: did not run: no slot', 'run 5: full flow: step 1: g'],
    });
    expect(repeatVerdict('DEV', runs).result).toBe('warn');
    expect(repeatVerdict('STG', [pass, runs[3] as RepeatRun])).toEqual({
      name: 'repeat test', result: 'unknown', details: ['0 of 2 runs failed: crash 0, softlock 0, error log 0, failed goal 0, other 0', 'run 2: did not run: no slot'],
    });
    expect(repeatVerdict('STG', [pass, pass])).toEqual({ name: 'repeat test', result: 'pass', details: [] });
  });

  it('runs 36 times: no failed run in 36 bounds the failure rate of a run under 8% at 95% confidence', () => {
    expect(saved.repeat.runs).toBe(36);
    expect(0.92 ** saved.repeat.runs).toBeLessThan(0.05);
    expect(0.92 ** (saved.repeat.runs - 1)).toBeGreaterThanOrEqual(0.05);
  });
});

describe('repeat test', () => {
  it('runs each run on its own instance and export, at most maxConcurrentInstances at a time, and keeps the logs of a failed run', async () => {
    const s = await setup();
    repeatPlan.runs = 3;
    // the client of instance i2 reports a softlock: that run fails, the others pass
    s.config({ clients: { main: { results: { 'f.bot_next_input': TAP } } }, telemetry: { goal_intervals: [{}] }, stateByInstance: { i2: { softlock: { kind: 'NoResponse', elapsed_ms: 9000 } } } });
    const check = await repeatTest(s.input);
    // one export per run, each with the launch values of its own instance, into its own folder
    const exports = vi.mocked(godotCheckExport).mock.calls.map((c) => ({ platform: c[2], id: c[5].OGW_INSTANCE_ID, dir: c[4].split('/').at(-1) }));
    expect(exports.map((e) => e.platform)).toEqual(['web', 'web', 'web']);
    expect(new Set(exports.map((e) => e.id))).toEqual(new Set(['i1', 'i2', 'i3']));
    expect(new Set(exports.map((e) => e.dir))).toEqual(new Set(['web-run-1', 'web-run-2', 'web-run-3']));
    // the run whose copy was ready second got instance i2
    const failed = Number(/^web-run-(\d)$/.exec(exports.find((e) => e.id === 'i2')?.dir ?? '')?.[1]);
    expect(check).toEqual({
      name: 'repeat test', result: 'fail',
      details: ['1 of 3 runs failed: crash 0, softlock 1, error log 0, failed goal 0, other 0', `run ${String(failed)}: no blocker: step 1: softlock {"kind":"NoResponse","elapsed_ms":9000}`],
    });
    expect(vi.mocked(startInstance).mock.calls.map((c) => c[1])).toEqual(Array(3).fill({ game: 'g', client: 'none', externalClient: true, platform: 'web' }));
    expect(started).toBe(3);
    expect(mostRunning).toBeLessThanOrEqual(2);
    expect(vi.mocked(stopInstance)).toHaveBeenCalledTimes(3);
    expect(readFileSync(join(s.dir, `builds/stg-0.2.0/repeat-test/run-${String(failed)}/server.log`), 'utf8')).toContain('"up"');
    for (const run of [1, 2, 3].filter((n) => n !== failed)) expect(existsSync(join(s.dir, `builds/stg-0.2.0/repeat-test/run-${String(run)}`))).toBe(false);
    started = 0;
    expect((await repeatTest({ ...s.input, env: 'DEV' }))?.result).toBe('warn');
  });

  it('passes when every run passes; is unknown when a run cannot start; is not run without web or in PROD', async () => {
    const s = await setup();
    repeatPlan.runs = 2;
    s.config({ clients: { main: { results: { 'f.bot_next_input': TAP } } }, telemetry: { goal_intervals: [{}] } });
    expect(await repeatTest(s.input)).toEqual({ name: 'repeat test', result: 'pass', details: [] });
    expect(['run-1', 'run-2'].map((run) => existsSync(join(s.dir, 'builds/stg-0.2.0/repeat-test', run)))).toEqual([false, false]);
    // the run whose copy is ready first starts the first instance
    vi.mocked(startInstance).mockRejectedValueOnce(new Error('no instance slot'));
    const unknown = await repeatTest(s.input);
    expect(unknown).toMatchObject({ name: 'repeat test', result: 'unknown' });
    expect(unknown?.details).toHaveLength(2);
    expect(unknown?.details[0]).toBe('0 of 2 runs failed: crash 0, softlock 0, error log 0, failed goal 0, other 0');
    expect(unknown?.details[1]).toMatch(/^run [12]: did not run: no instance slot$/);
    expect(await repeatTest({ ...s.input, platforms: ['android'] })).toBeNull();
    expect(await repeatTest({ ...s.input, env: 'PROD' })).toBeNull();
    vi.mocked(toolProgram).mockResolvedValue(null);
    expect(await repeatTest(s.input)).toEqual({ name: 'repeat test', result: 'unknown', details: ['repeat test did not run: harness settings tools.chromium is not on this host'] });
  });

  it('runs its check instances and check workspace in the checkout of the input when it is not the game repo checkout (the late checks of a DEV build)', async () => {
    const s = await setup();
    repeatPlan.runs = 1;
    s.config({ clients: { main: { results: { 'f.bot_next_input': TAP } } }, telemetry: { goal_intervals: [{}] } });
    const checkout = join(s.ws.root, 'late-checkout');
    git(s.dir, 'worktree', 'add', '--quiet', '--detach', checkout, 'HEAD');
    // the game repo checkout moves on: the check workspace is made of the HEAD of the given checkout
    write(s.dir, 'notes.txt', 'later');
    commit(s.dir, 'later');
    const real = await vi.importActual<typeof import('../../../../src/commands/build/lib/godot.ts')>('../../../../src/commands/build/lib/godot.ts');
    const heads: string[] = [];
    vi.mocked(godotCheckPrepare).mockImplementation(async (...args) => {
      heads.push(git(args[3], 'rev-parse', 'HEAD'));
      return real.godotCheckPrepare(...args);
    });
    expect(await repeatTest({ ...s.input, checkout })).toEqual({ name: 'repeat test', result: 'pass', details: [] });
    expect(vi.mocked(startInstance).mock.calls[0]?.[1]).toEqual({ game: 'g', client: 'none', externalClient: true, platform: 'web', root: checkout });
    expect(heads).toEqual([git(checkout, 'rev-parse', 'HEAD')]);
    expect(heads[0]).not.toBe(git(s.dir, 'rev-parse', 'HEAD'));
  });

  it('does not run repeat test and soak test while this host has no webSmokeCpuThrottleRate', async () => {
    const s = await setup({ webSmokeCpuThrottleRate: null });
    const reason = 'harness settings webSmokeCpuThrottleRate has no value: update env has not measured it on this host';
    expect(await repeatTest(s.input)).toEqual({ name: 'repeat test', result: 'unknown', details: [`repeat test did not run: ${reason}`] });
    expect(await soakTest(s.input)).toEqual({ name: 'soak test', result: 'unknown', details: [`soak test did not run: ${reason}`] });
    expect(vi.mocked(startInstance)).not.toHaveBeenCalled();
  });

  it('prepares and imports the web check workspace once, then makes the exports of the runs together, each in its own copy', async () => {
    const s = await setup();
    repeatPlan.runs = 3;
    s.config({ clients: { main: { results: { 'f.bot_next_input': TAP } } }, telemetry: { goal_intervals: [{}] } });
    const real = await vi.importActual<typeof import('../../../../src/commands/build/lib/godot.ts')>('../../../../src/commands/build/lib/godot.ts');
    const events: string[] = [];
    vi.mocked(godotCheckPrepare).mockImplementation(async (...args) => {
      events.push('prepare start');
      const prepared = await real.godotCheckPrepare(...args);
      events.push('prepare end');
      return prepared;
    });
    const instanceStart = vi.mocked(startInstance).getMockImplementation();
    vi.mocked(startInstance).mockImplementation(async (...args) => {
      events.push('instance start');
      return (instanceStart as typeof startInstance)(...args);
    });
    vi.mocked(cp).mockClear();
    // each export records its start and end around a delay: an export started beside it starts in that delay
    let exporting = 0;
    let mostExporting = 0;
    const copies: string[] = [];
    vi.mocked(godotCheckExport).mockImplementation(async (...args) => {
      exporting += 1;
      mostExporting = Math.max(mostExporting, exporting);
      copies.push(args[3]);
      // the copy holds the imported workspace with the times of its files, so that the engine imports nothing again
      const marker = 'client/.godot/imported-once';
      expect(statSync(join(args[3], marker)).mtimeMs).toBe(new Date(2020, 0, 1).getTime());
      expect(statSync(join(args[3], marker)).mtimeMs).toBe(statSync(join(args[3], '..', '..', marker)).mtimeMs);
      await new Promise((resolve) => setTimeout(resolve, 50));
      exporting -= 1;
      return real.godotCheckExport(...args);
    });
    const check = await repeatTest(s.input);
    expect(check).toEqual({ name: 'repeat test', result: 'pass', details: [] });
    // one preparation and one import for the three runs, before any check instance starts
    expect(vi.mocked(godotCheckPrepare)).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(s.bin, 'calls.log'), 'utf8').match(/--import/g)).toHaveLength(1);
    expect(events.slice(0, 2)).toEqual(['prepare start', 'prepare end']);
    expect(events.filter((e) => e === 'instance start')).toHaveLength(3);
    // two runs at a time (maxConcurrentInstances 2): their exports overlap
    expect(mostExporting).toBe(2);
    expect(copies.map((c) => c.split('/').slice(-2).join('/')).sort()).toEqual(['.ogw-copy/web-run-1', '.ogw-copy/web-run-2', '.ogw-copy/web-run-3']);
    // each copy holds client/ and resource/, cloned where the file system clones, with the file times and the links as they are
    const copied = vi.mocked(cp).mock.calls.filter((c) => String(c[1]).includes('/.ogw-copy/'));
    expect(copied.map((c) => String(c[1]).split('/').slice(-2).join('/')).sort()).toEqual(['web-run-1/client', 'web-run-1/resource', 'web-run-2/client', 'web-run-2/resource', 'web-run-3/client', 'web-run-3/resource']);
    for (const call of copied) expect(call[2]).toEqual({ recursive: true, mode: constants.COPYFILE_FICLONE, preserveTimestamps: true, verbatimSymlinks: true });
    expect(readdirSync(join(s.ws.worktrees, 'g'))).toEqual([]);
  });
});

function frame(patch: Partial<NonNullable<FpsTick>> = {}): NonNullable<FpsTick> {
  return { scene: 'arena', settled: true, loadKey: 'k', fps: 60, boundFps: 59, intervalsMs: FRAMES_OK, budgetMs: 1000 / 60, ...patch };
}

/** Ticks of a session of `soakPlan.windows` windows; `memory(window, tick in window)` and `frames(window)` give each tick. */
function session(memory: (w: number, k: number) => number | null, frames: (w: number) => Partial<NonNullable<FpsTick>> = () => ({})): SoakTick[] {
  return Array.from({ length: soakPlan.windows * soakPlan.windowTicks }, (_, n) => {
    const w = Math.floor(n / soakPlan.windowTicks);
    return { frame: frame(frames(w)), memoryBytes: memory(w, n % soakPlan.windowTicks) };
  });
}

function windows(memoryFloors: (number | null)[], hitchRatios: (number | null)[]): SoakWindow[] {
  return memoryFloors.map((memoryFloor, i) => ({ window: i + 1, memoryFloor, hitchRatio: hitchRatios[i] ?? null, unknown: [] }));
}

describe('soak test judgement', () => {
  it('has the exact one-sided p of Kendall S: 8 distinct values rise at S 16 and not at S 14', () => {
    expect(inversionCounts(4)).toEqual([1, 3, 5, 6, 5, 3, 1]);
    const eight = inversionCounts(8);
    expect(eight.reduce((a, b) => a + b, 0)).toBe(40320);
    expect(eight.slice(0, 7).reduce((a, b) => a + b, 0)).toBe(1230);
    expect(trendOf([1, 2, 3, 4, 5, 6, 7, 8])).toEqual({ s: 28, p: 1 / 40320, slope: 1 });
    // 6 inversions (S 16): p 1230 / 40320; 7 inversions (S 14): p 2191 / 40320, not below 0.05
    const six = trendOf([4, 3, 2, 1, 5, 6, 7, 8]);
    expect([six.s, six.p]).toEqual([16, 1230 / 40320]);
    expect(six.p).toBeLessThan(SOAK.maxP);
    const seven = trendOf([5, 3, 2, 1, 4, 6, 7, 8]);
    expect([seven.s, seven.p]).toEqual([14, 2191 / 40320]);
    expect(seven.p).toBeGreaterThanOrEqual(SOAK.maxP);
    // flat values have no trend
    expect(trendOf([3, 3, 3, 3, 3, 3, 3, 3])).toMatchObject({ s: 0, slope: 0 });
    expect(trendOf([3, 3, 3, 3, 3, 3, 3, 3]).p).toBeGreaterThan(0.5);
  });

  it('takes the Theil–Sen slope: the median of the pair slopes, not moved by one outlier', () => {
    expect(trendOf([1, 2, 3, 4, 5, 6, 7, 100]).slope).toBe(1);
    // 28 pair slopes: the mean of the 14th and the 15th
    const slopes: number[] = [];
    const v = [0, 0, 0, 0, 1, 1, 1, 1];
    for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) slopes.push(((v[j] ?? 0) - (v[i] ?? 0)) / (j - i));
    slopes.sort((a, b) => a - b);
    expect(trendOf(v).slope).toBe(((slopes[13] ?? 0) + (slopes[14] ?? 0)) / 2);
  });

  it('fails a memory leak whose floor reaches 2048 MiB within 288 windows, and not one a window short', () => {
    const rising = (base: number) => Array.from({ length: 8 }, (_, i) => (base + i) * MIB);
    const flat = Array<number>(8).fill(1);
    // floor of window 8 + 288 slopes of 1 MiB: 1753 + 7 + 288 = 2048 MiB
    expect(soakTrends(windows(rising(1753), flat)).failures).toEqual(['memory floor rises 1.00 MiB per window (p 0.0000) and reaches 2048 MiB 24.0 hours after window 8']);
    expect(soakTrends(windows(rising(1752), flat)).failures).toEqual([]);
    // a rise that is not a trend is no leak, however large
    const shuffled = [5, 3, 2, 1, 4, 6, 7, 8].map((x) => x * 500 * MIB);
    expect(soakTrends(windows(shuffled, flat)).failures).toEqual([]);
    // S 16 is a rise: its slope is the Theil–Sen median, 45.83 MiB per window
    expect(soakTrends(windows([4, 3, 2, 1, 5, 6, 7, 8].map((x) => x * 50 * MIB), flat)).failures).toEqual(['memory floor rises 45.83 MiB per window (p 0.0305) and reaches 2048 MiB 3.0 hours after window 8']);
  });

  it('fails frame degradation when the hitch ratio trend rises at least 10 ms/s from window 1 to window 8', () => {
    const memory = Array<number>(8).fill(100 * MIB);
    expect(soakTrends(windows(memory, [0, 1.5, 3, 4.5, 6, 7.5, 9, 10.5])).failures).toEqual(['hitch ratio rises 10.5 ms/s from window 1 to window 8 (p 0.0000)']);
    expect(soakTrends(windows(memory, [0, 1.25, 2.5, 3.75, 5, 6.25, 7.5, 8.75])).failures).toEqual([]);
    expect(soakTrends(windows(memory, [21, 3, 6, 0, 9, 12, 15, 18])).failures).toEqual([]);
    expect(SOAK.maxHitchRise).toBe(10);
  });

  it('reads the windows after the warm-up: the memory floor, the hitch ratio of kept ticks, and why a value is missing', () => {
    soakPlan.windowTicks = 4;
    // the warm-up window holds the largest values: it is not judged
    const ticks = session((w, k) => (w === 0 ? 4000 * MIB : (100 + k) * MIB));
    const measured = soakWindows(ticks);
    expect(measured.map((w) => w.window)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(measured.map((w) => w.memoryFloor))).toEqual(new Set([100 * MIB]));
    expect(new Set(measured.map((w) => w.hitchRatio))).toEqual(new Set([0]));
    expect(soakVerdict('STG', ticks, null)).toEqual({ name: 'soak test', result: 'pass', details: [] });
    // a hitch of 100 ms in each tick of 10 s of 16 ms frames: (100 − 1000/60) / 10.1 s
    const hitched = soakWindows(session(() => MIB, () => ({ intervalsMs: [...FRAMES_OK, 100] })));
    expect(hitched[0]?.hitchRatio).toBeCloseTo((100 - 1000 / 60) * 4 / (4 * 10.1), 6);
    const missing = session((w) => (w === 3 ? null : MIB), (w) => (w === 5 ? { intervalsMs: null } : w === 6 ? { intervalsMs: [16] } : {}));
    expect(soakVerdict('STG', missing, null)).toEqual({
      name: 'soak test', result: 'unknown',
      details: ['window 3: no static_memory_bytes reading', 'window 5: a kept tick has no frame_intervals_ms array of numbers', 'window 6: kept frame intervals add up to 0.06 s, less than 10 s'],
    });
    // the ticks of a scene load and the tick after it are not kept: their intervals do not count
    const loads = session(() => MIB, (w) => (w === 2 ? { settled: false } : {}));
    expect(soakWindows(loads)[1]?.unknown).toEqual(['kept frame intervals add up to 0.00 s, less than 10 s']);
    expect(soakWindows(loads)[2]?.unknown).toEqual([]);
  });

  it('fails on a blocker (DEV warns), is unknown on a stop without a blocker, and fails a leak over missing frames', () => {
    soakPlan.windowTicks = 4;
    expect(soakVerdict('STG', [], { tick: 12, message: 'softlock {"kind":"Block"}', blocker: true })).toEqual({ name: 'soak test', result: 'fail', details: ['tick 12: softlock {"kind":"Block"}'] });
    expect(soakVerdict('DEV', [], { tick: 12, message: 'softlock', blocker: true }).result).toBe('warn');
    expect(soakVerdict('STG', [], { tick: 3, message: 'get_state failed: closed', blocker: false })).toEqual({ name: 'soak test', result: 'unknown', details: ['tick 3: get_state failed: closed'] });
    const leak = session((w, k) => (1000 + w * 100 + k) * MIB, () => ({ intervalsMs: null }));
    const verdict = soakVerdict('STG', leak, null);
    expect(verdict.result).toBe('fail');
    expect(verdict.details).toEqual([expect.stringMatching(/^memory floor rises 100\.00 MiB per window/)]);
  });

  it('plays with the last auto step of the scenario, or with no bot', () => {
    const step = (kind: 'auto' | 'setup', command: string) => ({ kind, command, args: [command], until: null, timeoutMs: 1 });
    expect(soakBot({ steps: [step('auto', 'a.bot_next_input'), step('setup', 'x'), step('auto', 'b.bot_next_input'), step('setup', 'y')], goal: GOAL as never })).toEqual({ command: 'b.bot_next_input', args: ['b.bot_next_input'] });
    expect(soakBot({ steps: [step('setup', 'x')], goal: GOAL as never })).toBeNull();
  });

  it('lasts 45 minutes of 1000 ms ticks in 9 windows of two cycles of 120 s play and 30 s idle', () => {
    expect(saved.soak).toEqual({ tickMs: 1000, cycleTicks: 150, playTicks: 120, windowTicks: 300, windows: 9 });
    expect(saved.soak.windows * saved.soak.windowTicks * saved.soak.tickMs).toBe(45 * 60_000);
    expect(SOAK.leakWindows * SOAK.windowMinutes).toBe(24 * 60);
    expect(SOAK.memoryLimitBytes).toBe(2048 * MIB);
  });
});

describe('soak test', () => {
  /** Short ticks: 9 windows of 2 cycles of one play tick and one idle tick. */
  function shortPlan(): void {
    Object.assign(soakPlan, { tickMs: 5, cycleTicks: 2, playTicks: 1, windowTicks: 4, windows: 9 });
  }

  it('ends the session at the tick of a state blocker, a page that ended or an error line of the console; without a bot it puts in no input', async () => {
    shortPlan();
    const ctx = createContext({ cwd: makeWorkspace().root, env: {}, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const commands: string[] = [];
    /** Per bot command and input command, the number of `get_state` sent before it. */
    const inputs: number[] = [];
    let gets = 0;
    const answer = (result: unknown) => ({ ok: true, result, bytes: Buffer.alloc(0), frames: [], framePaths: [] });
    /** A client whose `get_state` of tick `softlockAt` reports a softlock. */
    const client = (softlockAt: number) => {
      gets = 0;
      commands.length = 0;
      inputs.length = 0;
      vi.mocked(automationRequest).mockImplementation(async (_c, _id, command) => {
        // counted when it is sent, before the turn of the event loop that a request over the channel takes
        if (command === 'get_state') gets += 1;
        if (command === 'f.bot_next_input' || command === 'tap') inputs.push(gets);
        await new Promise((resolve) => setImmediate(resolve));
        commands.push(command);
        if (command === 'get_state') {
          return answer({ boot_stage: 'Done', invariant_failures: [], softlock: gets - 1 === softlockAt ? { kind: 'Block', reason: 'scene' } : null });
        }
        if (command === 'get_stats') return answer({ static_memory_bytes: MIB, frame_intervals_ms: FRAMES_OK });
        if (command === 'f.bot_next_input') return answer({ command: 'tap', args: ['1', '2'] });
        return answer(null);
      });
    };
    const page = (ended: () => string | null, console: () => string[] = () => []) => ({ get console() {
      return console();
    }, ended, openedAt: 0, evaluate: () => Promise.resolve(undefined), close: () => Promise.resolve() });
    const bound = { targetFps: 60, refreshHz: null, levels: null };
    const bot = { command: 'f.bot_next_input', args: [] };
    client(5);
    const softlock = await soakSession(ctx, 'i1', page(() => null), bot, bound, 0);
    expect(softlock.stop).toEqual({ tick: 5, message: 'softlock {"kind":"Block","reason":"scene"}', blocker: true });
    expect(softlock.ticks).toHaveLength(6);
    expect(commands.filter((c) => c === 'clear_telemetry')).toHaveLength(3);
    expect(commands).toContain('tap');
    client(-1);
    const crashed = await soakSession(ctx, 'i1', page(() => (gets >= 3 ? 'browser page crashed' : null)), bot, bound, 0);
    expect(crashed.stop).toEqual({ tick: 2, message: 'client process main ended: browser page crashed', blocker: true });
    client(-1);
    const logged = await soakSession(ctx, 'i1', page(() => null, () => (gets >= 4 ? ['1\terror\tsave\tdisk full\t'] : [])), bot, bound, 0);
    expect(logged.stop).toEqual({ tick: 3, message: 'client main error log: 1\terror\tsave\tdisk full\t', blocker: true });
    // cycles of one play tick and two idle ticks: between the get_state of tick 3n + 1 and that of tick 3n + 2 both ticks
    // are idle, so no bot command and no input is sent with 3n + 2 get_state sent before it
    Object.assign(soakPlan, { cycleTicks: 3, playTicks: 1 });
    client(-1);
    const cycles = await soakSession(ctx, 'i1', page(() => null), bot, bound, 0);
    expect([cycles.stop, cycles.ticks.length]).toEqual([null, 36]);
    expect(inputs.length).toBeGreaterThanOrEqual(12);
    expect(inputs.filter((n) => n % 3 === 2)).toEqual([]);
    shortPlan();
    client(-1);
    const idle = await soakSession(ctx, 'i1', page(() => null), null, bound, 0);
    expect([idle.stop, idle.ticks.length]).toEqual([null, 36]);
    expect(commands.filter((c) => c === 'f.bot_next_input' || c === 'tap')).toEqual([]);
  });

  it('plays the scenario, then the ticks and cycles, and passes with a flat memory floor and steady frames', async () => {
    const s = await setup();
    shortPlan();
    const stats = { ok: true, result: { static_memory_bytes: 100 * MIB, frame_intervals_ms: FRAMES_OK } };
    s.config({ clients: { main: { results: { 'f.bot_next_input': TAP, get_stats: stats } } }, telemetry: { goal_intervals: [{}] } });
    expect(await soakTest(s.input)).toEqual({ name: 'soak test', result: 'pass', details: [] });
    const requests = s.requests();
    // one get_stats per tick and one clear_telemetry per cycle: 36 ticks, 18 cycles
    expect(requests.filter((r) => r === 'get_stats')).toHaveLength(36);
    expect(requests.filter((r) => r === 'clear_telemetry')).toHaveLength(18);
    // the bot plays in each play phase, after the scenario's own call
    expect(requests.filter((r) => r === 'f.bot_next_input').length).toBeGreaterThanOrEqual(19);
    expect(requests.indexOf('clear_telemetry')).toBeGreaterThan(requests.indexOf('f.bot_next_input'));
    const samples = JSON.parse(readFileSync(join(s.dir, 'builds/stg-0.2.0/soak-test/samples.json'), 'utf8')) as { ticks: number; windows: unknown[]; memory: { s: number } };
    expect([samples.ticks, samples.windows.length, samples.memory.s]).toEqual([36, 8, 0]);
    expect(existsSync(join(s.dir, 'builds/stg-0.2.0/soak-test/console.log'))).toBe(true);
    expect(vi.mocked(stopInstance)).toHaveBeenCalledTimes(1);
  });

  it('is unknown with the reason when the core settings of the instance cannot be read for the session, instead of no quality levels and no input gap', async () => {
    const s = await setup();
    shortPlan();
    s.config({ clients: { main: { results: { 'f.bot_next_input': TAP } } }, telemetry: { goal_intervals: [{}] } });
    records.failInSoak = true;
    try {
      expect(await soakTest(s.input)).toEqual({ name: 'soak test', result: 'unknown', details: ['soak test did not run: the instance record cannot be read'] });
      expect(s.requests()).not.toContain('get_stats');
    } finally {
      records.failInSoak = false;
    }
  });

  it('fails a memory floor that rises tick by tick (DEV warns), and fails at once on a command with ok false', async () => {
    const s = await setup();
    shortPlan();
    const rising = Array.from({ length: 36 }, (_, n) => ({ ok: true, result: { static_memory_bytes: (100 + 2 * n) * MIB, frame_intervals_ms: FRAMES_OK } }));
    s.config({ clients: { main: { results: { 'f.bot_next_input': TAP }, sequences: { get_stats: rising } } }, telemetry: { goal_intervals: [{}] } });
    const check = await soakTest(s.input);
    expect(check?.result).toBe('fail');
    expect(check?.details).toEqual(['memory floor rises 8.00 MiB per window (p 0.0000) and reaches 2048 MiB 19.6 hours after window 8']);
    s.config({ clients: { main: { results: { 'f.bot_next_input': TAP }, sequences: { get_stats: rising } } }, telemetry: { goal_intervals: [{}] } });
    expect((await soakTest({ ...s.input, env: 'DEV' }))?.result).toBe('warn');
    s.config({ clients: { main: { results: { 'f.bot_next_input': TAP }, fail: { get_stats: 'no stats' } } }, telemetry: { goal_intervals: [{}] } });
    expect(await soakTest(s.input)).toEqual({ name: 'soak test', result: 'fail', details: ['tick 0: get_stats returned ok false: "no stats"'] });
  });

  it('is the scenario result when the scenario does not pass, unknown when the bot gives no input command, and not run without web or in PROD', async () => {
    const s = await setup();
    shortPlan();
    s.config({ clients: { main: { fail: { 'f.bot_next_input': 'no bot' } } }, telemetry: { goal_intervals: [{}] } });
    expect(await soakTest(s.input)).toEqual({ name: 'soak test', result: 'fail', details: ['no blocker: step 1: f.bot_next_input returned ok false: "no bot"', 'full flow: step 1: scenario stopped at step 1'] });
    expect(s.requests()).not.toContain('get_stats');
    // the scenario's call gets no input, the soak's first call gets a value that is no input command
    s.config({ clients: { main: { sequences: { 'f.bot_next_input': [{ ok: true, result: null }, { ok: true, result: 5 }] } } }, telemetry: { goal_intervals: [{}] } });
    const stopped = await soakTest(s.input);
    expect(stopped?.result).toBe('unknown');
    expect(stopped?.details).toEqual([expect.stringMatching(/^tick \d+: f\.bot_next_input returned no input command: 5$/)]);
    expect(await soakTest({ ...s.input, platforms: ['android'] })).toBeNull();
    expect(await soakTest({ ...s.input, env: 'PROD' })).toBeNull();
    const { rmSync } = await import('node:fs');
    rmSync(join(s.dir, 'client/dev/bot/scenario.json'));
    expect((await soakTest(s.input))?.details).toEqual([
      'no blocker: client/dev/bot/scenario.json:1: client/dev/bot/scenario.json does not exist', 'full flow: client/dev/bot/scenario.json:1: client/dev/bot/scenario.json does not exist',
    ]);
  });
});
