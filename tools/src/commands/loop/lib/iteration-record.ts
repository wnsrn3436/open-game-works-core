import { readdir, readFile } from 'node:fs/promises';
import type { GameRepo } from '../../../lib/game.ts';
import { gitRaw } from '../../../lib/git.ts';
import { LIMITS } from '../../../lib/limits.ts';
import type { RunState } from '../../../lib/runstate.ts';
import { DEFECT_COLUMNS, defectRow, type Defect } from './defects.ts';
import { GATE_CHECKS, type JudgeEntry, type MeasureTarget, type VsBaseline, type VsReference } from './files.ts';
import { cell, column, document, parseTable, renderTable, section } from './markdown.ts';
import { abs, runRel } from './run.ts';

/** Loop iteration record `records/loops/<run>/iteration-<n>.md` (`game-loop` `## loop iteration record`). */

export interface RecordJudge extends Pick<JudgeEntry, 'kind' | 'result' | 'A' | 'B' | 'vsBaseline' | 'vsReference' | 'omittedMoments' | 'status'> {
  moments: string;
  loserBetter: string;
}

export interface RecordPlay {
  result: string;
  counts: Record<'blocker' | 'major' | 'minor' | 'none', number>;
}

export interface IterationRecordData {
  commit: string | null;
  baseline: string | null;
  /** The candidate iteration this confirmation iteration confirms; null for any other iteration. */
  confirms: number | null;
  checks: { name: string; result: string; path: string }[];
  /** null when steps 3 and 4 did not run. */
  judges: RecordJudge[] | null;
  plays: RecordPlay[] | null;
  defects: Defect[];
  measurements: MeasureTarget[] | null;
  /** null when the `performance` check did not fail. */
  load: { platform: string | null; hostLoad: unknown }[] | null;
}

function judgeBlock(judge: RecordJudge): string {
  return [
    `### ${judge.result}`,
    '',
    `- kind: ${judge.kind}`,
    `- status: ${judge.status}`,
    `- A: ${judge.A}`,
    `- B: ${judge.B ?? 'none'}`,
    `- vs baseline: ${judge.vsBaseline ?? 'none'}`,
    `- vs reference: ${judge.vsReference}`,
    `- omitted moments: ${judge.omittedMoments.length > 0 ? judge.omittedMoments.join(', ') : 'none'}`,
    '',
    '#### moments',
    '',
    judge.moments.trim() === '' ? 'none' : judge.moments.trim(),
    '',
    '#### loser better',
    '',
    judge.loserBetter.trim() === '' ? 'none' : judge.loserBetter.trim(),
  ].join('\n');
}

export function renderIterationRecord(data: IterationRecordData): string {
  const checks = data.checks.length > 0
    ? renderTable(['check', 'result', 'file'], data.checks.map((c) => [c.name, c.result, c.path]))
    : 'none';
  const judge = data.judges ? data.judges.map(judgeBlock).join('\n\n') : 'none';
  const play = data.plays
    ? renderTable(['feedback', 'blocker', 'major', 'minor', 'none'], data.plays.map((p) => [
      p.result, String(p.counts.blocker), String(p.counts.major), String(p.counts.minor), String(p.counts.none),
    ]))
    : 'none';
  const defects = data.defects.length > 0 ? renderTable([...DEFECT_COLUMNS], data.defects.map(defectRow)) : 'none';
  const measurements = data.measurements && data.measurements.length > 0
    ? renderTable(['metric', 'value', 'range', 'result'], data.measurements.map((t) => [
      t.metric, t.value === null ? 'none' : String(t.value), `${String(t.min)}..${String(t.max)}`, t.result,
    ]))
    : 'none';
  const load = data.load
    ? renderTable(['platform', 'hostLoad'], data.load.map((l) => [l.platform ?? 'none', JSON.stringify(l.hostLoad ?? null)]))
    : 'none';
  return document([
    ['commit', `- instance: ${data.commit ?? 'none'}\n- baseline: ${data.baseline ?? 'none'}\n- confirms: ${data.confirms === null ? 'none' : String(data.confirms)}`],
    ['checks', checks],
    ['judge', judge],
    ['play', play],
    ['defects', defects],
    ['measurements', measurements],
    ['load', load],
  ]);
}

export interface ParsedJudge {
  /** The judge result path of the `### <path>` heading; empty for a judge without one. */
  result: string;
  kind: string;
  status: string;
  vsBaseline: VsBaseline | null;
  vsReference: VsReference;
}

export interface ParsedRecord {
  iteration: number;
  path: string;
  commit: string | null;
  /** The candidate iteration of a confirmation iteration; null for any other iteration. */
  confirms: number | null;
  checks: Map<string, string>;
  /** null when `## judge` is `none`. */
  judges: ParsedJudge[] | null;
  /** Sum of the `blocker` column of `## play`; 0 when it is `none`. */
  playBlockers: number;
}

function bullet(lines: readonly string[], key: string): string | null {
  const prefix = `- ${key}: `;
  const line = lines.find((l) => l.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim();
}

function parseJudges(lines: readonly string[]): ParsedJudge[] | null {
  if (lines.every((l) => l.trim() === '' || l.trim() === 'none')) return null;
  const judges: ParsedJudge[] = [];
  let block: string[] | null = null;
  let result = '';
  const flush = (): void => {
    if (!block) return;
    const vsBaseline = bullet(block, 'vs baseline');
    judges.push({
      result,
      kind: bullet(block, 'kind') ?? '',
      status: bullet(block, 'status') ?? '',
      vsBaseline: vsBaseline === null || vsBaseline === 'none' ? null : (vsBaseline as VsBaseline),
      vsReference: (bullet(block, 'vs reference') ?? 'unknown') as VsReference,
    });
  };
  for (const line of lines) {
    if (line.startsWith('### ') || line === '###') {
      flush();
      result = line.slice(4).trim();
      block = [];
    } else if (block && !line.startsWith('#### ')) {
      block.push(line);
    }
  }
  flush();
  return judges;
}

export function parseIterationRecord(text: string, iteration: number, path: string): ParsedRecord {
  const commitLines = section(text, 'commit') ?? [];
  const commit = bullet(commitLines, 'instance');
  const checks = new Map<string, string>();
  const table = parseTable(section(text, 'checks') ?? []);
  if (table) {
    const nameCol = column(table, 'check');
    const resultCol = column(table, 'result');
    for (const row of table.rows) checks.set(cell(row, nameCol), cell(row, resultCol));
  }
  const confirms = bullet(commitLines, 'confirms');
  const play = parseTable(section(text, 'play') ?? []);
  const blockerCol = play ? column(play, 'blocker') : -1;
  const playBlockers = play && blockerCol >= 0 ? play.rows.reduce((sum, row) => sum + (Number(cell(row, blockerCol)) || 0), 0) : 0;
  return {
    iteration,
    path,
    commit: commit === null || commit === 'none' ? null : commit,
    confirms: confirms === null || confirms === 'none' || !/^[0-9]+$/.test(confirms) ? null : Number(confirms),
    checks,
    judges: parseJudges(section(text, 'judge') ?? []),
    playBlockers,
  };
}

/** Iteration numbers of the `iteration-<n>.md` names, in iteration order. */
function recordNumbers(names: readonly string[]): number[] {
  return names
    .map((name) => /^iteration-(\d+)\.md$/.exec(name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * Paths of the iteration records committed on the run branch, in iteration order, whatever branch the checkout is on.
 * Empty when the branch does not exist.
 */
export async function committedRecordPaths(game: GameRepo, run: RunState, env: NodeJS.ProcessEnv): Promise<string[]> {
  const dir = runRel(run, '');
  const result = await gitRaw(game.root, ['ls-tree', '--name-only', `refs/heads/${run.branch}`, '--', dir], { env, timeoutMs: LIMITS.shortMs });
  if (result.code !== 0) return [];
  const names = result.stdout.split('\n').filter((line) => line.startsWith(dir)).map((line) => line.slice(dir.length));
  return recordNumbers(names).map((n) => runRel(run, `iteration-${String(n)}.md`));
}

/** Iteration records of the run that exist in the checkout, in iteration order. */
export async function iterationRecords(game: GameRepo, run: RunState): Promise<ParsedRecord[]> {
  const dir = abs(game, runRel(run, ''));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const numbers = recordNumbers(names);
  const records: ParsedRecord[] = [];
  for (const n of numbers) {
    const rel = runRel(run, `iteration-${String(n)}.md`);
    records.push(parseIterationRecord(await readFile(abs(game, rel), 'utf8'), n, rel));
  }
  return records;
}

export function mainOf(record: ParsedRecord): ParsedJudge | null {
  return record.judges?.find((j) => j.kind === 'main') ?? null;
}

export function gatePassed(record: ParsedRecord): boolean {
  return GATE_CHECKS.every((name) => record.checks.get(name) === 'pass');
}
