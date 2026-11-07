import { describe, expect, it } from 'vitest';
import type { ElementVotes, JudgeEntry, Vote } from '../../../src/commands/loop/lib/files.ts';
import { DEGRADATIONS } from '../../../src/commands/judge/lib/degradations.ts';
import { parseLabels } from '../../../src/commands/judge/lib/pairs.ts';
import {
  agreementValues,
  falseWinRate,
  formatKappa,
  formatRate,
  humanAgreement,
  judgeCount,
  kInJudging,
  orderItems,
  parseReport,
  rateLines,
  rates,
  recommendations,
  renderReport,
  retestItems,
  sensitivity,
  type CalibrationPair,
  type PairOutcome,
  type Rates,
} from '../../../src/commands/judge/lib/report.ts';
import { FUN_ITERATION_ELEMENTS } from '../../../src/commands/loop/lib/files.ts';

const ELEMENTS = ['game feel', 'tension and release', 'no friction'];

function pair(kind: CalibrationPair['kind'], fields: Partial<CalibrationPair> = {}): CalibrationPair {
  return { name: kind, kind, commit: 'c', baseline: 'b', baselineLatencyMs: 0, baselineNetworkDelayMs: 0, baselineFeedbackOff: false, baselineRewardPresentationOff: false, judgings: [2], first: 'A', degradation: null, label: null, missing: null, ...fields };
}

function judge(k: number, side: 'A' | 'B', votes: Record<string, Vote>): { k: number; entry: JudgeEntry } {
  const entry: JudgeEntry = { kind: 'main', result: `r${String(k)}`, agent: { cli: 'claude-code', model: 'm', effort: 'high' }, A: 'c', B: 'b', instanceSide: side, omittedMoments: [], votes, lostMoments: [], vsReference: null, telemetry: null, status: 'done' };
  return { k, entry };
}

function decided(decisions: Record<string, ElementVotes['decision']>): ElementVotes[] {
  return Object.entries(decisions).map(([element, decision]) => ({ element, this: 0, baseline: 0, decision }));
}

function outcome(p: CalibrationPair, judgings: ElementVotes[][], judges: PairOutcome['judges'] = []): PairOutcome {
  return { pair: p, judges, status: 'counted', judgings };
}

/** Rates with every value at `total` decisions and no recommendation, to change one field at a time. */
function quiet(minDecisions: number): Rates {
  const full = { count: 30, total: 30 };
  return {
    falseWin: { count: 0, total: 30 },
    order: [{ name: 'all', rate: full, kappa: 0.9 }],
    retest: [{ name: 'all', rate: full, kappa: null }],
    sensitivity: [{ name: 'all', rate: full }],
    agreement: [{ element: 'game feel', rate: { count: 0, total: 0 } }],
    labels: 0,
    minDecisions,
  };
}

describe('judge calibration rates', () => {
  it('counts the false win rate over the element decisions of the counted null pairs', () => {
    const outcomes = [
      outcome(pair('null'), [decided({ 'game feel': 'this', 'tension and release': 'indistinguishable', 'no friction': 'uncertain' })]),
      outcome(pair('null'), [decided({ 'game feel': 'indistinguishable', 'tension and release': 'baseline', 'no friction': 'indistinguishable' })]),
      { ...outcome(pair('null'), []), status: 'not counted' as const, judgings: null },
    ];
    expect(falseWinRate(outcomes)).toEqual({ count: 2, total: 6 });
  });

  it('counts order consistency by the side vote of each side assignment, with the kappa of the judges', () => {
    const order: PairOutcome = outcome(pair('order', { judgings: [4] }), [[]], [
      judge(1, 'A', { 'game feel': 'this', 'tension and release': 'this', 'no friction': null }),
      judge(2, 'B', { 'game feel': 'this', 'tension and release': 'baseline', 'no friction': null }),
      judge(3, 'A', { 'game feel': 'this', 'tension and release': 'this', 'no friction': 'this' }),
      judge(4, 'B', { 'game feel': 'this', 'tension and release': 'baseline', 'no friction': 'this' }),
    ]);
    // game feel agrees; tension and release differs by side; no friction is mixed within each side
    const items = orderItems([order], ELEMENTS);
    expect(items.map((i) => [i.element, i.same])).toEqual([['game feel', true], ['tension and release', false], ['no friction', false]]);
    expect(items[2]?.ratings).toEqual(['no vote', 'no vote', 'this', 'this']);
    const values = agreementValues(items, ELEMENTS);
    expect(values.map((v) => [v.name, v.rate])).toEqual([
      ['all', { count: 1, total: 3 }],
      ['game feel', { count: 1, total: 1 }],
      ['tension and release', { count: 0, total: 1 }],
      ['no friction', { count: 0, total: 1 }],
    ]);
    // four judges: Fleiss kappa; game feel alone has every rating `this`
    expect(values[1]?.kappa).toBeNull();
    // p_o = (1 + 1/3 + 1/3) ÷ 3 = 5/9, p_e = (2/3)² + (1/6)² + (1/6)² = 1/2: kappa 1/9
    expect(values[0]?.kappa).toBeCloseTo(1 / 9, 10);
    expect(orderItems([{ ...order, status: 'not counted', judgings: null }], ELEMENTS)).toEqual([]);
  });

  it('takes Cohen kappa of the two judges of an order pair with two judges', () => {
    const order = (a: Vote, b: Vote): PairOutcome => outcome(pair('order'), [[]], [judge(1, 'A', { 'game feel': a }), judge(2, 'B', { 'game feel': b })]);
    const outcomes = [order('this', 'this'), order('this', null), order(null, null), order(null, 'this')];
    const [all] = agreementValues(orderItems(outcomes, ['game feel']), ['game feel']);
    // p_o = 0.5, p_e = 0.5: kappa 0
    expect(all).toEqual({ name: 'all', rate: { count: 2, total: 4 }, kappa: 0 });
  });

  it('counts retest agreement over the element decisions of the two judgings, with their Cohen kappa', () => {
    const retest = (first: ElementVotes['decision'], second: ElementVotes['decision']): PairOutcome =>
      outcome(pair('retest', { judgings: [2, 2] }), [decided({ 'game feel': first }), decided({ 'game feel': second })]);
    const outcomes = [retest('this', 'this'), retest('this', 'indistinguishable'), retest('indistinguishable', 'indistinguishable'), retest('indistinguishable', 'indistinguishable')];
    const items = retestItems(outcomes, ['game feel']);
    expect(items.map((i) => i.ratings)).toEqual([['this', 'this'], ['this', 'indistinguishable'], ['indistinguishable', 'indistinguishable'], ['indistinguishable', 'indistinguishable']]);
    const [all, gameFeel] = agreementValues(items, ['game feel']);
    // p_o = 0.75, p_e = 0.5 × 0.25 + 0.5 × 0.75 = 0.5: kappa 0.5
    expect(all?.rate).toEqual({ count: 3, total: 4 });
    expect(all?.kappa).toBeCloseTo(0.5, 10);
    expect(gameFeel?.kappa).toBeCloseTo(0.5, 10);
  });

  it('degrades the baseline instances per degradation with its flags only, for its target element', () => {
    const c = { nullPairs: 0, orderPairs: 0, orderRuns: 1, retestPairs: 0, degradedPairs: 1, degradeLatencyMs: 150, degradeNetworkDelayMs: 3000, minDecisions: 1 };
    const none = { latencyMs: 0, networkDelayMs: 0, feedbackOff: false, rewardPresentationOff: false };
    expect(DEGRADATIONS.map((d) => [d.name, d.element, d.baseline(c)])).toEqual([
      ['latency', 'game feel', { ...none, latencyMs: 150 }],
      ['network', 'no friction', { ...none, networkDelayMs: 3000 }],
      ['feedback', 'game feel', { ...none, feedbackOff: true }],
      ['reward', 'tension and release', { ...none, rewardPresentationOff: true }],
    ]);
  });

  it('counts sensitivity per degradation by the decision of its target element', () => {
    const degraded = (name: 'latency' | 'network' | 'feedback' | 'reward', element: string, decision: ElementVotes['decision']): PairOutcome =>
      outcome(pair('degraded', { degradation: { name, element } }), [
        decided({ 'game feel': 'indistinguishable', 'tension and release': 'indistinguishable', 'no friction': 'indistinguishable', [element]: decision }),
      ]);
    const outcomes = [
      degraded('latency', 'game feel', 'this'),
      degraded('latency', 'game feel', 'uncertain'),
      degraded('network', 'no friction', 'this'),
      degraded('network', 'no friction', 'this'),
      degraded('feedback', 'game feel', 'this'),
      degraded('feedback', 'game feel', 'baseline'),
      degraded('reward', 'tension and release', 'this'),
      degraded('reward', 'tension and release', 'indistinguishable'),
    ];
    expect(sensitivity(outcomes, DEGRADATIONS)).toEqual([
      { name: 'all', rate: { count: 5, total: 8 } },
      { name: 'latency (game feel)', rate: { count: 1, total: 2 } },
      { name: 'network (no friction)', rate: { count: 2, total: 2 } },
      { name: 'feedback (game feel)', rate: { count: 1, total: 2 } },
      { name: 'reward (tension and release)', rate: { count: 1, total: 2 } },
    ]);
    expect(sensitivity([], DEGRADATIONS).map((v) => v.rate.total)).toEqual([0, 0, 0, 0, 0]);
    // every degradation targets an element the calibration judges vote on
    for (const d of DEGRADATIONS) expect(FUN_ITERATION_ELEMENTS).toContain(d.element);
  });

  it('matches human answers to decisions, with uncertain never equal', () => {
    const label = { A: 'c', B: 'b', answers: { 'game feel': 'A' as const, 'tension and release': 'same' as const, 'no friction': 'B' as const }, note: '', at: 1 };
    const labeled = outcome(pair('label', { label }), [decided({ 'game feel': 'this', 'tension and release': 'indistinguishable', 'no friction': 'uncertain' })]);
    expect(humanAgreement([labeled], ELEMENTS)).toEqual([
      { element: 'game feel', rate: { count: 1, total: 1 } },
      { element: 'tension and release', rate: { count: 1, total: 1 } },
      { element: 'no friction', rate: { count: 0, total: 1 } },
    ]);
  });

  it('writes a value only when its total reaches the minimum', () => {
    expect(formatRate({ count: 2, total: 3 }, 3)).toBe('0.67 (2 of 3)');
    expect(formatRate({ count: 2, total: 29 }, 30)).toBe('none (29 of 30)');
    expect(formatRate({ count: 0, total: 0 }, 30)).toBe('none (0 of 30)');
    expect(formatRate({ count: 30, total: 30 }, 30)).toBe('1.00 (30 of 30)');
    expect(formatKappa({ name: 'all', rate: { count: 1, total: 29 }, kappa: 0.5 }, 30)).toBe('kappa none');
    expect(formatKappa({ name: 'all', rate: { count: 1, total: 30 }, kappa: 0.5 }, 30)).toBe('kappa 0.50');
    expect(formatKappa({ name: 'all', rate: { count: 30, total: 30 }, kappa: null }, 30)).toBe('kappa undefined');
  });

  it('recommends only from the values that count', () => {
    expect(recommendations(quiet(30), 2)).toEqual([]);
    const panel = (conditions: string): string =>
      `set loop.judgePanel to judges that mix models and efforts of the agent CLIs that are logged in (${conditions})`;
    // below the thresholds, but under the minimum: nothing
    const few = { count: 1, total: 29 };
    expect(recommendations({ ...quiet(30), falseWin: few, order: [{ name: 'all', rate: few, kappa: 0 }], sensitivity: [{ name: 'all', rate: few }] }, 2)).toEqual([]);
    expect(recommendations({ ...quiet(30), falseWin: { count: 1, total: 30 } }, 4)).toEqual(['raise loop.judgeVotes to 6 (false win rate 0.03 (1 of 30))']);
    const low = { ...quiet(30), order: [{ name: 'all', rate: { count: 21, total: 30 }, kappa: 0.41 }, { name: 'game feel', rate: { count: 9, total: 10 }, kappa: 0.1 }] };
    expect(recommendations(low, 2)).toEqual([panel('order consistency all 0.70 (21 of 30), order consistency all kappa 0.41')]);
    const retest = { ...quiet(30), retest: [{ name: 'all', rate: { count: 27, total: 30 }, kappa: 0.55 }] };
    expect(recommendations(retest, 2)).toEqual([panel('retest agreement all kappa 0.55')]);
    const insensitive = { ...quiet(30), sensitivity: [{ name: 'all', rate: { count: 20, total: 30 } }, { name: 'latency (game feel)', rate: { count: 10, total: 15 } }] };
    expect(recommendations(insensitive, 2)).toEqual([panel('sensitivity all 0.67 (20 of 30)')]);
    const human = { ...quiet(3), agreement: [{ element: 'game feel', rate: { count: 1, total: 2 } }, { element: 'no friction', rate: { count: 1, total: 3 } }] };
    expect(recommendations(human, 2)).toEqual([panel('human agreement no friction 0.33 (1 of 3)')]);
  });

  it('writes the rate lines and the report', () => {
    const empty = rates([], ELEMENTS, DEGRADATIONS, 0, 30);
    const lines = [
      'false win rate: none (0 of 30)',
      'order consistency: all none (0 of 30) kappa none, game feel none (0 of 30) kappa none, tension and release none (0 of 30) kappa none, no friction none (0 of 30) kappa none',
      'retest agreement: all none (0 of 30) kappa none, game feel none (0 of 30) kappa none, tension and release none (0 of 30) kappa none, no friction none (0 of 30) kappa none',
      'sensitivity: all none (0 of 30), latency (game feel) none (0 of 30), network (no friction) none (0 of 30), feedback (game feel) none (0 of 30), reward (tension and release) none (0 of 30)',
      'human agreement: none',
      'labels: 0',
    ];
    expect(rateLines(empty)).toEqual(lines);
    // the loop end record joins these lines with `; `
    for (const line of lines) expect(line).not.toContain(';');
    const retest = outcome(pair('retest', { name: 'retest-1', judgings: [2, 2] }), [
      [{ element: 'game feel', this: 2, baseline: 0, decision: 'this' }],
      [{ element: 'game feel', this: 1, baseline: 0, decision: 'indistinguishable' }],
    ]);
    const text = renderReport([retest], ['game feel'], rates([retest], ['game feel'], DEGRADATIONS, 0, 1), 2);
    expect(text).toContain('| retest-1 | c | b | counted | this (2/0); indistinguishable (1/0) |');
    expect(parseReport(renderReport([], ELEMENTS, empty, 2))).toEqual({ rates: lines, recommendations: [] });
  });

  it('counts the judges of each judging from 1', () => {
    expect(judgeCount({ judgings: [2, 2] })).toBe(4);
    expect([1, 2, 3, 4].map((k) => kInJudging([2, 2], k))).toEqual([1, 2, 1, 2]);
    expect([1, 2, 3].map((k) => kInJudging([3], k))).toEqual([1, 2, 3]);
  });

  it('refuses a labels file that is not an array of entries', () => {
    expect(() => parseLabels('{')).toThrow('records/calibration/labels.json is not JSON');
    expect(() => parseLabels('{}')).toThrow('is not a JSON array');
    expect(() => parseLabels('[{"A":"a","B":"b","answers":{"game feel":"C"},"note":"","at":1}]')).toThrow('entry 1: answers are not "A", "B" or "same"');
    expect(parseLabels('[{"A":"a","B":"b","answers":{"game feel":"same"},"note":"n","at":1}]')).toHaveLength(1);
  });
});
