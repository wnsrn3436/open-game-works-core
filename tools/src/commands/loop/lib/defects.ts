import { KEBAB } from './run.ts';

/** Defect list types and the merge and status rules of `game-loop` `## defect list` and `### defect status`. */

export type Severity = 'blocker' | 'major' | 'minor';
export type Source = 'check' | 'play' | 'judge' | 'hardening';
export type DefectStatus = 'open' | 'awaiting confirmation' | 'fixed' | 'reopened' | 'refused';

export const SEVERITIES: readonly Severity[] = ['blocker', 'major', 'minor'];
export const OWNERS = ['client content', 'server content', 'data', 'resource', 'contract', 'design'] as const;

export interface Finding {
  source: Source;
  severity: Severity | null;
  owner: string | null;
  where: string;
  what: string;
  why: string | null;
  evidence: string[];
  id: string | null;
  drop: string | null;
}

export interface FindingsFile {
  findings: Finding[];
  discarded: Finding[];
}

export interface Defect {
  id: string;
  severity: Severity;
  owner: string;
  where: string;
  what: string;
  why: string;
  evidence: string[];
  source: Source;
  status: DefectStatus;
  /** Reason the content agent gave when it refused the defect. */
  refusedReason: string | null;
  /** `## stop` `repeated defect` count. */
  repeatedDefect: number;
  /** `## stop` `oscillation` count. */
  oscillation: number;
}

/** `records/loops/<run>/defects.json`. */
export interface DefectsFile {
  defects: Defect[];
  previous: DefectsFile | null;
  recordedBy: string;
}

export interface ReportRow {
  result: string;
  note: string;
}

export function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}

function isOwner(value: unknown): boolean {
  return typeof value === 'string' && (OWNERS as readonly string[]).includes(value);
}

function isFilled(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Findings with `severity`, `owner` and `why` that a finding of the same `id` left empty takes from the first finding of
 * that `id` that has all three, so that the lead agent fills them once per defect (`game-loop` `## defect list`).
 */
export function fillFromSameId(findings: readonly Finding[]): Finding[] {
  const filled = new Map<string, Pick<Finding, 'severity' | 'owner' | 'why'>>();
  for (const f of findings) {
    if (f.drop !== null || f.id === null || filled.has(f.id)) continue;
    if (isSeverity(f.severity) && isOwner(f.owner) && isFilled(f.why)) filled.set(f.id, { severity: f.severity, owner: f.owner, why: f.why });
  }
  return findings.map((f) => {
    const from = f.drop === null && f.id !== null ? filled.get(f.id) : undefined;
    if (from === undefined) return f;
    return { ...f, severity: f.severity ?? from.severity, owner: f.owner ?? from.owner, why: f.why ?? from.why };
  });
}

/**
 * Findings that `ogw loop record` refuses: a `drop` that is neither null nor filled, or not dropped and missing
 * `id`, `severity`, `owner` or `why`, with a non-kebab-case `id`, or an `owner` outside `## defect list`.
 */
export function incompleteFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => {
    if (f.drop !== null) return !isFilled(f.drop) || f.id !== null;
    return f.id === null || !KEBAB.test(f.id) || !isSeverity(f.severity) || !isOwner(f.owner) || !isFilled(f.why);
  });
}

function rank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

/** Findings with the same `id` as one defect: the highest severity, all evidence, other fields of the first. */
export function groupFindings(findings: readonly Finding[]): Map<string, Omit<Defect, 'status' | 'refusedReason' | 'repeatedDefect' | 'oscillation'>> {
  const groups = new Map<string, Omit<Defect, 'status' | 'refusedReason' | 'repeatedDefect' | 'oscillation'>>();
  for (const f of findings) {
    if (f.drop !== null || f.id === null || f.severity === null) continue;
    const group = groups.get(f.id);
    if (!group) {
      groups.set(f.id, {
        id: f.id,
        severity: f.severity,
        owner: f.owner ?? '',
        where: f.where,
        what: f.what,
        why: f.why ?? '',
        evidence: [...f.evidence],
        source: f.source,
      });
      continue;
    }
    if (rank(f.severity) < rank(group.severity)) group.severity = f.severity;
    for (const e of f.evidence) if (!group.evidence.includes(e)) group.evidence.push(e);
  }
  return groups;
}

export interface RecordInput {
  /** Defects before this record. */
  base: readonly Defect[];
  findings: readonly Finding[];
  /** True when this record's confirmation of the defect gave a result. */
  confirmed: (defect: Defect) => boolean;
  /** The content agent report `## defects` rows by id; null for a hardening record. */
  report: ReadonlyMap<string, ReportRow> | null;
}

function confirm(defect: Defect, found: boolean): void {
  if (found) {
    defect.status = 'open';
    if (defect.owner !== 'resource') defect.repeatedDefect++;
  } else {
    defect.status = 'fixed';
    defect.repeatedDefect = 0;
  }
}

function changeByFinding(defect: Defect, found: boolean, confirmed: boolean): void {
  if (defect.status === 'awaiting confirmation') {
    if (confirmed) confirm(defect, found);
  } else if (defect.status === 'fixed' && found) {
    defect.status = 'reopened';
    defect.oscillation++;
  }
}

function changeByReport(defect: Defect, row: ReportRow | undefined): void {
  if (!row) return;
  if (row.result === 'fixed' || row.result === 'not reproduced') {
    defect.status = 'awaiting confirmation';
  } else if (row.result === 'refused') {
    defect.status = 'refused';
    defect.refusedReason = row.note === '' ? null : row.note;
  }
}

/** The defect list after this record, in defect list order. */
export function recordDefects(input: RecordInput): Defect[] {
  const groups = groupFindings(input.findings);
  const order = [...groups.keys()];
  const found: Defect[] = [];
  const rest: Defect[] = [];
  for (const previous of input.base) {
    const defect: Defect = structuredClone(previous);
    const group = groups.get(defect.id);
    if (input.report) changeByReport(defect, input.report.get(defect.id));
    changeByFinding(defect, group !== undefined, input.confirmed(defect));
    if (group) {
      Object.assign(defect, group);
      groups.delete(defect.id);
      found.push(defect);
    } else {
      rest.push(defect);
    }
  }
  for (const group of groups.values()) {
    found.push({ ...group, status: 'open', refusedReason: null, repeatedDefect: 0, oscillation: 0 });
  }
  found.sort((a, b) => rank(a.severity) - rank(b.severity) || order.indexOf(a.id) - order.indexOf(b.id));
  return [...found, ...rest];
}

/** Check names the evidence points at (`check-<n>.json#<check>`). */
export function evidenceChecks(defect: Pick<Defect, 'evidence'>): string[] {
  return defect.evidence.map((e) => /check-\d+\.json#(.+)$/.exec(e)?.[1]).filter((name): name is string => name !== undefined);
}

/** Metric names the evidence points at (`measure-<n>.json#<metric>`). */
export function evidenceMetrics(defect: Pick<Defect, 'evidence'>): string[] {
  return defect.evidence.map((e) => /measure-\d+\.json#(.+)$/.exec(e)?.[1]).filter((name): name is string => name !== undefined);
}

export const DEFECT_COLUMNS = ['id', 'severity', 'owner', 'where', 'what', 'why', 'evidence', 'source', 'status'] as const;

export function defectRow(defect: Defect): string[] {
  const status = defect.status === 'refused' && defect.refusedReason ? `refused (${defect.refusedReason})` : defect.status;
  return [defect.id, defect.severity, defect.owner, defect.where, defect.what, defect.why, defect.evidence.join(', '), defect.source, status];
}
