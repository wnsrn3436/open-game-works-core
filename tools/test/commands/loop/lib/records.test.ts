import { describe, expect, it } from 'vitest';
import { baselineFrom } from '../../../../src/commands/loop/lib/baseline.ts';
import type { Defect, DefectsFile } from '../../../../src/commands/loop/lib/defects.ts';
import { checkNames, checkResult, gateOf, successPrecondition, type CheckFile, type JudgeEntry } from '../../../../src/commands/loop/lib/files.ts';
import { gatePassed, mainJudges, parseIterationRecord, renderIterationRecord, type IterationRecordData, type ParsedJudge, type ParsedRecord } from '../../../../src/commands/loop/lib/iteration-record.ts';
import { newRunState } from '../../../../src/lib/runstate.ts';
import { candidateEvidence, confirmEvidence, verdict, type VerdictInput } from '../../../../src/commands/loop/lib/verdict.ts';
import type { CheckResult } from '../../../../src/commands/check/api.ts';

function check(results: Record<string, 'pass' | 'fail' | 'unknown'>): CheckFile {
  const checks: CheckResult[] = Object.entries(results).map(([name, result]) => ({ name, platform: null, result, failures: [], warnings: [] }));
  return { commit: 'c1', checks, gate: 'pass' };
}

const ALL_PASS = {
  'regression test': 'pass',
  'static check': 'pass',
  'no blocker': 'pass',
  'full flow': 'pass',
  performance: 'pass',
  'UI quality': 'pass',
  'no placeholder': 'pass',
} as const;

describe('check file', () => {
  it('reduces items per check and computes gate and completeness', () => {
    const file = check(ALL_PASS);
    file.checks.push({ name: 'performance', platform: 'web', result: 'unknown', failures: [], warnings: [] });
    expect(checkResult(file, 'performance')).toBe('unknown');
    expect(checkResult(file, 'row simulation')).toBe('unknown');
    expect(gateOf(file)).toBe('pass');
    const passing = { kind: 'completeness', vsBaseline: 'better', vsReference: 'pass' } as const;
    expect(successPrecondition(passing, (name) => checkResult(file, name))).toBe(false);
    file.checks.push({ name: 'performance', platform: 'ios', result: 'fail', failures: [], warnings: [] });
    expect(checkResult(file, 'performance')).toBe('fail');
    expect(gateOf({ ...check(ALL_PASS), gate: 'fail' })).toBe('fail');
    expect(gateOf({ commit: 'c', checks: [] } as unknown as CheckFile)).toBeNull();
    expect(gateOf({ ...check({}), gate: 'unknown' } as unknown as CheckFile)).toBeNull();
    expect(successPrecondition(passing, (name) => checkResult(check(ALL_PASS), name))).toBe(true);
    // a fun iteration is never a candidate iteration
    expect(successPrecondition({ ...passing, kind: 'fun' }, () => 'pass')).toBe(false);
    expect(successPrecondition({ ...passing, vsReference: null }, () => 'pass')).toBe(false);
    expect(successPrecondition({ ...passing, vsBaseline: null }, () => 'pass')).toBe(true);
    expect(successPrecondition({ ...passing, vsBaseline: 'worse' }, () => 'pass')).toBe(false);
    expect(successPrecondition({ ...passing, vsReference: 'unknown' }, () => 'pass')).toBe(false);
    expect(checkNames({ commit: 'c', gate: 'fail', checks: [...check({ custom: 'pass', 'UI quality': 'pass', 'regression test': 'fail' }).checks] })).toEqual([
      'regression test',
      'UI quality',
      'custom',
    ]);
  });
});

function judgeEntry(fields: Partial<JudgeEntry>): JudgeEntry {
  return {
    kind: 'main',
    result: 'records/loops/r/judge-1-1.md',
    agent: { cli: 'claude-code', model: 'm1', effort: 'high' },
    A: 'c1',
    B: 'b0',
    instanceSide: 'A',
    omittedMoments: [],
    votes: null,
    lostMoments: [],
    vsReference: 'pass',
    telemetry: null,
    status: 'done',
    ...fields,
  };
}

const DATA: IterationRecordData = {
  commit: 'c1',
  baseline: 'b0',
  confirms: null,
  kind: 'completeness',
  checks: [{ name: 'regression test', result: 'pass', path: 'p' }, { name: 'static check', result: 'pass', path: 'p' }, { name: 'no blocker', result: 'pass', path: 'p' }, { name: 'full flow', result: 'pass', path: 'p' }],
  judges: [
    { ...judgeEntry({ omittedMoments: ['boss'] }), moments: '`A` wins', loserBetter: '' },
    { ...judgeEntry({ kind: 'success', B: null, agent: { cli: 'codex', model: 'm2', effort: 'medium' }, vsReference: 'unknown', status: 'failed' }), moments: '', loserBetter: 'x' },
  ],
  votes: {
    vsBaseline: 'better',
    vsReference: 'pass',
    elements: [
      { element: 'game feel', this: 2, baseline: 0, decision: 'this' },
      { element: 'no friction', this: 1, baseline: 1, decision: 'uncertain' },
    ],
  },
  plays: [{ result: 'records/loops/r/play-1-1.md', counts: { blocker: 1, major: 0, minor: 2, none: 3 } }],
  defects: [],
  measurements: [{ metric: 'fps', min: 30, max: 60, value: null, result: 'unknown', data: null }],
  load: [{ platform: 'web', hostLoad: { cpuMaxPercent: 99 } }],
  temporary: ['icon/a', 'image/b'],
};

describe('iteration record', () => {
  it('renders every heading in order and parses back', () => {
    const text = renderIterationRecord(DATA);
    expect(text.match(/^## .+$/gm)).toEqual(['## commit', '## checks', '## judge', '## votes', '## play', '## defects', '## measurements', '## load', '## temporary resources']);
    expect(text).toContain('- confirms: none\n- kind: completeness\n');
    expect(text).toContain('- status: done\n- agent: claude-code m1 high\n- A: c1\n- B: b0\n- vs reference: pass\n- omitted moments: boss\n');
    expect(text).toContain('- agent: codex m2 medium\n');
    expect(text).toContain(
      '## votes\n\n- vs baseline: better\n- vs reference: pass\n\n| element | this | baseline | decision |\n|---|---|---|---|\n| game feel | 2 | 0 | this |\n| no friction | 1 | 1 | uncertain |\n',
    );
    expect(text).toContain('## temporary resources\n\n- `icon/a`\n- `image/b`\n');
    expect(text).toContain('- omitted moments: boss');
    expect(text).toContain('| records/loops/r/play-1-1.md | 1 | 0 | 2 | 3 |');
    expect(text).toContain('| fps | none | 30..60 | unknown |');
    expect(text).toContain('| web | {"cpuMaxPercent":99} |');
    expect(text).toContain('#### loser better\n\nnone');
    const parsed = parseIterationRecord(text, 1, 'p1');
    expect(parsed.commit).toBe('c1');
    expect(parsed.baseline).toBe(DATA.baseline);
    expect(parsed.checks.get('full flow')).toBe('pass');
    expect(parsed.judges).toEqual([
      { result: 'records/loops/r/judge-1-1.md', kind: 'main', status: 'done', vsBaseline: null, vsReference: 'pass' },
      { result: 'records/loops/r/judge-1-1.md', kind: 'success', status: 'failed', vsBaseline: null, vsReference: 'unknown' },
    ]);
    expect(gatePassed(parsed)).toBe(true);
    expect(parsed).toMatchObject({ kind: 'completeness', vsBaseline: 'better', vsReference: 'pass' });
    expect(mainJudges(parsed).map((j) => j.kind)).toEqual(['main']);
    // a fun iteration: its kind, no vs reference
    const fun = parseIterationRecord(
      renderIterationRecord({ ...DATA, kind: 'fun', votes: { vsBaseline: 'indistinguishable', vsReference: null, elements: [] } }),
      2,
      'p2',
    );
    expect(fun).toMatchObject({ kind: 'fun', vsBaseline: 'indistinguishable', vsReference: null });
    // no baseline game: `## votes` is none and vs reference comes from the step 4 judge
    const alone = parseIterationRecord(renderIterationRecord({ ...DATA, votes: null }), 1, 'p1');
    expect(renderIterationRecord({ ...DATA, votes: null })).toContain('## votes\n\nnone\n');
    expect(alone).toMatchObject({ vsBaseline: null, vsReference: 'pass' });
    // a record without a kind line is of a completeness iteration
    expect(parseIterationRecord('## commit\n\n- instance: c\n', 1, 'p').kind).toBe('completeness');
    expect(parsed.confirms).toBeNull();
    expect(parsed.playBlockers).toBe(1);
    const confirming = parseIterationRecord(renderIterationRecord({ ...DATA, confirms: 3 }), 4, 'p4');
    expect(confirming.confirms).toBe(3);
  });

  it('writes none for steps that did not run', () => {
    const text = renderIterationRecord({ ...DATA, commit: null, checks: [], judges: null, votes: null, plays: null, measurements: null, load: null, temporary: [] });
    expect(text).toBe(
      '## commit\n\n- instance: none\n- baseline: b0\n- confirms: none\n- kind: completeness\n\n## checks\n\nnone\n\n## judge\n\nnone\n\n## votes\n\nnone\n\n## play\n\nnone\n\n## defects\n\nnone\n\n## measurements\n\nnone\n\n## load\n\nnone\n\n## temporary resources\n\nnone\n',
    );
    const parsed = parseIterationRecord(text, 2, 'p');
    expect(parsed).toMatchObject({ commit: null, judges: null, confirms: null, playBlockers: 0, vsBaseline: null, vsReference: null });
    expect(mainJudges(parsed)).toEqual([]);
    expect(gatePassed(parsed)).toBe(false);
    expect(parseIterationRecord('', 1, 'p').checks.size).toBe(0);
  });
});

type Vs = 'better' | 'worse' | 'indistinguishable' | null;

function record(iteration: number, commit: string | null, gate: boolean, vsBaseline: Vs | undefined): ParsedRecord {
  const checks = new Map<string, string>(['regression test', 'static check', 'no blocker', 'full flow'].map((n) => [n, gate ? 'pass' : 'fail']));
  const judges: ParsedRecord['judges'] = vsBaseline === undefined ? null : [{ result: 'j', kind: 'main', status: 'done', vsBaseline: null, vsReference: 'pass' }];
  return { iteration, path: `p${String(iteration)}`, commit, baseline: null, confirms: null, kind: 'completeness', checks, judges, vsBaseline: vsBaseline ?? null, vsReference: 'pass', playBlockers: 0 };
}

function judged(vs: Vs): Vs {
  return vs;
}

describe('baseline', () => {
  it('starts at none for create and at the base commit for update', () => {
    const create = newRunState({ name: 'r', kind: 'loop', command: 'create', branch: 'b', baseCommit: 'base' });
    const update = newRunState({ name: 'r', kind: 'loop', command: 'update', branch: 'b', baseCommit: 'base' });
    expect(baselineFrom(create, [])).toBeNull();
    expect(baselineFrom(update, [])).toBe('base');
    const records = [record(1, 'c1', false, undefined), record(2, 'c2', true, judged(null)), record(3, 'c3', true, judged('indistinguishable')), record(4, 'c4', true, judged('better')), record(5, null, true, judged('better'))];
    expect(baselineFrom(create, records)).toBe('c4');
    expect(baselineFrom(create, records.slice(0, 3))).toBe('c2');
    expect(baselineFrom(update, records.slice(0, 3))).toBe('base');
  });
});

function defects(list: Partial<Defect>[]): DefectsFile {
  return {
    defects: list.map((x) => ({ id: 'a', severity: 'minor', owner: 'data', where: '', what: '', why: '', evidence: [], source: 'check', status: 'open', refusedReason: null, repeatedDefect: 0, oscillation: 0, ...x })),
    previous: null,
    recordedBy: 'iteration-1',
  };
}

function successRecord(iteration: number, judges: Partial<ParsedJudge>[], checks: Record<string, string> = ALL_PASS, together: Partial<ParsedRecord> = {}): ParsedRecord {
  return {
    iteration,
    path: `p${String(iteration)}`,
    commit: 'c1',
    baseline: null,
    confirms: null,
    kind: 'completeness',
    checks: new Map(Object.entries(checks)),
    judges: judges.map((j) => ({ result: 'records/loops/r/judge-2-1.md', kind: 'main', status: 'done', vsBaseline: null, vsReference: 'pass', ...j })),
    vsBaseline: 'better',
    vsReference: 'pass',
    playBlockers: 0,
    ...together,
  };
}

describe('verdict', () => {
  const base: VerdictInput = {
    iteration: 2,
    limit: 5,
    loopStop: { repeatedDefect: 3, oscillation: 2, plateau: 2, successJudges: 2 },
    records: [],
    checkPath: 'records/loops/r/check-2.json',
    defects: null,
    unhandled: [],
  };
  const passing = [{ result: 'records/loops/r/judge-2-1.md' }, { result: 'records/loops/r/judge-2-2.md' }, { kind: 'success', result: 's1' }, { kind: 'success', result: 's2' }];
  const success = [successRecord(2, passing, ALL_PASS, { vsBaseline: 'indistinguishable' })];

  it('gives success from the record of this iteration with its evidence', () => {
    expect(verdict({ ...base, records: success })).toEqual({
      reason: 'success',
      evidence: ['records/loops/r/judge-2-1.md', 'records/loops/r/judge-2-2.md', 's1', 's2', 'records/loops/r/check-2.json'],
    });
    // the record of an earlier iteration does not give success
    expect(verdict({ ...base, iteration: 3, records: success }).reason).toBe('continue');
    expect(verdict({ ...base, records: [successRecord(2, passing, ALL_PASS, { vsBaseline: null })] }).reason).toBe('success');
    // a fun iteration is not a candidate iteration
    expect(verdict({ ...base, records: [successRecord(2, passing, ALL_PASS, { kind: 'fun' })] }).reason).toBe('continue');
  });

  it('is not success when a condition fails', () => {
    const fewer = [{}, { kind: 'success' }];
    const failedSuccess = [{}, { kind: 'success' }, { kind: 'success', vsReference: 'unknown' as const }];
    const noMain = [{ kind: 'success' }, { kind: 'success' }];
    for (const judges of [fewer, failedSuccess, noMain, []]) expect(verdict({ ...base, records: [successRecord(2, judges)] }).reason).toBe('continue');
    const all = [{}, { kind: 'success' }, { kind: 'success' }];
    for (const together of [{ vsBaseline: 'worse' as const }, { vsReference: 'fail' as const }, { vsReference: null }]) {
      expect(verdict({ ...base, records: [successRecord(2, all, ALL_PASS, together)] }).reason).toBe('continue');
    }
    expect(verdict({ ...base, records: [successRecord(2, passing, { ...ALL_PASS, 'UI quality': 'fail' })] }).reason).toBe('continue');
    const noPerformance: Record<string, string> = { ...ALL_PASS };
    delete noPerformance.performance;
    expect(verdict({ ...base, records: [successRecord(2, passing, noPerformance)] }).reason).toBe('continue');
    expect(verdict({ ...base, records: [{ ...successRecord(2, []), judges: null }] }).reason).toBe('continue');
  });

  it('does not look at no placeholder: a candidate iteration with no unhandled worker job is success', () => {
    expect(verdict({ ...base, records: [successRecord(2, passing, { ...ALL_PASS, 'no placeholder': 'fail' })] }).reason).toBe('success');
  });

  it('gives confirm for a candidate iteration with unhandled worker jobs, after the stop reasons', () => {
    const unhandled = ['job-r', 'job-t'];
    expect(verdict({ ...base, records: success, unhandled })).toEqual({
      reason: 'confirm',
      evidence: ['records/loops/r/judge-2-1.md', 'records/loops/r/judge-2-2.md', 's1', 's2', 'unhandled worker job job-r', 'unhandled worker job job-t'],
    });
    expect(verdict({ ...base, records: success, unhandled, defects: defects([{ id: 'x', repeatedDefect: 3 }]) }).reason).toBe('repeated defect');
    expect(verdict({ ...base, iteration: 5, records: [successRecord(5, passing)], unhandled }).reason).toBe('limit reached');
    expect(verdict({ ...base, records: [successRecord(2, [{}], ALL_PASS, { vsReference: 'fail' })], unhandled }).reason).toBe('continue');
  });

  it('passes a confirmation iteration with the candidate conditions and no play blocker', () => {
    const confirming = (fields: Partial<ParsedRecord>): ParsedRecord => ({ ...successRecord(3, passing, { ...ALL_PASS, 'no placeholder': 'fail' }), confirms: 2, ...fields });
    const input = { ...base, iteration: 3 };
    expect(verdict({ ...input, records: [confirming({})] }).reason).toBe('success');
    expect(verdict({ ...input, records: [confirming({})], unhandled: ['job-r'] }).reason).toBe('confirm');
    expect(verdict({ ...input, records: [confirming({ playBlockers: 1 })] }).reason).toBe('continue');
    expect(verdict({ ...input, records: [{ ...confirming({}), checks: new Map(Object.entries({ ...ALL_PASS, 'full flow': 'fail' })) }] }).reason).toBe('continue');
    // a confirmation iteration is never a candidate iteration, and a candidate is never a passed confirmation
    expect(candidateEvidence(confirming({}), base.loopStop)).toBeNull();
    expect(confirmEvidence(successRecord(2, passing), base.loopStop)).toBeNull();
  });

  it('does not count confirmation iterations in plateau', () => {
    const records = [record(1, 'c1', true, judged('better')), record(2, 'c2', true, judged('indistinguishable')), { ...record(3, 'c3', true, judged('indistinguishable')), confirms: 2 }];
    expect(verdict({ ...base, iteration: 3, records }).reason).toBe('continue');
    expect(verdict({ ...base, iteration: 4, records: [...records, record(4, 'c4', true, judged('worse'))] })).toEqual({ reason: 'plateau', evidence: ['2', '4'] });
  });

  it('gives repeated defect and oscillation from the counts, and does not count resource defects as repeated', () => {
    expect(verdict({ ...base, defects: defects([{ id: 'x', repeatedDefect: 3 }, { id: 'y', repeatedDefect: 2 }]) })).toEqual({ reason: 'repeated defect', evidence: ['x 3'] });
    expect(verdict({ ...base, defects: defects([{ id: 'z', oscillation: 2 }]) })).toEqual({ reason: 'oscillation', evidence: ['z 2'] });
    expect(verdict({ ...base, defects: defects([{ id: 'z', oscillation: 1, repeatedDefect: 2 }]) }).reason).toBe('continue');
    expect(verdict({ ...base, defects: defects([{ id: 'r', owner: 'resource', repeatedDefect: 3 }]) }).reason).toBe('continue');
    expect(verdict({ ...base, defects: defects([{ id: 'r', owner: 'resource', repeatedDefect: 3, oscillation: 2 }]) })).toEqual({ reason: 'oscillation', evidence: ['r 2'] });
  });

  it('gives plateau from the trailing not-better iterations with a vs baseline', () => {
    const records = [record(1, 'c1', true, judged('better')), record(2, 'c2', true, judged('worse')), record(3, 'c3', true, judged(null)), record(4, 'c4', true, judged('indistinguishable'))];
    expect(verdict({ ...base, iteration: 4, records })).toEqual({ reason: 'plateau', evidence: ['2', '4'] });
    expect(verdict({ ...base, iteration: 4, records: records.slice(0, 2) }).reason).toBe('continue');
    expect(verdict({ ...base, iteration: 1, records }).reason).toBe('continue');
  });

  it('gives limit reached', () => {
    expect(verdict({ ...base, iteration: 5 })).toEqual({ reason: 'limit reached', evidence: ['iteration 5', 'limit 5'] });
    expect(verdict({ ...base, iteration: 4 }).reason).toBe('continue');
  });

  it('stops by the reason higher in the table when two hold', () => {
    const plateauRecords = [record(4, 'c4', true, judged('worse')), record(5, 'c5', true, judged('indistinguishable'))];
    // success over repeated defect
    expect(verdict({ ...base, records: success, defects: defects([{ repeatedDefect: 9 }]) }).reason).toBe('success');
    // repeated defect over oscillation
    expect(verdict({ ...base, defects: defects([{ id: 'x', repeatedDefect: 3, oscillation: 2 }]) })).toEqual({ reason: 'repeated defect', evidence: ['x 3'] });
    // oscillation over plateau
    expect(verdict({ ...base, iteration: 5, records: plateauRecords, defects: defects([{ id: 'z', oscillation: 2 }]) }).reason).toBe('oscillation');
    // plateau over limit reached
    expect(verdict({ ...base, iteration: 5, records: plateauRecords })).toEqual({ reason: 'plateau', evidence: ['4', '5'] });
  });
});
