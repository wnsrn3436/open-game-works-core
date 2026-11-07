import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { regressChecks, type CheckResult } from '../../../src/commands/check/api.ts';
import { sideAgent, sideProbe } from '../../../src/commands/regress/lib/side.ts';
import { stateSettings, upgradeCore } from '../../../src/commands/regress/lib/ops.ts';
import { withRegressLock } from '../../../src/commands/regress/lib/repo.ts';
import { readMark } from '../../../src/commands/regress/lib/mark.ts';
import { ogw, makeWorkspace, sh, testSettings, type TestWorkspace } from '../../helpers/workspace.ts';
import { ctxOf, item, joinedSpans, meetOtherGroup, overlaps, runningBeside, sourceGame, write, type Span } from './helpers.ts';

vi.mock('../../../src/commands/check/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/check/api.ts')>()),
  regressChecks: vi.fn(),
}));
vi.mock('../../../src/commands/regress/lib/ops.ts', () => ({ upgradeCore: vi.fn(), stateSettings: vi.fn(), dataTool: vi.fn(() => Promise.resolve(null)) }));
vi.mock('../../../src/commands/regress/lib/side.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/regress/lib/side.ts')>()),
  sideAgent: vi.fn(),
  sideProbe: vi.fn(),
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

/** A patch of the source game that the seed puts in: client/a.gd from `var x = 1` to `var x = <to>`. */
function patchOf(to: string): string {
  return ['diff --git a/client/a.gd b/client/a.gd', '--- a/client/a.gd', '+++ b/client/a.gd', '@@ -1 +1 @@', '-var x = 1', `+var x = ${to}`, ''].join('\n');
}

/** A harness with the bootstrap folder `regress/` of one state and the given seeds, at core version 1.0.0. */
function bootstrap(ws: TestWorkspace, commit: string, seeds: Record<string, { manifest: object; patch: string; reference?: string; oracle?: boolean }>, settings?: Record<string, unknown>): void {
  write(ws.harness, 'regress/states.json', JSON.stringify([{ state: 'lc', game: 'src', commit, ...(settings === undefined ? {} : { settings }) }]));
  for (const [id, seed] of Object.entries(seeds)) {
    write(ws.harness, `regress/seeds/${id}/seed.json`, JSON.stringify(seed.manifest));
    write(ws.harness, `regress/seeds/${id}/patch-0.9.0.diff`, seed.patch);
    if (seed.reference !== undefined) write(ws.harness, `regress/seeds/${id}/reference-0.9.0.diff`, seed.reference);
    if (seed.oracle === true) write(ws.harness, `regress/seeds/${id}/oracle/oracle.json`, '{"probe": "probe.ts", "languages": ["ko"]}');
  }
  sh(ws.harness, 'git', ['add', '-A']);
  sh(ws.harness, 'git', ['commit', '-qm', 'regress bootstrap']);
  sh(ws.harness, 'git', ['tag', 'core-v1.0.0']);
}

/** Fake checks: the leak shows on a checkout whose client/a.gd holds `leak`; unknown on `busy`, and on every second check of `flaky`. */
function fakeChecks(): void {
  let flaky = 0;
  vi.mocked(regressChecks).mockImplementation((_ctx, game) => {
    const code = readFileSync(join(game.root, 'client/a.gd'), 'utf8');
    const busy = code.includes('busy') || (code.includes('flaky') && flaky++ % 2 === 1);
    const blocker: CheckResult = busy ? item('no blocker', 'unknown', [['step 1', 'host busy']]) : item('no blocker', code.includes('leak') || code.includes('flaky') ? 'fail' : 'pass', code.includes('leak') || code.includes('flaky') ? [['step 2', LEAK]] : []);
    return Promise.resolve({ checks: [item('regression test', 'pass'), blocker, item('full flow', 'pass')], fixTestProof: [] });
  });
}

beforeEach(() => {
  vi.mocked(regressChecks).mockReset();
  vi.mocked(upgradeCore).mockReset();
  vi.mocked(stateSettings).mockReset().mockResolvedValue({ ok: true, text: 'none' });
  vi.mocked(sideAgent).mockReset();
  vi.mocked(sideProbe).mockReset();
  fakeChecks();
});

describe('ogw regress init, state, status', () => {
  it('makes the regress repo from regress/ of the harness with its states, and only once', async () => {
    const ws = makeWorkspace();
    const commit = sourceGame(ws, 'src');
    bootstrap(ws, commit, { S01: { manifest: MANIFEST, patch: patchOf('leak') } });
    const run = await ogw(ws, ['regress', 'init']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`state lc: ogw-regress-lc from src ${commit}`);
    expect(JSON.parse(readFileSync(join(ws.regress, 'states.json'), 'utf8'))).toEqual([{ state: 'lc', game: 'src', commit }]);
    expect(readFileSync(join(ws.regress, 'seeds/S01/patch-0.9.0.diff'), 'utf8')).toBe(patchOf('leak'));
    expect(sh(ws.regress, 'git', ['status', '--porcelain']).trim()).toBe('');
    expect(await readMark(join(ws.games, 'ogw-regress-lc', '.git'))).toEqual({ kind: 'state', state: 'lc' });
    expect((await ogw(ws, ['regress', 'init'])).stderr).toContain('exists: the regress repo is made once');
    const status = await ogw(ws, ['regress', 'status']);
    expect(status.stdout).toBe(
      [`regress repo: ${ws.regress}`, 'harness core version: 1.0.0', 'state lc: none', 'seed S01: not admitted', 'accepted: none', 'last run: none', ''].join('\n'),
    );
  });

  it('leaves nothing half made when a seed names a state that is not in states.json', async () => {
    const ws = makeWorkspace();
    const commit = sourceGame(ws, 'src');
    bootstrap(ws, commit, { S01: { manifest: { ...MANIFEST, state: 'nowhere' }, patch: patchOf('leak') } });
    const run = await ogw(ws, ['regress', 'init']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('seed S01: state nowhere is not in');
    expect(existsSync(ws.regress)).toBe(false);
    expect(existsSync(join(ws.games, 'ogw-regress-lc'))).toBe(false);
  });

  it('adds a state, refusing a name that is taken, and refuses while another command holds the lock', async () => {
    const ws = makeWorkspace();
    const commit = sourceGame(ws, 'src');
    bootstrap(ws, commit, {});
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    expect((await ogw(ws, ['regress', 'state', 'lc2', '--game', 'src', '--commit', 'main'])).stdout).toContain(`state lc2: ogw-regress-lc2 from src ${commit}`);
    expect((await ogw(ws, ['regress', 'state', 'lc2', '--game', 'src', '--commit', 'main'])).stderr).toContain('state lc2 is in states.json');
    expect((await ogw(ws, ['regress', 'state', 'Bad_Name', '--game', 'src', '--commit', 'main'])).stderr).toContain('a state name is kebab-case');
    expect((await ogw(ws, ['regress', 'state', 'fix-2', '--game', 'src', '--commit', 'main'])).stderr).toContain('not fix-<n>');
    await withRegressLock(ctxOf(ws), ws.regress, async () => {
      expect((await ogw(ws, ['regress', 'state', 'lc3', '--game', 'src', '--commit', 'main'])).stderr).toContain('another ogw regress command holds');
    });
  });
});

describe('ogw regress settings', () => {
  it('keeps the settings of a state from regress/ of the harness, and writes values over them, one commit each', async () => {
    const ws = makeWorkspace();
    const commit = sourceGame(ws, 'src');
    bootstrap(ws, commit, {}, { 'uiCheckScreens.0.pixelRatio': 1 });
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    const states = (): unknown => JSON.parse(readFileSync(join(ws.regress, 'states.json'), 'utf8'));
    expect(states()).toEqual([{ state: 'lc', game: 'src', commit, settings: { 'uiCheckScreens.0.pixelRatio': 1 } }]);
    const run = await ogw(ws, ['regress', 'settings', 'lc', 'uiCheckScreens.0.pixelRatio', '2', 'uiCheckScreens.1.pixelRatio', '1']);
    expect(run).toMatchObject({ code: 0, stdout: 'set uiCheckScreens.0.pixelRatio\nset uiCheckScreens.1.pixelRatio\n' });
    expect(states()).toEqual([{ state: 'lc', game: 'src', commit, settings: { 'uiCheckScreens.0.pixelRatio': 2, 'uiCheckScreens.1.pixelRatio': 1 } }]);
    expect(sh(ws.regress, 'git', ['log', '-1', '--format=%s']).trim()).toBe('regress settings lc');
    expect(sh(ws.regress, 'git', ['status', '--porcelain']).trim()).toBe('');
    expect((await ogw(ws, ['regress', 'settings', 'nowhere', 'a', '1'])).stderr).toBe('state nowhere is not in states.json\n');
    expect((await ogw(ws, ['regress', 'settings', 'lc', 'a', 'not json'])).stderr).toBe('not a JSON value: not json\n');
    expect((await ogw(ws, ['regress', 'settings', 'lc', 'a'])).stderr).toBe('usage: ogw regress settings <state> <path> <JSON value> [<path> <JSON value>]...\n');
    expect(states()).toEqual([{ state: 'lc', game: 'src', commit, settings: { 'uiCheckScreens.0.pixelRatio': 2, 'uiCheckScreens.1.pixelRatio': 1 } }]);
  });

  it('writes the settings of a state below the core version of the harness before its upgrade, and stops there when a lead value is missing', async () => {
    const ws = makeWorkspace();
    const commit = sourceGame(ws, 'src');
    bootstrap(ws, commit, { S01: { manifest: MANIFEST, patch: patchOf('leak') } }, { 'uiCheckScreens.0.pixelRatio': 1 });
    sh(ws.harness, 'git', ['tag', 'core-v2.0.0']);
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    const order: string[] = [];
    vi.mocked(stateSettings).mockImplementation((_ctx, game, values, version) => {
      order.push(`settings ${game.name} ${JSON.stringify(values)} ${version}`);
      return Promise.resolve({ ok: false, text: 'missing: uiCheckScreens.1.pixelRatio' });
    });
    vi.mocked(upgradeCore).mockImplementation(() => {
      order.push('upgrade');
      return Promise.resolve({ ok: true, text: '2.0.0' });
    });
    const run = await ogw(ws, ['regress', 'refresh']);
    expect(order).toEqual(['settings ogw-regress-lc {"uiCheckScreens.0.pixelRatio":1} 2.0.0']);
    expect(sideAgent).not.toHaveBeenCalled();
    expect(regressChecks).not.toHaveBeenCalled();
    expect(run.stdout).toContain('state lc: no base-2.0.0 (missing: uiCheckScreens.1.pixelRatio; none; none; none)');
    expect(run.stdout).toContain('seed S01: stale (base fails target: lc missing: uiCheckScreens.1.pixelRatio; none; none; none)');
    const record = readFileSync(join(ws.regress, 'records', 'refresh-2.0.0.md'), 'utf8');
    expect(record).toContain('| state | from | settings | upgrade | content job | base checks | base failures | tag |');
    expect(record).toContain('| lc | 1.0.0 | missing: uiCheckScreens.1.pixelRatio | none | none | none | none | none |');
    // with the value written, the next refresh goes on to the upgrade
    order.length = 0;
    vi.mocked(stateSettings).mockImplementation(() => {
      order.push('settings');
      return Promise.resolve({ ok: true, text: 'set' });
    });
    vi.mocked(sideAgent).mockResolvedValue({ job: 'c1', status: 'done', output: null, reason: null });
    await ogw(ws, ['regress', 'refresh']);
    expect(order).toEqual(['settings', 'upgrade']);
    expect(readFileSync(join(ws.regress, 'records', 'refresh-2.0.0.md'), 'utf8')).toContain('| lc | 1.0.0 | set | to 2.0.0 |');
  });
});

describe('ogw regress refresh and admission', () => {
  it('checks and tags the base, admits a caught seed and keeps its patch, base checks and record', async () => {
    const ws = makeWorkspace();
    const commit = sourceGame(ws, 'src');
    bootstrap(ws, commit, { S01: { manifest: MANIFEST, patch: patchOf('leak') } });
    // the source game is on core 1.0.0, the core version of the harness: no upgrade, no content agent
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    const run = await ogw(ws, ['regress', 'refresh']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(vi.mocked(upgradeCore)).not.toHaveBeenCalled();
    expect(vi.mocked(sideAgent)).not.toHaveBeenCalled();
    const state = join(ws.games, 'ogw-regress-lc');
    const base = sh(state, 'git', ['rev-parse', 'base-1.0.0']).trim();
    expect(base).toBe(sh(state, 'git', ['rev-parse', 'main']).trim());
    const admission = JSON.parse(readFileSync(join(ws.regress, 'seeds/S01/admitted-1.0.0.json'), 'utf8')) as Record<string, unknown>;
    expect(admission).toMatchObject({ result: 'admitted', base, catch: ['caught', 'caught', 'caught'], reference: null, oracle: null, reason: null });
    expect(sh(state, 'git', ['show', `${String(admission.seeded)}:client/a.gd`])).toBe('var x = leak\n');
    expect(readFileSync(join(ws.regress, 'seeds/S01/patch-1.0.0.diff'), 'utf8')).toContain('+var x = leak');
    // 3 base checks of every check, 3 checks of the target checks of the seeded commit
    expect(vi.mocked(regressChecks).mock.calls.map((c) => [...(c[3].only ?? ['all'])].join(','))).toEqual(['all', 'all', 'all', 'no blocker', 'no blocker', 'no blocker']);
    expect(vi.mocked(regressChecks).mock.calls.slice(0, 3).every((c) => c[3].performance)).toBe(true);
    expect(existsSync(join(ws.regress, 'records/refresh-1.0.0/lc-base-1.json'))).toBe(true);
    const record = readFileSync(join(ws.regress, 'records/refresh-1.0.0.md'), 'utf8');
    expect(record).toContain('| lc | 1.0.0 | none | none | none | 3 clean | none | base-1.0.0 |');
    expect(record).toContain('| S01 | admitted | none | caught, caught, caught | none |');
    expect(sh(ws.regress, 'git', ['status', '--porcelain']).trim()).toBe('');
    expect((await ogw(ws, ['regress', 'status'])).stdout).toContain('state lc: base-1.0.0\nseed S01: admitted\n');
    // the worktrees of the checks and of the admission are gone
    expect(sh(state, 'git', ['worktree', 'list']).trim().split('\n')).toHaveLength(1);
  });

  it('makes stale a seed whose patch does not apply, one not caught, and one whose catch is unknown', async () => {
    const ws = makeWorkspace();
    const commit = sourceGame(ws, 'src');
    bootstrap(ws, commit, {
      S01: { manifest: MANIFEST, patch: patchOf('leak').replace('-var x = 1', '-var x = 9') },
      S02: { manifest: MANIFEST, patch: patchOf('2') },
      S03: { manifest: MANIFEST, patch: patchOf('busy') },
      S04: { manifest: MANIFEST, patch: patchOf('flaky') },
    });
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    const run = await ogw(ws, ['regress', 'refresh']);
    expect(run.code).toBe(1);
    const read = (id: string): Record<string, unknown> => JSON.parse(readFileSync(join(ws.regress, `seeds/${id}/admitted-1.0.0.json`), 'utf8')) as Record<string, unknown>;
    expect(read('S01')).toMatchObject({ result: 'stale', reason: expect.stringMatching(/^patch does not apply: /) as unknown });
    expect(read('S02')).toMatchObject({ result: 'stale', reason: 'not caught: missed, missed, missed' });
    expect(read('S03')).toMatchObject({ result: 'stale', reason: 'not caught: unknown, unknown, unknown' });
    // one check of the three that does not catch it is enough to make it stale
    expect(read('S04')).toMatchObject({ result: 'stale', reason: 'not caught: caught, unknown, caught' });
    expect(existsSync(join(ws.regress, 'seeds/S02/patch-1.0.0.diff'))).toBe(false);
    expect((await ogw(ws, ['regress', 'status'])).stdout).toContain('seed S02: stale (not caught: missed, missed, missed)');
  });

  it('admits an oracle seed only when its probe fails on the seeded commit and passes on the reference fix', async () => {
    const ws = makeWorkspace();
    const commit = sourceGame(ws, 'src');
    const missed = { ...MANIFEST, expect: 'missed', match: [], oracle: true, row: { ...MANIFEST.row, source: 'play', where: 'result', what: 'shows 4', evidence: ['play'] } };
    const reference = ['diff --git a/client/a.gd b/client/a.gd', '--- a/client/a.gd', '+++ b/client/a.gd', '@@ -1 +1 @@', '-var x = 5', '+var x = 1', ''].join('\n');
    bootstrap(ws, commit, { S09: { manifest: missed, patch: patchOf('5'), reference, oracle: true }, S10: { manifest: missed, patch: patchOf('6'), reference: reference.replace('-var x = 5', '-var x = 6'), oracle: true } });
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    const state = join(ws.games, 'ogw-regress-lc');
    vi.mocked(sideProbe).mockImplementation((_ctx, _side, request) => {
      const code = sh(state, 'git', ['show', `${request.commit}:client/a.gd`]).trim();
      // S10's probe passes on its seeded commit too: it does not see the seed
      return Promise.resolve({ result: code === 'var x = 5' ? 'fail' : 'pass', reason: code });
    });
    expect((await ogw(ws, ['regress', 'refresh'])).code).toBe(1);
    const s09 = JSON.parse(readFileSync(join(ws.regress, 'seeds/S09/admitted-1.0.0.json'), 'utf8')) as Record<string, unknown>;
    expect(s09).toMatchObject({ result: 'admitted', catch: ['missed', 'missed', 'missed'], oracle: { seeded: 'fail', reference: 'pass' } });
    expect(sh(state, 'git', ['show', `${String(s09.reference)}:client/a.gd`])).toBe('var x = 1\n');
    expect(readFileSync(join(ws.regress, 'seeds/S09/reference-1.0.0.diff'), 'utf8')).toContain('+var x = 1');
    const s10 = JSON.parse(readFileSync(join(ws.regress, 'seeds/S10/admitted-1.0.0.json'), 'utf8')) as Record<string, unknown>;
    expect(s10).toMatchObject({ result: 'stale', reason: 'oracle: seeded pass (var x = 6), reference pass (var x = 1)' });
  });

  it('upgrades a state below the core version of the harness and runs one content agent before the base checks', async () => {
    const ws = makeWorkspace();
    const commit = sourceGame(ws, 'src');
    bootstrap(ws, commit, { S01: { manifest: MANIFEST, patch: patchOf('leak') } });
    sh(ws.harness, 'git', ['tag', 'core-v2.0.0']);
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    const state = join(ws.games, 'ogw-regress-lc');
    vi.mocked(upgradeCore).mockImplementation(() => {
      write(state, 'settings.json', '{"coreVersion": "2.0.0"}\n');
      sh(state, 'git', ['commit', '-qam', 'core 2.0.0', '--no-verify']);
      return Promise.resolve({ ok: true, text: '2.0.0' });
    });
    const inputs: string[] = [];
    vi.mocked(sideAgent).mockImplementation((_ctx, _side, request) => {
      inputs.push(readFileSync(request.input, 'utf8'));
      expect(request.seedRun).toMatch(/^refresh-2\.0\.0-\d+:1$/);
      return Promise.resolve({ job: 'c1', status: 'done', output: null, reason: null });
    });
    const run = await ogw(ws, ['regress', 'refresh']);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('state lc: base-2.0.0');
    expect(inputs).toEqual(['## kind\n\ncompleteness\n\n## request\n\n- core version raised to `2.0.0`\n\n## previous record\n\nnone\n\n## defects\n\nnone\n']);
    expect(sh(state, 'git', ['show', 'base-2.0.0:settings.json'])).toBe('{"coreVersion": "2.0.0"}\n');
  });

  it('takes a new seed with ogw regress seed on the kept base checks', async () => {
    const ws = makeWorkspace();
    const commit = sourceGame(ws, 'src');
    bootstrap(ws, commit, {});
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    const folder = join(ws.root, 'new-seeds', 'S11');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'seed.json'), JSON.stringify(MANIFEST));
    writeFileSync(join(folder, 'patch-1.0.0.diff'), patchOf('leak'));
    expect((await ogw(ws, ['regress', 'seed', folder])).stderr).toContain('state lc has no base-1.0.0: run ogw regress refresh');
    expect((await ogw(ws, ['regress', 'refresh'])).code).toBe(0);
    vi.mocked(regressChecks).mockClear();
    const run = await ogw(ws, ['regress', 'seed', folder]);
    expect(run.stdout).toBe('seed S11: admitted\n');
    // the base checks of the refresh are kept: only the seeded commit is checked
    expect(vi.mocked(regressChecks)).toHaveBeenCalledTimes(3);
    expect(sh(ws.regress, 'git', ['log', '-1', '--format=%s']).trim()).toBe('regress seed S11');
  });
});

describe('ogw regress refresh: the order of the admissions', () => {
  /**
   * States lc and lc2 of the source game, each with two caught seeds: S21 and S22 on lc, S23 and S24 on lc2, those of
   * `withPerformance` with `performance`.
   */
  function twoStates(ws: TestWorkspace, withPerformance: readonly string[] = []): void {
    const commit = sourceGame(ws, 'src');
    write(ws.harness, 'regress/states.json', JSON.stringify([{ state: 'lc', game: 'src', commit }, { state: 'lc2', game: 'src', commit }]));
    for (const [id, state] of [['S21', 'lc'], ['S22', 'lc'], ['S23', 'lc2'], ['S24', 'lc2']] as const) {
      write(ws.harness, `regress/seeds/${id}/seed.json`, JSON.stringify({ ...MANIFEST, state, performance: withPerformance.includes(id) }));
      write(ws.harness, `regress/seeds/${id}/patch-1.0.0.diff`, patchOf(`leak${id}`));
    }
    sh(ws.harness, 'git', ['add', '-A']);
    sh(ws.harness, 'git', ['commit', '-qm', 'regress bootstrap']);
    sh(ws.harness, 'git', ['tag', 'core-v1.0.0']);
  }

  /**
   * Fake checks that catch the leak and keep the span of each check of a seeded commit, keyed by the seeded code and
   * grouped by state. With `meet`, a check of a seeded commit waits until one of another state has started.
   */
  function timedChecks(spans: Span[], meet: boolean): void {
    const started = new Set<string>();
    vi.mocked(regressChecks).mockImplementation(async (_ctx, game) => {
      const code = readFileSync(join(game.root, 'client/a.gd'), 'utf8').trim();
      const leak = code.includes('leak');
      if (leak) {
        const start = performance.now();
        if (meet) await meetOtherGroup(started, game.name);
        await new Promise((resolve) => setTimeout(resolve, 15));
        spans.push({ key: code, group: game.name, start, end: performance.now() });
      }
      return { checks: [item('regression test', 'pass'), item('no blocker', leak ? 'fail' : 'pass', leak ? [['step 2', LEAK]] : []), item('full flow', 'pass')], fixTestProof: [] };
    });
  }

  it('admits the seeds of one state one after another and the states together', async () => {
    const ws = makeWorkspace();
    twoStates(ws);
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    const spans: Span[] = [];
    timedChecks(spans, true);
    const run = await ogw(ws, ['regress', 'refresh']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const admissions = joinedSpans(spans);
    expect(admissions.map((s) => s.key).sort()).toEqual(['var x = leakS21', 'var x = leakS22', 'var x = leakS23', 'var x = leakS24']);
    expect(overlaps(admissions, true)).toEqual([]);
    expect(overlaps(admissions, false)).not.toEqual([]);
    expect(readFileSync(join(ws.regress, 'records/refresh-1.0.0.md'), 'utf8')).toMatch(/\| S21 \| admitted [^\n]*\n\| S22 \| admitted [^\n]*\n\| S23 \| admitted [^\n]*\n\| S24 \| admitted /);
  });

  it('admits the seeds of at most regress.parallel states at a time', async () => {
    const ws = makeWorkspace({ regress: { ...(testSettings().regress as object), parallel: 1 } });
    twoStates(ws);
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    const spans: Span[] = [];
    timedChecks(spans, false);
    expect((await ogw(ws, ['regress', 'refresh'])).code).toBe(0);
    const admissions = joinedSpans(spans);
    expect(admissions).toHaveLength(4);
    expect(overlaps(admissions, true)).toEqual([]);
    expect(overlaps(admissions, false)).toEqual([]);
  });

  it('runs a check with performance while no other check of the refresh runs, and the checks without performance of different states together', async () => {
    const ws = makeWorkspace();
    twoStates(ws, ['S22', 'S24']);
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    const spans: (Span & { performance: boolean })[] = [];
    const started = new Set<string>();
    let n = 0;
    vi.mocked(regressChecks).mockImplementation(async (_ctx, game, _evidence, pick) => {
      const code = readFileSync(join(game.root, 'client/a.gd'), 'utf8').trim();
      const key = `${game.name} ${code} ${String(++n)}`;
      const start = performance.now();
      if (!pick.performance) await meetOtherGroup(started, game.name);
      await new Promise((resolve) => setTimeout(resolve, 15));
      spans.push({ key, group: game.name, start, end: performance.now(), performance: pick.performance });
      const leak = code.includes('leak');
      return { checks: [item('regression test', 'pass'), item('no blocker', leak ? 'fail' : 'pass', leak ? [['step 2', LEAK]] : []), item('full flow', 'pass')], fixTestProof: [] };
    });
    const run = await ogw(ws, ['regress', 'refresh']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    // 3 base checks of each state and 3 checks of each seeded commit of S22 and S24 have performance
    const alone = spans.filter((s) => s.performance);
    expect(alone).toHaveLength(12);
    for (const span of alone) expect(runningBeside(spans, span)).toEqual([]);
    expect(overlaps(spans.filter((s) => !s.performance), false)).not.toEqual([]);
  });
});

describe('ogw regress accept', () => {
  it('accepts the after side of a run with agents, not a catch-only run or one with an unknown side', async () => {
    const ws = makeWorkspace();
    const commit = sourceGame(ws, 'src');
    bootstrap(ws, commit, {});
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    const side = (name: string, unknown: string | null): object => ({ name, commit: `${name}-c`, agents: {}, worktree: null, unknown, info: unknown === null ? { commit: `${name}-c`, coreVersion: '1.0.0', promptBytes: { content: 1, translation: 1 }, agents: { content: { cli: 'codex', model: 'm', effort: 'e' } } } : null });
    const runFile = (ms: string, data: object): void => {
      write(ws.regress, `records/runs/${ms}/run.json`, JSON.stringify(data));
    };
    runFile('1', { run: 1, catchOnly: true, sides: [side('before', null), side('after', null)], seeds: [], catches: [], seedRuns: [] });
    runFile('2', { run: 2, catchOnly: false, sides: [side('before', 'npm ci failed'), side('after', null)], seeds: [], catches: [], seedRuns: [] });
    runFile('3', { run: 3, catchOnly: false, sides: [side('before', null), side('after', null)], seeds: [], catches: [], seedRuns: [] });
    expect((await ogw(ws, ['regress', 'accept', '1'])).stderr).toContain('made with --catch-only');
    expect((await ogw(ws, ['regress', 'accept', '2'])).stderr).toContain('has an unknown side');
    expect((await ogw(ws, ['regress', 'accept', '9'])).stderr).toContain('no run 9');
    expect((await ogw(ws, ['regress', 'accept', '3'])).stdout).toBe('accepted: after-c (run 3)\n');
    expect(JSON.parse(readFileSync(join(ws.regress, 'accepted.json'), 'utf8'))).toMatchObject({ commit: 'after-c', agents: { content: { cli: 'codex', model: 'm', effort: 'e' } }, run: '3' });
    expect((await ogw(ws, ['regress', 'status'])).stdout).toContain('accepted: after-c (run 3)\nlast run: 3\n- before: 0 seed-runs');
  });
});
