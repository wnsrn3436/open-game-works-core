import type { Context } from '../../../lib/command.ts';
import { exists, readText } from '../../../lib/fsx.ts';
import { changeAgentMeta, readAgentJob, resultFile } from '../../agent/lib/meta.ts';
import { changeLists, checkoutLine, specDebtTarget, specDebtTargetOf } from './debt.ts';
import { inputListIds, inputWhole } from './input.ts';
import { debtMismatch, parseReviewFile } from './review-file.ts';

/**
 * After a spec review agent job ended (`ogw agent wait`): writes its review file's change to the spec review lists
 * (`core` command.md `## review lists`), once per job. Returns the output lines, or null for a job that is not a spec
 * review. A review file not in the review file form gives an error line, and nothing is written.
 */
export async function recordSpecDebt(ctx: Context, id: string): Promise<{ lines: string[]; error: boolean } | null> {
  const { meta } = await readAgentJob(id, ctx.env);
  if (meta.role !== 'review' || meta.review?.side !== 'spec') return null;
  if (Array.isArray(meta.debtLines)) return { lines: meta.debtLines, error: false };
  const output = resultFile(meta);
  const input = await readText(meta.input);
  const file = output !== null && exists(output) ? parseReviewFile(await readText(output), { low: inputWhole(input) }) : null;
  const given = inputListIds(input);
  const mismatch = file === null ? 'not in the review file format' : debtMismatch(file, given);
  if (file === null || mismatch !== null) return { lines: [`review file ${output ?? 'none'}: ${mismatch ?? ''}`], error: true };
  const module = meta.review.target;
  // a location in the review agent's worktree is kept as a harness path
  const roots = [meta.folder, (await ctx.workspace()).harness].filter((root): root is string => typeof root === 'string');
  const lines = file.outOfScope.map((line) => checkoutLine(line, roots));
  const add = await Promise.all(lines.map(async (line) => ({ line, target: await specDebtTargetOf(ctx, line, module) })));
  const gone = (rows: typeof file.debt): string[] => rows.filter((row) => row.result !== 'open').map((row) => row.id);
  const remove = { target: specDebtTarget(module), debt: gone(file.debt), mustFix: gone(file.mustFix) };
  const changed = await changeLists(ctx, 'core', { add, remove, foundBy: specDebtTarget(module) });
  await changeAgentMeta(id, ctx.env, (m) => {
    m.debtLines = changed;
  });
  return { lines: changed, error: false };
}
