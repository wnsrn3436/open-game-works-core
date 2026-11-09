import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateDeps } from '../../../src/commands/loop/lib/evaluate.ts';
import { HARNESS_PINS_KEY } from '../../../src/commands/loop/lib/harness-pin.ts';
import { choiceOrder, targetElement, variantDeps, type VariantEntry, type VariantsFile } from '../../../src/commands/loop/lib/variants.ts';
import { jobPaths, killJob } from '../../../src/lib/jobs.ts';
import { currentRunSettings } from '../../../src/lib/settings.ts';
import { ogw } from '../../helpers/workspace.ts';
import { commit, git, openLoopRun, read, readJsonFile, setRun, setupGame, write, type TestGame } from './helpers.ts';

/** What a fake variant agent does: commit a change and its report, end without a commit, or fail. */
type VariantBehavior = 'commit' | 'no change' | 'fail';
type Vote = 'this' | 'baseline' | null;

interface FakeJudge {
  id: string;
  input: Record<string, unknown>;
  output: string;
  /** The variant k this judge judges. */
  k: number;
  /** The agent CLI, model and effort it was started with. */
  agent: unknown;
}

interface Fake {
  root: string;
  worktrees: string;
  instances: { id: string; commit: string; db?: string }[];
  /** Fails the start of an instance of this commit. */
  failStart: (commit: string) => boolean;
  stopped: string[];
  content: { id: string; k: number; input: string; output: string; status: 'done' | 'failed' }[];
  judges: FakeJudge[];
  /** k by variant commit. */
  commits: Map<string, number>;
  behavior: (k: number) => VariantBehavior;
  /** The vote of judge j of variant k per element. */
  votes: (k: number, j: number) => Record<string, Vote>;
  mergeFails: Set<number>;
  merges: { id: string; alsoCommit: readonly string[] }[];
  /** Whether variant agent k has ended; a running one is `running` to `agentOutcome`. */
  ended: (k: number) => boolean;
  /** The start of a variant agent before it makes its worktree. */
  starting: (k: number) => Promise<void>;
}

const fake = vi.hoisted(
  (): Fake => ({
    root: '',
    worktrees: '',
    instances: [],
    failStart: () => false,
    stopped: [],
    content: [],
    judges: [],
    commits: new Map(),
    behavior: () => 'commit',
    votes: () => ({}),
    mergeFails: new Set(),
    merges: [],
    ended: () => true,
    starting: () => Promise.resolve(),
  }),
);

vi.mock('../../../src/commands/instance/api.ts', () => ({
  startInstance: vi.fn((_ctx: unknown, opts: { commit: string; db?: string }) => {
    if (fake.failStart(opts.commit)) return Promise.reject(new Error('no server'));
    const id = `i${String(fake.instances.length + 1)}`;
    fake.instances.push({ id, commit: opts.commit, ...(opts.db === undefined ? {} : { db: opts.db }) });
    return Promise.resolve({ id, commit: opts.commit, root: join(fake.root, '..', 'instances', id), game: 'g', serverUrl: '', adminSecret: '', startedAt: 1 });
  }),
  stopInstance: vi.fn((_ctx: unknown, id: string) => {
    fake.stopped.push(id);
    return Promise.resolve();
  }),
  listInstances: vi.fn(() => Promise.resolve(fake.instances.filter((i) => !fake.stopped.includes(i.id)))),
}));

/** Fake agent jobs whose kill fails. */
const killFails = vi.hoisted(() => new Set<string>());

vi.mock('../../../src/lib/jobs.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/lib/jobs.ts')>();
  // a fake agent job has no record: killing it ends nothing
  const fakeJob = (id: string): boolean => fake.content.some((c) => c.id === id) || fake.judges.some((j) => j.id === id);
  const kill = (id: string, env?: NodeJS.ProcessEnv): Promise<void> => {
    if (killFails.has(id)) return Promise.reject(new Error(`cannot kill ${id}\nmore`));
    return fakeJob(id) ? Promise.resolve() : original.killJob(id, env);
  };
  return {
    ...original,
    killJob: vi.fn(kill),
    readJob: vi.fn((id: string, env?: NodeJS.ProcessEnv) => (fakeJob(id) ? Promise.resolve({ id, meta: {} }) : original.readJob(id, env))),
  };
});

vi.mock('../../../src/commands/agent/api.ts', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const side = (input: Record<string, unknown>, which: 'A' | 'B'): string =>
    fake.instances.find((i) => i.id === (input[which] as { instance: string }).instance)?.commit ?? '';
  return {
    startAgentJob: vi.fn(async (_ctx: unknown, options: { role: string; input: string; variant?: number; runPlace?: { output: string }; agent?: unknown }) => {
      if (options.role === 'content') {
        const k = options.variant as number;
        await fake.starting(k);
        const id = `c${String(fake.content.length + 1)}v${String(k)}`;
        const wt = path.join(fake.worktrees, 'g', `agent-${id}`);
        sh(fake.root, 'worktree', 'add', '-q', '-b', `agent/${id}`, wt);
        const rel = `records/loops/update-1/content-2-v${String(k)}.md`;
        const behavior = fake.behavior(k);
        if (behavior === 'commit') {
          fs.mkdirSync(path.join(wt, 'records/loops/update-1'), { recursive: true });
          fs.writeFileSync(path.join(wt, rel), `## hypothesis\n\nvariant ${String(k)}\n`);
          fs.writeFileSync(path.join(wt, `client/v${String(k)}.gd`), `# variant ${String(k)}\n`);
          sh(wt, 'add', '-A');
          sh(wt, 'commit', '-qm', `variant ${String(k)}`);
          fake.commits.set(sh(wt, 'rev-parse', 'HEAD'), k);
        } else if (behavior !== 'fail') {
          // a report and no commit: the branch is the work branch commit the variant was made from
          fs.mkdirSync(path.join(wt, 'records/loops/update-1'), { recursive: true });
          fs.writeFileSync(path.join(wt, rel), 'report without a change\n');
        }
        fake.content.push({ id, k, input: options.input, output: path.join(wt, rel), status: behavior === 'fail' ? 'failed' : 'done' });
        return Promise.resolve(id);
      }
      const id = `j${String(fake.judges.length + 1)}`;
      const input = JSON.parse(fs.readFileSync(options.input, 'utf8')) as Record<string, unknown>;
      const k = fake.commits.get(side(input, 'A')) ?? fake.commits.get(side(input, 'B')) ?? 0;
      fake.judges.push({ id, input, output: options.runPlace?.output ?? '', k, agent: options.agent });
      return Promise.resolve(id);
    }),
    agentOutcome: vi.fn((_ctx: unknown, id: string) => {
      const content = fake.content.find((c) => c.id === id);
      if (content !== undefined && !fake.ended(content.k)) return Promise.resolve({ status: 'running', output: null });
      if (content !== undefined) return Promise.resolve({ status: content.status, output: content.status === 'done' ? content.output : null });
      const judge = fake.judges.find((j) => j.id === id) as FakeJudge;
      const thisSide = fake.commits.get(side(judge.input, 'A')) === judge.k ? 'A' : 'B';
      const otherSide = thisSide === 'A' ? 'B' : 'A';
      const j = Number(/-(\d+)\.md$/.exec(judge.output)?.[1]);
      const rows = Object.entries(fake.votes(judge.k, j)).map(([element, vote]) => {
        const winner = vote === 'this' ? thisSide : vote === 'baseline' ? otherSide : 'indistinguishable';
        return `| ${element} | ${winner} | clear | r | e |`;
      });
      const text = ['## vs baseline', '', '| element | winner | margin | reason | evidence |', '|---|---|---|---|---|', ...rows, '', '## vs reference', '', 'none', ''].join('\n');
      fs.mkdirSync(path.dirname(judge.output), { recursive: true });
      fs.writeFileSync(judge.output, text);
      return Promise.resolve({ status: 'done', output: judge.output });
    }),
    mergeAgentJobs: vi.fn((_ctx: unknown, ids: string[], options: { alsoCommit?: readonly string[] } = {}) => {
      const id = ids[0] as string;
      const k = fake.content.find((c) => c.id === id)?.k ?? 0;
      fake.merges.push({ id, alsoCommit: options.alsoCommit ?? [] });
      if (fake.mergeFails.has(k)) return Promise.resolve({ merged: [], failed: [{ id, reason: 'data', detail: 'ERROR x bad row' }] });
      sh(fake.root, 'merge', '-q', '--no-commit', '--no-ff', `agent/${id}`);
      sh(fake.root, 'add', '--', ...(options.alsoCommit ?? []));
      sh(fake.root, 'commit', '-qm', `ogw agent merge ${id}`);
      sh(fake.root, 'worktree', 'remove', '-f', path.join(fake.worktrees, 'g', `agent-${id}`));
      sh(fake.root, 'branch', '-D', `agent/${id}`);
      return Promise.resolve({ merged: [id], failed: [] });
    }),
    retryAgentJob: vi.fn(),
  };
});

const R = 'records/loops/update-1';
const FUN = { funIterations: 3, judgeVotes: 2, judgePanel: [], variants: 3 };

async function funIteration(settings: Record<string, unknown> = {}, command: 'update' | 'create' = 'update'): Promise<{ g: TestGame; base: string }> {
  const g = setupGame({ backgroundRetryLimit: 0, loop: FUN, ...settings });
  const run = await openLoopRun(g, { iteration: 2, command });
  await setRun(g, (r) => {
    r.data.loop = { kinds: [{ iteration: 1, kind: 'completeness' }, { iteration: 2, kind: 'fun' }] };
  });
  write(g.root, 'client/main.gd', '# main\n');
  write(g.root, `${R}/content-input-2.md`, '## kind\n\nfun\n\n## request\n\nnone\n\n## previous record\n\nnone\n\n## defects\n\nnone\n');
  commit(g.root);
  fake.root = g.root;
  fake.worktrees = g.ws.worktrees;
  return { g, base: run.baseCommit };
}

beforeEach(() => {
  fake.instances = [];
  fake.failStart = () => false;
  fake.stopped = [];
  fake.content = [];
  fake.judges = [];
  fake.commits = new Map();
  fake.behavior = () => 'commit';
  fake.votes = () => ({});
  fake.mergeFails = new Set();
  fake.merges = [];
  fake.ended = () => true;
  fake.starting = () => Promise.resolve();
  evaluateDeps.pollMs = 0;
  evaluateDeps.random = () => 0.1;
  variantDeps.pollMs = 0;
});

/** The commit of the instance of side `side` of a judge input. */
function commitOf(input: Record<string, unknown>, side: 'A' | 'B'): string {
  return fake.instances.find((i) => i.id === (input[side] as { instance: string }).instance)?.commit ?? '';
}

function entry(k: number, fields: Partial<VariantEntry> = {}): VariantEntry {
  return { k, job: `j${String(k)}`, element: 'game feel', commit: `c${String(k)}`, judges: [], votes: null, vsBaseline: null, merge: null, chosen: false, ...fields };
}

function votes(...rows: [string, number, number, VariantEntry['votes'] extends (infer V)[] | null ? V extends { decision: infer D } ? D : never : never][]): VariantEntry['votes'] {
  return rows.map(([element, t, b, decision]) => ({ element, this: t, baseline: b, decision }));
}

describe('variant choice', () => {
  it('gives the target element of variant k in iteration n', () => {
    expect([1, 2, 3, 4].map((k) => targetElement(k, 1))).toEqual(['game feel', 'tension and release', 'no friction', 'game feel']);
    expect([1, 2, 3].map((k) => targetElement(k, 2))).toEqual(['tension and release', 'no friction', 'game feel']);
  });

  it('orders better variants by elements decided this, fewest baseline votes and lowest k, then the others by this minus baseline', () => {
    const order = choiceOrder([
      entry(1, { vsBaseline: 'better', votes: votes(['game feel', 2, 0, 'this'], ['no friction', 0, 1, 'indistinguishable']) }),
      entry(2, { vsBaseline: 'better', votes: votes(['game feel', 2, 0, 'this'], ['no friction', 0, 0, 'indistinguishable']) }),
      entry(3, { vsBaseline: 'better', votes: votes(['game feel', 2, 0, 'this'], ['no friction', 2, 0, 'this']) }),
      entry(4, { vsBaseline: 'indistinguishable', votes: votes(['game feel', 1, 0, 'indistinguishable']) }),
      entry(5, { vsBaseline: 'worse', votes: votes(['game feel', 2, 0, 'this'], ['no friction', 0, 2, 'baseline']) }),
      entry(6, { commit: null }),
      entry(7, { vsBaseline: 'indistinguishable', votes: votes(['game feel', 1, 0, 'indistinguishable']) }),
    ]);
    expect(order.map((v) => v.k)).toEqual([3, 2, 1, 4, 7, 5]);
    // without judges every variant with a commit has a margin of 0: the lowest k first
    expect(choiceOrder([entry(2), entry(1, { commit: null }), entry(3)]).map((v) => v.k)).toEqual([2, 3]);
    // a variant whose judges could not run is left out while another variant was judged, even a worse one
    const judgedWorse = entry(3, { vsBaseline: 'worse', votes: votes(['game feel', 0, 2, 'baseline']) });
    expect(choiceOrder([entry(1), entry(2), judgedWorse]).map((v) => v.k)).toEqual([3]);
  });
});

describe('ogw loop variants', () => {
  it('runs the variant agents, judges their commits, merges the chosen one with its records and removes the others', async () => {
    const { g, base } = await funIteration();
    fake.behavior = (k) => (k === 3 ? 'fail' : 'commit');
    // variant 1 wins game feel, variant 2 wins game feel and no friction
    fake.votes = (k): Record<string, Vote> => (k === 1 ? { 'game feel': 'this' } : { 'game feel': 'this', 'no friction': 'this', 'tension and release': null });
    const varjob = await jobPaths('varjob', g.ws.env);
    mkdirSync(join(varjob.record, '..'), { recursive: true });
    writeFileSync(varjob.record, JSON.stringify({ id: 'varjob', argv: [], cwd: '/', command: 'loop variants', game: 'g', startedAt: Date.now(), endedAt: null, status: 'running', exitCode: null, supervisorPid: null, pid: null, timeLimitMs: 60_000, agentJob: null, summary: null, meta: {} }));
    const out = await ogw(g.ws, ['loop', 'variants', 'g'], { env: { ...g.ws.env, OGW_JOB_ID: 'varjob' } });
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    // a span per variant from the start of its agent to its end (failed for the variant whose agent failed), the judging,
    // the merge and the removal of the other worktrees (ogw.md `## time`)
    const spans = readFileSync(varjob.spans, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { name?: string; end: number | null; failed?: true });
    const ended = spans.filter((l) => l.end !== null && l.name !== undefined);
    expect(ended.filter((l) => l.name?.startsWith('variant ') === true).map((l) => [l.name, l.failed === true]).sort()).toEqual([['variant 1', false], ['variant 2', false], ['variant 3', true]]);
    expect(ended.filter((l) => l.name?.startsWith('variant ') !== true).map((l) => l.name)).toEqual(expect.arrayContaining(['judging', 'wait for variants', 'merge', 'remove worktrees']));
    const [v1, v2, v3] = fake.content.map((c) => c.id) as [string, string, string];
    // the inputs: the content input with `## variant`, committed before the agents start
    expect(fake.content.map((c) => c.input)).toEqual([1, 2, 3].map((k) => join(g.root, `${R}/content-input-2-v${String(k)}.md`)));
    expect(git(g.root, 'show', `HEAD^1:${R}/content-input-2-v2.md`)).toBe(
      '## kind\n\nfun\n\n## request\n\nnone\n\n## previous record\n\nnone\n\n## defects\n\nnone\n\n## variant\n\n- variant: 2 of 3\n- element: no friction',
    );
    // two judges per variant commit on alternating sides, fun elements, no fixtures, no reference, in the run folder
    expect(fake.judges.map((j) => [j.k, j.output.slice(g.root.length + 1)])).toEqual([
      [1, `${R}/judge-2-v1-1.md`],
      [1, `${R}/judge-2-v1-2.md`],
      [2, `${R}/judge-2-v2-1.md`],
      [2, `${R}/judge-2-v2-2.md`],
    ]);
    for (const judge of fake.judges) expect(judge.input).toMatchObject({ fixtures: [], elements: ['game feel', 'tension and release', 'no friction'], reference: null });
    expect(fake.judges.map((j) => fake.commits.get(commitOf(j.input, 'A')) === j.k)).toEqual([true, false, true, false]);
    expect(fake.instances.filter((i) => !fake.commits.has(i.commit)).every((i) => i.commit === base)).toBe(true);
    // the record of the choice
    const file = readJsonFile(g.root, `${R}/variants-2.json`) as VariantsFile;
    expect(file.baseline).toBe(base);
    expect(file.variants.map((v) => [v.k, v.job, v.element, v.vsBaseline, v.chosen, v.merge])).toEqual([
      [1, v1, 'tension and release', 'better', false, null],
      [2, v2, 'no friction', 'better', true, null],
      [3, v3, 'game feel', null, false, null],
    ]);
    expect(file.variants[1]?.votes).toEqual([
      { element: 'game feel', this: 2, baseline: 0, decision: 'this' },
      { element: 'tension and release', this: 0, baseline: 0, decision: 'indistinguishable' },
      { element: 'no friction', this: 2, baseline: 0, decision: 'this' },
    ]);
    expect(file.variants[1]?.judges).toEqual([`${R}/judge-2-v2-1.md`, `${R}/judge-2-v2-2.md`]);
    expect(file.variants[2]).toMatchObject({ commit: null, judges: [], votes: null });
    // one merge commit: the variant, its report as the content report, the variants file and the judge results
    expect(fake.merges.map((m) => m.id)).toEqual([v2]);
    expect(git(g.root, 'log', '-1', '--format=%s')).toBe(`ogw agent merge ${v2}`);
    const committed = git(g.root, 'show', '--name-only', '--format=', '--first-parent', '-m', 'HEAD').split('\n').sort();
    expect(committed).toEqual(
      [
        'client/v2.gd',
        `${R}/content-2-v2.md`,
        `${R}/content-2.md`,
        `${R}/judge-2-v1-1.md`,
        `${R}/judge-2-v1-2.md`,
        `${R}/judge-2-v2-1.md`,
        `${R}/judge-2-v2-2.md`,
        `${R}/variants-2.json`,
      ].sort(),
    );
    expect(read(g.root, `${R}/content-2.md`)).toBe('## hypothesis\n\nvariant 2\n');
    // only the judge inputs, which are evidence, are not committed
    expect(git(g.root, 'status', '--porcelain')).toBe(`?? ${R}/evidence/`);
    // the other variants' worktrees and branches are gone
    for (const id of [v1, v3]) {
      expect(existsSync(join(g.ws.worktrees, 'g', `agent-${id}`))).toBe(false);
      expect(git(g.root, 'branch', '--list', `agent/${id}`)).toBe('');
    }
    expect(out.stdout).toContain(`variant 2 ${v2} no friction commit `);
    expect(out.stdout).toContain('vs baseline better chosen\n');
    expect(out.stdout).toContain(`variant 3 ${v3} game feel commit none vs baseline none\n`);
    // the iteration record gets `## variants` from the file
    write(g.root, `${R}/findings-2.json`, { findings: [], discarded: [] });
    write(g.root, `${R}/check-2.json`, { commit: git(g.root, 'rev-parse', 'HEAD'), checks: [], gate: 'pass' });
    commit(g.root);
    expect((await ogw(g.ws, ['loop', 'record', 'g'])).code).toBe(0);
    const record = read(g.root, `${R}/iteration-2.md`);
    expect(record).toContain('## variants\n\n| k | element | commit | vs baseline | chosen |\n|---|---|---|---|---|\n| 1 | tension and release |');
    expect(record).toContain('| 3 | game feel | none | none | no |\n\n## checks');
  });

  it('chooses by this votes minus baseline votes when none is better, and the next variant when a merge fails', async () => {
    const { g } = await funIteration();
    // single votes: every element is indistinguishable; the margins are v1 +1, v2 0, v3 -1
    fake.votes = (k, j): Record<string, Vote> => {
      if (k === 1) return j === 1 ? { 'game feel': 'this' } : {};
      if (k === 2) return j === 1 ? { 'game feel': 'this' } : { 'no friction': 'baseline' };
      return j === 1 ? { 'no friction': 'baseline' } : {};
    };
    fake.mergeFails = new Set([1]);
    const out = await ogw(g.ws, ['loop', 'variants', 'g']);
    expect(out.code).toBe(0);
    const file = readJsonFile(g.root, `${R}/variants-2.json`) as VariantsFile;
    expect(file.variants.map((v) => v.vsBaseline)).toEqual(['indistinguishable', 'indistinguishable', 'indistinguishable']);
    // v1 does not merge, so v2 is chosen
    expect(fake.merges.map((m) => fake.content.find((c) => c.id === m.id)?.k)).toEqual([1, 2]);
    expect(file.variants.map((v) => [v.chosen, v.merge])).toEqual([
      [false, 'data: ERROR x bad row'],
      [true, null],
      [false, null],
    ]);
    expect(read(g.root, `${R}/content-2.md`)).toBe('## hypothesis\n\nvariant 2\n');
    expect(out.stdout).toContain('not merged: data: ERROR x bad row');
  });

  it('prints the content agent call when no variant has a commit, and commits the variants file', async () => {
    const { g } = await funIteration();
    fake.behavior = (k) => (k === 2 ? 'fail' : 'no change');
    const out = await ogw(g.ws, ['loop', 'variants', 'g']);
    expect(out.code).toBe(1);
    // a failed variant agent is not retried: the content agent is called once as without variants
    expect(out.stdout).toContain(`no variant was merged: call the content agent once with ogw agent content --game g --input ${join(g.root, R)}/content-input-2.md --background`);
    expect(out.stdout).not.toContain('ogw agent retry');
    expect(fake.judges).toEqual([]);
    expect(fake.merges).toEqual([]);
    const file = readJsonFile(g.root, `${R}/variants-2.json`) as VariantsFile;
    expect(file.variants.map((v) => [v.commit, v.chosen])).toEqual([
      [null, false],
      [null, false],
      [null, false],
    ]);
    expect(git(g.root, 'log', '-1', '--format=%s')).toBe('loop update-1: variants 2');
    expect(existsSync(join(g.root, `${R}/content-2.md`))).toBe(false);
    for (const c of fake.content) expect(existsSync(join(g.ws.worktrees, 'g', `agent-${c.id}`))).toBe(false);
    expect(git(g.root, 'branch', '--list', 'agent/*')).toBe('');
  });

  it('keeps the finished variants when the judging fails, and passes --db to the judge instances', async () => {
    const { g } = await funIteration({ maxConcurrentInstances: 2 });
    fake.votes = (k): Record<string, Vote> => (k === 1 ? { 'game feel': 'this' } : { 'game feel': 'baseline' });
    // the instances of variant 3 do not start; one judge at a time, so variants 1 and 2 were judged before
    fake.failStart = (c) => fake.commits.get(c) === 3;
    const out = await ogw(g.ws, ['loop', 'variants', 'g', '--db', 'postgresql']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    expect(fake.instances.length).toBeGreaterThan(0);
    expect(fake.instances.every((i) => i.db === 'postgresql')).toBe(true);
    const file = readJsonFile(g.root, `${R}/variants-2.json`) as VariantsFile;
    expect(file.judging).toBe('instance start failed: no server');
    expect(file.variants.map((v) => [v.k, v.vsBaseline, v.votes === null, v.chosen])).toEqual([
      [1, 'better', false, true],
      [2, 'worse', false, false],
      [3, null, true, false],
    ]);
    expect(out.stdout).toContain('judging failed: instance start failed: no server\n');
    expect(fake.stopped.length).toBe(fake.instances.length);
    // without a judged variant, a variant whose judges could not run is chosen by the margin rule
    const all = await funIteration({ maxConcurrentInstances: 2 });
    fake.content = [];
    fake.judges = [];
    fake.commits = new Map();
    fake.failStart = () => true;
    expect((await ogw(all.g.ws, ['loop', 'variants', 'g'])).code).toBe(0);
    const none = readJsonFile(all.g.root, `${R}/variants-2.json`) as VariantsFile;
    expect(none.judging).toBe('instance start failed: no server');
    expect(none.variants.map((v) => [v.votes, v.chosen])).toEqual([
      [null, true],
      [null, false],
      [null, false],
    ]);
    expect((await ogw(all.g.ws, ['loop', 'variants', 'g', '--db', 'mysql'])).stderr).toContain('usage: ogw loop variants <game> [--db postgresql]');
  });

  it('waits for a variant agent that still runs when the judging fails, without killing it, and does not choose it over a judged one', async () => {
    const { g } = await funIteration({ maxConcurrentInstances: 2 });
    fake.votes = (k): Record<string, Vote> => (k === 1 ? { 'game feel': 'this' } : {});
    // the instances of variant 2 do not start; variant 3 runs until the tool waits for the agents the judging left
    fake.failStart = (c) => fake.commits.get(c) === 2;
    const realOnSignal = evaluateDeps.onSignal;
    let watches = 0;
    evaluateDeps.onSignal = (handler) => {
      watches++;
      return realOnSignal(handler);
    };
    // the judging watches signals first, then the wait for the variant agents it left
    fake.ended = (k) => k !== 3 || watches >= 2;
    vi.mocked(killJob).mockClear();
    try {
      const out = await ogw(g.ws, ['loop', 'variants', 'g']);
      expect([out.code, out.stderr]).toEqual([0, '']);
    } finally {
      evaluateDeps.onSignal = realOnSignal;
    }
    const v3 = fake.content.find((c) => c.k === 3)?.id as string;
    expect(vi.mocked(killJob).mock.calls.map((c) => c[0])).not.toContain(v3);
    const file = readJsonFile(g.root, `${R}/variants-2.json`) as VariantsFile;
    expect(file.judging).toBe('instance start failed: no server');
    expect(file.variants.map((v) => [v.k, v.commit !== null, v.judges.length, v.votes === null, v.chosen])).toEqual([
      [1, true, 2, false, true],
      [2, true, 0, true, false],
      [3, true, 0, true, false],
    ]);
    expect(file.variants[2]?.job).toBe(v3);
  });

  it('takes loop.variants and the judge agents from the pin of the run, not from harness settings now', async () => {
    /** Pins the run of `game` to run settings with `variants` variant agents and another judge model. */
    const pin = async (game: TestGame, variants: number): Promise<void> => {
      const runSettings = await currentRunSettings(game.ws.env);
      const agents = runSettings.agents as Record<string, Record<string, unknown>>;
      (runSettings.loop as Record<string, unknown>).variants = variants;
      agents.judge = { ...agents.judge, model: 'claude-haiku-5-5' };
      await setRun(game, (r) => {
        r.data[HARNESS_PINS_KEY] = [{ commit: git(game.ws.harness, 'rev-parse', 'HEAD'), iteration: 0, runSettings }];
      });
    };
    // harness settings hold 3 variants and another judge model
    const { g } = await funIteration();
    await pin(g, 2);
    const out = await ogw(g.ws, ['loop', 'variants', 'g']);
    expect([out.code, out.stderr]).toEqual([0, '']);
    expect(fake.content.map((c) => c.k)).toEqual([1, 2]);
    expect(fake.judges.length).toBeGreaterThan(0);
    for (const judge of fake.judges) expect(judge.agent).toMatchObject({ model: 'claude-haiku-5-5' });
    const one = await funIteration();
    fake.content = [];
    await pin(one.g, 1);
    expect((await ogw(one.g.ws, ['loop', 'variants', 'g'])).stderr).toBe('harness settings loop.variants is 1; call the content agent\n');
    expect(fake.content).toEqual([]);
  });

  it('fails with the start failure of a variant agent after killing the ones it started, and says a kill that failed', async () => {
    const { g } = await funIteration();
    const agentApi = await import('../../../src/commands/agent/api.ts');
    const start = vi.mocked(agentApi.startAgentJob);
    const base = start.getMockImplementation() as NonNullable<ReturnType<typeof start.getMockImplementation>>;
    start.mockImplementation((ctx, options) => (options.variant === 2 ? Promise.reject(new Error('no room')) : base(ctx, options)));
    killFails.add('c1v1');
    try {
      const out = await ogw(g.ws, ['loop', 'variants', 'g']);
      expect(out.code).toBe(1);
      expect(out.stderr).toContain('killing job c1v1 failed: cannot kill c1v1\n');
      expect(out.stderr).toContain('no room');
    } finally {
      start.mockImplementation(base);
      killFails.clear();
    }
  });

  it('runs no judge without a baseline game and chooses the lowest k with a commit', async () => {
    const { g } = await funIteration({}, 'create');
    fake.behavior = (k) => (k === 1 ? 'no change' : 'commit');
    const out = await ogw(g.ws, ['loop', 'variants', 'g']);
    expect(out.code).toBe(0);
    expect(fake.judges).toEqual([]);
    const file = readJsonFile(g.root, `${R}/variants-2.json`) as VariantsFile;
    expect(file).toMatchObject({ baseline: null });
    expect(file.variants.map((v) => [v.vsBaseline, v.chosen])).toEqual([
      [null, false],
      [null, true],
      [null, false],
    ]);
  });

  it('runs only in a fun iteration with loop.variants above 1, after ogw loop input', async () => {
    const one = await funIteration({ loop: { ...FUN, variants: 1 } });
    expect((await ogw(one.g.ws, ['loop', 'variants', 'g'])).stderr).toBe('harness settings loop.variants is 1; call the content agent\n');
    const { g } = await funIteration();
    await setRun(g, (r) => {
      r.data.loop = { kinds: [{ iteration: 2, kind: 'completeness' }] };
    });
    expect((await ogw(g.ws, ['loop', 'variants', 'g'])).stderr).toBe('iteration 2 is not a fun iteration; call the content agent\n');
    await setRun(g, (r) => {
      r.data.loop = { kinds: [{ iteration: 2, kind: 'fun' }] };
    });
    write(g.root, 'client/main.gd', '# changed\n');
    expect((await ogw(g.ws, ['loop', 'variants', 'g'])).stderr).toContain('has uncommitted changes');
    git(g.root, 'checkout', '--', 'client/main.gd');
    git(g.root, 'rm', '-q', `${R}/content-input-2.md`);
    commit(g.root);
    expect((await ogw(g.ws, ['loop', 'variants', 'g'])).stderr).toBe(`${R}/content-input-2.md is missing; run ogw loop input g content first\n`);
    expect(fake.content).toEqual([]);
  });
});

/** Waits until `done` holds or `ms` passed: the timeout is what a version that never gets there meets. */
async function until(done: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; !done() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5));
  return done();
}

describe('ogw loop variants work beside each other', () => {
  it('starts the variant agents together', async () => {
    const { g } = await funIteration();
    let starting = 0;
    let most = 0;
    fake.starting = async () => {
      starting++;
      most = Math.max(most, starting);
      await until(() => most >= 3, 200);
      starting--;
    };
    expect((await ogw(g.ws, ['loop', 'variants', 'g'])).code).toBe(0);
    expect(most).toBe(3);
  });

  it('judges a variant as soon as its agent ended, while the other variant agents run', async () => {
    const { g } = await funIteration();
    fake.votes = (k): Record<string, Vote> => (k === 1 ? { 'game feel': 'this' } : {});
    // variants 2 and 3 end once a judge of variant 1 started, or 500 ms after they were first asked
    let judgedFirst = false;
    let firstAsked: number | null = null;
    fake.ended = (k) => {
      if (k === 1) return true;
      firstAsked ??= Date.now();
      judgedFirst ||= fake.judges.some((j) => j.k === 1);
      return judgedFirst || Date.now() - firstAsked >= 500;
    };
    const out = await ogw(g.ws, ['loop', 'variants', 'g']);
    expect(out.stderr).toBe('');
    expect(judgedFirst).toBe(true);
    // every variant was judged and the record is as when the judges waited for every agent
    const file = readJsonFile(g.root, `${R}/variants-2.json`) as VariantsFile;
    expect(file.variants.map((v) => [v.k, v.vsBaseline, v.chosen])).toEqual([
      [1, 'better', true],
      [2, 'indistinguishable', false],
      [3, 'indistinguishable', false],
    ]);
    expect(fake.judges.map((j) => j.k).sort()).toEqual([1, 1, 2, 2, 3, 3]);
  });
});
