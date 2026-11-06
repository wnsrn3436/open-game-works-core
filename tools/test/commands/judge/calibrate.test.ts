import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateDeps } from '../../../src/commands/loop/lib/evaluate.ts';
import { ogw, sh } from '../../helpers/workspace.ts';
import { addJob, commit, openLoopRun, setupGame, write, type TestGame } from '../loop/helpers.ts';

interface FakeInstance {
  id: string;
  commit: string;
  latency: number;
  delay: number;
  client: string;
  played: boolean;
}

interface FakeAgent {
  id: string;
  input: { A: { instance: string } | null; B: { instance: string } | null; elements: string[]; telemetry: string | null; reference: unknown; fixtures: unknown[] };
  output: string;
  calibration: { output: string; evidence: string } | undefined;
  agent: { cli: string; model: string; effort: string } | undefined;
}

const fake = vi.hoisted(() => {
  /** The winner per element the judge writes for its input; null for a failed judge. */
  const respond: (agent: FakeAgent, n: number) => Record<string, string> | null = () => ({});
  return { instances: [] as FakeInstance[], agents: [] as FakeAgent[], bots: [] as { commit: string; latency: number; delay: number }[], respond };
});

vi.mock('../../../src/commands/instance/api.ts', () => ({
  startInstance: vi.fn((_ctx: unknown, opts: Record<string, unknown>, hooks: { onReserved?: (id: string) => void } = {}) => {
    const id = `i${String(fake.instances.length + 1)}`;
    fake.instances.push({
      id,
      commit: opts.commit as string,
      latency: (opts.inputLatencyMs as number | undefined) ?? 0,
      delay: (opts.networkDelayMs as number | undefined) ?? 0,
      client: opts.client as string,
      played: opts.played === true,
    });
    hooks.onReserved?.(id);
    return Promise.resolve({ id, commit: opts.commit, root: '/nowhere', game: 'g', serverUrl: '', adminSecret: '' });
  }),
  stopInstance: vi.fn(() => Promise.resolve()),
  listInstances: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../../src/commands/agent/api.ts', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  return {
    startAgentJob: vi.fn((_ctx: unknown, options: { input: string; calibration?: FakeAgent['calibration']; agent?: FakeAgent['agent'] }) => {
      const id = `a${String(fake.agents.length + 1)}`;
      const input = JSON.parse(fs.readFileSync(options.input, 'utf8')) as FakeAgent['input'];
      fake.agents.push({ id, input, output: options.calibration?.output ?? '', calibration: options.calibration, agent: options.agent });
      return Promise.resolve(id);
    }),
    agentOutcome: vi.fn((_ctx: unknown, id: string) => {
      const agent = fake.agents.find((a) => a.id === id) as FakeAgent;
      const winners = fake.respond(agent, fake.agents.indexOf(agent) + 1);
      if (winners === null) return Promise.resolve({ status: 'failed', output: null });
      const rows = agent.input.elements.map((e) => `| ${e} | ${winners[e] ?? 'indistinguishable'} | clear | r | e |`);
      fs.mkdirSync(path.dirname(agent.output), { recursive: true });
      fs.writeFileSync(agent.output, ['## vs baseline', '', '| element | winner | margin | reason | evidence |', '|---|---|---|---|---|', ...rows, ''].join('\n'));
      return Promise.resolve({ status: 'done', output: agent.output });
    }),
  };
});

vi.mock('../../../src/commands/loop/lib/shared-telemetry.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/loop/lib/shared-telemetry.ts')>()),
  botRun: vi.fn((_ctx: unknown, instance: { id: string }) => {
    const started = fake.instances.find((i) => i.id === instance.id) as FakeInstance;
    fake.bots.push({ commit: started.commit, latency: started.latency, delay: started.delay });
    const telemetry = { started_at: 0, inputs: [], rewards: [], marks: [], idle_spans: [], goal_intervals: [], scene_loads: [], dropped: 0 };
    return Promise.resolve({ telemetry, guide: null });
  }),
}));

const RECORD = (instance: string, baseline: string): string =>
  `## commit\n\n- instance: ${instance}\n- baseline: ${baseline}\n- confirms: none\n- kind: fun\n\n## checks\n\nnone\n\n## judge\n\n### records/loops/update-1/judge-1-1.md\n\n- kind: main\n- status: done\n\n## votes\n\nnone\n`;

/** The commit of the instance of the agent's side `side`. */
function sideOf(agent: FakeAgent, side: 'A' | 'B'): FakeInstance {
  const id = agent.input[side]?.instance;
  return fake.instances.find((i) => i.id === id) as FakeInstance;
}

/**
 * Makes main hold the commits base, better and best and the judged iteration records of better against base, best
 * against better, and again better against base, the most recent; returns the commits.
 */
function history(g: TestGame): { base: string; better: string; best: string } {
  // as the .gitignore of `ogw game init`: the calibration evidence goes to builds/
  write(g.root, '.gitignore', '/builds/\n');
  write(g.root, 'client/a.txt', 'base');
  const base = commit(g.root, 'base');
  write(g.root, 'client/a.txt', 'better');
  const better = commit(g.root, 'better');
  write(g.root, 'client/a.txt', 'best');
  const best = commit(g.root, 'best');
  write(g.root, 'records/loops/update-1/iteration-1.md', RECORD(better, base));
  commit(g.root, 'record 1');
  write(g.root, 'records/loops/update-1/iteration-2.md', RECORD(best, better));
  commit(g.root, 'record 2');
  write(g.root, 'records/loops/update-1/iteration-3.md', RECORD(better, base));
  commit(g.root, 'record 3');
  return { base, better, best };
}

/** A judge that sees the commit `better` as better than any other, and the side without a degradation as better, at every element. */
function sensible(better: string) {
  return (agent: FakeAgent): Record<string, string> => {
    const a = sideOf(agent, 'A');
    const b = sideOf(agent, 'B');
    const degradeA = a.latency + a.delay;
    const degradeB = b.latency + b.delay;
    let winner = 'indistinguishable';
    if (degradeA !== degradeB) winner = degradeA < degradeB ? 'A' : 'B';
    else if (a.commit === better && b.commit !== better) winner = 'A';
    else if (b.commit === better && a.commit !== better) winner = 'B';
    return Object.fromEntries(agent.input.elements.map((e) => [e, winner]));
  };
}

const CALIBRATION = { nullPairs: 2, orderPairs: 3, orderRuns: 1, retestPairs: 1, degradedPairs: 2, degradeLatencyMs: 150, degradeNetworkDelayMs: 3000, minDecisions: 2 };
const PANEL = [
  { cli: 'claude-code', model: 'm1', effort: 'high' },
  { cli: 'claude-code', model: 'm2', effort: 'low' },
];
const SETTINGS = { calibration: CALIBRATION, loop: { funIterations: 3, judgeVotes: 2, judgePanel: [], variants: 1 }, backgroundRetryLimit: 1 };

beforeEach(() => {
  fake.instances = [];
  fake.agents = [];
  fake.bots = [];
  evaluateDeps.pollMs = 1;
  evaluateDeps.random = () => 0.1;
  evaluateDeps.now = () => 5000;
});

describe('ogw judge calibrate', () => {
  it('judges the null, order, retest, degraded and labeled pairs as judges of a fun iteration and commits the report on main', async () => {
    const g = setupGame(SETTINGS);
    const { base, better, best } = history(g);
    const missing = 'f'.repeat(40);
    const labels = [
      { A: base, B: better, answers: { 'game feel': 'B', 'tension and release': 'A', 'no friction': 'same', progression: 'B' }, note: '', at: 1 },
      { A: missing, B: better, answers: { 'game feel': 'A' }, note: '', at: 2 },
      { A: better, B: base, answers: { 'game feel': 'A', 'tension and release': 'B', 'no friction': 'A' }, note: '', at: 3 },
    ];
    write(g.root, 'records/calibration/labels.json', labels);
    write(g.root, 'client/dev/bot/scenario.json', { steps: [{ kind: 'setup', command: 'f.cheat', timeoutMs: 1000 }], goal: { path: 'telemetry.goal_intervals', op: 'count_gte', value: 1 } });
    commit(g.root, 'labels');
    const main = sh(g.root, 'git', ['rev-parse', 'HEAD']).trim();
    sh(g.root, 'git', ['checkout', '--quiet', '-b', 'other']);
    fake.respond = sensible(better);
    const run = await ogw(g.ws, ['judge', 'calibrate', 'g']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(sh(g.root, 'git', ['branch', '--show-current']).trim()).toBe('main');
    const report = readFileSync(join(g.root, 'records/calibration/5000.md'), 'utf8');
    expect(run.stdout.split('\n')[0]).toBe('records/calibration/5000.md');
    expect(report).toContain(
      [
        '## rates',
        '',
        '- false win rate: 0.00 (0 of 6)',
        // order-1 is better against base (this wins), order-2 best against better (baseline wins): Cohen kappa 1 per element
        '- order consistency: all 1.00 (6 of 6) kappa 1.00, game feel 1.00 (2 of 2) kappa 1.00, tension and release 1.00 (2 of 2) kappa 1.00, no friction 1.00 (2 of 2) kappa 1.00',
        // one retest pair: every decision `this` in both judgings
        '- retest agreement: all 1.00 (3 of 3) kappa undefined, game feel none (1 of 2) kappa none, tension and release none (1 of 2) kappa none, no friction none (1 of 2) kappa none',
        '- sensitivity: all 1.00 (4 of 4), latency (game feel) 1.00 (2 of 2), network (no friction) 1.00 (2 of 2)',
        '- human agreement: game feel 1.00 (2 of 2), tension and release 0.00 (0 of 2), no friction 0.50 (1 of 2)',
        '- labels: 3',
        '',
        '## recommendations',
        '',
        '- set loop.judgePanel to judges that mix Claude Code models and efforts; add Codex judges only when the Codex CLI is logged in (human agreement tension and release 0.00 (0 of 2), human agreement no friction 0.50 (1 of 2))',
      ].join('\n'),
    );
    expect(report).toContain(`| null-1 | ${main} | ${main} | counted | indistinguishable (0/0) | indistinguishable (0/0) | indistinguishable (0/0) |`);
    // the judged pairs with different commits, most recent first: the first record of better against base is not used again
    expect(report).toContain(`| order-1 | ${better} | ${base} | counted | this (2/0) | this (2/0) | this (2/0) |`);
    expect(report).toContain(`| order-2 | ${best} | ${better} | counted | baseline (0/2) | baseline (0/2) | baseline (0/2) |`);
    expect(report).not.toContain('| order-3 |');
    expect(report).toContain(`| retest-1 | ${better} | ${base} | counted | this (2/0); this (2/0) | this (2/0); this (2/0) | this (2/0); this (2/0) |`);
    expect(report).not.toContain('| retest-2 |');
    expect(report).toContain(`| degraded-latency-1 | ${main} | ${main} | counted | this (2/0) |`);
    expect(report).toContain(`| degraded-network-2 | ${main} | ${main} | counted | this (2/0) |`);
    expect(report).toContain(`| label-1 | ${base} | ${better} | counted | baseline (0/2) |`);
    expect(report).toContain(`| label-2 | ${missing} | ${better} | not judged (${missing} missing) |`);
    expect(report).toContain('| order-1 | 1 | A | done | claude-code ');
    expect(report).toContain('| order-1 | 2 | B | done | claude-code ');
    expect(report).toContain('| retest-1 | 4 | B | done | claude-code ');
    // 2 null pairs, 2 order pairs, 2 judgings of the retest pair, 2 degraded pairs of each degradation and 2 labeled pairs: 2 judges each
    expect(fake.agents).toHaveLength(24);
    for (const agent of fake.agents) {
      expect(agent.input).toMatchObject({ elements: ['game feel', 'tension and release', 'no friction'], fixtures: [], reference: null });
      expect(agent.calibration?.output).toMatch(new RegExp(`^${g.root}/records/calibration/5000/judge-[a-z0-9-]+-[1-4]\\.md$`));
      expect(agent.calibration?.evidence).toMatch(new RegExp(`^${g.root}/builds/calibration/5000/judge-`));
      expect(agent.input.telemetry).toMatch(new RegExp(`^${g.root}/builds/calibration/5000/telemetry-`));
    }
    // the degraded pairs: the baseline instances, and the bot runs of the baseline, have the degradation and only it
    const degradedOf = (latency: number, delay: number): string[] =>
      fake.instances.filter((i) => i.latency === latency && i.delay === delay).map((i) => `${i.commit} ${i.client}`).sort();
    const expected = [...Array.from({ length: 6 }, () => `${main} headless`), ...Array.from({ length: 4 }, () => `${main} window`)].sort();
    expect(degradedOf(150, 0)).toEqual(expected);
    expect(degradedOf(0, 3000)).toEqual(expected);
    expect(fake.instances.filter((i) => i.latency > 0 && i.delay > 0)).toEqual([]);
    expect(fake.bots.filter((b) => b.latency === 150)).toHaveLength(6);
    expect(fake.bots.filter((b) => b.delay === 3000)).toHaveLength(6);
    // a judge of a degraded pair gets the degraded instance on the side opposite this commit
    for (const agent of fake.agents.filter((a) => a.output.includes('/judge-degraded-network-'))) {
      expect(sideOf(agent, 'A').delay + sideOf(agent, 'B').delay).toBe(3000);
    }
    const committed = sh(g.root, 'git', ['show', '--name-only', '--format=%s', 'main']).trim().split('\n');
    expect(committed[0]).toBe('judge calibration 5000');
    expect(committed).toContain('records/calibration/5000.md');
    expect(committed).toContain('records/calibration/5000/judge-order-1-1.md');
    expect(committed).toContain('records/calibration/5000/judge-retest-1-4.md');
    expect(committed).toContain('records/calibration/5000/judge-degraded-network-2-2.md');
    expect(sh(g.root, 'git', ['status', '--porcelain']).trim()).toBe('');
  });

  it('runs the second judging of a retest pair with the agents of the first', async () => {
    const g = setupGame({ ...SETTINGS, calibration: { ...CALIBRATION, nullPairs: 1, orderPairs: 0, degradedPairs: 0 }, loop: { ...SETTINGS.loop, judgeVotes: 4, judgePanel: PANEL } });
    history(g);
    fake.respond = () => ({});
    expect((await ogw(g.ws, ['judge', 'calibrate', 'g'])).code).toBe(0);
    const models = (pair: string): string[] =>
      fake.agents
        .filter((a) => a.output.includes(`/judge-${pair}-`))
        .sort((x, y) => x.output.localeCompare(y.output))
        .map((a) => a.agent?.model ?? '');
    expect(models('null-1')).toEqual(['m1', 'm1', 'm2', 'm2']);
    expect(models('retest-1')).toEqual(['m1', 'm1', 'm2', 'm2', 'm1', 'm1', 'm2', 'm2']);
    const report = readFileSync(join(g.root, 'records/calibration/5000.md'), 'utf8');
    // nothing is decided in either judging: they agree, but every rating is in one category
    expect(report).toContain('- retest agreement: all 1.00 (3 of 3) kappa undefined,');
    expect(report).toContain('- sensitivity: all none (0 of 2), latency (game feel) none (0 of 2), network (no friction) none (0 of 2)');
  });

  it('recommends more votes after a false win and a judge panel after an order effect, and does not count a pair whose judge failed', async () => {
    const g = setupGame({ ...SETTINGS, calibration: { ...CALIBRATION, orderPairs: 1, retestPairs: 0, degradedPairs: 1 } });
    history(g);
    // every judge prefers side A; the second judge of the degraded pair of `network` fails every time
    fake.respond = (agent) => (agent.output.endsWith('/judge-degraded-network-1-2.md') ? null : Object.fromEntries(agent.input.elements.map((e) => [e, 'A'])));
    const run = await ogw(g.ws, ['judge', 'calibrate', 'g']);
    expect(run.code).toBe(0);
    const report = readFileSync(join(g.root, 'records/calibration/5000.md'), 'utf8');
    expect(report).toContain(
      [
        '- false win rate: 0.00 (0 of 6)',
        '- order consistency: all 0.00 (0 of 3) kappa 0.00, game feel none (1 of 2) kappa none, tension and release none (1 of 2) kappa none, no friction none (1 of 2) kappa none',
        '- retest agreement: all none (0 of 2) kappa none, game feel none (0 of 2) kappa none, tension and release none (0 of 2) kappa none, no friction none (0 of 2) kappa none',
        '- sensitivity: all none (1 of 2), latency (game feel) none (1 of 2), network (no friction) none (0 of 2)',
        '- human agreement: none',
        '- labels: 0',
      ].join('\n'),
    );
    expect(report).toContain(
      '- set loop.judgePanel to judges that mix Claude Code models and efforts; add Codex judges only when the Codex CLI is logged in (order consistency all 0.00 (0 of 3), order consistency all kappa 0.00)',
    );
    expect(report).toContain('| degraded-network-1 | ');
    expect(report).toContain(' | not counted |  |  |  |');
    // a judge that always votes for this commit wins the null pairs: decisions need votes from both side assignments
    fake.agents = [];
    fake.instances = [];
    evaluateDeps.now = () => 6000;
    // the coin puts this commit on A for the first judge of each pair; the second judge has it on B
    fake.respond = (agent) => {
      const thisSide = /-1\.md$/.test(agent.output) ? 'A' : 'B';
      return Object.fromEntries(agent.input.elements.map((e) => [e, thisSide]));
    };
    const second = await ogw(g.ws, ['judge', 'calibrate', 'g']);
    expect(second.code).toBe(0);
    const again = readFileSync(join(g.root, 'records/calibration/6000.md'), 'utf8');
    expect(again).toContain('- false win rate: 1.00 (6 of 6)');
    expect(again).toContain('- raise loop.judgeVotes to 4 (false win rate 1.00 (6 of 6))');
  });

  it('does not start with an open run, a running calibration, or changes in the checkout', async () => {
    const g = setupGame(SETTINGS);
    write(g.root, 'x.txt', 'x');
    expect((await ogw(g.ws, ['judge', 'calibrate', 'g'])).stderr).toContain('game repo checkout has changes');
    sh(g.root, 'git', ['clean', '-fdq']);
    const job = await addJob(g.ws, { command: 'judge calibrate', game: 'g', supervisorPid: process.pid });
    expect((await ogw(g.ws, ['judge', 'calibrate', 'g'])).stderr).toContain(`ogw judge calibrate job ${job.id} of game g is running`);
    expect((await ogw(g.ws, ['loop', 'start', 'g', '--command', 'update'], { stdin: 'x' })).stderr).toContain(`ogw judge calibrate job ${job.id} of game g is running`);
    expect((await ogw(g.ws, ['build', 'start', 'g', 'DEV'])).stderr).toContain(`ogw judge calibrate job ${job.id} of game g is running`);
    expect(fake.agents).toHaveLength(0);
    // the calibration job itself runs
    expect((await ogw(g.ws, ['judge', 'calibrate', 'g'], { env: { OGW_JOB_ID: job.id } })).code).toBe(0);
    const agents = fake.agents.length;
    await openLoopRun(g);
    expect((await ogw(g.ws, ['judge', 'calibrate', 'g'], { env: { OGW_JOB_ID: job.id } })).stderr).toContain('game g has an open run: update-1');
    expect(fake.agents).toHaveLength(agents);
  });
});
