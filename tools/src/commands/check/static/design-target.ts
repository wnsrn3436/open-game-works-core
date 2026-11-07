import { rowProblems, targetRows, type TargetRow } from '../../measure/lib/targets.ts';
import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { cellOf } from './lib/csv.ts';

/**
 * design target: a `design.md` `## feel targets` or `## tuning targets` table has a `metric` outside the metric names,
 * a `min` or `max` that is not an integer, a `min` greater than `max`, or a `data` cell that names no data: neither
 * empty, nor `<table>.<column>` of a column of `data/tables/<table>.csv`, nor `game_setting.<name>` of the row `[<name>]`
 * of `data/system/game_setting.csv` (`game-design` `## design doc`).
 */
export const NAME = 'design target';

const GAME_SETTING = 'data/system/game_setting.csv';

export function checkDoc(doc: string): Finding[] {
  return targetRows(doc).flatMap((row) => rowProblems(row).map((problem) => finding(NAME, at('design.md', row.line), problem)));
}

/** Why the `data` cell of a target row names no data, or null. */
async function dataProblem(sc: StaticContext, row: TargetRow): Promise<string | null> {
  if (row.data === '') return null;
  const m = /^([a-z][a-z0-9_]*)\.([A-Za-z0-9_]+)$/.exec(row.data);
  const shape = `\`data\` \`${row.data}\` of \`${row.metric}\``;
  if (!m) return `${shape} is not \`<table>.<column>\` or \`game_setting.<name>\``;
  const [, table, name] = m as unknown as [string, string, string];
  if (table === 'game_setting') {
    const settings = await sc.table(GAME_SETTING);
    const found = settings?.rows.some((r) => (cellOf(settings, r, 'id') ?? '').trim() === `[${name}]`) === true;
    return found ? null : `${shape} names no row \`[${name}]\` of ${GAME_SETTING}`;
  }
  const path = `data/tables/${table}.csv`;
  const data = await sc.table(path);
  if (data === null) return `${shape} names no table: ${path} does not exist`;
  return data.names.includes(name) ? null : `${shape} names no column \`${name}\` of ${path}`;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  if (!sc.has('design.md')) return [];
  const doc = await sc.text('design.md');
  const out = checkDoc(doc);
  for (const row of targetRows(doc)) {
    const problem = await dataProblem(sc, row);
    if (problem !== null) out.push(finding(NAME, at('design.md', row.line), problem));
  }
  return out;
}
