import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { alternateSide, evaluateDeps, judgeAgent } from '../../../src/commands/loop/lib/evaluate.ts';
import type { EvaluateFile } from '../../../src/commands/loop/lib/files.ts';
import { ogw } from '../../helpers/workspace.ts';
import { commit, git, openBuildRun, openLoopRun, read, readJsonFile, REFERENCE_MD, setRun, setupGame, write, type TestGame } from './helpers.ts';

interface FakeInstance {
  id: string;
  commit: string;
  platform?: string;
  fixture?: string;
  /** Content of the save fixture file when the instance started, or null when there was no file. */
  fixtureText?: string | null;
  db?: string;
  played?: boolean;
  client?: string;
  root: string;
  startedAt: number;
}

interface FakeAgent {
  id: string;
  role: string;
  input: Record<string, unknown>;
  output: string;
  /** The agent CLI, model and effort `ogw loop evaluate` gave the job. */
  agent?: { cli?: string; model: string; effort: string };
}

interface Fake {
  instances: FakeInstance[];
  running: Set<string>;
  stopped: string[];
  agents: FakeAgent[];
  root: string;
  run: string;
  /** The result text, null for a failed agent, undefined for an agent still running. */
  respond: (agent: FakeAgent, k: number) => string | null | undefined;
  /** `StartFailure` reason of a failed start, or null to start. */
  failStart: (opts: Record<string, unknown>) => string | null;
  others: number;
  /** `others` becomes 0 after this many `listInstances` calls; null keeps it. */
  othersListed: number | null;
  /** Instances running (with `others`) when each instance start succeeded, before it was added. */
  runningAtStart: number[];
  /** Boot of an instance after its slot was reserved; the start fails when the instance was stopped meanwhile. */
  booting: (id: string) => Promise<void>;
  /** Called inside `startAgentJob` before it returns the new job id. */
  agentStarting: (id: string) => void;
  /** Wait for a slot with the start's abort signal, before the instance id is reserved. */
  reserving: (signal: AbortSignal | undefined) => Promise<void>;
}

const fake = vi.hoisted(
  (): Fake => ({
    instances: [],
    running: new Set<string>(),
    stopped: [],
    agents: [],
    root: '',
    run: 'update-1',
    respond: () => '',
    failStart: () => null,
    others: 0,
    othersListed: null,
    runningAtStart: [],
    booting: () => Promise.resolve(),
    agentStarting: () => undefined,
    reserving: () => Promise.resolve(),
  }),
);

vi.mock('../../../src/commands/instance/api.ts', () => ({
  startInstance: vi.fn(async (_ctx: unknown, opts: Record<string, unknown>, hooks: { onReserved?: (id: string) => void; signal?: AbortSignal } = {}) => {
    const { OgwError } = await import('../../../src/lib/errors.ts');
    // like `reserveSlot`: an aborted signal ends the wait for a slot without one
    await fake.reserving(hooks.signal);
    if (hooks.signal?.aborted === true) throw new OgwError('instance start was stopped', 1, { reason: 'start' });
    const reason = fake.failStart(opts);
    if (reason !== null) throw new OgwError(`cannot start ${String(opts.fixture ?? opts.commit)}`, 1, { reason });
    const id = `i${String(fake.instances.length + 1)}`;
    const root = join(fake.root, '..', 'instances', id);
    const fixture = opts.fixture as string | undefined;
    const fixtureText = fixture === undefined ? undefined : existsSync(fixture) ? readFileSync(fixture, 'utf8') : null;
    const info = { id, commit: opts.commit as string, platform: opts.platform as string | undefined, fixture, fixtureText, db: opts.db as string | undefined, played: opts.played as boolean | undefined, client: opts.client as string | undefined, root, startedAt: 100 };
    fake.instances.push(info);
    fake.runningAtStart.push(fake.running.size + fake.others);
    const stops = fake.stopped.length;
    hooks.onReserved?.(id);
    // the detached supervisor runs from here on
    fake.running.add(id);
    await fake.booting(id);
    if (fake.stopped.slice(stops).includes(id)) throw new OgwError(`instance not found: ${id}`, 1, { reason: 'start' });
    return { ...info, game: 'g', serverUrl: '', adminSecret: '' };
  }),
  stopInstance: vi.fn((_ctx: unknown, id: string) => {
    fake.running.delete(id);
    fake.stopped.push(id);
    return Promise.resolve();
  }),
  listInstances: vi.fn(() => {
    if (fake.othersListed !== null && --fake.othersListed <= 0) fake.others = 0;
    return Promise.resolve([...[...fake.running].map((id) => ({ id })), ...Array.from({ length: fake.others }, (_v, i) => ({ id: `o${String(i)}` }))]);
  }),
}));

const counters = vi.hoisted(() => ({ play: 0, judge: 0 }));

vi.mock('../../../src/commands/agent/api.ts', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  return {
    startAgentJob: vi.fn((_ctx: unknown, options: { role: 'play' | 'judge'; input: string; agent?: FakeAgent['agent'] }) => {
      const id = `a${String(fake.agents.length + 1)}`;
      counters[options.role]++;
      const output = path.join(fake.root, 'records', 'loops', fake.run, `${options.role}-1-${String(counters[options.role])}.md`);
      const input = JSON.parse(fs.readFileSync(options.input, 'utf8')) as Record<string, unknown>;
      fake.agents.push({ id, role: options.role, input, output, ...(options.agent === undefined ? {} : { agent: options.agent }) });
      fake.agentStarting(id);
      return Promise.resolve(id);
    }),
    agentOutcome: vi.fn((_ctx: unknown, id: string) => {
      const agent = fake.agents.find((a) => a.id === id) as FakeAgent;
      const k = fake.agents.filter((a) => a.role === agent.role).indexOf(agent) + 1;
      const text = fake.respond(agent, k);
      if (text === undefined) return Promise.resolve({ status: 'running', output: null });
      if (text === null) return Promise.resolve({ status: 'failed', output: null });
      fs.mkdirSync(path.dirname(agent.output), { recursive: true });
      fs.writeFileSync(agent.output, text);
      return Promise.resolve({ status: 'done', output: agent.output });
    }),
    mergeAgentJobs: vi.fn(),
    retryAgentJob: vi.fn(),
  };
});

const killed = vi.hoisted(() => [] as string[]);

vi.mock('../../../src/lib/jobs.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/jobs.ts')>()),
  killJob: vi.fn((id: string) => {
    killed.push(id);
    return Promise.resolve();
  }),
}));

const measure = vi.hoisted(() => ({ collected: [] as string[][], collect: [] as [string, string][], dead: [] as string[] }));

vi.mock('../../../src/commands/telemetry/api.ts', () => ({
  telemetrySummary: vi.fn((_ctx: unknown, id: string) =>
    measure.dead.includes(id) ? Promise.reject(new Error('get_telemetry failed: client channel closed\nmore')) : Promise.resolve([`device ms: ${id}`, 'scenes: lobby']),
  ),
}));
vi.mock('../../../src/commands/measure/api.ts', () => ({
  collectMeasure: vi.fn((_ctx: unknown, _game: string, id: string, out: string) => {
    if (measure.dead.includes(id)) return Promise.reject(new Error('get_telemetry failed'));
    measure.collect.push([id, out]);
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, '{}');
    return Promise.resolve();
  }),
  measureCollected: vi.fn((_ctx: unknown, _game: string, files: string[]) => {
    measure.collected.push(files);
    const out = join(fake.root, 'records', 'loops', fake.run, 'measure-1.json');
    writeFileSync(out, '{"commit":"x","targets":[]}\n');
    return Promise.resolve({ path: out, commit: 'x', targets: [] });
  }),
}));

/** The bot runs of the shared telemetry: by instance id, the telemetry, or null for a run that did not reach every step. */
const bots = vi.hoisted(() => ({ runs: [] as { id: string; commit: string; pollMs: number }[], fail: new Set<string>() }));

vi.mock('../../../src/commands/loop/lib/shared-telemetry.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/loop/lib/shared-telemetry.ts')>()),
  botRun: vi.fn((_ctx: unknown, instance: { id: string }, _scenario: unknown, pollMs: number) => {
    const commit = fake.instances.find((i) => i.id === instance.id)?.commit ?? '';
    bots.runs.push({ id: instance.id, commit, pollMs });
    if (bots.fail.has(commit)) return Promise.resolve(null);
    // this commit answers input 30 ms late, the baseline 90 ms
    const latency = bots.runs.length === 1 ? 30 : 90;
    const telemetry = { started_at: 0, inputs: [{ at: 10, command: 'tap', latency_ms: latency, feedback: { sound: 1 } }], rewards: [], marks: [], idle_spans: [], goal_intervals: [], scene_loads: [], dropped: 0 };
    return Promise.resolve({ telemetry, guide: null });
  }),
}));

const R = 'records/loops/update-1';

function judgeText(winner: string, side: string, reference: string): string {
  return [
    '## vs baseline', '', '| element | winner | margin | reason | evidence |', '|---|---|---|---|---|', `| game feel | ${winner} | clear | r | e |`, '',
    '## vs reference', '', '| instance | element | result | reason | evidence |', '|---|---|---|---|---|', `| ${side} | game feel | ${reference} | r | e |`, '',
  ].join('\n');
}

const PASS_ALL = ['regression test', 'static check', 'no blocker', 'full flow', 'performance', 'UI quality', 'no placeholder'];

async function loop(settings: Record<string, unknown> = {}, checks = PASS_ALL): Promise<{ g: TestGame; head: string; base: string }> {
  const g = setupGame({ playInstances: 2, backgroundRetryLimit: 1, loopStop: { repeatedDefect: 3, oscillation: 2, plateau: 3, successJudges: 2 }, ...settings });
  const run = await openLoopRun(g, { iteration: 1 });
  write(g.root, `${R}/request.md`, '## judge moments\n\n- `boss`: reach the boss\n- `broken` (set by lead agent): never loads\n');
  write(g.root, 'client/dev/bot/fixtures/boss.json', '{"steps": []}\n');
  const head = commit(g.root);
  write(g.root, `${R}/check-1.json`, { commit: head, checks: checks.map((name) => ({ name, platform: null, result: 'pass', failures: [], warnings: [] })), gate: 'pass' });
  commit(g.root);
  fake.root = g.root;
  return { g, head, base: run.baseCommit };
}

const signalDeps = { onSignal: evaluateDeps.onSignal, resignal: evaluateDeps.resignal, signalSettleMs: evaluateDeps.signalSettleMs };

/** What was cleaned up when the signal handler sent the signal again, which ends the process in production. */
interface Resignal {
  signal: NodeJS.Signals;
  killed: string[];
  running: string[];
  /** Ids of the instances started (reserved) so far. */
  instances: string[];
}

/**
 * Replaces the signal handling: `send` calls the evaluate handler like a SIGTERM would, and `resignals` records the
 * state at each resignal. The run goes on after the resignal here, so only cleanup done before it counts.
 */
function trapSignals(): { send: () => void; resignals: Resignal[]; offCalls: () => number } {
  let handler: ((signal: NodeJS.Signals) => void) | null = null;
  let offCalls = 0;
  evaluateDeps.onSignal = (h) => {
    handler = h;
    return () => {
      offCalls++;
    };
  };
  const resignals: Resignal[] = [];
  evaluateDeps.resignal = (signal) => {
    resignals.push({ signal, killed: [...killed], running: [...fake.running], instances: fake.instances.map((i) => i.id) });
  };
  return {
    send: () => handler?.('SIGTERM'),
    resignals,
    offCalls: () => offCalls,
  };
}

beforeEach(() => {
  evaluateDeps.onSignal = signalDeps.onSignal;
  evaluateDeps.resignal = signalDeps.resignal;
  evaluateDeps.signalSettleMs = signalDeps.signalSettleMs;
  killed.length = 0;
  fake.instances = [];
  fake.running = new Set();
  fake.stopped = [];
  fake.agents = [];
  fake.run = 'update-1';
  fake.others = 0;
  fake.othersListed = null;
  fake.runningAtStart = [];
  fake.booting = () => Promise.resolve();
  fake.agentStarting = () => undefined;
  fake.reserving = () => Promise.resolve();
  fake.failStart = (opts) => (typeof opts.fixture === 'string' && opts.fixture.endsWith('broken.json') ? 'fixture' : null);
  counters.play = 0;
  counters.judge = 0;
  measure.collected = [];
  measure.collect = [];
  measure.dead = [];
  bots.runs = [];
  bots.fail = new Set();
  evaluateDeps.pollMs = 0;
  evaluateDeps.botPollMs = 7;
  evaluateDeps.random = () => 0.1;
  let ms = 1000;
  evaluateDeps.now = () => ms;
  ms += 0;
});

describe('judgeAgent', () => {
  it('gives each panel item two judges in a row, in turn, so that with alternating sides it judges both sides', () => {
    const panel = ['a', 'b', 'c'].map((model) => ({ cli: 'claude-code' as const, model, effort: 'high' }));
    const settings = { loop: { funIterations: 3, judgeVotes: 8, judgePanel: panel, variants: 1, playTimeLimitMs: 2700000, judgeTimeLimitMs: 3600000 }, agents: {} };
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((k) => judgeAgent(settings, k).model)).toEqual(['a', 'a', 'b', 'b', 'c', 'c', 'a', 'a']);
    expect([1, 2, 3, 4].map((k) => alternateSide('A', k))).toEqual(['A', 'B', 'A', 'B']);
  });
});

describe('ogw loop evaluate', () => {
  it('plays, judges, confirms success, measures, writes and commits evaluate-<n>.json', async () => {
    const { g, head, base } = await loop();
    const plays = new Map<string, number>();
    fake.respond = (agent) => {
      if (agent.role === 'play') {
        const tries = (plays.get(String(agent.input.platform)) ?? 0) + 1;
        const instance = String(agent.input.instance);
        // the boss play agent fails once
        if (instance === 'i11') return null;
        plays.set(instance, tries);
        return '## coverage\n\nunknown: none\n\n## observations\n\n1 | lobby | tap | ok | fine | none | c.png\n';
      }
      const sideA = (agent.input.A as { instance: string }).instance;
      const isThis = fake.instances.find((i) => i.id === sideA)?.commit === head;
      const side = isThis ? 'A' : 'B';
      const n = fake.agents.filter((a) => a.role === 'judge').indexOf(agent);
      return judgeText(side, side, n === 3 ? 'fail' : 'pass');
    };
    // the working tree file is not the one the instances get: the work branch HEAD file is
    write(g.root, 'client/dev/bot/fixtures/boss.json', '{"steps": [1]}\n');
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.commit).toBe(head);
    expect(file.baseline).toBe(base);
    expect(file.measure).toBe(`${R}/measure-1.json`);
    // ogw loop input did not ask for memorable_moment in this run
    expect(file.memorableMoment).toBeUndefined();
    const agent = { cli: 'claude-code', model: 'claude-opus-5-5', effort: 'high' };
    const entry = { agent, omittedMoments: [], votes: { 'game feel': 'this', 'tension and release': null, progression: null, 'one more run': null, 'no friction': null, presentation: null }, lostMoments: [], telemetry: null, status: 'done' };
    expect(file.judges).toEqual([
      { kind: 'main', result: `${R}/judge-1-1.md`, A: head, B: base, instanceSide: 'A', vsReference: 'pass', ...entry },
      { kind: 'main', result: `${R}/judge-1-2.md`, A: base, B: head, instanceSide: 'B', vsReference: 'pass', ...entry },
      { kind: 'success', result: `${R}/judge-1-3.md`, A: head, B: base, instanceSide: 'A', vsReference: 'pass', ...entry },
      { kind: 'success', result: `${R}/judge-1-4.md`, A: head, B: base, instanceSide: 'A', vsReference: 'fail', ...entry },
    ]);
    expect(file).toMatchObject({ kind: 'completeness', elements: ['game feel', 'tension and release', 'progression', 'one more run', 'no friction', 'presentation'], vsBaseline: 'better', vsReference: 'pass' });
    expect(file.votes?.[0]).toEqual({ element: 'game feel', this: 2, baseline: 0, decision: 'this' });
    expect(file.votes?.slice(1).every((v) => v.decision === 'indistinguishable')).toBe(true);
    // every judge runs with harness settings agents.judge while loop.judgePanel is empty
    expect(fake.agents.filter((a) => a.role === 'judge').map((a) => a.agent)).toEqual(Array.from({ length: 4 }, () => agent));
    expect(file.plays.map((p) => [p.platform, p.moment, p.status])).toEqual([
      ['android', null, 'done'],
      ['web', null, 'done'],
      ['android', 'boss', 'done'],
      ['android', 'broken', 'failed'],
    ]);
    expect(file.plays[3]).toEqual({ result: '', instance: '', platform: 'android', moment: 'broken', status: 'failed' });
    // main judge: this commit, baseline, boss pair; broken fixtures are null
    const mainInput = fake.agents[0]?.input as { A: { instance: string; playGuide: string }; B: { instance: string }; fixtures: unknown[]; reference: unknown; elements: string[]; telemetry: unknown };
    expect(mainInput.elements).toEqual(file.elements);
    expect(mainInput.telemetry).toBeNull();
    // the second step 4 judge: the other side
    expect((fake.agents[1]?.input as { A: { instance: string } }).A.instance).toBe('i5');
    expect(fake.instances.find((i) => i.id === 'i5')?.commit).toBe(base);
    expect(mainInput.A).toEqual({ instance: 'i1', playGuide: join(g.root, '..', 'instances', 'i1', 'play-guide.md') });
    expect(mainInput.B.instance).toBe('i2');
    expect(mainInput.fixtures).toEqual([
      { moment: { name: 'boss', description: 'reach the boss' }, A: 'i3', B: 'i4' },
      { moment: { name: 'broken', description: 'never loads' }, A: null, B: null },
    ]);
    expect(mainInput.reference).toEqual({
      name: 'Hollow Run',
      presentation: 'Hollow Run',
      moments: [
        { name: 'first 30000ms', video: join(g.root, 'records/setup/reference/hollow.mp4'), startMs: 0, endMs: 30000 },
        { name: 'core action', video: join(g.root, 'records/setup/reference/hollow.mp4'), startMs: 1000, endMs: 4000 },
        { name: 'first failure', video: null, startMs: null, endMs: null },
      ],
    });
    const i3 = fake.instances.find((i) => i.id === 'i3');
    expect(i3?.commit).toBe(head);
    expect(i3?.fixture).toMatch(/ogw-fixtures-[^/]+\/boss\.json$/);
    expect(i3?.fixtureText).toBe('{"steps": []}\n');
    expect(fake.instances.find((i) => i.id === 'i4')?.fixtureText).toBe('{"steps": []}\n');
    expect(existsSync(i3?.fixture ?? '')).toBe(false);
    // the play and judge agents play the client main of the instances without a save fixture: no dev account
    expect(fake.instances.map((i) => [i.id, i.played === true])).toEqual(fake.instances.map((i) => [i.id, i.fixture === undefined]));
    expect(fake.instances.filter((i) => i.platform !== undefined).map((i) => [i.id, i.platform])).toEqual([['i9', 'android'], ['i10', 'web']]);
    expect(file.plays[2]).toMatchObject({ instance: 'i12', result: `${R}/play-1-4.md` });
    expect(fake.stopped).toContain('i11');
    const playInputs = fake.agents.filter((a) => a.role === 'play').map((a) => a.input);
    expect(playInputs[0]).toEqual({ instance: 'i9', playGuide: join(g.root, '..', 'instances', 'i9', 'play-guide.md'), moment: null });
    expect(playInputs.find((p) => p.moment !== null)).toMatchObject({ moment: { name: 'boss', description: 'reach the boss' } });
    expect(read(g.root, `${R}/play-1-1.md`)).toBe('## coverage\n\nunknown: none\ndevice ms: i9\nscenes: lobby\n\n## observations\n\n1 | lobby | tap | ok | fine | none | c.png\n');
    expect(measure.collect.map(([id]) => id).sort()).toEqual(['i10', 'i9']);
    expect(measure.collect[0]?.[1]).toBe(join(g.root, `${R}/evidence/measure-1/${measure.collect[0]?.[0] ?? ''}.json`));
    expect(measure.collected).toHaveLength(1);
    expect(fake.running.size).toBe(0);
    expect(new Set(fake.stopped).size).toBe(fake.instances.length);
    const committed = git(g.root, 'show', '--name-only', '--format=', 'HEAD').split('\n');
    expect(committed).toContain(`${R}/evaluate-1.json`);
    expect(committed).toContain(`${R}/measure-1.json`);
    expect(committed).toContain(`${R}/judge-1-4.md`);
    expect(committed).toContain(`${R}/play-1-1.md`);
    expect(committed.some((p) => p.includes('evidence'))).toBe(false);
  });

  it('retries a failed play agent on a new instance and records failed at the limit', async () => {
    const { g } = await loop({ playInstances: 1 }, ['regression test', 'static check', 'no blocker', 'full flow']);
    write(g.root, `${R}/request.md`, 'no moments');
    commit(g.root);
    fake.respond = (agent) => (agent.role === 'play' ? null : judgeText('A', 'A', 'pass'));
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g', '--json']);
    expect(out.code).toBe(0);
    const file = JSON.parse(out.stdout) as EvaluateFile;
    expect(file.plays).toEqual([{ result: '', instance: 'i6', platform: 'android', moment: null, status: 'failed' }]);
    expect(fake.agents.filter((a) => a.role === 'play').map((a) => a.input.instance)).toEqual(['i5', 'i6']);
    // completeness not all pass: no success judges
    expect(file.judges.map((j) => j.kind)).toEqual(['main', 'main']);
    expect(file.measure).toBeNull();
    expect(measure.collected).toEqual([]);
  });

  it('fails a judge whose tables cannot be read and skips success judges', async () => {
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    write(g.root, `${R}/measure-1.json`, 'old');
    commit(g.root);
    fake.respond = (agent) => (agent.role === 'play' ? null : 'no tables');
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('judge main failed claude-code claude-opus-5-5 high side A vs reference unknown');
    expect(out.stdout).toContain('vs baseline indistinguishable\nvs reference unknown');
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.judges).toHaveLength(2);
    expect(file.judges[0]).toMatchObject({ status: 'failed', votes: null, vsReference: 'unknown', result: '' });
    expect(file.votes?.every((v) => v.this === 0 && v.baseline === 0)).toBe(true);
    expect(git(g.root, 'ls-files', `${R}/measure-1.json`)).toBe('');
  });

  it('puts this commit in B by the coin and judges without a baseline in a create run', async () => {
    const { g, head, base } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    evaluateDeps.random = () => 0.7;
    fake.respond = (agent) => {
      if (agent.role === 'play') return null;
      const side = fake.instances.find((i) => i.id === (agent.input.A as { instance: string }).instance)?.commit === head ? 'A' : 'B';
      return judgeText(side, side, 'fail');
    };
    await ogw(g.ws, ['loop', 'evaluate', 'g']);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.judges[0]).toMatchObject({ A: base, B: head, instanceSide: 'B', vsReference: 'fail' });
    expect(file.judges[1]).toMatchObject({ A: head, B: base, instanceSide: 'A', vsReference: 'fail' });
    expect(file).toMatchObject({ vsBaseline: 'better', vsReference: 'fail' });

    const c = setupGame({ playInstances: 1, backgroundRetryLimit: 0 });
    await openLoopRun(c, { name: 'create-1', command: 'create', iteration: 1 });
    const chead = git(c.root, 'rev-parse', 'HEAD');
    write(c.root, 'records/loops/create-1/check-1.json', { commit: chead, checks: PASS_ALL.map((name) => ({ name, platform: null, result: 'pass', failures: [], warnings: [] })), gate: 'pass' });
    // the presentation game is another game than the reference game
    write(c.root, 'records/setup/reference/reference.md', REFERENCE_MD.replace('## reason', '## presentation game\n\nGlow Town\n\n## reason'));
    fake.root = c.root;
    fake.run = 'create-1';
    fake.instances = [];
    fake.agents = [];
    counters.judge = 0;
    counters.play = 0;
    fake.respond = (agent) => (agent.role === 'play' ? null : judgeText('A', 'A', 'unknown'));
    await ogw(c.ws, ['loop', 'evaluate', 'g']);
    const created = readJsonFile(c.root, 'records/loops/create-1/evaluate-1.json') as EvaluateFile;
    expect(created.baseline).toBeNull();
    // no baseline game: one step 4 judge, no votes
    expect(created.judges).toEqual([
      {
        kind: 'main',
        result: 'records/loops/create-1/judge-1-1.md',
        agent: { cli: 'claude-code', model: 'claude-opus-5-5', effort: 'high' },
        A: chead,
        B: null,
        instanceSide: 'A',
        omittedMoments: [],
        votes: null,
        lostMoments: [],
        vsReference: 'unknown',
        telemetry: null,
        status: 'done',
      },
    ]);
    expect(created).toMatchObject({ votes: null, vsBaseline: null, vsReference: 'unknown' });
    expect(fake.agents[0]?.input).toMatchObject({ B: null, fixtures: [], reference: { name: 'Hollow Run', presentation: 'Glow Town' } });
  });

  it('caps judge moments by maxConcurrentInstances and waits for room', async () => {
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0, maxConcurrentInstances: 4 });
    // another instance holds a slot: the main judge group of 4 waits until it is freed, though evaluate holds none
    fake.others = 1;
    fake.othersListed = 3;
    fake.respond = (agent) => (agent.role === 'play' ? null : judgeText('A', 'A', 'fail'));
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    expect(fake.runningAtStart.slice(0, 4)).toEqual([0, 1, 2, 3]);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.judges[0]?.omittedMoments).toEqual(['broken']);
    expect((fake.agents[0]?.input as { fixtures: unknown[] }).fixtures).toHaveLength(1);
  });

  it('records memorable_moment omitted when the step 4 judge did not get it', async () => {
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0, maxConcurrentInstances: 4 });
    write(g.root, `${R}/request.md`, '## judge moments\n\n- `boss`: reach the boss\n- `memorable_moment`: reach the tower, wait 5000 ms\n');
    write(g.root, 'client/dev/bot/fixtures/memorable_moment.json', '{"steps": []}\n');
    commit(g.root);
    await setRun(g, (run) => {
      run.data['memorable moment'] = true;
    });
    fake.respond = (agent) => (agent.role === 'play' ? null : judgeText('A', 'A', 'fail'));
    expect((await ogw(g.ws, ['loop', 'evaluate', 'g'])).code).toBe(0);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.judges[0]?.omittedMoments).toEqual(['memorable_moment']);
    expect(file.memorableMoment).toBe('omitted');
  });

  it('records memorable_moment missing without its judge moment line or its save fixture at the work branch HEAD', async () => {
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    // the line is there but the save fixture is only in the working tree
    write(g.root, `${R}/request.md`, '## judge moments\n\n- `memorable_moment`: reach the tower\n');
    commit(g.root);
    write(g.root, 'client/dev/bot/fixtures/memorable_moment.json', '{"steps": []}\n');
    await setRun(g, (run) => {
      run.data['memorable moment'] = true;
    });
    fake.respond = (agent) => (agent.role === 'play' ? null : judgeText('A', 'A', 'fail'));
    expect((await ogw(g.ws, ['loop', 'evaluate', 'g'])).code).toBe(0);
    expect((readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile).memorableMoment).toBe('missing');
  });

  it('fails when no room opens within instanceWaitTimeoutMs while evaluate holds no instance', async () => {
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0, maxConcurrentInstances: 4, instanceWaitTimeoutMs: 5000 });
    fake.others = 1;
    let ms = 0;
    evaluateDeps.now = () => (ms += 1000);
    fake.respond = () => null;
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('instance start failed: no room for 4 instances within instanceWaitTimeoutMs (5000 ms)');
    expect(fake.instances).toEqual([]);
    expect(fake.agents).toEqual([]);
    expect(git(g.root, 'ls-files', `${R}/evaluate-1.json`)).toBe('');
  });

  it('retries a failed judge as a new agent on new instances with the same A and B', async () => {
    const { g, head, base } = await loop({ playInstances: 1, backgroundRetryLimit: 1 });
    // first step 4 judge: this commit in B; a redraw on retry would put it in A
    const coins = [0.7, 0.1, 0.1];
    evaluateDeps.random = () => coins.shift() ?? 0.1;
    const runningAtRetry: string[] = [];
    fake.respond = (agent, k) => {
      if (agent.role === 'play') return null;
      if (k === 1) return 'no tables';
      if (k === 3) runningAtRetry.push(...fake.running);
      return judgeText('B', 'B', 'fail');
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    const judges = fake.agents.filter((a) => a.role === 'judge');
    expect(judges).toHaveLength(3);
    const ids = (agent: FakeAgent): string[] => {
      const input = agent.input as { A: { instance: string }; B: { instance: string }; fixtures: { A: string | null; B: string | null }[] };
      return [input.A.instance, input.B.instance, ...input.fixtures.flatMap((f) => [f.A, f.B]).filter((i): i is string => i !== null)];
    };
    const first = ids(judges[0] as FakeAgent);
    const second = ids(judges[2] as FakeAgent);
    expect(first).toHaveLength(4);
    expect(second).toHaveLength(4);
    expect(second.filter((id) => first.includes(id))).toEqual([]);
    expect(fake.stopped).toEqual(expect.arrayContaining(first));
    expect(runningAtRetry.filter((id) => first.includes(id))).toEqual([]);
    const commitOf = (id: string): string | undefined => fake.instances.find((i) => i.id === id)?.commit;
    expect(second.map(commitOf)).toEqual(first.map(commitOf));
    expect(second.map(commitOf)).toEqual([base, head, base, head]);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.judges.map((j) => [j.kind, j.result, j.A, j.B, j.instanceSide, j.vsReference, j.status])).toEqual([
      ['main', `${R}/judge-1-3.md`, base, head, 'B', 'fail', 'done'],
      ['main', `${R}/judge-1-2.md`, head, base, 'A', 'unknown', 'done'],
    ]);
    // one vote each way: uncertain
    expect(file.votes?.[0]).toEqual({ element: 'game feel', this: 1, baseline: 1, decision: 'uncertain' });
  });

  it('stops its agents and instances on SIGTERM before it lets the signal end the process', async () => {
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    const signals = trapSignals();
    // every agent hangs; the job time limit sends SIGTERM while they run
    fake.respond = () => {
      signals.send();
      return undefined;
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('ogw loop evaluate stopped by SIGTERM');
    await vi.waitFor(() => {
      expect(signals.resignals.map((r) => r.signal)).toEqual(['SIGTERM']);
    });
    expect(fake.agents.length).toBeGreaterThan(0);
    expect(fake.instances.length).toBeGreaterThan(0);
    const [at] = signals.resignals as [Resignal];
    expect(new Set(at.killed)).toEqual(new Set(fake.agents.map((a) => a.id)));
    expect(at.running).toEqual([]);
    expect(signals.offCalls()).toBeGreaterThan(0);
    expect(git(g.root, 'ls-files', `${R}/evaluate-1.json`)).toBe('');
  });

  it('stops an instance that is still starting on SIGTERM and starts nothing after it', async () => {
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    const signals = trapSignals();
    // the boot of the first instance does not end by itself within the test: only a stop of its reserved id ends the start
    evaluateDeps.signalSettleMs = 200;
    fake.booting = async (id) => {
      if (id !== 'i1') return;
      signals.send();
      for (let k = 0; k < 100 && !fake.stopped.includes(id); k++) await new Promise((r) => setTimeout(r, 10));
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('ogw loop evaluate stopped by SIGTERM');
    await vi.waitFor(() => {
      expect(signals.resignals).toHaveLength(1);
    });
    const [at] = signals.resignals as [Resignal];
    expect(at.running).toEqual([]);
    expect(fake.stopped).toContain('i1');
    expect(fake.instances.map((i) => i.id)).toEqual(['i1']);
    expect(fake.agents).toEqual([]);
  });

  it('starts no other instance and no agent after SIGTERM comes during an instance start that succeeds', async () => {
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    const signals = trapSignals();
    fake.booting = (id) => {
      if (id === 'i1') signals.send();
      return Promise.resolve();
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('ogw loop evaluate stopped by SIGTERM');
    await vi.waitFor(() => {
      expect(signals.resignals).toHaveLength(1);
    });
    const [at] = signals.resignals as [Resignal];
    expect(at.running).toEqual([]);
    expect(fake.instances.map((i) => i.id)).toEqual(['i1']);
    expect(fake.agents).toEqual([]);
  });

  it('kills an agent job whose start was in flight on SIGTERM before it lets the signal end the process', async () => {
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    const signals = trapSignals();
    fake.agentStarting = (id) => {
      if (id === 'a1') signals.send();
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('ogw loop evaluate stopped by SIGTERM');
    await vi.waitFor(() => {
      expect(signals.resignals).toHaveLength(1);
    });
    const [at] = signals.resignals as [Resignal];
    expect(fake.agents.map((a) => a.id)).toEqual(['a1']);
    expect(at.killed).toEqual(['a1']);
    expect(at.running).toEqual([]);
  });

  it('reserves no instance slot after SIGTERM comes while an instance start waits for a slot', async () => {
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    const signals = trapSignals();
    // the slot frees after the settle time: a start that keeps waiting would reserve it after the process ended
    evaluateDeps.signalSettleMs = 100;
    fake.reserving = async (signal) => {
      signals.send();
      if (signal?.aborted === true) return;
      await new Promise((r) => setTimeout(r, 400));
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('ogw loop evaluate stopped by SIGTERM');
    await vi.waitFor(() => {
      expect(signals.resignals).toHaveLength(1);
    });
    const [at] = signals.resignals as [Resignal];
    expect(at.instances).toEqual([]);
    expect(fake.instances).toEqual([]);
    expect(fake.running).toEqual(new Set());
  });

  it('kills the held agent jobs and stops the held instances itself on SIGTERM when the run stays blocked past signalSettleMs', async () => {
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    const signals = trapSignals();
    evaluateDeps.signalSettleMs = 100;
    fake.respond = () => undefined;
    let sent = false;
    // the main judge's agent and instances run; the play instance's boot ignores the stop and outlasts the settle time
    fake.booting = async () => {
      if (fake.agents.length === 0 || sent) return;
      sent = true;
      signals.send();
      await new Promise((r) => setTimeout(r, 500));
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('ogw loop evaluate stopped by SIGTERM');
    expect(signals.resignals).toHaveLength(1);
    const [at] = signals.resignals as [Resignal];
    expect(fake.agents.map((a) => a.id)).toEqual(['a1']);
    expect(at.killed).toEqual(['a1']);
    expect(at.instances.length).toBeGreaterThan(1);
    expect(at.running).toEqual([]);
  });

  it('starts a bundle only when it fits beside the running instances, and calls no success judge after one fails', async () => {
    const { g, head } = await loop({ playInstances: 1, backgroundRetryLimit: 0, maxConcurrentInstances: 4 });
    fake.respond = (agent) => {
      if (agent.role === 'play') return '## coverage\n\nunknown: none\n';
      const n = fake.agents.filter((a) => a.role === 'judge').indexOf(agent);
      const side = fake.instances.find((i) => i.id === (agent.input.A as { instance: string }).instance)?.commit === head ? 'A' : 'B';
      return judgeText(side, side, n === 2 ? 'fail' : 'pass');
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    // each step 4 judge (this commit, baseline, boss pair) in its own group, the second after the first stopped, then
    // the play and the boss play, then one success judge; the second does not fit beside the first and is not called
    // after it failed
    expect(fake.runningAtStart).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 0, 1, 2, 3]);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.judges.map((j) => [j.kind, j.vsReference])).toEqual([['main', 'pass'], ['main', 'pass'], ['success', 'fail']]);
    expect(file.judges[0]?.A).toBe(head);
    expect(file.judges[1]?.B).toBe(head);
    expect(fake.agents.filter((a) => a.role === 'judge')).toHaveLength(3);
    expect(fake.running.size).toBe(0);
  });

  it('draws A and B for each success judge by its own coin', async () => {
    const { g, head, base } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    const coins = [0.1, 0.7, 0.3];
    evaluateDeps.random = () => coins.shift() ?? 0.1;
    fake.respond = (agent) => {
      if (agent.role === 'play') return null;
      const sideA = (agent.input.A as { instance: string }).instance;
      const side = fake.instances.find((i) => i.id === sideA)?.commit === head ? 'A' : 'B';
      return judgeText(side, side, 'pass');
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(0);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    // the step 4 judges take one coin and then alternate; each success judge takes its own coin
    expect(file.judges.map((j) => [j.kind, j.instanceSide, j.A, j.B, j.vsReference])).toEqual([
      ['main', 'A', head, base, 'pass'],
      ['main', 'B', base, head, 'pass'],
      ['success', 'B', base, head, 'pass'],
      ['success', 'A', head, base, 'pass'],
    ]);
  });

  it('keeps a play whose client cannot answer telemetry or measure as done without its raw data', async () => {
    const { g } = await loop();
    measure.dead = ['i9'];
    fake.respond = (agent) => (agent.role === 'play' ? '## coverage\n\nunknown: none\n\n## observations\n\n1 | lobby | tap | crash | stuck | blocker | c.png\n' : judgeText('A', 'A', 'fail'));
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.plays.filter((p) => p.moment === null).map((p) => [p.instance, p.status])).toEqual([['i9', 'done'], ['i10', 'done']]);
    expect(read(g.root, `${R}/play-1-1.md`)).toBe('## coverage\n\nunknown: none\n- telemetry: unknown (get_telemetry failed: client channel closed)\n\n## observations\n\n1 | lobby | tap | crash | stuck | blocker | c.png\n');
    expect(measure.collected).toEqual([[join(g.root, `${R}/evidence/measure-1/i10.json`)]]);
    expect(file.measure).toBe(`${R}/measure-1.json`);
    expect(fake.running.size).toBe(0);
  });

  it('stops everything and fails when an instance without a fixture cannot start', async () => {
    const { g } = await loop();
    fake.failStart = (opts) => (opts.platform === 'web' ? 'start' : null);
    fake.respond = () => null;
    const outcome = (await import('../../../src/commands/agent/api.ts')).agentOutcome as unknown as { mockImplementationOnce: (f: () => Promise<unknown>) => void };
    outcome.mockImplementationOnce(() => Promise.resolve({ status: 'running', output: null }));
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('instance start failed: cannot start');
    expect(fake.running.size).toBe(0);
    expect(git(g.root, 'ls-files', `${R}/evaluate-1.json`)).toBe('');
  });

  it('stops everything when a save fixture instance cannot start for another reason than the fixture', async () => {
    const { g } = await loop();
    fake.failStart = (opts) => (typeof opts.fixture === 'string' && opts.fixture.endsWith('boss.json') ? 'wait-timeout' : null);
    fake.respond = () => null;
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/instance start failed: cannot start \S*ogw-fixtures-[^/]+\/boss\.json/);
    expect(fake.running.size).toBe(0);
    expect(git(g.root, 'ls-files', `${R}/evaluate-1.json`)).toBe('');
  });

  it('needs a passing check file, a reference and platforms', async () => {
    const { g, head } = await loop();
    write(g.root, `${R}/check-1.json`, { commit: head, checks: [{ name: 'full flow', platform: null, result: 'pass', failures: [], warnings: [] }] });
    expect((await ogw(g.ws, ['loop', 'evaluate', 'g'])).stderr).toContain(`${R}/check-1.json has no gate`);
    write(g.root, `${R}/check-1.json`, { commit: head, checks: [{ name: 'full flow', platform: null, result: 'pass', failures: [], warnings: [] }], gate: 'fail' });
    expect((await ogw(g.ws, ['loop', 'evaluate', 'g'])).stderr).toContain(`${R}/check-1.json gate is not pass`);
    write(g.root, `${R}/check-1.json`, { commit: head, checks: [], gate: 'pass' });
    write(g.root, 'settings.json', { buildPlatforms: [] });
    expect((await ogw(g.ws, ['loop', 'evaluate', 'g'])).stderr).toContain('buildPlatforms is empty');
    git(g.root, 'rm', '-q', 'records/setup/reference/reference.md');
    expect((await ogw(g.ws, ['loop', 'evaluate', 'g'])).stderr).toContain('reference.md is missing');
    git(g.root, 'rm', '-q', '-f', `${R}/check-1.json`);
    expect((await ogw(g.ws, ['loop', 'evaluate', 'g'])).stderr).toContain('check-1.json is missing');
    expect((await ogw(g.ws, ['loop', 'evaluate', 'g', '--db', 'mysql'])).stderr).toContain('usage:');
  });

  it('starts no instance and no agent while a gameplay video of reference.md is not on this host, in a loop run and in a build run', async () => {
    const message = 'records/setup/reference/ lacks the gameplay videos that records/setup/reference/reference.md `## video` names: hollow.mp4. ';
    const { g } = await loop();
    rmSync(join(g.root, 'records/setup/reference/hollow.mp4'));
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(message);
    expect(fake.instances).toEqual([]);
    expect(fake.agents).toEqual([]);
    expect(git(g.root, 'ls-files', `${R}/evaluate-1.json`)).toBe('');

    const b = setupGame({ playInstances: 1 });
    await openBuildRun(b, { iteration: 1 });
    write(b.root, 'records/loops/build-stg-0.2.0/check-1.json', { commit: git(b.root, 'rev-parse', 'HEAD'), checks: [], gate: 'pass' });
    rmSync(join(b.root, 'records/setup/reference/hollow.mp4'));
    expect((await ogw(b.ws, ['loop', 'evaluate', 'g', '--db', 'postgresql'])).stderr).toContain(message);
    expect(fake.instances).toEqual([]);
    expect(fake.agents).toEqual([]);
  });

  it('passes --db postgresql and runs no success judge in a build run', async () => {
    const g = setupGame({ playInstances: 1, backgroundRetryLimit: 0 });
    await openBuildRun(g, { iteration: 1 });
    fake.root = g.root;
    fake.run = 'build-stg-0.2.0';
    const head = git(g.root, 'rev-parse', 'HEAD');
    write(g.root, 'records/loops/build-stg-0.2.0/check-1.json', { commit: head, checks: PASS_ALL.map((name) => ({ name, platform: null, result: 'pass', failures: [], warnings: [] })), gate: 'pass' });
    fake.respond = (agent) => (agent.role === 'play' ? null : judgeText('A', 'A', 'pass'));
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g', '--db', 'postgresql']);
    expect(out.code).toBe(0);
    expect(fake.instances.every((i) => i.db === 'postgresql')).toBe(true);
    const file = readJsonFile(g.root, 'records/loops/build-stg-0.2.0/evaluate-1.json') as EvaluateFile;
    expect(file.judges.map((j) => j.kind)).toEqual(['main', 'main']);
    expect(file.kind).toBe('completeness');
    expect(file.baseline).toBe(git(g.root, 'rev-parse', 'main'));
  });
  it('judges a fun iteration with the judge panel, the fun elements, no reference, no save fixture instance and no success judge', async () => {
    const panel = [
      { cli: 'codex', model: 'gpt-x', effort: 'high' },
      { cli: 'claude-code', model: 'claude-sonnet-5-5', effort: 'medium' },
    ];
    const { g, head } = await loop({ playInstances: 1, backgroundRetryLimit: 0, loop: { funIterations: 3, judgeVotes: 4, judgePanel: panel, variants: 1 } });
    write(g.root, 'client/dev/bot/fixtures/memorable_moment.json', '{"steps": []}\n');
    commit(g.root);
    await setRun(g, (run) => {
      run.data['memorable moment'] = true;
      run.data.loop = { kinds: [{ iteration: 1, kind: 'fun' }] };
    });
    fake.respond = (agent) => {
      if (agent.role === 'play') return '## coverage\n\nunknown: none\n';
      const side = fake.instances.find((i) => i.id === (agent.input.A as { instance: string }).instance)?.commit === head ? 'A' : 'B';
      return judgeText(side, side, 'pass').replace(/## vs reference[\s\S]*$/, '## vs reference\n\nnone\n');
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file).toMatchObject({ kind: 'fun', elements: ['game feel', 'tension and release', 'no friction'], vsBaseline: 'better', vsReference: null });
    expect(file.memorableMoment).toBeUndefined();
    expect(file.votes).toEqual([
      { element: 'game feel', this: 4, baseline: 0, decision: 'this' },
      { element: 'tension and release', this: 0, baseline: 0, decision: 'indistinguishable' },
      { element: 'no friction', this: 0, baseline: 0, decision: 'indistinguishable' },
    ]);
    // four step 4 judges on alternating sides, each panel item for two judges in a row so that it judges both sides; no success judge
    expect(file.judges.map((j) => [j.kind, j.instanceSide, j.agent.model, j.vsReference])).toEqual([
      ['main', 'A', 'gpt-x', null],
      ['main', 'B', 'gpt-x', null],
      ['main', 'A', 'claude-sonnet-5-5', null],
      ['main', 'B', 'claude-sonnet-5-5', null],
    ]);
    const judges = fake.agents.filter((a) => a.role === 'judge');
    expect(judges.map((a) => a.agent)).toEqual([panel[0], panel[0], panel[1], panel[1]]);
    for (const judge of judges) expect(judge.input).toMatchObject({ fixtures: [], elements: ['game feel', 'tension and release', 'no friction'], telemetry: null, reference: null });
    // no save fixture instance and no play of a moment
    expect(fake.instances.filter((i) => i.fixture !== undefined)).toEqual([]);
    expect(file.plays.map((p) => p.moment)).toEqual([null]);
    expect(out.stdout).toContain('judge main done codex gpt-x high side A vs reference none');
    expect(out.stdout).toContain('votes game feel: this 4 baseline 0 this');
  });

  it('shares the telemetry of one bot run per commit with every judge, named by its sides', async () => {
    const { g, head, base } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    const goal = { path: 'telemetry.goal_intervals', op: 'count_gte', value: 1 };
    write(g.root, 'client/dev/bot/scenario.json', { steps: [{ kind: 'setup', command: 'f.cheat', timeoutMs: 1000 }], goal });
    commit(g.root);
    fake.respond = (agent) => {
      if (agent.role === 'play') return null;
      const side = fake.instances.find((i) => i.id === (agent.input.A as { instance: string }).instance)?.commit === head ? 'A' : 'B';
      return judgeText(side, side, 'pass');
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    // two headless instances first, this commit and the baseline game, stopped before the judges start
    expect(fake.instances.slice(0, 2).map((i) => [i.commit, i.client, i.played])).toEqual([[head, 'headless', undefined], [base, 'headless', undefined]]);
    expect(bots.runs.map((r) => r.commit)).toEqual([head, base]);
    // the bot runs poll at their own interval, not that of the agent jobs
    expect(bots.runs.map((r) => r.pollMs)).toEqual([7, 7]);
    expect(fake.stopped.slice(0, 2).sort()).toEqual(['i1', 'i2']);
    const first = join(g.root, `${R}/evidence/telemetry-1-1.md`);
    const second = join(g.root, `${R}/evidence/telemetry-1-2.md`);
    expect(read(g.root, `${R}/evidence/telemetry-1-1.md`)).toContain('input_latency_ms: A 30, B 90');
    expect(read(g.root, `${R}/evidence/telemetry-1-2.md`)).toContain('input_latency_ms: A 90, B 30');
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.judges.map((j) => [j.kind, j.instanceSide, j.telemetry])).toEqual([
      ['main', 'A', first],
      ['main', 'B', second],
      ['success', 'A', first],
      ['success', 'A', first],
    ]);
    expect(fake.agents.filter((a) => a.role === 'judge').map((a) => a.input.telemetry)).toEqual([first, second, first, first]);
    // evidence is not committed
    expect(git(g.root, 'ls-files', `${R}/evidence`)).toBe('');

    // a bot run that does not reach every step: no telemetry for any judge
    fake.instances = [];
    fake.agents = [];
    counters.judge = 0;
    counters.play = 0;
    bots.runs = [];
    bots.fail = new Set([base]);
    rmSync(join(g.root, `${R}/evidence`), { recursive: true, force: true });
    expect((await ogw(g.ws, ['loop', 'evaluate', 'g'])).code).toBe(0);
    expect(fake.agents.filter((a) => a.role === 'judge').map((a) => a.input.telemetry)).toEqual([null, null, null, null]);
    expect(existsSync(first)).toBe(false);
  });
});
