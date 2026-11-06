import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChannelResponse } from '../../../src/commands/instance/lib/channel.ts';
import { InputLatency } from '../../../src/commands/instance/lib/latency.ts';
import { restartClient } from '../../../src/commands/instance/automation.ts';
import { readPlayAccess, readRecord } from '../../../src/commands/instance/lib/records.ts';
import { createContext } from '../../../src/lib/command.ts';
import { ogw } from '../../helpers/workspace.ts';
import { setupRunner, startFor, stopAll, type Runner } from './runner.ts';

vi.mock('../../../src/commands/generate/api.ts', async () => (await import('./mocks/apis.ts')).generate);
vi.mock('../../../src/commands/data/api.ts', async () => (await import('./mocks/apis.ts')).data);
vi.mock('../../../src/commands/core/api.ts', async () => (await import('./mocks/apis.ts')).core);
vi.mock('../../../src/commands/env/api.ts', async () => (await import('./mocks/apis.ts')).env);
vi.mock('../../../src/commands/instance/lib/spawn.ts', () => import('./mocks/spawn.ts'));
vi.mock('../../../src/commands/instance/lib/launch.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/commands/instance/lib/launch.ts')>();
  return { ...real, ...(await import('./mocks/apis.ts')).launchOverrides(real) };
});

/** A client `main` that keeps its step mode and records the commands it got. */
function fakeMain(fail: Record<string, string> = {}) {
  const sent: string[] = [];
  const waits: number[] = [];
  let stepMode = false;
  const send = (command: string, args: readonly string[]): Promise<ChannelResponse> => {
    const response = (ok: boolean, result: unknown): ChannelResponse => ({ ok, result, bytes: Buffer.alloc(0), frames: [] });
    if (command === 'get_state') return Promise.resolve(response(true, { step_mode: stepMode }));
    sent.push([command, ...args].join(' '));
    if (command === 'set_step_mode') stepMode = args[0] === 'on';
    const failure = fail[[command, ...args].join(' ')];
    return Promise.resolve(failure === undefined ? response(true, null) : response(false, failure));
  };
  const latency = new InputLatency(150, send, (ms) => {
    waits.push(ms);
    return Promise.resolve();
  });
  return { sent, waits, latency };
}

describe('input latency', () => {
  it('answers an input in free mode at once and sends it after the latency, and sends other commands at once', async () => {
    const sent: string[] = [];
    let release = (): void => undefined;
    const send = (command: string, args: readonly string[]): Promise<ChannelResponse> => {
      if (command !== 'get_state') sent.push([command, ...args].join(' '));
      return Promise.resolve({ ok: true, result: command === 'get_state' ? { step_mode: false } : null, bytes: Buffer.alloc(0), frames: [] });
    };
    const waits: number[] = [];
    const latency = new InputLatency(150, send, (ms) => {
      waits.push(ms);
      return new Promise((resolve) => {
        release = resolve;
      });
    }, () => 1000);
    expect((await latency.request('tap', ['1', '2'], 1000)).ok).toBe(true);
    await latency.request('capture_screen', [], 1000);
    expect(sent).toEqual(['capture_screen']);
    release();
    await latency.sent();
    expect(sent).toEqual(['capture_screen', 'tap 1 2']);
    expect(waits).toEqual([150]);
  });

  it('sends each input of a timed sequence the latency after its own send time, in order', async () => {
    const arrived: { command: string; at: number }[] = [];
    const send = (command: string): Promise<ChannelResponse> => {
      if (command !== 'get_state') arrived.push({ command, at: Date.now() });
      return Promise.resolve({ ok: true, result: command === 'get_state' ? { step_mode: false } : null, bytes: Buffer.alloc(0), frames: [] });
    };
    const latency = new InputLatency(150, send);
    const start = Date.now();
    const sentAt: number[] = [];
    for (const [i, command] of ['key_down', 'tap', 'key_up'].entries()) {
      const due = start + i * 50;
      if (due > Date.now()) await new Promise((r) => setTimeout(r, due - Date.now()));
      sentAt.push(Date.now());
      expect((await latency.request(command, ['1'], 1000)).ok).toBe(true);
    }
    // every request was answered at once, before the first input arrived
    expect(arrived).toEqual([]);
    await latency.sent();
    expect(arrived.map((a) => a.command)).toEqual(['key_down', 'tap', 'key_up']);
    for (const [i, a] of arrived.entries()) {
      expect(a.at - (sentAt[i] as number)).toBeGreaterThanOrEqual(149);
      expect(a.at - (sentAt[i] as number)).toBeLessThan(220);
    }
  });

  it('holds an input in step mode and splits the step during which it becomes due', async () => {
    const main = fakeMain();
    await main.latency.request('set_step_mode', ['on'], 1000);
    expect((await main.latency.request('key_down', ['A'], 1000)).ok).toBe(true);
    expect(main.latency.heldCommands()).toEqual(['key_down']);
    await main.latency.request('step', ['100'], 1000);
    expect(main.latency.heldCommands()).toEqual(['key_down']);
    await main.latency.request('key_up', ['A'], 1000);
    await main.latency.request('step', ['100'], 1000);
    await main.latency.request('step', ['200'], 1000);
    expect(main.sent).toEqual(['set_step_mode on', 'step 100', 'step 50', 'key_down A', 'step 50', 'step 50', 'key_up A', 'step 150']);
    expect(main.latency.heldCommands()).toEqual([]);
    expect(main.waits).toEqual([]);
  });

  it('sends a held input due at the end of a step after that step, and the failure of a part as the answer', async () => {
    const main = fakeMain({ 'tap 1 1': 'no target' });
    await main.latency.request('set_step_mode', ['on'], 1000);
    await main.latency.request('tap', ['1', '1'], 1000);
    const answer = await main.latency.request('step', ['150'], 1000);
    expect(main.sent).toEqual(['set_step_mode on', 'step 150', 'tap 1 1']);
    expect(answer).toMatchObject({ ok: false, result: 'no target' });
  });

  it('sends the held inputs after the rest of their latency when step mode turns off', async () => {
    const main = fakeMain();
    await main.latency.request('set_step_mode', ['on'], 1000);
    await main.latency.request('key_down', ['A'], 1000);
    await main.latency.request('step', ['100'], 1000);
    await main.latency.request('key_up', ['A'], 1000);
    await main.latency.request('set_step_mode', ['off'], 1000);
    expect(main.sent).toEqual(['set_step_mode on', 'step 100', 'set_step_mode off', 'key_down A', 'key_up A']);
    expect(main.waits).toEqual([50, 100]);
  });
});

describe('ogw instance start --input-latency', () => {
  let runner: Runner;
  let id: string;

  beforeAll(async () => {
    runner = setupRunner();
    id = await startFor(runner, ['--input-latency', '300']);
  });

  afterAll(async () => {
    await stopAll(runner);
  });

  it('keeps the latency in the plan and the play access, and delays ogw input by it', async () => {
    expect((await readRecord(id, runner.ws.env)).plan?.inputLatencyMs).toBe(300);
    expect((await readPlayAccess(id, runner.ws.env)).inputLatencyMs).toBe(300);
    const started = Date.now();
    const run = await ogw(runner.ws, ['input', id, 'tap', '1', '2']);
    expect(run).toMatchObject({ code: 0, stdout: '{"ok":true,"result":null}\n' });
    const tapped = (): boolean => runner.requests('main').at(-1)?.command === 'tap';
    while (!tapped() && Date.now() - started < 10_000) await new Promise((r) => setTimeout(r, 20));
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(runner.requests('main').at(-1)).toMatchObject({ command: 'tap', args: ['1', '2'] });
  });

  it('holds an input in step mode until ogw step reaches it', async () => {
    expect((await ogw(runner.ws, ['step-mode', id, 'on'])).code).toBe(0);
    const before = runner.requests('main').length;
    expect((await ogw(runner.ws, ['input', id, 'key_down', 'A'])).code).toBe(0);
    expect(runner.requests('main').slice(before).map((r) => r.command)).toEqual(['get_state']);
    const step = await ogw(runner.ws, ['step', id, '200', '--count', '2']);
    expect(step.code).toBe(0);
    const sent = runner.requests('main').slice(before).filter((r) => r.command === 'step' || r.command === 'key_down');
    expect(sent.map((r) => [r.command, ...r.args].join(' '))).toEqual(['step 200', 'step 100', 'key_down A', 'step 100']);
    expect((await ogw(runner.ws, ['step-mode', id, 'off'])).code).toBe(0);
  });

  it('refuses an --input-latency that is not a whole number of ms', async () => {
    const run = await ogw(runner.ws, ['instance', 'start', 'g', '--input-latency', 'x']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('invalid --input-latency: x');
  });
});

describe('ogw instance start --network-delay', () => {
  let runner: Runner;

  beforeAll(() => {
    runner = setupRunner();
  });

  afterAll(async () => {
    await stopAll(runner);
  });

  const delays = (): string[] =>
    runner
      .requests('main')
      .filter((r) => r.command === 'set_network_delay')
      .map((r) => r.args.join(' '));

  it('sends set_network_delay to the client main first on each connection of its automation channel', async () => {
    const id = await startFor(runner, ['--network-delay', '3000']);
    expect((await readRecord(id, runner.ws.env)).plan?.networkDelayMs).toBe(3000);
    expect(runner.requests('main')[0]).toMatchObject({ command: 'set_network_delay', args: ['3000'] });
    expect(delays()).toEqual(['3000']);
    // a restart connects the channel again: the new boot gets it again
    const ctx = createContext({ cwd: runner.ws.root, env: runner.ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    await restartClient(ctx, id);
    expect(delays()).toEqual(['3000', '3000']);
    await stopAll(runner);
    // an instance without the option gets none
    await startFor(runner);
    expect(delays()).toEqual(['3000', '3000']);
    await stopAll(runner);
  });

  it('fails the start when the first set_network_delay is not ok, and refuses a value that is not a whole number of ms', async () => {
    runner.config({ clients: { main: { fail: { set_network_delay: 'NetworkCore is not initialized' } } } });
    const run = await ogw(runner.ws, ['instance', 'start', 'g', '--network-delay', '3000']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('main: set_network_delay failed: "NetworkCore is not initialized"');
    runner.config({});
    const bad = await ogw(runner.ws, ['instance', 'start', 'g', '--network-delay', 'x']);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('invalid --network-delay: x');
  });
});
