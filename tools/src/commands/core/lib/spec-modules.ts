// The module tables of `skills/client-core/SKILL.md` and `skills/server-core/SKILL.md` (`## module`).
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { linkTargets, mdLines, section, soleCodeSpan, tableAt, type MdLine, type MdTable } from './spec-md.ts';

export type Side = 'client' | 'server';

export interface ModuleEntry {
  name: string;
  side: Side;
  /** Absolute path of the spec file. */
  spec: string;
  /** Path of the spec file relative to the harness root (used in messages). */
  specRel: string;
}

export const MODULE_SKILLS: readonly { side: Side; skill: string }[] = [
  { side: 'client', skill: 'skills/client-core/SKILL.md' },
  { side: 'server', skill: 'skills/server-core/SKILL.md' },
];

async function readLines(path: string): Promise<MdLine[]> {
  try {
    return mdLines(await readFile(path, 'utf8'));
  } catch {
    throw new OgwError(`file not found: ${path}`);
  }
}

/** Finds the module table: the first table in `## module` whose header starts with `module`, `spec`. */
function moduleTable(lines: MdLine[], skillRel: string): MdTable {
  const sec = section(lines, 2, 'module');
  if (!sec) throw new OgwError(`${skillRel}: no "## module" section`);
  for (let i = sec.start; i < sec.end; i++) {
    const table = tableAt(lines, i);
    if (table && table.header[0] === 'module' && table.header[1] === 'spec') return table;
  }
  throw new OgwError(`${skillRel}: no module table with columns "module", "spec" in "## module"`);
}

/** Reads the modules and their spec files from the two skills of the harness. */
export async function readModuleEntries(harness: string): Promise<ModuleEntry[]> {
  const entries: ModuleEntry[] = [];
  for (const { side, skill } of MODULE_SKILLS) {
    const path = join(harness, skill);
    const lines = await readLines(path);
    const table = moduleTable(lines, skill);
    for (const row of table.rows) {
      const name = soleCodeSpan(row.cells[0] ?? '');
      const target = linkTargets(row.cells[1] ?? '')[0];
      if (name === null || target === undefined) {
        throw new OgwError(`${skill}:${String(row.n)}: module row needs a module name code span and a spec link`);
      }
      const spec = resolve(dirname(path), target);
      entries.push({ name, side, spec, specRel: relative(harness, spec) });
    }
  }
  return entries;
}
