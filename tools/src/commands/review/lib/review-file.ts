import { markdownSection, tableCells } from '../../agent/lib/prompt.ts';

export interface Finding {
  id: string;
  aspect: string;
  severity: string;
  location: string;
  evidence: string;
  fix: string;
  specChange: 'yes' | 'no';
  confidence: number;
}

export interface PreviousResult {
  id: string;
  result: 'fixed' | 'open' | 'withdrawn';
  evidence: string;
}

/** A `## debt` or `## must fix` row: what the round found of an item of the review list its input gave. */
export interface ListResult {
  id: string;
  result: 'fixed' | 'open' | 'withdrawn';
  /** The finding that carries an `open` item, or null. */
  finding: string | null;
  evidence: string;
}

export interface ReviewFile {
  findings: Finding[];
  previous: PreviousResult[];
  /** The `## out of scope` lines without their `- `. */
  outOfScope: string[];
  /** The `## debt` rows; `[]` for a file of an earlier form without the section. */
  debt: ListResult[];
  /** The `## must fix` rows; `[]` for a file of an earlier form without the section. */
  mustFix: ListResult[];
}

const FINDING_COLUMNS = ['id', 'aspect', 'severity', 'location', 'evidence', 'fix', 'spec change', 'confidence'];
const PREVIOUS_COLUMNS = ['id', 'result', 'evidence'];
const DEBT_COLUMNS = ['id', 'result', 'finding', 'evidence'];
const ASPECTS = ['correctness', 'spec', 'test evidence', 'security', 'structure', 'efficiency'];
/** The severities of a finding; `low` only in a review of the whole target (`ParseOptions.low`). */
const SEVERITIES = ['critical', 'high', 'medium'];
/** What a review file judged before the review agent stopped writing them can also hold. */
const EARLIER_ASPECTS = [...ASPECTS, 'duplication'];
const EARLIER_SEVERITIES = [...SEVERITIES, 'low'];
/**
 * A `## out of scope` item: `<file>:<line>: <severity> <problem and evidence>`, `critical`, `high` or `medium`. A `.`,
 * `,` or `:` right after the severity is taken.
 */
const OUT_OF_SCOPE_ITEM = /^([^\s:]+:\d+): (critical|high|medium)[.,:]? (\S.*)$/;
const RESULTS = ['fixed', 'open', 'withdrawn'];

/** A `## out of scope` item read: its location, severity and problem. */
export interface OutOfScopeItem {
  location: string;
  severity: 'critical' | 'high' | 'medium';
  problem: string;
}

/** Reads a `## out of scope` item (`OUT_OF_SCOPE_ITEM`); null when it is not in that form. */
export function outOfScopeItem(line: string): OutOfScopeItem | null {
  const match = OUT_OF_SCOPE_ITEM.exec(line);
  if (match === null) return null;
  return { location: match[1] as string, severity: match[2] as OutOfScopeItem['severity'], problem: (match[3] as string).trim() };
}

/** Whether an out of scope item asks for a fix at once: `critical` or `high`. */
export function urgentOutOfScope(line: string): boolean {
  // an item of an earlier form, in no form, had `critical` or `high` only
  return outOfScopeItem(line)?.severity !== 'medium';
}

/** A cell without surrounding code span backticks, with `\|` read as `|` (`agents/review.md`). */
function plain(cell: string): string {
  return cell.replace(/^`(.*)`$/, '$1').replace(/\\\|/g, '|').trim();
}

/** Rows of the section's table with exactly `columns`; `[]` for `none`; null when the section is not in that form. */
function sectionTable(text: string, heading: string, columns: readonly string[]): string[][] | null {
  const section = markdownSection(text, heading);
  if (section === null) return null;
  const body = section.split('\n').slice(1).map((line) => line.trim()).filter((line) => line !== '');
  // `none` may carry a short note after it (`none. Round 2 had no findings`)
  if (body.length === 1 && /^none\b/.test(body[0] as string)) return [];
  if (body.length < 2 || !body.every((line) => line.startsWith('|'))) return null;
  const header = tableCells(body[0] as string).map(plain);
  if (header.join('\u0000') !== columns.join('\u0000')) return null;
  if (!/^\|[\s|:-]+\|?$/.test(body[1] as string)) return null;
  // a cell writes `|` as `\|`: a row with another number of cells is not in the form
  const rows = body.slice(2).map((line) => tableCells(line).map(plain));
  return rows.every((row) => row.length === columns.length) ? rows : null;
}

function toFinding(row: readonly string[], earlier: boolean, low: boolean): Finding | null {
  const [id, aspect, severity, location, evidence, fix, specChange, confidence] = row as [string, string, string, string, string, string, string, string];
  const score = Number(confidence);
  const [aspects, severities] = earlier ? [EARLIER_ASPECTS, EARLIER_SEVERITIES] : [ASPECTS, low ? [...SEVERITIES, 'low'] : SEVERITIES];
  if (!/^R\d+-\d+$/.test(id) || !aspects.includes(aspect) || !severities.includes(severity)) return null;
  if ((specChange !== 'yes' && specChange !== 'no') || !Number.isInteger(score) || score < 0 || score > 100) return null;
  return { id, aspect, severity, location, evidence, fix, specChange, confidence: score };
}

function toPrevious(row: readonly string[]): PreviousResult | null {
  const [id, result, evidence] = row as [string, string, string];
  if (!/^R\d+-\d+$/.test(id) || !RESULTS.includes(result)) return null;
  return { id, result: result as PreviousResult['result'], evidence };
}

/** A row of a review list table; its id has the list's prefix (`D` debt, `M` must fix). */
function toListResult(row: readonly string[], prefix: 'D' | 'M'): ListResult | null {
  const [id, result, finding, evidence] = row as [string, string, string, string];
  if (!new RegExp(`^${prefix}\\d+$`).test(id) || !RESULTS.includes(result)) return null;
  if (finding !== 'none' && !/^R\d+-\d+$/.test(finding)) return null;
  return { id, result: result as ListResult['result'], finding: finding === 'none' ? null : finding, evidence };
}

/** The rows of a review list table, `[]` when an earlier form has no such section; null when not in the form. */
function listRows(text: string, heading: 'debt' | 'must fix', prefix: 'D' | 'M', earlier: boolean): ListResult[] | null {
  if (earlier && markdownSection(text, heading) === null) return [];
  const rows = sectionTable(text, heading, DEBT_COLUMNS)?.map((row) => toListResult(row, prefix));
  return rows === undefined || rows.includes(null) ? null : (rows as ListResult[]);
}

/**
 * The `## out of scope` list items, `[]` for `none`; null when the section is missing or holds other lines or an item
 * not in the form (`OUT_OF_SCOPE_ITEM`). `earlier` takes any item, as written before items had that form.
 */
function outOfScopeLines(text: string, earlier: boolean): string[] | null {
  const section = markdownSection(text, 'out of scope');
  if (section === null) return null;
  const body = section.split('\n').slice(1).map((line) => line.trim()).filter((line) => line !== '');
  if (body.length === 1 && /^none\b/.test(body[0] as string)) return [];
  if (body.length === 0 || !body.every((line) => line.startsWith('- '))) return null;
  const items = body.map((line) => line.slice(2).trim());
  return earlier || items.every((item) => OUT_OF_SCOPE_ITEM.test(item)) ? items : null;
}

export interface ParseOptions {
  /**
   * Reads a review file judged in an earlier form, whose findings are looked up again later: one without
   * `## out of scope`, `## debt` or `## must fix`, with its out of scope items in no form, and with `duplication` findings or `low`
   * severities.
   */
  earlier?: boolean;
  /** Takes `low` findings: the review of the whole target (`agents/review.md` `## procedure`). */
  low?: boolean;
}

/** Parses a review file in the `agents/review.md` `## review file` form; null when it is not in that form. */
export function parseReviewFile(text: string, options: ParseOptions = {}): ReviewFile | null {
  const earlier = options.earlier === true;
  const findingRows = sectionTable(text, 'findings', FINDING_COLUMNS);
  const previousRows = sectionTable(text, 'previous', PREVIOUS_COLUMNS);
  const outOfScope = earlier && markdownSection(text, 'out of scope') === null ? [] : outOfScopeLines(text, earlier);
  const debt = listRows(text, 'debt', 'D', earlier);
  const mustFix = listRows(text, 'must fix', 'M', earlier);
  if (findingRows === null || previousRows === null || outOfScope === null || debt === null || mustFix === null || markdownSection(text, 'unknown') === null) return null;
  const findings = findingRows.map((row) => toFinding(row, earlier, options.low === true));
  const previous = previousRows.map(toPrevious);
  if (findings.includes(null) || previous.includes(null)) return null;
  return { findings: findings as Finding[], previous: previous as PreviousResult[], outOfScope, debt, mustFix };
}

/** The ids of the review list items an input gave: `## debt` and `## must fix`. */
export interface GivenItems {
  debt: readonly string[];
  mustFix: readonly string[];
}

/** Why one review list table does not answer the items given (`debtMismatch`), or null. */
function tableMismatch(file: ReviewFile, heading: 'debt' | 'must fix', rows: readonly ListResult[], given: readonly string[]): string | null {
  const ids = rows.map((row) => row.id);
  const missing = given.filter((id) => !ids.includes(id));
  const extra = ids.filter((id) => !given.includes(id));
  if (missing.length > 0 || extra.length > 0 || new Set(ids).size !== ids.length) {
    return `## ${heading} rows ${ids.join(', ') || 'none'} do not answer the ${heading} items ${given.join(', ') || 'none'}`;
  }
  const open = new Set([...file.findings.map((f) => f.id), ...file.previous.filter((p) => p.result === 'open').map((p) => p.id)]);
  const unnamed = rows.filter((row) => row.result === 'open' && (row.finding === null || !open.has(row.finding)));
  return unnamed.length === 0 ? null : `## ${heading} rows ${unnamed.map((row) => row.id).join(', ')} are open without an open finding`;
}

/**
 * Why the `## debt` and `## must fix` rows of a review file do not answer the items its input gave, or null when they
 * do: one row for each given item and no other, and an `open` row names a finding of the file that is `open` in it (a
 * `## findings` row, or a `## previous` row `open`).
 */
export function debtMismatch(file: ReviewFile, given: GivenItems): string | null {
  return tableMismatch(file, 'debt', file.debt, given.debt) ?? tableMismatch(file, 'must fix', file.mustFix, given.mustFix);
}

/** Round number of a finding id `R<round>-<n>`. */
export function roundOfId(id: string): number {
  return Number(/^R(\d+)-/.exec(id)?.[1] ?? '0');
}
