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

export interface JudgeEntry {
  kind: 'main' | 'success';
  result: string;
  A: string;
  B: string | null;
  instanceSide: 'A' | 'B';
  omittedMoments: string[];
  vsBaseline: VsBaseline | null;
  vsReference: VsReference;
  status: 'done' | 'failed';
}

/** `records/loops/<run>/evaluate-<iteration>.json`. */
export interface EvaluateFile {
  commit: string;
  baseline: string | null;
  plays: PlayEntry[];
  judges: JudgeEntry[];
  measure: string | null;
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
 * The rest of a candidate iteration besides the success judges (`game-loop` `## stop`): the step 4 judge's
 * `vs reference` is `pass`, its `vs baseline` is not `worse`, and the completeness elements but `no placeholder` are
 * `pass` by `resultOf`.
 */
export function successPrecondition(
  main: { vsBaseline: VsBaseline | null; vsReference: VsReference } | null,
  resultOf: (check: string) => string,
): boolean {
  return main !== null && main.vsReference === 'pass' && main.vsBaseline !== 'worse' && CANDIDATE_CHECKS.every((name) => resultOf(name) === 'pass');
}

/** Check names in the file, in `CHECK_ORDER` order and then any other names in file order. */
export function checkNames(file: CheckFile): string[] {
  const names: string[] = [];
  for (const name of CHECK_ORDER) if (file.checks.some((c) => c.name === name)) names.push(name);
  for (const c of file.checks) if (!names.includes(c.name)) names.push(c.name);
  return names;
}

export function mainJudge(file: EvaluateFile): JudgeEntry | null {
  return file.judges.find((j) => j.kind === 'main') ?? null;
}
