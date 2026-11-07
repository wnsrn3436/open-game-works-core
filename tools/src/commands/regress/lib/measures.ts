/** The measures of a seed-run (ogw.md `### seed-run` of `## regress`), in the order of the measure table. */

export const MEASURES = [
  'fixed',
  'iterations',
  'new defects',
  'guards',
  'unconfirmed claims',
  'test first',
  'input tokens',
  'cached tokens',
  'output tokens',
  'cost USD',
  'turns',
  'agent minutes',
  'check minutes',
  'placeholders',
  'own fixed',
] as const;

export type Measure = (typeof MEASURES)[number];

/** The way a measure is better; null for a measure without a verdict. */
export const BETTER: Readonly<Record<Measure, 'higher' | 'lower' | null>> = {
  fixed: 'higher',
  iterations: 'lower',
  'new defects': 'lower',
  guards: 'lower',
  'unconfirmed claims': 'lower',
  'test first': 'higher',
  'input tokens': 'lower',
  'cached tokens': 'lower',
  'output tokens': 'lower',
  'cost USD': 'lower',
  turns: 'lower',
  'agent minutes': 'lower',
  'check minutes': null,
  placeholders: null,
  'own fixed': null,
};

/** The measures whose transformed value is ln(1 + value) (ogw.md `### regress comparison`). */
export const LOG_MEASURES: ReadonlySet<Measure> = new Set<Measure>(['input tokens', 'cached tokens', 'output tokens', 'cost USD', 'turns', 'agent minutes']);

export type MeasureValues = Record<Measure, number | null>;

export function emptyMeasures(): MeasureValues {
  return Object.fromEntries(MEASURES.map((m) => [m, null])) as MeasureValues;
}

export function transformed(measure: Measure, value: number): number {
  return LOG_MEASURES.has(measure) ? Math.log1p(value) : value;
}
