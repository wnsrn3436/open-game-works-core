import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import type { GameRepo } from '../../../lib/game.ts';
import type { RunState } from '../../../lib/runstate.ts';
import { buildTagName, parseHardeningRecordName } from '../../build/lib/names.ts';
import { isSeverity, type Finding, type FindingsFile } from './defects.ts';
import type { CheckFile, MeasureFile } from './files.ts';
import { cell, column, parseTable, section } from './markdown.ts';
import { judgeDefects, observations, referenceRows } from './results.ts';
import { abs, confirmOf, iterationResults, readGameText, runRel } from './run.ts';

/** Finding collection of `game-loop` `## defect list`. */

function finding(fields: Partial<Finding> & Pick<Finding, 'source' | 'where' | 'what' | 'evidence'>): Finding {
  return { severity: null, owner: null, why: null, id: null, drop: null, ...fields };
}

function rowSimulationOwner(message: string): string {
  return message.trim().split(/\s+/)[0] === 'error' ? 'client content' : 'data';
}

export function checkFindings(check: CheckFile, checkPath: string): Finding[] {
  const out: Finding[] = [];
  for (const c of check.checks) {
    if (c.result !== 'fail' || c.name === 'no placeholder') continue;
    for (const f of c.failures) {
      out.push(finding({
        source: 'check',
        owner: c.name === 'row simulation' ? rowSimulationOwner(f.message) : null,
        where: f.where,
        what: f.message,
        evidence: [`${checkPath}#${c.name}`, ...f.evidence],
      }));
    }
  }
  return out;
}

export function measureFindings(measure: MeasureFile, measurePath: string): Finding[] {
  return measure.targets
    .filter((t) => t.result === 'out')
    .map((t) => finding({
      source: 'check',
      owner: t.data === null ? 'design' : 'data',
      where: t.metric,
      what: `value ${String(t.value)} out of ${String(t.min)}..${String(t.max)}`,
      evidence: [`${measurePath}#${t.metric}`],
    }));
}

export function playFindings(text: string, feedbackPath: string): Finding[] {
  return observations(text)
    .filter((o) => o.severity !== 'none')
    .map((o) => finding({
      source: 'play',
      severity: isSeverity(o.severity) ? o.severity : null,
      where: o.scene,
      what: o.input === '' ? o.happened : `${o.input} → ${o.happened}`,
      why: o.feeling === '' ? null : o.feeling,
      evidence: [...(o.capture === '' || o.capture === 'none' ? [] : [o.capture]), `${feedbackPath}:${String(o.line)}`],
    }));
}

/**
 * Findings of a judge result for this commit's side: its `## defects` rows, and its failed `## vs reference` rows
 * (`game-loop` `## defect list`). `judgePath` is the judge result path the reference findings point at.
 */
export function judgeFindings(text: string, side: 'A' | 'B', judgePath: string): Finding[] {
  const defects = judgeDefects(text)
    .filter((d) => d.instance === side)
    .map((d) => finding({
      source: 'judge',
      severity: isSeverity(d.severity) ? d.severity : null,
      where: d.where,
      what: d.what,
      why: d.why === '' ? null : d.why,
      evidence: d.evidence === '' ? [] : [d.evidence],
    }));
  const reference = referenceRows(text)
    .filter((r) => r.instance === side && r.result === 'fail')
    .map((r) => finding({
      source: 'judge',
      severity: 'major',
      where: r.element === '' ? '' : `vs reference: ${r.element}`,
      what: r.reason,
      why: 'worse than the reference game, so `vs reference` is `fail`',
      evidence: [...(r.evidence === '' ? [] : [r.evidence]), judgePath],
    }));
  return [...defects, ...reference];
}

/** Splits off findings whose `where`, `what` or `evidence` is empty. */
export function sortOut(findings: readonly Finding[]): FindingsFile {
  const kept: Finding[] = [];
  const discarded: Finding[] = [];
  for (const f of findings) (f.where.trim() === '' || f.what.trim() === '' || f.evidence.length === 0 ? discarded : kept).push(f);
  return { findings: kept, discarded };
}

/**
 * Findings of iteration `n`: its check file, and when it has an evaluate file, its measure, done plays and done judges.
 * A confirmation iteration takes only the `blocker` observations of the plays.
 */
export async function iterationFindings(game: GameRepo, run: RunState, n: number): Promise<FindingsFile> {
  const confirming = confirmOf(run, n) !== null;
  const all: Finding[] = [];
  const { checkRel, check, evaluate, measure } = await iterationResults(game, run, n);
  if (check) all.push(...checkFindings(check, checkRel));
  if (evaluate) {
    if (evaluate.measure !== null && measure) all.push(...measureFindings(measure, evaluate.measure));
    for (const play of evaluate.plays.filter((p) => p.status === 'done')) {
      const text = await readGameText(game, play.result);
      if (text !== null) all.push(...playFindings(text, play.result).filter((f) => !confirming || f.severity === 'blocker'));
    }
    for (const judge of evaluate.judges.filter((j) => j.status === 'done')) {
      const text = await readGameText(game, judge.result);
      if (text !== null) all.push(...judgeFindings(text, judge.instanceSide, judge.result));
    }
  }
  return sortOut(all);
}

/** `records/hardening/<env>-<version>-<server|client>-<round>.md` of the build run. */
export async function hardeningRecords(game: GameRepo, run: RunState): Promise<{ round: number; records: string[] }> {
  if (run.env === null || run.version === null) throw new OgwError(`run ${run.name} has no environment and version`);
  const { env, version } = run;
  const names = await readdir(join(game.root, 'records', 'hardening')).catch(() => [] as string[]);
  const found = names
    .map((name) => ({ name, parsed: parseHardeningRecordName(name, env, version) }))
    .flatMap((f) => (f.parsed === null ? [] : [{ rel: `records/hardening/${f.name}`, round: f.parsed.round }]));
  if (found.length === 0) throw new OgwError(`no hardening record of ${buildTagName(env, version)} in records/hardening/`);
  const round = Math.max(...found.map((f) => f.round));
  return { round, records: found.filter((f) => f.round === round).map((f) => f.rel).sort() };
}

/** Columns of the hardening record `## content agent fixes` table (`build` `## hardening`). */
export const CONTENT_AGENT_FIX_COLUMNS = ['file:line', 'owner', 'problem', 'task'] as const;

/** Findings from the `## content agent fixes` table of a hardening record; none when the section is `none`. */
export function hardeningFindings(text: string, recordPath: string): Finding[] {
  const table = parseTable(section(text, 'content agent fixes') ?? []);
  if (!table) return [];
  const [whereCol, ownerCol, whatCol, taskCol] = CONTENT_AGENT_FIX_COLUMNS.map((name) => column(table, name)) as [number, number, number, number];
  if (whereCol < 0 || ownerCol < 0 || whatCol < 0 || taskCol < 0) {
    throw new OgwError(`${recordPath} \`## content agent fixes\` needs the columns ${CONTENT_AGENT_FIX_COLUMNS.join(', ')}`);
  }
  return table.rows.map((row) => finding({
    source: 'hardening',
    owner: cell(row, ownerCol) === '' ? null : cell(row, ownerCol),
    where: cell(row, whereCol),
    what: cell(row, whatCol),
    evidence: [recordPath],
  }));
}

export async function collectHardeningFindings(game: GameRepo, run: RunState): Promise<{ round: number; file: FindingsFile }> {
  const { round, records } = await hardeningRecords(game, run);
  const all: Finding[] = [];
  for (const rel of records) all.push(...hardeningFindings(await readFile(abs(game, rel), 'utf8'), rel));
  return { round, file: sortOut(all) };
}

/** The most recent `findings-hardening-<round>.json` of the run. */
export async function latestHardeningFindings(game: GameRepo, run: RunState): Promise<{ round: number; rel: string } | null> {
  const names = await readdir(abs(game, runRel(run, ''))).catch(() => [] as string[]);
  const rounds = names.map((n) => /^findings-hardening-(\d+)\.json$/.exec(n)?.[1]).filter((r): r is string => r !== undefined).map(Number);
  if (rounds.length === 0) return null;
  const round = Math.max(...rounds);
  return { round, rel: runRel(run, `findings-hardening-${String(round)}.json`) };
}
