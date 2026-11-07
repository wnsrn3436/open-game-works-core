/**
 * One seed-run (ogw.md `### seed-run` of `## regress`): a side fixing one seed in the fix repo of the seed-run, in
 * iterations of a fixer job and a confirmation with the after side's checker, then the final check, the guards and the
 * diff.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { exists, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import { commitPaths, git, head } from '../../../lib/git.ts';
import type { JobRecord } from '../../../lib/jobs.ts';
import { mergedChecks } from '../../check/api.ts';
import { costRows, renderCost } from '../../loop/lib/cost.ts';
import { DEFECT_COLUMNS, defectRow, proofExemption, type Defect, type DefectsFile } from '../../loop/lib/defects.ts';
import type { FixTestProof } from '../../loop/lib/files.ts';
import { document, renderTable } from '../../loop/lib/markdown.ts';
import { reportRows } from '../../loop/lib/record.ts';
import { guardViolations } from './guards.ts';
import { cleanFor, keysOf, matching, targetChecks, type Matched, type RegressCheckFile } from './keys.ts';
import { emptyMeasures, type MeasureValues } from './measures.ts';
import type { ReportRow } from '../../loop/lib/defects.ts';
import { every, type RegressPool } from './pool.ts';
import { translationAgents } from './refresh.ts';
import type { Seed } from './repo.ts';
import { jobFacts, sideAgent, sideCheck, sideProbe, type FixerRun, type ProbeResult, type Side } from './side.ts';

export interface SeedRunInput {
  /** `<unix ms>` of the run. */
  runMs: number;
  /** The order of the seed-run in the run, from 1. */
  k: number;
  seed: Seed;
  side: Side;
  after: Side;
  repeat: number;
  /** The fix repo of the seed-run: its game name, its checkout, and the root commit of its `main`, which holds the seeded tree. */
  fix: { game: string; root: string; seeded: string };
  /** The after side's catch checks of the seed: base, seeded, and the first matching failure of the seeded check. */
  catchAfter: { base: RegressCheckFile; seeded: RegressCheckFile; seededPath: string; matched: Matched | null };
  /** The oracle folder of the seed, or null. */
  oracle: string | null;
  /** The folder of the confirmation and final checks: `<dataDir>/regress/<unix ms>/fix/<seed-run>/`. */
  work: string;
  /** Harness settings `loopStop.repeatedDefect`. */
  cap: number;
  /** Where the diff from the seeded to the final commit goes: `records/runs/<unix ms>/<seed-run>.diff` of the regress repo. */
  diff: string;
  /** The work of the run (`## regress`): the side commands of the seed-run run through it. */
  pool: RegressPool;
}

/** One iteration of a seed-run, kept in `run.json`. */
export interface SeedRunIteration {
  n: number;
  jobs: string[];
  report: string | null;
  proof: FixTestProof['result'] | null;
  found: boolean;
  confirmed: boolean;
  status: Defect['status'];
}

export interface SeedRunResult {
  /** `<seed>-<side>-<repeat>`. */
  id: string;
  seed: string;
  side: Side['name'];
  repeat: number;
  result: 'fixed' | 'not fixed' | 'unknown';
  reason: string | null;
  measures: MeasureValues;
  iterations: SeedRunIteration[];
  final: string | null;
  newDefects: string[];
  guards: string[];
}

export function seedRunId(seed: string, side: string, repeat: number): string {
  return `${seed}-${side}-${String(repeat)}`;
}

/** The records of the seed-run in the fix repo: `records/loops/regress-<unix ms>-<k>/`. */
export function seedRunRecords(runMs: number, k: number): string {
  return `regress-${String(runMs)}-${String(k)}`;
}

/** The defect of the seed in iteration 1: `row`, with `where`, `what` and `evidence` of the matching failure. */
function firstDefect(input: SeedRunInput): Defect {
  const row = input.seed.manifest.row;
  return {
    id: row.id,
    severity: row.severity,
    owner: row.owner,
    where: row.where ?? '',
    what: row.what ?? '',
    why: row.why,
    evidence: row.evidence ?? [],
    source: row.source,
    status: 'open',
    refusedReason: null,
    repeatedDefect: 0,
    oscillation: 0,
  };
}

/** `where`, `what` and `evidence` of a defect from the failure of a check file that found it. */
function fromFailure(defect: Defect, matched: Matched, checkPath: string): void {
  defect.where = matched.failure.where;
  defect.what = matched.failure.message;
  defect.evidence = [`${checkPath}#${matched.check.name}`, ...matched.failure.evidence];
}

function contentInput(previous: string | null, defect: Defect): string {
  const listed = defect.status === 'open' || defect.status === 'reopened' || defect.status === 'awaiting confirmation';
  return document([
    ['kind', 'completeness'],
    ['request', 'none'],
    ['previous record', previous ?? 'none'],
    ['defects', listed ? renderTable([...DEFECT_COLUMNS], [defectRow(defect)]) : 'none'],
  ]);
}

/** The languages of the `translation_missing` and `translation_stale` failures of a check file, in file order. */
export function translationLanguagesOf(file: RegressCheckFile): string[] {
  const languages: string[] = [];
  for (const check of file.checks) {
    if (check.name !== 'no placeholder') continue;
    for (const f of check.failures) {
      const language = /^translation_(?:missing|stale) (\S+)/.exec(f.message)?.[1];
      if (language !== undefined && !languages.includes(language)) languages.push(language);
    }
  }
  return languages;
}

interface Confirmation {
  file: RegressCheckFile | null;
  path: string;
  probe: ProbeResult | null;
  minutes: number;
  found: Matched | null;
  /** The defect was found: a matching failure, or a probe that is `fail`. */
  foundAny: boolean;
  /** The confirmation gives a result. */
  result: boolean;
}

/**
 * The check of a confirmation: the target checks, or the regression test for a seed without target checks when the fix
 * test proof is asked for, which the check gives beside its checks; null when there is nothing to check or it failed.
 */
async function confirmCheck(ctx: Context, input: SeedRunInput, commit: string, path: string, proof: string | null): Promise<{ file: RegressCheckFile | null; minutes: number }> {
  const targets = targetChecks(input.seed.manifest);
  if (targets.length === 0 && proof === null) return { file: null, minutes: 0 };
  const checks = targets.length > 0 ? targets : ['regression test'];
  const checked = await input.pool.work(() => sideCheck(ctx, input.after, { game: input.fix.game, commit, out: path, checks, performance: input.seed.manifest.performance, proof }));
  return 'file' in checked ? { file: checked.file, minutes: checked.minutes } : { file: null, minutes: 0 };
}

async function confirmProbe(ctx: Context, input: SeedRunInput, commit: string, out: string): Promise<{ probe: ProbeResult | null; minutes: number }> {
  if (input.oracle === null) return { probe: null, minutes: 0 };
  const oracle = input.oracle;
  const started = Date.now();
  const probe = await input.pool.work(() => sideProbe(ctx, input.after, { game: input.fix.game, commit, oracle, out }));
  return { probe, minutes: (Date.now() - started) / 60_000 };
}

async function confirmOnce(ctx: Context, input: SeedRunInput, commit: string, n: number, attempt: number, proof: string | null): Promise<Confirmation> {
  const seed = input.seed.manifest;
  const path = join(input.work, `check-${String(n)}${attempt > 1 ? `-${String(attempt)}` : ''}.json`);
  const hasTargets = targetChecks(seed).length > 0;
  // the check and the probe do not wait for each other
  const [{ file, minutes }, probed] = await every([confirmCheck(ctx, input, commit, path, proof), confirmProbe(ctx, input, commit, join(input.work, `probe-${String(n)}-${String(attempt)}.json`))]);
  const found = hasTargets && file !== null ? (matching(seed, file)[0] ?? null) : null;
  const checkResult = !hasTargets || (file !== null && (found !== null || cleanFor(seed, file).clean));
  const probeResult = probed.probe === null || probed.probe.result !== 'unknown';
  const foundAny = found !== null || probed.probe?.result === 'fail';
  return { file, path, probe: probed.probe, minutes: minutes + probed.minutes, found, foundAny, result: checkResult && probeResult };
}

/** The confirmation of iteration n, made once more when it gives no result. */
async function confirm(ctx: Context, input: SeedRunInput, commit: string, n: number, proof: string | null): Promise<Confirmation> {
  const first = await confirmOnce(ctx, input, commit, n, 1, proof);
  if (first.result) return first;
  const second = await confirmOnce(ctx, input, commit, n, 2, proof);
  return { ...second, minutes: first.minutes + second.minutes };
}

/** The status change of the seed's defect by the report row and the fix test proof (`## loop record`). */
function changeByReport(defect: Defect, row: { result: string; note: string } | undefined, proof: FixTestProof | undefined): void {
  if (row === undefined) return;
  if (row.result === 'not reproduced') defect.status = 'awaiting confirmation';
  else if (row.result === 'refused') {
    defect.status = 'refused';
    defect.refusedReason = row.note;
  } else if (row.result === 'fixed' && (proofExemption(defect, row.note) !== null || proof?.result === 'pass')) defect.status = 'awaiting confirmation';
}

/** The change of an `awaiting confirmation` defect by a confirmation that gave a result (`## loop record`). */
function changeByConfirmation(defect: Defect, confirmation: Confirmation): void {
  if (defect.status !== 'awaiting confirmation' || !confirmation.result) return;
  if (confirmation.foundAny) {
    defect.status = 'open';
    defect.repeatedDefect++;
  } else {
    defect.status = 'fixed';
    defect.repeatedDefect = 0;
  }
}

function iterationRecord(input: SeedRunInput, n: number, commit: string, defect: Defect, confirmation: Confirmation, jobs: readonly JobRecord[]): string {
  const checks = confirmation.file === null ? 'none' : renderTable(['check', 'result', 'file'], mergedChecks(confirmation.file.checks).map((c) => [c.name, c.result, confirmation.path]));
  const proofs = confirmation.file?.fixTestProof ?? [];
  const proofTable =
    proofs.length === 0
      ? 'none'
      : renderTable(['id', 'result', 'reason', 'tests'], proofs.map((p) => [p.id, p.result, p.reason ?? 'none', p.tests.length === 0 ? 'none' : p.tests.map((t) => `${t.name}: ${t.result}`).join(', ')]));
  return document([
    ['commit', [`- instance: ${commit}`, `- side: ${input.side.name} ${input.side.commit}`, '- kind: completeness'].join('\n')],
    ['checks', checks],
    ['defects', renderTable([...DEFECT_COLUMNS], [defectRow(defect)])],
    ['fix test proof', proofTable],
    ['cost', renderCost(costRows(jobs, false))],
  ]);
}

interface Fixed {
  run: FixerRun[];
  merged: boolean;
  failure: string | null;
}

/** An input file of a fixer: a content input, or a translation input with its language. */
interface FixerInput {
  language: string | null;
  input: string;
}

/** The fixer of iteration n: one content agent, or one translation sub-agent per language, the languages together, each merged. */
async function fix(ctx: Context, input: SeedRunInput, records: string, n: number, inputFiles: readonly FixerInput[]): Promise<Fixed> {
  const seedRun = `${records}:${String(n)}`;
  if (input.seed.manifest.fixer === 'translation') {
    const translated = await translationAgents(ctx, input.side, input.pool, input.fix.game, seedRun, inputFiles.map((f) => ({ language: f.language ?? '', input: f.input })));
    return { run: translated.runs, merged: translated.failure === null, failure: translated.failure };
  }
  const runs: FixerRun[] = [];
  for (const file of inputFiles) {
    const ran = await input.pool.work(() => sideAgent(ctx, input.side, { role: 'content', game: input.fix.game, input: file.input, seedRun }));
    runs.push(ran);
    if (ran.status !== 'done') return { run: runs, merged: false, failure: ran.reason ?? 'the content job did not end done' };
  }
  return { run: runs, merged: true, failure: null };
}

async function writeInputs(ctx: Context, input: SeedRunInput, records: string, n: number, defect: Defect): Promise<FixerInput[]> {
  const dir = join(input.fix.root, 'records', 'loops', records);
  await mkdir(dir, { recursive: true });
  const defects: DefectsFile = { defects: [defect], previous: null, recordedBy: 'ogw regress run' };
  await writeJsonAtomic(join(dir, 'defects.json'), defects);
  const files: FixerInput[] = [];
  if (input.seed.manifest.fixer === 'translation') {
    for (const language of translationLanguagesOf(input.catchAfter.seeded)) {
      const file = join(dir, `translation-input-${language}-${String(Date.now())}.md`);
      await writeFileAtomic(file, `${language}\n`);
      files.push({ language, input: file });
    }
  } else {
    const previous = n > 1 ? `records/loops/${records}/iteration-${String(n - 1)}.md` : null;
    const file = join(dir, `content-input-${String(n)}.md`);
    await writeFileAtomic(file, contentInput(previous, defect));
    files.push({ language: null, input: file });
  }
  await commitPaths(input.fix.root, [join('records', 'loops', records)], `regress ${records}: input ${String(n)}`, { env: ctx.env, noVerify: true });
  return files;
}

/** The job records `costRows` reads, from the jobs folder, which every side shares. */
async function jobRecords(ctx: Context, runs: readonly FixerRun[], role: string): Promise<{ records: JobRecord[]; minutes: number; usage: { input: number | null; cached: number | null; output: number | null; cost: number | null; turns: number | null } }> {
  const records: JobRecord[] = [];
  let minutes = 0;
  const sums: Record<'input' | 'cached' | 'output' | 'cost' | 'turns', number | null> = { input: 0, cached: 0, output: 0, cost: 0, turns: 0 };
  const add = (key: keyof typeof sums, value: number | null | undefined): void => {
    const current = sums[key];
    sums[key] = current === null || value === null || value === undefined ? null : current + value;
  };
  for (const ran of runs) {
    if (ran.job === null) continue;
    const facts = await jobFacts(ctx, ran.job);
    records.push({ meta: { role, usage: facts.usage ?? undefined } } as unknown as JobRecord);
    minutes += ((facts.endedAt ?? Date.now()) - facts.startedAt) / 60_000;
    add('input', facts.usage?.inputTokens);
    add('cached', facts.usage?.cachedTokens);
    add('output', facts.usage?.outputTokens);
    add('cost', facts.usage?.costUsd);
    add('turns', facts.usage?.turns);
  }
  return { records, minutes, usage: sums };
}

/** The `no placeholder` keys of a check file. */
function placeholderKeys(file: RegressCheckFile): Set<string> {
  return keysOf({ ...file, checks: file.checks.filter((c) => c.name === 'no placeholder') });
}

interface Tally {
  seeded: string;
  allRuns: FixerRun[];
  checkMinutes: number;
  unconfirmed: number;
  lastProof: number | null;
  claimed: boolean;
  defect: Defect;
  role: 'content' | 'translation';
  /** The last confirmation gave a result. */
  confirmed: boolean;
  /** The seed-run ended with a result (not `unknown`). */
  ended: boolean;
}

/** The content agent report of iteration n and its row of the defect; none for a translation fixer. */
async function reportOf(input: SeedRunInput, records: string, n: number, role: Tally['role'], id: string): Promise<{ path: string | null; row: ReportRow | undefined }> {
  const path = join(input.fix.root, 'records', 'loops', records, `content-${String(n)}.md`);
  if (role !== 'content' || !exists(path)) return { path: null, row: undefined };
  return { path, row: reportRows(await readFile(path, 'utf8')).get(id) };
}

/** Iteration n (`### seed-run` 1 to 5): the failure of its fixer, or null; `tally` holds what it changed. */
async function iterate(ctx: Context, input: SeedRunInput, records: string, n: number, tally: Tally, iterations: SeedRunIteration[]): Promise<string | null> {
  const defect = tally.defect;
  const files = await writeInputs(ctx, input, records, n, defect);
  const fixed = await fix(ctx, input, records, n, files);
  tally.allRuns.push(...fixed.run);
  if (fixed.failure !== null) return fixed.failure;
  const commit = await head(input.fix.root, { env: ctx.env });
  const report = await reportOf(input, records, n, tally.role, defect.id);
  const confirmation = await confirm(ctx, input, commit, n, tally.role === 'content' ? `${records}:${String(n)}` : null);
  tally.checkMinutes += confirmation.minutes;
  const proof = confirmation.file?.fixTestProof.find((p) => p.id === defect.id);
  if (tally.role === 'translation') defect.status = 'awaiting confirmation';
  else changeByReport(defect, report.row, proof);
  if (report.row?.result === 'fixed') {
    tally.claimed = true;
    if (confirmation.foundAny) tally.unconfirmed++;
    tally.lastProof = proof?.result === 'pass' ? 1 : proof?.result === 'fail' ? 0 : null;
  }
  changeByConfirmation(defect, confirmation);
  tally.confirmed = confirmation.result;
  if (confirmation.found !== null) fromFailure(defect, confirmation.found, confirmation.path);
  iterations.push({ n, jobs: fixed.run.flatMap((r) => (r.job === null ? [] : [r.job])), report: report.path, proof: proof?.result ?? null, found: confirmation.foundAny, confirmed: confirmation.result, status: defect.status });
  const facts = await jobRecords(ctx, fixed.run, tally.role);
  const recordRel = join('records', 'loops', records, `iteration-${String(n)}.md`);
  await writeFileAtomic(join(input.fix.root, recordRel), iterationRecord(input, n, commit, defect, confirmation, facts.records));
  await commitPaths(input.fix.root, [recordRel], `regress ${records}: iteration ${String(n)}`, { env: ctx.env, noVerify: true });
  return null;
}

/** Runs one seed-run; it does not throw for what a side or a check did, which makes it `unknown` with the reason. */
export async function runSeedRun(ctx: Context, input: SeedRunInput): Promise<SeedRunResult> {
  const records = seedRunRecords(input.runMs, input.k);
  const id = seedRunId(input.seed.id, input.side.name, input.repeat);
  const iterations: SeedRunIteration[] = [];
  const result: SeedRunResult = { id, seed: input.seed.id, side: input.side.name, repeat: input.repeat, result: 'unknown', reason: null, measures: emptyMeasures(), iterations, final: null, newDefects: [], guards: [] };
  await mkdir(input.work, { recursive: true });
  const defect = firstDefect(input);
  if (input.catchAfter.matched !== null) fromFailure(defect, input.catchAfter.matched, input.catchAfter.seededPath);
  const role = input.seed.manifest.fixer === 'translation' ? 'translation' : 'content';
  const tally: Tally = { seeded: input.fix.seeded, allRuns: [], checkMinutes: 0, unconfirmed: 0, lastProof: null, claimed: false, defect, role, confirmed: true, ended: false };
  try {
    for (let n = 1; n <= input.cap; n++) {
      result.reason = await iterate(ctx, input, records, n, tally, iterations);
      if (result.reason !== null || defect.status === 'fixed' || defect.status === 'refused') break;
    }
    if (result.reason === null && defect.status === 'awaiting confirmation' && !tally.confirmed) result.reason = 'the last confirmation gave no result';
    tally.ended = result.reason === null;
    return await finish(ctx, input, result, tally);
  } catch (error) {
    result.reason = `the seed-run stopped: ${(error as Error).message.split('\n')[0] as string}`;
    tally.ended = false;
    return await finish(ctx, input, result, tally).catch((finishError: unknown) => {
      result.reason = `${result.reason ?? 'the seed-run stopped'}; finishing it failed: ${(finishError as Error).message.split('\n')[0] as string}`;
      return result;
    });
  }
}

/** The final checks, the guards, the diff and the measures. */
async function finish(ctx: Context, input: SeedRunInput, result: SeedRunResult, tally: Tally): Promise<SeedRunResult> {
  const seed = input.seed.manifest;
  const m = result.measures;
  const final = await head(input.fix.root, { env: ctx.env });
  result.final = final;
  const facts = await jobRecords(ctx, tally.allRuns, tally.role);
  m['input tokens'] = facts.usage.input;
  m['cached tokens'] = facts.usage.cached;
  m['output tokens'] = facts.usage.output;
  m['cost USD'] = facts.usage.cost;
  m.turns = facts.usage.turns;
  m['agent minutes'] = facts.minutes;
  await writeFileAtomic(input.diff, await git(input.fix.root, ['diff', '--binary', tally.seeded, final], { env: ctx.env }));
  if (!tally.ended) {
    result.result = 'unknown';
    return result;
  }
  const fixedNow = tally.defect.status === 'fixed';
  result.result = fixedNow ? 'fixed' : 'not fixed';
  m.fixed = fixedNow ? 1 : 0;
  m.iterations = fixedNow ? result.iterations.length : input.cap + 1;
  m['unconfirmed claims'] = tally.unconfirmed;
  m['test first'] = tally.claimed ? tally.lastProof : null;
  result.guards = await guardViolations(ctx, input.fix.root, tally.seeded, final, seed, seed.fixer === 'translation');
  m.guards = result.guards.length;
  let checkMinutes = tally.checkMinutes;
  // the final check of the after side and the before side's own checks do not wait for each other
  const [finalCheck, own] = await every([
    input.pool.work(() => sideCheck(ctx, input.after, { game: input.fix.game, commit: final, out: join(input.work, 'final.json'), checks: null, performance: seed.performance, proof: null })),
    input.side.name === 'before' ? ownFixed(ctx, input, final) : Promise.resolve(null),
  ]);
  if ('file' in finalCheck) {
    checkMinutes += finalCheck.minutes;
    const known = new Set([...keysOf(input.catchAfter.base), ...keysOf(input.catchAfter.seeded)]);
    const placeholders = placeholderKeys(finalCheck.file);
    result.newDefects = [...keysOf(finalCheck.file)].filter((key) => !known.has(key) && !placeholders.has(key));
    m['new defects'] = result.newDefects.length;
    const seededPlaceholders = placeholderKeys(input.catchAfter.seeded);
    m.placeholders = [...placeholders].filter((key) => !seededPlaceholders.has(key)).length;
  }
  if (own !== null) {
    checkMinutes += own.minutes;
    m['own fixed'] = own.value;
  }
  m['check minutes'] = checkMinutes;
  return result;
}

/** `own fixed`: the before side's own target checks and oracle on the final commit. */
async function ownFixed(ctx: Context, input: SeedRunInput, final: string): Promise<{ value: number | null; minutes: number }> {
  const own: SeedRunInput = { ...input, after: input.side, work: join(input.work, 'own') };
  await mkdir(own.work, { recursive: true });
  const confirmation = await confirmOnce(ctx, own, final, 0, 1, null);
  if (!confirmation.result) return { value: null, minutes: confirmation.minutes };
  return { value: confirmation.foundAny ? 0 : 1, minutes: confirmation.minutes };
}
