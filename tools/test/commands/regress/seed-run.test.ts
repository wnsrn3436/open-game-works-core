import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCopyRepo } from '../../../src/commands/regress/lib/copy.ts';
import type { RegressCheckFile } from '../../../src/commands/regress/lib/keys.ts';
import { parseManifest, type Seed } from '../../../src/commands/regress/lib/repo.ts';
import { runSeedRun, type SeedRunInput } from '../../../src/commands/regress/lib/seed-run.ts';
import { jobFacts, sideAgent, sideCheck, sideMerge, sideProbe, type CheckRequest, type Side } from '../../../src/commands/regress/lib/side.ts';
import { makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { checkFile, ctxOf, item, sourceGame, write } from './helpers.ts';

vi.mock('../../../src/commands/regress/lib/side.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/regress/lib/side.ts')>()),
  sideAgent: vi.fn(),
  sideCheck: vi.fn(),
  sideProbe: vi.fn(),
  sideMerge: vi.fn(),
  jobFacts: vi.fn(),
}));

const LEAK: [string, string] = ['step 2', 'client main error log: 1793 error ResourceCore leak: icon/flame'];

function seedOf(fields: Record<string, unknown> = {}): Seed {
  const { manifest, problems } = parseManifest({
    state: 's',
    class: 'K1',
    element: 'no blocker',
    expect: 'caught',
    match: [{ check: 'no blocker', where: '^step \\d+$', message: '^client main error log: .*leak: icon/flame' }],
    fixer: 'content',
    row: { id: 'flame-leak', severity: 'blocker', owner: 'client content', why: 'the bot playtest stops', source: 'check' },
    frozen: [],
    ...fields,
  });
  expect(problems).toEqual([]);
  return { id: 'S01', manifest };
}

function sideOf(name: 'before' | 'after'): Side {
  return { name, commit: `${name}-harness`, agents: {}, worktree: `/sides/${name}`, info: null, unknown: null };
}

interface Fixture {
  ws: TestWorkspace;
  repo: string;
  input: SeedRunInput;
  /** The calls of the fixer, in order: the iteration of `--seed-run` and the side. */
  fixers: { seedRun: string; side: string; role: string }[];
  checks: { request: CheckRequest; side: string }[];
}

/** The content of client/a.gd at a commit of the fix repo: the fake fixer writes `fixed` there. */
function codeAt(repo: string, commit: string): string {
  return sh(repo, 'git', ['show', `${commit}:client/a.gd`]).trim();
}

async function fixture(seed: Seed, side: 'before' | 'after' = 'after', cap = 3): Promise<Fixture> {
  const ws = makeWorkspace();
  const commit = sourceGame(ws);
  const source = join(ws.games, 'src');
  const ctx = ctxOf(ws);
  const main = await makeCopyRepo(ctx, 'ogw-regress-fix-1', { repo: source, commit, registry: sh(source, 'git', ['rev-parse', 'id-registry']).trim() }, { kind: 'fix', state: 's' }, 'fix repo 1');
  const repo = join(ws.games, 'ogw-regress-fix-1');
  const registry = sh(repo, 'git', ['rev-parse', 'id-registry']).trim();
  const base = checkFile('base', item('no blocker', 'fail', [['step 1', 'known blocker']]), item('full flow', 'pass'), item('static check', 'fail', [['client/c.gd:1', 'base only']]));
  const seeded = checkFile(main, item('no blocker', 'fail', [['step 1', 'known blocker'], LEAK]), item('full flow', 'fail', [['step 2', 'scenario stopped at step 2']]));
  const after = sideOf('after');
  const input: SeedRunInput = {
    runMs: 1000,
    k: 1,
    seed,
    side: side === 'after' ? after : sideOf('before'),
    after,
    repeat: 1,
    fix: { game: 'ogw-regress-fix-1', root: repo, roots: { main, registry } },
    catchAfter: { base, seeded, seededPath: '/catch/after/S01.json', matched: { check: seeded.checks[0] as RegressCheckFile['checks'][number], failure: (seeded.checks[0] as RegressCheckFile['checks'][number]).failures[1] as RegressCheckFile['checks'][number]['failures'][number] } },
    oracle: null,
    work: join(ws.root, 'work', 'S01-after-1'),
    cap,
    diff: join(ws.root, 'regress', 'S01-after-1.diff'),
  };
  return { ws, repo, input, fixers: [], checks: [] };
}

/**
 * Fake fixer: in iteration n, `act(n)` gives the code it writes to client/a.gd (null for no change) and its report row
 * of the defect, which it writes as the content agent report and commits.
 */
function fakeFixer(f: Fixture, act: (n: number) => { code: string | null; result: string; note: string } | 'fail'): void {
  vi.mocked(sideAgent).mockImplementation((_ctx, side, request) => {
    f.fixers.push({ seedRun: request.seedRun, side: side.name, role: request.role });
    const n = Number(request.seedRun.split(':')[1]);
    const done = act(n);
    if (done === 'fail') return Promise.resolve({ job: `j${String(n)}`, status: 'failed', output: null, reason: 'agent job failed: limit' });
    if (done.code !== null) write(f.repo, 'client/a.gd', `${done.code}\n`);
    const records = request.seedRun.split(':')[0] as string;
    const output = join(f.repo, 'records', 'loops', records, `content-${String(n)}.md`);
    write(f.repo, `records/loops/${records}/content-${String(n)}.md`, `## defects\n\n| id | result | note |\n|---|---|---|\n| flame-leak | ${done.result} | ${done.note} |\n`);
    sh(f.repo, 'git', ['add', '-A']);
    sh(f.repo, 'git', ['commit', '-qm', `fixer ${String(n)}`, '--no-verify']);
    return Promise.resolve({ job: `j${String(n)}`, status: 'done', output, reason: null });
  });
}

/** Fake checks: the leak is found until client/a.gd is `fixed`; the proof of iteration n is `proofs(n)`. */
function fakeChecks(f: Fixture, proofs: (n: number) => 'pass' | 'fail' | 'unknown' = () => 'pass', extra: [string, string][] = []): void {
  vi.mocked(sideCheck).mockImplementation((_ctx, side, request) => {
    f.checks.push({ request, side: side.name });
    const fixed = codeAt(f.repo, request.commit) === 'fixed';
    const blocker = item('no blocker', 'fail', [['step 1', 'known blocker'], ...(fixed ? [] : [LEAK])]);
    const checks = request.checks === null ? [blocker, item('full flow', 'pass'), item('static check', extra.length > 0 ? 'fail' : 'pass', extra), item('no placeholder', 'fail', [['resource/resources.csv:4', 'placeholder icon/x']])] : [blocker];
    const n = request.proof === null ? 0 : Number(request.proof.split(':')[1]);
    const fixTestProof = request.proof === null ? [] : [{ id: 'flame-leak', result: proofs(n), reason: null, tests: [] }];
    return Promise.resolve({ file: { commit: request.commit, checks, fixTestProof }, minutes: 1 });
  });
}

beforeEach(() => {
  vi.mocked(sideAgent).mockReset();
  vi.mocked(sideCheck).mockReset();
  vi.mocked(sideProbe).mockReset();
  vi.mocked(sideMerge).mockReset().mockResolvedValue(null);
  vi.mocked(jobFacts).mockReset().mockResolvedValue({ usage: { cli: 'claude-code', model: 'm', effort: 'high', inputTokens: 1000, cachedTokens: 900, outputTokens: 10, costUsd: 0.5, costUnknown: null, turns: 4 }, startedAt: 0, endedAt: 120_000 });
});

describe('seed-run', () => {
  it('fixes in iteration 1: input, record, measures, diff, and the fix repo put back', async () => {
    const f = await fixture(seedOf());
    fakeFixer(f, () => ({ code: 'fixed', result: 'fixed', note: '`client/tests/test_a.gd::test_one`' }));
    // the final check still has the failure of the base that the seeded check has not: no new defect
    fakeChecks(f, () => 'pass', [['client/b.gd:3', 'system clock call'], ['client/c.gd:7', 'base only']]);
    const result = await runSeedRun(ctxOf(f.ws), f.input);
    expect(result).toMatchObject({ id: 'S01-after-1', result: 'fixed', reason: null });
    expect(result.measures).toMatchObject({ fixed: 1, iterations: 1, 'unconfirmed claims': 0, 'test first': 1, 'input tokens': 1000, 'cached tokens': 900, 'output tokens': 10, 'cost USD': 0.5, turns: 4, 'agent minutes': 2, guards: 0, placeholders: 1 });
    // the new defect is the static check failure: the base and seeded keys and the no placeholder failures are left out
    expect(result.newDefects).toEqual(['static check|-|client/b.gd|system clock call']);
    expect(result.measures['new defects']).toBe(1);
    expect(result.measures['check minutes']).toBe(2);
    expect(result.measures['own fixed']).toBeNull();
    expect(f.fixers).toEqual([{ seedRun: 'regress-1000-1:1', side: 'after', role: 'content' }]);
    // the confirmation checks the target checks with the fix test proof; the final check every check
    expect(f.checks.map((c) => [c.request.checks, c.request.proof])).toEqual([[['no blocker'], 'regress-1000-1:1'], [null, null]]);
    const diff = readFileSync(f.input.diff, 'utf8');
    expect(diff).toContain('+fixed');
    expect(diff).toContain('records/loops/regress-1000-1/content-input-1.md');
    // the history of the run: input, fixer, record; the input names the defect with the matching failure
    const records = 'records/loops/regress-1000-1';
    const input = sh(f.repo, 'git', ['show', `${result.final ?? ''}:${records}/content-input-1.md`]);
    expect(input).toBe(
      [
        '## kind', '', 'completeness', '',
        '## request', '', 'none', '',
        '## previous record', '', 'none', '',
        '## defects', '',
        '| id | severity | owner | where | what | why | evidence | source | status |',
        '|---|---|---|---|---|---|---|---|---|',
        `| flame-leak | blocker | client content | step 2 | ${LEAK[1]} | the bot playtest stops | /catch/after/S01.json#no blocker | check | open |`,
        '',
      ].join('\n'),
    );
    const record = sh(f.repo, 'git', ['show', `${result.final ?? ''}:${records}/iteration-1.md`]);
    expect([...record.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(['commit', 'checks', 'defects', 'fix test proof', 'cost']);
    expect(record).toContain('- side: after after-harness');
    expect(record).toContain('| flame-leak | pass | none | none |');
    expect(record).toMatch(/\| flame-leak \| blocker \|.*\| check \| fixed \|/);
    expect(record).toContain('| content | 1 | 1000 | 900 | 10 | 0.50 | 0 | 0 |');
    // the fix repo is back at its root: the next seed-run starts from the seeded commit
    expect(sh(f.repo, 'git', ['rev-parse', 'main']).trim()).toBe(f.input.fix.roots.main);
    expect(existsSync(join(f.repo, records))).toBe(false);
  });

  it('counts an unconfirmed claim, gives the next iteration the previous record and the failure that found it, and fixes in iteration 2', async () => {
    const f = await fixture(seedOf());
    fakeFixer(f, (n) => (n === 1 ? { code: 'tried', result: 'fixed', note: '`client/tests/test_a.gd::test_one`' } : { code: 'fixed', result: 'fixed', note: '`client/tests/test_a.gd::test_two`' }));
    fakeChecks(f);
    const result = await runSeedRun(ctxOf(f.ws), f.input);
    expect(result.measures).toMatchObject({ fixed: 1, iterations: 2, 'unconfirmed claims': 1, 'test first': 1, 'input tokens': 2000 });
    expect(result.iterations.map((i) => [i.n, i.status, i.found])).toEqual([[1, 'open', true], [2, 'fixed', false]]);
    expect(f.fixers.map((x) => x.seedRun)).toEqual(['regress-1000-1:1', 'regress-1000-1:2']);
  });

  it('leaves a fixed claim of a play defect without a passing fix test proof open, and ends not fixed at the cap', async () => {
    // a defect that a check found needs no proof (`source check`); one from play does
    const f = await fixture(seedOf({ row: { id: 'flame-leak', severity: 'blocker', owner: 'client content', why: 'w', source: 'play', where: 'crypt', what: 'leak', evidence: ['play feedback'] } }), 'after', 2);
    fakeFixer(f, () => ({ code: 'fixed', result: 'fixed', note: '`client/tests/test_a.gd::test_one`' }));
    fakeChecks(f, () => 'fail');
    const result = await runSeedRun(ctxOf(f.ws), f.input);
    expect(result.result).toBe('not fixed');
    // the confirmation does not find it, but the status never awaited confirmation
    expect(result.measures).toMatchObject({ fixed: 0, iterations: 3, 'unconfirmed claims': 0, 'test first': 0 });
    expect(result.iterations.map((i) => i.status)).toEqual(['open', 'open']);
  });

  it('takes a refused defect as the end, not fixed', async () => {
    const f = await fixture(seedOf());
    fakeFixer(f, () => ({ code: null, result: 'refused', note: 'it breaks the brief' }));
    fakeChecks(f);
    const result = await runSeedRun(ctxOf(f.ws), f.input);
    expect(result).toMatchObject({ result: 'not fixed', iterations: [{ n: 1, status: 'refused' }] });
    expect(result.measures['test first']).toBeNull();
  });

  it('is unknown when the fixer does not end done, and the fix repo is put back', async () => {
    const f = await fixture(seedOf());
    fakeFixer(f, () => 'fail');
    fakeChecks(f);
    const result = await runSeedRun(ctxOf(f.ws), f.input);
    expect(result).toMatchObject({ result: 'unknown', reason: 'agent job failed: limit' });
    expect(result.measures.fixed).toBeNull();
    expect(result.measures['input tokens']).toBe(1000);
    expect(sh(f.repo, 'git', ['rev-parse', 'main']).trim()).toBe(f.input.fix.roots.main);
  });

  it('is unknown when the confirmation gives no result twice in the last iteration', async () => {
    const f = await fixture(seedOf(), 'after', 1);
    fakeFixer(f, () => ({ code: 'fixed', result: 'not reproduced', note: 'no leak on step 2' }));
    vi.mocked(sideCheck).mockResolvedValue({ error: 'ogw regress check exit 1: host busy' });
    const result = await runSeedRun(ctxOf(f.ws), f.input);
    expect(result).toMatchObject({ result: 'unknown', reason: 'the last confirmation gave no result' });
    expect(vi.mocked(sideCheck)).toHaveBeenCalledTimes(2);
  });

  it('confirms a seed with an oracle by its probe, run with the side tool of the after side', async () => {
    const seed = seedOf({ expect: 'missed', match: [], oracle: true, row: { id: 'flame-leak', severity: 'major', owner: 'client content', why: 'w', source: 'play', where: 'result panel', what: 'shows 4', evidence: ['play feedback'] } });
    const f = await fixture(seed);
    f.input.oracle = '/regress/seeds/S09/oracle';
    f.input.catchAfter.matched = null;
    fakeFixer(f, (n) => ({ code: n === 1 ? 'tried' : 'fixed', result: 'fixed', note: '`client/tests/test_a.gd::test_one`' }));
    fakeChecks(f);
    vi.mocked(sideProbe).mockImplementation((_ctx, side, request) => Promise.resolve({ result: codeAt(f.repo, request.commit) === 'fixed' && side.name === 'after' ? 'pass' : 'fail', reason: 'r' }));
    const result = await runSeedRun(ctxOf(f.ws), f.input);
    expect(result.measures).toMatchObject({ fixed: 1, iterations: 2, 'unconfirmed claims': 1 });
    // without target checks the confirmation runs the regression test for the fix test proof
    expect(f.checks[0]?.request.checks).toEqual(['regression test']);
    const input = sh(f.repo, 'git', ['show', `${result.final ?? ''}:records/loops/regress-1000-1/content-input-2.md`]);
    expect(input).toContain('## previous record\n\nrecords/loops/regress-1000-1/iteration-1.md');
    expect(input).toContain('| flame-leak | major | client content | result panel | shows 4 | w | play feedback | play | open |');
  });

  it('runs a translation fixer per language of the seeded check, merges it and confirms it', async () => {
    const seed = seedOf({ match: [{ check: 'no placeholder', where: '^data/', message: '^translation_(stale|missing) en ' }], fixer: 'translation', row: { id: 'flame-leak', severity: 'major', owner: 'data', why: 'w', source: 'check' } });
    const f = await fixture(seed);
    const stale = item('no placeholder', 'fail', [['data/translations/en.csv:3', 'translation_stale en b'], ['data/translations/en.csv:4', 'translation_missing en c']]);
    f.input.catchAfter = { ...f.input.catchAfter, seeded: checkFile('s', stale), matched: { check: stale, failure: stale.failures[0] as RegressCheckFile['checks'][number]['failures'][number] } };
    vi.mocked(sideAgent).mockImplementation((_ctx, side, request) => {
      f.fixers.push({ seedRun: request.seedRun, side: side.name, role: request.role });
      expect(readFileSync(request.input, 'utf8')).toBe('en\n');
      write(f.repo, 'data/translations/en.csv', 'key,source,source_hash,current_hash,text\na,가,h1,h1,A\nb,나,h3,h3,B2\nc,다,h4,h4,C\n');
      sh(f.repo, 'git', ['commit', '-qam', 'translation', '--no-verify']);
      return Promise.resolve({ job: 'tj', status: 'done', output: null, reason: null });
    });
    vi.mocked(sideCheck).mockImplementation((_ctx, _side, request) => Promise.resolve({ file: { commit: request.commit, checks: [item('no placeholder', 'pass')], fixTestProof: [] }, minutes: 1 }));
    const result = await runSeedRun(ctxOf(f.ws), f.input);
    expect(f.fixers).toEqual([{ seedRun: 'regress-1000-1:1', side: 'after', role: 'translation' }]);
    expect(vi.mocked(sideMerge)).toHaveBeenCalledWith(expect.anything(), f.input.side, 'tj');
    expect(result).toMatchObject({ result: 'fixed', guards: [] });
    expect(vi.mocked(sideCheck).mock.calls[0]?.[2].proof).toBeNull();
  });

  it('gives the before side its own fixed by its own target checks on the final commit', async () => {
    const f = await fixture(seedOf(), 'before');
    fakeFixer(f, () => ({ code: 'fixed', result: 'fixed', note: '`client/tests/test_a.gd::test_one`' }));
    fakeChecks(f);
    const result = await runSeedRun(ctxOf(f.ws), f.input);
    expect(result.measures['own fixed']).toBe(1);
    expect(f.checks.map((c) => c.side)).toEqual(['after', 'after', 'before']);
    expect(f.fixers.map((x) => x.side)).toEqual(['before']);
  });
});
