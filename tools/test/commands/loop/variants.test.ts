import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateDeps } from '../../../src/commands/loop/lib/evaluate.ts';
import { choiceOrder, targetElement, variantDeps, type VariantEntry, type VariantsFile } from '../../../src/commands/loop/lib/variants.ts';
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
}

interface Fake {
  root: string;
  worktrees: string;
  instances: { id: string; commit: string }[];
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
}

const fake = vi.hoisted(
  (): Fake => ({
    root: '',
    worktrees: '',
    instances: [],
    stopped: [],
    content: [],
    judges: [],
    commits: new Map(),
    behavior: () => 'commit',
    votes: () => ({}),
    mergeFails: new Set(),
    merges: [],
  }),
);

vi.mock('../../../src/commands/instance/api.ts', () => ({
  startInstance: vi.fn((_ctx: unknown, opts: { commit: string }) => {
    const id = `i${String(fake.instances.length + 1)}`;
    fake.instances.push({ id, commit: opts.commit });
    return Promise.resolve({ id, commit: opts.commit, root: join(fake.root, '..', 'instances', id), game: 'g', serverUrl: '', adminSecret: '', startedAt: 1 });
  }),
  stopInstance: vi.fn((_ctx: unknown, id: string) => {
    fake.stopped.push(id);
    return Promise.resolve();
  }),
  listInstances: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../../src/commands/agent/api.ts', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const side = (input: Record<string, unknown>, which: 'A' | 'B'): string =>
    fake.instances.find((i) => i.id === (input[which] as { instance: string }).instance)?.commit ?? '';
  return {
    startAgentJob: vi.fn((_ctx: unknown, options: { role: string; input: string; variant?: number; runPlace?: { output: string } }) => {
      if (options.role === 'content') {
        const k = options.variant as number;
        const id = `c${String(fake.content.length + 1)}v${String(k)}`;
        const wt = path.join(fake.worktrees, 'g', `agent-${id}`);
        sh(fake.root, 'worktree', 'add', '-q', '-b', `agent/${id}`, wt);
        const rel = `records/loops/update-1/content-2-v${String(k)}.md`;
        const behavior = fake.behavior(k);
        if (behavior !== 'fail') {
          fs.mkdirSync(path.join(wt, 'records/loops/update-1'), { recursive: true });
          fs.writeFileSync(path.join(wt, rel), `## hypothesis\n\nvariant ${String(k)}\n`);
          // the run log `ogw agent` commits is no change of the agent
          fs.writeFileSync(path.join(wt, `records/loops/update-1/content-2-v${String(k)}-runs.json`), '{"runs":[]}\n');
          if (behavior === 'commit') fs.writeFileSync(path.join(wt, `client/v${String(k)}.gd`), `# variant ${String(k)}\n`);
          else fs.rmSync(path.join(wt, rel));
          sh(wt, 'add', '-A');
          sh(wt, 'commit', '-qm', `variant ${String(k)}`);
          if (behavior === 'commit') fake.commits.set(sh(wt, 'rev-parse', 'HEAD'), k);
          else fs.writeFileSync(path.join(wt, rel), 'report without a change\n');
        }
        fake.content.push({ id, k, input: options.input, output: path.join(wt, rel), status: behavior === 'fail' ? 'failed' : 'done' });
        return Promise.resolve(id);
      }
      const id = `j${String(fake.judges.length + 1)}`;
      const input = JSON.parse(fs.readFileSync(options.input, 'utf8')) as Record<string, unknown>;
      const k = fake.commits.get(side(input, 'A')) ?? fake.commits.get(side(input, 'B')) ?? 0;
      fake.judges.push({ id, input, output: options.runPlace?.output ?? '', k });
      return Promise.resolve(id);
    }),
    agentOutcome: vi.fn((_ctx: unknown, id: string) => {
      const content = fake.content.find((c) => c.id === id);
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
  fake.stopped = [];
  fake.content = [];
  fake.judges = [];
  fake.commits = new Map();
  fake.behavior = () => 'commit';
  fake.votes = () => ({});
  fake.mergeFails = new Set();
  fake.merges = [];
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
  });
});

describe('ogw loop variants', () => {
  it('runs the variant agents, judges their commits, merges the chosen one with its records and removes the others', async () => {
    const { g, base } = await funIteration();
    fake.behavior = (k) => (k === 3 ? 'fail' : 'commit');
    // variant 1 wins game feel, variant 2 wins game feel and no friction
    fake.votes = (k): Record<string, Vote> => (k === 1 ? { 'game feel': 'this' } : { 'game feel': 'this', 'no friction': 'this', 'tension and release': null });
    const out = await ogw(g.ws, ['loop', 'variants', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
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
    for (const judge of fake.judges) expect(judge.input).toMatchObject({ fixtures: [], elements: ['game feel', 'tension and release', 'no friction'], telemetry: null, reference: null });
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
        `${R}/content-2-v2-runs.json`,
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

  it('fails the content agent of the iteration when no variant has a commit, and commits the variants file', async () => {
    const { g } = await funIteration();
    fake.behavior = (k) => (k === 2 ? 'fail' : 'no change');
    const out = await ogw(g.ws, ['loop', 'variants', 'g']);
    expect(out.code).toBe(1);
    const failed = fake.content[1]?.id ?? '';
    expect(out.stdout).toContain(`no variant was merged: the content agent failed; retry it with ogw agent retry ${failed} --background`);
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
    // no variant agent failed: the content agent is called as without variants
    const none = await funIteration();
    fake.content = [];
    fake.behavior = () => 'no change';
    const out2 = await ogw(none.g.ws, ['loop', 'variants', 'g']);
    expect(out2.code).toBe(1);
    expect(out2.stdout).toContain(`no variant was merged and no variant agent failed: call the content agent with ogw agent content --game g --input ${join(none.g.root, R)}/content-input-2.md --background`);
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
