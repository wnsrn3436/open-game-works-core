import { beforeEach, describe, expect, it, vi } from 'vitest';
import { automationRequest } from '../../../../src/commands/instance/automation.ts';
import { instanceProcesses, instanceServerLog } from '../../../../src/commands/check/lib/instance-probe.ts';
import {
  LogCursor,
  parseScenario,
  processBlocker,
  autoInputGapMs,
  runScenario,
  stateBlocker,
  type Scenario,
} from '../../../../src/commands/check/lib/scenario.ts';
import { ClientLogUnreadable } from '../../../../src/commands/check/lib/logs.ts';
import { readRecord, type InstanceRecord } from '../../../../src/commands/instance/lib/records.ts';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doneState, fakeContext, notOk, ok, type Handler } from '../helpers.ts';

vi.mock('../../../../src/commands/instance/automation.ts', () => ({
  automationRequest: vi.fn(),
  restartClient: async (...args: Parameters<typeof import('../helpers.ts').fakeRestartClient>) => (await import('../helpers.ts')).fakeRestartClient(...args),
}));
vi.mock('../../../../src/commands/check/lib/instance-probe.ts', () => ({ instanceProcesses: vi.fn(), instanceServerLog: vi.fn() }));
vi.mock('../../../../src/commands/instance/lib/records.ts', () => ({ readRecord: vi.fn(() => Promise.reject(new Error('no record'))) }));

const ctx = fakeContext();
const calls: string[] = [];

function serve(handler: Handler): void {
  vi.mocked(automationRequest).mockImplementation(async (_ctx, _id, command, args, client) => {
    calls.push([command, ...args].join(' '));
    return handler(command, args, client);
  });
}

/** A client with a QAState and telemetry; unknown commands succeed. */
function client(state: Record<string, unknown> = doneState(), telemetry: unknown = { goal_intervals: [{}] }): Handler {
  return (command) => {
    if (command === 'get_state') return ok(state);
    if (command === 'get_telemetry') return ok(telemetry);
    if (command === 'extract_logs') return ok([{ path: 'log/log_1.txt', content: '1\tinfo\tboot\tstarted\t\n' }]);
    return ok(null);
  };
}

const goal = { path: 'telemetry.goal_intervals', op: 'count_gte' as const, value: 1 };

function scenario(steps: Scenario['steps']): Scenario {
  return { steps, goal };
}

function step(command: string, extra: Partial<Scenario['steps'][number]> = {}): Scenario['steps'][number] {
  return { kind: 'input', command, args: [], until: null, timeoutMs: 2000, ...extra };
}

beforeEach(() => {
  calls.length = 0;
  vi.mocked(instanceProcesses).mockResolvedValue({ server: true, clients: [{ client: 'main', alive: true }] });
  vi.mocked(instanceServerLog).mockResolvedValue('{"level":"info","message":"ok"}\n');
});

describe('parseScenario', () => {
  it('parses steps with defaults', () => {
    const text = JSON.stringify({
      steps: [
        { kind: 'input', command: 'tap', args: ['1', '2'], timeoutMs: 5 },
        { kind: 'save', timeoutMs: 5 },
        { kind: 'auto', command: 'f.bot_next_input', timeoutMs: 5, until: goal },
      ],
      goal,
    });
    expect(parseScenario(text)).toEqual({
      steps: [
        { kind: 'input', command: 'tap', args: ['1', '2'], until: null, timeoutMs: 5 },
        { kind: 'save', command: null, args: [], until: null, timeoutMs: 5 },
        { kind: 'auto', command: 'f.bot_next_input', args: [], until: goal, timeoutMs: 5 },
      ],
      goal,
    });
  });

  it('names what is wrong', () => {
    const steps = (s: unknown): string => JSON.stringify({ steps: [s], goal });
    expect(parseScenario('{')).toMatch(/^scenario is not JSON: /);
    expect(parseScenario('[]')).toBe('scenario: scenario is not a JSON object');
    expect(parseScenario('{"steps": 1}')).toBe('scenario: `steps` is not a list');
    expect(parseScenario('{"steps": []}')).toBe('scenario: no `goal`');
    expect(parseScenario(JSON.stringify({ steps: [], goal, extra: 1 }))).toBe('scenario: unknown field `extra`');
    expect(parseScenario(steps(1))).toBe('step 1: step is not an object');
    expect(parseScenario(steps({ kind: 'jump', timeoutMs: 1 }))).toBe('step 1: `kind` must be `input`, `setup`, `auto` or `save`');
    expect(parseScenario(steps({ kind: 3, timeoutMs: 1 }))).toBe('step 1: `kind` must be `input`, `setup`, `auto` or `save`');
    expect(parseScenario(steps({ kind: 'setup', timeoutMs: 1 }))).toBe('step 1: step has no `command`');
    expect(parseScenario(steps({ kind: 'save', command: 'x', timeoutMs: 1 }))).toBe('step 1: `save` step has a `command`');
    expect(parseScenario(steps({ kind: 'setup', command: 'x', timeoutMs: 1, extra: 1 }))).toBe('step 1: unknown step field `extra`');
    expect(parseScenario(steps({ kind: 'input', command: 'tap', args: [1], timeoutMs: 1 }))).toBe('step 1: `args` must be a list of strings');
    expect(parseScenario(steps({ kind: 'input', command: 'tap', args: 'x', timeoutMs: 1 }))).toBe('step 1: `args` must be a list of strings');
    expect(parseScenario(steps({ kind: 'input', command: 'tap', timeoutMs: 0 }))).toBe('step 1: `timeoutMs` must be an integer of 1 or more');
    expect(parseScenario(steps({ kind: 'input', command: 'tap', timeoutMs: 1.5 }))).toBe('step 1: `timeoutMs` must be an integer of 1 or more');
    expect(parseScenario(steps({ kind: 'input', command: 'tap' }))).toBe('step 1: `timeoutMs` must be an integer of 1 or more');
    expect(parseScenario(steps({ kind: 'input', command: 'tap', timeoutMs: 1, until: { path: 'x', op: 'eq', value: 1 } }))).toBe(
      'step 1 until: condition `path` must start with `state.` or `telemetry.`',
    );
    expect(parseScenario(steps({ kind: 'input', command: 'tap', timeoutMs: 1, until: { all: [goal], path: 'state.x' } }))).toBe(
      'step 1 until: `all` condition must be `{"all": [<condition>, ...]}`',
    );
    expect(parseScenario(steps({ kind: 'auto', command: 'f.bot_next_input', timeoutMs: 1 }))).toBe('step 1: `auto` step has no `until`');
    expect(parseScenario(JSON.stringify({ steps: [], goal: 1 }))).toBe('goal: condition is not an object');
  });
});

describe('stateBlocker', () => {
  it('finds each blocker of the QAState', () => {
    expect(stateBlocker(doneState())).toBeNull();
    expect(stateBlocker(doneState({ boot_stage: 'Halted' }))).toBe('boot_stage is Halted');
    expect(stateBlocker(doneState({ invariant_failures: ['a.b', 'c.d'] }))).toBe('invariant failures: a.b, c.d');
    expect(stateBlocker(doneState({ softlock: { kind: 'Block' } }))).toBe('softlock {"kind":"Block"}');
    expect(stateBlocker(doneState({ softlock: undefined }))).toBeNull();
  });
});

describe('processBlocker', () => {
  it('names an ended process or the first error log line', async () => {
    serve(client());
    expect(await processBlocker(ctx, 'i1')).toBeNull();
    vi.mocked(instanceProcesses).mockResolvedValueOnce({ server: false, clients: [] });
    expect(await processBlocker(ctx, 'i1')).toBe('server process ended');
    vi.mocked(instanceProcesses).mockResolvedValueOnce({
      server: true,
      clients: [{ client: 'main', alive: true }, { client: 'opponent_1', alive: false }],
    });
    expect(await processBlocker(ctx, 'i1')).toBe('client process opponent_1 ended');
    serve((command) => (command === 'extract_logs' ? ok([{ path: 'a', content: '1\terror\tnet\tboom\t\n' }]) : ok(null)));
    expect(await processBlocker(ctx, 'i1')).toBe('client main error log: 1\terror\tnet\tboom\t');
    serve(client());
    vi.mocked(instanceServerLog).mockResolvedValueOnce('not json\n{"level":"error","message":"bad"}\n');
    expect(await processBlocker(ctx, 'i1')).toBe('server error log: {"level":"error","message":"bad"}');
  });

  it('with a cursor, reads the server log from the byte after the last checked line and scans only new client log lines', async () => {
    const cursor = new LogCursor();
    let clientText = '1\tinfo\tnet\té\t\n2\tinfo';
    serve((command) => (command === 'extract_logs' ? ok([{ path: 'a', content: clientText }]) : ok(null)));
    vi.mocked(instanceServerLog).mockResolvedValueOnce('{"level":"info","m":"é"}\n{"lev');
    expect(await processBlocker(ctx, 'i1', cursor)).toBeNull();
    expect(instanceServerLog).toHaveBeenLastCalledWith(ctx, 'i1', 0);
    expect(cursor.server).toBe(Buffer.byteLength('{"level":"info","m":"é"}\n'));
    expect(cursor.clients.get('main')).toEqual(new Map([['a', Buffer.byteLength('1\tinfo\tnet\té\t\n')]]));
    vi.mocked(instanceServerLog).mockResolvedValueOnce('{"level":"info"}\n');
    expect(await processBlocker(ctx, 'i1', cursor)).toBeNull();
    expect(instanceServerLog).toHaveBeenLastCalledWith(ctx, 'i1', Buffer.byteLength('{"level":"info","m":"é"}\n'));
    clientText = '1\tinfo\tnet\té\t\n2\terror\tnet\tlate\t\n';
    expect(await processBlocker(ctx, 'i1', cursor)).toBe('client main error log: 2\terror\tnet\tlate\t');
    clientText = '9\terror\tx\t';
    expect(await processBlocker(ctx, 'i1', cursor)).toBe('client main error log: 9\terror\tx\t');
  });

  it('with a cursor, reads a new log file from its start after the oldest file is deleted', async () => {
    const cursor = new LogCursor();
    const info = (n: number): string => `${String(n)}\tinfo\tnet\t${'x'.repeat(40)}\t\n`;
    const log1 = Array.from({ length: 10 }, (_, i) => info(i)).join('');
    const log2 = Array.from({ length: 4 }, (_, i) => info(i)).join('');
    let files = [
      { path: 'log/log_1.txt', content: log1 },
      { path: 'log/log_2.txt', content: log2 },
    ];
    serve((command) => (command === 'extract_logs' ? ok(files) : ok(null)));
    expect(await processBlocker(ctx, 'i1', cursor)).toBeNull();
    // A new boot starts log_3 and deletes log_1; the joined text does not get shorter than before.
    const log3 = `${info(1)}7\terror\tnet\tafter restart\t\n${log1}`;
    files = [
      { path: 'log/log_2.txt', content: log2 },
      { path: 'log/log_3.txt', content: log3 },
    ];
    expect(log2.length + log3.length).toBeGreaterThan(log1.length + log2.length);
    expect(await processBlocker(ctx, 'i1', cursor)).toBe('client main error log: 7\terror\tnet\tafter restart\t');
    files = [{ path: 'log/log_3.txt', content: log1 }];
    const fresh = new LogCursor();
    expect(await processBlocker(ctx, 'i1', fresh)).toBeNull();
    expect(fresh.clients.get('main')).toEqual(new Map([['log/log_3.txt', Buffer.byteLength(log1)]]));
  });

  it('with a cursor, asks extract_logs for each file from its checked byte offset and reads only what the client sends', async () => {
    const cursor = new LogCursor();
    const first = '1\tinfo\tnet\té\t\n';
    const requests: string[][] = [];
    let answer: unknown[] = [{ path: 'a', offset: 0, content: `${first}2\tinfo`, size: Buffer.byteLength(`${first}2\tinfo`) }];
    serve((command, args) => {
      if (command !== 'extract_logs') return ok(null);
      requests.push(args);
      return ok(answer);
    });
    vi.mocked(instanceServerLog).mockResolvedValue('');
    expect(await processBlocker(ctx, 'i1', cursor)).toBeNull();
    expect(requests[0]).toEqual([JSON.stringify({})]);
    const checked = Buffer.byteLength(first);
    expect(cursor.clients.get('main')).toEqual(new Map([['a', checked]]));
    // the client sends the file from that offset on
    answer = [{ path: 'a', offset: checked, content: '2\terror\tnet\tlate\t\n', size: checked + 20 }];
    expect(await processBlocker(ctx, 'i1', cursor)).toBe('client main error log: 2\terror\tnet\tlate\t');
    expect(requests[1]).toEqual([JSON.stringify({ a: checked })]);
    // a file that got shorter than its offset comes again from offset 0
    answer = [{ path: 'a', offset: 0, content: '3\tinfo\tx\t\n', size: 12 }];
    const later = new LogCursor();
    later.clients.set('main', new Map([['a', 500]]));
    expect(await processBlocker(ctx, 'i1', later)).toBeNull();
    expect(later.clients.get('main')).toEqual(new Map([['a', Buffer.byteLength('3\tinfo\tx\t\n')]]));
  });
});

describe('runScenario', () => {
  it('runs every step, calls afterStep, and evaluates the goal', async () => {
    serve(client());
    const after: number[] = [];
    const outcome = await runScenario(ctx, 'i1', scenario([step('tap'), step('key', { args: ['a'] })]), {
      pollMs: 1,
      afterStep: (n) => {
        after.push(n);
        return Promise.resolve();
      },
    });
    expect(outcome).toEqual({ stop: null, goal: true });
    expect(after).toEqual([1, 2]);
    expect(calls).toContain('key a');
  });

  it('spaces the inputs of an auto step by twice the game button click interval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-gap-'));
    mkdirSync(join(root, 'client', 'generated'), { recursive: true });
    writeFileSync(join(root, 'client', 'generated', 'core_settings.json'), JSON.stringify({ 'UICore.buttonClickIntervalMs': 40 }));
    vi.mocked(readRecord).mockResolvedValueOnce({ root } as InstanceRecord);
    const taps: number[] = [];
    serve((command) => {
      if (command === 'f.bot_next_input') return ok({ command: 'tap_anchor', args: ['card'] });
      if (command === 'tap_anchor') taps.push(Date.now());
      if (command === 'get_telemetry') return ok({ goal_intervals: taps.length >= 3 ? [{}] : [] });
      if (command === 'get_state') return ok(doneState());
      return ok(null);
    });
    const auto = { kind: 'auto' as const, command: 'f.bot_next_input', args: [], until: goal, timeoutMs: 5000 };
    expect(await runScenario(ctx, 'i1', scenario([auto]), { pollMs: 1 })).toEqual({ stop: null, goal: true });
    expect(taps).toHaveLength(3);
    for (let i = 1; i < taps.length; i += 1) expect((taps[i] as number) - (taps[i - 1] as number)).toBeGreaterThanOrEqual(80);
  });

  it('picks each auto input after the gap and puts it in at once; no gap without the key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-gap-'));
    mkdirSync(join(root, 'client', 'generated'), { recursive: true });
    writeFileSync(join(root, 'client', 'generated', 'core_settings.json'), JSON.stringify({ 'UICore.buttonClickIntervalMs': 40 }));
    vi.mocked(readRecord).mockResolvedValueOnce({ root } as InstanceRecord);
    const events: [string, number][] = [];
    const auto = { kind: 'auto' as const, command: 'f.bot_next_input', args: [], until: goal, timeoutMs: 5000 };
    const serveTaps = (): void => {
      events.length = 0;
      serve((command) => {
        if (command === 'f.bot_next_input') events.push(['pick', Date.now()]);
        if (command === 'f.bot_next_input') return ok({ command: 'tap_anchor', args: ['card'] });
        if (command === 'tap_anchor') events.push(['tap', Date.now()]);
        if (command === 'get_telemetry') return ok({ goal_intervals: events.filter((e) => e[0] === 'tap').length >= 3 ? [{}] : [] });
        if (command === 'get_state') return ok(doneState());
        return ok(null);
      });
    };
    serveTaps();
    expect(await runScenario(ctx, 'i1', scenario([auto]), { pollMs: 1 })).toEqual({ stop: null, goal: true });
    for (let i = 0; i + 1 < events.length; i += 2) {
      expect(events[i]?.[0]).toBe('pick');
      expect((events[i + 1]?.[1] as number) - (events[i]?.[1] as number)).toBeLessThan(40);
    }
    // a core_settings.json without UICore.buttonClickIntervalMs: no gap
    const bare = mkdtempSync(join(tmpdir(), 'ogw-gap-'));
    mkdirSync(join(bare, 'client', 'generated'), { recursive: true });
    writeFileSync(join(bare, 'client', 'generated', 'core_settings.json'), JSON.stringify({ 'QACore.commandTimeoutMs': 1000 }));
    vi.mocked(readRecord).mockResolvedValueOnce({ root: bare } as InstanceRecord);
    expect(await autoInputGapMs(ctx, 'i1')).toBe(0);
  });

  it('stops at the blocker of a client the runner did not start, after the process blocker', async () => {
    serve(client());
    const seen: string[] = [];
    const blocker = (): Promise<string | null> => {
      seen.push('asked');
      return Promise.resolve(seen.length >= 2 ? 'browser page crashed' : null);
    };
    const outcome = await runScenario(ctx, 'i1', scenario([step('tap'), step('key')]), { pollMs: 1, blocker });
    expect(outcome).toEqual({ stop: { step: 2, message: 'browser page crashed', blocker: true }, goal: false });
    vi.mocked(instanceProcesses).mockResolvedValue({ server: false, clients: [] });
    seen.length = 0;
    const first = await runScenario(ctx, 'i1', scenario([step('tap')]), { pollMs: 1, blocker });
    expect(first.stop?.message).toBe('server process ended');
    expect(seen).toEqual([]);
  });

  it('names the outside blocker when a request fails', async () => {
    serve((command, args, c) => {
      if (command === 'tap') throw new Error('channel closed');
      return client()(command, args, c);
    });
    const outcome = await runScenario(ctx, 'i1', scenario([step('tap')]), { pollMs: 1, blocker: () => Promise.resolve('client process main ended') });
    expect(outcome.stop).toEqual({ step: 1, message: 'client process main ended', blocker: true });
  });

  it('stops as no blocker when the outside blocker cannot read its client log, in a step and after a failed request', async () => {
    const unreadable = (): Promise<string | null> => Promise.reject(new ClientLogUnreadable('client main log could not be read: extract_logs failed: gone'));
    serve(client());
    const inStep = await runScenario(ctx, 'i1', scenario([step('tap')]), { pollMs: 1, blocker: unreadable });
    expect(inStep.stop).toEqual({ step: 1, message: 'client main log could not be read: extract_logs failed: gone', blocker: false });
    serve((command, args, c) => {
      if (command === 'tap') throw new Error('channel closed');
      return client()(command, args, c);
    });
    const failed = await runScenario(ctx, 'i1', scenario([step('tap')]), { pollMs: 1, blocker: unreadable });
    expect(failed.stop).toEqual({ step: 1, message: 'tap failed: channel closed', blocker: false });
  });

  it('reports a false goal', async () => {
    serve(client(doneState(), { goal_intervals: [] }));
    expect(await runScenario(ctx, 'i1', scenario([step('tap')]), { pollMs: 1 })).toEqual({ stop: null, goal: false });
  });

  it('stops at a command with ok false', async () => {
    serve((command, args, c) => (command === 'key' ? notOk('no such key') : client()(command, args, c)));
    const outcome = await runScenario(ctx, 'i1', scenario([step('tap'), step('key')]), { pollMs: 1 });
    expect(outcome).toEqual({ stop: { step: 2, message: 'key returned ok false: "no such key"', blocker: true }, goal: false });
  });

  it('stops at a blocker in the state', async () => {
    serve(client(doneState({ softlock: { kind: 'NoResponse', elapsed_ms: 9 } })));
    const outcome = await runScenario(ctx, 'i1', scenario([step('tap')]), { pollMs: 1 });
    expect(outcome.stop).toEqual({ step: 1, message: 'softlock {"kind":"NoResponse","elapsed_ms":9}', blocker: true });
  });

  it('stops at a blocker of the processes after the step', async () => {
    serve(client());
    vi.mocked(instanceProcesses).mockResolvedValue({ server: false, clients: [] });
    const outcome = await runScenario(ctx, 'i1', scenario([step('tap')]), { pollMs: 1 });
    expect(outcome.stop).toEqual({ step: 1, message: 'server process ended', blocker: true });
  });

  it('waits for until and fails when timeoutMs passes', async () => {
    let polls = 0;
    serve((command, args, c) => {
      if (command === 'get_state') return ok(doneState({ scene_key: ++polls >= 3 ? 'battle' : 'lobby' }));
      return client()(command, args, c);
    });
    const until = { path: 'state.scene_key', op: 'eq' as const, value: 'battle' };
    expect((await runScenario(ctx, 'i1', scenario([step('tap', { until })]), { pollMs: 1 })).stop).toBeNull();
    expect(polls).toBeGreaterThanOrEqual(3);
    const never = { path: 'state.scene_key', op: 'eq' as const, value: 'nowhere' };
    const outcome = await runScenario(ctx, 'i1', scenario([step('tap', { until: never, timeoutMs: 30 })]), { pollMs: 5 });
    expect(outcome.stop).toEqual({ step: 1, message: 'step did not end within 30 ms', blocker: true });
  });

  it('reads telemetry only for telemetry conditions', async () => {
    serve(client());
    await runScenario(ctx, 'i1', scenario([step('tap', { until: { path: 'state.boot_stage', op: 'eq', value: 'Done' } })]), { pollMs: 1 });
    expect(calls.filter((c) => c === 'get_telemetry')).toHaveLength(1);
  });

  it('auto step inserts the input the bot command returns until the condition holds', async () => {
    let moves = 0;
    let turn = 0;
    serve((command, args, c) => {
      if (command === 'm3.bot_next_input') return ok(++turn % 2 === 0 ? null : { command: 'drag', args: ['1', '2', '3', '4', '0'] });
      if (command === 'drag') {
        moves++;
        return ok(null);
      }
      if (command === 'get_state') return ok(doneState({ moves }));
      return client()(command, args, c);
    });
    const auto = step('m3.bot_next_input', { kind: 'auto', until: { path: 'state.moves', op: 'gte', value: 2 } });
    expect((await runScenario(ctx, 'i1', scenario([auto]), { pollMs: 1 })).stop).toBeNull();
    expect(moves).toBe(2);
    expect(calls.filter((c) => c === 'm3.bot_next_input')).toHaveLength(3);
  });

  it('auto step stops (not a blocker) when the bot command returns another form', async () => {
    serve((command, args, c) => (command === 'm3.bot_next_input' ? ok({ command: 'drag', args: [1] }) : client()(command, args, c)));
    const auto = step('m3.bot_next_input', { kind: 'auto', until: goal });
    const outcome = await runScenario(ctx, 'i1', scenario([auto]), { pollMs: 1 });
    expect(outcome.stop).toEqual({ step: 1, message: 'm3.bot_next_input returned no input command: {"command":"drag","args":[1]}', blocker: false });
    serve((command, args, c) => (command === 'm3.bot_next_input' ? ok(5) : client()(command, args, c)));
    expect((await runScenario(ctx, 'i1', scenario([auto]), { pollMs: 1 })).stop?.message).toBe('m3.bot_next_input returned no input command: 5');
    serve((command, args, c) => (command === 'm3.bot_next_input' ? ok({ args: [] }) : client()(command, args, c)));
    expect((await runScenario(ctx, 'i1', scenario([auto]), { pollMs: 1 })).stop?.blocker).toBe(false);
  });

  function restarting(content: () => unknown, failures: number): Handler {
    let booting = 0;
    return (command, args, c) => {
      if (command === 'restart' || command === 'set_language') {
        booting = failures;
        return ok(null);
      }
      if (command === 'get_state') {
        if (booting > 0) {
          booting--;
          if (booting % 2 === 0) throw new Error('channel closed');
          return ok(doneState({ boot_stage: 'Login' }));
        }
        return ok(doneState({ content: content() }));
      }
      return client()(command, args, c);
    };
  }

  it('save step compares content before and after restart, waiting for Done through a closed channel', async () => {
    serve(restarting(() => ({ gold: 5 }), 4));
    const save = { kind: 'save' as const, command: null, args: [], until: null, timeoutMs: 2000 };
    expect((await runScenario(ctx, 'i1', scenario([save]), { pollMs: 1 })).stop).toBeNull();
    let gold = 0;
    serve(restarting(() => ({ gold: gold++ }), 2));
    expect((await runScenario(ctx, 'i1', scenario([save]), { pollMs: 1 })).stop).toEqual({
      step: 1,
      message: 'save: content differs after restart: {"gold":0} then {"gold":2}',
      blocker: false,
      failedStep: true,
    });
  });

  it('save step compares content without regard to key order', async () => {
    let restarted = false;
    serve((command, args, c) => {
      if (command === 'restart') restarted = true;
      if (command === 'get_state') return ok(doneState({ content: restarted ? { gems: 1, gold: 5 } : { gold: 5, gems: 1 } }));
      return client()(command, args, c);
    });
    const save = { kind: 'save' as const, command: null, args: [], until: null, timeoutMs: 2000 };
    expect((await runScenario(ctx, 'i1', scenario([save]), { pollMs: 1 })).stop).toBeNull();
    expect(restarted).toBe(true);
  });

  it('a restart step waits for Done and fails when boot does not end in time', async () => {
    serve(restarting(() => ({}), 3));
    expect((await runScenario(ctx, 'i1', scenario([step('restart', { kind: 'setup' })]), { pollMs: 1 })).stop).toBeNull();
    serve(restarting(() => ({}), 10_000));
    const outcome = await runScenario(ctx, 'i1', scenario([step('set_language', { kind: 'setup', args: ['en'], timeoutMs: 20 })]), { pollMs: 2 });
    expect(outcome.stop).toEqual({ step: 1, message: 'step did not end within 20 ms: boot_stage is not Done', blocker: true });
  });

  it('a request that throws is named by the process blocker, or by its error', async () => {
    serve((command, args, c) => {
      if (command === 'tap') throw new Error('socket closed');
      return client()(command, args, c);
    });
    vi.mocked(instanceProcesses).mockResolvedValueOnce({ server: true, clients: [{ client: 'main', alive: false }] });
    expect((await runScenario(ctx, 'i1', scenario([step('tap')]), { pollMs: 1 })).stop?.message).toBe('client process main ended');
    expect((await runScenario(ctx, 'i1', scenario([step('tap')]), { pollMs: 1 })).stop).toEqual({ step: 1, message: 'tap failed: socket closed', blocker: false });
  });

  it('a server log that cannot be read stops the run as no blocker, not as an empty log', async () => {
    vi.mocked(instanceServerLog).mockRejectedValueOnce(new Error('EACCES: permission denied'));
    await expect(processBlocker(ctx, 'i1')).rejects.toThrow('the server log could not be read: EACCES: permission denied');
    serve(client());
    vi.mocked(instanceServerLog).mockRejectedValueOnce(new Error('EACCES: permission denied'));
    expect((await runScenario(ctx, 'i1', scenario([step('tap')]), { pollMs: 1 })).stop).toEqual({ step: 1, message: 'the server log could not be read: EACCES: permission denied', blocker: false });
  });

  it('stops outside the no blocker fail list are not blockers', async () => {
    serve((command, args, c) => (command === 'get_state' ? ok('not a state') : client()(command, args, c)));
    expect((await runScenario(ctx, 'i1', scenario([step('tap')]), { pollMs: 1 })).stop).toEqual({ step: 1, message: 'get_state returned no QAState', blocker: false });
    serve((command, args, c) => {
      if (command === 'restart') throw new Error('restart refused');
      return client()(command, args, c);
    });
    expect((await runScenario(ctx, 'i1', scenario([step('restart', { kind: 'setup' })]), { pollMs: 1 })).stop).toEqual({ step: 1, message: 'restart refused', blocker: false });
  });

  it('a client log that cannot be read stops the run without a blocker', async () => {
    serve((command, args, c) => (command === 'extract_logs' ? notOk('no LogCore') : client()(command, args, c)));
    expect((await runScenario(ctx, 'i1', scenario([step('tap')]), { pollMs: 1 })).stop).toEqual({
      step: 1,
      message: 'client main log could not be read: extract_logs returned "no LogCore"',
      blocker: false,
    });
    serve((command, args, c) => (command === 'extract_logs' ? ok({ files: [] }) : client()(command, args, c)));
    expect((await runScenario(ctx, 'i1', scenario([step('tap')]), { pollMs: 1 })).stop?.blocker).toBe(false);
  });

  it('a request that throws on a live client whose extract_logs throws too stops on the request error without a blocker', async () => {
    serve((command, args, c) => {
      if (command === 'tap' || command === 'extract_logs') throw new Error('request timed out');
      return client()(command, args, c);
    });
    expect((await runScenario(ctx, 'i1', scenario([step('tap')]), { pollMs: 1 })).stop).toEqual({ step: 1, message: 'tap failed: request timed out', blocker: false });
  });

  it('a command that does not answer before timeoutMs fails the step', async () => {
    vi.mocked(automationRequest).mockImplementation((_c, _i, command) =>
      command === 'tap' ? new Promise(() => undefined) : Promise.resolve(client()(command, [], undefined)),
    );
    const outcome = await runScenario(ctx, 'i1', scenario([step('tap', { timeoutMs: 15 })]), { pollMs: 1 });
    expect(outcome.stop).toEqual({ step: 1, message: 'step did not end within 15 ms', blocker: true });
  });

  it('passes errors that are not stops through', async () => {
    serve(client());
    vi.mocked(instanceProcesses).mockRejectedValue(new Error('probe broken'));
    await expect(runScenario(ctx, 'i1', scenario([step('tap')]), { pollMs: 1 })).rejects.toThrow('probe broken');
  });
});
