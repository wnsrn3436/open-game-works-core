import { describe, expect, it } from 'vitest';
import {
  defectRow,
  evidenceChecks,
  evidenceMetrics,
  groupFindings,
  fillFromSameId,
  incompleteFindings,
  isSeverity,
  recordDefects,
  type Defect,
  type Finding,
} from '../../../../src/commands/loop/lib/defects.ts';
import type { CheckFile, EvaluateFile, MeasureFile } from '../../../../src/commands/loop/lib/files.ts';
import { confirmedBy } from '../../../../src/commands/loop/lib/record.ts';

function f(fields: Partial<Finding>): Finding {
  return {
    source: 'check',
    severity: 'minor',
    owner: 'data',
    where: 'w',
    what: 'x',
    why: 'y',
    evidence: ['e'],
    id: 'a',
    drop: null,
    ...fields,
  };
}

function d(fields: Partial<Defect>): Defect {
  return {
    id: 'a',
    severity: 'minor',
    owner: 'data',
    where: 'w',
    what: 'x',
    why: 'y',
    evidence: ['e'],
    source: 'check',
    status: 'open',
    refusedReason: null,
    repeatedDefect: 0,
    oscillation: 0,
    ...fields,
  };
}

const always = (): boolean => true;
const never = (): boolean => false;

describe('finding checks', () => {
  it('fills the empty severity, owner and why of a finding from the first finding of its id that has all three', () => {
    const blank = { severity: null, owner: null, why: null };
    const out = fillFromSameId([
      f({ id: 'a', ...blank, what: 'a1' }),
      f({ id: 'a', severity: 'minor', owner: 'design', why: 'w', what: 'a2' }),
      f({ id: 'a', severity: 'major', owner: 'data', why: 'x', what: 'a3' }),
      f({ id: 'b', ...blank }),
      f({ id: null, ...blank, drop: 'placeholder' }),
    ]);
    expect(out.map((x) => [x.id, x.severity, x.owner, x.why])).toEqual([
      ['a', 'minor', 'design', 'w'],
      ['a', 'minor', 'design', 'w'],
      ['a', 'major', 'data', 'x'],
      // no finding of b has them: still refused
      ['b', null, null, null],
      [null, null, null, null],
    ]);
    expect(incompleteFindings(out).map((x) => x.id)).toEqual(['b']);
  });

  it('finds findings record refuses', () => {
    const bad = [f({ id: null }), f({ severity: null }), f({ owner: null }), f({ why: null }), f({ id: 'Not-Kebab' }), f({ id: 'a--b' })];
    expect(incompleteFindings([...bad, f({}), f({ id: null, drop: 'placeholder' })])).toEqual(bad);
    expect(incompleteFindings([f({ severity: 'huge' as 'minor' })])).toHaveLength(1);
    const invalid = [
      f({ owner: '' }),
      f({ owner: 'resources' }),
      f({ why: '' }),
      f({ why: '  ' }),
      f({ drop: '' }),
      f({ drop: ' ', id: null }),
      f({ drop: undefined }),
    ];
    expect(incompleteFindings(invalid)).toEqual(invalid);
    const owners = ['client content', 'server content', 'data', 'resource', 'contract', 'design'].map((owner) => f({ owner }));
    expect(incompleteFindings([...owners, f({ id: null, severity: null, owner: null, why: null, drop: 'placeholder' })])).toEqual([]);
    expect(isSeverity('major')).toBe(true);
    expect(isSeverity('none')).toBe(false);
    expect(isSeverity(1)).toBe(false);
  });

  it('groups by id: highest severity, all evidence, first fields', () => {
    const groups = groupFindings([
      f({ id: 'a', severity: 'minor', what: 'first', evidence: ['e1'] }),
      f({ id: 'b', drop: 'dropped' }),
      f({ id: 'a', severity: 'blocker', what: 'second', evidence: ['e1', 'e2'] }),
      f({ id: 'a', severity: 'major', evidence: ['e3'] }),
    ]);
    expect([...groups.keys()]).toEqual(['a']);
    expect(groups.get('a')).toMatchObject({ severity: 'blocker', what: 'first', evidence: ['e1', 'e2', 'e3'] });
  });
});

describe('recordDefects', () => {
  it('opens new defects and orders by severity then finding order, then the rest', () => {
    const out = recordDefects({
      base: [d({ id: 'old', status: 'open' })],
      findings: [f({ id: 'm1', severity: 'minor' }), f({ id: 'b1', severity: 'blocker' }), f({ id: 'm2', severity: 'minor' }), f({ id: 'j', severity: 'major' })],
      confirmed: always,
      report: null,
    });
    expect(out.map((x) => [x.id, x.status])).toEqual([['b1', 'open'], ['j', 'open'], ['m1', 'open'], ['m2', 'open'], ['old', 'open']]);
  });

  it('confirms awaiting defects: found → open and counted, missing → fixed and reset', () => {
    const out = recordDefects({
      base: [d({ id: 'a', status: 'awaiting confirmation', repeatedDefect: 1 }), d({ id: 'b', status: 'awaiting confirmation', repeatedDefect: 2 })],
      findings: [f({ id: 'a', what: 'new what' })],
      confirmed: always,
      report: null,
    });
    expect(out.map((x) => [x.id, x.status, x.repeatedDefect, x.what])).toEqual([['a', 'open', 2, 'new what'], ['b', 'fixed', 0, 'x']]);
  });

  it('does not count resource defects and waits when the confirmation has not come', () => {
    const out = recordDefects({
      base: [d({ id: 'r', owner: 'resource', status: 'awaiting confirmation' }), d({ id: 'w', status: 'awaiting confirmation' })],
      findings: [f({ id: 'r', owner: 'resource' })],
      confirmed: (defect) => defect.id === 'r',
      report: null,
    });
    expect(out.map((x) => [x.id, x.status, x.repeatedDefect])).toEqual([['r', 'open', 0], ['w', 'awaiting confirmation', 0]]);
  });

  it('reopens fixed defects and keeps refused ones', () => {
    const out = recordDefects({
      base: [d({ id: 'f', status: 'fixed', oscillation: 1 }), d({ id: 'r', status: 'refused', refusedReason: 'brief' }), d({ id: 'g', status: 'fixed' })],
      findings: [f({ id: 'f' }), f({ id: 'r' })],
      confirmed: never,
      report: null,
    });
    expect(out.map((x) => [x.id, x.status, x.oscillation])).toEqual([['f', 'reopened', 2], ['r', 'refused', 0], ['g', 'fixed', 0]]);
  });

  it('applies the content agent report first, then confirms against this record', () => {
    const report = new Map([
      ['a', { result: 'fixed', note: '' }],
      ['b', { result: 'not reproduced', note: 'no repro' }],
      ['c', { result: 'refused', note: 'breaks brief' }],
      ['e', { result: 'refused', note: '' }],
      ['d', { result: 'not done', note: 'later' }],
    ]);
    const seen: string[] = [];
    const out = recordDefects({
      base: ['a', 'b', 'c', 'd', 'e'].map((id) => d({ id })),
      findings: [f({ id: 'a' }), f({ id: 'c' })],
      confirmed: (defect) => {
        seen.push(`${defect.id}:${defect.status}`);
        return true;
      },
      report,
    });
    expect(seen).toEqual(['a:awaiting confirmation', 'b:awaiting confirmation', 'c:refused', 'd:open', 'e:refused']);
    expect(out.map((x) => [x.id, x.status, x.refusedReason, x.repeatedDefect])).toEqual([
      ['a', 'open', null, 1],
      ['c', 'refused', 'breaks brief', 0],
      ['b', 'fixed', null, 0],
      ['d', 'open', null, 0],
      ['e', 'refused', null, 0],
    ]);
    const waiting = recordDefects({ base: [d({ id: 'a' })], findings: [], confirmed: never, report });
    expect(waiting.map((x) => x.status)).toEqual(['awaiting confirmation']);
    const noReport = recordDefects({ base: [d({ id: 'a' })], findings: [], confirmed: always, report: null });
    expect(noReport.map((x) => x.status)).toEqual(['open']);
  });

  it('does not change the base defects', () => {
    const base = [d({ status: 'fixed' })];
    recordDefects({ base, findings: [f({})], confirmed: always, report: null });
    expect(base[0]?.status).toBe('fixed');
  });
});

describe('defect helpers', () => {
  it('tells measure defects and renders rows', () => {
    const evidence = ['records/loops/r/measure-2.json#fps', 'records/loops/r/check-2.json#UI quality', 'shot.png', 'check-3.json', 'r/check-1.json#no blocker'];
    expect(evidenceMetrics({ evidence })).toEqual(['fps']);
    expect(evidenceChecks({ evidence })).toEqual(['UI quality', 'no blocker']);
    expect(defectRow(d({ evidence: ['a', 'b'] }))).toEqual(['a', 'minor', 'data', 'w', 'x', 'y', 'a, b', 'check', 'open']);
    expect(defectRow(d({ status: 'refused', refusedReason: 'why' }))[8]).toBe('refused (why)');
    expect(defectRow(d({ status: 'refused' }))[8]).toBe('refused');
  });
});

describe('confirmedBy', () => {
  const check = (result: 'pass' | 'fail' | 'unknown', name = 'performance'): CheckFile => ({
    commit: 'c',
    gate: 'pass',
    checks: [{ name, platform: 'web', result, failures: [], warnings: [] }, { name: 'other', platform: null, result: 'pass', failures: [], warnings: [] }],
  });
  const measure = (result: 'in' | 'out' | 'unknown', metric = 'fps'): MeasureFile => ({
    commit: 'c',
    targets: [{ metric, min: 0, max: 1, value: 1, result, data: null }, { metric: 'other', min: 0, max: 1, value: 1, result: 'in', data: null }],
  });
  const evaluate = (play: 'done' | 'failed', judge: 'done' | 'failed'): EvaluateFile => ({
    commit: 'c',
    baseline: null,
    kind: 'completeness',
    elements: [],
    measure: null,
    votes: null,
    vsBaseline: null,
    vsReference: 'pass',
    plays: [{ result: 'p', instance: 'i', platform: 'web', moment: null, status: play }],
    judges: [
      {
        kind: 'main',
        result: 'j',
        agent: { cli: 'claude-code', model: 'm', effort: 'high' },
        A: 'a',
        B: null,
        instanceSide: 'A',
        omittedMoments: [],
        votes: null,
        lostMoments: [],
        vsReference: 'pass',
        telemetry: null,
        status: judge,
      },
    ],
  });
  const none = { check: null, measure: null, evaluate: null };
  const checkDefect = d({ source: 'check', evidence: ['records/loops/r/check-1.json#performance'] });
  const measureDefect = d({ source: 'check', evidence: ['records/loops/r/measure-1.json#fps'] });

  it('confirms a check defect only when its check passed or failed', () => {
    expect(confirmedBy({ ...none, check: check('pass') }, false, checkDefect)).toBe(true);
    expect(confirmedBy({ ...none, check: check('fail') }, false, checkDefect)).toBe(true);
    expect(confirmedBy({ ...none, check: check('unknown') }, false, checkDefect)).toBe(false);
    expect(confirmedBy({ ...none, check: check('pass', 'UI quality') }, false, checkDefect)).toBe(false);
    expect(confirmedBy(none, false, checkDefect)).toBe(false);
    expect(confirmedBy({ ...none, check: check('pass') }, false, d({ source: 'check', evidence: ['x'] }))).toBe(false);
  });

  it('confirms a measure defect only when its metric was in or out', () => {
    expect(confirmedBy({ ...none, measure: measure('in') }, false, measureDefect)).toBe(true);
    expect(confirmedBy({ ...none, measure: measure('out') }, false, measureDefect)).toBe(true);
    expect(confirmedBy({ ...none, measure: measure('unknown') }, false, measureDefect)).toBe(false);
    expect(confirmedBy({ ...none, measure: measure('in', 'load') }, false, measureDefect)).toBe(false);
    expect(confirmedBy({ ...none, check: check('pass') }, false, measureDefect)).toBe(false);
  });

  it('confirms play and judge defects when one of that source is done, judge defects only in a completeness iteration, hardening defects only by hardening', () => {
    expect(confirmedBy({ ...none, evaluate: evaluate('done', 'failed') }, false, d({ source: 'play' }))).toBe(true);
    // a confirmation iteration takes only blocker play findings
    expect(confirmedBy({ ...none, evaluate: evaluate('done', 'failed') }, false, d({ source: 'play', severity: 'major' }), true)).toBe(false);
    expect(confirmedBy({ ...none, evaluate: evaluate('done', 'failed') }, false, d({ source: 'play', severity: 'blocker' }), true)).toBe(true);
    expect(confirmedBy({ ...none, evaluate: evaluate('done', 'done') }, false, d({ source: 'judge', severity: 'minor' }), true)).toBe(true);
    expect(confirmedBy({ ...none, evaluate: evaluate('failed', 'done') }, false, d({ source: 'play' }))).toBe(false);
    expect(confirmedBy({ ...none, evaluate: evaluate('failed', 'done') }, false, d({ source: 'judge' }))).toBe(true);
    expect(confirmedBy({ ...none, evaluate: evaluate('done', 'failed') }, false, d({ source: 'judge' }))).toBe(false);
    expect(confirmedBy(none, false, d({ source: 'judge' }))).toBe(false);
    // a fun iteration judges three elements without the reference game or moments: no result for a judge defect
    const fun = { ...evaluate('done', 'done'), kind: 'fun' as const };
    expect(confirmedBy({ ...none, evaluate: fun }, false, d({ source: 'judge' }))).toBe(false);
    expect(confirmedBy({ ...none, evaluate: fun }, false, d({ source: 'play' }))).toBe(true);
    expect(confirmedBy(none, true, d({ source: 'hardening' }))).toBe(true);
    expect(confirmedBy(none, false, d({ source: 'hardening' }))).toBe(false);
    expect(confirmedBy({ ...none, check: check('pass') }, true, checkDefect)).toBe(false);
  });
});
