import type { ElementDecision, ElementVotes, JudgeEntry, Vote, VsBaseline, VsReference } from './files.ts';

/** Votes a decision needs (`game-loop` `## iteration` 4): two thirds of `loop.judgeVotes` rounded up, and at least 2. */
export function quorum(judgeVotes: number): number {
  return Math.max(2, Math.ceil((2 * judgeVotes) / 3));
}

/** A step 4 judge as the votes see it: its side assignment and its votes (null for a failed judge). */
export type Voter = Pick<JudgeEntry, 'instanceSide' | 'votes'>;

function decide(element: string, voters: readonly Voter[], need: number): ElementVotes {
  const sides: Record<'this' | 'baseline', Set<'A' | 'B'>> = { this: new Set(), baseline: new Set() };
  const counts = { this: 0, baseline: 0 };
  for (const voter of voters) {
    const vote: Vote = voter.votes?.[element] ?? null;
    if (vote === null) continue;
    counts[vote]++;
    sides[vote].add(voter.instanceSide);
  }
  const wins = (vote: 'this' | 'baseline', other: 'this' | 'baseline'): boolean =>
    counts[other] === 0 && counts[vote] >= need && sides[vote].size === 2;
  let decision: ElementDecision = 'indistinguishable';
  if (counts.this > 0 && counts.baseline > 0) decision = 'uncertain';
  else if (wins('this', 'baseline')) decision = 'this';
  else if (wins('baseline', 'this')) decision = 'baseline';
  return { element, this: counts.this, baseline: counts.baseline, decision };
}

/** The votes and the element decision of each element of `elements`. */
export function countVotes(voters: readonly Voter[], elements: readonly string[], judgeVotes: number): ElementVotes[] {
  const need = quorum(judgeVotes);
  return elements.map((element) => decide(element, voters, need));
}

/**
 * `vs baseline` of the step 4 judges together: `better` with an element decided `this`, none decided `baseline` and no
 * judge moment lost; `worse` with an element decided `baseline` and none decided `this`; `indistinguishable` otherwise.
 */
export function combinedVsBaseline(votes: readonly ElementVotes[], momentLost: boolean): VsBaseline {
  const decided = (decision: ElementDecision): boolean => votes.some((v) => v.decision === decision);
  if (decided('this') && !decided('baseline') && !momentLost) return 'better';
  if (decided('baseline') && !decided('this')) return 'worse';
  return 'indistinguishable';
}

/**
 * `vs reference` of the step 4 judges together: `fail` when any judge's is `fail`, `pass` when every judge that did not
 * fail has `pass` (and one did not fail), `unknown` otherwise.
 */
export function combinedVsReference(judges: readonly Pick<JudgeEntry, 'status' | 'vsReference'>[]): VsReference {
  if (judges.some((j) => j.vsReference === 'fail')) return 'fail';
  const done = judges.filter((j) => j.status === 'done');
  if (done.length > 0 && done.every((j) => j.vsReference === 'pass')) return 'pass';
  return 'unknown';
}
