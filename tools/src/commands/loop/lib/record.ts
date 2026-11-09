import { OgwError } from '../../../lib/errors.ts';
import { readJsonIfExists, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { commitPaths, showFile } from '../../../lib/git.ts';
import { LIST_PATH, temporaryKeys } from '../../resource/lib/list.ts';
import type { RunState } from '../../../lib/runstate.ts';
import {
  evidenceChecks,
  fillFromSameId,
  incompleteFindings,
  iterationLabel,
  recordBase,
  recordDefects,
  type Defect,
  type DefectsFile,
  type FindingsFile,
  type RecordInput,
  type ReportRow,
} from './defects.ts';
import { costRows, runAgentJobs } from './cost.ts';
import { runTimeSection } from '../../time/api.ts';
import { checkNames, checkResult, type CheckFile, type EvaluateFile, type IterationKind, type JudgeEntry } from './files.ts';
import { hardeningRecords, latestHardeningFindings } from './findings.ts';
import { iterationRecords, renderIterationRecord, type IterationRecordData, type RecordJudge, type RecordPlay, type RecordVariant, type RecordVotes } from './iteration-record.ts';
import { cell, column, parseTable, section } from './markdown.ts';
import { judgeSectionText, observations } from './results.ts';
import { abs, confirmOf, iterationKind, iterationResults, readGameText, readRunJson, runRel, type IterationResults } from './run.ts';
import type { VariantsFile } from './variants.ts';
import { harnessHead, harnessLine } from './harness-pin.ts';

/** `ogw loop record`: defect list merge, status change, and the loop iteration record. */

/** `## defects` rows (`id`, `result`, `note`) of the content agent report `content-<n>.md`. */
export function reportRows(report: string): Map<string, ReportRow> {
  return readReportRows(report).rows;
}

/** The `result` cells of `## defects` of the content agent report (`agents/content.md` `## report`). */
const REPORT_RESULTS = ['fixed', 'refused', 'not reproduced', 'not done'];
const REPORT_COLUMNS = ['id', 'result', 'note'];

/**
 * `reportRows`, with each way `## defects` is not in the form of `agents/content.md` `## report` in `errors` (ogw.md
 * `### result format` of `## agent`): missing, neither `none` nor a table with its columns, or a `result` it does not have.
 */
export function readReportRows(report: string): { rows: Map<string, ReportRow>; errors: string[] } {
  const rows = new Map<string, ReportRow>();
  const lines = section(report, 'defects');
  if (lines === null) return { rows, errors: ['`## defects` is missing'] };
  const table = parseTable(lines);
  if (!table) {
    const body = lines.map((line) => line.trim()).filter((line) => line !== '');
    const none = body.length === 1 && /^none\b/.test(body[0] as string);
    return { rows, errors: none ? [] : [`\`## defects\` is neither \`none\` nor a table with the columns ${REPORT_COLUMNS.join(', ')}`] };
  }
  const [idCol, resultCol, noteCol] = REPORT_COLUMNS.map((name) => column(table, name)) as [number, number, number];
  const errors = idCol < 0 || resultCol < 0 || noteCol < 0 ? [`\`## defects\` columns missing: it needs ${REPORT_COLUMNS.join(', ')}`] : [];
  for (const row of table.rows) {
    const result = cell(row, resultCol);
    if (resultCol >= 0 && !REPORT_RESULTS.includes(result)) errors.push(`\`## defects\` row ${cell(row, idCol)}: result \`${result}\` is not one of ${REPORT_RESULTS.join(', ')}`);
    rows.set(cell(row, idCol), { result, note: cell(row, noteCol) });
  }
  return { rows, errors };
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
  return { label: iterationLabel(run.iteration), findingsRel: runRel(run, `findings-${String(run.iteration)}.json`), hardening };
}

/** Results of this record that a confirmation of ogw.md `## loop record` reads. */
interface Confirmations {
  check: CheckFile | null;
  evaluate: EvaluateFile | null;
}

/** A check defect: a check of its evidence gave a result. */
function checkConfirmed(results: Confirmations, defect: Defect): boolean {
  const checks = evidenceChecks(defect);
  return results.check?.checks.some((c) => checks.includes(c.name) && (c.result === 'pass' || c.result === 'fail')) ?? false;
}

/**
 * True when this record's confirmation of the defect gave a result (ogw.md `## loop record`). A confirmation iteration
 * (`confirming`) takes only blocker play findings, so for another play defect it gives a result only when this record
 * has a finding of its id (`found`), and like any play confirmation only with a done play. A judge defect is confirmed
 * only by a completeness iteration: a fun judge sees three elements, no reference and no moments.
 */
export function confirmedBy(results: Confirmations, hardening: boolean, defect: Defect, confirming = false, found = false): boolean {
  if (hardening || defect.source === 'hardening') return hardening && defect.source === 'hardening';
  if (confirming && defect.source === 'play' && defect.severity !== 'blocker' && !found) return false;
  if (defect.source === 'check') return checkConfirmed(results, defect);
  return defect.source === 'play' ? playConfirmed(results) : judgeConfirmed(results);
}

function playConfirmed(results: Confirmations): boolean {
  return results.evaluate?.plays.some((p) => p.status === 'done') ?? false;
}

/** A judge defect: a done judge of a completeness iteration. */
function judgeConfirmed(results: Confirmations): boolean {
  const evaluate = results.evaluate;
  return evaluate !== null && evaluate.kind !== 'fun' && evaluate.judges.some((j) => j.status === 'done');
}

async function judgesOf(game: GameRepo, evaluate: EvaluateFile): Promise<RecordJudge[]> {
  const out: RecordJudge[] = [];
  for (const judge of evaluate.judges) {
    const body = await readGameText(game, judge.result);
    out.push({
      ...judge,
      agent: (judge as Partial<JudgeEntry>).agent ?? null,
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

/** The iteration kind: that of the evaluate file, else the one `ogw loop next` kept. */
function kindOf(run: RunState, evaluate: EvaluateFile | null): IterationKind {
  return evaluate?.kind ?? iterationKind(run, run.iteration);
}

/** `## votes`: the step 4 judges together; null without a baseline game or an evaluate file. */
function votesOf(evaluate: EvaluateFile | null): RecordVotes | null {
  if (evaluate === null || evaluate.baseline === null) return null;
  return { vsBaseline: evaluate.vsBaseline, vsReference: evaluate.vsReference, elements: evaluate.votes ?? [] };
}

/** `## variants`: the variants of `variants-<n>.json`; null without that file. */
async function variantsOf(game: GameRepo, run: RunState): Promise<RecordVariant[] | null> {
  return (await readRunJson<VariantsFile>(game, run, `variants-${String(run.iteration)}.json`))?.variants ?? null;
}

/** `## checks` of the iteration record: one row per check name of the check file. */
function checkRows(check: CheckFile | null, checkRel: string): IterationRecordData['checks'] {
  return check === null ? [] : checkNames(check).map((name) => ({ name, result: checkResult(check, name), path: checkRel }));
}

async function writeIterationRecord(game: GameRepo, run: RunState, results: IterationResults, defects: Defect[], env: NodeJS.ProcessEnv): Promise<string> {
  const n = String(run.iteration);
  const { checkRel, check, evaluate, measure } = results;
  const rel = runRel(run, `iteration-${n}.md`);
  const variants = await variantsOf(game, run);
  await writeFileAtomic(abs(game, rel), renderIterationRecord({
    commit: check?.commit ?? null,
    baseline: evaluate?.baseline ?? null,
    confirms: confirmOf(run, run.iteration),
    kind: kindOf(run, evaluate),
    harness: harnessLine(run, run.iteration, await harnessHead(env)),
    variants,
    checks: checkRows(check, checkRel),
    judges: evaluate ? await judgesOf(game, evaluate) : null,
    votes: votesOf(evaluate),
    plays: evaluate ? await playsOf(game, evaluate) : null,
    defects,
    measurements: measure?.targets ?? null,
    temporary: await newTemporary(game, run, check?.commit ?? null),
    cost: costRows(await runAgentJobs(env, game.name, run.name, run.iteration), false),
    time: await runTimeSection(env, game, run, run.iteration),
  }));
  return rel;
}

export interface RecordResult {
  defects: string;
  record: string | null;
  label: string;
}

/** The defect list this record starts from (`recordBase`). */
async function baseDefects(game: GameRepo, defectsRel: string, label: string): Promise<DefectsFile | null> {
  return recordBase(await readJsonIfExists<DefectsFile>(abs(game, defectsRel)), label);
}

/**
 * What this record decides the status changes by (ogw.md `## loop record`): the content agent report, and the
 * confirmations by the iteration results. A hardening record has neither report nor iteration results.
 */
async function recordInputOf(game: GameRepo, run: RunState, hardening: boolean): Promise<{ results: IterationResults; input: Omit<RecordInput, 'base' | 'findings'> }> {
  if (hardening) {
    const none: IterationResults = { checkRel: '', check: null, evaluate: null, measure: null };
    return { results: none, input: { report: null, confirmed: (defect) => confirmedBy(none, true, defect) } };
  }
  const report = reportRows((await readGameText(game, runRel(run, `content-${String(run.iteration)}.md`))) ?? '');
  const results = await iterationResults(game, run, run.iteration);
  // in a confirmation iteration a finding of the defect's id is a result also for a play defect that is not a blocker
  const confirming = confirmOf(run, run.iteration) !== null;
  return { results, input: { report, confirmed: (defect, found) => confirmedBy(results, false, defect, confirming, found) } };
}

/**
 * Records the finding file of this iteration (or with `hardening`, the latest hardening round) into the defect list.
 * `env` finds the agent jobs of the iteration for `## cost`.
 */
export async function recordFindings(game: GameRepo, run: RunState, hardening: boolean, env: NodeJS.ProcessEnv = process.env): Promise<RecordResult> {
  const label = await labelOf(game, run, hardening);
  const file = await readJsonIfExists<FindingsFile>(abs(game, label.findingsRel));
  if (!file) throw new OgwError(`finding file missing: ${label.findingsRel}`);
  const defectsRel = runRel(run, 'defects.json');
  const base = await baseDefects(game, defectsRel, label.label);
  const findings: FindingsFile = { ...file, findings: fillFromSameId(file.findings, base?.defects ?? []) };
  const incomplete = incompleteFindings(findings.findings);
  if (incomplete.length > 0) {
    const what = 'findings without id, severity, owner or why, with a non-kebab-case id or an owner not in the defect list, or with a blank drop';
    throw new OgwError(`${what}:\n${JSON.stringify(incomplete, null, 2)}`, 1, {
      findings: incomplete,
    });
  }
  const { results, input } = await recordInputOf(game, run, hardening);
  const defects = recordDefects({ ...input, base: base?.defects ?? [], findings: findings.findings });
  const previous = base ? { ...base, previous: null } : null;
  await writeJsonAtomic(abs(game, defectsRel), { defects, previous, recordedBy: label.label } satisfies DefectsFile);
  const record = hardening ? null : await writeIterationRecord(game, run, results, defects, env);
  await commitPaths(game.root, [defectsRel, label.findingsRel, ...(record ? [record] : [])], `loop ${run.name}: record ${label.label}`);
  return { defects: defectsRel, record, label: label.label };
}
