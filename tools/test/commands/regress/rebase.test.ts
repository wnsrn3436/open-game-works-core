// The seed agent of `ogw regress refresh` (ogw.md `### seed agent` of `## regress`), with a fake seed agent job.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { regressChecks, type CheckResult } from '../../../src/commands/check/api.ts';
import { stateSettings, upgradeCore } from '../../../src/commands/regress/lib/ops.ts';
import { sideAgent, sideProbe } from '../../../src/commands/regress/lib/side.ts';
import { runSeedAgent } from '../../../src/commands/regress/lib/seed-agent.ts';
import { ogw, makeWorkspace, sh, testSettings, type TestWorkspace } from '../../helpers/workspace.ts';
import { item, meetOtherGroup, overlaps, sourceGame, write, type Span } from './helpers.ts';

vi.mock('../../../src/commands/check/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/check/api.ts')>()),
  regressChecks: vi.fn(),
}));
vi.mock('../../../src/commands/regress/lib/ops.ts', () => ({ upgradeCore: vi.fn(), stateSettings: vi.fn(), dataTool: vi.fn(() => Promise.resolve(null)) }));
vi.mock('../../../src/commands/regress/lib/side.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/regress/lib/side.ts')>()),
  sideAgent: vi.fn(),
  sideMerge: vi.fn(),
  sideProbe: vi.fn(),
}));
vi.mock('../../../src/commands/regress/lib/seed-agent.ts', () => ({ runSeedAgent: vi.fn() }));

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

const MISSED = { ...MANIFEST, expect: 'missed', match: [], oracle: true, row: { ...MANIFEST.row, source: 'play', where: 'result', what: 'shows 5', evidence: ['play'] } };

/** A patch of client/a.gd from `var x = <from>` to `var x = <to>`. */
function patchOf(to: string, from = '1'): string {
  return ['diff --git a/client/a.gd b/client/a.gd', '--- a/client/a.gd', '+++ b/client/a.gd', '@@ -1 +1 @@', `-var x = ${from}`, `+var x = ${to}`, ''].join('\n');
}

interface SeedFiles {
  manifest: object;
  state?: string;
  files: Record<string, string>;
}

/** A harness with the bootstrap folder `regress/` of the states and seeds, at core version 1.0.0. */
function bootstrap(ws: TestWorkspace, seeds: Record<string, SeedFiles>, states: readonly string[] = ['lc']): void {
  const commit = sourceGame(ws, 'src');
  write(ws.harness, 'regress/states.json', JSON.stringify(states.map((state) => ({ state, game: 'src', commit }))));
  for (const [id, seed] of Object.entries(seeds)) {
    write(ws.harness, `regress/seeds/${id}/seed.json`, JSON.stringify({ ...seed.manifest, state: seed.state ?? 'lc' }));
    for (const [path, content] of Object.entries(seed.files)) write(ws.harness, `regress/seeds/${id}/${path}`, content);
  }
  sh(ws.harness, 'git', ['add', '-A']);
  sh(ws.harness, 'git', ['commit', '-qm', 'regress bootstrap']);
  sh(ws.harness, 'git', ['tag', 'core-v1.0.0']);
}

/** Fake checks: the leak shows on a checkout whose client/a.gd holds `leak`. */
function fakeChecks(): void {
  vi.mocked(regressChecks).mockImplementation((_ctx, game) => {
    const leak = readFileSync(join(game.root, 'client/a.gd'), 'utf8').includes('leak');
    const blocker: CheckResult = item('no blocker', leak ? 'fail' : 'pass', leak ? [['step 2', LEAK]] : []);
    return Promise.resolve({ checks: [item('regression test', 'pass'), blocker], fixTestProof: [] });
  });
}

/** What the fake seed agent saw of its folder. */
interface Seen {
  folder: string;
  input: string;
  copy: string[];
  branches: string;
  remotes: string;
  tags: string;
  head: string;
  code: string;
}

const seen: Seen[] = [];

/** The files under `root`, relative, sorted. */
function filesOf(root: string): string[] {
  return sh(root, 'find', ['.', '-type', 'f']).trim().split('\n').map((line) => line.replace(/^\.\//, '')).sort();
}

/**
 * A fake seed agent: it records what it saw in its folder, then `act` writes in its copy of the seed and returns the
 * result file, or null to fail as a job that did not end done.
 */
function fakeSeedAgent(act: (seed: string, folder: string) => string | null): void {
  vi.mocked(runSeedAgent).mockImplementation((_ctx, folder, input) => {
    const base = join(folder, 'base');
    const id = /^## seed\n\n(.+)$/m.exec(readFileSync(input, 'utf8'))?.[1] ?? '';
    seen.push({
      folder,
      input: readFileSync(input, 'utf8'),
      copy: filesOf(join(folder, 'seed')),
      branches: sh(base, 'git', ['for-each-ref', '--format=%(refname)']).trim(),
      remotes: sh(base, 'git', ['remote']).trim(),
      tags: sh(base, 'git', ['tag']).trim(),
      head: sh(base, 'git', ['rev-parse', 'HEAD']).trim(),
      code: readFileSync(join(base, 'client/a.gd'), 'utf8'),
    });
    // named by its seed: the seeds are admitted together, so their seed agents start in no fixed order
    const job = `sa${id.toLowerCase()}`;
    const result = act(id, folder);
    if (result === null) return Promise.resolve({ job, status: 'failed', output: null, reason: 'agent CLI ended with code 1' });
    writeFileSync(join(folder, 'result.md'), result);
    return Promise.resolve({ job, status: 'done', output: join(folder, 'result.md'), reason: null });
  });
}

const REBASED = '## result\n\nrebased\n\n## reason\n\nthe line moved\n';

function readAdmission(ws: TestWorkspace, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ws.regress, `seeds/${id}/admitted-1.0.0.json`), 'utf8')) as Record<string, unknown>;
}

function record(ws: TestWorkspace): string {
  return readFileSync(join(ws.regress, 'records/refresh-1.0.0.md'), 'utf8');
}

beforeEach(() => {
  seen.length = 0;
  vi.mocked(regressChecks).mockReset();
  vi.mocked(upgradeCore).mockReset();
  vi.mocked(stateSettings).mockReset().mockResolvedValue({ ok: true, text: 'none' });
  vi.mocked(sideAgent).mockReset();
  vi.mocked(sideProbe).mockReset();
  vi.mocked(runSeedAgent).mockReset();
  fakeChecks();
});

describe('ogw regress refresh: the seed agent', () => {
  it('rebases a seed whose patch does not apply with a copy of the seed and a clone of the base holding no branch of another seed, and admits its new patch', async () => {
    const ws = makeWorkspace();
    bootstrap(ws, {
      S00: { manifest: MANIFEST, files: { 'patch-0.9.0.diff': patchOf('leak0') } },
      S01: { manifest: MANIFEST, files: { 'patch-0.9.0.diff': patchOf('leak', '9'), 'admitted-0.9.0.json': '{}', 'rebase-0.9.0.md': 'old\n' } },
    });
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    // the branch of another seed, with its patch, is in the state before S01 is rebased
    const state = join(ws.games, 'ogw-regress-lc');
    sh(state, 'git', ['checkout', '--quiet', '-b', 'seed/S98-0.9.0']);
    write(state, 'client/a.gd', 'var x = other\n');
    sh(state, 'git', ['commit', '-qam', 'seed S98', '--no-verify']);
    sh(state, 'git', ['checkout', '--quiet', 'main']);
    fakeSeedAgent((_id, folder) => {
      writeFileSync(join(folder, 'seed', 'patch-1.0.0.diff'), patchOf('leak'));
      return REBASED;
    });
    const run = await ogw(ws, ['regress', 'refresh']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(vi.mocked(runSeedAgent)).toHaveBeenCalledTimes(1);
    expect(sh(state, 'git', ['branch', '--list', 'seed/S98-0.9.0']).trim()).not.toBe('');
    const [agent] = seen as [Seen];
    // the copy of the seed without the files the tool writes there; the base alone, on branch base, with no remote
    expect(agent.copy).toEqual(['patch-0.9.0.diff', 'seed.json']);
    expect(agent.branches).toBe('refs/heads/base');
    expect(agent.remotes).toBe('');
    expect(agent.tags).toBe('');
    expect(agent.head).toBe(sh(state, 'git', ['rev-parse', 'base-1.0.0']).trim());
    expect(agent.code).toBe('var x = 1\n');
    expect(agent.input).toMatch(/^## seed\n\nS01\n\n## core version\n\n1\.0\.0\n\n## stale reason\n\npatch does not apply: [^\n]+\n\n## old patch\n\n`patch-0\.9\.0\.diff`\n\n## old reference\n\nnone\n\n## core release\n\nnone\n$/);
    // admitted with the new patch, the result file kept for the human, the folder gone
    expect(readAdmission(ws, 'S01')).toMatchObject({ result: 'admitted', catch: ['caught', 'caught', 'caught'], reason: null });
    expect(readFileSync(join(ws.regress, 'seeds/S01/patch-1.0.0.diff'), 'utf8')).toContain('+var x = leak');
    expect(readFileSync(join(ws.regress, 'seeds/S01/rebase-1.0.0.md'), 'utf8')).toBe(REBASED);
    expect(existsSync(agent.folder)).toBe(false);
    expect(record(ws)).toContain('| seed | result | reason | catch | oracle | rebase |');
    expect(record(ws)).toContain('| S00 | admitted | none | caught, caught, caught | none | none |');
    expect(record(ws)).toContain('| S01 | admitted | none | caught, caught, caught | none | rebased (sas01) |');
    expect(record(ws)).toMatch(/\| seed \| 1 \|/);
    expect(run.stdout).toContain('seed S01: admitted; seed agent: rebased (sas01)\n');
    expect(sh(ws.regress, 'git', ['status', '--porcelain']).trim()).toBe('');
    // the next refresh admits the rebased seed as it is
    vi.mocked(runSeedAgent).mockClear();
    expect((await ogw(ws, ['regress', 'refresh'])).code).toBe(0);
    expect(vi.mocked(runSeedAgent)).not.toHaveBeenCalled();
  });

  it('sends no seed stale for not <expect> or base fails target to the seed agent', async () => {
    const ws = makeWorkspace();
    const unclean = { ...MANIFEST, match: [{ check: 'regression test', where: '.*', message: '.*' }] };
    bootstrap(ws, { S02: { manifest: MANIFEST, files: { 'patch-0.9.0.diff': patchOf('2') } }, S06: { manifest: unclean, files: { 'patch-0.9.0.diff': patchOf('6') } } });
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    // the regression test fails on the base too
    vi.mocked(regressChecks).mockResolvedValue({ checks: [item('regression test', 'fail', [['client/tests/test_a.gd', 'boom']]), item('no blocker', 'pass')], fixTestProof: [] });
    fakeSeedAgent(() => REBASED);
    expect((await ogw(ws, ['regress', 'refresh'])).code).toBe(1);
    expect(readAdmission(ws, 'S02')).toMatchObject({ result: 'stale', reason: 'not caught: missed, missed, missed' });
    expect(readAdmission(ws, 'S06')).toMatchObject({ result: 'stale', reason: expect.stringMatching(/^base fails target: /) as unknown });
    expect(vi.mocked(runSeedAgent)).not.toHaveBeenCalled();
    expect(record(ws)).toContain('| S02 | stale | not caught: missed, missed, missed | missed, missed, missed | none | none |');
  });

  it('refuses a result that changes the manifest, a file it may not change or lacks the new patch, and keeps those seeds as they were', async () => {
    const ws = makeWorkspace();
    const stale = { 'patch-0.9.0.diff': patchOf('leak', '9') };
    bootstrap(ws, { S03: { manifest: MANIFEST, files: stale }, S04: { manifest: MANIFEST, files: stale }, S05: { manifest: MANIFEST, files: stale } });
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    const manifest = readFileSync(join(ws.regress, 'seeds/S03/seed.json'), 'utf8');
    fakeSeedAgent((id, folder) => {
      const copy = join(folder, 'seed');
      if (id !== 'S05') writeFileSync(join(copy, 'patch-1.0.0.diff'), patchOf('leak'));
      // a manifest whose seed would be caught by another check
      if (id === 'S03') writeFileSync(join(copy, 'seed.json'), JSON.stringify({ ...MANIFEST, match: [{ check: 'regression test', where: '.*', message: '.*' }] }));
      if (id === 'S04') writeFileSync(join(copy, 'notes.txt'), 'a note\n');
      return REBASED;
    });
    expect((await ogw(ws, ['regress', 'refresh'])).code).toBe(1);
    for (const id of ['S03', 'S04', 'S05']) {
      expect(readAdmission(ws, id)).toMatchObject({ result: 'stale', reason: expect.stringMatching(/^patch does not apply: /) as unknown });
      expect(existsSync(join(ws.regress, `seeds/${id}/patch-1.0.0.diff`))).toBe(false);
    }
    expect(readFileSync(join(ws.regress, 'seeds/S03/seed.json'), 'utf8')).toBe(manifest);
    expect(existsSync(join(ws.regress, 'seeds/S04/notes.txt'))).toBe(false);
    expect(record(ws)).toContain('| refused (sas03): it changed seed.json, which it may not change |');
    expect(record(ws)).toContain('| refused (sas04): it changed notes.txt, which it may not change |');
    expect(record(ws)).toContain('| refused (sas05): it wrote no patch-1.0.0.diff |');
    // only the seeded commit of the first admission of each was checked: a refused result is not admitted
    expect(vi.mocked(regressChecks)).toHaveBeenCalledTimes(3);
  });

  it('puts back the files of a rebase that admission does not admit, keeping the admission before it, and records why', async () => {
    const ws = makeWorkspace();
    bootstrap(ws, { S07: { manifest: MANIFEST, files: { 'patch-0.9.0.diff': patchOf('leak', '9'), 'patch-1.0.0.diff': patchOf('leak', '8') } } });
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    const before = readFileSync(join(ws.regress, 'seeds/S07/patch-1.0.0.diff'), 'utf8');
    // a patch that applies but plants nothing the check catches
    fakeSeedAgent((_id, folder) => {
      writeFileSync(join(folder, 'seed', 'patch-1.0.0.diff'), patchOf('2'));
      return REBASED;
    });
    expect((await ogw(ws, ['regress', 'refresh'])).code).toBe(1);
    expect(readAdmission(ws, 'S07')).toMatchObject({ result: 'stale', reason: expect.stringMatching(/^patch does not apply: /) as unknown });
    expect(readFileSync(join(ws.regress, 'seeds/S07/patch-1.0.0.diff'), 'utf8')).toBe(before);
    expect(readFileSync(join(ws.regress, 'seeds/S07/rebase-1.0.0.md'), 'utf8')).toBe(REBASED);
    expect(record(ws)).toContain('| not admitted (sas07): not caught: missed, missed, missed |');
    expect(sh(ws.regress, 'git', ['status', '--porcelain']).trim()).toBe('');
  });

  it('records a seed that the seed agent did not rebase and one whose job failed', async () => {
    const ws = makeWorkspace();
    const stale = { 'patch-0.9.0.diff': patchOf('leak', '9') };
    bootstrap(ws, { S11: { manifest: MANIFEST, files: stale }, S12: { manifest: MANIFEST, files: stale } });
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    fakeSeedAgent((id) => (id === 'S11' ? '## result\n\nnot rebased\n\n## reason\n\nthe feature is gone\n' : null));
    const run = await ogw(ws, ['regress', 'refresh']);
    expect(run.code).toBe(1);
    expect(record(ws)).toContain('| not rebased (sas11) |');
    expect(record(ws)).toContain('| failed (sas12): agent CLI ended with code 1 |');
    expect(run.stdout).toContain('; seed agent: not rebased (sas11)\n');
    expect(readFileSync(join(ws.regress, 'seeds/S11/rebase-1.0.0.md'), 'utf8')).toContain('the feature is gone');
    expect(existsSync(join(ws.regress, 'seeds/S12/rebase-1.0.0.md'))).toBe(false);
  });

  it('rebases an oracle seed whose reference fix no longer fixes the seeded commit with a new reference and probe, and refuses one that changes oracle.json', async () => {
    const ws = makeWorkspace();
    const oracle = { 'patch-0.9.0.diff': patchOf('5'), 'reference-0.9.0.diff': patchOf('3', '5'), 'oracle/oracle.json': '{"probe": "probe.ts", "languages": ["ko"]}', 'oracle/probe.ts': 'old probe\n' };
    bootstrap(ws, { S09: { manifest: MISSED, files: oracle }, S10: { manifest: MISSED, files: oracle } });
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    const state = join(ws.games, 'ogw-regress-lc');
    vi.mocked(sideProbe).mockImplementation((_ctx, _side, request) => {
      const code = sh(state, 'git', ['show', `${request.commit}:client/a.gd`]).trim();
      const probe = readFileSync(join(request.oracle, 'probe.ts'), 'utf8');
      // the old probe does not reach its screen on the reference commit; the new one does
      return Promise.resolve(code === 'var x = 5' ? { result: 'fail', reason: code } : probe === 'new probe\n' && code === 'var x = 1' ? { result: 'pass', reason: code } : { result: 'fail', reason: code });
    });
    fakeSeedAgent((id, folder) => {
      const copy = join(folder, 'seed');
      writeFileSync(join(copy, 'patch-1.0.0.diff'), patchOf('5'));
      writeFileSync(join(copy, 'reference-1.0.0.diff'), patchOf('1', '5'));
      writeFileSync(join(copy, 'oracle/probe.ts'), 'new probe\n');
      if (id === 'S10') writeFileSync(join(copy, 'oracle/oracle.json'), '{"probe": "probe.ts", "languages": ["en"]}');
      return REBASED;
    });
    expect((await ogw(ws, ['regress', 'refresh'])).code).toBe(1);
    expect(seen[0]?.input).toContain('## old reference\n\n`reference-0.9.0.diff`\n');
    expect(seen[0]?.input).toContain('## stale reason\n\noracle: seeded fail (var x = 5), reference fail (var x = 3)\n');
    expect(readAdmission(ws, 'S09')).toMatchObject({ result: 'admitted', oracle: { seeded: 'fail', reference: 'pass' } });
    expect(readFileSync(join(ws.regress, 'seeds/S09/oracle/probe.ts'), 'utf8')).toBe('new probe\n');
    expect(readFileSync(join(ws.regress, 'seeds/S09/reference-1.0.0.diff'), 'utf8')).toContain('+var x = 1');
    expect(readAdmission(ws, 'S10')).toMatchObject({ result: 'stale', reason: 'oracle: seeded fail (var x = 5), reference fail (var x = 3)' });
    expect(readFileSync(join(ws.regress, 'seeds/S10/oracle/probe.ts'), 'utf8')).toBe('old probe\n');
    expect(record(ws)).toContain('| refused (sas10): it changed oracle/oracle.json, which it may not change |');
  });

  it('starts no seed agent in ogw regress seed', async () => {
    const ws = makeWorkspace();
    bootstrap(ws, {});
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    expect((await ogw(ws, ['regress', 'refresh'])).code).toBe(0);
    const folder = join(ws.root, 'new-seeds', 'S13');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'seed.json'), JSON.stringify({ ...MANIFEST, state: 'lc' }));
    writeFileSync(join(folder, 'patch-1.0.0.diff'), patchOf('leak', '9'));
    fakeSeedAgent(() => REBASED);
    const run = await ogw(ws, ['regress', 'seed', folder]);
    expect(run.stdout).toMatch(/^seed S13: stale \(patch does not apply: /);
    expect(vi.mocked(runSeedAgent)).not.toHaveBeenCalled();
  });

  /** A fake seed agent that waits until `meet` has work of another group started, at most `limitMs`, keeping its span in `spans`. */
  function meetingSeedAgent(spans: Span[], started: Set<string>, meet: string, limitMs = 1000): void {
    let n = 0;
    vi.mocked(runSeedAgent).mockImplementation(async (_ctx, folder) => {
      const key = `agent ${String(++n)}`;
      const start = performance.now();
      await meetOtherGroup(started, meet === 'agent' ? key : 'agent', limitMs);
      await new Promise((resolve) => setTimeout(resolve, 20));
      writeFileSync(join(folder, 'seed', 'patch-1.0.0.diff'), patchOf('leak'));
      writeFileSync(join(folder, 'result.md'), REBASED);
      spans.push({ key, group: 'agent', start, end: performance.now() });
      return { job: `sa${String(n)}`, status: 'done', output: join(folder, 'result.md'), reason: null };
    });
  }

  it('runs at most regress.parallel seed agents at a time', async () => {
    const ws = makeWorkspace({ regress: { ...(testSettings().regress as object), parallel: 1 } });
    const stale = { 'patch-0.9.0.diff': patchOf('leak', '9') };
    bootstrap(ws, { S21: { manifest: MANIFEST, files: stale }, S22: { manifest: MANIFEST, files: stale } });
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    // each seed agent waits for another to start: two that run together meet at once
    const spans: Span[] = [];
    meetingSeedAgent(spans, new Set(), 'agent');
    const run = await ogw(ws, ['regress', 'refresh']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(spans).toHaveLength(2);
    expect(overlaps(spans, true)).toEqual([]);
  });

  it('runs a seed agent beside a check with performance of the refresh: it holds no performance lease and waits for no measurement', async () => {
    const ws = makeWorkspace();
    bootstrap(ws, { S21: { manifest: MANIFEST, files: { 'patch-0.9.0.diff': patchOf('leak', '9') } }, S23: { manifest: { ...MANIFEST, performance: true }, state: 'lc2', files: { 'patch-0.9.0.diff': patchOf('leak') } } }, ['lc', 'lc2']);
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    // the seed agent of S21 and the checks with performance of the seeded commit of S23 each wait for the other to start:
    // without a gate between them they meet at once
    const spans: Span[] = [];
    const started = new Set<string>();
    vi.mocked(regressChecks).mockImplementation(async (_ctx, game, _evidence, pick) => {
      const leak = readFileSync(join(game.root, 'client/a.gd'), 'utf8').includes('leak');
      const start = performance.now();
      if (pick.performance && leak) await meetOtherGroup(started, 'check', 1000);
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (pick.performance) spans.push({ key: `check ${game.name} ${String(spans.length)}`, group: 'check', start, end: performance.now() });
      return { checks: [item('no blocker', leak ? 'fail' : 'pass', leak ? [['step 2', LEAK]] : [])], fixTestProof: [] };
    });
    // the seed agent waits long enough for the check of a loaded host; the check, less than a seed agent started late
    meetingSeedAgent(spans, started, 'check', 10_000);
    const run = await ogw(ws, ['regress', 'refresh']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(spans.filter((s) => s.group === 'agent')).toHaveLength(1);
    expect(overlaps(spans, false)).not.toEqual([]);
  });

  it('starts the seed agent of a seed as soon as its admission ends, while the admission of another seed still runs', async () => {
    const ws = makeWorkspace();
    bootstrap(ws, { S21: { manifest: MANIFEST, files: { 'patch-0.9.0.diff': patchOf('leak', '9') } }, S24: { manifest: MANIFEST, state: 'lc2', files: { 'patch-0.9.0.diff': patchOf('leak') } } }, ['lc', 'lc2']);
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    // each check of the seeded commit of S24 waits for the seed agent of S21 to start, at most 2 s
    const spans: Span[] = [];
    const started = new Set<string>();
    vi.mocked(regressChecks).mockImplementation(async (_ctx, game) => {
      const code = readFileSync(join(game.root, 'client/a.gd'), 'utf8');
      const leak = code.includes('leak');
      const start = performance.now();
      if (game.name === 'ogw-regress-lc2' && leak) {
        await meetOtherGroup(started, 'check', 2000);
        spans.push({ key: `check ${String(spans.length)}`, group: 'check', start, end: performance.now() });
      }
      return { checks: [item('no blocker', leak ? 'fail' : 'pass', leak ? [['step 2', LEAK]] : [])], fixTestProof: [] };
    });
    // the seed agent waits long enough for the checks of a loaded host
    meetingSeedAgent(spans, started, 'check', 10_000);
    const run = await ogw(ws, ['regress', 'refresh']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    // the seed agent ran while the admission of S24 ran: it did not wait for it to end
    expect(overlaps(spans, false)).not.toEqual([]);
  });
});
