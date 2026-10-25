// Builds the `core-spec/` module objects (`skills/core/command.md` `## core spec file`).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { byteCompare } from '../../../lib/order.ts';
import { mdLines, section, tableAt, type MdLine } from './spec-md.ts';
import { readModuleEntries, type ModuleEntry } from './spec-modules.ts';
import { readSpec, type CollectedDataVocabulary, type ParsedSpec } from './spec-parse.ts';

export interface CoreSpecResult {
  modules: Map<string, unknown>;
  /** The settings type table: the `type` of every distinct settings `key` of all modules, in byte order of `key`. */
  settingTypes: Map<string, string>;
  errors: string[];
  entries: ModuleEntry[];
  specs: ParsedSpec[];
}

async function readLines(path: string, rel: string): Promise<MdLine[]> {
  try {
    return mdLines(await readFile(path, 'utf8'));
  } catch {
    throw new OgwError(`spec file not found: ${rel}`);
  }
}

/** The data type and purpose values of `skills/core/SKILL.md` `## collected data`. */
export async function collectedDataVocabulary(harness: string): Promise<CollectedDataVocabulary> {
  const rel = 'skills/core/SKILL.md';
  const lines = await readLines(join(harness, rel), rel);
  const sec = section(lines, 2, 'collected data');
  const values = (column: string): Set<string> | null => {
    if (!sec) return null;
    for (let i = sec.start; i < sec.end; i++) {
      const table = tableAt(lines, i);
      if (table && table.header[0] === column && table.header[1] === 'meaning') {
        return new Set(table.rows.map((row) => (row.cells[0] ?? '').replace(/^`|`$/g, '')));
      }
    }
    return null;
  };
  const dataTypes = values('data type');
  const purposes = values('purpose');
  if (!dataTypes || !purposes) throw new OgwError(`${rel}: "## collected data" needs the "data type" and "purpose" tables`);
  return { dataTypes, purposes };
}

function unique(items: Iterable<string>): string[] {
  return [...new Set(items)];
}

function moduleObject(spec: ParsedSpec, ownTables: ReadonlySet<string>): Record<string, unknown> {
  const deps = spec.dependencies;
  const dev = new Set(deps.filter((d) => d.devOnly).map((d) => d.name));
  return {
    name: spec.entry.name,
    side: spec.entry.side,
    lifecycle: spec.lifecycle,
    dependencies: unique(deps.filter((d) => d.label !== 'optional' && !dev.has(d.name)).map((d) => d.name)),
    optionalDependencies: unique(deps.filter((d) => d.label === 'optional' && !d.devOnly).map((d) => d.name)),
    devDependencies: unique(deps.filter((d) => d.devOnly).map((d) => d.name)),
    settings: spec.settings.map(({ key, type, source, owner }) => ({ key, type, source, owner })),
    settingsConstraints: spec.settingsConstraints.map(({ left, factor, right }) => ({ left, factor, right })),
    tables: spec.tables.map((t) => ({ name: t.name, columns: t.columns })),
    usedTables: unique(spec.uses.map((u) => u.table).filter((t) => !ownTables.has(t))),
    enums: spec.enums,
    invariants: spec.invariants,
    reserved: spec.reserved.map(({ table, id, requiredWhen, rowOf }) => ({ table, id, requiredWhen, rowOf })),
    formatArguments: spec.formatArguments.map(({ text, arguments: args }) => ({ text, arguments: args })),
    collectedData: spec.collectedData,
    adapters: spec.adapters,
    operations: spec.operations,
  };
}

interface Issue {
  spec: ParsedSpec;
  n: number;
  reason: string;
}

/**
 * Checks that need every spec: tables named by used table lines and `→`, format argument texts, duplicate constraints,
 * one settings `key` with two types.
 */
function crossIssues(specs: readonly ParsedSpec[]): Issue[] {
  const columns = new Map<string, Set<string>>();
  for (const spec of specs) {
    for (const table of spec.tables) columns.set(table.name, new Set(table.columns.map((c) => c.name)));
  }
  const reservedNames = new Set(
    specs.flatMap((s) => s.reserved.filter((r) => r.table !== 'reserved_sound').map((r) => r.id)),
  );
  const issues: Issue[] = [];
  const constraints = new Map<string, string>();
  const settingTypes = new Map<string, { type: string; at: string }>();
  for (const spec of specs) {
    for (const use of spec.uses) {
      if (use.checked && !columns.has(use.table)) {
        issues.push({ spec, n: use.n, reason: `table \`${use.table}\` has no table definition in any module` });
      }
    }
    for (const fa of spec.formatArguments) {
      if (!formatTextKnown(fa.text, reservedNames, columns)) {
        issues.push({ spec, n: fa.n, reason: `format argument text \`${fa.text}\` is not a reserved string, reserved ID or <table>.<column> of a table definition` });
      }
    }
    for (const c of spec.settingsConstraints) {
      const key = `${c.left} ${String(c.factor)} ${c.right}`;
      const first = constraints.get(key);
      if (first === undefined) constraints.set(key, `${spec.entry.specRel}:${String(c.n)}`);
      else issues.push({ spec, n: c.n, reason: `the same settings constraint is also in ${first}` });
    }
    for (const row of spec.settings) {
      const first = settingTypes.get(row.key);
      if (first === undefined) settingTypes.set(row.key, { type: row.type, at: `${spec.entry.specRel}:${String(row.n)}` });
      else if (first.type !== row.type) {
        issues.push({ spec, n: row.n, reason: `settings key \`${row.key}\` has type "${row.type}", and type "${first.type}" in ${first.at}` });
      }
    }
  }
  return issues;
}

function formatTextKnown(text: string, reserved: ReadonlySet<string>, columns: ReadonlyMap<string, Set<string>>): boolean {
  if (reserved.has(text)) return true;
  const dot = text.indexOf('.');
  if (dot < 0) return false;
  return columns.get(text.slice(0, dot))?.has(text.slice(dot + 1)) === true;
}

/** Reads every module spec of the harness at `harness` and builds the module objects. */
export async function buildFromHarness(harness: string): Promise<CoreSpecResult> {
  const entries = await readModuleEntries(harness);
  const vocabulary = await collectedDataVocabulary(harness);
  const names = new Set(entries.map((e) => e.name));
  const specs: ParsedSpec[] = [];
  for (const entry of entries) {
    specs.push(readSpec(entry, await readLines(entry.spec, entry.specRel), vocabulary, names));
  }
  const all: Issue[] = [
    ...specs.flatMap((spec) => spec.issues.map((i) => ({ spec, n: i.n, reason: i.reason }))),
    ...crossIssues(specs),
  ];
  const order = new Map(specs.map((s, i) => [s, i]));
  all.sort((a, b) => (order.get(a.spec) as number) - (order.get(b.spec) as number) || a.n - b.n);
  const errors = all.map((i) => `${i.spec.entry.specRel}:${String(i.n)}: ${i.reason}`);
  const modules = new Map<string, unknown>();
  for (const spec of specs) modules.set(spec.entry.name, moduleObject(spec, new Set(spec.tables.map((t) => t.name))));
  const settingTypes = new Map<string, string>();
  const rows = specs.flatMap((spec) => spec.settings).sort((a, b) => byteCompare(a.key, b.key));
  for (const row of rows) if (!settingTypes.has(row.key)) settingTypes.set(row.key, row.type);
  return { modules, settingTypes, errors, entries, specs };
}
