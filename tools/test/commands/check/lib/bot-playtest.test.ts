import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { automationRequest } from '../../../../src/commands/instance/automation.ts';
import { startInstance, stopInstance } from '../../../../src/commands/instance/api.ts';
import { instanceProcesses, instanceServerLog } from '../../../../src/commands/check/lib/instance-probe.ts';
import { botPlaytest, judge, readScenario } from '../../../../src/commands/check/lib/bot-playtest.ts';
import { Slots, withInstance } from '../../../../src/commands/check/lib/instances.ts';
import { doneState, fakeAutomation, fakeContext, notOk, ok } from '../helpers.ts';

vi.mock('../../../../src/commands/instance/automation.ts', () => ({
  automationRequest: vi.fn(),
  restartClient: async (...args: Parameters<typeof import('../helpers.ts').fakeRestartClient>) => (await import('../helpers.ts')).fakeRestartClient(...args),
}));
vi.mock('../../../../src/commands/instance/api.ts', () => ({ startInstance: vi.fn(), stopInstance: vi.fn(), listInstances: vi.fn() }));
vi.mock('../../../../src/commands/check/lib/instance-probe.ts', () => ({ instanceProcesses: vi.fn(), instanceServerLog: vi.fn() }));

const logs: string[] = [];
const ctx = fakeContext(logs);
const goal = { path: 'telemetry.goal_intervals', op: 'count_gte', value: 1 };

function root(scenario: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'ogw-bot-'));
  if (scenario !== undefined) {
    mkdirSync(join(dir, 'client', 'dev', 'bot'), { recursive: true });
    writeFileSync(join(dir, 'client/dev/bot/scenario.json'), typeof scenario === 'string' ? scenario : JSON.stringify(scenario));
  }
  return dir;
}

function serve(goals: number, tapResult = ok(null)): void {
  vi.mocked(automationRequest).mockImplementation(fakeAutomation((command) => {
    if (command === 'get_state') return ok(doneState());
    if (command === 'get_telemetry') return ok({ goal_intervals: Array.from({ length: goals }, () => ({})) });
    if (command === 'extract_logs') return ok([{ path: 'log/log_1.txt', content: 'line\n' }, { path: 'x' }, null]);
    if (command === 'tap') return tapResult;
    return ok(null);
  }));
}

const steps = [{ kind: 'input', command: 'tap', args: ['1', '1'], timeoutMs: 1000 }];

beforeEach(() => {
  logs.length = 0;
  vi.mocked(startInstance).mockReset().mockResolvedValue({ id: 'b1' } as Awaited<ReturnType<typeof startInstance>>);
  vi.mocked(stopInstance).mockReset().mockResolvedValue();
  vi.mocked(instanceProcesses).mockResolvedValue({ server: true, clients: [{ client: 'main', alive: true }] });
  vi.mocked(instanceServerLog).mockResolvedValue('{"level":"info"}\n');
});

describe('botPlaytest', () => {
  it('passes both checks and keeps the logs', async () => {
    const dir = root({ steps, goal });
    serve(1);
    const [noBlocker, fullFlow] = await botPlaytest(ctx, 'g', await readScenario(dir), { evidence: { root: dir, dir: 'ev', relative: true }, slots: new Slots(1), pollMs: 1 });
    expect(startInstance).toHaveBeenCalledWith(ctx, { game: 'g', client: 'headless', db: undefined }, { beforeFailedStop: expect.any(Function) as unknown });
    expect(stopInstance).toHaveBeenCalledWith(ctx, 'b1');
    expect(noBlocker).toEqual({ name: 'no blocker', platform: null, result: 'pass', failures: [], warnings: [] });
    expect(fullFlow).toEqual({ name: 'full flow', platform: null, result: 'pass', failures: [], warnings: [] });
    expect(readFileSync(join(dir, 'ev/bot-playtest/client.log'), 'utf8')).toBe('line\n');
    expect(readFileSync(join(dir, 'ev/bot-playtest/server.log'), 'utf8')).toBe('{"level":"info"}\n');
  });

  it('full flow fails when the goal is not true after the last step', async () => {
    const dir = root({ steps, goal });
    serve(0);
    const [noBlocker, fullFlow] = await botPlaytest(ctx, 'g', await readScenario(dir), { evidence: { root: dir, dir: 'ev', relative: true }, slots: new Slots(1), pollMs: 1, db: 'postgresql' });
    expect(startInstance).toHaveBeenCalledWith(ctx, { game: 'g', client: 'headless', db: 'postgresql' }, { beforeFailedStop: expect.any(Function) as unknown });
    expect(noBlocker.result).toBe('pass');
    expect(fullFlow.failures).toEqual([
      { where: 'step 1', message: 'goal is not true after the last step', evidence: ['ev/bot-playtest/client.log', 'ev/bot-playtest/server.log'] },
    ]);
  });

  it('a blocker fails both; logs that cannot be read are left out', async () => {
    const dir = root({ steps, goal });
    serve(1, notOk('blocked'));
    vi.mocked(instanceServerLog).mockRejectedValue(new Error('gone'));
    const [noBlocker, fullFlow] = await botPlaytest(ctx, 'g', await readScenario(dir), { evidence: { root: dir, dir: 'ev', relative: true }, slots: new Slots(1), pollMs: 1 });
    expect(noBlocker).toEqual({
      name: 'no blocker',
      platform: null,
      result: 'fail',
      failures: [{ where: 'step 1', message: 'tap returned ok false: "blocked"', evidence: ['ev/bot-playtest/client.log'] }],
      warnings: [],
    });
    expect(fullFlow.result).toBe('fail');
    expect(fullFlow.failures[0]?.message).toBe('scenario stopped at step 1');
  });

  it('a stop that is not a blocker leaves no blocker and full flow unknown', async () => {
    const auto = [{ kind: 'auto', command: 'f.bot_next_input', until: goal, timeoutMs: 1000 }];
    const dir = root({ steps: auto, goal });
    serve(0);
    vi.mocked(automationRequest).mockImplementation(fakeAutomation((command) => (command === 'f.bot_next_input' ? ok('bad') : ok(doneState()))));
    const [noBlocker, fullFlow] = await botPlaytest(ctx, 'g', await readScenario(dir), { evidence: { root: dir, dir: null, relative: true }, slots: new Slots(1), pollMs: 1 });
    expect(noBlocker.result).toBe('unknown');
    expect(noBlocker.failures[0]?.evidence).toEqual([]);
    expect(fullFlow.result).toBe('unknown');
    expect(fullFlow.failures).toEqual(noBlocker.failures);
  });

  it('fails both when the scenario is missing or has another form', async () => {
    for (const [scenario, message] of [
      [undefined, 'client/dev/bot/scenario.json does not exist'],
      ['{', expect.stringMatching(/^scenario is not JSON/) as unknown as string],
    ] as const) {
      const dir = root(scenario);
      const [noBlocker, fullFlow] = await botPlaytest(ctx, 'g', await readScenario(dir), { evidence: { root: dir, dir: null, relative: true }, slots: new Slots(1), pollMs: 1 });
      expect(noBlocker).toEqual({ name: 'no blocker', platform: null, result: 'fail', failures: [{ where: 'client/dev/bot/scenario.json:1', message, evidence: [] }], warnings: [] });
      expect(fullFlow.result).toBe('fail');
    }
    expect(startInstance).not.toHaveBeenCalled();
  });

  it('is unknown when the instance does not start', async () => {
    const dir = root({ steps, goal });
    vi.mocked(startInstance).mockRejectedValue(new Error('fixture failed'));
    const [noBlocker, fullFlow] = await botPlaytest(ctx, 'g', await readScenario(dir), { evidence: { root: dir, dir: null, relative: true }, slots: new Slots(1), pollMs: 1 });
    const failure = { where: 'client/dev/bot/scenario.json:1', message: 'bot playtest did not run: fixture failed', evidence: [] };
    expect(noBlocker).toEqual({ name: 'no blocker', platform: null, result: 'unknown', failures: [failure], warnings: [] });
    expect(fullFlow).toEqual({ name: 'full flow', platform: null, result: 'unknown', failures: [failure], warnings: [] });
  });

  it('readScenario and botPlaytest treat an unreadable scenario like a malformed one', async () => {
    const dir = root(undefined);
    mkdirSync(join(dir, 'client/dev/bot/scenario.json'), { recursive: true });
    expect(await readScenario(dir)).toMatch(/^client\/dev\/bot\/scenario\.json could not be read: .*EISDIR/);
    const [noBlocker, fullFlow] = await botPlaytest(ctx, 'g', await readScenario(dir), { evidence: { root: dir, dir: null, relative: true }, slots: new Slots(1), pollMs: 1 });
    expect([noBlocker.result, fullFlow.result]).toEqual(['fail', 'fail']);
    expect(noBlocker.failures[0]?.where).toBe('client/dev/bot/scenario.json:1');
    expect(startInstance).not.toHaveBeenCalled();
  });
});

describe('Slots and withInstance', () => {
  it('lets at most size holders run and frees the slot on errors', async () => {
    const slots = new Slots(2);
    let running = 0;
    let most = 0;
    const work = async (): Promise<void> => {
      await slots.acquire();
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 3));
      running--;
      slots.release();
    };
    await Promise.all([work(), work(), work(), work(), work()]);
    expect(most).toBe(2);
    const one = new Slots(1);
    vi.mocked(startInstance).mockResolvedValue({ id: 'w1' } as Awaited<ReturnType<typeof startInstance>>);
    vi.mocked(stopInstance).mockRejectedValue(new Error('already gone'));
    await expect(withInstance(ctx, one, { game: 'g' }, () => Promise.reject(new Error('work failed')))).rejects.toThrow('work failed');
    expect(stopInstance).toHaveBeenCalledWith(ctx, 'w1');
    expect(logs).toEqual(['cannot stop instance w1: already gone']);
    vi.mocked(startInstance).mockRejectedValue(new Error('no start'));
    await expect(withInstance(ctx, one, { game: 'g' }, () => Promise.resolve(1))).rejects.toThrow('no start');
    vi.mocked(startInstance).mockResolvedValue({ id: 'w2' } as Awaited<ReturnType<typeof startInstance>>);
    vi.mocked(stopInstance).mockResolvedValue();
    expect(await withInstance(ctx, one, { game: 'g' }, (i) => Promise.resolve(i.id))).toBe('w2');
  });
});

describe('judge', () => {
  it('makes a failed step a full flow failure, and no blocker unknown: the step\'s blocker check and the steps after it did not run', () => {
    const at = (step: number) => ({ stop: { step, message: 'save: content differs after restart: 1 then 2', blocker: false, failedStep: true }, goal: false }) as unknown as Parameters<typeof judge>[0];
    const [noBlocker, fullFlow] = judge(at(3), 5, []);
    expect(noBlocker.result).toBe('unknown');
    expect(noBlocker.failures[0]?.message).toContain('blockers of step 3 and after were not checked');
    expect(fullFlow.result).toBe('fail');
    expect(fullFlow.failures[0]?.message).toContain('save: content differs');
    // the last step too: the scenario stopped inside it, before its blocker check
    const [lastNoBlocker, lastFullFlow] = judge(at(5), 5, []);
    expect(lastNoBlocker.result).toBe('unknown');
    expect(lastFullFlow.result).toBe('fail');
  });
});
