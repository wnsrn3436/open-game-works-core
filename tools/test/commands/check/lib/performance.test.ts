import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { automationRequest } from '../../../../src/commands/instance/automation.ts';
import { listInstances, startInstance, stopInstance } from '../../../../src/commands/instance/api.ts';
import { instanceProcesses, instanceServerLog } from '../../../../src/commands/check/lib/instance-probe.ts';
import { HostLoadSampler, hostProbe, type HostProbe } from '../../../../src/commands/check/lib/host-load.ts';
import { Slots } from '../../../../src/commands/check/lib/instances.ts';
import { hostRefreshHz } from '../../../../src/lib/display.ts';
import { fpsBound, fpsHolds, fpsSampling, frameLimitFps, keptSamples, percentile5Sample, performanceCheck, performanceChecks, platformProfiles, type FpsTick, type PerformanceOptions } from '../../../../src/commands/check/lib/performance.ts';
import { performanceLeaseBase, withGenerationLease } from '../../../../src/commands/generation/lib/lease.ts';
import type { Context } from '../../../../src/lib/command.ts';
import { hostBootId, pidNamespace } from '../../../../src/lib/proc.ts';
import { withWriter, type RwLock } from '../../../../src/lib/rwlock.ts';
import type { CheckResult } from '../../../../src/commands/check/api.ts';
import type { Scenario } from '../../../../src/commands/check/lib/scenario.ts';
import { doneState, fakeContext, notOk, ok } from '../helpers.ts';

vi.mock('../../../../src/commands/instance/automation.ts', () => ({
  automationRequest: vi.fn(),
  restartClient: async (...args: Parameters<typeof import('../helpers.ts').fakeRestartClient>) => (await import('../helpers.ts')).fakeRestartClient(...args),
}));
vi.mock('../../../../src/commands/instance/api.ts', () => ({ startInstance: vi.fn(), stopInstance: vi.fn(), listInstances: vi.fn() }));
vi.mock('../../../../src/commands/check/lib/instance-probe.ts', () => ({ instanceProcesses: vi.fn(), instanceServerLog: vi.fn() }));
vi.mock('../../../../src/lib/display.ts', () => ({ hostRefreshHz: vi.fn() }));

const ctx = fakeContext();

describe('platformProfiles', () => {
  it('takes the first mobile and the first other platform', () => {
    expect(platformProfiles(['web', 'ios', 'android', 'macos'])).toEqual(['ios', 'web']);
    expect(platformProfiles(['linux'])).toEqual(['linux']);
    expect(platformProfiles(['android'])).toEqual(['android']);
    expect(platformProfiles([])).toEqual([]);
  });
});

/** A settled tick of `scene` with `fps` and bound 59, whose load key is `key`. */
function tick(scene: string, fps: number | null, key = scene, settled = true): FpsTick {
  return { scene, settled, loadKey: key, fps, boundFps: 59 };
}

describe('fps samples and bound', () => {
  it('5 percentile of fps − bound by nearest rank', () => {
    const at = (fps: number[], bound = 59): number | undefined => percentile5Sample(fps.map((f) => ({ fps: f, boundFps: bound })))?.fps;
    expect(at([60])).toBe(60);
    expect(at(Array.from({ length: 20 }, (_, i) => 60 - i))).toBe(41);
    expect(at(Array.from({ length: 21 }, (_, i) => 60 - i))).toBe(41);
    expect(percentile5Sample([])).toBeNull();
    expect(at(Array.from({ length: 61 }, (_, i) => i + 1))).toBe(4);
    expect(percentile5Sample([{ fps: 40, boundFps: 29 }, { fps: 50, boundFps: 59 }])).toEqual({ fps: 50, boundFps: 59 });
  });

  it('the bound is the smallest of targetFps, refresh rate and frame limit, minus 1', () => {
    expect(fpsBound(60, null, null)).toBe(59);
    expect(fpsBound(60, 120, null)).toBe(59);
    expect(fpsBound(120, 60, null)).toBe(59);
    expect(fpsBound(60, 120, 30)).toBe(29);
    const levels = { Low: { frameLimitPermille: 500 }, High: { frameLimitPermille: 1000 }, Tiny: { frameLimitPermille: 1 } };
    expect(frameLimitFps(60, levels, 'Low')).toBe(30);
    expect(frameLimitFps(45, levels, 'Low')).toBe(22);
    expect(frameLimitFps(60, levels, 'Tiny')).toBe(1);
    expect(frameLimitFps(60, levels, 'High')).toBe(60);
    expect(frameLimitFps(60, levels, '')).toBeNull();
    expect(frameLimitFps(60, levels, 'Ultra')).toBeNull();
    expect(frameLimitFps(60, null, 'Low')).toBeNull();
  });

  it('keeps only the ticks that neither have a scene load nor follow one', () => {
    const ticks: FpsTick[] = [
      tick('lobby', 10), // no tick before
      tick('lobby', 11), // the tick before has a scene load
      tick('lobby', 60),
      tick('lobby', null),
      tick('battle', 12), // scene_key changed
      tick('battle', 13),
      tick('battle', 50),
      tick('battle', 14, 'battle', false), // in a transition
      tick('battle', 15),
      tick('battle', 51),
      tick('battle', 16, 'battle reloaded'), // last_scene_load_ms or boot_ms changed
      tick('battle', 17, 'battle reloaded'),
      null, // a request failed
      tick('battle', 18, 'battle reloaded'),
      tick('battle', 19, 'battle reloaded'),
      tick('battle', 52, 'battle reloaded'),
    ];
    const { samples, missed } = keptSamples(ticks);
    expect(Object.fromEntries([...samples].map(([scene, values]) => [scene, values.map((v) => v.fps)]))).toEqual({ lobby: [60], battle: [50, 51, 52] });
    expect([...missed]).toEqual(['lobby']);
  });

  it('holds when a scene is judged and every judged scene keeps its bound', () => {
    const of = (fps: number[]): { fps: number; boundFps: number }[] => fps.map((f) => ({ fps: f, boundFps: 59 }));
    expect(fpsHolds(new Map([['a', of([59, 59])], ['b', of([58, 90])]]))).toBe(false);
    expect(fpsHolds(new Map([['a', of([59, 60])], ['b', of([10])]]))).toBe(true);
    expect(fpsHolds(new Map([['a', of([59])]]))).toBe(false);
    expect(fpsHolds(new Map())).toBe(false);
  });
});

function fixedProbe(cpu: { idle: number; total: number }[], memory: number[], instances: number[]): HostProbe {
  let c = 0;
  let m = 0;
  let n = 0;
  return {
    cpuTimes: () => cpu[Math.min(c++, cpu.length - 1)] ?? { idle: 0, total: 0 },
    memoryPercent: () => memory[Math.min(m++, memory.length - 1)] ?? 0,
    instances: () => Promise.resolve(instances[Math.min(n++, instances.length - 1)] ?? 0),
  };
}

describe('HostLoadSampler', () => {
  it('keeps the maxima of CPU, memory and instance readings', async () => {
    const probe = fixedProbe(
      [{ idle: 0, total: 0 }, { idle: 50, total: 100 }, { idle: 60, total: 200 }, { idle: 60, total: 200 }],
      [40.04, 72.36, 50],
      [2, 5, 3],
    );
    const sampler = new HostLoadSampler(probe, 5);
    await new Promise((resolve) => setTimeout(resolve, 18));
    expect(await sampler.stop()).toEqual({ cpuMaxPercent: 90, memoryMaxPercent: 72.4, instancesMax: 5 });
  });

  it('a failing instance count reads as 0', async () => {
    const probe = { ...fixedProbe([{ idle: 0, total: 0 }], [10], []), instances: () => Promise.reject(new Error('x')) };
    expect(await new HostLoadSampler(probe, 1000).stop()).toEqual({ cpuMaxPercent: 0, memoryMaxPercent: 10, instancesMax: 0 });
  });

  it('hostProbe reads this host and the runner', async () => {
    vi.mocked(listInstances).mockResolvedValue([{}, {}] as Awaited<ReturnType<typeof listInstances>>);
    const probe = hostProbe(ctx);
    const times = probe.cpuTimes();
    expect(times.total).toBeGreaterThan(0);
    expect(times.idle).toBeLessThanOrEqual(times.total);
    expect(probe.memoryPercent()).toBeGreaterThan(0);
    expect(probe.memoryPercent()).toBeLessThanOrEqual(100);
    expect(await probe.instances()).toBe(2);
  });
});

const scenario: Scenario = {
  steps: [
    { kind: 'input', command: 'tap', args: ['1', '1'], until: null, timeoutMs: 2000 },
    { kind: 'setup', command: 'go_to_scene', args: ['battle'], until: null, timeoutMs: 2000 },
    { kind: 'input', command: 'tap', args: ['2', '2'], until: null, timeoutMs: 2000 },
  ],
  goal: { path: 'telemetry.goal_intervals', op: 'count_gte', value: 1 },
};

/** get_stats calls per scene after which an input step of the scenario ends, so the sampler reads enough ticks. */
const TICKS_PER_SCENE = 6;

function fakeGame(fps: Record<string, number>, loads: unknown, overrides: Record<string, unknown> = {}): string[] {
  const calls: string[] = [];
  let scene = 'lobby';
  const read: Record<string, number> = {};
  const waiters: (() => void)[] = [];
  const reply = (command: string, args: string[]): Awaited<ReturnType<typeof automationRequest>> => {
    if (command in overrides) return overrides[command] as Awaited<ReturnType<typeof automationRequest>>;
    if (command === 'go_to_scene') scene = args[0] ?? '';
    if (command === 'get_state') return ok(doneState({ scene_key: scene, in_transition: false }));
    if (command === 'get_stats') {
      read[scene] = (read[scene] ?? 0) + 1;
      for (const wake of waiters.splice(0)) wake();
      return ok(scene in fps ? { fps: fps[scene], quality_level: '', last_scene_load_ms: 5, boot_ms: 7 } : { quality_level: '' });
    }
    if (command === 'get_telemetry') return ok({ goal_intervals: [{}], scene_loads: loads });
    if (command === 'extract_logs') return ok([]);
    return ok(null);
  };
  vi.mocked(automationRequest).mockImplementation(async (_c, _i, command, args) => {
    if (command !== 'get_stats' && command !== 'get_state' && command !== 'get_telemetry') calls.push([command, ...args].join(' '));
    // an input waits until the sampler has read the scene often enough
    if (command === 'tap') {
      const at = scene;
      while ((read[at] ?? 0) < TICKS_PER_SCENE) await new Promise<void>((resolve) => waiters.push(resolve));
    }
    return reply(command, args);
  });
  return calls;
}

function options(root: string, extra: Partial<PerformanceOptions> = {}): PerformanceOptions {
  return {
    evidence: { root, dir: 'ev', relative: true },
    slots: new Slots(1),
    pollMs: 1,
    targetFps: 60,
    loadingTimeLimitMs: 3000,
    quality: true,
    probe: fixedProbe([{ idle: 0, total: 0 }, { idle: 20, total: 100 }], [33], [1]),
    sampleMs: 1000,
    lease: { base: join(root, 'lease'), waitMs: 60_000 },
    ...extra,
  };
}

beforeEach(() => {
  fpsSampling.intervalMs = 0;
  vi.mocked(hostRefreshHz).mockReset().mockResolvedValue(null);
  vi.mocked(startInstance).mockReset().mockResolvedValue({ id: 'p1' } as Awaited<ReturnType<typeof startInstance>>);
  vi.mocked(stopInstance).mockReset().mockResolvedValue();
  vi.mocked(instanceProcesses).mockResolvedValue({ server: true, clients: [{ client: 'main', alive: true }] });
  vi.mocked(instanceServerLog).mockResolvedValue('');
});

describe('performanceCheck', () => {
  it('samples fps per scene alongside the scenario, drops the ticks of scene loads, judges p5 and scene loads, and writes hostLoad', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    const calls = fakeGame({ lobby: 59, battle: 58 }, [
      { at: 1, scene_key: 'lobby', duration_ms: 3000 },
      { at: 2, scene_key: 'battle', duration_ms: 3001 },
    ]);
    const result = await performanceCheck(ctx, 'g', 'android', scenario, options(root));
    expect(startInstance).toHaveBeenCalledWith(ctx, { game: 'g', platform: 'android', client: 'window', db: undefined }, { beforeFailedStop: expect.any(Function) as unknown });
    expect(stopInstance).toHaveBeenCalledWith(ctx, 'p1');
    expect(calls[0]).toBe('set_quality_level High');
    const ev = ['ev/performance-android/samples.json'];
    expect(result).toEqual({
      name: 'performance',
      platform: 'android',
      result: 'fail',
      failures: [
        { where: 'battle', message: expect.stringMatching(/^fps 5 percentile 58 is below the fps bound 59 \(\d+ samples\)$/) as unknown, evidence: ev },
        { where: 'battle', message: 'scene load 3001 ms is over loadingTimeLimitMs 3000', evidence: ev },
      ],
      warnings: [],
      hostLoad: { cpuMaxPercent: 80, memoryMaxPercent: 33, instancesMax: 1 },
    });
    const record = JSON.parse(readFileSync(join(root, 'ev/performance-android/samples.json'), 'utf8')) as { samples: Record<string, { fps: number; boundFps: number }[]> };
    expect(new Set(record.samples.lobby?.map((v) => `${String(v.fps)}/${String(v.boundFps)}`))).toEqual(new Set(['59/59']));
    expect(record.samples.lobby?.length).toBeGreaterThanOrEqual(TICKS_PER_SCENE - 2);
    expect(new Set(record.samples.battle?.map((v) => v.fps))).toEqual(new Set([58]));
  });

  it('passes without QualityCore at the fps bound', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    const calls = fakeGame({ lobby: 59, battle: 61 }, []);
    const result = await performanceCheck(ctx, 'g', 'web', scenario, options(root, { quality: false, db: 'postgresql' }));
    expect(result.result).toBe('pass');
    expect(calls).not.toContain('set_quality_level High');
    expect(startInstance).toHaveBeenCalledWith(ctx, { game: 'g', platform: 'web', client: 'window', db: 'postgresql' }, { beforeFailedStop: expect.any(Function) as unknown });
  });

  it('bounds the fps by the refresh rate of the host display', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    vi.mocked(hostRefreshHz).mockResolvedValue(50);
    fakeGame({ lobby: 49, battle: 49 }, []);
    expect((await performanceCheck(ctx, 'g', 'web', scenario, options(root))).result).toBe('pass');
    fakeGame({ lobby: 49, battle: 48 }, []);
    const slow = await performanceCheck(ctx, 'g', 'web', scenario, options(root));
    expect(slow.failures.map((f) => f.message)).toEqual([expect.stringMatching(/^fps 5 percentile 48 is below the fps bound 49 /) as unknown]);
  });

  it('is unknown when telemetry scene_loads, an fps sample of the run or of a scene is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    const ev = ['ev/performance-web/samples.json'];
    const run = async (): Promise<Pick<CheckResult, 'result' | 'failures'>> => {
      const { result, failures } = await performanceCheck(ctx, 'g', 'web', scenario, options(root));
      return { result, failures };
    };
    fakeGame({ lobby: 60, battle: 60 }, 'not a list');
    expect(await run()).toEqual({ result: 'unknown', failures: [{ where: 'client/dev/bot/scenario.json:1', message: 'telemetry scene_loads is not a list: "not a list"', evidence: ev }] });
    fakeGame({ lobby: 60, battle: 60 }, []);
    const answer = vi.mocked(automationRequest).getMockImplementation() as typeof automationRequest;
    let telemetryCalls = 0;
    // the goal check reads telemetry; the read after the run fails
    vi.mocked(automationRequest).mockImplementation((c, i, command, args) => {
      if (command === 'get_telemetry' && ++telemetryCalls > 1) return Promise.resolve(notOk('no TelemetryCore'));
      return answer(c, i, command, args);
    });
    expect(await run()).toEqual({ result: 'unknown', failures: [{ where: 'client/dev/bot/scenario.json:1', message: 'get_telemetry returned ok false: "no TelemetryCore"', evidence: ev }] });
    fakeGame({ lobby: 60 }, []);
    expect(await run()).toEqual({ result: 'unknown', failures: [{ where: 'battle', message: 'no get_stats fps sample in this scene', evidence: ev }] });
    fakeGame({}, []);
    expect(await run()).toEqual({ result: 'unknown', failures: [{ where: 'client/dev/bot/scenario.json:1', message: 'no get_stats fps sample in the run outside scene loads', evidence: ev }] });
    fakeGame({ lobby: 30 }, 'not a list');
    expect(await run()).toEqual({ result: 'fail', failures: [{ where: 'lobby', message: expect.stringMatching(/^fps 5 percentile 30 is below the fps bound 59 /) as unknown, evidence: ev }] });
  });

  it('is unknown when set_quality_level fails or the scenario stops', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    fakeGame({}, [], { set_quality_level: notOk('no QualityCore') });
    const quality = await performanceCheck(ctx, 'g', 'web', scenario, options(root));
    expect(quality.result).toBe('unknown');
    expect(quality.failures).toEqual([{ where: 'client/dev/bot/scenario.json:1', message: 'set_quality_level High failed: "no QualityCore"', evidence: [] }]);
    expect(quality.hostLoad).toEqual({ cpuMaxPercent: 80, memoryMaxPercent: 33, instancesMax: 1 });
    fakeGame({}, [], { go_to_scene: notOk('no scene') });
    const stopped = await performanceCheck(ctx, 'g', 'web', scenario, options(root));
    expect(stopped.result).toBe('unknown');
    expect(stopped.failures).toEqual([
      { where: 'step 2', message: 'scenario stopped: go_to_scene returned ok false: "no scene"', evidence: ['ev/performance-web/samples.json'] },
    ]);
    expect(stopped.hostLoad).toBeDefined();
  });

  it('fails a stopped run on a scene load over the limit, without judging its partial fps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    fakeGame({ lobby: 10 }, [{ scene_key: 'lobby', duration_ms: 9000 }, { scene_key: 'battle', duration_ms: 100 }], { go_to_scene: notOk('no scene') });
    const stopped = await performanceCheck(ctx, 'g', 'web', scenario, options(root));
    expect(stopped.result).toBe('fail');
    expect(stopped.failures).toEqual([
      { where: 'lobby', message: 'scene load 9000 ms is over loadingTimeLimitMs 3000', evidence: ['ev/performance-web/samples.json'] },
    ]);
  });

  it('puts fps samples and scene loads without a scene key at the scenario file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    fakeGame({ lobby: 10, battle: 10 }, [{ duration_ms: 9000 }], { get_state: ok(doneState({ scene_key: null })) });
    const result = await performanceCheck(ctx, 'g', 'web', scenario, options(root));
    expect(result.failures.map((f) => `${f.where} | ${f.message}`)).toEqual([
      expect.stringMatching(/^client\/dev\/bot\/scenario\.json:1 \| fps 5 percentile 10 is below the fps bound 59 \(\d+ samples\)$/),
      'client/dev/bot/scenario.json:1 | scene load 9000 ms is over loadingTimeLimitMs 3000',
    ]);
  });

  it('is unknown with a host reading when there is no scenario or no instance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    const noScenario = await performanceCheck(ctx, 'g', 'web', 'client/dev/bot/scenario.json does not exist', options(root));
    expect(noScenario).toEqual({
      name: 'performance',
      platform: 'web',
      result: 'unknown',
      failures: [{ where: 'client/dev/bot/scenario.json:1', message: 'performance did not run: client/dev/bot/scenario.json does not exist', evidence: [] }],
      warnings: [],
      hostLoad: { cpuMaxPercent: 80, memoryMaxPercent: 33, instancesMax: 1 },
    });
    expect(startInstance).not.toHaveBeenCalled();
    vi.mocked(startInstance).mockRejectedValue(new Error('instanceWaitTimeoutMs'));
    expect((await performanceCheck(ctx, 'g', 'web', scenario, options(root))).failures[0]?.message).toBe('performance did not run: instanceWaitTimeoutMs');
  });
});

describe('host load of a measurement', () => {
  /** A probe whose CPU reading is `100 − idle` % and whose memory reading is `memory` %. */
  const busyProbe = (idle: number, memory: number): HostProbe => fixedProbe([{ idle: 0, total: 0 }, { idle, total: 100 }], [memory], [1]);
  const where = 'client/dev/bot/scenario.json:1';

  it('makes a fail measured on a busy host unknown, with one failure per value it reached, memory first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    const ev = ['ev/performance-web/samples.json'];
    const slowGame = (): string[] => fakeGame({ lobby: 30, battle: 60 }, [{ scene_key: 'lobby', duration_ms: 9000 }]);
    slowGame();
    expect(await performanceCheck(ctx, 'g', 'web', scenario, options(root, { probe: busyProbe(20, 97.3) }))).toEqual({
      name: 'performance',
      platform: 'web',
      result: 'unknown',
      failures: [{ where, message: 'host memory 97.3%', evidence: ev }],
      warnings: [],
      hostLoad: { cpuMaxPercent: 80, memoryMaxPercent: 97.3, instancesMax: 1 },
    });
    slowGame();
    const both = await performanceCheck(ctx, 'g', 'web', scenario, options(root, { probe: busyProbe(10, 95) }));
    expect(both.result).toBe('unknown');
    expect(both.failures.map((f) => f.message)).toEqual(['host memory 95%', 'host CPU 90%']);
    slowGame();
    const cpu = await performanceCheck(ctx, 'g', 'web', scenario, options(root, { probe: busyProbe(5, 40) }));
    expect(cpu.failures).toEqual([{ where, message: 'host CPU 95%', evidence: ev }]);
    // below both values the fail stays a fail with its own failures
    slowGame();
    const below = await performanceCheck(ctx, 'g', 'web', scenario, options(root, { probe: busyProbe(11, 94.9) }));
    expect(below.result).toBe('fail');
    expect(below.failures.map((f) => f.where)).toEqual(['lobby', 'lobby']);
  });

  it('keeps a pass and an unknown measured on a busy host', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    fakeGame({ lobby: 60, battle: 60 }, []);
    expect((await performanceCheck(ctx, 'g', 'web', scenario, options(root, { probe: busyProbe(0, 99) }))).result).toBe('pass');
    fakeGame({ lobby: 60 }, []);
    const unknown = await performanceCheck(ctx, 'g', 'web', scenario, options(root, { probe: busyProbe(0, 99) }));
    expect(unknown).toMatchObject({ result: 'unknown', failures: [{ where: 'battle', message: 'no get_stats fps sample in this scene' }] });
  });
});

/** An owner file of `pid` as the locks of `ogw` write it. */
function ownerOf(pid: number): string {
  return `${String(pid)}\n${pidNamespace() ?? ''}\n${hostBootId() ?? ''}\n${String(Math.random())}\n`;
}

/** Leaves the lock or entry folder `folder` with the owner file `owner`, as a process that took it does. */
function leave(folder: string, owner: string): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'pid'), owner);
}

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await sleep(10);
}

describe('performanceChecks: the performance lease', () => {
  const busy = (platform: string, message: string): CheckResult => ({
    name: 'performance',
    platform,
    result: 'unknown',
    failures: [{ where: 'client/dev/bot/scenario.json:1', message, evidence: [] }],
    warnings: [],
    hostLoad: { cpuMaxPercent: 80, memoryMaxPercent: 33, instancesMax: 1 },
  });

  /** A context whose workspace root is `root`, for the lease that `generation run` holds. */
  function leaseContext(root: string): Context {
    return { ...ctx, workspace: () => Promise.resolve({ root }) } as unknown as Context;
  }

  async function leaseOf(root: string, waitMs = 60_000): Promise<RwLock> {
    return { base: await performanceLeaseBase(leaseContext(root)), waitMs };
  }

  /** A generation run that holds the lease shared until `end` is called. */
  function generation(root: string, order: string[]): { done: Promise<void>; end: () => void } {
    let resolveRun: () => void = () => undefined;
    const done = withGenerationLease(leaseContext(root), () => new Promise<void>((resolve) => {
      order.push('generation');
      resolveRun = resolve;
    }));
    return {
      done,
      end: () => {
        resolveRun();
      },
    };
  }

  /** Records instance starts and stops in `order`; a stop takes `stopMs`. */
  function trackInstances(order: string[], stopMs = 0): void {
    vi.mocked(startInstance).mockImplementation(() => {
      order.push('start');
      return Promise.resolve({ id: 'p1' } as Awaited<ReturnType<typeof startInstance>>);
    });
    vi.mocked(stopInstance).mockImplementation(async () => {
      await sleep(stopMs);
      order.push('stop');
    });
  }

  it('measures every platform profile under one hold after the running generation ends', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    const order: string[] = [];
    trackInstances(order);
    fakeGame({ lobby: 60, battle: 60 }, []);
    const gen = generation(root, order);
    await until(() => order.includes('generation'));
    const checks = performanceChecks(ctx, 'g', ['android', 'web'], scenario, options(root, { lease: await leaseOf(root) }));
    await sleep(600);
    expect(order).toEqual(['generation']);
    order.push('generation ended');
    gen.end();
    await gen.done;
    const results = await checks;
    expect(results.map((r) => r.platform)).toEqual(['android', 'web']);
    expect(results.flatMap((r) => r.failures).filter((f) => f.message.startsWith('host busy'))).toEqual([]);
    expect(order.slice(0, 2)).toEqual(['generation', 'generation ended']);
    expect(order.slice(2).sort()).toEqual(['start', 'start', 'stop', 'stop']);
  });

  it('keeps a generation that starts while it measures out until the measurement ends', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    const order: string[] = [];
    trackInstances(order, 500);
    fakeGame({ lobby: 60, battle: 60 }, []);
    const checks = performanceChecks(ctx, 'g', ['web'], scenario, options(root, { lease: await leaseOf(root) }));
    await until(() => order.includes('start'));
    const gen = withGenerationLease(leaseContext(root), () => Promise.resolve(order.push('generation')));
    const [results] = await Promise.all([checks, gen]);
    expect(results.map((r) => r.result)).toEqual(['pass']);
    expect(order).toEqual(['start', 'stop', 'generation']);
  });

  it('goes before a generation that starts while it waits for the generation of another process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    const order: string[] = [];
    trackInstances(order);
    fakeGame({ lobby: 60, battle: 60 }, []);
    const lease = await leaseOf(root);
    const other = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const entry = join(`${lease.base}-readers`, 'other');
      leave(entry, ownerOf(other.pid as number));
      const checks = performanceChecks(ctx, 'g', ['web'], scenario, options(root, { lease }));
      await sleep(300);
      const gen = withGenerationLease(leaseContext(root), () => Promise.resolve(order.push('generation')));
      await sleep(600);
      expect(order).toEqual([]);
      // the generation of the other process ends
      rmSync(entry, { recursive: true });
      await Promise.all([checks, gen]);
      expect(order).toEqual(['start', 'stop', 'generation']);
    } finally {
      other.kill('SIGKILL');
    }
  });

  it('is unknown without measuring when a generation holds the lease past the wait, with the host load of the wait', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    const order: string[] = [];
    trackInstances(order);
    const gen = generation(root, order);
    await until(() => order.includes('generation'));
    const results = await performanceChecks(ctx, 'g', ['android', 'web'], scenario, options(root, { lease: await leaseOf(root, 300) }));
    expect(results).toEqual([busy('android', 'host busy: local generation'), busy('web', 'host busy: local generation')]);
    expect(startInstance).not.toHaveBeenCalled();
    // without a scenario nothing is measured, so nothing waits for the lease
    const noScenario = await performanceChecks(ctx, 'g', ['web'], 'client/dev/bot/scenario.json does not exist', options(root, { lease: await leaseOf(root) }));
    expect(noScenario[0]?.failures[0]?.message).toBe('performance did not run: client/dev/bot/scenario.json does not exist');
    gen.end();
    await gen.done;
  });

  it('is unknown without measuring when the measurement of another check holds the lease past the wait', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    trackInstances([]);
    const lease = await leaseOf(root, 300);
    const other = withWriter({ ...lease, waitMs: 60_000 }, () => sleep(1500));
    await sleep(100);
    expect(await performanceChecks(ctx, 'g', ['web'], scenario, options(root, { lease }))).toEqual([busy('web', 'host busy: performance measurement')]);
    expect(startInstance).not.toHaveBeenCalled();
    await other;
  });

  it('does not wait for holders left by a process that is gone, nor does a generation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    const order: string[] = [];
    trackInstances(order);
    fakeGame({ lobby: 60, battle: 60 }, []);
    const lease = await leaseOf(root, 3000);
    const gone = (): string => ownerOf(Number(spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim()));
    for (const folder of [join(`${lease.base}-readers`, 'r'), join(`${lease.base}-writers`, 'w'), lease.base]) leave(folder, gone());
    expect((await performanceChecks(ctx, 'g', ['web'], scenario, options(root, { lease }))).map((r) => r.result)).toEqual(['pass']);
    for (const folder of [join(`${lease.base}-writers`, 'w'), lease.base]) leave(folder, gone());
    const started = Date.now();
    await withGenerationLease(leaseContext(root), () => Promise.resolve(order.push('generation')));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(order).toEqual(['start', 'stop', 'generation']);
  });
});
