/** The report of a run of the regression suite (ogw.md `### regress report` and `### regress comparison` of `## regress`). */
import { document, renderTable } from '../../loop/lib/markdown.ts';
import type { CatchResult } from './keys.ts';
import { BETTER, LOG_MEASURES, MEASURES, transformed, type Measure } from './measures.ts';
import type { SeedRunResult } from './seed-run.ts';
import type { Side, SideName } from './side.ts';
import { permutationTest, verdictOf, type SeedValues, type Verdict } from './stats.ts';

export interface SeedLine {
  id: string;
  state: string;
  expect: 'caught' | 'missed';
  /** Why the seed is `unknown` in this run (not admitted, stale), or null. */
  unknown: string | null;
}

export interface CatchLine {
  seed: string;
  before: CatchResult | null;
  after: CatchResult | null;
}

/** Everything a report shows; `run.json` holds it. */
export interface RunData {
  run: number;
  catchOnly: boolean;
  sides: Side[];
  seeds: SeedLine[];
  catches: CatchLine[];
  seedRuns: SeedRunResult[];
}

export interface DifferenceLine {
  measure: Measure;
  before: number | null;
  after: number | null;
  d: number | null;
  p: number | null;
  verdict: Verdict;
  seeds: number;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

/** The values of a measure per seed and side over the seed-runs that count. */
function valuesOf(runs: readonly SeedRunResult[], measure: Measure): Map<string, Record<SideName, number[]>> {
  const bySeed = new Map<string, Record<SideName, number[]>>();
  for (const run of runs) {
    const value = run.measures[measure];
    if (run.result === 'unknown' || value === null) continue;
    const entry = bySeed.get(run.seed) ?? { before: [], after: [] };
    entry[run.side].push(value);
    bySeed.set(run.seed, entry);
  }
  return bySeed;
}

/** The comparison of one measure (ogw.md `### regress comparison`). */
export function differenceOf(runs: readonly SeedRunResult[], measure: Measure, permutations: number, level: number, seed: number): DifferenceLine {
  const counted = [...valuesOf(runs, measure).values()].filter((v) => v.before.length >= 2 && v.after.length >= 2);
  const better = BETTER[measure];
  const before = mean(counted.flatMap((v) => v.before));
  const after = mean(counted.flatMap((v) => v.after));
  if (counted.length === 0 || better === null) return { measure, before, after, d: null, p: null, verdict: 'unknown', seeds: counted.length };
  const seeds: SeedValues[] = counted.map((v) => ({ before: v.before.map((x) => transformed(measure, x)), after: v.after.map((x) => transformed(measure, x)) }));
  const test = permutationTest(seeds, permutations, seed);
  return { measure, before, after, d: test.d, p: test.p, verdict: verdictOf(test, better, level), seeds: counted.length };
}

export function differences(data: RunData, permutations: number, level: number): DifferenceLine[] {
  return MEASURES.filter((m) => BETTER[m] !== null).map((m) => differenceOf(data.seedRuns, m, permutations, level, data.run));
}

function num(value: number | null, digits = 2): string {
  if (value === null) return 'none';
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function agentText(side: Side, role: string): string {
  const agent = side.info?.agents[role];
  return agent === undefined ? 'none' : `${agent.cli ?? 'claude-code'} ${agent.model} ${agent.effort}`;
}

function sidesSection(data: RunData): string {
  const known = data.sides.filter((s) => s.unknown === null);
  const lines: string[] = [];
  if (known.length > 0) {
    lines.push(
      renderTable(
        ['side', 'commit', 'core version', 'content agent', 'translation agent', 'content prompt bytes', 'translation prompt bytes'],
        known.map((s) => [s.name, s.commit, s.info?.coreVersion ?? 'none', agentText(s, 'content'), agentText(s, 'translation'), String(s.info?.promptBytes.content ?? 'none'), String(s.info?.promptBytes.translation ?? 'none')]),
      ),
    );
  }
  for (const s of data.sides.filter((side) => side.unknown !== null)) lines.push(`- ${s.name}: unknown (${s.unknown ?? ''})`);
  return lines.join('\n\n');
}

function catchCell(result: CatchResult | null): string {
  if (result === null) return 'none';
  const pipeline = result.catch === 'caught' && result.pipeline !== null ? ` (pipeline ${result.pipeline})` : '';
  return `${result.catch}${pipeline}`;
}

function catchSection(data: RunData): string {
  if (data.catches.length === 0) return 'none';
  const seeds = new Map(data.seeds.map((s) => [s.id, s]));
  return renderTable(
    ['seed', 'state', 'expect', 'before', 'after', 'collateral before', 'collateral after'],
    data.catches.map((c) => {
      const seed = seeds.get(c.seed);
      return [c.seed, seed?.state ?? '', seed?.expect ?? '', catchCell(c.before), catchCell(c.after), c.before?.collateral.join(', ') || 'none', c.after?.collateral.join(', ') || 'none'];
    }),
  );
}

function fixSection(data: RunData): string {
  if (data.seedRuns.length === 0) return 'none';
  return renderTable(
    ['seed', 'side', 'repeat', 'result', ...MEASURES],
    data.seedRuns.map((r) => [r.seed, r.side, String(r.repeat), r.result === 'unknown' ? `unknown (${r.reason ?? ''})` : r.result, ...MEASURES.map((m) => num(r.measures[m]))]),
  );
}

function sum(runs: readonly SeedRunResult[], measure: Measure): number | null {
  const values = runs.map((r) => r.measures[measure]).filter((v): v is number => v !== null);
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
}

export function totalsLines(data: RunData): string[] {
  return (['before', 'after'] as const).map((side) => {
    const runs = data.seedRuns.filter((r) => r.side === side);
    const fixed = runs.filter((r) => r.result === 'fixed').length;
    const unknown = runs.filter((r) => r.result === 'unknown').length;
    return `- ${side}: ${String(runs.length)} seed-runs, ${String(fixed)} fixed, ${String(unknown)} unknown, input tokens ${num(sum(runs, 'input tokens'))}, cost USD ${sum(runs, 'cost USD')?.toFixed(2) ?? 'none'}, agent minutes ${num(sum(runs, 'agent minutes'))}, check minutes ${num(sum(runs, 'check minutes'))}`;
  });
}

export function differenceLines(data: RunData, lines: readonly DifferenceLine[]): string[] {
  const out = data.catchOnly
    ? []
    : lines.map((l) => {
        const ratio = LOG_MEASURES.has(l.measure) && l.d !== null ? ` ratio ${Math.exp(l.d).toFixed(3)}` : '';
        return `- ${l.measure}: before ${num(l.before)}, after ${num(l.after)}, D ${num(l.d, 3)}${ratio}, p ${num(l.p, 3)}, ${l.verdict} (${String(l.seeds)} seeds)`;
      });
  const changed = data.catches.filter((c) => (c.before?.catch ?? null) !== (c.after?.catch ?? null));
  if (changed.length === 0) out.push('- catch: same');
  for (const c of changed) out.push(`- catch ${c.seed}: before ${c.before?.catch ?? 'none'}, after ${c.after?.catch ?? 'none'}`);
  return out;
}

export function unknownLines(data: RunData): string[] {
  const lines: string[] = [];
  for (const s of data.sides) if (s.unknown !== null) lines.push(`- side ${s.name}: ${s.unknown}`);
  for (const s of data.seeds) if (s.unknown !== null) lines.push(`- seed ${s.id}: ${s.unknown}`);
  for (const c of data.catches) {
    for (const side of ['before', 'after'] as const) {
      const result = c[side];
      if (result?.catch === 'unknown') lines.push(`- catch ${c.seed} ${side}: ${result.reason ?? ''}`);
    }
  }
  for (const r of data.seedRuns) if (r.result === 'unknown') lines.push(`- seed-run ${r.id}: ${r.reason ?? ''}`);
  return lines;
}

/** The report `records/runs/<unix ms>.md`. */
export function renderReport(data: RunData, permutations: number, level: number): { text: string; difference: string[] } {
  const unknownSide = data.sides.some((s) => s.unknown !== null);
  if (unknownSide) {
    return { text: document([['sides', sidesSection(data)], ['unknown', unknownLines(data).join('\n') || 'none']]), difference: [] };
  }
  const difference = differenceLines(data, data.catchOnly ? [] : differences(data, permutations, level));
  const text = document([
    ['sides', sidesSection(data)],
    ['catch', catchSection(data)],
    ['fix', fixSection(data)],
    ['totals', data.catchOnly ? 'none' : totalsLines(data).join('\n')],
    ['difference', difference.join('\n')],
    ['unknown', unknownLines(data).join('\n') || 'none'],
  ]);
  return { text, difference };
}
