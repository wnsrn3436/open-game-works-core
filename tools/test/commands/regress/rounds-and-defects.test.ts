// The round input of the seed agent (ogw.md `### seed agent` 5) and the base defects of the base fix (`### regress
// refresh` 4), as the tool makes them from check files.
import { describe, expect, it } from 'vitest';
import { baseDefects, baseFixInput } from '../../../src/commands/regress/lib/base-fix.ts';
import type { SeenAdmission } from '../../../src/commands/regress/lib/refresh.ts';
import type { Admission, Seed, SeedManifest } from '../../../src/commands/regress/lib/repo.ts';
import { roundInput } from '../../../src/commands/regress/lib/round-input.ts';
import { checkFile, item } from './helpers.ts';

function seedOf(id: string, manifest: Partial<SeedManifest>): Seed {
  return {
    id,
    manifest: {
      state: 'lc',
      class: 'K1',
      element: 'no blocker',
      expect: 'caught',
      match: [],
      performance: false,
      fixer: 'content',
      row: { id: 'r', severity: 'major', owner: 'client content', why: 'w', source: 'check' },
      frozen: [],
      frozenColumns: [],
      oracle: false,
      regenerate: false,
      reference: '',
      ...manifest,
    },
  };
}

const LEAK = 'client main error log: 1793 error ResourceCore leak: icon/flame';
const CAUGHT = seedOf('S01', { match: [{ check: 'no blocker', where: '^step \\d+$', message: '^client main error log: .*leak: icon/flame' }] });

function stale(reason: string, fields: Partial<Admission> = {}): Admission {
  return { result: 'stale', base: 'b', seeded: 's', reference: null, catch: [], oracle: null, reason, added: null, at: 1, ...fields };
}

describe('the round input of the seed agent', () => {
  it('holds the stale reason, the items of the target checks of a caught seed with their failures, those that match the seed marked, and why a check did not run', () => {
    const seen: SeenAdmission = {
      admission: stale('not caught: caught, missed, unknown (ogw regress check exit 1: the server did not start)'),
      checks: [
        { file: checkFile('s', item('regression test', 'fail', [['client/tests/test_a.gd', 'boom']]), item('no blocker', 'fail', [['step 2', LEAK], ['step 3', 'client main error log: 7 error ResourceCore leak: icon/drip']])) },
        { file: checkFile('s', item('no blocker', 'pass')) },
        { error: 'ogw regress check exit 1: the server did not start' },
      ],
      probes: null,
    };
    expect(roundInput(CAUGHT, 2, '/f/input.md', seen)).toBe(
      [
        '## round', '', '2', '',
        '## first input', '', '/f/input.md', '',
        '## stale reason', '', 'not caught: caught, missed, unknown (ogw regress check exit 1: the server did not start)', '',
        '## checks', '',
        '### check 1', '', '- no blocker: fail', `  - step 2: ${LEAK} (matches the seed)`, '  - step 3: client main error log: 7 error ResourceCore leak: icon/drip', '',
        '### check 2', '', '- no blocker: pass', '',
        '### check 3', '', 'did not run: ogw regress check exit 1: the server did not start', '',
        '## probes', '', 'none', '',
      ].join('\n'),
    );
  });

  it('holds the probes of an oracle seed and, for a missed seed, only the failures that the base checks do not have', () => {
    const missed = seedOf('S09', { expect: 'missed', oracle: true });
    const seen: SeenAdmission = {
      admission: stale('oracle: seeded unknown (the probe threw: the pause popup opening did not happen), reference fail (ko: Luck: 24 px above the bottom)', {
        added: [[{ check: 'UI quality', platform: 'macos', where: 'scene/run', message: 'clipped Luck in prefab/run/stats (ko)' }], [], []],
      }),
      checks: [
        { file: checkFile('s', item('UI quality', 'fail', [['scene/run', 'clipped Luck in prefab/run/stats (ko)'], ['scene/menu', 'low contrast x in scene/menu/menu (ko)']], 'macos')) },
        { file: checkFile('s', item('UI quality', 'pass', [], 'macos')) },
        { file: checkFile('s', item('UI quality', 'pass', [], 'macos')) },
      ],
      probes: { seeded: { result: 'unknown', reason: 'the probe threw: the pause popup opening did not happen' }, reference: { result: 'fail', reason: 'ko: Luck: 24 px above the bottom' } },
    };
    const text = roundInput(missed, 3, '/f/input.md', seen);
    expect(text).toContain('## round\n\n3\n');
    expect(text).toContain('## checks\n\n### check 1\n\n- UI quality (macos) scene/run: clipped Luck in prefab/run/stats (ko)\n\n### check 2\n\nnone\n\n### check 3\n\nnone\n');
    expect(text).not.toContain('low contrast');
    expect(text).toContain('## probes\n\n- seeded: unknown: the probe threw: the pause popup opening did not happen\n- reference: fail: ko: Luck: 24 px above the bottom\n');
  });

  it('is none for checks and probes when admission stopped before them', () => {
    const text = roundInput(CAUGHT, 2, '/f/input.md', { admission: stale('patch does not apply: error: corrupt patch at line 5'), checks: null, probes: null });
    expect(text).toContain('## stale reason\n\npatch does not apply: error: corrupt patch at line 5\n\n## checks\n\nnone\n\n## probes\n\nnone\n');
  });
});

const FPS = 'fps 5 percentile 39 is below the fps bound 59 (126 samples)';
const HITCH = 'hitch ratio 12.5 ms/s is at least 10 ms/s over 60.0 s of kept frames (750.0 ms of hitch time in this scene)';
const PERFORMANCE = seedOf('S04', { element: 'performance', performance: true, match: [{ check: 'performance', where: '^scene/crypt/', message: '^(fps|hitch)' }] });

describe('the base defects of the base fix', () => {
  it('makes one defect per failure of a target check that matches a seed, in the order of the first, with its evidence in each base check', () => {
    const perf = (k: number): ReturnType<typeof item> => ({
      ...item('performance', 'fail', [['scene/crypt/crypt', FPS], ['scene/crypt/crypt', HITCH], ['scene/menu/menu', FPS]], 'macos'),
      failures: [
        { where: 'scene/crypt/crypt', message: FPS.replace('39', String(38 + k)), evidence: [`/d/lc-base-${String(k)}/performance-macos/samples.json`] },
        { where: 'scene/crypt/crypt', message: HITCH, evidence: [] },
        // not the seed's: it matches no seed of the state
        { where: 'scene/menu/menu', message: FPS, evidence: [] },
      ],
    });
    const checks = [1, 2, 3].map((k) => ({ file: checkFile('b', perf(k), item('no blocker', 'pass')), path: `/d/lc-base-${String(k)}.json` }));
    const defects = baseDefects([PERFORMANCE, CAUGHT], checks);
    expect(defects.map((d) => [d.id, d.where, d.what])).toEqual([
      ['performance-scene-crypt-crypt', 'scene/crypt/crypt', FPS],
      ['performance-scene-crypt-crypt-2', 'scene/crypt/crypt', HITCH],
    ]);
    expect(defects[0]).toMatchObject({ severity: 'major', owner: 'client content', why: 'the performance check fails', source: 'check', status: 'open' });
    expect(defects[0]?.evidence).toEqual([
      '/d/lc-base-1.json#performance', '/d/lc-base-1/performance-macos/samples.json',
      '/d/lc-base-2.json#performance', '/d/lc-base-2/performance-macos/samples.json',
      '/d/lc-base-3.json#performance', '/d/lc-base-3/performance-macos/samples.json',
    ]);
    const input = baseFixInput(defects);
    expect(input).toMatch(/^## kind\n\ncompleteness\n\n## request\n\nnone\n\n## previous record\n\nnone\n\n## defects\n\n\| id \| severity \| owner \| where \| what \| why \| evidence \| source \| status \|/);
    // the content agent gets failures of the base: no seed
    expect(input).not.toMatch(/S04|S01|\^\(fps/);
  });

  it('takes the owner of a UI quality, a row simulation and a server failure, and gives none for an unknown item, a check that is no target, or no placeholder', () => {
    const anything = (check: string): { check: string; where: string; message: string } => ({ check, where: '.*', message: '.*' });
    const seed = seedOf('S06', { match: ['UI quality', 'row simulation', 'regression test', 'no placeholder', 'no blocker'].map(anything) });
    const file = checkFile(
      'b',
      item('UI quality', 'fail', [['scene/run', 'clipped Luck in prefab/run/stats (ko, macbook_air_13)']], 'macos'),
      item('row simulation', 'fail', [['data/tables/opponent.csv:5', 'out [opp_a] sim_turns 3 not in 5..9']]),
      item('regression test', 'fail', [['server/tests/battle.test.ts', 'battle > ends']]),
      item('no placeholder', 'fail', [['data/translations/en.csv:9', 'translation_missing en a']]),
      item('no blocker', 'unknown', [['client/dev/bot/scenario.json:1', 'host CPU 97%']]),
      item('full flow', 'fail', [['step 4', 'stuck']]),
    );
    const defects = baseDefects([seed], [{ file, path: '/d/lc-base-1.json' }]);
    expect(defects.map((d) => [d.id, d.owner, d.why])).toEqual([
      ['clipped-prefab-run-stats', 'client content', 'UI quality: clipped in prefab/run/stats'],
      ['row-simulation-data-tables-opponent-csv', 'data', 'the row simulation check fails'],
      ['regression-test-server-tests-battle-test-ts', 'server content', 'the regression test check fails'],
    ]);
    expect(baseDefects([CAUGHT], [{ file, path: '/d/lc-base-1.json' }])).toEqual([]);
  });
});
