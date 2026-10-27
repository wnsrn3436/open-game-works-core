import { CHECK_ORDER, GATE_CHECKS, mergedResult, type CheckResult } from '../../check/api.ts';

export { GATE_CHECKS };

/** `records/loops/<run>/check-<iteration>.json`. */
export interface CheckFile {
  commit: string;
  checks: CheckResult[];
  gate: 'pass' | 'fail';
}

/** `records/loops/<run>/measure-<iteration>.json`. */
export interface MeasureTarget {
  metric: string;
  min: number;
  max: number;
  value: number | null;
  result: 'in' | 'out' | 'unknown';
  data: string | null;
}

export interface MeasureFile {
  commit: string;
  targets: MeasureTarget[];
}

export interface PlayEntry {
  result: string;
  instance: string;
  platform: string;
  moment: string | null;
  status: 'done' | 'failed';
}

export type VsBaseline = 'better' | 'worse' | 'indistinguishable';
export type VsReference = 'pass' | 'fail' | 'unknown';

/** Iteration kind (`game-loop` `## iteration`). */
export type IterationKind = 'fun' | 'completeness';

/** The elements of `agents/judge.md` `## fun judgement criteria`, in table order. */
export const FUN_ELEMENTS = ['game feel', 'tension and release', 'progression', 'one more run', 'no friction', 'presentation'] as const;

/** The elements a judge of a fun iteration judges (`game-loop` `## iteration` 4). */
export const FUN_ITERATION_ELEMENTS = ['game feel', 'tension and release', 'no friction'] as const;

/** The judge input `elements` of an iteration of that kind. */
export function elementsOf(kind: IterationKind): string[] {
  return kind === 'fun' ? [...FUN_ITERATION_ELEMENTS] : [...FUN_ELEMENTS];
}

/** A vote of a judge for an element, restated relative to this instance; null for no vote. */
export type Vote = 'this' | 'baseline' | null;

export type ElementDecision = 'this' | 'baseline' | 'uncertain' | 'indistinguishable';

/** The votes of the step 4 judges for one element and its element decision. */
export interface ElementVotes {
  element: string;
  this: number;
  baseline: number;
  decision: ElementDecision;
}

/** Agent CLI, model and effort a judge ran with. */
export interface JudgeAgent {
  cli: 'claude-code' | 'codex';
  model: string;
  effort: string;
}

export interface JudgeEntry {
  kind: 'main' | 'success';
  result: string;
  agent: JudgeAgent;
  A: string;
  B: string | null;
  instanceSide: 'A' | 'B';
  omittedMoments: string[];
  /** Per element of `elements`, the vote of a done judge with a baseline game; null without one or when the judge failed. */
  votes: Record<string, Vote> | null;
  /** The judge moments put in this judge at which its `## moments` says the other side is better. */
  lostMoments: string[];
  /** null in a fun iteration, which has no `vs reference`. */
  vsReference: VsReference | null;
  /** Absolute path of the judge input `telemetry`, or null. */
  telemetry: string | null;
  status: 'done' | 'failed';
}

/** `records/loops/<run>/evaluate-<iteration>.json`. */
export interface EvaluateFile {
  commit: string;
  baseline: string | null;
  kind: IterationKind;
  /** The judge input `elements`. */
  elements: string[];
  plays: PlayEntry[];
  judges: JudgeEntry[];
  /** Per element of `elements`, the votes of the step 4 judges; null without a baseline game. */
  votes: ElementVotes[] | null;
  /** `vs baseline` of the step 4 judges together; null without a baseline game. */
  vsBaseline: VsBaseline | null;
  /** `vs reference` of the step 4 judges together; null in a fun iteration. */
  vsReference: VsReference | null;
  measure: string | null;
  /** Set when `memorable_moment` was asked for and the step 4 judges did not get it (`game-loop` `## iteration` 3). */
  memorableMoment?: 'missing' | 'omitted';
}

export const COMPLETENESS_CHECKS = ['no blocker', 'performance', 'no placeholder', 'full flow', 'UI quality'] as const;

/** Result of a check over its items, as `ogw check` merges them (`unknown` also when the check has no item). */
export function checkResult(file: CheckFile, name: string): 'pass' | 'fail' | 'unknown' {
  return mergedResult(file.checks.filter((c) => c.name === name));
}

/** The `gate` field of the check file; null when it is missing or not `pass` or `fail`. */
export function gateOf(file: CheckFile): 'pass' | 'fail' | null {
  const gate: unknown = (file as { gate?: unknown }).gate;
  return gate === 'pass' || gate === 'fail' ? gate : null;
}

/** Completeness elements a candidate iteration needs (`game-loop` `## stop`): all but `no placeholder`. */
export const CANDIDATE_CHECKS: readonly string[] = COMPLETENESS_CHECKS.filter((name) => name !== 'no placeholder');

/**
 * The rest of a candidate iteration besides the success judges (`game-loop` `## stop`): a completeness iteration whose
 * step 4 judges together have `vs reference` `pass` and a `vs baseline` that is not `worse`, and whose completeness
 * elements but `no placeholder` are `pass` by `resultOf`.
 */
export function successPrecondition(
  judged: { kind: IterationKind; vsBaseline: VsBaseline | null; vsReference: VsReference | null },
  resultOf: (check: string) => string,
): boolean {
  return (
    judged.kind === 'completeness' &&
    judged.vsReference === 'pass' &&
    judged.vsBaseline !== 'worse' &&
    CANDIDATE_CHECKS.every((name) => resultOf(name) === 'pass')
  );
}

/** Check names in the file, in `CHECK_ORDER` order and then any other names in file order. */
export function checkNames(file: CheckFile): string[] {
  const names: string[] = [];
  for (const name of CHECK_ORDER) if (file.checks.some((c) => c.name === name)) names.push(name);
  for (const c of file.checks) if (!names.includes(c.name)) names.push(c.name);
  return names;
}

/** The first step 4 judge of the file; null when it has none. */
export function mainJudge(file: EvaluateFile): JudgeEntry | null {
  return file.judges.find((j) => j.kind === 'main') ?? null;
}
