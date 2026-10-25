import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expectPositionals, flag, positional, str, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists, writeFileAtomic } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { commitPaths, showFile } from '../../lib/git.ts';
import type { RunState } from '../../lib/runstate.ts';
import { placeholderFailures } from '../check/api.ts';
import { needsHumanLines } from './lib/assumptions.ts';
import { addedCoreProposals } from '../build/lib/report-sections.ts';
import { LIST_PATH, temporaryKeys, unknownLicenseKeys } from '../resource/lib/list.ts';
import type { DefectsFile } from './lib/defects.ts';
import { checkResult, COMPLETENESS_CHECKS, mainJudge, type CheckFile, type EvaluateFile } from './lib/files.ts';
import { iterationRecords, mainOf } from './lib/iteration-record.ts';
import { document } from './lib/markdown.ts';
import { abs, coreUpgrade, loopData, openTarget, readRunJson, runRel } from './lib/run.ts';

const USAGE = 'ogw loop end-record <game> [--stopped-by-human] [--human <file>]';

/** The highest `<n>` of `records/loops/<run>/<prefix><n>.json`. */
async function lastNumbered(game: GameRepo, run: RunState, prefix: string): Promise<number | null> {
  const names = await readdir(abs(game, runRel(run, ''))).catch(() => [] as string[]);
  const numbers = names
    .map((name) => (name.startsWith(prefix) ? /^(\d+)\.json$/.exec(name.slice(prefix.length))?.[1] : undefined))
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

function bullets(lines: readonly string[]): string {
  return lines.map((line) => `- ${line}`).join('\n');
}

function oneLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '').join('; ');
}

async function mergeLines(game: GameRepo, run: RunState): Promise<string[]> {
  const prepared = loopData(run).prepareMerge;
  const commit = prepared?.commit ?? null;
  const record = commit === null ? undefined : (await iterationRecords(game, run)).filter((r) => r.commit === commit).at(-1);
  const lines = [`merge commit: ${commit ?? 'none'}`, `vs baseline: ${(record ? mainOf(record)?.vsBaseline : null) ?? 'none'}`];
  if (!prepared) lines.push('not merged: ogw loop prepare-merge has not run');
  else if (prepared.failed !== undefined) lines.push(`not merged: ogw loop prepare-merge failed: ${oneLine(prepared.failed)}`);
  else if (prepared.mainHead !== prepared.baseCommit) lines.push(`not merged: main HEAD ${prepared.mainHead} is not the work branch base ${prepared.baseCommit}`);
  else if (commit === null) lines.push('not merged: no iteration passed the gate checks with a judge not worse than the baseline game; only records/ is merged');
  return lines;
}

async function lastCheck(game: GameRepo, run: RunState): Promise<CheckFile | null> {
  const n = await lastNumbered(game, run, 'check-');
  return n === null ? null : readRunJson<CheckFile>(game, run, `check-${String(n)}.json`);
}

async function resultSection(game: GameRepo, run: RunState): Promise<string> {
  const lines = await mergeLines(game, run);
  const lastEvaluate = await lastNumbered(game, run, 'evaluate-');
  const evaluate = lastEvaluate === null ? null : await readRunJson<EvaluateFile>(game, run, `evaluate-${String(lastEvaluate)}.json`);
  lines.push(`last judge result: ${(evaluate ? mainJudge(evaluate)?.result : null) ?? 'none'}`);
  const check = await lastCheck(game, run);
  if (check) lines.push(...COMPLETENESS_CHECKS.map((name) => `${name}: ${checkResult(check, name)}`));
  else lines.push('completeness check: none');
  return bullets(lines);
}

async function failuresSection(ctx: Context, game: GameRepo, run: RunState): Promise<string> {
  const lines = (await placeholderFailures(ctx, game)).map((f) => f.message);
  const defects = await readRunJson<DefectsFile>(game, run, 'defects.json');
  for (const d of defects?.defects.filter((x) => x.status === 'open') ?? []) lines.push(`open defect ${d.id}: ${d.what}`);
  for (const task of loopData(run).tasks.filter((t) => t.gaveUp)) lines.push(`not given again ${task.input}: ${task.lastFailure ?? ''}`);
  for (const stuck of loopData(run).stuck) lines.push(`not merged ${stuck.job}: ${stuck.failure}`);
  return bullets(lines);
}

async function unknownLicenses(game: GameRepo): Promise<string[]> {
  const resources = join(game.root, LIST_PATH);
  if (!exists(resources)) return [];
  return unknownLicenseKeys(await readFile(resources, 'utf8')).map((key) => `license unknown: ${key}`);
}

/** Rows `temporary` at the commit to merge (`ogw loop prepare-merge`); none without that commit. */
async function temporaryResources(game: GameRepo, run: RunState): Promise<string[]> {
  const commit = loopData(run).prepareMerge?.commit ?? null;
  if (commit === null) return [];
  const resources = await showFile(game.root, commit, LIST_PATH);
  if (resources === null) return [];
  return temporaryKeys(resources.toString('utf8')).map((key) => `temporary resource (the next update game makes it again): ${key}`);
}

/** Languages of the `data check banned_word_missing` warnings of the last check file. */
function bannedWordLines(check: CheckFile | null): string[] {
  const warnings = check?.checks.filter((c) => c.name === 'static check').flatMap((c) => c.warnings) ?? [];
  return warnings
    .filter((w) => w.message.startsWith('data check banned_word_missing'))
    .map((w) => `banned word list missing: ${/banned-words\/([^/:]+)\.txt/.exec(w.where)?.[1] ?? w.where}`);
}

async function humanSection(game: GameRepo, run: RunState, humanFile: string | null): Promise<string> {
  const lines: string[] = [];
  const assumptions = abs(game, runRel(run, 'assumptions.md'));
  if (exists(assumptions)) lines.push(...needsHumanLines(await readFile(assumptions, 'utf8')));
  lines.push(...(await addedCoreProposals(game, run.baseCommit, run.branch)).map((p) => `core proposal: ${p}`));
  lines.push(...(await unknownLicenses(game)));
  lines.push(...(await temporaryResources(game, run)));
  lines.push(...(coreUpgrade(run)?.skipped ?? []).map((v) => `skipped core version: ${v}`));
  lines.push(...bannedWordLines(await lastCheck(game, run)));
  // One bullet per line, so a line neither joins the item above it nor becomes a heading.
  if (humanFile !== null) lines.push(...(await readFile(humanFile, 'utf8')).split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== ''));
  return bullets(lines);
}

export const loopEndRecord: CommandDef = {
  name: ['loop', 'end-record'],
  usage: USAGE,
  options: { human: { type: 'string' }, 'stopped-by-human': { type: 'boolean' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const { game, run } = await openTarget(ctx, positional(args, 0, 'game'), 'loop');
    const last = loopData(run).verdict;
    const stop = last != null && last.reason !== 'continue' && last.reason !== 'confirm' ? last : null;
    const byHuman = flag(args, 'stopped-by-human');
    if (byHuman && stop !== null) throw new OgwError(`the loop already stopped with ${stop.reason}: run without --stopped-by-human`);
    let reason: string;
    if (byHuman) {
      reason = ['stopped by human', bullets([last != null ? `last verdict: ${last.reason} (iteration ${String(last.iteration)})` : 'last verdict: none'])].join('\n\n');
    } else if (stop !== null) {
      reason = [stop.reason, bullets(stop.evidence)].filter((p) => p !== '').join('\n\n');
    } else {
      throw new OgwError('no stop reason: run ogw loop verdict until it gives a stop reason, or give --stopped-by-human when a person stopped the loop');
    }
    const humanArg = str(args, 'human');
    const humanFile = humanArg === undefined ? null : resolve(ctx.cwd, humanArg);
    if (humanFile !== null && !exists(humanFile)) throw new OgwError(`--human file not found: ${humanFile}`);
    const text = document([
      ['reason', reason],
      ['result', await resultSection(game, run)],
      ['failures', await failuresSection(ctx, game, run)],
      ['human', await humanSection(game, run, humanFile)],
    ]);
    const rel = runRel(run, 'end.md');
    await writeFileAtomic(abs(game, rel), text);
    await commitPaths(game.root, [rel], `loop ${run.name}: end record`, { env: ctx.env });
    return { text: rel, data: { path: rel } };
  },
};
