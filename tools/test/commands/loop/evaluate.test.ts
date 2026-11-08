import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jobsDir } from '../../../src/lib/jobs.ts';
import { alternateSide, evaluateDeps, judgeAgent, judgeBudget } from '../../../src/commands/loop/lib/evaluate.ts';
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
  /** `--random-base` of the instance; absent for none. */
  randomBase?: bigint;
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
  /** For a judge, the text of the `playGuide` file of `A` and of `B` when the job started (null without a file). */
  guides?: { A: string | null; B: string | null };
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
  /** By instance id, the ids of the instances of the run that were running when its start succeeded, before it was added. */
  runningIdsAtStart: Map<string, string[]>;
  /** Boot of an instance after its slot was reserved; the start fails when the instance was stopped meanwhile. */
  booting: (id: string) => Promise<void>;
  /** The stop of an instance once it left `running`, before the stop returns. */
  stopping: (id: string) => Promise<void>;
  /** Called inside `startAgentJob` before it returns the new job id. */
  agentStarting: (id: string) => void;
  /** Wait for a slot with the start's abort signal, before the instance id is reserved. */
  reserving: (signal: AbortSignal | undefined) => Promise<void>;
  /** Whether the agent CLI output of the agent has a limit message of `cli`. */
  limited: (agent: FakeAgent, cli: string) => boolean;
  /** The input the job gets in place of the one the tool wrote, written over its file; undefined keeps it. */
  editInput: (role: string, input: Record<string, unknown>) => Record<string, unknown> | undefined;
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
    runningIdsAtStart: new Map(),
    booting: () => Promise.resolve(),
    stopping: () => Promise.resolve(),
    agentStarting: () => undefined,
    reserving: () => Promise.resolve(),
    limited: () => false,
    editInput: () => undefined,
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
    const id = (opts.id as string | undefined) ?? `i${String(fake.instances.length + 1)}`;
    const root = join(fake.root, '..', 'instances', id);
    const fixture = opts.fixture as string | undefined;
    const fixtureText = fixture === undefined ? undefined : existsSync(fixture) ? readFileSync(fixture, 'utf8') : null;
    const info = { id, commit: opts.commit as string, platform: opts.platform as string | undefined, fixture, fixtureText, db: opts.db as string | undefined, played: opts.played as boolean | undefined, client: opts.client as string | undefined, ...(opts.randomBase === undefined ? {} : { randomBase: opts.randomBase as bigint }), root, startedAt: 100 };
    fake.instances.push(info);
    fake.runningAtStart.push(fake.running.size + fake.others);
    fake.runningIdsAtStart.set(id, [...fake.running]);
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
    return fake.stopping(id);
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
      const written = JSON.parse(fs.readFileSync(options.input, 'utf8')) as Record<string, unknown>;
      const edited = fake.editInput(options.role, written);
      if (edited !== undefined) fs.writeFileSync(options.input, JSON.stringify(edited));
      const input = edited ?? written;
      // `ogw agent` copies the play guides of a judge input when the job starts
      const guide = (side: 'A' | 'B'): string | null => {
        const path = (input[side] as { playGuide?: string } | null)?.playGuide;
        return path !== undefined && fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : null;
      };
      const guides = options.role === 'judge' ? { guides: { A: guide('A'), B: guide('B') } } : {};
      fake.agents.push({ id, role: options.role, input, output, ...(options.agent === undefined ? {} : { agent: options.agent }), ...guides });
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
    agentHitLimit: vi.fn((_ctx: unknown, id: string, cli: string) => Promise.resolve(fake.limited(fake.agents.find((a) => a.id === id) as FakeAgent, cli))),
    mergeAgentJobs: vi.fn(),
    retryAgentJob: vi.fn(),
  };
});

const killed = vi.hoisted(() => [] as string[]);
/** Jobs whose kill fails, and jobs whose record cannot be read. */
const killFails = vi.hoisted(() => new Set<string>());
const unreadable = vi.hoisted(() => new Set<string>());

vi.mock('../../../src/lib/jobs.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/lib/jobs.ts')>();
  return {
    ...original,
    killJob: vi.fn((id: string) => {
      killed.push(id);
      return killFails.has(id) ? Promise.reject(new Error(`job ${id} runs in the PID namespace of a play or judge sandbox\nmore`)) : Promise.resolve();
    }),
    // the job record of a fake agent: one with no result file path
    readJob: vi.fn((id: string, env?: NodeJS.ProcessEnv) => {
      if (unreadable.has(id)) return Promise.reject(new Error(`the record of ${id} cannot be read`));
      return fake.agents.some((a) => a.id === id) ? Promise.resolve({ id, meta: {} }) : original.readJob(id, env);
    }),
  };
});

/** The raw data collected, the instances whose client cannot answer, and the read of a telemetry summary before its result. */
interface Measure {
  collected: string[][];
  collect: [string, string][];
  dead: string[];
  summarizing: (id: string) => Promise<void>;
}

const measure = vi.hoisted((): Measure => ({ collected: [], collect: [], dead: [], summarizing: () => Promise.resolve() }));

vi.mock('../../../src/commands/telemetry/api.ts', () => ({
  telemetrySummary: vi.fn(async (_ctx: unknown, id: string) => {
    await measure.summarizing(id);
    return measure.dead.includes(id) ? Promise.reject(new Error('get_telemetry failed: client channel closed\nmore')) : Promise.resolve([`device ms: ${id}`, 'scenes: lobby']);
  }),
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
interface Bots {
  runs: { id: string; commit: string; pollMs: number }[];
  fail: Set<string>;
  failRuns: Map<string, number>;
  /** The run of the scenario on an instance, before its result. */
  running: (id: string) => Promise<void>;
}

const bots = vi.hoisted((): Bots => ({ runs: [], fail: new Set(), failRuns: new Map(), running: () => Promise.resolve() }));

vi.mock('../../../src/commands/loop/lib/shared-telemetry.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/loop/lib/shared-telemetry.ts')>()),
  botRun: vi.fn(async (_ctx: unknown, instance: { id: string }, _scenario: unknown, pollMs: number) => {
    const commit = fake.instances.find((i) => i.id === instance.id)?.commit ?? '';
    bots.runs.push({ id: instance.id, commit, pollMs });
    await bots.running(instance.id);
    if (bots.fail.has(commit)) return Promise.resolve(null);
    const failing = bots.failRuns.get(commit) ?? 0;
    if (failing > 0) {
      bots.failRuns.set(commit, failing - 1);
      return Promise.resolve(null);
    }
    // this commit (the first started) answers input 30 ms late, the baseline 90 ms, in every run
    const latency = commit === fake.instances[0]?.commit ? 30 : 90;
    const telemetry = { started_at: 0, inputs: [{ at: 10, command: 'tap', latency_ms: latency, feedback: { sound: 1 } }], rewards: [], marks: [], idle_spans: [], goal_intervals: [], scene_loads: [], dropped: 0 };
    return Promise.resolve({ telemetry, guide: null });
  }),
}));

const R = 'records/loops/update-1';

/**
 * The commit of side `side` of a judge: that of a started instance of that side that its input names. Its first-screen
 * instance starts after its save fixture instances, so it may not have started yet.
 */
function sideCommit(agent: FakeAgent, side: 'A' | 'B'): string | undefined {
  const input = agent.input as { A: { instance: string } | null; B: { instance: string } | null; fixtures: { A: string | null; B: string | null }[] };
  const ids = [input[side]?.instance, ...input.fixtures.map((f) => f[side])];
  return fake.instances.find((i) => ids.includes(i.id))?.commit;
}

function judgeText(winner: string, side: string, reference: string): string {
  return [
    '## vs baseline', '', '| element | winner | margin | reason | evidence |', '|---|---|---|---|---|', `| game feel | ${winner} | clear | r | e |`, '',
    '## vs reference', '', '| instance | element | result | reason | evidence |', '|---|---|---|---|---|', `| ${side} | game feel | ${reference} | r | e |`, '',
  ].join('\n');
}

const PASS_ALL = ['regression test', 'static check', 'no blocker', 'full flow', 'performance', 'UI quality', 'no placeholder'];

async function loop(settings: Record<string, unknown> = {}, checks = PASS_ALL, files: Record<string, string> = {}): Promise<{ g: TestGame; head: string; base: string }> {
  const g = setupGame({ playInstances: 2, backgroundRetryLimit: 1, loopStop: { repeatedDefect: 3, oscillation: 2, plateau: 3, successJudges: 2 }, ...settings });
  const run = await openLoopRun(g, { iteration: 1 });
  write(g.root, `${R}/request.md`, '## judge moments\n\n- `boss`: reach the boss\n- `broken` (set by lead agent): never loads\n');
  write(g.root, 'client/dev/bot/fixtures/boss.json', '{"steps": []}\n');
  for (const [path, text] of Object.entries(files)) write(g.root, path, text);
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
  killFails.clear();
  unreadable.clear();
  fake.instances = [];
  fake.running = new Set();
  fake.stopped = [];
  fake.agents = [];
  fake.run = 'update-1';
  fake.others = 0;
  fake.othersListed = null;
  fake.runningAtStart = [];
  fake.runningIdsAtStart = new Map();
  fake.booting = () => Promise.resolve();
  fake.stopping = () => Promise.resolve();
  fake.agentStarting = () => undefined;
  fake.reserving = () => Promise.resolve();
  fake.limited = () => false;
  fake.editInput = () => undefined;
  fake.failStart = (opts) => (typeof opts.fixture === 'string' && opts.fixture.endsWith('broken.json') ? 'fixture' : null);
  counters.play = 0;
  counters.judge = 0;
  measure.collected = [];
  measure.collect = [];
  measure.dead = [];
  measure.summarizing = () => Promise.resolve();
  bots.runs = [];
  bots.running = () => Promise.resolve();
  bots.fail = new Set();
  bots.failRuns = new Map();
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
    const settings = { loop: { funIterations: 3, judgeVotes: 8, judgePanel: panel, variants: 1, playTimeLimitMs: 2700000, playBudgetMs: 900000, judgeInstanceBudgetMs: 240000, judgeTimeLimitMs: 3600000 }, agents: {} };
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((k) => judgeAgent(settings, k).model)).toEqual(['a', 'a', 'b', 'b', 'c', 'c', 'a', 'a']);
    expect([1, 2, 3, 4].map((k) => alternateSide('A', k))).toEqual(['A', 'B', 'A', 'B']);
  });
});

describe('ogw loop evaluate', () => {
  it('plays, judges, confirms success, measures, writes and commits evaluate-<n>.json', async () => {
    // this commit has its own play guide and the game's names, which the judge reads its logo against
    const { g, head, base } = await loop({}, PASS_ALL, { 'play-guide.md': '## controls\n\ntap\n', 'records/setup/name.md': 'ko: 등불 지하실\nen: Lantern Crypt\n' });
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
      const isThis = sideCommit(agent, 'A') === head;
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
    // main judge: the boss pair and the broken pair (null), then this commit and the baseline from the first screen,
    // started in the order the judge plays them
    const mainInput = judgeAgents()[0]?.input as { A: { instance: string; playGuide: string }; B: { instance: string; playGuide: string; names: unknown }; fixtures: unknown[]; reference: unknown; elements: string[]; telemetry: unknown };
    expect(mainInput.elements).toEqual(file.elements);
    expect(mainInput.telemetry).toBeNull();
    expect(fake.instances.slice(0, 4).map((i) => [i.id, i.commit, i.fixture !== undefined])).toEqual([
      ['i1', head, true],
      ['i2', base, true],
      ['i3', head, false],
      ['i4', base, false],
    ]);
    // the second step 4 judge: the other side
    expect((judgeAgents()[1]?.input as { A: { instance: string } }).A.instance).toBe('i7');
    expect(fake.instances.find((i) => i.id === 'i7')?.commit).toBe(base);
    // play-guide.md and records/setup/name.md of the commit of each side, from git
    expect(mainInput.A).toEqual({ instance: 'i3', playGuide: expect.stringMatching(new RegExp(`/ogw-guides-[^/]+/${head}/play-guide\\.md$`)) as string, names: { ko: '등불 지하실', en: 'Lantern Crypt' } });
    expect((judgeAgents()[0] as FakeAgent).guides).toEqual({ A: '## controls\n\ntap\n', B: null });
    expect(mainInput.B.names).toEqual({ ko: 'Runner' });
    expect(mainInput.B.instance).toBe('i4');
    expect(existsSync(join(mainInput.A.playGuide, '..', '..'))).toBe(false);
    expect(mainInput.fixtures).toEqual([
      { moment: { name: 'boss', description: 'reach the boss' }, A: 'i1', B: 'i2' },
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
    const i1 = fake.instances.find((i) => i.id === 'i1');
    expect(i1?.commit).toBe(head);
    expect(i1?.fixture).toMatch(/ogw-fixtures-[^/]+\/boss\.json$/);
    expect(i1?.fixtureText).toBe('{"steps": []}\n');
    expect(fake.instances.find((i) => i.id === 'i2')?.fixtureText).toBe('{"steps": []}\n');
    expect(existsSync(i1?.fixture ?? '')).toBe(false);
    // the play and judge agents play the client main of the instances without a save fixture: no dev account
    expect(fake.instances.map((i) => [i.id, i.played === true])).toEqual(fake.instances.map((i) => [i.id, i.fixture === undefined]));
    expect(fake.instances.filter((i) => i.platform !== undefined).map((i) => [i.id, i.platform])).toEqual([['i9', 'android'], ['i10', 'web']]);
    expect(file.plays[2]).toMatchObject({ instance: 'i12', result: `${R}/play-1-4.md` });
    expect(fake.stopped).toContain('i11');
    const playInputs = fake.agents.filter((a) => a.role === 'play').map((a) => a.input);
    expect(playInputs[0]).toEqual({ instance: 'i9', playGuide: join(g.root, '..', 'instances', 'i9', 'play-guide.md'), moment: null, defects: [] });
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

  it('gives every play agent the play and judge defects awaiting confirmation after the content agent report, and the judges none', async () => {
    const defect = (id: string, source: string, status: string, owner = 'client content', evidence: string[] = []): object => ({
      id, severity: 'major', owner, where: `where ${id}`, what: `what ${id}`, why: 'y', evidence, source, status, refusedReason: null, repeatedDefect: 0, oscillation: 0,
    });
    const files = {
      [`${R}/play-0-1.md`]: '## observations\n\n1200 | boss | dash | stuck on the wall | annoying | major | cap/1.jpg\n',
      [`${R}/defects.json`]: JSON.stringify({
        defects: [
          defect('waits', 'play', 'awaiting confirmation', 'client content', [`${R}/play-0-1.md:3`, 'cap/1.jpg', `${R}/play-0-1.md:9`]),
          defect('judged', 'judge', 'awaiting confirmation', 'client content', ['i3-1000']),
          defect('proved', 'play', 'open'),
          defect('unproved', 'play', 'open'),
          defect('balance', 'judge', 'reopened', 'data'),
          defect('again', 'play', 'open'),
          defect('later', 'play', 'awaiting confirmation'),
          defect('refuse', 'play', 'awaiting confirmation'),
          defect('checked', 'check', 'awaiting confirmation'),
          defect('done', 'play', 'fixed'),
        ],
        previous: null,
        recordedBy: 'iteration-0',
      }),
      [`${R}/content-1.md`]: [
        '## defects', '', '| id | result | note |', '|---|---|---|',
        '| proved | fixed | `client/tests/a.gd::test_a` |', '| unproved | fixed | `client/tests/b.gd::test_b` |', '| balance | fixed | |', '| again | not reproduced | gone |',
        '| later | not done | next time |', '| refuse | refused | brief |', '',
      ].join('\n'),
    };
    const { g, head } = await loop({ playInstances: 2, backgroundRetryLimit: 0 }, PASS_ALL, files);
    const check = readJsonFile(g.root, `${R}/check-1.json`) as Record<string, unknown>;
    write(g.root, `${R}/check-1.json`, { ...check, commit: head, fixTestProof: [{ id: 'proved', result: 'pass', reason: null, tests: [] }, { id: 'unproved', result: 'fail', reason: 'r', tests: [] }] });
    commit(g.root);
    fake.respond = (agent) => (agent.role === 'play' ? null : judgeText('A', 'A', 'pass'));
    expect((await ogw(g.ws, ['loop', 'evaluate', 'g'])).code).toBe(0);
    const expected = [
      { id: 'waits', where: 'where waits', what: 'what waits', seen: ['1200 | boss | dash | stuck on the wall | annoying | major | cap/1.jpg'] },
      { id: 'judged', where: 'where judged', what: 'what judged', seen: [] },
      { id: 'proved', where: 'where proved', what: 'what proved', seen: [] },
      { id: 'balance', where: 'where balance', what: 'what balance', seen: [] },
      { id: 'again', where: 'where again', what: 'what again', seen: [] },
      { id: 'later', where: 'where later', what: 'what later', seen: [] },
    ];
    const plays = fake.agents.filter((a) => a.role === 'play');
    // the two first-screen plays and the play of the boss moment
    expect(plays.length).toBeGreaterThanOrEqual(3);
    for (const play of plays) expect(play.input.defects).toEqual(expected);
    expect(fake.agents.filter((a) => a.role === 'judge').every((a) => !('defects' in a.input))).toBe(true);
  });

  it('gives the play agents of a redone iteration the defects to confirm of the list its record starts from', async () => {
    const defect = (status: string): object => ({
      id: 'waits', severity: 'major', owner: 'client content', where: 'where waits', what: 'what waits', why: 'y', evidence: [], source: 'play', status, refusedReason: null, repeatedDefect: 0, oscillation: 0,
    });
    // the first record of iteration 1 made the defect fixed from an answer of a play: the redo of iteration 1 asks again
    const files = {
      [`${R}/defects.json`]: JSON.stringify({
        defects: [defect('fixed')],
        previous: { defects: [defect('awaiting confirmation')], previous: null, recordedBy: 'iteration-0' },
        recordedBy: 'iteration-1',
      }),
      [`${R}/content-1.md`]: '## defects\n\nnone\n',
    };
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0 }, PASS_ALL, files);
    fake.respond = (agent) => (agent.role === 'play' ? null : judgeText('A', 'A', 'pass'));
    expect((await ogw(g.ws, ['loop', 'evaluate', 'g'])).code).toBe(0);
    const plays = fake.agents.filter((a) => a.role === 'play');
    expect(plays.length).toBeGreaterThan(0);
    for (const play of plays) expect(play.input.defects).toEqual([{ id: 'waits', where: 'where waits', what: 'what waits', seen: [] }]);
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

  it('records the judging, each play and judge from its first instance start to its entry, and the record, when it runs as a job', async () => {
    const { g } = await loop({ playInstances: 1 }, ['regression test', 'static check', 'no blocker', 'full flow']);
    write(g.root, `${R}/request.md`, 'no moments');
    commit(g.root);
    fake.respond = (agent) => (agent.role === 'play' ? null : judgeText('A', 'A', 'pass'));
    const jobs = await jobsDir(g.ws.env);
    mkdirSync(jobs, { recursive: true });
    writeFileSync(join(jobs, 'ev1.json'), JSON.stringify({ id: 'ev1', argv: [], cwd: '/', command: 'loop evaluate', game: 'g', startedAt: Date.now(), endedAt: null, status: 'running', exitCode: null, supervisorPid: process.pid, pid: null, timeLimitMs: 60_000, agentJob: null, summary: null, meta: {} }));
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g'], { env: { ...g.ws.env, OGW_JOB_ID: 'ev1' } });
    expect(out.code).toBe(0);
    const lines = readFileSync(join(jobs, 'ev1.spans.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { id: string; name?: string; parent: string | null; end: number | null; failed?: true });
    const ended = lines.filter((l) => l.name !== undefined && l.end !== null);
    const named = (name: string): typeof ended => ended.filter((l) => l.name === name);
    const [judging] = named('judging');
    expect(judging?.parent).toBeNull();
    expect(named('record')).toHaveLength(1);
    // the play called again on a new instance is one span from its first start to its failed entry
    expect(named('play').map((l) => [l.parent === judging?.id, l.failed === true])).toEqual([[true, true]]);
    expect(new Set(lines.filter((l) => l.name === 'play').map((l) => l.id)).size).toBe(1);
    expect(named('judge main').map((l) => l.parent === judging?.id)).toEqual([true, true]);
  });

  it('fails the run when the job record of a failed agent cannot be read', async () => {
    const { g } = await loop({ playInstances: 1 });
    fake.respond = (agent) => (agent.role === 'play' ? null : judgeText('A', 'A', 'pass'));
    fake.agentStarting = (id) => {
      if (fake.agents.find((a) => a.id === id)?.role === 'play') unreadable.add(id);
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/the record of a\d+ cannot be read/);
  });

  it('removes the budget noted for a play job and a judge job when it sees each job end', async () => {
    const { g } = await loop({ playInstances: 1 });
    const budgets = join(await jobsDir(g.ws.env), 'play-budget');
    fake.agentStarting = (id) => {
      const role = fake.agents.find((a) => a.id === id)?.role;
      const file = role === 'judge' ? join(budgets, `judge-${id}`, 'i1') : join(budgets, id);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, '1000');
    };
    // whether the budget of each agent was still there when the agent ended
    const noted = new Map<string, boolean>();
    fake.respond = (agent) => {
      noted.set(agent.id, existsSync(join(budgets, agent.role === 'judge' ? `judge-${agent.id}` : agent.id)));
      return agent.role === 'play' ? null : judgeText('A', 'A', 'pass');
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    expect(new Set(fake.agents.map((a) => a.role))).toEqual(new Set(['play', 'judge']));
    expect([...noted.keys()].sort()).toEqual(fake.agents.map((a) => a.id).sort());
    expect([...noted.values()].every(Boolean)).toBe(true);
    expect(readdirSync(budgets)).toEqual([]);
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

  it('fails the run on a judge result that cannot be read, instead of taking it as one whose tables cannot be read', async () => {
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    fake.respond = (agent) => (agent.role === 'play' ? null : 'no tables');
    const agentApi = await import('../../../src/commands/agent/api.ts');
    const outcome = agentApi.agentOutcome as unknown as { mockImplementation: (f: (ctx: unknown, id: string) => Promise<unknown>) => void; getMockImplementation: () => (ctx: unknown, id: string) => Promise<unknown> };
    const base = outcome.getMockImplementation();
    outcome.mockImplementation((ctx, id) => {
      const agent = fake.agents.find((a) => a.id === id);
      if (agent?.role !== 'judge') return base(ctx, id);
      // the judge result is a folder
      mkdirSync(agent.output, { recursive: true });
      return Promise.resolve({ status: 'done', output: agent.output });
    });
    try {
      const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
      expect(out.code).toBe(1);
      expect(out.stderr).toContain('EISDIR');
    } finally {
      outcome.mockImplementation(base);
    }
  });

  it('reads no ## vs baseline of a judge whose input has B null, though the pair has a baseline game', async () => {
    const { g, base } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    // the judge gets no B: it compares nothing with the baseline game and writes only ## vs reference
    fake.editInput = (role, input) => (role === 'judge' ? { ...input, B: null } : undefined);
    fake.respond = (agent) => {
      if (agent.role === 'play') return null;
      return ['## vs reference', '', '| instance | element | result | reason | evidence |', '|---|---|---|---|---|', '| A | game feel | pass | r | e |', '| B | game feel | pass | r | e |', ''].join('\n');
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.baseline).toBe(base);
    const main = file.judges.filter((j) => j.kind === 'main');
    expect(main.map((j) => [j.status, j.votes, j.vsReference])).toEqual([
      ['done', null, 'pass'],
      ['done', null, 'pass'],
    ]);
    expect(fake.agents.filter((a) => a.role === 'judge').every((a) => a.input.B === null)).toBe(true);
  });

  it('reads no ## vs reference of a judge whose input has reference null in a completeness iteration', async () => {
    const { g, head } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    fake.editInput = (role, input) => (role === 'judge' ? { ...input, reference: null } : undefined);
    fake.respond = (agent) => {
      if (agent.role === 'play') return null;
      const side = sideCommit(agent, 'A') === head ? 'A' : 'B';
      return ['## vs baseline', '', '| element | winner | margin | reason | evidence |', '|---|---|---|---|---|', `| game feel | ${side} | clear | r | e |`, ''].join('\n');
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(0);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    const main = file.judges.filter((j) => j.kind === 'main');
    expect(main.map((j) => [j.status, j.votes?.['game feel'], j.vsReference])).toEqual([
      ['done', 'this', 'unknown'],
      ['done', 'this', 'unknown'],
    ]);
  });

  it('puts this commit in B by the coin and judges without a baseline in a create run', async () => {
    const { g, head, base } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    evaluateDeps.random = () => 0.7;
    fake.respond = (agent) => {
      if (agent.role === 'play') return null;
      const side = sideCommit(agent, 'A') === head ? 'A' : 'B';
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
    expect(judgeAgents()[0]?.input).toMatchObject({ B: null, fixtures: [], reference: { name: 'Hollow Run', presentation: 'Glow Town' } });
  });

  it('caps judge moments by maxConcurrentInstances and waits for room', async () => {
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0, maxConcurrentInstances: 4 });
    // other instances hold three slots: the main judge group of 2 waits until they are freed, though evaluate holds none
    fake.others = 3;
    fake.othersListed = 3;
    fake.respond = (agent) => (agent.role === 'play' ? null : judgeText('A', 'A', 'fail'));
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    expect(fake.runningAtStart.slice(0, 4)).toEqual([0, 1, 2, 3]);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.judges[0]?.omittedMoments).toEqual(['broken']);
    expect((judgeAgents()[0]?.input as { fixtures: unknown[] }).fixtures).toHaveLength(1);
  });

  it('stops the instances a running judge released and starts the next judge waiting for them', async () => {
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0, maxConcurrentInstances: 4 });
    // other instances hold two slots and each judge group holds 2: the second waits until the first judge gives its instances back
    fake.others = 2;
    const jobs = await jobsDir(g.ws.env);
    const firstIds: string[] = [];
    let secondStartedWhileFirstRan = false;
    fake.respond = (agent, k) => {
      if (agent.role === 'play') return null;
      if (k === 2) return judgeText('A', 'A', 'fail');
      if (fake.agents.filter((a) => a.role === 'judge').length < 2) {
        if (firstIds.length === 0) {
          const input = agent.input as { A: { instance: string }; B: { instance: string }; fixtures: { A: string | null; B: string | null }[] };
          firstIds.push(input.A.instance, input.B.instance, ...input.fixtures.flatMap((f) => [f.A, f.B]).filter((i): i is string => i !== null));
          // `ogw instance release` of every instance of its input, all written before the next poll, so a poll never
          // sees the release of the boss pair without that of the first-screen pair
          for (const id of firstIds) release(jobs, agent, id);
        }
        return undefined;
      }
      secondStartedWhileFirstRan = true;
      return judgeText('A', 'A', 'fail');
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    expect(secondStartedWhileFirstRan).toBe(true);
    expect(firstIds).toHaveLength(4);
    // each released instance that started (the boss pair) is stopped once, before the judge ended; the first-screen
    // pair, given back before it started, never starts
    const started = firstIds.filter((id) => fake.instances.some((i) => i.id === id));
    expect(started).toHaveLength(2);
    expect(fake.stopped.filter((id) => firstIds.includes(id)).sort()).toEqual([...started].sort());
    // the requests of an ended judge are cleared
    const releases = join(await jobsDir(g.ws.env), 'instance-releases');
    expect(existsSync(releases) ? readdirSync(releases) : []).toEqual([]);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.judges.map((j) => j.status)).toEqual(['done', 'done']);
  });

  /** A loop whose three judge moments have save fixtures, for judges that start with part of their instances. */
  async function threeMoments(settings: Record<string, unknown>): Promise<TestGame> {
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0, ...settings });
    write(g.root, `${R}/request.md`, '## judge moments\n\n- `m1`: one\n- `m2`: two\n- `m3`: three\n');
    for (const m of ['m1', 'm2', 'm3']) write(g.root, `client/dev/bot/fixtures/${m}.json`, '{"steps": []}\n');
    const head = commit(g.root);
    write(g.root, `${R}/check-1.json`, { commit: head, checks: PASS_ALL.map((name) => ({ name, platform: null, result: 'pass', failures: [], warnings: [] })), gate: 'pass' });
    commit(g.root);
    return g;
  }

  /** `ogw instance release` as the broker sandbox leaves it, written before the poll returns. */
  function release(jobs: string, agent: FakeAgent, id: string): void {
    mkdirSync(join(jobs, 'instance-releases', agent.id), { recursive: true });
    writeFileSync(join(jobs, 'instance-releases', agent.id, id), '');
  }

  function judgeIds(agent: FakeAgent): { first: string[]; fixtures: string[] } {
    const input = agent.input as { A: { instance: string }; B: { instance: string }; fixtures: { A: string | null; B: string | null }[] };
    return { first: [input.A.instance, input.B.instance], fixtures: input.fixtures.flatMap((f) => [f.A, f.B]).filter((i): i is string => i !== null) };
  }

  it('starts each step 4 judge with its share of the instance slots, so the judges run at once, and starts the rest as it gives instances back', async () => {
    const g = await threeMoments({ maxConcurrentInstances: 8 });
    const jobs = await jobsDir(g.ws.env);
    const judgesWhenFirstEnded: number[] = [];
    const released = new Set<string>();
    fake.respond = (agent) => {
      if (agent.role === 'play') return null;
      const { first, fixtures } = judgeIds(agent);
      const started = new Set(fake.instances.map((i) => i.id));
      // the judge plays the save fixture pairs in order and gives each back, then waits for the first-screen pair
      const next = fixtures.filter((id) => started.has(id) && !released.has(id));
      if (next.length === 0 && fixtures.every((id) => released.has(id))) {
        if (!first.every((id) => started.has(id))) return undefined;
        judgesWhenFirstEnded.push(fake.agents.filter((a) => a.role === 'judge').length);
        for (const id of first) release(jobs, agent, id);
        return judgeText('A', 'A', 'fail');
      }
      for (const id of next) {
        released.add(id);
        release(jobs, agent, id);
      }
      return undefined;
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    const judges = fake.agents.filter((a) => a.role === 'judge');
    // both step 4 judges ran before either ended
    expect(judgesWhenFirstEnded[0]).toBeGreaterThanOrEqual(2);
    for (const judge of judges.slice(0, 2)) {
      const { first, fixtures } = judgeIds(judge);
      expect(fixtures).toHaveLength(6);
      // every instance its input names was started, under that id
      for (const id of [...first, ...fixtures]) expect(fake.instances.some((i) => i.id === id)).toBe(true);
    }
    // never more than maxConcurrentInstances at once
    expect(Math.max(...fake.runningAtStart)).toBeLessThan(8);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.judges.filter((j) => j.kind === 'main').map((j) => j.status)).toEqual(['done', 'done']);
  });

  it('runs the plays beside the step 4 judges, which share the slots step 3 leaves and start their instances in the order they play them', async () => {
    // 8 slots: the play, three plays of moments, and the two step 4 judges with one instance per side each
    const g = await threeMoments({ maxConcurrentInstances: 8 });
    const jobs = await jobsDir(g.ws.env);
    const released = new Set<string>();
    // the play agents that had started when each step 4 judge was first seen running
    const playsAtFirstPoll = new Map<string, number>();
    const polls = new Map<string, number>();
    fake.respond = (agent) => {
      if (agent.role === 'play') return '## coverage\n\nunknown: none\n';
      const n = (polls.get(agent.id) ?? 0) + 1;
      polls.set(agent.id, n);
      if (n === 1) playsAtFirstPoll.set(agent.id, fake.agents.filter((a) => a.role === 'play').length);
      const { first, fixtures } = judgeIds(agent);
      const started = new Set(fake.instances.map((i) => i.id));
      // the judge plays the save fixture pairs in order, gives each back, then plays the first-screen pair; it ends after
      // at most 50 polls, so that a run in which its instances do not start ends too
      for (const id of fixtures.filter((i) => started.has(i) && !released.has(i))) {
        released.add(id);
        release(jobs, agent, id);
      }
      if (!(fixtures.every((id) => released.has(id)) && first.every((id) => started.has(id))) && n < 50) return undefined;
      for (const id of first) release(jobs, agent, id);
      return judgeText('A', 'A', 'fail');
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    // the four plays started with the judges, before either judge gave an instance back
    expect([...playsAtFirstPoll.values()]).toEqual([4, 4]);
    for (const judge of fake.agents.filter((a) => a.role === 'judge').slice(0, 2)) {
      const { first, fixtures } = judgeIds(judge);
      // its instances started in the order it plays them: m1, m2, m3 (A before B), then the first-screen pair
      const order = [...fixtures, ...first];
      expect(fake.instances.filter((i) => order.includes(i.id)).map((i) => i.id)).toEqual(order);
    }
    // never more than maxConcurrentInstances at once
    expect(Math.max(...fake.runningAtStart)).toBeLessThan(8);
  });

  it('starts the success confirmation judges beside the plays still running, in the slots step 3 leaves', async () => {
    const { g, head } = await loop({ playInstances: 2, backgroundRetryLimit: 0, maxConcurrentInstances: 8 });
    // when each success judge was first seen running: the plays still running and the judges started
    const playsRunning: [number, number][] = [];
    const ended = new Set<string>();
    const polls = new Map<string, number>();
    fake.respond = (agent) => {
      const n = (polls.get(agent.id) ?? 0) + 1;
      polls.set(agent.id, n);
      const judges = judgeAgents();
      if (agent.role === 'play') {
        // a play goes on until both success judges were seen running, at most 50 polls
        if (playsRunning.length < 2 && n < 50) return undefined;
        ended.add(agent.id);
        return '## coverage\n\nunknown: none\n';
      }
      if (judges.indexOf(agent) >= 2 && n === 1) playsRunning.push([fake.agents.filter((a) => a.role === 'play' && !ended.has(a.id)).length, judges.length]);
      const side = sideCommit(agent, 'A') === head ? 'A' : 'B';
      return judgeText(side, side, 'pass');
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.judges.map((j) => [j.kind, j.vsReference])).toEqual([['main', 'pass'], ['main', 'pass'], ['success', 'pass'], ['success', 'pass']]);
    // the two plays and the boss play (the broken save fixture did not start), and both success judges at once
    expect(playsRunning).toEqual([
      [3, 4],
      [3, 4],
    ]);
    expect(Math.max(...fake.runningAtStart)).toBeLessThan(8);
  });

  it('notes for ogw instance wait a later instance of a judge whose save fixture step failed, and clears the notes when the judge ends', async () => {
    const g = await threeMoments({ maxConcurrentInstances: 8 });
    // the m3 save fixture fails only for an instance started after its judge
    fake.failStart = (opts) => (typeof opts.fixture === 'string' && opts.fixture.endsWith('m3.json') && opts.id !== undefined ? 'fixture' : null);
    const jobs = await jobsDir(g.ws.env);
    const notes = join(jobs, 'instance-unstarted');
    const seen = new Map<string, string>();
    const released = new Set<string>();
    fake.respond = (agent) => {
      if (agent.role === 'play') return null;
      const input = agent.input as { fixtures: { moment: { name: string }; A: string | null; B: string | null }[] };
      const m3 = input.fixtures.find((f) => f.moment.name === 'm3');
      const m3Ids = [m3?.A, m3?.B].filter((i): i is string => typeof i === 'string');
      for (const id of m3Ids) {
        const note = join(notes, agent.id, id);
        if (existsSync(note)) seen.set(id, readFileSync(note, 'utf8'));
      }
      if (m3Ids.every((id) => seen.has(id))) return judgeText('A', 'A', 'fail');
      const started = new Set(fake.instances.map((i) => i.id));
      for (const id of judgeIds(agent).fixtures.filter((i) => started.has(i) && !released.has(i))) {
        released.add(id);
        release(jobs, agent, id);
      }
      return undefined;
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    expect(seen.size).toBe(4);
    expect([...new Set(seen.values())]).toEqual(['its save fixture step failed']);
    expect(existsSync(notes) ? readdirSync(notes) : []).toEqual([]);
  });

  it('keeps the slot of a judge whose first save fixture failed for its next instance, and starts that one only when a slot is free', async () => {
    const g = await threeMoments({ maxConcurrentInstances: 8 });
    const jobs = await jobsDir(g.ws.env);
    // the first judge's m1 save fixture fails at its start: it holds 3 of its budget of 4
    let failedOnce = false;
    fake.failStart = (opts) => {
      if (!failedOnce && typeof opts.fixture === 'string' && opts.fixture.endsWith('m1.json') && opts.id === undefined) {
        failedOnce = true;
        return 'fixture';
      }
      return null;
    };
    // a start while every slot is taken would wait in reserveSlot, holding up every other agent
    let startedWhenFull = 0;
    fake.reserving = () => {
      if (fake.running.size >= 8) startedWhenFull++;
      return Promise.resolve();
    };
    const released = new Set<string>();
    fake.respond = (agent) => {
      if (agent.role === 'play') return 'feedback';
      const { first, fixtures } = judgeIds(agent);
      const started = new Set(fake.instances.map((i) => i.id));
      const next = fixtures.filter((id) => started.has(id) && !released.has(id));
      if (next.length === 0 && fixtures.every((id) => released.has(id) || !started.has(id)) && fixtures.slice(-2).every((id) => released.has(id))) {
        for (const id of first) release(jobs, agent, id);
        return judgeText('A', 'A', 'fail');
      }
      for (const id of next) {
        released.add(id);
        release(jobs, agent, id);
      }
      return undefined;
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    expect(startedWhenFull).toBe(0);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.judges.filter((j) => j.kind === 'main').map((j) => j.status)).toEqual(['done', 'done']);
  });

  it('never starts a pending instance the judge gave back, and starts the next one in its place', async () => {
    const g = await threeMoments({ maxConcurrentInstances: 8 });
    const jobs = await jobsDir(g.ws.env);
    const notes = join(jobs, 'instance-unstarted');
    const skipped = new Map<string, string[]>();
    const seen = new Map<string, string>();
    fake.respond = (agent) => {
      if (agent.role === 'play') return null;
      const input = agent.input as { fixtures: { moment: { name: string }; A: string; B: string }[] };
      const [m1, m2, m3] = input.fixtures;
      if (!m1 || !m2 || !m3) throw new Error('three moments');
      if (!skipped.has(agent.id)) {
        // it will not play m2: it gives m2 back before it starts, then m1 once played
        skipped.set(agent.id, [m2.A, m2.B]);
        for (const id of [m2.A, m2.B, m1.A, m1.B]) release(jobs, agent, id);
        return undefined;
      }
      for (const id of [m2.A, m2.B]) if (existsSync(join(notes, agent.id, id))) seen.set(id, readFileSync(join(notes, agent.id, id), 'utf8'));
      const started = new Set(fake.instances.map((i) => i.id));
      return started.has(m3.A) && started.has(m3.B) ? judgeText('A', 'A', 'fail') : undefined;
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    const never = [...skipped.values()].flat();
    expect(never).toHaveLength(4);
    for (const id of never) expect(fake.instances.some((i) => i.id === id)).toBe(false);
    expect([...new Set(seen.values())]).toEqual(['it was given back']);
  });

  it('gives a judge its share of the slots of its kind, and at least one instance per side', () => {
    expect(judgeBudget(8, 2, 3, 2)).toBe(4);
    expect(judgeBudget(16, 2, 3, 2)).toBe(8);
    expect(judgeBudget(12, 2, 3, 2)).toBe(6);
    expect(judgeBudget(4, 2, 3, 2)).toBe(2);
    expect(judgeBudget(6, 2, 0, 2)).toBe(2);
    expect(judgeBudget(8, 1, 3, 1)).toBe(4);
    expect(judgeBudget(null, 2, 3, 2)).toBe(8);
    expect(judgeBudget(8, 2, 3, 0)).toBe(8);
    // the plays of step 3 leave the step 4 judges fewer slots than one per side, or none
    expect(judgeBudget(2, 2, 3, 2)).toBe(2);
    expect(judgeBudget(-2, 2, 3, 2)).toBe(2);
    expect(judgeBudget(1, 1, 3, 2)).toBe(1);
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
    fake.others = 3;
    let ms = 0;
    evaluateDeps.now = () => (ms += 1000);
    fake.respond = () => null;
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('instance start failed: no room for 2 instances within instanceWaitTimeoutMs (5000 ms)');
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
    // the judges' agents and instances run; the boot of the play instance (the one with a platform) waits for a judge
    // agent, then ignores the stop and outlasts the settle time; every agent that started is killed
    fake.booting = async (id) => {
      if (fake.instances.find((i) => i.id === id)?.platform === undefined) return;
      while (!fake.agents.some((a) => a.role === 'judge')) await new Promise((r) => setTimeout(r, 5));
      signals.send();
      await new Promise((r) => setTimeout(r, 500));
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('ogw loop evaluate stopped by SIGTERM');
    expect(signals.resignals).toHaveLength(1);
    const [at] = signals.resignals as [Resignal];
    expect(fake.agents.some((a) => a.role === 'judge')).toBe(true);
    expect(new Set(at.killed)).toEqual(new Set(fake.agents.map((a) => a.id)));
    expect(at.instances.length).toBeGreaterThan(1);
    expect(at.running).toEqual([]);
  });

  it('starts a bundle only when it fits beside the running instances, and calls no success judge after one fails', async () => {
    const { g, head } = await loop({ playInstances: 1, backgroundRetryLimit: 0, maxConcurrentInstances: 4 });
    fake.respond = (agent) => {
      if (agent.role === 'play') return '## coverage\n\nunknown: none\n';
      const n = fake.agents.filter((a) => a.role === 'judge').indexOf(agent);
      const side = sideCommit(agent, 'A') === head ? 'A' : 'B';
      return judgeText(side, side, n === 2 ? 'fail' : 'pass');
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    // each step 4 judge in its own group of one instance per side (the boss pair; the first-screen pair waits for it):
    // the plays leave the judges 1 slot, so their least fills the 4 slots; then the play and the boss play as slots free
    // up, then one success judge with its share of 2; the second does not fit beside the first and is not called after
    // it failed. No start runs beside 4 instances
    expect(fake.runningAtStart.slice(0, 4)).toEqual([0, 1, 2, 3]);
    expect(fake.runningAtStart).toHaveLength(8);
    expect(fake.runningAtStart.every((n) => n < 4)).toBe(true);
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
      const side = sideCommit(agent, 'A') === head ? 'A' : 'B';
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

  it('keeps a play whose client cannot answer telemetry or measure as done without its raw data, and says why it has none', async () => {
    const { g } = await loop();
    measure.dead = ['i9'];
    fake.respond = (agent) => (agent.role === 'play' ? '## coverage\n\nunknown: none\n\n## observations\n\n1 | lobby | tap | crash | stuck | blocker | c.png\n' : judgeText('A', 'A', 'fail'));
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('measure: no raw data of instance i9: get_telemetry failed\n');
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

  it('keeps the failure of the run when a kill of its cleanup fails too, and says that kill in the log', async () => {
    const { g } = await loop();
    fake.failStart = (opts) => (opts.platform === 'web' ? 'start' : null);
    fake.respond = () => null;
    const outcome = (await import('../../../src/commands/agent/api.ts')).agentOutcome as unknown as { mockImplementationOnce: (f: () => Promise<unknown>) => void };
    outcome.mockImplementationOnce(() => Promise.resolve({ status: 'running', output: null }));
    killFails.add('a1');
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('killing job a1 failed: job a1 runs in the PID namespace of a play or judge sandbox\n');
    expect(out.stderr).toContain('instance start failed: cannot start');
    expect(fake.running.size).toBe(0);
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
  it('judges a fun iteration with the judge panel, the fun elements, no reference, no save fixture instance, no play and no success judge', async () => {
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
      const side = sideCommit(agent, 'A') === head ? 'A' : 'B';
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
    expect(file.plays).toEqual([]);
    expect(out.stdout).toContain('judge main done codex gpt-x high side A vs reference none');
    expect(out.stdout).toContain('votes game feel: this 4 baseline 0 this');
    // without loop.confirmJudge no confirmation pair checks the better
    expect(file.confirmation).toBeUndefined();
    expect(out.stdout).not.toContain('confirmation');
  });

  it('gives the judges of a fun iteration the save fixture instances of the moment that the hypothesis names', async () => {
    const { g, head } = await loop({ playInstances: 1, backgroundRetryLimit: 0, loop: { funIterations: 3, judgeVotes: 2, judgePanel: [], variants: 1 } });
    write(g.root, `${R}/content-1.md`, '## hypothesis\n\n- element: tension and release\n- kind: tuning\n- change: x\n- expected: y\n- moment: `boss`\n');
    commit(g.root);
    await setRun(g, (run) => {
      run.data.loop = { kinds: [{ iteration: 1, kind: 'fun' }] };
    });
    fake.respond = (agent) => {
      if (agent.role === 'play') return '## coverage\n\nunknown: none\n';
      const side = sideCommit(agent, 'A') === head ? 'A' : 'B';
      return judgeText(side, side, 'pass').replace(/## vs reference[\s\S]*$/, '## vs reference\n\nnone\n');
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    const judges = fake.agents.filter((a) => a.role === 'judge');
    expect(judges).toHaveLength(2);
    for (const judge of judges) expect((judge.input.fixtures as { moment: { name: string } }[]).map((f) => f.moment.name)).toEqual(['boss']);
    // two save fixture instances per judge, none for a play
    expect(fake.instances.filter((i) => i.fixture !== undefined)).toHaveLength(4);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.plays).toEqual([]);
  });

  it('shares the telemetry of three bot runs per commit with every judge, named by its sides', async () => {
    const { g, head, base } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    const goal = { path: 'telemetry.goal_intervals', op: 'count_gte', value: 1 };
    write(g.root, 'client/dev/bot/scenario.json', { steps: [{ kind: 'setup', command: 'f.cheat', timeoutMs: 1000 }], goal });
    commit(g.root);
    fake.respond = (agent) => {
      if (agent.role === 'play') return null;
      const side = sideCommit(agent, 'A') === head ? 'A' : 'B';
      return judgeText(side, side, 'pass');
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    // six headless instances first, started together, three of this commit and three of the baseline game, stopped
    // before the judges start
    const headless = fake.instances.slice(0, 6);
    expect(headless.map((i) => [i.commit, i.client, i.played]).sort()).toEqual(
      [head, head, head, base, base, base].map((c) => [c, 'headless', undefined]).sort(),
    );
    // the k-th run of each commit has random base k, so the two commits play the same worlds; the judges' have none
    expect(headless.map((i) => `${i.commit} ${String(i.randomBase)}`).sort()).toEqual([head, base].flatMap((c) => [1, 2, 3].map((k) => `${c} ${String(k)}`)).sort());
    expect(fake.instances.slice(6).filter((i) => i.randomBase !== undefined)).toEqual([]);
    expect(bots.runs.map((r) => r.commit).sort()).toEqual([head, head, head, base, base, base].sort());
    // the bot runs poll at their own interval, not that of the agent jobs
    expect(bots.runs.map((r) => r.pollMs)).toEqual([7, 7, 7, 7, 7, 7]);
    expect(fake.stopped).toEqual(expect.arrayContaining(['i1', 'i2', 'i3', 'i4', 'i5', 'i6']));
    const judgeIds = judgeAgents().flatMap((a) => {
      const input = a.input as { A: { instance: string }; B: { instance: string } | null; fixtures: { A: string | null; B: string | null }[] };
      return [input.A.instance, input.B?.instance ?? null, ...input.fixtures.flatMap((f) => [f.A, f.B])].filter((id): id is string => id !== null);
    });
    for (const id of judgeIds) expect(fake.runningIdsAtStart.get(id)?.filter((r) => headless.some((h) => h.id === r)) ?? []).toEqual([]);
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

    // a bot run that does not reach every step is replaced by a new run
    fake.instances = [];
    fake.agents = [];
    counters.judge = 0;
    counters.play = 0;
    bots.runs = [];
    bots.failRuns = new Map([[base, 2]]);
    rmSync(join(g.root, `${R}/evidence`), { recursive: true, force: true });
    const retried = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(retried.code).toBe(0);
    expect(retried.stderr).toContain(`shared telemetry: a bot run of ${base} did not reach every step`);
    expect(bots.runs.filter((r) => r.commit === base)).toHaveLength(5);
    // the new runs count on: random bases 4 and 5
    expect(fake.instances.filter((i) => i.commit === base && i.client === 'headless').map((i) => i.randomBase)).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(fake.agents.filter((a) => a.role === 'judge').map((a) => a.input.telemetry)).toEqual([first, second, first, first]);

    // runs that do not reach every step, also when run again: no telemetry for any judge
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

  it('takes the shared telemetry runs that ogw check --loop made of the same two commits with the same scenario, and makes them itself otherwise', async () => {
    const { g, head, base } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    const goal = { path: 'telemetry.goal_intervals', op: 'count_gte', value: 1 };
    const scenarioFile = { steps: [{ kind: 'setup', command: 'f.cheat', timeoutMs: 1000 }], goal };
    write(g.root, 'client/dev/bot/scenario.json', scenarioFile);
    commit(g.root);
    const sha256 = createHash('sha256').update(`${JSON.stringify(scenarioFile, null, 2)}\n`).digest('hex');
    const runOf = (latency: number) => ({ telemetry: { started_at: 0, inputs: [{ at: 10, command: 'tap', latency_ms: latency, feedback: { sound: 1 } }], rewards: [], marks: [], idle_spans: [], goal_intervals: [], scene_loads: [], dropped: 0 }, guide: null });
    const runs = (commitRuns: unknown, baselineRuns: unknown, scenario = sha256): void => {
      write(g.root, `${R}/evidence/check-1/telemetry-runs.json`, { commit: head, baseline: base, scenario, runs: { commit: commitRuns, baseline: baselineRuns } });
    };
    fake.respond = (agent) => {
      if (agent.role === 'play') return null;
      const side = sideCommit(agent, 'A') === head ? 'A' : 'B';
      return judgeText(side, side, 'pass');
    };
    const evaluate = async (): Promise<void> => {
      resetRun();
      bots.runs = [];
      const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
      expect(out.stderr).toBe('');
      expect(out.code).toBe(0);
    };
    const telemetry = join(g.root, `${R}/evidence/telemetry-1-1.md`);

    // the runs of the check: no bot run and no headless instance, and the judges compare them
    runs([runOf(40), runOf(40), runOf(40)], [runOf(120), runOf(120), runOf(120)]);
    await evaluate();
    expect(bots.runs).toEqual([]);
    expect(fake.instances.filter((i) => i.client === 'headless')).toEqual([]);
    expect(read(g.root, `${R}/evidence/telemetry-1-1.md`)).toContain('input_latency_ms: A 40, B 120');
    expect(judgeAgents().map((a) => a.input.telemetry)).toEqual([telemetry, join(g.root, `${R}/evidence/telemetry-1-2.md`), telemetry, telemetry]);

    // runs of the check that fell short for a commit: no telemetry, and no runs again
    runs([runOf(40), runOf(40), runOf(40)], null);
    rmSync(telemetry);
    await evaluate();
    expect(bots.runs).toEqual([]);
    expect(judgeAgents().map((a) => a.input.telemetry)).toEqual([null, null, null, null]);

    // runs of another scenario, or of other commits: it makes the runs itself
    for (const [scenario, baseline] of [['0'.repeat(64), base], [sha256, head]] as const) {
      write(g.root, `${R}/evidence/check-1/telemetry-runs.json`, { commit: head, baseline, scenario, runs: { commit: [runOf(40), runOf(40), runOf(40)], baseline: [runOf(120), runOf(120), runOf(120)] } });
      await evaluate();
      expect(bots.runs.map((r) => r.commit).sort()).toEqual([head, head, head, base, base, base].sort());
      expect(read(g.root, `${R}/evidence/telemetry-1-1.md`)).toContain('input_latency_ms: A 30, B 90');
    }
  });
});

const OPUS = { cli: 'claude-code', model: 'claude-opus-5-5', effort: 'high' };
const CONFIRM = { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' };
const FALLBACK = { cli: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' };
const FUN_VOTES = ['game feel', 'tension and release', 'no friction'];

/** A fun iteration of a loop run with the given `loop` settings added, and no call again of a failed agent. */
async function funLoop(confirm: Record<string, unknown>): Promise<{ g: TestGame; head: string; base: string }> {
  const loaded = await loop({ playInstances: 1, backgroundRetryLimit: 0, loop: { funIterations: 3, judgeVotes: 2, judgePanel: [], variants: 1, ...confirm } });
  await setRun(loaded.g, (run) => {
    run.data.loop = { kinds: [{ iteration: 1, kind: 'fun' }] };
  });
  return loaded;
}

/** A judge result of a fun iteration: per element of `winners`, this commit or the baseline game wins. */
function funJudge(agent: FakeAgent, head: string, winners: Record<string, 'this' | 'baseline'>): string {
  const thisSide = sideCommit(agent, 'A') === head ? 'A' : 'B';
  const rows = Object.entries(winners).map(([element, winner]) => `| ${element} | ${winner === 'this' ? thisSide : thisSide === 'A' ? 'B' : 'A'} | clear | r | e |`);
  return ['## vs baseline', '', '| element | winner | margin | reason | evidence |', '|---|---|---|---|---|', ...rows, '', '## vs reference', '', 'none', ''].join('\n');
}

function judgeAgents(): FakeAgent[] {
  return fake.agents.filter((a) => a.role === 'judge');
}

/** The commits of the `A` and `B` instances of a judge. */
function sideCommits(agent: FakeAgent): (string | undefined)[] {
  return (['A', 'B'] as const).map((side) => sideCommit(agent, side));
}

/** The judge input without the instances of `A` and `B`. */
function inputBesidesSides(agent: FakeAgent): Record<string, unknown> {
  return Object.fromEntries(Object.entries(agent.input).filter(([key]) => key !== 'A' && key !== 'B'));
}

function resetRun(): void {
  fake.instances = [];
  fake.agents = [];
  fake.running = new Set();
  fake.stopped = [];
  fake.runningAtStart = [];
  counters.judge = 0;
  counters.play = 0;
}

describe('ogw loop evaluate confirmation pair', () => {
  it('confirms a better of a fun iteration with two judges on loop.confirmJudge, one per side, on new instances after the step 4 judges', async () => {
    const { g, head, base } = await funLoop({ confirmJudge: CONFIRM });
    // the step 4 judges draw `A` for this commit, the confirmation pair draws `B` for its first judge
    const coins = [0.1, 0.7];
    evaluateDeps.random = () => coins.shift() ?? 0.1;
    fake.respond = (agent) => funJudge(agent, head, { 'game feel': 'this' });
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.judges.map((j) => [j.kind, j.instanceSide, j.agent, j.status, j.fallback])).toEqual([
      ['main', 'A', OPUS, 'done', undefined],
      ['main', 'B', OPUS, 'done', undefined],
      ['confirm', 'B', CONFIRM, 'done', undefined],
      ['confirm', 'A', CONFIRM, 'done', undefined],
    ]);
    expect(file.votes?.map((v) => v.decision)).toEqual(['this', 'indistinguishable', 'indistinguishable']);
    expect(file.confirmation).toEqual({
      outcome: 'confirmed',
      fallback: false,
      votes: [
        { element: 'game feel', this: 2, baseline: 0, decision: 'this' },
        { element: 'tension and release', this: 0, baseline: 0, decision: 'indistinguishable' },
        { element: 'no friction', this: 0, baseline: 0, decision: 'indistinguishable' },
      ],
    });
    expect(file.vsBaseline).toBe('better');
    const [first, , pairB, pairA] = judgeAgents() as [FakeAgent, FakeAgent, FakeAgent, FakeAgent];
    expect(judgeAgents().map((a) => a.agent)).toEqual([OPUS, OPUS, CONFIRM, CONFIRM]);
    expect(sideCommits(pairB)).toEqual([base, head]);
    expect(sideCommits(pairA)).toEqual([head, base]);
    // the input of the first step 4 judge with the assignment of each judge of the pair
    expect(inputBesidesSides(pairB)).toEqual(inputBesidesSides(first));
    expect(inputBesidesSides(pairA)).toEqual(inputBesidesSides(first));
    expect(first.input).toMatchObject({ elements: FUN_VOTES, fixtures: [], reference: null });
    // the pair starts once the step 4 judges ended and stopped their instances, both judges at once, on new instances
    expect(fake.runningAtStart).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    expect(new Set(fake.instances.map((i) => i.id)).size).toBe(8);
    expect(fake.running.size).toBe(0);
    expect(out.stdout).toContain('judge confirm done codex gpt-6.1-sol high side B vs reference none');
    expect(out.stdout).toContain('confirm votes game feel: this 2 baseline 0 this');
    expect(out.stdout).toContain('confirmation confirmed\nvs baseline better');
    expect(git(g.root, 'show', '--name-only', '--format=', 'HEAD').split('\n')).toContain(`${R}/judge-1-4.md`);
  });

  it('overturns a better that the pair decides this for no element of step 4, or decides baseline for an element', async () => {
    const { g, head } = await funLoop({ confirmJudge: CONFIRM });
    // the pair decides `this` only for an element that step 4 did not decide `this`
    fake.respond = (agent) => funJudge(agent, head, agent.agent?.model === CONFIRM.model ? { 'tension and release': 'this' } : { 'game feel': 'this' });
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(0);
    let file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.votes?.map((v) => v.decision)).toEqual(['this', 'indistinguishable', 'indistinguishable']);
    expect(file.confirmation?.outcome).toBe('overturned');
    expect(file.confirmation?.votes.map((v) => v.decision)).toEqual(['indistinguishable', 'this', 'indistinguishable']);
    expect(file.vsBaseline).toBe('indistinguishable');
    expect(out.stdout).toContain('confirmation overturned\nvs baseline indistinguishable');

    // the pair confirms the element but decides `baseline` for another
    resetRun();
    fake.respond = (agent) => funJudge(agent, head, agent.agent?.model === CONFIRM.model ? { 'game feel': 'this', 'no friction': 'baseline' } : { 'game feel': 'this' });
    expect((await ogw(g.ws, ['loop', 'evaluate', 'g'])).code).toBe(0);
    file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.confirmation?.votes.map((v) => v.decision)).toEqual(['this', 'indistinguishable', 'baseline']);
    expect(file.confirmation?.outcome).toBe('overturned');
    expect(file.vsBaseline).toBe('indistinguishable');

    // the two judges of the pair differ on the element: `uncertain` confirms nothing
    resetRun();
    fake.respond = (agent) => {
      const pair = judgeAgents().filter((a) => a.agent?.model === CONFIRM.model);
      return funJudge(agent, head, { 'game feel': pair.indexOf(agent) === 1 ? 'baseline' : 'this' });
    };
    expect((await ogw(g.ws, ['loop', 'evaluate', 'g'])).code).toBe(0);
    file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.confirmation?.votes[0]).toEqual({ element: 'game feel', this: 1, baseline: 1, decision: 'uncertain' });
    expect(file.vsBaseline).toBe('indistinguishable');
  });

  it('calls no confirmation pair when the step 4 judges do not decide better', async () => {
    const { g, head } = await funLoop({ confirmJudge: CONFIRM });
    fake.respond = (agent) => funJudge(agent, head, { 'game feel': 'baseline' });
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(0);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.judges.map((j) => j.kind)).toEqual(['main', 'main']);
    expect(file.vsBaseline).toBe('worse');
    expect(file.confirmation).toBeUndefined();
    expect(judgeAgents()).toHaveLength(2);
  });

  it('runs the success confirmation judges with loop.confirmJudge, and one that hit its limit once more with loop.confirmFallback', async () => {
    const { g, head } = await loop({ playInstances: 1, backgroundRetryLimit: 0, loop: { funIterations: 3, judgeVotes: 2, judgePanel: [], variants: 1, confirmJudge: CONFIRM, confirmFallback: FALLBACK } });
    fake.respond = (agent) => {
      if (agent.role === 'play') return null;
      // the first success judge ends without a result
      if (judgeAgents().indexOf(agent) === 2) return null;
      const side = sideCommit(agent, 'A') === head ? 'A' : 'B';
      return judgeText(side, side, 'pass');
    };
    // ... and its Codex output says it hit the usage limit
    fake.limited = (agent, cli) => cli === 'codex' && judgeAgents().indexOf(agent) === 2;
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(0);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    // the step 4 judges keep agents.judge; the success judges run with loop.confirmJudge, the first then on the fallback
    expect(file.judges.map((j) => [j.kind, j.agent, j.fallback, j.status, j.vsReference])).toEqual([
      ['main', OPUS, undefined, 'done', 'pass'],
      ['main', OPUS, undefined, 'done', 'pass'],
      ['success', FALLBACK, 'usage limit', 'done', 'pass'],
      ['success', CONFIRM, undefined, 'done', 'pass'],
    ]);
    expect(judgeAgents().map((a) => a.agent)).toEqual([OPUS, OPUS, CONFIRM, CONFIRM, FALLBACK]);
    expect(file.confirmation).toBeUndefined();
    expect(out.stdout).toContain('judge success done claude-code claude-sonnet-5-5 high (fallback: usage limit) side A vs reference pass');
  });

  it('calls a judge of the pair once more with loop.confirmFallback after a limit message, not after another failure, and only once', async () => {
    const { g, head } = await funLoop({ confirmJudge: CONFIRM, confirmFallback: FALLBACK });
    // the first judge of the pair hits the Codex usage limit; the second fails for another reason
    fake.respond = (agent) => ([2, 3].includes(judgeAgents().indexOf(agent)) ? null : funJudge(agent, head, { 'game feel': 'this' }));
    fake.limited = (agent, cli) => cli === 'codex' && judgeAgents().indexOf(agent) === 2;
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.code).toBe(0);
    expect(out.stderr).toContain('hit the limit of codex: calling it again with loop.confirmFallback');
    let file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.judges.map((j) => [j.kind, j.agent, j.fallback, j.status])).toEqual([
      ['main', OPUS, undefined, 'done'],
      ['main', OPUS, undefined, 'done'],
      ['confirm', FALLBACK, 'usage limit', 'done'],
      ['confirm', CONFIRM, undefined, 'failed'],
    ]);
    // with backgroundRetryLimit 0 the fallback call is not counted, and the other failure is not called again
    expect(judgeAgents().map((a) => a.agent)).toEqual([OPUS, OPUS, CONFIRM, CONFIRM, FALLBACK]);
    const [, , limited, , fallback] = judgeAgents() as [FakeAgent, FakeAgent, FakeAgent, FakeAgent, FakeAgent];
    expect(inputBesidesSides(fallback)).toEqual(inputBesidesSides(limited));
    expect(sideCommits(fallback)).toEqual(sideCommits(limited));
    expect(fallback.input.A).not.toEqual(limited.input.A);
    // one vote of the pair decides no element: overturned, on the fallback
    expect(file.confirmation).toMatchObject({ outcome: 'overturned', fallback: true });
    expect(file.vsBaseline).toBe('indistinguishable');
    expect(out.stdout).toContain('judge confirm done claude-code claude-sonnet-5-5 high (fallback: usage limit) side');
    expect(out.stdout).toContain('confirmation overturned (fallback: usage limit)');
    expect(fake.running.size).toBe(0);

    // a judge falls back once: a limit message of the fallback agent is not fallen back again
    resetRun();
    fake.respond = (agent) => (judgeAgents().indexOf(agent) >= 2 ? null : funJudge(agent, head, { 'game feel': 'this' }));
    fake.limited = () => true;
    expect((await ogw(g.ws, ['loop', 'evaluate', 'g'])).code).toBe(0);
    file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(judgeAgents().map((a) => a.agent)).toEqual([OPUS, OPUS, CONFIRM, CONFIRM, FALLBACK, FALLBACK]);
    expect(file.judges.slice(2).map((j) => [j.agent, j.fallback, j.status])).toEqual([
      [FALLBACK, 'usage limit', 'failed'],
      [FALLBACK, 'usage limit', 'failed'],
    ]);
  });

  it('calls a judge that fell back again with loop.confirmFallback, and the fallback call uses up no call again', async () => {
    const loaded = await loop({ playInstances: 1, backgroundRetryLimit: 1, loop: { funIterations: 3, judgeVotes: 2, judgePanel: [], variants: 1, confirmJudge: CONFIRM, confirmFallback: FALLBACK } });
    await setRun(loaded.g, (run) => {
      run.data.loop = { kinds: [{ iteration: 1, kind: 'fun' }] };
    });
    const { g, head } = loaded;
    // the first judge of the pair hits the limit; its fallback job fails without a limit message; its call again passes
    fake.respond = (agent) => ([2, 4].includes(judgeAgents().indexOf(agent)) ? null : funJudge(agent, head, { 'game feel': 'this' }));
    fake.limited = (agent, cli) => cli === 'codex' && judgeAgents().indexOf(agent) === 2;
    expect((await ogw(g.ws, ['loop', 'evaluate', 'g'])).code).toBe(0);
    expect(judgeAgents().map((a) => a.agent)).toEqual([OPUS, OPUS, CONFIRM, CONFIRM, FALLBACK, FALLBACK]);
    const file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(file.judges.slice(2).map((j) => [j.agent, j.fallback, j.status])).toEqual([
      [FALLBACK, 'usage limit', 'done'],
      [CONFIRM, undefined, 'done'],
    ]);
  });

  it('does not fall back without loop.confirmFallback, nor for a judge that does not run with loop.confirmJudge', async () => {
    const { g, head } = await funLoop({ confirmJudge: CONFIRM });
    fake.respond = (agent) => (judgeAgents().indexOf(agent) === 2 ? null : funJudge(agent, head, { 'game feel': 'this' }));
    fake.limited = () => true;
    expect((await ogw(g.ws, ['loop', 'evaluate', 'g'])).code).toBe(0);
    let file = readJsonFile(g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    expect(judgeAgents().map((a) => a.agent)).toEqual([OPUS, OPUS, CONFIRM, CONFIRM]);
    expect(file.judges.map((j) => [j.kind, j.status])).toEqual([['main', 'done'], ['main', 'done'], ['confirm', 'failed'], ['confirm', 'done']]);

    // loop.confirmFallback alone: the success judges run with the agent of the first step 4 judge and do not fall back
    const alone = await loop({ playInstances: 1, backgroundRetryLimit: 0, loop: { funIterations: 3, judgeVotes: 2, judgePanel: [], variants: 1, confirmFallback: FALLBACK } });
    resetRun();
    fake.respond = (agent) => {
      if (agent.role === 'play' || judgeAgents().indexOf(agent) === 2) return null;
      const side = sideCommit(agent, 'A') === alone.head ? 'A' : 'B';
      return judgeText(side, side, 'pass');
    };
    expect((await ogw(alone.g.ws, ['loop', 'evaluate', 'g'])).code).toBe(0);
    file = readJsonFile(alone.g.root, `${R}/evaluate-1.json`) as EvaluateFile;
    // both success judges started together; the one that failed is not called again
    expect(judgeAgents().map((a) => a.agent)).toEqual([OPUS, OPUS, OPUS, OPUS]);
    expect(file.judges.map((j) => [j.kind, j.status, j.fallback])).toEqual([['main', 'done', undefined], ['main', 'done', undefined], ['success', 'failed', undefined], ['success', 'done', undefined]]);
  });
});

/** Waits until `done` holds or `ms` passed: the timeout is what a version that never gets there meets. */
async function until(done: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; !done() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5));
  return done();
}

const PLAY_DONE = '## coverage\n\nunknown: none\n';
const SCENARIO = { steps: [{ kind: 'setup', command: 'f.cheat', timeoutMs: 1000 }], goal: { path: 'telemetry.goal_intervals', op: 'count_gte', value: 1 } };

/** Records the boot of each instance that is not headless: `play` for one of the `playInstances` plays (it has a platform). */
function recordBoots(events: string[]): void {
  fake.booting = (id) => {
    const instance = fake.instances.find((i) => i.id === id);
    if (instance?.client !== 'headless') events.push(instance?.platform === undefined ? 'judge or moment' : 'play');
    return Promise.resolve();
  };
}

/** The instance ids that the inputs of the judges name. */
function judgeInstanceIds(): string[] {
  return judgeAgents().flatMap((a) => {
    const input = a.input as { A: { instance: string }; B: { instance: string } | null; fixtures: { A: string | null; B: string | null }[] };
    return [input.A.instance, input.B?.instance ?? null, ...input.fixtures.flatMap((f) => [f.A, f.B])].filter((id): id is string => id !== null);
  });
}

describe('ogw loop evaluate work beside each other', () => {
  it('starts the instances of the groups that fit together, not one after another', async () => {
    // 8 slots: the 4 play instances (2 plays and a play per moment) and the 2 instances each step 4 judge starts with
    const { g } = await loop({ maxConcurrentInstances: 8 });
    // no poll comes between the starts of the groups: they start in one pass
    evaluateDeps.pollMs = 10_000;
    fake.respond = (agent) => (agent.role === 'play' ? PLAY_DONE : judgeText('A', 'A', 'pass'));
    let booting = 0;
    let most = 0;
    // the broken moment fails its save fixture before its boot: 7 boots of the 8 starts
    fake.booting = async () => {
      booting++;
      most = Math.max(most, booting);
      await until(() => most >= 7, 300);
      booting--;
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    expect(most).toBe(7);
    // no start ran beside 8 instances
    expect(fake.runningAtStart.every((n) => n < 8)).toBe(true);
  });

  it('starts the plays while the shared telemetry runs, and the judges once the runs ended', async () => {
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    write(g.root, 'client/dev/bot/scenario.json', SCENARIO);
    commit(g.root);
    fake.respond = (agent) => (agent.role === 'play' ? PLAY_DONE : judgeText('A', 'A', 'pass'));
    const events: string[] = [];
    bots.running = async () => {
      // the runs end once the play started, or after 300 ms: a version whose plays wait for the runs gets there
      await until(() => events.includes('play'), 300);
      events.push('bot');
    };
    recordBoots(events);
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    // the play started before the runs ended; the judges, whose input names the runs, after all six ended
    expect(events.indexOf('play')).toBeLessThan(events.indexOf('bot'));
    const ids = judgeInstanceIds();
    expect(ids.length).toBeGreaterThan(0);
    const headless = (id: string): boolean => fake.instances.find((i) => i.id === id)?.client === 'headless';
    for (const id of ids) expect(fake.runningIdsAtStart.get(id)?.filter(headless) ?? []).toEqual([]);
    expect(judgeAgents().every((a) => typeof a.input.telemetry === 'string')).toBe(true);
  });

  it('keeps the slots the shared telemetry runs and their judges take for them: no play starts in them', async () => {
    // 8 slots: the 6 runs and the 2 instances each of the 2 step 4 judges start with leave none for a play meanwhile
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0, maxConcurrentInstances: 8 });
    write(g.root, 'client/dev/bot/scenario.json', SCENARIO);
    commit(g.root);
    fake.respond = (agent) => (agent.role === 'play' ? PLAY_DONE : judgeText('A', 'A', 'pass'));
    const events: string[] = [];
    bots.running = async () => {
      await new Promise((r) => setTimeout(r, 30));
      events.push('bot');
    };
    recordBoots(events);
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(events.slice(0, 6)).toEqual(['bot', 'bot', 'bot', 'bot', 'bot', 'bot']);
    // the judges start first, as they did after the runs
    expect(events[6]).toBe('judge or moment');
    expect(fake.runningAtStart.every((n) => n < 8)).toBe(true);
  });

  it('stops the instances of an ended judge together', async () => {
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    let firstStopped = false;
    let stopping = 0;
    let most = 0;
    // the first judge ends first; the other agents end once its 4 instances (the broken pair fails its save fixture)
    // stopped, so that no other stop runs beside them
    fake.respond = (agent) => {
      if (agent === judgeAgents()[0]) return judgeText('A', 'A', 'pass');
      if (!firstStopped) return undefined;
      return agent.role === 'play' ? PLAY_DONE : judgeText('A', 'A', 'pass');
    };
    fake.stopping = async () => {
      stopping++;
      // the stops of the first judge: those before the first time no stop runs
      if (!firstStopped) most = Math.max(most, stopping);
      // the stops end once 4 run at once, or after 200 ms
      await until(() => most >= 4, 200);
      stopping--;
      if (stopping === 0) firstStopped = true;
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(most).toBe(4);
  });

  it('finishes an agent that ended while the work after another ended agent runs', async () => {
    const { g } = await loop({ playInstances: 1, backgroundRetryLimit: 0 });
    let summarizing = false;
    fake.respond = (agent) => {
      if (agent.role === 'play') return PLAY_DONE;
      // the judges end once the telemetry of an ended play is being read
      return summarizing ? judgeText('A', 'A', 'pass') : undefined;
    };
    let judgesStopped = false;
    measure.summarizing = async () => {
      summarizing = true;
      // the summary ends once the step 4 judges ended and their instances stopped, or after 500 ms
      judgesStopped = await until(() => {
        const ids = judgeInstanceIds();
        return ids.length >= 8 && ids.every((id) => fake.stopped.includes(id));
      }, 500);
    };
    const out = await ogw(g.ws, ['loop', 'evaluate', 'g']);
    expect(out.stderr).toBe('');
    expect(judgesStopped).toBe(true);
  });
});
