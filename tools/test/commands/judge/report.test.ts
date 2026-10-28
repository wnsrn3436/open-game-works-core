import { describe, expect, it } from 'vitest';
import type { ElementVotes, JudgeEntry, Vote } from '../../../src/commands/loop/lib/files.ts';
import { parseLabels } from '../../../src/commands/judge/lib/pairs.ts';
import {
  formatRate,
  humanAgreement,
  orderConsistency,
  parseReport,
  rateLines,
  rates,
  recommendations,
  renderReport,
  sensitivity,
  type CalibrationPair,
  type PairOutcome,
} from '../../../src/commands/judge/lib/report.ts';

const ELEMENTS = ['game feel', 'tension and release', 'no friction'];

function pair(kind: CalibrationPair['kind'], fields: Partial<CalibrationPair> = {}): CalibrationPair {
  return { name: kind, kind, commit: 'c', baseline: 'b', baselineLatencyMs: 0, judges: 2, first: 'A', label: null, missing: null, ...fields };
}

function judge(k: number, side: 'A' | 'B', votes: Record<string, Vote>): { k: number; entry: JudgeEntry } {
  const entry: JudgeEntry = { kind: 'main', result: `r${String(k)}`, agent: { cli: 'claude-code', model: 'm', effort: 'high' }, A: 'c', B: 'b', instanceSide: side, omittedMoments: [], votes, lostMoments: [], vsReference: null, telemetry: null, status: 'done' };
  return { k, entry };
}

function decided(decisions: Record<string, ElementVotes['decision']>): ElementVotes[] {
  return Object.entries(decisions).map(([element, decision]) => ({ element, this: 0, baseline: 0, decision }));
}

describe('judge calibration rates', () => {
  it('counts order consistency by the side vote of each side assignment', () => {
    const order: PairOutcome = {
      pair: pair('order', { judges: 4 }),
      status: 'counted',
      votes: [],
      judges: [
        judge(1, 'A', { 'game feel': 'this', 'tension and release': 'this', 'no friction': null }),
        judge(2, 'B', { 'game feel': 'this', 'tension and release': 'baseline', 'no friction': null }),
        judge(3, 'A', { 'game feel': 'this', 'tension and release': 'this', 'no friction': 'this' }),
        judge(4, 'B', { 'game feel': 'this', 'tension and release': 'baseline', 'no friction': 'this' }),
      ],
    };
    // game feel agrees; tension and release differs by side; no friction is mixed within each side
    expect(orderConsistency([order], ELEMENTS)).toEqual({ count: 1, total: 3 });
    expect(orderConsistency([{ ...order, status: 'not counted' }], ELEMENTS)).toEqual({ count: 0, total: 0 });
  });

  it('matches human answers to decisions, with uncertain never equal', () => {
    const label = { A: 'c', B: 'b', answers: { 'game feel': 'A' as const, 'tension and release': 'same' as const, 'no friction': 'B' as const }, note: '', at: 1 };
    const outcome: PairOutcome = { pair: pair('label', { label }), status: 'counted', judges: [], votes: decided({ 'game feel': 'this', 'tension and release': 'indistinguishable', 'no friction': 'uncertain' }) };
    expect(humanAgreement([outcome], ELEMENTS)).toEqual([
      { element: 'game feel', rate: { count: 1, total: 1 } },
      { element: 'tension and release', rate: { count: 1, total: 1 } },
      { element: 'no friction', rate: { count: 0, total: 1 } },
    ]);
    expect(sensitivity([{ pair: pair('degraded'), status: 'counted', judges: [], votes: decided({ 'game feel': 'uncertain' }) }])).toBe(false);
    expect(sensitivity([])).toBeNull();
  });

  it('writes the rates and the recommendations of the thresholds', () => {
    expect(formatRate({ count: 2, total: 3 })).toBe('0.67 (2 of 3)');
    expect(formatRate({ count: 0, total: 0 })).toBe('none');
    const r = {
      falseWin: { count: 0, total: 9 },
      order: { count: 3, total: 3 },
      sensitivity: true,
      agreement: [
        { element: 'game feel', rate: { count: 1, total: 2 } },
        { element: 'no friction', rate: { count: 1, total: 3 } },
      ],
      labels: 3,
    };
    // a low agreement counts only over at least 3 labeled pairs
    expect(recommendations(r, 2)).toEqual([
      'set loop.judgePanel to judges that mix Claude Code models and efforts; add Codex judges only when the Codex CLI is logged in (human agreement no friction 0.33 (1 of 3))',
    ]);
    expect(recommendations({ ...r, agreement: [], order: { count: 2, total: 3 }, sensitivity: false, falseWin: { count: 1, total: 9 } }, 4)).toEqual([
      'raise loop.judgeVotes to 6 (false win rate 0.11 (1 of 9))',
      'set loop.judgePanel to judges that mix Claude Code models and efforts; add Codex judges only when the Codex CLI is logged in (order consistency 0.67 (2 of 3), sensitivity no)',
    ]);
    expect(recommendations({ ...r, agreement: [], order: { count: 0, total: 0 }, sensitivity: null }, 2)).toEqual([]);
    expect(rateLines(rates([], ELEMENTS, 0))).toEqual(['false win rate: none', 'order consistency: none', 'sensitivity: none', 'human agreement: none', 'labels: 0']);
    const text = renderReport([], ELEMENTS, rates([], ELEMENTS, 0), 2);
    expect(parseReport(text)).toEqual({ rates: ['false win rate: none', 'order consistency: none', 'sensitivity: none', 'human agreement: none', 'labels: 0'], recommendations: [] });
  });

  it('refuses a labels file that is not an array of entries', () => {
    expect(() => parseLabels('{')).toThrow('records/calibration/labels.json is not JSON');
    expect(() => parseLabels('{}')).toThrow('is not a JSON array');
    expect(() => parseLabels('[{"A":"a","B":"b","answers":{"game feel":"C"},"note":"","at":1}]')).toThrow('entry 1: answers are not "A", "B" or "same"');
    expect(parseLabels('[{"A":"a","B":"b","answers":{"game feel":"same"},"note":"n","at":1}]')).toHaveLength(1);
  });
});
