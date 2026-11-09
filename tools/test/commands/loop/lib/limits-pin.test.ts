import { describe, expect, it } from 'vitest';
import type { Defect, DefectsFile } from '../../../../src/commands/loop/lib/defects.ts';
import { changedRunUnits, harnessLine, harnessPins, pinHarness, pinnedHarness, pinnedRunSettings, repinLines, requirePinned, runSettingsLines } from '../../../../src/commands/loop/lib/harness-pin.ts';
import type { ParsedRecord } from '../../../../src/commands/loop/lib/iteration-record.ts';
import { givenLimits, iterationLimit, LIMIT_OPTIONS, runLimits, setRunLimits } from '../../../../src/commands/loop/lib/run-limits.ts';
import { blockingDefects, verdict, type VerdictInput } from '../../../../src/commands/loop/lib/verdict.ts';
import { parseTokens } from '../../../../src/lib/command.ts';
import { newRunState, type RunState } from '../../../../src/lib/runstate.ts';

const CHECKS = ['regression test', 'static check', 'no blocker', 'full flow', 'UI quality', 'no placeholder'];

/** The record of a candidate iteration: every check passes, its step 4 judge and its success judge pass. */
function candidate(iteration: number, fields: Partial<ParsedRecord> = {}): ParsedRecord {
  return {
    iteration,
    path: `p${String(iteration)}`,
    commit: `c${String(iteration)}`,
    baseline: null,
    confirms: null,
    kind: 'completeness',
    checks: new Map(CHECKS.map((name) => [name, 'pass'])),
    judges: [
      { result: 'main-1', kind: 'main', status: 'done', vsBaseline: null, vsReference: 'pass' },
      { result: 'success-1', kind: 'success', status: 'done', vsBaseline: null, vsReference: 'pass' },
    ],
    vsBaseline: 'better',
    vsReference: 'pass',
    playBlockers: 0,
    ...fields,
  };
}

function defectsOf(list: Partial<Defect>[]): DefectsFile {
  return {
    defects: list.map((x) => ({
      id: 'd', severity: 'major', owner: 'design', where: '', what: '', why: '', evidence: [], source: 'judge', status: 'open', refusedReason: null, repeatedDefect: 0, oscillation: 0, ...x,
    })),
    previous: null,
    recordedBy: 'iteration-2',
  };
}

const base: VerdictInput = {
  iteration: 2,
  limit: 9,
  loopStop: { repeatedDefect: 3, oscillation: 2, plateau: 5, successJudges: 1 },
  records: [candidate(2)],
  checkPath: 'check-2.json',
  defects: null,
  unhandled: [],
};

describe('success and blocking defects', () => {
  it('blocks a candidate iteration while a blocker or major defect is open, reopened or awaiting confirmation', () => {
    expect(verdict(base)).toEqual({ reason: 'success', evidence: ['main-1', 'success-1', 'check-2.json'] });
    expect(verdict({ ...base, defects: defectsOf([{ id: 'shop-crash' }]) })).toEqual({ reason: 'continue', evidence: [], blockedBy: ['shop-crash'] });
    const three = defectsOf([
      { id: 'a', severity: 'blocker', status: 'reopened' },
      { id: 'b', status: 'awaiting confirmation' },
      { id: 'c', severity: 'blocker', status: 'open' },
    ]);
    expect(verdict({ ...base, defects: three }).blockedBy).toEqual(['a', 'b', 'c']);
  });

  it('is not blocked by a refused or fixed major defect, or by an open minor defect', () => {
    const clean = defectsOf([
      { id: 'r', status: 'refused', refusedReason: 'keeps the brief' },
      { id: 'f', severity: 'blocker', status: 'fixed' },
      { id: 'm', severity: 'minor', status: 'open' },
      { id: 'n', severity: 'minor', status: 'reopened' },
    ]);
    expect(blockingDefects(clean)).toEqual([]);
    expect(verdict({ ...base, defects: clean })).toEqual({ reason: 'success', evidence: ['main-1', 'success-1', 'check-2.json'] });
  });

  it('gives continue, not confirm, for a blocked candidate with unhandled worker jobs, and keeps the ids with a stop reason', () => {
    const major = defectsOf([{ id: 'shop-crash' }]);
    expect(verdict({ ...base, unhandled: ['job-r'] }).reason).toBe('confirm');
    expect(verdict({ ...base, unhandled: ['job-r'], defects: major })).toEqual({ reason: 'continue', evidence: [], blockedBy: ['shop-crash'] });
    expect(verdict({ ...base, limit: 2, defects: major })).toEqual({
      reason: 'limit reached',
      evidence: ['iteration 2 reached game settings loopIterationLimit 2'],
      blockedBy: ['shop-crash'],
    });
  });

  it('blocks a passed confirmation iteration the same way', () => {
    const confirming = { ...base, iteration: 3, records: [candidate(3, { confirms: 2 })] };
    expect(verdict(confirming).reason).toBe('success');
    expect(verdict({ ...confirming, defects: defectsOf([{ id: 'boss-softlock', severity: 'blocker' }]) })).toEqual({
      reason: 'continue',
      evidence: [],
      blockedBy: ['boss-softlock'],
    });
  });

  it('has no success blocked by for an iteration that is not a candidate iteration', () => {
    const notCandidate = { ...base, records: [candidate(2, { vsReference: 'fail' })], defects: defectsOf([{ id: 'shop-crash' }]) };
    expect(verdict(notCandidate)).toEqual({ reason: 'continue', evidence: [] });
  });
});

describe('limit reached', () => {
  const plain = { ...base, records: [] };

  it('stops at the smaller of the run --limit and loopIterationLimit, and names it', () => {
    expect(verdict({ ...plain, iteration: 2, runLimit: 2 })).toEqual({ reason: 'limit reached', evidence: ['iteration 2 reached --limit 2'] });
    expect(verdict({ ...plain, iteration: 1, runLimit: 2 }).reason).toBe('continue');
    expect(verdict({ ...plain, iteration: 9, runLimit: 12 })).toEqual({ reason: 'limit reached', evidence: ['iteration 9 reached game settings loopIterationLimit 9'] });
    expect(verdict({ ...plain, iteration: 8, runLimit: 12 }).reason).toBe('continue');
    expect(verdict({ ...plain, iteration: 9, runLimit: 9 }).evidence).toEqual(['iteration 9 reached --limit 9']);
  });

  it('stops once the current time has reached --until', () => {
    expect(verdict({ ...plain, until: 1000, now: 999 }).reason).toBe('continue');
    expect(verdict({ ...plain, until: 1000, now: 1000 })).toEqual({ reason: 'limit reached', evidence: ['now 1000 reached --until 1000'] });
    expect(verdict({ ...plain, iteration: 3, runLimit: 3, until: 1000, now: 4000 }).evidence).toEqual(['iteration 3 reached --limit 3', 'now 4000 reached --until 1000']);
    // a success comes before the time limit
    expect(verdict({ ...base, until: 1000, now: 4000 }).reason).toBe('success');
  });
});

function loopRun(): RunState {
  return newRunState({ name: 'update-1', kind: 'loop', command: 'update', branch: 'loop/update-1', baseCommit: 'base' });
}

describe('run limits', () => {
  const parse = (...tokens: string[]): ReturnType<typeof givenLimits> => givenLimits(parseTokens(tokens, LIMIT_OPTIONS), 1000);

  it('takes an iteration count of 1 or more and a Unix ms later than now', () => {
    expect(parse()).toEqual({});
    expect(parse('--limit', '3', '--until', '5000')).toEqual({ iterations: 3, until: 5000 });
    expect(() => parse('--limit', '0')).toThrow('invalid --limit: 0');
    expect(() => parse('--limit', 'two')).toThrow('invalid --limit: two');
    expect(() => parse('--until', '1000')).toThrow('invalid --until: 1000 is not later than now (1000)');
    expect(() => parse('--until', '1.5')).toThrow('invalid --until: 1.5');
  });

  it('replaces only the limits given, and takes the smaller iteration limit', () => {
    const run = loopRun();
    expect(runLimits(run)).toEqual({ iterations: null, until: null });
    expect(iterationLimit(run, 20)).toEqual({ limit: 20, by: 'game settings loopIterationLimit' });
    setRunLimits(run, { iterations: 4, until: 9000 });
    setRunLimits(run, { until: 12000 });
    expect(runLimits(run)).toEqual({ iterations: 4, until: 12000 });
    expect(iterationLimit(run, 20)).toEqual({ limit: 4, by: '--limit' });
    expect(iterationLimit(run, 3)).toEqual({ limit: 3, by: 'game settings loopIterationLimit' });
  });
});

describe('harness pin', () => {
  const S = { loop: { funIterations: 3 } };

  it('writes the pinned commit of each iteration and the repin in the iteration it counts for', () => {
    const run = loopRun();
    expect(pinnedHarness(run)).toBeNull();
    // a run without a pin (a build run) writes the harness repo HEAD
    expect(harnessLine(run, 1, 'head')).toBe('head');
    pinHarness(run, 'old', S, 0);
    expect(harnessLine(run, 1, 'head')).toBe('old');
    pinHarness(run, 'new', S, 2);
    pinHarness(run, 'new', S, 3);
    expect(harnessPins(run)).toEqual([{ commit: 'old', iteration: 0, runSettings: S }, { commit: 'new', iteration: 2, runSettings: S }]);
    expect(pinnedHarness(run)).toBe('new');
    expect([1, 2, 3].map((n) => harnessLine(run, n, 'head'))).toEqual(['old', 'new (repinned from old)', 'new']);
  });

  it('fails naming both commits while the harness repo HEAD is not the pinned commit', () => {
    const run = loopRun();
    requirePinned(run, 'any');
    pinHarness(run, 'old', S, 0);
    requirePinned(run, 'old');
    expect(() => {
      requirePinned(run, 'new');
    }).toThrow('harness repo HEAD new is not the pinned harness commit old of run update-1: give --repin to pin new');
  });

  it('repins run settings that changed under the same commit, naming the units that changed', () => {
    const run = loopRun();
    const first = { agents: { content: { model: 'a', effort: 'high' } }, loop: { funIterations: 3, judgePanel: [] } };
    expect(pinHarness(run, 'c', first, 0)).toEqual({ commit: null, units: [] });
    expect(pinnedRunSettings(run)).toEqual(first);
    expect(pinHarness(run, 'c', structuredClone(first), 2)).toBeNull();
    const second = { agents: { content: { model: 'b', effort: 'high' }, judge: { model: 'x', effort: 'y' } }, loop: { funIterations: 3, judgePanel: [{ model: 'm', effort: 'e' }] } };
    const repin = pinHarness(run, 'c', second, 2);
    expect(repin).toEqual({ commit: null, units: ['agents.content.model', 'agents.judge.model', 'agents.judge.effort', 'loop.judgePanel'] });
    expect(repinLines(repin, ', counts for iteration 2')).toEqual(['run settings: agents.content.model, agents.judge.model, agents.judge.effort, loop.judgePanel (repinned), counts for iteration 2']);
    expect(pinnedRunSettings(run)).toEqual(second);
    // the harness commit of the iteration did not change
    expect(harnessLine(run, 2, 'head')).toBe('c');
    const third = pinHarness(run, 'd', { agents: { content: second.agents.content }, loop: second.loop }, 3);
    expect(repinLines(third)).toEqual(['harness: d (repinned from c)', 'run settings: agents.judge.model, agents.judge.effort (repinned)']);
    expect(changedRunUnits({ a: [1] }, { a: [1, 2], b: 1 })).toEqual([['a'], ['b']]);
    expect(changedRunUnits(null, { a: { b: 1 } })).toEqual([['a', 'b']]);
  });

  it('gives the run settings of each pin that changed them for the loop end record', () => {
    const run = loopRun();
    expect(runSettingsLines(run)).toEqual([]);
    pinHarness(run, 'old', { playInstances: 3, loop: { judgePanel: [], variants: 1 } }, 0);
    pinHarness(run, 'new', { playInstances: 3, loop: { judgePanel: [], variants: 1 } }, 2);
    pinHarness(run, 'new', { playInstances: 2, loop: { judgePanel: [] } }, 4);
    expect(runSettingsLines(run)).toEqual([
      '- iteration 0:',
      '  - playInstances: 3',
      '  - loop.judgePanel: []',
      '  - loop.variants: 1',
      '- iteration 4:',
      '  - playInstances: 2',
      '  - loop.variants: none',
    ]);
  });
});
