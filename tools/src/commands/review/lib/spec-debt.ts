import { isAbsolute, relative } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { exists, readText, writeFileAtomic } from '../../../lib/fsx.ts';
import { privateTempPath } from '../../../lib/secret-files.ts';
import { markdownSection } from '../../agent/lib/prompt.ts';
import { changeAgentMeta, readAgentJob, resultFile } from '../../agent/lib/meta.ts';
import { changeLists, checkoutLine, specDebtTarget, specDebtTargetOf } from './debt.ts';
import { inputListIds, inputWhole, parseReviewInput, targetSlug } from './input.ts';
import { debtMismatch, parseReviewFile, type Finding, type ReviewFile } from './review-file.ts';

/** Folder of `ogw-temp/` that keeps the review file of each module's last spec review; `ogw review clear core` removes it. */
const LAST_FOLDER = 'ogw-review-spec-last';

/** The path that keeps the review file of the last spec review of `module` (it may not exist). */
export async function lastSpecReviewPath(module: string, env: NodeJS.ProcessEnv): Promise<string> {
  return privateTempPath(LAST_FOLDER, `${targetSlug(module)}.md`, env);
}

/** The path that keeps the input round of the last spec review of `module` (it may not exist). */
export async function lastSpecRoundPath(module: string, env: NodeJS.ProcessEnv): Promise<string> {
  return privateTempPath(LAST_FOLDER, `${targetSlug(module)}.round`, env);
}

/** The review file text without the `## findings` rows of `ids`. */
function withoutFindings(text: string, ids: ReadonlySet<string>): string {
  if (ids.size === 0) return text;
  const start = text.indexOf('## findings');
  const end = text.indexOf('\n## ', start + 1);
  const section = text.slice(start, end === -1 ? text.length : end);
  // an id cell is read as `parseReviewFile` reads it: without surrounding code span backticks
  const idOf = (line: string): string | null => /^\|\s*`?(R\d+-\d+)`?\s*\|/.exec(line)?.[1] ?? null;
  const kept = section.split('\n').filter((line) => !ids.has(idOf(line) ?? ''));
  const rows = kept.filter((line) => idOf(line) !== null);
  // a findings table left without rows is `none`
  const body = rows.length === 0 ? ['## findings', '', 'none', ''] : kept;
  return text.slice(0, start) + body.join('\n') + (end === -1 ? '' : text.slice(end));
}

/** The ids the `## previous` rows of a review must have: the finding ids of the input's `## previous review` file. */
async function previousIds(input: string): Promise<string[] | null> {
  const path = (markdownSection(input, 'previous review') ?? '').split('\n').slice(1).join('\n').trim();
  if (path === '' || path === 'none' || !exists(path)) return null;
  return parseReviewFile(await readText(path), { low: true })?.findings.map((f) => f.id) ?? [];
}

/** The file of a unified diff and the line ranges `[first, last]` of its hunks on the new side. */
interface DiffScope {
  file: string;
  ranges: [number, number][];
}

/** The new-side file and hunk line ranges of a one-file `git diff`; null for an empty diff. */
export function diffScope(diff: string): DiffScope | null {
  const file = /^\+\+\+ b\/(.+)$/m.exec(diff)?.[1];
  if (file === undefined) return null;
  const ranges: [number, number][] = [];
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const first = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    // a hunk that only removes lines sits between its new-side line and the next one
    ranges.push([first, first + Math.max(count, 1) - (count === 0 ? 0 : 1)]);
  }
  return { file, ranges };
}

/** Whether a finding's location (`<file>:<line>`, the file relative to `harness` or under one of `roots`) is a line of a hunk. */
function inScope(location: string, scope: DiffScope, roots: readonly string[]): boolean {
  const match = /^(.*):(\d+)$/.exec(location.trim());
  if (!match) return false;
  const file = match[1] as string;
  const line = Number(match[2]);
  const rel = isAbsolute(file) ? roots.map((root) => relative(root, file)).find((r) => !r.startsWith('..') && !isAbsolute(r)) : file.replace(/^\.\//, '');
  return rel === scope.file && scope.ranges.some(([first, last]) => line >= first && line <= last);
}

/** The `## spec changes` diff of a spec review input with `--since`: its scope, or null for `none` or an empty diff. */
async function inputScope(input: string): Promise<DiffScope | null> {
  const path = (markdownSection(input, 'spec changes') ?? '').split('\n').slice(1).join('\n').trim();
  if (path === '' || path === 'none' || !exists(path)) return null;
  return diffScope(await readText(path));
}

/** The out of scope line of a finding: `<location>: <severity> <evidence>`. */
function asOutOfScope(f: Finding): string {
  return `${f.location}: ${f.severity} ${f.evidence}`;
}

/** Why a spec review file cannot be taken, or null: its form, its list answers, or its `## previous` ids. */
async function reviewMismatch(file: ReviewFile | null, input: string): Promise<string | null> {
  if (file === null) return 'not in the review file format';
  const listMismatch = debtMismatch(file, inputListIds(input));
  if (listMismatch !== null) return listMismatch;
  const expected = await previousIds(input);
  const answered = file.previous.map((p) => p.id);
  if (expected === null || (answered.length === expected.length && expected.every((e) => answered.includes(e)))) return null;
  return `## previous answers ${answered.join(', ') || 'none'}, not the findings ${expected.join(', ') || 'none'} of the previous review`;
}

/** Keeps the review file, without the findings of `moved`, and its input round as the module's last spec review. */
async function keepLastReview(ctx: Context, module: string, output: string, input: string, moved: readonly Finding[]): Promise<void> {
  await writeFileAtomic(await lastSpecReviewPath(module, ctx.env), withoutFindings(await readText(output), new Set(moved.map((f) => f.id))));
  await writeFileAtomic(await lastSpecRoundPath(module, ctx.env), `${String(parseReviewInput(input).round)}\n`);
}

/**
 * After a spec review agent job ended (`ogw agent wait`): writes its review file's change to the spec review lists
 * (`core` command.md `## review lists`), once per job, and keeps the review file, without the findings it moved, as the
 * module's last spec review. A review whose `## previous` ids are not the finding ids of its previous review fails. In a
 * review of the changes (`--since`), a finding whose location is not a line of a hunk of the diff goes to the lists as
 * an out of scope line, with a `finding outside the spec changes: <id>` line. Returns the output lines, or null for a
 * job that is not a spec review. A review file not in the review file form gives an error line, and nothing is written.
 */
export async function recordSpecDebt(ctx: Context, id: string): Promise<{ lines: string[]; error: boolean } | null> {
  const { meta } = await readAgentJob(id, ctx.env);
  if (meta.role !== 'review' || meta.review?.side !== 'spec') return null;
  if (Array.isArray(meta.debtLines)) return { lines: meta.debtLines, error: false };
  const output = resultFile(meta);
  const input = await readText(meta.input);
  const file = output !== null && exists(output) ? parseReviewFile(await readText(output), { low: inputWhole(input) }) : null;
  const mismatch = await reviewMismatch(file, input);
  if (output === null || file === null || mismatch !== null) return { lines: [`review file ${output ?? 'none'}: ${mismatch ?? ''}`], error: true };
  const module = meta.review.target;
  // a location in the review agent's worktree is kept as a harness path
  const harness = (await ctx.workspace()).harness;
  const roots = [meta.folder, harness].filter((root): root is string => typeof root === 'string');
  // a finding of a review of the changes outside every hunk of that diff is not a finding: it goes to the debt list
  const scope = await inputScope(input);
  const outside = scope === null ? [] : file.findings.filter((f) => !inScope(f.location, scope, roots));
  const lines = [...file.outOfScope, ...outside.map(asOutOfScope)].map((line) => checkoutLine(line, roots));
  const add = await Promise.all(lines.map(async (line) => ({ line, target: await specDebtTargetOf(ctx, line, module) })));
  const gone = (rows: typeof file.debt): string[] => rows.filter((row) => row.result !== 'open').map((row) => row.id);
  const remove = { target: specDebtTarget(module), debt: gone(file.debt), mustFix: gone(file.mustFix) };
  const changed = [
    ...outside.map((f) => `finding outside the spec changes: ${f.id}`),
    ...(await changeLists(ctx, 'core', { add, remove, foundBy: specDebtTarget(module) })),
  ];
  // the next spec review answers this review's findings, without the ones that went to the debt list
  await keepLastReview(ctx, module, output, input, outside);
  await changeAgentMeta(id, ctx.env, (m) => {
    m.debtLines = changed;
  });
  return { lines: changed, error: false };
}
