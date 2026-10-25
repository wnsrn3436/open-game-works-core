import { OgwError } from '../../../lib/errors.ts';
import { readJsonIfExists, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { commitPaths, showFile } from '../../../lib/git.ts';
import { LIST_PATH, temporaryKeys } from '../../resource/lib/list.ts';
import type { RunState } from '../../../lib/runstate.ts';
import {
  evidenceChecks,
  evidenceMetrics,
  incompleteFindings,
  recordDefects,
  type Defect,
  type DefectsFile,
  type FindingsFile,
  type ReportRow,
} from './defects.ts';
import { checkNames, checkResult, type CheckFile, type EvaluateFile, type MeasureFile } from './files.ts';
import { hardeningRecords, latestHardeningFindings } from './findings.ts';
import { iterationRecords, renderIterationRecord, type RecordJudge, type RecordPlay } from './iteration-record.ts';
import { cell, column, parseTable, section } from './markdown.ts';
import { judgeSectionText, observations } from './results.ts';
import { abs, confirmOf, iterationResults, readGameText, runRel, type IterationResults } from './run.ts';

/** `ogw loop record`: defect list merge, status change, and the loop iteration record. */

/** `## defects` rows (`id`, `result`, `note`) of the content agent report `content-<n>.md`. */
export function reportRows(report: string): Map<string, ReportRow> {
  const rows = new Map<string, ReportRow>();
  const table = parseTable(section(report, 'defects') ?? []);
  if (!table) return rows;
  const idCol = column(table, 'id');
  const resultCol = column(table, 'result');
  const noteCol = column(table, 'note');
  for (const row of table.rows) rows.set(cell(row, idCol), { result: cell(row, resultCol), note: cell(row, noteCol) });
  return rows;
}

interface Label {
  label: string;
  findingsRel: string;
  hardening: boolean;
}

async function labelOf(game: GameRepo, run: RunState, hardening: boolean): Promise<Label> {
  if (hardening) {
    if (run.kind !== 'build') throw new OgwError('--hardening is taken only in a build run');
    const latest = await latestHardeningFindings(game, run);
    if (!latest) throw new OgwError(`no findings-hardening-<round>.json in ${runRel(run, '')}`);
    const { round } = await hardeningRecords(game, run);
    if (latest.round !== round) {
      throw new OgwError(`${latest.rel} is not of the latest hardening round ${String(round)}: run ogw loop findings ${game.name} --hardening first`);
    }
    return { label: `hardening-${String(latest.round)}`, findingsRel: latest.rel, hardening };
  }
  if (run.iteration === 0) throw new OgwError(`run ${run.name} has not started an iteration`);
  return { label: `iteration-${String(run.iteration)}`, findingsRel: runRel(run, `findings-${String(run.iteration)}.json`), hardening };
}

/** Results of this record that a confirmation of `### defect status` reads. */
interface Confirmations {
  check: CheckFile | null;
  measure: MeasureFile | null;
  evaluate: EvaluateFile | null;
}

/** A check defect: a check or metric of its evidence gave a result. */
function checkConfirmed(results: Confirmations, defect: Defect): boolean {
  const checks = evidenceChecks(defect);
  const metrics = evidenceMetrics(defect);
  const checked = results.check?.checks.some((c) => checks.includes(c.name) && (c.result === 'pass' || c.result === 'fail')) ?? false;
  const measured = results.measure?.targets.some((t) => metrics.includes(t.metric) && (t.result === 'in' || t.result === 'out')) ?? false;
  return checked || measured;
}

/**
 * True when this record's confirmation of the defect gave a result (`### defect status`). A confirmation iteration
 * (`confirming`) takes only blocker play findings, so for another play defect it gives a result only when this record
 * has a finding of its id (`found`), and like any play confirmation only with a done play.
 */
export function confirmedBy(results: Confirmations, hardening: boolean, defect: Defect, confirming = false, found = false): boolean {
  if (hardening || defect.source === 'hardening') return hardening && defect.source === 'hardening';
  if (confirming && defect.source === 'play' && defect.severity !== 'blocker' && !found) return false;
  if (defect.source === 'check') return checkConfirmed(results, defect);
  const entries: { status: string }[] = (defect.source === 'play' ? results.evaluate?.plays : results.evaluate?.judges) ?? [];
  return entries.some((e) => e.status === 'done');
}

async function judgesOf(game: GameRepo, evaluate: EvaluateFile): Promise<RecordJudge[]> {
  const out: RecordJudge[] = [];
  for (const judge of evaluate.judges) {
    const body = await readGameText(game, judge.result);
    out.push({
      ...judge,
      moments: body === null ? 'none' : judgeSectionText(body, 'moments'),
      loserBetter: body === null ? 'none' : judgeSectionText(body, 'loser better'),
    });
  }
  return out;
}

async function playsOf(game: GameRepo, evaluate: EvaluateFile): Promise<RecordPlay[]> {
  const out: RecordPlay[] = [];
  for (const play of evaluate.plays) {
    const counts = { blocker: 0, major: 0, minor: 0, none: 0 };
    const body = await readGameText(game, play.result);
    for (const o of body === null ? [] : observations(body)) {
      if (o.severity in counts) counts[o.severity as keyof typeof counts]++;
    }
    out.push({ result: play.result, counts });
  }
  return out;
}

async function temporaryAt(game: GameRepo, commit: string): Promise<string[]> {
  const bytes = await showFile(game.root, commit, LIST_PATH);
  return bytes === null ? [] : temporaryKeys(bytes.toString('utf8'));
}

/** Keys `temporary` at the instance commit and not at that of the previous iteration (the base commit for iteration 1). */
async function newTemporary(game: GameRepo, run: RunState, commit: string | null): Promise<string[]> {
  if (commit === null) return [];
  const previous = (await iterationRecords(game, run)).filter((r) => r.iteration < run.iteration && r.commit !== null).at(-1)?.commit ?? run.baseCommit;
  const before = new Set(await temporaryAt(game, previous));
  return (await temporaryAt(game, commit)).filter((key) => !before.has(key));
}

async function writeIterationRecord(game: GameRepo, run: RunState, results: IterationResults, defects: Defect[]): Promise<string> {
  const n = String(run.iteration);
  const { checkRel, check, evaluate, measure } = results;
  const performanceFailed = check !== null && checkResult(check, 'performance') === 'fail';
  const rel = runRel(run, `iteration-${n}.md`);
  await writeFileAtomic(abs(game, rel), renderIterationRecord({
    commit: check?.commit ?? null,
    baseline: evaluate?.baseline ?? null,
    confirms: confirmOf(run, run.iteration),
    checks: check ? checkNames(check).map((name) => ({ name, result: checkResult(check, name), path: checkRel })) : [],
    judges: evaluate ? await judgesOf(game, evaluate) : null,
    plays: evaluate ? await playsOf(game, evaluate) : null,
    defects,
    measurements: measure?.targets ?? null,
    load: performanceFailed
      ? check.checks.filter((c) => c.name === 'performance').map((c) => ({ platform: c.platform, hostLoad: c.hostLoad ?? null }))
      : null,
    temporary: await newTemporary(game, run, check?.commit ?? null),
  }));
  return rel;
}

export interface RecordResult {
  defects: string;
  record: string | null;
  label: string;
}

/** Records the finding file of this iteration (or with `hardening`, the latest hardening round) into the defect list. */
export async function recordFindings(game: GameRepo, run: RunState, hardening: boolean): Promise<RecordResult> {
  const label = await labelOf(game, run, hardening);
  const findings = await readJsonIfExists<FindingsFile>(abs(game, label.findingsRel));
  if (!findings) throw new OgwError(`finding file missing: ${label.findingsRel}`);
  const incomplete = incompleteFindings(findings.findings);
  if (incomplete.length > 0) {
    const what = 'findings without id, severity, owner or why, with a non-kebab-case id or an owner not in the defect list, or with a blank drop';
    throw new OgwError(`${what}:\n${JSON.stringify(incomplete, null, 2)}`, 1, {
      findings: incomplete,
    });
  }
  const defectsRel = runRel(run, 'defects.json');
  const existing = await readJsonIfExists<DefectsFile>(abs(game, defectsRel));
  const base = existing && existing.recordedBy === label.label ? existing.previous : existing;
  const report = hardening ? null : reportRows((await readGameText(game, runRel(run, `content-${String(run.iteration)}.md`))) ?? '');
  const results: IterationResults = hardening
    ? { checkRel: '', check: null, evaluate: null, measure: null }
    : await iterationResults(game, run, run.iteration);
  const confirming = !hardening && confirmOf(run, run.iteration) !== null;
  // in a confirmation iteration a finding of the defect's id is a result also for a play defect that is not a blocker
  const found = new Set(findings.findings.filter((f) => f.drop === null).map((f) => f.id).filter((id): id is string => typeof id === 'string'));
  const confirmed = (defect: Defect): boolean => confirmedBy(results, hardening, defect, confirming, found.has(defect.id));
  const defects = recordDefects({ base: base?.defects ?? [], findings: findings.findings, confirmed, report });
  const previous = base ? { ...base, previous: null } : null;
  await writeJsonAtomic(abs(game, defectsRel), { defects, previous, recordedBy: label.label } satisfies DefectsFile);
  const record = hardening ? null : await writeIterationRecord(game, run, results, defects);
  await commitPaths(game.root, [defectsRel, label.findingsRel, ...(record ? [record] : [])], `loop ${run.name}: record ${label.label}`);
  return { defects: defectsRel, record, label: label.label };
}
