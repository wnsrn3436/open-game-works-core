import { describe, expect, it } from 'vitest';
import { cohenKappa, fleissKappa, kappa } from '../../../src/commands/judge/lib/kappa.ts';

/** Items of two ratings from a table of counts: `table[a][b]` items rated `a` by the first rater and `b` by the second. */
function fromTable(table: Record<string, Record<string, number>>): [string, string][] {
  return Object.entries(table).flatMap(([a, row]) => Object.entries(row).flatMap(([b, n]) => Array.from({ length: n }, () => [a, b] as [string, string])));
}

/** Items of ratings from per-item category counts. */
function fromCounts(rows: readonly (readonly number[])[]): string[][] {
  return rows.map((counts) => counts.flatMap((n, c) => Array.from({ length: n }, () => `c${String(c)}`)));
}

describe('kappa', () => {
  it('computes Cohen kappa of a known table', () => {
    // p_o = 35/50 = 0.7; p_e = 0.5 × 0.6 + 0.5 × 0.4 = 0.5; kappa = 0.4
    const items = fromTable({ yes: { yes: 20, no: 5 }, no: { yes: 10, no: 15 } });
    expect(cohenKappa(items)).toBeCloseTo(0.4, 10);
    expect(kappa(items)).toBeCloseTo(0.4, 10);
    // perfect agreement over two categories, and agreement no better than chance
    expect(cohenKappa(fromTable({ a: { a: 3 }, b: { b: 2 } }))).toBe(1);
    expect(cohenKappa(fromTable({ a: { a: 1, b: 1 }, b: { a: 1, b: 1 } }))).toBe(0);
    // a category only the second rater gives: p_e = 0.5 × 0.5 + 0.5 × 0.25 = 0.375, p_o = 0.5, kappa = 0.2
    expect(cohenKappa([['x', 'x'], ['x', 'z'], ['y', 'x'], ['y', 'y']])).toBeCloseTo(0.2, 10);
  });

  it('computes Fleiss kappa of a known table of 10 items and 14 raters', () => {
    const rows = [
      [0, 0, 0, 0, 14],
      [0, 2, 6, 4, 2],
      [0, 0, 3, 5, 6],
      [0, 3, 9, 2, 0],
      [2, 2, 8, 1, 1],
      [7, 7, 0, 0, 0],
      [3, 2, 6, 3, 0],
      [2, 5, 3, 2, 2],
      [6, 5, 2, 1, 0],
      [0, 2, 2, 3, 7],
    ];
    // P̄ = 0.378, P̄e = 0.213: kappa 0.210
    expect(fleissKappa(fromCounts(rows))).toBeCloseTo(0.20993, 4);
    expect(kappa(fromCounts(rows))).toBeCloseTo(0.20993, 4);
  });

  it('is undefined (null) when every rating is in one category, without items, or with uneven items', () => {
    expect(cohenKappa([['a', 'a'], ['a', 'a']])).toBeNull();
    expect(fleissKappa([['a', 'a', 'a'], ['a', 'a', 'a']])).toBeNull();
    expect(cohenKappa([])).toBeNull();
    expect(kappa([])).toBeNull();
    expect(fleissKappa([['a', 'b', 'a'], ['a', 'b']])).toBeNull();
  });
});
