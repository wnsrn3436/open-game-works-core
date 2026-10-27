import { cell, column, parseTable, section, sectionText, splitRow, type Table } from './markdown.ts';
import type { VsBaseline, VsReference } from './files.ts';

/** Judge result tables read for `vs baseline` and `vs reference` (`agents/judge.md` `## judge result`). */
export interface JudgeVerdict {
  vsBaseline: VsBaseline | null;
  vsReference: VsReference;
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
 * `vs baseline` from the element winners turned to the side of this commit's instance (`game-loop` `## iteration` 4).
 * A judge moment lost in `## moments` keeps it from `better`. Throws when the table cannot be read.
 */
export function vsBaselineOf(text: string, instanceSide: 'A' | 'B', judgeMoments: readonly string[] = []): VsBaseline {
  const table = tableOf(text, 'vs baseline');
  if (!table) throw new Error('`## vs baseline` table missing');
  const winnerCol = column(table, 'winner');
  const marginCol = column(table, 'margin');
  if (column(table, 'element') < 0 || winnerCol < 0 || marginCol < 0) throw new Error('`## vs baseline` columns missing');
  let won = 0;
  let lost = 0;
  // a decisive loss or a lost judge moment keeps it from `better`
  let blocked = lostMoments(text, instanceSide, judgeMoments).length > 0;
  for (const row of table.rows) {
    const winner = cell(row, winnerCol);
    if (!WINNERS.has(winner)) throw new Error(`unknown winner ${winner}`);
    if (winner === 'n/a' || winner === 'indistinguishable') continue;
    if (winner === instanceSide) {
      won++;
    } else {
      lost++;
      if (cell(row, marginCol) === 'decisive') blocked = true;
    }
  }
  if (won > lost && !blocked) return 'better';
  if (lost > won) return 'worse';
  return 'indistinguishable';
}

/** `vs reference` of the rows of this commit's side. Throws when the table cannot be read. */
export function vsReferenceOf(text: string, instanceSide: 'A' | 'B'): VsReference {
  const table = referenceTable(text);
  if (!table) throw new Error('`## vs reference` table missing');
  const instanceCol = column(table, 'instance');
  const resultCol = column(table, 'result');
  if (instanceCol < 0 || resultCol < 0 || column(table, 'element') < 0) throw new Error('`## vs reference` columns missing');
  const results: string[] = [];
  for (const row of table.rows) {
    const result = cell(row, resultCol);
    if (!REFERENCE_RESULTS.has(result)) throw new Error(`unknown result ${result}`);
    if (cell(row, instanceCol) === instanceSide && result !== 'n/a') results.push(result);
  }
  if (results.length > 0 && results.every((r) => r === 'pass')) return 'pass';
  if (results.includes('fail')) return 'fail';
  return 'unknown';
}

/**
 * Both verdicts. `withBaseline` false: `vs baseline` is not read and is null. `judgeMoments`: the names of the save
 * fixture moments put in that judge.
 */
export function judgeVerdict(text: string, instanceSide: 'A' | 'B', withBaseline: boolean, judgeMoments: readonly string[] = []): JudgeVerdict {
  return {
    vsBaseline: withBaseline ? vsBaselineOf(text, instanceSide, judgeMoments) : null,
    vsReference: vsReferenceOf(text, instanceSide),
  };
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
  const start = lines.findIndex((line) => line.trim() === '## observations');
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
