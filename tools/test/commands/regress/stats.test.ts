import { describe, expect, it } from 'vitest';
import { emptyMeasures, type Measure } from '../../../src/commands/regress/lib/measures.ts';
import { differenceOf, renderReport, type RunData } from '../../../src/commands/regress/lib/report.ts';
import type { SeedRunResult } from '../../../src/commands/regress/lib/seed-run.ts';
import type { Side } from '../../../src/commands/regress/lib/side.ts';
import { difference, mulberry32, permutationTest, verdictOf } from '../../../src/commands/regress/lib/stats.ts';

describe('mulberry32', () => {
  it('gives the same sequence for the same seed and another for another seed, in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect(c()).not.toBe(first[0]);
    for (const value of first) expect(value >= 0 && value < 1).toBe(true);
  });
});

describe('permutation test', () => {
  it('D is the mean over the seeds of the after mean minus the before mean', () => {
    expect(difference([{ before: [0, 0], after: [1, 1] }, { before: [1, 1], after: [1, 0] }])).toBe(0.25);
  });

  it('gives p 1 when the sides are the same and a small p for a clear difference, the same p for the same seed', () => {
    const same = [{ before: [1, 0, 1], after: [1, 0, 1] }];
    expect(permutationTest(same, 200, 7).p).toBe(1);
    const clear = Array.from({ length: 6 }, () => ({ before: [0, 0, 0], after: [1, 1, 1] }));
    const result = permutationTest(clear, 2000, 7);
    expect(result.d).toBe(1);
    // within each seed only 2 of the 20 labelings reach |D| 1, so over six seeds (1/10)^6 of them do
    expect(result.p).toBeLessThan(0.01);
    expect(permutationTest(clear, 2000, 7).p).toBe(result.p);
  });

  it('counts a permutation whose |D| equals the |D| of the values as extreme', () => {
    // two seed-runs per side, one seed: every labeling gives |D| 0 or 1, and half of them give 1
    const half = permutationTest([{ before: [0, 0], after: [1, 1] }], 999, 3);
    expect(half.p).toBeGreaterThan(0.2);
  });

  it('decides better and worse by the way the measure is better, and no difference at p at least the level', () => {
    expect(verdictOf({ d: 0.5, p: 0.01 }, 'higher', 0.1)).toBe('better');
    expect(verdictOf({ d: 0.5, p: 0.01 }, 'lower', 0.1)).toBe('worse');
    expect(verdictOf({ d: -0.5, p: 0.01 }, 'lower', 0.1)).toBe('better');
    expect(verdictOf({ d: 0.5, p: 0.1 }, 'higher', 0.1)).toBe('no difference');
    expect(verdictOf(null, 'higher', 0.1)).toBe('unknown');
  });
});

function run(seed: string, side: 'before' | 'after', repeat: number, values: Partial<Record<Measure, number | null>>, result: SeedRunResult['result'] = 'fixed'): SeedRunResult {
  return { id: `${seed}-${side}-${String(repeat)}`, seed, side, repeat, result, reason: result === 'unknown' ? 'agent failed' : null, measures: { ...emptyMeasures(), ...values }, iterations: [], final: null, newDefects: [], guards: [] };
}

describe('comparison of a measure', () => {
  it('counts a seed only with two counted seed-runs per side, and leaves out unknown seed-runs and missing values', () => {
    const runs = [
      run('S1', 'before', 1, { fixed: 0 }),
      run('S1', 'before', 2, { fixed: 0 }),
      run('S1', 'after', 1, { fixed: 1 }),
      run('S1', 'after', 2, { fixed: 1 }),
      run('S2', 'before', 1, { fixed: 1 }),
      run('S2', 'after', 1, { fixed: 1 }),
      run('S2', 'after', 2, { fixed: 1 }),
      run('S2', 'before', 2, { fixed: 0 }, 'unknown'),
    ];
    const line = differenceOf(runs, 'fixed', 500, 0.1, 1);
    expect(line.seeds).toBe(1);
    expect(line.before).toBe(0);
    expect(line.after).toBe(1);
    expect(line.d).toBe(1);
    expect(differenceOf([run('S1', 'before', 1, { fixed: 1 })], 'fixed', 10, 0.1, 1).verdict).toBe('unknown');
  });

  it('compares the ln measures by ln(1 + value), whose D is a ratio', () => {
    const runs = [run('S1', 'before', 1, { 'input tokens': 99 }), run('S1', 'before', 2, { 'input tokens': 99 }), run('S1', 'after', 1, { 'input tokens': 199 }), run('S1', 'after', 2, { 'input tokens': 199 })];
    const line = differenceOf(runs, 'input tokens', 50, 0.1, 1);
    expect(Math.exp(line.d ?? 0)).toBeCloseTo(2, 10);
    expect(line.before).toBe(99);
  });
});

function side(name: 'before' | 'after', unknown: string | null = null): Side {
  return {
    name,
    commit: `${name}-commit`,
    agents: {},
    worktree: '/w',
    unknown,
    info: unknown === null ? { commit: `${name}-commit`, coreVersion: '1.0.0', promptBytes: { content: 100, translation: 50 }, agents: { content: { cli: 'claude-code', model: 'm', effort: 'high' } } } : null,
  };
}

describe('report', () => {
  const catches: RunData['catches'] = [
    { seed: 'S1', before: { catch: 'caught', reason: null, collateral: ['full flow|-|step 2|stopped'], pipeline: 'pass', matched: null }, after: { catch: 'caught', reason: null, collateral: [], pipeline: 'pass', matched: null } },
    { seed: 'S2', before: { catch: 'missed', reason: null, collateral: [], pipeline: null, matched: null }, after: { catch: 'unknown', reason: 'host busy', collateral: [], pipeline: null, matched: null } },
  ];

  it('has the headings in order and the catch lines that differ', () => {
    const data: RunData = { run: 5, catchOnly: true, sides: [side('before'), side('after')], seeds: [{ id: 'S1', state: 's', expect: 'caught', unknown: null }, { id: 'S2', state: 's', expect: 'missed', unknown: null }, { id: 'S3', state: 's', expect: 'caught', unknown: 'stale at 1.0.0: not caught' }], catches, seedRuns: [] };
    const { text, difference: lines } = renderReport(data, 10, 0.1);
    expect([...text.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(['sides', 'catch', 'fix', 'totals', 'difference', 'unknown']);
    expect(text).toContain('| S1 | s | caught | caught (pipeline pass) | caught (pipeline pass) | full flow\\|-\\|step 2\\|stopped | none |');
    expect(lines).toEqual(['- catch S2: before missed, after unknown']);
    expect(text).toContain('- seed S3: stale at 1.0.0: not caught');
    expect(text).toContain('- catch S2 after: host busy');
  });

  it('with an unknown side has only sides and unknown', () => {
    const data: RunData = { run: 5, catchOnly: false, sides: [side('before', 'npm ci failed'), side('after')], seeds: [], catches: [], seedRuns: [] };
    const { text } = renderReport(data, 10, 0.1);
    expect([...text.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(['sides', 'unknown']);
    expect(text).toContain('- before: unknown (npm ci failed)');
  });

  it('writes a difference line per measure with a better and the totals per side', () => {
    const runs = [run('S1', 'before', 1, { fixed: 1, 'cost USD': 2 }), run('S1', 'before', 2, { fixed: 1, 'cost USD': 2 }), run('S1', 'after', 1, { fixed: 1, 'cost USD': 1 }), run('S1', 'after', 2, { fixed: 1, 'cost USD': 1 })];
    const data: RunData = { run: 5, catchOnly: false, sides: [side('before'), side('after')], seeds: [], catches, seedRuns: runs };
    const { text, difference: lines } = renderReport(data, 20, 0.1);
    expect(lines.filter((l) => !l.startsWith('- catch')).map((l) => l.split(':')[0])).toEqual(['- fixed', '- iterations', '- new defects', '- guards', '- unconfirmed claims', '- test first', '- input tokens', '- cached tokens', '- output tokens', '- cost USD', '- turns', '- agent minutes']);
    expect(lines.find((l) => l.startsWith('- cost USD'))).toMatch(/^- cost USD: before 2, after 1, D -0\.405 ratio 0\.667, p [0-9.]+, (no difference|better) \(1 seeds\)$/);
    expect(text).toContain('- before: 2 seed-runs, 2 fixed, 0 unknown, input tokens none, cost USD 4.00');
  });
});
