import type { HarnessSettings } from '../../../lib/settings.ts';
import type { DefectStatus, DefectsFile, Severity } from './defects.ts';
import { successPrecondition } from './files.ts';
import { mainJudges, type ParsedRecord } from './iteration-record.ts';
import type { VerdictRecord } from './run.ts';
import { iterationLimitLine, smallerLimit, timeLimitLine } from './run-limits.ts';

export interface VerdictInput {
  iteration: number;
  /** Game settings `loopIterationLimit`. */
  limit: number;
  /** The run's `--limit`; none when absent or null. */
  runLimit?: number | null;
  /** The run's `--until` (UTC Unix ms); none when absent or null. */
  until?: number | null;
  /** The current time (UTC Unix ms) the time limit is judged at; `Date.now()` when absent. */
  now?: number;
  loopStop: HarnessSettings['loopStop'];
  /** Loop iteration records of the run; the one of `iteration` gives `success` and `confirm`. */
  records: readonly ParsedRecord[];
  /** `check-<iteration>.json` path, the check evidence of `success`. */
  checkPath: string;
  defects: DefectsFile | null;
  /** Resource and translation jobs of the run that `ogw loop sync` has not handled (ogw.md `## loop verdict`). */
  unhandled: readonly string[];
}

/**
 * Evidence that the record is a candidate iteration (ogw.md `## loop verdict`): not a confirmation iteration, its kind, its
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

const BLOCKING_SEVERITIES: readonly Severity[] = ['blocker', 'major'];
const OPEN_STATUSES: readonly DefectStatus[] = ['open', 'reopened', 'awaiting confirmation'];

/** Ids of the blocking defects (ogw.md `## loop verdict`): `blocker` or `major`, not `fixed` and not `refused`. */
export function blockingDefects(defects: DefectsFile | null): string[] {
  return (defects?.defects ?? []).filter((d) => BLOCKING_SEVERITIES.includes(d.severity) && OPEN_STATUSES.includes(d.status)).map((d) => d.id);
}

function success(input: VerdictInput): string[] | null {
  const evidence = qualified(input);
  return evidence && blockingDefects(input.defects).length === 0 && input.unhandled.length === 0 ? [...evidence, input.checkPath] : null;
}

function confirm(input: VerdictInput): string[] | null {
  const evidence = qualified(input);
  if (!evidence || blockingDefects(input.defects).length > 0 || input.unhandled.length === 0) return null;
  return [...evidence, ...input.unhandled.map((id) => `unhandled worker job ${id}`)];
}

/** The iteration limit and the time limit of the run that are reached, one evidence line each. */
function limitReached(input: VerdictInput): string[] | null {
  const limit = smallerLimit(input.runLimit ?? null, input.limit);
  const now = input.now ?? Date.now();
  const until = input.until ?? null;
  const lines = [
    ...(input.iteration >= limit.limit ? [iterationLimitLine(input.iteration, limit)] : []),
    ...(until !== null && now >= until ? [timeLimitLine(now, until)] : []),
  ];
  return lines.length > 0 ? lines : null;
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

/** The first ogw.md `## loop verdict` reason that holds, else `confirm` or `continue`. */
export function verdict(input: VerdictInput): Omit<VerdictRecord, 'iteration'> {
  const checks: [VerdictRecord['reason'], () => string[] | null][] = [
    ['success', () => success(input)],
    ['repeated defect', () => countReason(input, 'repeatedDefect', input.loopStop.repeatedDefect)],
    ['oscillation', () => countReason(input, 'oscillation', input.loopStop.oscillation)],
    ['plateau', () => plateau(input)],
    ['limit reached', () => limitReached(input)],
    ['confirm', () => confirm(input)],
  ];
  // the blocking defects of an iteration that meets the other success conditions go with whatever reason it gives
  const blocked = qualified(input) === null ? [] : blockingDefects(input.defects);
  const blockedBy = blocked.length > 0 ? { blockedBy: blocked } : {};
  for (const [reason, test] of checks) {
    const evidence = test();
    if (evidence) return { reason, evidence, ...blockedBy };
  }
  return { reason: 'continue', evidence: [], ...blockedBy };
}
