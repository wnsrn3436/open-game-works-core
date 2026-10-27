// The `meaning` column of the `## settings` tables of the harness module specs (`skills/client-core/modules/*.md`,
// `skills/server-core/modules/*.md`). `core-spec.json` of a release does not carry it, so the harness specs, which are
// of the core version of the harness (AGENTS.md `## repo`), give it.
import { readFile } from 'node:fs/promises';
import { cellValue, mdLines, section, soleCodeSpan, tableAt } from '../../core/lib/spec-md.ts';
import { readModuleEntries } from '../../core/lib/spec-modules.ts';

const SETTINGS_COLUMNS = ['key', 'type', 'source', 'owner', 'meaning'];

/** Key → meaning of the core keys of the `## settings` tables of one spec. */
function specMeanings(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = mdLines(text);
  const sec = section(lines, 2, 'settings');
  if (!sec) return out;
  for (let i = sec.start; i < sec.end; i++) {
    const table = tableAt(lines, i);
    if (!table) continue;
    i = table.endIndex - 1;
    if (table.header.join('|') !== SETTINGS_COLUMNS.join('|')) continue;
    for (const row of table.rows) {
      const key = soleCodeSpan(row.cells[0] ?? '');
      if (key !== null && cellValue(row.cells[2] ?? '') === 'core' && !out.has(key)) out.set(key, (row.cells[4] ?? '').trim());
    }
  }
  return out;
}

/** Core settings key → meaning. A key in the tables of several specs takes the row of the module the key names. */
export async function coreSettingMeanings(harness: string): Promise<Map<string, string>> {
  const own = new Map<string, string>();
  const other = new Map<string, string>();
  for (const entry of await readModuleEntries(harness)) {
    for (const [key, meaning] of specMeanings(await readFile(entry.spec, 'utf8'))) {
      const into = key.startsWith(`${entry.name}.`) ? own : other;
      if (!into.has(key)) into.set(key, meaning);
    }
  }
  for (const [key, meaning] of other) if (!own.has(key)) own.set(key, meaning);
  return own;
}
