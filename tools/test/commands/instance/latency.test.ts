import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChannelResponse } from '../../../src/commands/instance/lib/channel.ts';
import { InputLatency } from '../../../src/commands/instance/lib/latency.ts';
import { restartClient } from '../../../src/commands/instance/automation.ts';
import { startInstance } from '../../../src/commands/instance/api.ts';
import { instanceFolder, readPlayAccess, readRecord } from '../../../src/commands/instance/lib/records.ts';
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
  const logged: string[] = [];
  let stepMode = false;
  const send = (command: string, args: readonly string[]): Promise<ChannelResponse> => {
    const response = (ok: boolean, result: unknown): ChannelResponse => ({ ok, result, bytes: Buffer.alloc(0), frames: [] });
    if (command === 'get_state') return Promise.resolve(response(true, { step_mode: stepMode }));
    sent.push([command, ...args].join(' '));
    if (command === 'set_step_mode') stepMode = args[0] === 'on';
    const failure = fail[[command, ...args].join(' ')];
    return Promise.resolve(failure === undefined ? response(true, null) : response(false, failure));
  };
  const latency = new InputLatency(150, send, (line) => logged.push(line), (ms) => {
    waits.push(ms);
    return Promise.resolve();
  });
  return { sent, waits, logged, latency };
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
    const latency = new InputLatency(150, send, () => undefined, (ms) => {
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
    const latency = new InputLatency(150, send, () => undefined);
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

  it('writes a delayed input that is not ok or fails to the log, as its caller already got ok', async () => {
    const main = fakeMain({ 'key_down A': 'no focus' });
    await main.latency.request('key_down', ['A'], 1000);
    await main.latency.sent();
    expect(main.logged).toEqual(['main: delayed key_down failed: "no focus"']);
    const logged: string[] = [];
    const send = (command: string): Promise<ChannelResponse> =>
      command === 'get_state'
        ? Promise.resolve({ ok: true, result: { step_mode: false }, bytes: Buffer.alloc(0), frames: [] })
        : Promise.reject(new Error('main: automation channel closed'));
    const gone = new InputLatency(150, send, (line) => logged.push(line), () => Promise.resolve());
    expect((await gone.request('tap', ['1', '1'], 1000)).ok).toBe(true);
    await gone.sent();
    expect(logged).toEqual(['main: delayed tap failed: main: automation channel closed']);
  });

  it('fails an input whose get_state fails, as the input itself would, instead of taking it as outside step mode', async () => {
    const sent: string[] = [];
    const send = (command: string): Promise<ChannelResponse> => {
      if (command === 'get_state') return Promise.reject(new Error('main: get_state got no response within 1000 ms'));
      sent.push(command);
      return Promise.resolve({ ok: true, result: null, bytes: Buffer.alloc(0), frames: [] });
    };
    const latency = new InputLatency(150, send, () => undefined, () => Promise.resolve());
    await expect(latency.request('tap', ['1', '1'], 1000)).rejects.toThrow('get_state got no response');
    await latency.sent();
    expect(sent).toEqual([]);
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

  it('writes a later set_network_delay that is not ok to runner.log of the instance folder, and the instance keeps running', async () => {
    const before = delays().length;
    const id = await startFor(runner, ['--network-delay', '3000']);
    runner.config({ clients: { main: { fail: { set_network_delay: 'NetworkCore is not initialized' } } } });
    const ctx = createContext({ cwd: runner.ws.root, env: runner.ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    await restartClient(ctx, id);
    const log = join(await instanceFolder(id, runner.ws.env), 'runner.log');
    const line = 'main: set_network_delay failed: "NetworkCore is not initialized"';
    const logged = (): boolean => existsSync(log) && readFileSync(log, 'utf8').includes(line);
    const started = Date.now();
    while (!logged() && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 20));
    expect(readFileSync(log, 'utf8')).toContain(line);
    expect(delays().slice(before)).toEqual(['3000', '3000']);
    expect((await readRecord(id, runner.ws.env)).status).toBe('running');
    runner.config({});
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

describe('ogw instance start --feedback-off and --reward-presentation-off', () => {
  let runner: Runner;

  beforeAll(() => {
    runner = setupRunner();
  });

  afterAll(async () => {
    await stopAll(runner);
  });

  const ctx = () => createContext({ cwd: runner.ws.root, env: runner.ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
  const SWITCHES = ['set_feedback_off', 'set_reward_presentation_off'];
  const isSwitch = (line: string): boolean => SWITCHES.includes(line.split(' ')[0] ?? '');
  /** The requests of the client main from the `from`-th, as `<command> <args>`. */
  const sentFrom = (from: number): string[] => runner.requests('main').slice(from).map((r) => [r.command, ...r.args].join(' '));
  /** The requests of each connection of main from the `from`-th: a `restart` ends a connection. */
  const connections = (from: number): string[][] => {
    const all: string[][] = [[]];
    for (const line of sentFrom(from)) {
      (all.at(-1) as string[]).push(line);
      if (line === 'restart') all.push([]);
    }
    return all;
  };

  for (const [option, command] of [['--feedback-off', 'set_feedback_off on'], ['--reward-presentation-off', 'set_reward_presentation_off on']] as const) {
    it(`sends ${command} to the client main before any other command on each connection of its automation channel with ${option}`, async () => {
      const from = runner.requests('main').length;
      const id = await startFor(runner, [option]);
      const plan = (await readRecord(id, runner.ws.env)).plan;
      expect([plan?.feedbackOff, plan?.rewardPresentationOff]).toEqual(option === '--feedback-off' ? [true, undefined] : [undefined, true]);
      // a restart connects the channel again: the new boot gets it again, first
      await restartClient(ctx(), id);
      await restartClient(ctx(), id);
      const connected = connections(from);
      expect(connected).toHaveLength(3);
      for (const connection of connected) {
        expect(connection[0]).toBe(command);
        expect(connection.slice(1)).toContain('get_state');
        expect(connection.filter(isSwitch)).toEqual([command]);
      }
      await stopAll(runner);
      // an instance without the option gets none
      const without = runner.requests('main').length;
      await startFor(runner);
      expect(sentFrom(without).filter(isSwitch)).toEqual([]);
      await stopAll(runner);
    });
  }

  it('sends both switches, both before set_network_delay and any other command of each connection, when both are given', async () => {
    const from = runner.requests('main').length;
    const id = await startFor(runner, ['--feedback-off', '--reward-presentation-off', '--network-delay', '3000']);
    await restartClient(ctx(), id);
    const connected = connections(from);
    expect(connected).toHaveLength(2);
    for (const connection of connected) {
      expect(connection.slice(0, 2).sort()).toEqual(['set_feedback_off on', 'set_reward_presentation_off on']);
      expect(connection[2]).toBe('set_network_delay 3000');
    }
    await stopAll(runner);
  });

  for (const command of SWITCHES) {
    it(`fails the start when the first ${command} is not ok, and writes a later one that is not ok to runner.log`, async () => {
      runner.config({ clients: { main: { fail: { [command]: 'QACore refused' } } } });
      const run = await ogw(runner.ws, ['instance', 'start', 'g', '--feedback-off', '--reward-presentation-off']);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain(`main: ${command} failed: "QACore refused"`);
      runner.config({});
      const id = await startFor(runner, ['--feedback-off', '--reward-presentation-off']);
      runner.config({ clients: { main: { fail: { [command]: 'QACore refused' } } } });
      await restartClient(ctx(), id);
      const log = join(await instanceFolder(id, runner.ws.env), 'runner.log');
      const line = `main: ${command} failed: "QACore refused"`;
      const logged = (): boolean => existsSync(log) && readFileSync(log, 'utf8').includes(line);
      const started = Date.now();
      while (!logged() && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 20));
      expect(readFileSync(log, 'utf8')).toContain(line);
      // the other switch was ok: only the one that failed is logged
      const other = SWITCHES.find((c) => c !== command) ?? '';
      expect(readFileSync(log, 'utf8')).not.toContain(`main: ${other} failed`);
      expect((await readRecord(id, runner.ws.env)).status).toBe('running');
      runner.config({});
      await stopAll(runner);
    });
  }
});

describe('the movie and test screen of the flash check', () => {
  let runner: Runner;

  beforeAll(() => {
    runner = setupRunner();
  });

  afterAll(async () => {
    await stopAll(runner);
  });

  const ctx = () => createContext({ cwd: runner.ws.root, env: runner.ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });

  it('starts the client main with the movie window and fps and sends it the test screen after the other connection commands, on each connection', async () => {
    const from = runner.requests('main').length;
    const file = join(runner.logDir, 'frame.png');
    const testScreen = { window: [1179, 2556] as [number, number], fillMode: 'Crop', notch: [0, 59, 0, 34] as [number, number, number, number] };
    const instance = await startInstance(ctx(), { game: 'g', client: 'window', networkDelayMs: 100, movie: { file, resolution: [393, 852], fps: 30 }, testScreen });
    expect((await readRecord(instance.id, runner.ws.env)).plan).toMatchObject({ movie: { file, resolution: [393, 852], fps: 30 }, testScreen });
    const args = runner.clientArgs('main');
    expect(args.slice(0, args.indexOf('--'))).toEqual(expect.arrayContaining(['--resolution', '393x852', '--write-movie', file, '--fixed-fps', '30']));
    expect(JSON.parse(readFileSync(join(runner.logDir, 'main.values.json'), 'utf8'))).toMatchObject({ OGW_FRAME_STEP_FPS: '30' });
    await restartClient(ctx(), instance.id);
    const all: string[][] = [[]];
    for (const line of runner.requests('main').slice(from).map((r) => [r.command, ...r.args].join(' '))) {
      (all.at(-1) as string[]).push(line);
      if (line === 'restart') all.push([]);
    }
    expect(all).toHaveLength(2);
    for (const connection of all) expect(connection.slice(0, 3)).toEqual(['set_network_delay 100', 'set_test_screen 1179 2556 Crop', 'set_virtual_notch 0 59 0 34']);
    await stopAll(runner);
  });

  it('fails the start when the first set_test_screen is not ok', async () => {
    runner.config({ clients: { main: { fail: { set_test_screen: 'bad size' } } } });
    const testScreen = { window: [100, 100] as [number, number], fillMode: 'Letterbox', notch: [0, 0, 0, 0] as [number, number, number, number] };
    await expect(startInstance(ctx(), { game: 'g', client: 'window', testScreen })).rejects.toThrow('main: set_test_screen failed: "bad size"');
    runner.config({});
    await stopAll(runner);
  });
});
