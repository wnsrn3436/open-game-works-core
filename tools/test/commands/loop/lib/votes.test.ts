import { describe, expect, it } from 'vitest';
import type { Vote } from '../../../../src/commands/loop/lib/files.ts';
import { combinedVsBaseline, combinedVsReference, countVotes, quorum, type Voter } from '../../../../src/commands/loop/lib/votes.ts';

function voter(side: 'A' | 'B', votes: Record<string, Vote> | null): Voter {
  return { instanceSide: side, votes };
}

describe('votes', () => {
  it('needs two thirds of loop.judgeVotes rounded up, and at least 2', () => {
    expect([2, 3, 4, 5, 6, 7].map(quorum)).toEqual([2, 2, 3, 4, 4, 5]);
  });

  it('decides an element from judges of both side assignments', () => {
    const voters = [
      voter('A', { feel: 'this', flow: 'this', fail: 'baseline', none: null }),
      voter('B', { feel: 'this', flow: null, fail: 'baseline', none: null }),
      voter('A', { feel: 'this', flow: 'this', fail: 'baseline', none: null }),
    ];
    expect(countVotes(voters, ['feel', 'flow', 'fail', 'none'], 3)).toEqual([
      { element: 'feel', this: 3, baseline: 0, decision: 'this' },
      // two votes, both from side A judges
      { element: 'flow', this: 2, baseline: 0, decision: 'indistinguishable' },
      { element: 'fail', this: 0, baseline: 3, decision: 'baseline' },
      { element: 'none', this: 0, baseline: 0, decision: 'indistinguishable' },
    ]);
  });

  it('is uncertain with votes both ways, short of the quorum without, and a failed judge gives no vote', () => {
    const voters = [voter('A', { feel: 'this', flow: 'this' }), voter('B', { feel: 'baseline', flow: 'this' }), voter('A', null), voter('B', null)];
    expect(countVotes(voters, ['feel', 'flow'], 4)).toEqual([
      { element: 'feel', this: 1, baseline: 1, decision: 'uncertain' },
      { element: 'flow', this: 2, baseline: 0, decision: 'indistinguishable' },
    ]);
    expect(countVotes(voters.slice(0, 2), ['flow'], 2)[0]?.decision).toBe('this');
  });

  it('combines vs baseline and vs reference', () => {
    const decided = (...decisions: ('this' | 'baseline' | 'uncertain' | 'indistinguishable')[]) => decisions.map((decision, i) => ({ element: String(i), this: 0, baseline: 0, decision }));
    expect(combinedVsBaseline(decided('this', 'uncertain'), false)).toBe('better');
    expect(combinedVsBaseline(decided('this'), true)).toBe('indistinguishable');
    expect(combinedVsBaseline(decided('this', 'baseline'), false)).toBe('indistinguishable');
    expect(combinedVsBaseline(decided('baseline', 'uncertain'), false)).toBe('worse');
    expect(combinedVsBaseline(decided('uncertain'), false)).toBe('indistinguishable');
    expect(combinedVsReference([{ status: 'done', vsReference: 'pass' }, { status: 'failed', vsReference: 'unknown' }])).toBe('pass');
    expect(combinedVsReference([{ status: 'done', vsReference: 'pass' }, { status: 'done', vsReference: 'unknown' }])).toBe('unknown');
    expect(combinedVsReference([{ status: 'done', vsReference: 'unknown' }, { status: 'done', vsReference: 'fail' }])).toBe('fail');
    expect(combinedVsReference([{ status: 'failed', vsReference: 'unknown' }])).toBe('unknown');
  });
});
