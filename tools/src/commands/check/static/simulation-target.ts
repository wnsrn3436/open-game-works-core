import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import type { DataTable } from './lib/csv.ts';
import { isSnakeCase } from './lib/files.ts';

/**
 * simulation target (`client-content` `## row simulation`): a `data/tables/` column whose name starts with `sim_` is not
 * `sim_<metric>_min` or `sim_<metric>_max`, is not `int?`, has a build target other than `None`, has no pair column,
 * a row's `sim_<metric>_min` is greater than its `sim_<metric>_max`, or the table's first column is not `id(key)`.
 */
export const NAME = 'simulation target';

const TARGET = /^sim_(.+)_(min|max)$/;

function columnFindings(table: DataTable): Finding[] {
  const out: Finding[] = [];
  const header = at(table.path, 4);
  table.names.forEach((name, i) => {
    if (!name.startsWith('sim_')) return;
    const m = TARGET.exec(name);
    if (!m || !isSnakeCase(m[1] as string)) {
      out.push(finding(NAME, header, `column \`${name}\` is not \`sim_<metric>_min\` or \`sim_<metric>_max\``));
      return;
    }
    if (table.types[i] !== 'int?') out.push(finding(NAME, at(table.path, 3), `column \`${name}\` type is \`${table.types[i] ?? ''}\`, not \`int?\``));
    if (table.targets[i] !== 'None') out.push(finding(NAME, at(table.path, 2), `column \`${name}\` build target is \`${table.targets[i] ?? ''}\`, not \`None\``));
    const pair = `sim_${m[1] as string}_${m[2] === 'min' ? 'max' : 'min'}`;
    if (!table.names.includes(pair)) out.push(finding(NAME, header, `column \`${name}\` has no pair column \`${pair}\``));
  });
  return out;
}

function rowFindings(table: DataTable): Finding[] {
  const out: Finding[] = [];
  for (const [i, name] of table.names.entries()) {
    const m = TARGET.exec(name);
    if (m?.[2] !== 'min') continue;
    const maxIndex = table.names.indexOf(`sim_${m[1] as string}_max`);
    if (maxIndex === -1) continue;
    for (const row of table.rows) {
      const min = row.cells[i] ?? '';
      const max = row.cells[maxIndex] ?? '';
      if (/^-?[0-9]+$/.test(min) && /^-?[0-9]+$/.test(max) && BigInt(min) > BigInt(max)) {
        out.push(finding(NAME, at(table.path, row.line), `\`${name}\` ${min} is greater than \`sim_${m[1] as string}_max\` ${max}`));
      }
    }
  }
  return out;
}

export function checkTable(table: DataTable): Finding[] {
  if (!table.names.some((n) => n.startsWith('sim_'))) return [];
  const out = [...columnFindings(table), ...rowFindings(table)];
  if (table.types[0] !== 'id(key)') out.push(finding(NAME, at(table.path, 3), 'table with `sim_` columns has a first column that is not `id(key)`'));
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const tables = await Promise.all(sc.filter((p) => /^data\/tables\/[^/]+\.csv$/.test(p)).map((p) => sc.table(p)));
  return tables.flatMap((t) => (t ? checkTable(t) : []));
}
