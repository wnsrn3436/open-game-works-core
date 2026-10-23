import { rowProblems, targetRows } from '../../measure/lib/targets.ts';
import { at, finding, type Finding, type StaticContext } from './lib/context.ts';

/**
 * design target: a `design.md` `## feel targets` or `## tuning targets` table has a `metric` outside the metric names,
 * a `min` or `max` that is not an integer, or a `min` greater than `max` (`game-design` `## design doc`).
 */
export const NAME = 'design target';

export function checkDoc(doc: string): Finding[] {
  return targetRows(doc).flatMap((row) => rowProblems(row).map((problem) => finding(NAME, at('design.md', row.line), problem)));
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  if (!sc.has('design.md')) return [];
  return checkDoc(await sc.text('design.md'));
}
