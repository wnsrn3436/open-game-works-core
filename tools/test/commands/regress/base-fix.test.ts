// The base fix of `ogw regress refresh` (ogw.md `### regress refresh` 4 of `## regress`): a base whose checks fail a
// target check of a seed of its state gets one content agent with those failures, and its base checks again.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { regressChecks, type CheckResult } from '../../../src/commands/check/api.ts';
import { dataDir } from '../../../src/commands/env/lib/host.ts';
import { stateSettings, upgradeCore } from '../../../src/commands/regress/lib/ops.ts';
import { sideAgent, sideMerge, sideProbe } from '../../../src/commands/regress/lib/side.ts';
import { ogw, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { ctxOf, item, sourceGame, write } from './helpers.ts';

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

const LEAK = 'client main error log: 1793 error ResourceCore leak: icon/flame';
const FPS = 'fps 5 percentile 39 is below the fps bound 59 (126 samples)';

const ROW = { id: 'r', severity: 'major', owner: 'client content', why: 'w', source: 'check' };
/** A seed of a leak, which `no blocker` catches. */
const LEAKS = { state: 'lc', class: 'K1', element: 'no blocker', expect: 'caught', match: [{ check: 'no blocker', where: '^step \\d+$', message: '^client main error log: .*leak: icon/flame' }], fixer: 'content', row: ROW, frozen: [] };
/** A seed of a slow crypt, which `performance` catches. */
const SLOW = { ...LEAKS, element: 'performance', performance: true, match: [{ check: 'performance', where: '^scene/crypt/crypt$', message: '^fps ' }] };

function patchOf(file: string, from: string, to: string): string {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1 +1 @@', `-${from}`, `+${to}`, ''].join('\n');
}

/**
 * A harness with one state of a source game whose crypt is slow (`client/b.gd` holds `hot`), with the seeds S01 (a leak
 * in client/a.gd) and S04 (a slow crypt from client/c.gd), at core version 1.0.0.
 */
function bootstrap(ws: TestWorkspace, seeds: Record<string, object> = { S01: LEAKS, S04: SLOW }): void {
  sourceGame(ws, 'src');
  const source = join(ws.games, 'src');
  write(source, 'client/b.gd', 'var heat = hot\n');
  write(source, 'client/c.gd', 'var y = 1\n');
  sh(source, 'git', ['add', '-A']);
  sh(source, 'git', ['commit', '-qm', 'crypt']);
  const commit = sh(source, 'git', ['rev-parse', 'main']).trim();
  write(ws.harness, 'regress/states.json', JSON.stringify([{ state: 'lc', game: 'src', commit }]));
  const patches: Record<string, string> = { S01: patchOf('client/a.gd', 'var x = 1', 'var x = leak'), S04: patchOf('client/c.gd', 'var y = 1', 'var y = slow'), S06: patchOf('client/a.gd', 'var x = 1', 'var x = 6'), S07: patchOf('client/a.gd', 'var x = 1', 'var x = 7') };
  for (const [id, manifest] of Object.entries(seeds)) {
    write(ws.harness, `regress/seeds/${id}/seed.json`, JSON.stringify(manifest));
    write(ws.harness, `regress/seeds/${id}/patch-1.0.0.diff`, patches[id] as string);
  }
  sh(ws.harness, 'git', ['add', '-A']);
  sh(ws.harness, 'git', ['commit', '-qm', 'regress bootstrap']);
  sh(ws.harness, 'git', ['tag', 'core-v1.0.0']);
}

/** What the fake checks saw: the code of each check and the evidence file of each slow check. */
const checked: { hot: boolean; evidence: string | null }[] = [];

/**
 * Fake checks: the leak shows on a client/a.gd that holds `leak`; with performance, the crypt is slow on a client/b.gd
 * that holds `hot` or a client/c.gd that holds `slow`, with the samples written to the evidence folder of the check.
 */
function fakeChecks(): void {
  vi.mocked(regressChecks).mockImplementation((_ctx, game, evidence, pick) => {
    const read = (file: string): string => readFileSync(join(game.root, file), 'utf8');
    const leak = read('client/a.gd').includes('leak');
    const hot = read('client/b.gd').includes('= hot');
    const slow = hot || read('client/c.gd').includes('slow');
    const checks: CheckResult[] = [item('no blocker', leak ? 'fail' : 'pass', leak ? [['step 2', LEAK]] : []), item('full flow', 'pass')];
    let samples: string | null = null;
    if (pick.performance) {
      samples = join(evidence.root, 'performance-macos', 'samples.json');
      mkdirSync(join(evidence.root, 'performance-macos'), { recursive: true });
      writeFileSync(samples, '{}');
      checks.push({ ...item('performance', slow ? 'fail' : 'pass', [], 'macos'), failures: slow ? [{ where: 'scene/crypt/crypt', message: FPS, evidence: [samples] }] : [] });
    }
    checked.push({ hot, evidence: samples });
    return Promise.resolve({ checks, fixTestProof: [] });
  });
}

/** A fake content agent that cools the crypt and commits on main of the state, keeping what it saw. */
function coolingAgent(ws: TestWorkspace, saw: { input: string; text: string; seedRun: string; evidence: boolean[] }[], status: 'done' | 'failed' = 'done', cool = true): void {
  vi.mocked(sideAgent).mockImplementation((_ctx, _side, request) => {
    const text = readFileSync(request.input, 'utf8');
    const evidence = [...text.matchAll(/(\/[^\s,|]+?\.json)(?:#\w+)?/g)].map((m) => existsSync(m[1] as string));
    saw.push({ input: request.input, text, seedRun: request.seedRun, evidence });
    const state = join(ws.games, 'ogw-regress-lc');
    write(state, 'client/b.gd', cool ? 'var heat = cool\n' : 'var heat = hot # tried\n');
    sh(state, 'git', ['commit', '-qam', 'cool the crypt', '--no-verify']);
    return Promise.resolve({ job: 'c1', status, output: null, reason: status === 'done' ? null : 'the agent CLI exited 1' });
  });
}

function record(ws: TestWorkspace): string {
  return readFileSync(join(ws.regress, 'records/refresh-1.0.0.md'), 'utf8');
}

function readAdmission(ws: TestWorkspace, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ws.regress, `seeds/${id}/admitted-1.0.0.json`), 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  checked.length = 0;
  vi.mocked(regressChecks).mockReset();
  vi.mocked(upgradeCore).mockReset();
  vi.mocked(stateSettings).mockReset().mockResolvedValue({ ok: true, text: 'none' });
  vi.mocked(sideAgent).mockReset();
  vi.mocked(sideMerge).mockReset();
  vi.mocked(sideProbe).mockReset();
  fakeChecks();
});

describe('ogw regress refresh: the base fix', () => {
  it('runs one content agent on a base that fails a target check of a seed, with those failures as its defects, checks the base again and tags the fixed commit', async () => {
    const ws = makeWorkspace();
    bootstrap(ws);
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    const state = join(ws.games, 'ogw-regress-lc');
    const before = sh(state, 'git', ['rev-parse', 'main']).trim();
    const saw: { input: string; text: string; seedRun: string; evidence: boolean[] }[] = [];
    coolingAgent(ws, saw);
    const run = await ogw(ws, ['regress', 'refresh']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    // one content agent, in the seed-run records of the refresh, with the failure of the base and no seed
    expect(saw).toHaveLength(1);
    const [agent] = saw as [(typeof saw)[number]];
    expect(agent.seedRun).toMatch(/^refresh-1\.0\.0-\d+:1$/);
    expect(agent.input).toMatch(/\/records\/loops\/refresh-1\.0\.0-\d+\/content-input-1\.md$/);
    const work = join(await dataDir(ctxOf(ws)), 'regress', 'refresh-1.0.0');
    const evidence = [1, 2, 3].flatMap((k) => [`${work}/lc-base-${String(k)}.json#performance`, `${work}/lc-base-${String(k)}/performance-macos/samples.json`]).join(', ');
    expect(agent.text).toBe(
      '## kind\n\ncompleteness\n\n## request\n\nnone\n\n## previous record\n\nnone\n\n## defects\n\n' +
        '| id | severity | owner | where | what | why | evidence | source | status |\n|---|---|---|---|---|---|---|---|---|\n' +
        `| performance-scene-crypt-crypt | major | client content | scene/crypt/crypt | ${FPS} | the performance check fails | ${evidence} | check | open |\n`,
    );
    expect(agent.text).not.toMatch(/S01|S04|\^fps/);
    // the content agent reads the check files and their evidence outside the regress repo, which the refresh then removes
    expect(agent.evidence).toEqual([true, true, true, true, true, true]);
    expect(existsSync(join(work, 'lc-base-1.json'))).toBe(false);
    expect(existsSync(join(work, 'lc-base-1'))).toBe(false);
    // the defects and the input are committed in the records of the state
    const rel = agent.input.slice(state.length + 1);
    expect(sh(state, 'git', ['show', `base-1.0.0:${rel}`])).toBe(agent.text);
    expect((JSON.parse(sh(state, 'git', ['show', `base-1.0.0:${rel.replace(/content-input-1\.md$/, 'defects.json')}`])) as { defects: unknown[] }).defects).toHaveLength(1);
    // the base checks ran again on the commit of the agent, which got the tag
    expect(checked.slice(0, 6).map((c) => c.hot)).toEqual([true, true, true, false, false, false]);
    const base = sh(state, 'git', ['rev-parse', 'base-1.0.0']).trim();
    expect(base).not.toBe(before);
    expect(base).toBe(sh(state, 'git', ['rev-parse', 'main']).trim());
    expect(sh(state, 'git', ['show', 'base-1.0.0:client/b.gd'])).toBe('var heat = cool\n');
    const kept = JSON.parse(readFileSync(join(ws.regress, 'records/refresh-1.0.0/lc-base-1.json'), 'utf8')) as { commit: string };
    expect(kept.commit).toBe(base);
    // the seed that the slow base kept out is admitted on the fixed base
    expect(readAdmission(ws, 'S04')).toMatchObject({ result: 'admitted', base, catch: ['caught', 'caught', 'caught'] });
    expect(readAdmission(ws, 'S01')).toMatchObject({ result: 'admitted', base });
    expect(record(ws)).toContain('| state | from | settings | upgrade | content job | translation | base checks | base failures | base fix | tag |');
    expect(record(ws)).toContain('| lc | 1.0.0 | none | none | none | none | 3 checks | none | done (c1) for performance-scene-crypt-crypt | base-1.0.0 |');
    expect(record(ws)).toMatch(/\| content \| 1 \|/);
  });

  it('keeps the base before it when its content agent does not end done, with main reset, and runs one content agent at most', async () => {
    const ws = makeWorkspace();
    bootstrap(ws);
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    const state = join(ws.games, 'ogw-regress-lc');
    const before = sh(state, 'git', ['rev-parse', 'main']).trim();
    const saw: { input: string; text: string; seedRun: string; evidence: boolean[] }[] = [];
    coolingAgent(ws, saw, 'failed');
    expect((await ogw(ws, ['regress', 'refresh'])).code).toBe(1);
    expect(saw).toHaveLength(1);
    expect(sh(state, 'git', ['rev-parse', 'base-1.0.0']).trim()).toBe(before);
    expect(sh(state, 'git', ['rev-parse', 'main']).trim()).toBe(before);
    expect(sh(state, 'git', ['status', '--porcelain']).trim()).toBe('');
    // the base checks did not run again: the seed stays out for the base before
    expect(checked.filter((c) => c.evidence !== null && c.hot)).toHaveLength(3);
    expect(readAdmission(ws, 'S04')).toMatchObject({ result: 'stale', reason: `base fails target: performance scene/crypt/crypt ${FPS}` });
    expect(readAdmission(ws, 'S01')).toMatchObject({ result: 'admitted', base: before });
    expect(record(ws)).toContain('| failed (c1) for performance-scene-crypt-crypt: the agent CLI exited 1 | base-1.0.0 |');
    // a fix that does not cool the crypt is checked again and tagged, and no second content agent runs in the refresh
    write(ws.harness, 'tools/changed.txt', 'other check code\n');
    sh(ws.harness, 'git', ['add', '-A']);
    sh(ws.harness, 'git', ['commit', '-qm', 'check code']);
    saw.length = 0;
    coolingAgent(ws, saw, 'done', false);
    expect((await ogw(ws, ['regress', 'refresh'])).code).toBe(1);
    expect(saw).toHaveLength(1);
    expect(sh(state, 'git', ['rev-parse', 'base-1.0.0']).trim()).not.toBe(before);
    expect(readAdmission(ws, 'S04')).toMatchObject({ result: 'stale', reason: `base fails target: performance scene/crypt/crypt ${FPS}` });
    expect(record(ws)).toContain('| done (c1) for performance-scene-crypt-crypt | base-1.0.0 |');
  });

  it('fixes a tagged base whose base checks run again, moving its tag, and not one whose kept base checks it takes', async () => {
    const ws = makeWorkspace();
    bootstrap(ws);
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    const state = join(ws.games, 'ogw-regress-lc');
    const saw: { input: string; text: string; seedRun: string; evidence: boolean[] }[] = [];
    // the first refresh tags the slow base: its content agent fails
    coolingAgent(ws, saw, 'failed');
    expect((await ogw(ws, ['regress', 'refresh'])).code).toBe(1);
    const slow = sh(state, 'git', ['rev-parse', 'base-1.0.0']).trim();
    // the same check inputs take the kept base checks: no content agent again
    saw.length = 0;
    coolingAgent(ws, saw);
    expect((await ogw(ws, ['regress', 'refresh'])).code).toBe(1);
    expect(saw).toHaveLength(0);
    expect(record(ws)).toContain('| lc | 1.0.0 | none | none | none | none | kept | none | none | base-1.0.0 |');
    // other check inputs check the tagged base again, and its base fix moves the tag
    write(ws.harness, 'tools/changed.txt', 'other check code\n');
    sh(ws.harness, 'git', ['add', '-A']);
    sh(ws.harness, 'git', ['commit', '-qm', 'check code']);
    expect((await ogw(ws, ['regress', 'refresh'])).code).toBe(0);
    expect(saw).toHaveLength(1);
    expect((saw[0] as (typeof saw)[number]).seedRun).toMatch(/^refresh-1\.0\.0-\d+:1$/);
    const fixed = sh(state, 'git', ['rev-parse', 'base-1.0.0']).trim();
    expect(fixed).not.toBe(slow);
    expect(sh(state, 'git', ['merge-base', '--is-ancestor', slow, fixed]).trim()).toBe('');
    expect(readAdmission(ws, 'S04')).toMatchObject({ result: 'admitted', base: fixed });
    expect(record(ws)).toContain('| lc | 1.0.0 | none | none | none | none | 3 checks | none | done (c1) for performance-scene-crypt-crypt | base-1.0.0 |');
  });

  it('starts no content agent for a base failure that is unknown, of no target check, or of no placeholder, nor in ogw regress seed', async () => {
    const ws = makeWorkspace();
    const missing = { ...LEAKS, element: 'no placeholder', match: [{ check: 'no placeholder', where: '.*', message: '^translation_missing ' }] };
    const screens = { ...LEAKS, element: 'UI quality', match: [{ check: 'UI quality', where: '.*', message: '.*' }] };
    bootstrap(ws, { S01: LEAKS, S04: SLOW, S06: missing, S07: screens });
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    // a busy host makes the slow crypt unknown; the base fails a translation, and a full flow that no seed targets
    vi.mocked(regressChecks).mockImplementation((_ctx, game, _evidence, pick) => {
      const leak = readFileSync(join(game.root, 'client/a.gd'), 'utf8').includes('leak');
      return Promise.resolve({
        checks: [
          item('no blocker', leak ? 'fail' : 'pass', leak ? [['step 2', LEAK]] : []),
          item('full flow', 'fail', [['step 4', 'stuck at the gate']]),
          item('no placeholder', 'fail', [['data/translations/en.csv:9', 'translation_missing en a']]),
          item('UI quality', 'unknown', [['scene/lobby', 'host busy']], 'macos'),
          ...(pick.performance ? [item('performance', 'unknown', [['client/dev/bot/scenario.json:1', 'host CPU 97%']], 'macos')] : []),
        ],
        fixTestProof: [],
      });
    });
    expect((await ogw(ws, ['regress', 'refresh'])).code).toBe(1);
    expect(vi.mocked(sideAgent)).not.toHaveBeenCalled();
    expect(record(ws)).toContain('| none | base-1.0.0 |');
    expect(readAdmission(ws, 'S04')).toMatchObject({ result: 'stale', reason: 'base fails target: performance (macos): unknown: host CPU 97%' });
    expect(readAdmission(ws, 'S06')).toMatchObject({ result: 'stale', reason: 'base fails target: no placeholder data/translations/en.csv:9 translation_missing en a' });
    // ogw regress seed checks the base again for other check inputs, and starts no content agent
    fakeChecks();
    write(ws.harness, 'tools/changed.txt', 'other check code\n');
    sh(ws.harness, 'git', ['add', '-A']);
    sh(ws.harness, 'git', ['commit', '-qm', 'check code']);
    const folder = join(ws.root, 'new-seeds', 'S14');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'seed.json'), JSON.stringify(SLOW));
    writeFileSync(join(folder, 'patch-1.0.0.diff'), patchOf('client/c.gd', 'var y = 1', 'var y = slow'));
    expect((await ogw(ws, ['regress', 'seed', folder])).stdout).toBe(`seed S14: stale (base fails target: performance scene/crypt/crypt ${FPS})\n`);
    expect(vi.mocked(sideAgent)).not.toHaveBeenCalled();
  });
});
