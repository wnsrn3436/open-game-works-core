// `added` of an admission and `ogw regress expect` (ogw.md `### admission` and `### regress refresh` of `## regress`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { regressChecks } from '../../../src/commands/check/api.ts';
import { caughtMatch, messageRegex, whereRegex } from '../../../src/commands/regress/lib/expect.ts';
import { stateSettings } from '../../../src/commands/regress/lib/ops.ts';
import { runSeedAgent } from '../../../src/commands/regress/lib/seed-agent.ts';
import { ogw, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { item, sourceGame, write } from './helpers.ts';

vi.mock('../../../src/commands/check/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/check/api.ts')>()),
  regressChecks: vi.fn(),
}));
vi.mock('../../../src/commands/regress/lib/ops.ts', () => ({ upgradeCore: vi.fn(), stateSettings: vi.fn(), dataTool: vi.fn(() => Promise.resolve(null)) }));
vi.mock('../../../src/commands/regress/lib/seed-agent.ts', () => ({ runSeedAgent: vi.fn() }));

const MISSED = {
  state: 'lc',
  class: 'K9',
  element: 'no blocker',
  expect: 'missed',
  fixer: 'content',
  row: { id: 'slow-door', severity: 'major', owner: 'client content', why: 'w', source: 'play', where: 'door', what: 'stuck 3 s', evidence: ['play'] },
  frozen: [],
  reference: 'fix 12',
};

function patchOf(to: string): string {
  return ['diff --git a/client/a.gd b/client/a.gd', '--- a/client/a.gd', '+++ b/client/a.gd', '@@ -1 +1 @@', '-var x = 1', `+var x = ${to}`, ''].join('\n');
}

/** A harness with one state and the seeds of `expect` `missed` with their patches, at core version 1.0.0. */
function bootstrap(ws: TestWorkspace, seeds: Record<string, string>): void {
  const commit = sourceGame(ws, 'src');
  write(ws.harness, 'regress/states.json', JSON.stringify([{ state: 'lc', game: 'src', commit }]));
  for (const [id, to] of Object.entries(seeds)) {
    write(ws.harness, `regress/seeds/${id}/seed.json`, JSON.stringify(MISSED));
    write(ws.harness, `regress/seeds/${id}/patch-1.0.0.diff`, patchOf(to));
  }
  sh(ws.harness, 'git', ['add', '-A']);
  sh(ws.harness, 'git', ['commit', '-qm', 'regress bootstrap']);
  sh(ws.harness, 'git', ['tag', 'core-v1.0.0']);
}

/**
 * Fake checks: the base fails the regression test; a checkout whose code holds `door` fails no blocker at a step whose
 * number changes from check to check, and one that holds `flaky` fails full flow in every second check only.
 */
function fakeChecks(): void {
  let n = 0;
  vi.mocked(regressChecks).mockImplementation((_ctx, game) => {
    n += 1;
    const code = readFileSync(join(game.root, 'client/a.gd'), 'utf8');
    const door = code.includes('door');
    const flaky = code.includes('flaky') && n % 2 === 0;
    return Promise.resolve({
      checks: [
        item('regression test', 'fail', [['client/tests/test_a.gd:3', 'boom']]),
        item('no blocker', door ? 'fail' : 'pass', door ? [[`client/door.gd:${String(n)}`, `stuck for ${String(n)} s at the door (x)`]] : []),
        item('full flow', flaky ? 'fail' : 'pass', flaky ? [['step 4', 'lost the save']] : []),
      ],
      fixTestProof: [],
    });
  });
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  vi.mocked(regressChecks).mockReset();
  vi.mocked(stateSettings).mockReset().mockResolvedValue({ ok: true, text: 'none' });
  vi.mocked(runSeedAgent).mockReset();
  fakeChecks();
});

describe('ogw regress expect', () => {
  it('makes a missed seed that each admission check caught a caught seed of the checks that caught it, and admits it', async () => {
    const ws = makeWorkspace();
    bootstrap(ws, { S30: 'door' });
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    expect((await ogw(ws, ['regress', 'refresh'])).code).toBe(1);
    const admission = readJson(join(ws.regress, 'seeds/S30/admitted-1.0.0.json'));
    expect(admission).toMatchObject({ result: 'stale', reason: 'not missed: caught, caught, caught' });
    // the failures of each seeded check that no base check has: not the regression test, which the base fails too
    const added = admission.added as { check: string }[][];
    expect(added.map((list) => list.map((f) => f.check))).toEqual([['no blocker'], ['no blocker'], ['no blocker']]);
    expect(runSeedAgent).not.toHaveBeenCalled();
    const run = await ogw(ws, ['regress', 'expect', 'S30', 'caught']);
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe('seed S30: expect caught, target checks no blocker\nseed S30: admitted\n');
    const manifest = readJson(join(ws.regress, 'seeds/S30/seed.json'));
    // every other field as it was
    expect(manifest).toMatchObject({ ...MISSED, expect: 'caught' });
    const match = manifest.match as { check: string; where: string; message: string }[];
    expect(new Set(match.map((m) => m.check))).toEqual(new Set(['no blocker']));
    expect(match.every((m) => new RegExp(m.where).test('client/door.gd:99') && new RegExp(m.message).test('stuck for 77 s at the door (x)'))).toBe(true);
    expect(readJson(join(ws.regress, 'seeds/S30/admitted-1.0.0.json'))).toMatchObject({ result: 'admitted', catch: ['caught', 'caught', 'caught'], added: null });
    // only the target check of the seeded commit, on the kept base checks
    expect(vi.mocked(regressChecks).mock.calls.slice(-3).map((c) => [...(c[3].only ?? ['all'])].join(','))).toEqual(['no blocker', 'no blocker', 'no blocker']);
    expect(sh(ws.regress, 'git', ['log', '-1', '--format=%s']).trim()).toBe('regress expect S30 caught');
    expect(sh(ws.regress, 'git', ['status', '--porcelain']).trim()).toBe('');
  });

  it('fails for a seed whose admission is not stale with each check caught, and for a value other than caught', async () => {
    const ws = makeWorkspace();
    bootstrap(ws, { S31: '2', S32: 'flaky' });
    expect((await ogw(ws, ['regress', 'init'])).code).toBe(0);
    expect((await ogw(ws, ['regress', 'refresh'])).code).toBe(1);
    expect(readJson(join(ws.regress, 'seeds/S32/admitted-1.0.0.json'))).toMatchObject({ result: 'stale', reason: expect.stringMatching(/^not missed: /) as unknown });
    const manifest = readFileSync(join(ws.regress, 'seeds/S31/seed.json'), 'utf8');
    for (const id of ['S31', 'S32']) {
      const run = await ogw(ws, ['regress', 'expect', id, 'caught']);
      expect(run.code).toBe(1);
      expect(run.stderr).toBe(`seed ${id} is not a seed with expect missed whose admission at 1.0.0 is stale with not missed: caught, caught, caught\n`);
    }
    expect((await ogw(ws, ['regress', 'expect', 'S31', 'missed'])).stderr).toBe('usage: ogw regress expect <seed> caught [--background]\n');
    expect((await ogw(ws, ['regress', 'expect', 'S99', 'caught'])).stderr).toContain('no seed S99 in');
    expect(readFileSync(join(ws.regress, 'seeds/S31/seed.json'), 'utf8')).toBe(manifest);
  });
});

describe('caughtMatch', () => {
  const failure = (check: string, where: string, message: string): { check: string; platform: null; where: string; message: string } => ({ check, platform: null, where, message });

  it('takes the checks with an added failure in each list, one item per failure of them, each once', () => {
    const made = caughtMatch({
      added: [
        [failure('no blocker', 'a.gd:1', 'stuck 1 s'), failure('full flow', 'step 4', 'lost')],
        [failure('no blocker', 'a.gd:2', 'stuck 2 s')],
        [failure('no blocker', 'a.gd:1', 'stuck 1 s'), failure('no blocker', 'b.gd', 'other')],
      ],
    });
    expect(made).toEqual({
      checks: ['no blocker'],
      match: [
        { check: 'no blocker', where: whereRegex('a.gd'), message: messageRegex('stuck 1 s') },
        { check: 'no blocker', where: whereRegex('b.gd'), message: messageRegex('other') },
      ],
    });
    expect(caughtMatch({ added: [[failure('full flow', 's', 'm')], []] })).toEqual({ error: 'no check has a failure that no base check has in each of the 2 admission checks' });
    expect(caughtMatch({ added: null })).toEqual({ error: 'its admission keeps no added failures; run ogw regress refresh' });
  });

  it('makes regexes that match as finding keys compare: the where with any line and column, digits of the message as any digits', () => {
    expect(new RegExp(whereRegex('client/a.gd:12')).test('client/a.gd')).toBe(true);
    expect(new RegExp(whereRegex('client/a.gd:12')).test('client/a.gd:3:4')).toBe(true);
    expect(new RegExp(whereRegex('client/a.gd')).test('client/aXgd')).toBe(false);
    expect(new RegExp(messageRegex('leak: 1793 (icon*)')).test('leak: 5 (icon*)')).toBe(true);
    expect(new RegExp(messageRegex('leak: 1793 (icon*)')).test('leak: 5 (iconn)')).toBe(false);
  });
});
