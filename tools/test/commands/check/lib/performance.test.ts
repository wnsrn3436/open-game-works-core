import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { automationRequest } from '../../../../src/commands/instance/automation.ts';
import { listInstances, startInstance, stopInstance } from '../../../../src/commands/instance/api.ts';
import { instanceProcesses, instanceServerLog } from '../../../../src/commands/check/lib/instance-probe.ts';
import { HostLoadSampler, hostProbe, type HostProbe } from '../../../../src/commands/check/lib/host-load.ts';
import { Slots } from '../../../../src/commands/check/lib/instances.ts';
import { fpsHolds, percentile5, performanceCheck, platformProfiles, type PerformanceOptions } from '../../../../src/commands/check/lib/performance.ts';
import type { CheckResult } from '../../../../src/commands/check/api.ts';
import type { Scenario } from '../../../../src/commands/check/lib/scenario.ts';
import { doneState, fakeAutomation, fakeContext, notOk, ok } from '../helpers.ts';

vi.mock('../../../../src/commands/instance/automation.ts', () => ({
  automationRequest: vi.fn(),
  restartClient: async (...args: Parameters<typeof import('../helpers.ts').fakeRestartClient>) => (await import('../helpers.ts')).fakeRestartClient(...args),
}));
vi.mock('../../../../src/commands/instance/api.ts', () => ({ startInstance: vi.fn(), stopInstance: vi.fn(), listInstances: vi.fn() }));
vi.mock('../../../../src/commands/check/lib/instance-probe.ts', () => ({ instanceProcesses: vi.fn(), instanceServerLog: vi.fn() }));

const ctx = fakeContext();

describe('platformProfiles and percentile5', () => {
  it('takes the first mobile and the first other platform', () => {
    expect(platformProfiles(['web', 'ios', 'android', 'macos'])).toEqual(['ios', 'web']);
    expect(platformProfiles(['linux'])).toEqual(['linux']);
    expect(platformProfiles(['android'])).toEqual(['android']);
    expect(platformProfiles([])).toEqual([]);
  });

  it('5 percentile by nearest rank', () => {
    expect(percentile5([60])).toBe(60);
    expect(percentile5(Array.from({ length: 20 }, (_, i) => 60 - i))).toBe(41);
    expect(percentile5(Array.from({ length: 21 }, (_, i) => 60 - i))).toBe(41);
    expect(percentile5([])).toBe(0);
    expect(percentile5(Array.from({ length: 60 }, (_, i) => i + 1))).toBe(3);
    expect(percentile5(Array.from({ length: 61 }, (_, i) => i + 1))).toBe(4);
    expect(percentile5([5, 1, 3])).toBe(1);
  });

  it('holds when the 5 percentile of every scene reaches targetFps', () => {
    expect(fpsHolds(new Map([['a', [60]], ['b', [59]]]), 60)).toBe(false);
    expect(fpsHolds(new Map([['a', [60]], ['b', [61, 90]]]), 60)).toBe(true);
    expect(fpsHolds(new Map(), 60)).toBe(true);
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

function fakeGame(fps: Record<string, number[]>, loads: unknown, overrides: Record<string, unknown> = {}): string[] {
  const calls: string[] = [];
  let scene = 'lobby';
  const taken: Record<string, number> = {};
  vi.mocked(automationRequest).mockImplementation(fakeAutomation((command, args) => {
    calls.push([command, ...args].join(' '));
    if (command in overrides) return overrides[command] as Awaited<ReturnType<typeof automationRequest>>;
    if (command === 'go_to_scene') scene = args[0] ?? '';
    if (command === 'get_state') return ok(doneState({ scene_key: scene }));
    if (command === 'get_stats') {
      const list = fps[scene] ?? [];
      const i = taken[scene] ?? 0;
      taken[scene] = i + 1;
      return ok(i < list.length ? { fps: list[i] } : {});
    }
    if (command === 'get_telemetry') return ok({ goal_intervals: [{}], scene_loads: loads });
    if (command === 'extract_logs') return ok([]);
    return ok(null);
  }));
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
    probe: fixedProbe([{ idle: 0, total: 0 }, { idle: 10, total: 100 }], [33], [1]),
    sampleMs: 1000,
    ...extra,
  };
}

beforeEach(() => {
  vi.mocked(startInstance).mockReset().mockResolvedValue({ id: 'p1' } as Awaited<ReturnType<typeof startInstance>>);
  vi.mocked(stopInstance).mockReset().mockResolvedValue();
  vi.mocked(instanceProcesses).mockResolvedValue({ server: true, clients: [{ client: 'main', alive: true }] });
  vi.mocked(instanceServerLog).mockResolvedValue('');
});

describe('performanceCheck', () => {
  it('samples fps per scene after each step, judges p5 and scene loads, and writes hostLoad', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    const calls = fakeGame({ lobby: [60], battle: [59, 61] }, [
      { at: 1, scene_key: 'lobby', duration_ms: 3000 },
      { at: 2, scene_key: 'battle', duration_ms: 3001 },
    ]);
    const result = await performanceCheck(ctx, 'g', 'android', scenario, options(root));
    expect(startInstance).toHaveBeenCalledWith(ctx, { game: 'g', platform: 'android', client: 'window', db: undefined }, { beforeFailedStop: expect.any(Function) as unknown });
    expect(stopInstance).toHaveBeenCalledWith(ctx, 'p1');
    expect(calls[0]).toBe('set_quality_level High');
    expect(result).toEqual({
      name: 'performance',
      platform: 'android',
      result: 'fail',
      failures: [
        { where: 'battle', message: 'fps 5 percentile 59 is below targetFps 60 (2 samples)', evidence: ['ev/performance-android/samples.json'] },
        { where: 'battle', message: 'scene load 3001 ms is over loadingTimeLimitMs 3000', evidence: ['ev/performance-android/samples.json'] },
      ],
      warnings: [],
      hostLoad: { cpuMaxPercent: 90, memoryMaxPercent: 33, instancesMax: 1 },
    });
    const record = JSON.parse(readFileSync(join(root, 'ev/performance-android/samples.json'), 'utf8')) as { samples: unknown };
    expect(record.samples).toEqual({ lobby: [60], battle: [59, 61] });
  });

  it('passes without QualityCore and with fast scenes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    const calls = fakeGame({ lobby: [60], battle: [60, 61] }, []);
    const result = await performanceCheck(ctx, 'g', 'web', scenario, options(root, { quality: false, db: 'postgresql' }));
    expect(result.result).toBe('pass');
    expect(calls).not.toContain('set_quality_level High');
    expect(startInstance).toHaveBeenCalledWith(ctx, { game: 'g', platform: 'web', client: 'window', db: 'postgresql' }, { beforeFailedStop: expect.any(Function) as unknown });
  });

  it('is unknown when telemetry scene_loads, an fps sample of the run or of a scene is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    const ev = ['ev/performance-web/samples.json'];
    const run = async (): Promise<Pick<CheckResult, 'result' | 'failures'>> => {
      const { result, failures } = await performanceCheck(ctx, 'g', 'web', scenario, options(root));
      return { result, failures };
    };
    fakeGame({ lobby: [60], battle: [60] }, 'not a list');
    expect(await run()).toEqual({ result: 'unknown', failures: [{ where: 'client/dev/bot/scenario.json:1', message: 'telemetry scene_loads is not a list: "not a list"', evidence: ev }] });
    fakeGame({ lobby: [60], battle: [60] }, []);
    const answer = vi.mocked(automationRequest).getMockImplementation();
    let telemetryCalls = 0;
    vi.mocked(automationRequest).mockImplementation((c, i, command, args) => {
      if (command === 'get_telemetry' && ++telemetryCalls > 1) return Promise.resolve(notOk('no TelemetryCore'));
      return (answer as typeof automationRequest)(c, i, command, args);
    });
    expect(await run()).toEqual({ result: 'unknown', failures: [{ where: 'client/dev/bot/scenario.json:1', message: 'get_telemetry returned ok false: "no TelemetryCore"', evidence: ev }] });
    fakeGame({ lobby: [60] }, []);
    expect(await run()).toEqual({ result: 'unknown', failures: [{ where: 'battle', message: 'no get_stats fps sample in this scene', evidence: ev }] });
    fakeGame({}, []);
    expect(await run()).toEqual({ result: 'unknown', failures: [{ where: 'client/dev/bot/scenario.json:1', message: 'no get_stats fps sample in the run', evidence: ev }] });
    fakeGame({ lobby: [30] }, 'not a list');
    expect(await run()).toEqual({ result: 'fail', failures: [{ where: 'lobby', message: 'fps 5 percentile 30 is below targetFps 60 (1 samples)', evidence: ev }] });
  });

  it('is unknown when set_quality_level fails or the scenario stops', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    fakeGame({}, [], { set_quality_level: notOk('no QualityCore') });
    const quality = await performanceCheck(ctx, 'g', 'web', scenario, options(root));
    expect(quality.result).toBe('unknown');
    expect(quality.failures).toEqual([{ where: 'client/dev/bot/scenario.json:1', message: 'set_quality_level High failed: "no QualityCore"', evidence: [] }]);
    expect(quality.hostLoad).toEqual({ cpuMaxPercent: 90, memoryMaxPercent: 33, instancesMax: 1 });
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
    fakeGame({ lobby: [10] }, [{ scene_key: 'lobby', duration_ms: 9000 }, { scene_key: 'battle', duration_ms: 100 }], { go_to_scene: notOk('no scene') });
    const stopped = await performanceCheck(ctx, 'g', 'web', scenario, options(root));
    expect(stopped.result).toBe('fail');
    expect(stopped.failures).toEqual([
      { where: 'lobby', message: 'scene load 9000 ms is over loadingTimeLimitMs 3000', evidence: ['ev/performance-web/samples.json'] },
    ]);
  });

  it('puts fps samples and scene loads without a scene key at the scenario file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-perf-'));
    fakeGame({ lobby: [10], battle: [10, 10] }, [{ duration_ms: 9000 }], { get_state: ok(doneState({ scene_key: null })) });
    const result = await performanceCheck(ctx, 'g', 'web', scenario, options(root));
    expect(result.failures.map((f) => `${f.where} | ${f.message}`)).toEqual([
      'client/dev/bot/scenario.json:1 | fps 5 percentile 10 is below targetFps 60 (3 samples)',
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
      hostLoad: { cpuMaxPercent: 90, memoryMaxPercent: 33, instancesMax: 1 },
    });
    expect(startInstance).not.toHaveBeenCalled();
    vi.mocked(startInstance).mockRejectedValue(new Error('instanceWaitTimeoutMs'));
    expect((await performanceCheck(ctx, 'g', 'web', scenario, options(root))).failures[0]?.message).toBe('performance did not run: instanceWaitTimeoutMs');
  });
});
