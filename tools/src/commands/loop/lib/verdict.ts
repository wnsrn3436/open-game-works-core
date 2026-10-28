import type { HarnessSettings } from '../../../lib/settings.ts';
import type { DefectsFile } from './defects.ts';
import { successPrecondition } from './files.ts';
import { mainJudges, type ParsedRecord } from './iteration-record.ts';
import type { VerdictRecord } from './run.ts';

export interface VerdictInput {
  iteration: number;
  limit: number;
  loopStop: HarnessSettings['loopStop'];
  /** Loop iteration records of the run; the one of `iteration` gives `success` and `confirm`. */
  records: readonly ParsedRecord[];
  /** `check-<iteration>.json` path, the check evidence of `success`. */
  checkPath: string;
  defects: DefectsFile | null;
  /** Resource and translation jobs of the run that `ogw loop sync` has not handled (`game-loop` `## stop`). */
  unhandled: readonly string[];
}

/**
 * Evidence that the record is a candidate iteration (`game-loop` `## stop`): not a confirmation iteration, its kind, its
 * step 4 judges together and its checks meet `successPrecondition`, and its success judges all passed. null when it is
 * not one.
 */
export function candidateEvidence(record: ParsedRecord, loopStop: HarnessSettings['loopStop']): string[] | null {
  if (record.confirms !== null) return null;
  return judgedEvidence(record, loopStop);
}

/** Evidence that the record is a confirmation iteration that passed: the candidate conditions and no play blocker. */
export function confirmEvidence(record: ParsedRecord, loopStop: HarnessSettings['loopStop']): string[] | null {
  if (record.confirms === null || record.playBlockers > 0) return null;
  return judgedEvidence(record, loopStop);
}

function judgedEvidence(record: ParsedRecord, loopStop: HarnessSettings['loopStop']): string[] | null {
  const main = mainJudges(record);
  if (main.length === 0 || !successPrecondition(record, (name) => record.checks.get(name) ?? 'unknown')) return null;
  const confirm = (record.judges ?? []).filter((j) => j.kind === 'success');
  if (confirm.length < loopStop.successJudges || !confirm.every((j) => j.vsReference === 'pass')) return null;
  return [...main.map((j) => j.result), ...confirm.map((j) => j.result)];
}

/** Evidence of this iteration as a candidate or a passed confirmation iteration; null otherwise. */
function qualified(input: VerdictInput): string[] | null {
  const record = input.records.find((r) => r.iteration === input.iteration);
  if (!record) return null;
  return record.confirms === null ? candidateEvidence(record, input.loopStop) : confirmEvidence(record, input.loopStop);
}

function success(input: VerdictInput): string[] | null {
  const evidence = qualified(input);
  return evidence && input.unhandled.length === 0 ? [...evidence, input.checkPath] : null;
}

function confirm(input: VerdictInput): string[] | null {
  const evidence = qualified(input);
  return evidence && input.unhandled.length > 0 ? [...evidence, ...input.unhandled.map((id) => `unhandled worker job ${id}`)] : null;
}

/** Defects at or over the limit; `repeated defect` does not count a defect whose `owner` is `resource`. */
function countReason(input: VerdictInput, field: 'repeatedDefect' | 'oscillation', limit: number): string[] | null {
  const counted = (input.defects?.defects ?? []).filter((d) => field !== 'repeatedDefect' || d.owner !== 'resource');
  const hits = counted.filter((d) => d[field] >= limit);
  return hits.length > 0 ? hits.map((d) => `${d.id} ${String(d[field])}`) : null;
}

/** Iterations that are not confirmation iterations and have a `vs baseline`, the last ones not `better`. */
function plateau(input: VerdictInput): string[] | null {
  const counted = input.records.filter((r) => r.iteration <= input.iteration && r.confirms === null && r.vsBaseline !== null);
  const run: number[] = [];
  for (let i = counted.length - 1; i >= 0; i--) {
    const record = counted[i] as ParsedRecord;
    if (record.vsBaseline === 'better') break;
    run.unshift(record.iteration);
  }
  return run.length >= input.loopStop.plateau ? run.map(String) : null;
}

/** The first `game-loop` `## stop` reason that holds, else `confirm` or `continue`. */
export function verdict(input: VerdictInput): Omit<VerdictRecord, 'iteration'> {
  const checks: [VerdictRecord['reason'], () => string[] | null][] = [
    ['success', () => success(input)],
    ['repeated defect', () => countReason(input, 'repeatedDefect', input.loopStop.repeatedDefect)],
    ['oscillation', () => countReason(input, 'oscillation', input.loopStop.oscillation)],
    ['plateau', () => plateau(input)],
    ['limit reached', () => (input.iteration >= input.limit ? [`iteration ${String(input.iteration)}`, `limit ${String(input.limit)}`] : null)],
    ['confirm', () => confirm(input)],
  ];
  for (const [reason, test] of checks) {
    const evidence = test();
    if (evidence) return { reason, evidence };
  }
  return { reason: 'continue', evidence: [] };
}
