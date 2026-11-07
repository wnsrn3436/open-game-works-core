import { cell, column, parseTable, section, sectionText, splitRow, type Table } from './markdown.ts';
import type { Vote, VsReference } from './files.ts';

/** What `ogw loop evaluate` reads from a judge result (`agents/judge.md` `## judge result`). */
export interface JudgeVerdict {
  /** Per element of `elements`, the vote; null without a baseline game. */
  votes: Record<string, Vote> | null;
  /** The judge moments put in the judge at which `## moments` says the other side is better. */
  lostMoments: string[];
  /** null when the iteration has no `vs reference` (a fun iteration). */
  vsReference: VsReference | null;
}

const WINNERS = new Set(['A', 'B', 'indistinguishable', 'n/a']);
const REFERENCE_RESULTS = new Set(['pass', 'fail', 'unknown', 'n/a']);

function tableOf(text: string, heading: string): Table | null {
  const lines = section(text, heading);
  return lines === null ? null : parseTable(lines);
}

/**
 * The `## vs reference` table: the first table of the section whose header has `instance`, as the section can also
 * hold the `presentation counts` table; else the first table.
 */
function referenceTable(text: string): Table | null {
  const lines = section(text, 'vs reference');
  if (lines === null) return null;
  for (let i = 0; i < lines.length; i++) {
    if (parseTable(lines.slice(i, i + 2)) === null) continue;
    const table = parseTable(lines.slice(i));
    if (table && column(table, 'instance') >= 0) return table;
  }
  return parseTable(lines);
}

/** The moments of `judgeMoments` at which `## moments` says the side other than `instanceSide` is better. */
export function lostMoments(text: string, instanceSide: 'A' | 'B', judgeMoments: readonly string[]): string[] {
  const names = new Set(judgeMoments);
  const lost = new Set<string>();
  for (const line of section(text, 'moments') ?? []) {
    const match = /^\s*(?:[-*]\s+)?`?(A|B)`? is better at (.+?)\.\s*Reason:/i.exec(line);
    if (!match) continue;
    const moment = (match[2] as string).replace(/`/g, '').trim();
    if (match[1] !== instanceSide && names.has(moment)) lost.add(moment);
  }
  return [...lost];
}

/**
 * The vote of each element of `elements` (ogw.md `## loop evaluate`): the winner of its `## vs baseline` row restated
 * relative to this commit's side. `indistinguishable`, `n/a` and an element without a row are no vote. Throws when
 * the table cannot be read.
 */
export function votesOf(text: string, instanceSide: 'A' | 'B', elements: readonly string[]): Record<string, Vote> {
  const read = readVotes(text, instanceSide, elements);
  if (read.votes === null) throw new Error(read.errors.join('; '));
  return read.votes;
}

/** `votesOf`, with each way the `## vs baseline` table cannot be read in `errors` instead of a throw. */
function readVotes(text: string, instanceSide: 'A' | 'B', elements: readonly string[]): { votes: Record<string, Vote> | null; errors: string[] } {
  const table = tableOf(text, 'vs baseline');
  if (!table) return { votes: null, errors: ['`## vs baseline` table missing'] };
  const elementCol = column(table, 'element');
  const winnerCol = column(table, 'winner');
  if (elementCol < 0 || winnerCol < 0) return { votes: null, errors: ['`## vs baseline` columns missing: it needs `element` and `winner`'] };
  const votes: Record<string, Vote> = Object.fromEntries(elements.map((e) => [e, null]));
  const errors: string[] = [];
  for (const row of table.rows) {
    const winner = cell(row, winnerCol);
    const element = cell(row, elementCol).replace(/`/g, '').trim();
    if (!WINNERS.has(winner)) errors.push(`\`## vs baseline\` row ${element}: unknown winner ${winner}, not one of ${[...WINNERS].join(', ')}`);
    if (!(element in votes) || (winner !== 'A' && winner !== 'B')) continue;
    votes[element] = winner === instanceSide ? 'this' : 'baseline';
  }
  return errors.length > 0 ? { votes: null, errors } : { votes, errors };
}

/** `vs reference` of the rows of this commit's side. Throws when the table cannot be read. */
export function vsReferenceOf(text: string, instanceSide: 'A' | 'B'): VsReference {
  const read = readVsReference(text, instanceSide);
  if (read.value === null) throw new Error(read.errors.join('; '));
  return read.value;
}

/** `vsReferenceOf`, with each way the `## vs reference` table cannot be read in `errors` instead of a throw. */
function readVsReference(text: string, instanceSide: 'A' | 'B'): { value: VsReference | null; errors: string[] } {
  const table = referenceTable(text);
  if (!table) return { value: null, errors: ['`## vs reference` table missing'] };
  const instanceCol = column(table, 'instance');
  const resultCol = column(table, 'result');
  if (instanceCol < 0 || resultCol < 0 || column(table, 'element') < 0) return { value: null, errors: ['`## vs reference` columns missing: it needs `instance`, `element` and `result`'] };
  const results: string[] = [];
  const errors: string[] = [];
  for (const row of table.rows) {
    const result = cell(row, resultCol);
    if (!REFERENCE_RESULTS.has(result)) errors.push(`\`## vs reference\` row ${cell(row, instanceCol)} ${cell(row, column(table, 'element'))}: unknown result ${result}, not one of ${[...REFERENCE_RESULTS].join(', ')}`);
    else if (cell(row, instanceCol) === instanceSide && result !== 'n/a') results.push(result);
  }
  if (errors.length > 0) return { value: null, errors };
  if (results.length > 0 && results.every((r) => r === 'pass')) return { value: 'pass', errors };
  if (results.includes('fail')) return { value: 'fail', errors };
  return { value: 'unknown', errors };
}

/**
 * What a judge result gives, read as its judge input sets (`judgeReadingOf`). `withBaseline` false: no votes and no lost
 * moments. `withReference` false: `## vs reference` is not read. `judgeMoments`: the names of the save fixture moments
 * put in that judge. Throws when a table it reads cannot be read.
 */
export function judgeVerdict(text: string, instanceSide: 'A' | 'B', reading: JudgeReading & { judgeMoments?: readonly string[] }): JudgeVerdict {
  return {
    votes: reading.withBaseline ? votesOf(text, instanceSide, reading.elements) : null,
    lostMoments: reading.withBaseline ? lostMoments(text, instanceSide, reading.judgeMoments ?? []) : [],
    vsReference: reading.withReference ? vsReferenceOf(text, instanceSide) : null,
  };
}

/** What of a judge result `judgeVerdict` reads, set by the judge input (ogw.md `### result format` of `## agent`). */
export interface JudgeReading {
  /** `B` of the input is not `null`: `## vs baseline` is read. */
  withBaseline: boolean;
  /** `reference` of the input is not `null`: `## vs reference` is read. */
  withReference: boolean;
  elements: readonly string[];
}

/**
 * The reading of the judge input `input` (agents/judge.md): `## vs baseline` when its `B` is not `null`, `## vs reference`
 * when its `reference` is not `null`, of its `elements`. Both the result format check and `ogw loop evaluate` read so.
 */
export function judgeReadingOf(input: unknown): JudgeReading {
  const fields = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const elements = Array.isArray(fields.elements) ? fields.elements.filter((e): e is string => typeof e === 'string') : [];
  return { withBaseline: fields.B !== null && fields.B !== undefined, withReference: fields.reference !== null && fields.reference !== undefined, elements };
}

/** The format errors of a judge result: each way `judgeVerdict` cannot read the tables it reads (ogw.md `### result format`). */
export function judgeResultErrors(text: string, reading: JudgeReading): string[] {
  return [
    ...(reading.withBaseline ? readVotes(text, 'A', reading.elements).errors : []),
    ...(reading.withReference ? readVsReference(text, 'A').errors : []),
  ];
}

export interface JudgeDefect {
  instance: string;
  where: string;
  what: string;
  why: string;
  severity: string;
  evidence: string;
}

/** Rows of the judge result `## defects` table; empty when there is none. */
export function judgeDefects(text: string): JudgeDefect[] {
  const table = tableOf(text, 'defects');
  if (!table) return [];
  const cols = ['instance', 'where', 'what', 'why', 'severity', 'evidence'].map((name) => column(table, name));
  return table.rows.map((row) => {
    const [instance, where, what, why, severity, evidence] = cols.map((index) => cell(row, index));
    return {
      instance: instance ?? '',
      where: where ?? '',
      what: what ?? '',
      why: why ?? '',
      severity: severity ?? '',
      evidence: evidence ?? '',
    };
  });
}

/** A `## vs reference` row of a judge result (`agents/judge.md` `## judge result`). */
export interface ReferenceRow {
  instance: string;
  element: string;
  result: string;
  reason: string;
  evidence: string;
}

/** Rows of the `## vs reference` table; empty when the table is missing. */
export function referenceRows(text: string): ReferenceRow[] {
  const table = referenceTable(text);
  if (!table) return [];
  const cols = ['instance', 'element', 'result', 'reason', 'evidence'].map((name) => column(table, name));
  return table.rows.map((row) => {
    const [instance = '', element = '', result = '', reason = '', evidence = ''] = cols.map((index) => cell(row, index));
    return { instance, element, result, reason, evidence };
  });
}

export function judgeSectionText(text: string, heading: 'moments' | 'loser better'): string {
  return sectionText(text, heading) ?? 'none';
}

export interface Observation {
  /** 1-based line number in the feedback file. */
  line: number;
  elapsed: string;
  scene: string;
  input: string;
  happened: string;
  feeling: string;
  severity: string;
  capture: string;
}

/**
 * Lines of the play feedback `## observations` (`agents/play.md` `## feedback`). A row with six cells has an empty
 * capture. A row with fewer cells keeps only its line in `happened`, with empty other cells and severity, so that its
 * finding is discarded with the feedback line as evidence.
 */
export function observations(text: string): Observation[] {
  const lines = text.split(/\r?\n/);
  const start = observationsHeading(lines);
  if (start === -1) return [];
  const out: Observation[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i] as string;
    if (/^#{1,2} /.test(raw)) break;
    const line = raw.trim().replace(/^[-*]\s+/, '');
    if (!line.includes('|') || /^\|?[\s:|-]+\|?$/.test(line)) continue;
    const cells = splitRow(line);
    if ((cells[0] ?? '').toLowerCase().includes('elapsed')) continue;
    if (cells.length < 6) {
      out.push({ line: i + 1, elapsed: '', scene: '', input: '', happened: line, feeling: '', severity: '', capture: '' });
      continue;
    }
    if (cells.length === 6) cells.push('');
    const [elapsed, scene, input, happened, feeling, severity, capture] = cells as [string, string, string, string, string, string, string];
    out.push({ line: i + 1, elapsed, scene, input, happened, feeling, severity: severity.replace(/^severity:\s*/, ''), capture });
  }
  return out;
}

/** The index of the `## observations` heading line, which `observations` reads under; -1 when it is missing. */
function observationsHeading(lines: readonly string[]): number {
  return lines.findIndex((line) => line.trim() === '## observations');
}

/** The format errors of a play feedback: without `## observations`, `observations` reads none (ogw.md `### result format`). */
export function playFeedbackErrors(text: string): string[] {
  return observationsHeading(text.split(/\r?\n/)) === -1 ? ['`## observations` is missing'] : [];
}

/** Adds lines at the end of the `## coverage` section; adds the section at the end when it is missing. */
export function appendCoverage(text: string, added: readonly string[]): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## coverage');
  if (start === -1) {
    const body = text.endsWith('\n') || text === '' ? text : `${text}\n`;
    return `${body}${body === '' ? '' : '\n'}## coverage\n\n${added.join('\n')}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end);
  while (body.length > 0 && (body[body.length - 1] as string).trim() === '') body.pop();
  const rest = lines.slice(end);
  return [...lines.slice(0, start + 1), ...(body.length > 0 ? body : ['']), ...added, '', ...rest].join('\n');
}
