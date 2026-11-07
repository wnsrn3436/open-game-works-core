import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { regressChecks, type CheckResult } from '../../../src/commands/check/api.ts';
import { jobFacts, makeSide, removeSide, sideAgent, sideCheck, sideMerge, sideProbe, type Side, type SideSpec } from '../../../src/commands/regress/lib/side.ts';
import { makeCopyRepo } from '../../../src/commands/regress/lib/copy.ts';
import * as regressPoolModule from '../../../src/commands/regress/lib/pool.ts';
import { leasedAlike, seedRunPlan } from '../../../src/commands/regress/lib/run.ts';
import { pooled } from '../../../src/lib/pool.ts';
import { ogw, makeWorkspace, sh, testSettings, type TestWorkspace } from '../../helpers/workspace.ts';
import { item, meetOtherGroup, overlaps, runningBeside, sourceGame, write, type Span } from './helpers.ts';

vi.mock('../../../src/commands/regress/lib/copy.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/commands/regress/lib/copy.ts')>();
  return { ...actual, makeCopyRepo: vi.fn(actual.makeCopyRepo) };
});
vi.mock('../../../src/lib/pool.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/pool.ts')>();
  return { ...actual, pooled: vi.fn(actual.pooled) };
});

vi.mock('../../../src/commands/check/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/check/api.ts')>()),
  regressChecks: vi.fn(),
}));
vi.mock('../../../src/commands/regress/lib/ops.ts', () => ({ upgradeCore: vi.fn(), dataTool: vi.fn(() => Promise.resolve(null)) }));
vi.mock('../../../src/commands/regress/lib/side.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/regress/lib/side.ts')>()),
  makeSide: vi.fn(),
  removeSide: vi.fn(),
  sideCheck: vi.fn(),
  sideAgent: vi.fn(),
  sideMerge: vi.fn(),
  sideProbe: vi.fn(),
  jobFacts: vi.fn(),
}));

const LEAK = 'client main error log: 1793 error ResourceCore leak: icon/flame';
const MANIFEST = {
  state: 'lc',
  class: 'K1',
  element: 'no blocker',
  expect: 'caught',
  match: [{ check: 'no blocker', where: '^step \\d+$', message: '^client main error log: .*leak: icon/flame' }],
  fixer: 'content',
  row: { id: 'flame-leak', severity: 'blocker', owner: 'client content', why: 'w', source: 'check' },
  frozen: [],
};

function patchOf(to: string): string {
  return ['diff --git a/client/a.gd b/client/a.gd', '--- a/client/a.gd', '+++ b/client/a.gd', '@@ -1 +1 @@', '-var x = 1', `+var x = ${to}`, ''].join('\n');
}

function blockerOf(code: string): CheckResult {
  return code.includes('leak') ? item('no blocker', 'fail', [['step 2', LEAK]]) : item('no blocker', 'pass');
}

/**
 * The regress repo with state lc and seeds S01 (content fixer) and S07b (catch only), and with `secondState` also
 * state lc2 and seeds S08 and S09 (content fixers, S09 with `performance`), refreshed and admitted at 1.0.0.
 */
async function admitted(ws: TestWorkspace, secondState = false): Promise<void> {
  const commit = sourceGame(ws, 'src');
  write(ws.harness, 'regress/states.json', JSON.stringify([{ state: 'lc', game: 'src', commit }, ...(secondState ? [{ state: 'lc2', game: 'src', commit }] : [])]));
  write(ws.harness, 'regress/seeds/S01/seed.json', JSON.stringify(MANIFEST));
  write(ws.harness, 'regress/seeds/S01/patch-1.0.0.diff', patchOf('leak'));
  write(ws.harness, 'regress/seeds/S07b/seed.json', JSON.stringify({ ...MANIFEST, expect: 'missed', match: [], fixer: 'none', row: { ...MANIFEST.row, where: 'w', what: 'gap', evidence: ['e'] } }));
  write(ws.harness, 'regress/seeds/S07b/patch-1.0.0.diff', patchOf('gap'));
  if (secondState) {
    write(ws.harness, 'regress/seeds/S08/seed.json', JSON.stringify({ ...MANIFEST, state: 'lc2' }));
    write(ws.harness, 'regress/seeds/S08/patch-1.0.0.diff', patchOf('leak8'));
    write(ws.harness, 'regress/seeds/S09/seed.json', JSON.stringify({ ...MANIFEST, state: 'lc2', performance: true }));
    write(ws.harness, 'regress/seeds/S09/patch-1.0.0.diff', patchOf('leak9'));
  }
  sh(ws.harness, 'git', ['add', '-A']);
  sh(ws.harness, 'git', ['commit', '-qm', 'bootstrap']);
  sh(ws.harness, 'git', ['tag', 'core-v1.0.0']);
  vi.mocked(regressChecks).mockImplementation((_ctx, game) => Promise.resolve({ checks: [blockerOf(readFileSync(join(game.root, 'client/a.gd'), 'utf8')), item('full flow', 'pass')], fixTestProof: [] }));
  // the refresh checks with the harness itself, whose side commands run in this process
  const actual = await vi.importActual<typeof import('../../../src/commands/regress/lib/side.ts')>('../../../src/commands/regress/lib/side.ts');
  vi.mocked(sideCheck).mockImplementation(actual.sideCheck);
  for (const argv of [['regress', 'init'], ['regress', 'refresh']]) {
    const run = await ogw(ws, argv);
    expect(run.code, `ogw ${argv.join(' ')}:\n${run.stdout}${run.stderr}`).toBe(0);
  }
  vi.mocked(sideCheck).mockReset();
}

/**
 * A side whose side tool runs; with `lease` `instances`, one from before its heavy steps held the performance lease, and
 * with `none`, one from before its instances held it too.
 */
function fakeSide(spec: SideSpec, coreVersion = '1.0.0', lease: 'all' | 'instances' | 'none' = 'all'): Side {
  const leases = { ...(lease === 'none' ? {} : { instanceLease: true as const }), ...(lease === 'all' ? { stepLease: true as const } : {}) };
  return { ...spec, worktree: `/sides/${spec.name}`, unknown: null, info: { commit: spec.commit, coreVersion, promptBytes: { content: 1000, translation: 500 }, agents: { content: { cli: 'claude-code', model: `${spec.name}-model`, effort: 'high' } }, ...leases } };
}

/** The content of client/a.gd at a commit of a game repo. */
function codeAt(ws: TestWorkspace, game: string, commit: string): string {
  return sh(join(ws.games, game), 'git', ['show', `${commit}:client/a.gd`]);
}

beforeEach(() => {
  for (const fn of [makeSide, removeSide, sideCheck, sideAgent, sideMerge, sideProbe, jobFacts, regressChecks]) vi.mocked(fn).mockReset();
  for (const fn of [makeCopyRepo, pooled]) vi.mocked(fn).mockClear();
  vi.mocked(makeSide).mockImplementation((_ctx, spec) => Promise.resolve(fakeSide(spec)));
  vi.mocked(removeSide).mockResolvedValue();
  vi.mocked(jobFacts).mockResolvedValue({ usage: { cli: 'claude-code', model: 'm', effort: 'high', inputTokens: 100, cachedTokens: 0, outputTokens: 1, costUsd: 1, costUnknown: null, turns: 2 }, startedAt: 0, endedAt: 60_000 });
});

describe('seed-run plan', () => {
  it('starts repeat by repeat, seed by seed, the two sides of a repeat next to each other, the side that goes first alternating', () => {
    const seed = (id: string): { seed: { id: string }; admission: object } => ({ seed: { id }, admission: {} });
    const plan = seedRunPlan([seed('S1'), seed('S2')] as unknown as Parameters<typeof seedRunPlan>[0], 2);
    expect(plan.map((p) => `${String(p.k)} ${p.admitted.seed.id} ${p.side}${String(p.repeat)}`)).toEqual(['1 S1 before1', '2 S1 after1', '3 S2 before1', '4 S2 after1', '5 S1 after2', '6 S1 before2', '7 S2 after2', '8 S2 before2']);
  });
});

describe('ogw regress run', () => {
  it('measures only the catch with --catch-only, per side, and commits the report and run.json', async () => {
    const ws = makeWorkspace();
    await admitted(ws);
    const head = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    let firstSeeded = true;
    vi.mocked(sideCheck).mockImplementation((_ctx, side, request) => {
      const code = codeAt(ws, request.game, request.commit);
      // the first check of a seeded commit of S01 gives no result: it is checked once more and the second counts
      if (code.includes('leak') && side.name === 'before' && firstSeeded) {
        firstSeeded = false;
        return Promise.resolve({ file: { commit: request.commit, checks: [item('no blocker', 'unknown', [['step 1', 'host busy']])], fixTestProof: [] }, minutes: 1 });
      }
      // the after side catches the gap of S07b with a new failure of its regression test
      const gap = side.name === 'after' && code.includes('gap') ? [item('regression test', 'fail', [['server/tests/shop.test.ts:9', 'order not checked']])] : [];
      return Promise.resolve({ file: { commit: request.commit, checks: [blockerOf(code), item('full flow', 'pass'), ...gap], fixTestProof: [] }, minutes: 1 });
    });
    const run = await ogw(ws, ['regress', 'run', '--before', head, '--catch-only']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const [reportLine, ...difference] = run.stdout.trim().split('\n');
    expect(difference).toEqual(['- catch S07b: before missed, after caught']);
    const report = readFileSync((reportLine as string).replace('report: ', ''), 'utf8');
    expect(report).toContain('| S01 | lc | caught | caught (pipeline none) | caught (pipeline none) |');
    expect(report).toContain('| S07b | lc | missed | missed | caught | none | regression test\\|-\\|server/tests/shop.test.ts\\|order not checked |');
    expect(report).toContain('| before | ' + head);
    expect(vi.mocked(sideAgent)).not.toHaveBeenCalled();
    expect(sh(ws.regress, 'git', ['status', '--porcelain']).trim()).toBe('');
    expect(sh(ws.regress, 'git', ['log', '-1', '--format=%s']).trim()).toMatch(/^regress run \d+$/);
    // per side: one base check of the state and one check of each seeded commit, all checks, the base with performance
    const calls = vi.mocked(sideCheck).mock.calls.map((c) => [c[1].name, c[2].checks, c[2].performance]);
    expect(calls.filter((c) => c[0] === 'before')).toHaveLength(4);
    // the after side catches S07b, which is to be missed: its seeded commit is checked once more too
    expect(calls.filter((c) => c[0] === 'after')).toHaveLength(4);
    expect(calls.filter((c) => c[2] === true)).toHaveLength(2);
    expect(vi.mocked(removeSide)).toHaveBeenCalledTimes(2);
  });

  /**
   * Fake checks that keep the span of each check, keyed by side and file, and that wait with `meet` until a check of
   * another group (side and game) has started too.
   */
  function timedChecks(ws: TestWorkspace, spans: (Span & { performance: boolean })[], meet: (request: { performance: boolean }) => boolean): void {
    const started = new Set<string>();
    vi.mocked(sideCheck).mockImplementation(async (_ctx, side, request) => {
      const start = performance.now();
      const group = `${side.name} ${request.game}`;
      if (meet(request)) await meetOtherGroup(started, group);
      await new Promise((resolve) => setTimeout(resolve, 15));
      spans.push({ key: `${side.name} ${basename(request.out)}`, group, start, end: performance.now(), performance: request.performance });
      return { file: { commit: request.commit, checks: [blockerOf(codeAt(ws, request.game, request.commit)), item('full flow', 'pass')], fixTestProof: [] }, minutes: 1 };
    });
  }

  it('checks the catch of both sides and of every state together, a catch once the base check of its state has ended', async () => {
    const ws = makeWorkspace();
    await admitted(ws, true);
    const head = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    const spans: (Span & { performance: boolean })[] = [];
    // every check waits until a check of another side or state has started: checks that ran one after another would not meet
    timedChecks(ws, spans, () => true);
    const run = await ogw(ws, ['regress', 'run', '--before', head, '--catch-only']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(spans.map((s) => s.key).sort()).toEqual(['after S01.json', 'after S07b.json', 'after S08.json', 'after S09.json', 'after lc-base.json', 'after lc2-base.json', 'before S01.json', 'before S07b.json', 'before S08.json', 'before S09.json', 'before lc-base.json', 'before lc2-base.json']);
    // checks of one state run beside each other, with performance or without, and the sides beside each other
    expect(overlaps(spans, true)).not.toEqual([]);
    expect(overlaps(spans.filter((s) => s.performance), false)).not.toEqual([]);
    const before = spans.filter((s) => s.key.startsWith('before'));
    const after = spans.filter((s) => s.key.startsWith('after'));
    expect(Math.min(...after.map((s) => s.start))).toBeLessThan(Math.max(...before.map((s) => s.end)));
    const report = readFileSync(run.stdout.split('\n')[0]?.replace('report: ', '') ?? '', 'utf8');
    for (const seed of ['S01', 'S08', 'S09']) expect(report).toContain(`| ${seed} | `);
    expect(report).toMatch(/\| S01 \| lc \| caught \| caught \(pipeline none\) \| caught \(pipeline none\) \|/);
  });

  it('with a side tool whose instances do not hold the performance lease, checks the catch with performance alone', async () => {
    const ws = makeWorkspace();
    await admitted(ws, true);
    const head = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    vi.mocked(makeSide).mockImplementation((_ctx, spec) => Promise.resolve(fakeSide(spec, '1.0.0', spec.name === 'after' ? 'all' : 'none')));
    const spans: (Span & { performance: boolean })[] = [];
    timedChecks(ws, spans, (request) => !request.performance);
    const run = await ogw(ws, ['regress', 'run', '--before', head, '--catch-only']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    // the base checks and the checks of S09 have performance
    expect(spans.filter((s) => s.performance).map((s) => s.key).sort()).toEqual(['after S09.json', 'after lc-base.json', 'after lc2-base.json', 'before S09.json', 'before lc-base.json', 'before lc2-base.json']);
    for (const span of spans.filter((s) => s.performance)) expect(runningBeside(spans, span)).toEqual([]);
    expect(overlaps(spans.filter((s) => !s.performance), false)).not.toEqual([]);
  });

  /** A fixer that fixes the leak on the after side and leaves it on the before side, in the fix repo of its game. */
  function fakeFixer(ws: TestWorkspace, seen: string[], before: () => void = () => undefined): void {
    vi.mocked(sideAgent).mockImplementation((_ctx, side, request) => {
      before();
      const repo = join(ws.games, request.game);
      // every seed-run starts from the seeded commit in a fix repo of its own
      if (request.seedRun.endsWith(':1')) expect(readFileSync(join(repo, 'client/a.gd'), 'utf8')).toMatch(/^var x = leak\d*\n$/);
      seen.push(`${side.name} ${request.game} ${request.seedRun}`);
      const [records, n] = request.seedRun.split(':') as [string, string];
      write(repo, 'client/a.gd', side.name === 'after' ? 'var x = 1\n' : `var x = leak${n}\n`);
      write(repo, `records/loops/${records}/content-${n}.md`, '## defects\n\n| id | result | note |\n|---|---|---|\n| flame-leak | fixed | done |\n');
      sh(repo, 'git', ['add', '-A']);
      sh(repo, 'git', ['commit', '-qm', 'fix', '--no-verify']);
      return Promise.resolve({ job: 'j', status: 'done', output: null, reason: null });
    });
  }

  it('runs each seed-run in a fix repo of its own, all reserved before any fixer, and removes the fix repos', async () => {
    const ws = makeWorkspace();
    await admitted(ws);
    const head = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    vi.mocked(sideCheck).mockImplementation((_ctx, _side, request) => {
      const file = { commit: request.commit, checks: [blockerOf(codeAt(ws, request.game, request.commit)), item('full flow', 'pass')], fixTestProof: [] };
      // as the side command does: the check file at --out
      write('/', request.out, JSON.stringify(file));
      return Promise.resolve({ file, minutes: 1 });
    });
    const seen: string[] = [];
    // the folders of the fix repos of all 4 seed-runs and of their worktrees are there before any fixer starts
    const reserved: boolean[] = [];
    fakeFixer(ws, seen, () => {
      if (reserved.length === 0) for (let k = 1; k <= 4; k++) for (const parent of [ws.games, ws.worktrees]) reserved.push(existsSync(join(parent, `ogw-regress-fix-${String(k)}`)));
    });
    const run = await ogw(ws, ['regress', 'run', '--before', head, '--repeats', '2', '--after-agent', 'content=codex/gpt/high']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    // the before side never fixes it and runs to the cap of loopStop.repeatedDefect iterations; seed-run k in fix repo k
    expect(seen.map((s) => s.replace(/regress-\d+-/, 'regress-ms-')).sort()).toEqual([
      'after ogw-regress-fix-2 regress-ms-2:1',
      'after ogw-regress-fix-3 regress-ms-3:1',
      'before ogw-regress-fix-1 regress-ms-1:1',
      'before ogw-regress-fix-1 regress-ms-1:2',
      'before ogw-regress-fix-1 regress-ms-1:3',
      'before ogw-regress-fix-4 regress-ms-4:1',
      'before ogw-regress-fix-4 regress-ms-4:2',
      'before ogw-regress-fix-4 regress-ms-4:3',
    ]);
    expect(reserved).toEqual(Array<boolean>(8).fill(true));
    expect(vi.mocked(makeSide).mock.calls.map((c) => c[1])).toEqual([
      { name: 'before', commit: head, agents: {} },
      { name: 'after', commit: head, agents: { content: { cli: 'codex', model: 'gpt', effort: 'high' } } },
    ]);
    for (let k = 1; k <= 4; k++) for (const parent of [ws.games, ws.worktrees]) expect(existsSync(join(parent, `ogw-regress-fix-${String(k)}`))).toBe(false);
    const report = readFileSync(run.stdout.split('\n')[0]?.replace('report: ', '') ?? '', 'utf8');
    expect(report).toMatch(/\| S01 \| before \| 1 \| not fixed \| 0 \| 4 \|/);
    expect(report).toMatch(/\| S01 \| after \| 1 \| fixed \| 1 \| 1 \|/);
    expect(run.stdout).toMatch(/- fixed: before 0, after 1, D 1, p [0-9.]+, (better|no difference) \(1 seeds\)/);
    const ms = /records\/runs\/(\d+)\.md/.exec(run.stdout)?.[1] ?? '';
    expect(existsSync(join(ws.regress, 'records', 'runs', ms, 'S01-after-1.diff'))).toBe(true);
    expect(existsSync(join(ws.regress, 'records', 'runs', ms, 'checks', 'catch', 'after', 'S01.json'))).toBe(true);
    const data = JSON.parse(readFileSync(join(ws.regress, 'records', 'runs', ms, 'run.json'), 'utf8')) as { seedRuns: { id: string }[] };
    expect(data.seedRuns.map((r) => r.id)).toEqual(['S01-before-1', 'S01-after-1', 'S01-after-2', 'S01-before-2']);
  });

  /** The spans of the fixer jobs of the seed-runs, keyed by seed-run records, grouped by seed and side. */
  /**
   * With `meet`, each fixer waits until `meet` fixers run at once or `limitMs` has passed: fixers that run together get
   * past it at once, and one that runs alone only at the limit.
   */
  function timedFixer(ws: TestWorkspace, spans: Span[], meet: number, limitMs: number): void {
    let running = 0;
    vi.mocked(sideAgent).mockImplementation(async (_ctx, side, request) => {
      const start = performance.now();
      running += 1;
      const repo = join(ws.games, request.game);
      const seed = readFileSync(join(repo, 'client/a.gd'), 'utf8').trim();
      const group = `${seed} ${side.name}`;
      for (const until = Date.now() + limitMs; running < meet && Date.now() < until; ) await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      const [records, n] = request.seedRun.split(':') as [string, string];
      write(repo, 'client/a.gd', 'var x = 1\n');
      write(repo, `records/loops/${records}/content-${n}.md`, '## defects\n\n| id | result | note |\n|---|---|---|\n| flame-leak | fixed | done |\n');
      sh(repo, 'git', ['add', '-A']);
      sh(repo, 'git', ['commit', '-qm', 'fix', '--no-verify']);
      spans.push({ key: records, group, start, end: performance.now() });
      return { job: 'j', status: 'done', output: null, reason: null };
    });
  }

  it('runs the seed-runs of every seed, side and repeat together, also those of a seed with performance', async () => {
    const ws = makeWorkspace({ regress: { ...(testSettings().regress as object), parallel: 8 } });
    await admitted(ws, true);
    const head = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    vi.mocked(sideCheck).mockImplementation((_ctx, _side, request) => Promise.resolve({ file: { commit: request.commit, checks: [blockerOf(codeAt(ws, request.game, request.commit)), item('full flow', 'pass')], fixTestProof: [] }, minutes: 1 }));
    const spans: Span[] = [];
    timedFixer(ws, spans, 8, 2000);
    const run = await ogw(ws, ['regress', 'run', '--before', head, '--repeats', '2', '--seeds', 'S08', 'S09']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    // 2 seeds, 2 sides, 2 repeats, each fixed in iteration 1
    expect(spans).toHaveLength(8);
    // the two seed-runs of one seed and side run beside each other, and S09 (performance) beside those of S08
    expect(overlaps(spans, true)).not.toEqual([]);
    const s09 = spans.filter((s) => s.group.startsWith('var x = leak9'));
    expect(s09.some((span) => runningBeside(spans, span).some((key) => spans.find((o) => o.key === key)?.group.startsWith('var x = leak8') === true))).toBe(true);
  });

  it('with a side tool whose instances do not hold the performance lease, runs the seed-runs of a seed with performance after the others, one at a time', async () => {
    const ws = makeWorkspace({ regress: { ...(testSettings().regress as object), parallel: 8 } });
    await admitted(ws, true);
    const head = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    vi.mocked(makeSide).mockImplementation((_ctx, spec) => Promise.resolve(fakeSide(spec, '1.0.0', spec.name === 'after' ? 'all' : 'none')));
    vi.mocked(sideCheck).mockImplementation((_ctx, _side, request) => Promise.resolve({ file: { commit: request.commit, checks: [blockerOf(codeAt(ws, request.game, request.commit)), item('full flow', 'pass')], fixTestProof: [] }, minutes: 1 }));
    const spans: Span[] = [];
    timedFixer(ws, spans, 2, 500);
    const run = await ogw(ws, ['regress', 'run', '--before', head, '--repeats', '2', '--seeds', 'S08', 'S09']);
    expect(run.code).toBe(0);
    const s09 = spans.filter((s) => s.group.startsWith('var x = leak9'));
    expect(s09).toHaveLength(4);
    for (const span of s09) expect(runningBeside(spans, span)).toEqual([]);
    const s08 = spans.filter((s) => s.group.startsWith('var x = leak8'));
    expect(Math.max(...s08.map((s) => s.end))).toBeLessThanOrEqual(Math.min(...s09.map((s) => s.start)));
  });

  it('keeps the coarse rule, with the pool of ogw, for sides of which only one keeps its heavy steps off a measurement', async () => {
    const ws = makeWorkspace({ regress: { ...(testSettings().regress as object), parallel: 8 } });
    await admitted(ws, true);
    const head = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    vi.mocked(makeSide).mockImplementation((_ctx, spec) => Promise.resolve(fakeSide(spec, '1.0.0', spec.name === 'after' ? 'all' : 'instances')));
    vi.mocked(sideCheck).mockImplementation((_ctx, _side, request) => Promise.resolve({ file: { commit: request.commit, checks: [blockerOf(codeAt(ws, request.game, request.commit)), item('full flow', 'pass')], fixTestProof: [] }, minutes: 1 }));
    const spans: Span[] = [];
    timedFixer(ws, spans, 2, 500);
    const run = await ogw(ws, ['regress', 'run', '--before', head, '--repeats', '2', '--seeds', 'S08', 'S09']);
    expect(run.code).toBe(0);
    const s09 = spans.filter((s) => s.group.startsWith('var x = leak9'));
    expect(s09).toHaveLength(4);
    for (const span of s09) expect(runningBeside(spans, span)).toEqual([]);
    // the seed-runs go through the pool of ogw, which the regress pool does not copy
    expect(vi.mocked(pooled).mock.calls.filter((c) => c[1] === 8).map((c) => c[0].length)).toEqual([4]);
    expect(Object.keys(regressPoolModule)).not.toContain('pooled');
    const info = (lease: 'all' | 'instances' | 'none'): NonNullable<Side['info']> => fakeSide({ name: 'before', commit: head, agents: {} }, '1.0.0', lease).info as NonNullable<Side['info']>;
    expect([leasedAlike(info('all'), info('all')), leasedAlike(info('instances'), info('instances')), leasedAlike(info('instances'), info('all')), leasedAlike(info('all'), info('none'))]).toEqual([true, true, false, false]);
  });

  it('starts the seed-runs of a seed once the after side has caught it, while the catch of another seed runs on', async () => {
    const ws = makeWorkspace({ regress: { ...(testSettings().regress as object), parallel: 8 } });
    await admitted(ws, true);
    const head = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    const fixers: { seed: string; start: number }[] = [];
    const slowEnded = new Map<string, number>();
    vi.mocked(sideCheck).mockImplementation(async (_ctx, side, request) => {
      const code = codeAt(ws, request.game, request.commit).trim();
      // the catch of S01 by the after side and that of S08 by the before side end only once a fixer of S08 has started,
      // at most after 5 s
      const slow = request.out.includes('/catch/') && ((code === 'var x = leak' && side.name === 'after') || (code === 'var x = leak8' && side.name === 'before'));
      if (slow) {
        for (const until = Date.now() + 5000; !fixers.some((f) => f.seed === 'S08') && Date.now() < until; ) await new Promise((resolve) => setTimeout(resolve, 5));
        slowEnded.set(`${side.name} ${code}`, performance.now());
      }
      return { file: { commit: request.commit, checks: [blockerOf(code), item('full flow', 'pass')], fixTestProof: [] }, minutes: 1 };
    });
    vi.mocked(sideAgent).mockImplementation((_ctx, _side, request) => {
      const repo = join(ws.games, request.game);
      const code = readFileSync(join(repo, 'client/a.gd'), 'utf8').trim();
      fixers.push({ seed: code === 'var x = leak8' ? 'S08' : code === 'var x = leak' ? 'S01' : code, start: performance.now() });
      const [records, n] = request.seedRun.split(':') as [string, string];
      write(repo, 'client/a.gd', 'var x = 1\n');
      write(repo, `records/loops/${records}/content-${n}.md`, '## defects\n\n| id | result | note |\n|---|---|---|\n| flame-leak | fixed | done |\n');
      sh(repo, 'git', ['add', '-A']);
      sh(repo, 'git', ['commit', '-qm', 'fix', '--no-verify']);
      return Promise.resolve({ job: 'j', status: 'done', output: null, reason: null });
    });
    const run = await ogw(ws, ['regress', 'run', '--before', head, '--repeats', '1', '--seeds', 'S01', 'S08']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(fixers.map((f) => f.seed).sort()).toEqual(['S01', 'S01', 'S08', 'S08']);
    // the seed-runs of S08 start before the after side's catch of S01 and the before side's catch of S08 have ended, those
    // of S01 only after the after side's catch of S01
    const s08 = Math.min(...fixers.filter((f) => f.seed === 'S08').map((f) => f.start));
    expect(s08).toBeLessThan(slowEnded.get('after var x = leak') as number);
    expect(s08).toBeLessThan(slowEnded.get('before var x = leak8') as number);
    expect(Math.min(...fixers.filter((f) => f.seed === 'S01').map((f) => f.start))).toBeGreaterThan(slowEnded.get('after var x = leak') as number);
    const ms = /records\/runs\/(\d+)\.md/.exec(run.stdout)?.[1] ?? '';
    const data = JSON.parse(readFileSync(join(ws.regress, 'records', 'runs', ms, 'run.json'), 'utf8')) as { seedRuns: { id: string }[] };
    // the results keep the order of the seed-runs
    expect(data.seedRuns.map((r) => r.id)).toEqual(['S01-before-1', 'S01-after-1', 'S08-before-1', 'S08-after-1']);
  });

  it('makes the fix repo of a seed once from its seeded commit and those of its other seed-runs as clones of it, each with its own hook', async () => {
    const ws = makeWorkspace();
    await admitted(ws);
    const head = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    vi.mocked(sideCheck).mockImplementation((_ctx, _side, request) => Promise.resolve({ file: { commit: request.commit, checks: [blockerOf(codeAt(ws, request.game, request.commit)), item('full flow', 'pass')], fixTestProof: [] }, minutes: 1 }));
    const repos: { game: string; hook: string; hooksPath: string; root: string }[] = [];
    fakeFixer(ws, [], () => undefined);
    const fixer = vi.mocked(sideAgent).getMockImplementation() as typeof sideAgent;
    vi.mocked(sideAgent).mockImplementation((ctx, side, request) => {
      const repo = join(ws.games, request.game);
      if (request.seedRun.endsWith(':1')) {
        const hooksPath = sh(repo, 'git', ['config', 'core.hooksPath']).trim();
        repos.push({ game: request.game, hook: readFileSync(join(hooksPath, 'pre-commit'), 'utf8'), hooksPath, root: sh(repo, 'git', ['rev-list', '--max-parents=0', 'main']).trim() });
      }
      return fixer(ctx, side, request);
    });
    const run = await ogw(ws, ['regress', 'run', '--before', head, '--repeats', '2']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(repos.map((r) => r.game).sort()).toEqual(['ogw-regress-fix-1', 'ogw-regress-fix-2', 'ogw-regress-fix-3', 'ogw-regress-fix-4']);
    // one fix repo made from the seeded commit, the 3 others clones of it on this host
    expect(vi.mocked(makeCopyRepo).mock.calls.filter((c) => c[1].startsWith('ogw-regress-fix-')).map((c) => c[1])).toEqual(process.platform === 'darwin' ? ['ogw-regress-fix-1'] : ['ogw-regress-fix-1', 'ogw-regress-fix-2', 'ogw-regress-fix-3', 'ogw-regress-fix-4']);
    for (const repo of repos) {
      expect(repo.hooksPath).toBe(join(ws.games, repo.game, '.git', 'hooks'));
      expect(repo.hook).toContain(`# ogw pre-commit hook of game ${repo.game}\n`);
    }
    expect(new Set(repos.map((r) => r.root)).size).toBe(1);
  });

  it('writes only sides and unknown with an unknown side and ends with exit code 1', async () => {
    const ws = makeWorkspace();
    await admitted(ws);
    const head = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    vi.mocked(makeSide).mockImplementation((_ctx, spec) => Promise.resolve(spec.name === 'before' ? { ...spec, worktree: null, info: null, unknown: 'the side tool of x does not run ogw regress side' } : fakeSide(spec)));
    const run = await ogw(ws, ['regress', 'run', '--before', head]);
    expect(run.code).toBe(1);
    const report = readFileSync(run.stdout.split('\n')[0]?.replace('report: ', '') ?? '', 'utf8');
    expect([...report.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(['sides', 'unknown']);
    expect(report).toContain('- side before: the side tool of x does not run ogw regress side');
    expect(vi.mocked(sideCheck)).not.toHaveBeenCalled();
  });

  it('fails before any check when the sides have different core versions, and without a before side', async () => {
    const ws = makeWorkspace();
    await admitted(ws);
    const head = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    vi.mocked(makeSide).mockImplementation((_ctx, spec) => Promise.resolve(fakeSide(spec, spec.name === 'before' ? '0.9.0' : '1.0.0')));
    const run = await ogw(ws, ['regress', 'run', '--before', head]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('the sides have different harness core versions: before');
    expect(vi.mocked(sideCheck)).not.toHaveBeenCalled();
    expect(vi.mocked(removeSide)).toHaveBeenCalledTimes(2);
    expect((await ogw(ws, ['regress', 'run'])).stderr).toContain('no accepted.json in');
    expect((await ogw(ws, ['regress', 'run', '--before', head, '--after-agent', 'content=codex'])).stderr).toContain('an agent override is <role>=<cli>/<model>/<effort>');
    write(ws.harness, 'AGENTS.md', 'changed\n');
    expect((await ogw(ws, ['regress', 'run', '--before', head])).stderr).toContain('the harness repo has uncommitted changes');
  });

  it('takes the before side from accepted.json with its agent settings', async () => {
    const ws = makeWorkspace();
    await admitted(ws);
    const head = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    write(ws.regress, 'accepted.json', JSON.stringify({ commit: head, agents: { content: { cli: 'claude-code', model: 'old', effort: 'low' } }, run: '1', at: 1 }));
    sh(ws.regress, 'git', ['add', '-A']);
    sh(ws.regress, 'git', ['commit', '-qm', 'accepted']);
    vi.mocked(sideCheck).mockImplementation((_ctx, _side, request) => Promise.resolve({ file: { commit: request.commit, checks: [blockerOf(codeAt(ws, request.game, request.commit))], fixTestProof: [] }, minutes: 1 }));
    expect((await ogw(ws, ['regress', 'run', '--catch-only', '--seeds', 'S01'])).code).toBe(0);
    expect(vi.mocked(makeSide).mock.calls[0]?.[1]).toEqual({ name: 'before', commit: head, agents: { content: { cli: 'claude-code', model: 'old', effort: 'low' } } });
    expect((await ogw(ws, ['regress', 'run', '--catch-only', '--seeds', 'S99'])).stderr).toContain('no seed S99');
  });
});
