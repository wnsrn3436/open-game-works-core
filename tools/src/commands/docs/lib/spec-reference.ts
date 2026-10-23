// Harness consistency check item `spec reference`.
import { codeSpans, section, type MdLine, type MdTable } from '../../core/lib/spec-md.ts';
import { escapeRegExp } from '../../../lib/regexp.ts';
import { at, type Failure } from './files.ts';
import { firstSpan, tablesIn, type SpecDoc } from './spec-items.ts';

const ITEM = 'spec reference';

export type MemberKind = 'operation' | 'event' | 'hook';


/** Lifecycle names that a reference may use without a table row. */
const LIFECYCLE = new Set(['init', 'release']);

function tables(lines: readonly MdLine[], title: string): MdTable[] {
  const sec = section(lines, 2, title);
  return sec ? tablesIn(lines, sec) : [];
}

/** The column of the names of a table: `operation`, `event` or `hook` first, or `operation` after `component`. */
function nameColumn(table: MdTable, kind: MemberKind): number {
  if (table.header[0] === kind) return 0;
  return kind === 'operation' && table.header[0] === 'component' && table.header[1] === 'operation' ? 1 : -1;
}

function addNames(members: Map<string, MemberKind>, table: MdTable, kind: MemberKind): void {
  const column = nameColumn(table, kind);
  if (column < 0) return;
  for (const row of table.rows) {
    const name = firstSpan(row.cells[column] ?? '');
    if (name !== null) members.set(name, kind);
  }
}

/** The operations of `## API` and `## DEV`, the events of `## event` and the hooks of `## hook` of a spec. */
export function specMembers(lines: readonly MdLine[]): Map<string, MemberKind> {
  const members = new Map<string, MemberKind>();
  for (const title of ['API', 'DEV']) for (const table of tables(lines, title)) addNames(members, table, 'operation');
  for (const table of tables(lines, 'event')) addNames(members, table, 'event');
  for (const table of tables(lines, 'hook')) addNames(members, table, 'hook');
  return members;
}

export interface Reference {
  module: string;
  name: string;
}

export type KeyTest = (text: string) => boolean;

const PLACEHOLDER = /<[^>]+>/;

/** Tests a text against keys; a `<...>` part of a key matches one or more letters, digits and `_`. */
export function keyTest(keys: readonly string[]): KeyTest {
  const exact = new Set(keys.filter((k) => !PLACEHOLDER.test(k)));
  const patterns = keys
    .filter((k) => PLACEHOLDER.test(k))
    .map((k) => new RegExp(`^${k.split(new RegExp(PLACEHOLDER.source)).map(escapeRegExp).join('[A-Za-z0-9_]+')}$`));
  return (text) => exact.has(text) || patterns.some((p) => p.test(text));
}

/** The reference `<Module>.<name>` that a code span text is, or null. Core settings keys and `LocalDataCore` keys are not references. */
export function referenceOf(text: string, modules: ReadonlySet<string>, isKey: KeyTest): Reference | null {
  if (isKey(text)) return null;
  const m = /^([A-Za-z][A-Za-z0-9-]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(text);
  if (!m || !modules.has(m[1] as string)) return null;
  return { module: m[1] as string, name: m[2] as string };
}

/** Text between `` `<Module>` `` and `` `<name>` `` that makes the name a member of the module. */
const POSSESSIVE = "'s ";
/** Text between `` `<name>` `` and `` `<Module>` `` in `` `<name>` of `<Module>` ``. */
const OF = ' of ';

type Members = ReadonlyMap<string, ReadonlyMap<string, MemberKind>>;

/** Failures of one spec line: references to missing names, and `` `<Module>`'s `<name>` `` or `` `<name>` of `<Module>` `` for a name of another module. */
export function referenceFailures(spec: SpecDoc, line: MdLine, members: Members, isKey: KeyTest): Failure[] {
  const failures: Failure[] = [];
  const where = at(spec.entry.specRel, line.n);
  const modules = new Set(members.keys());
  const spans = codeSpans(line.text);
  spans.forEach((span, i) => {
    const ref = referenceOf(span.text, modules, isKey);
    if (ref) {
      if (!LIFECYCLE.has(ref.name) && members.get(ref.module)?.has(ref.name) !== true) {
        failures.push({ item: ITEM, where, reason: `\`${span.text}\`: ${ref.module} has no operation, event or hook \`${ref.name}\`` });
      }
      return;
    }
    const next = spans[i + 1];
    if (!next) return;
    const between = line.text.slice(span.end, next.start);
    const kind = members.get(span.text)?.get(next.text);
    if (kind && span.text !== spec.entry.name && between === POSSESSIVE) {
      failures.push({ item: ITEM, where, reason: `write \`${span.text}.${next.text}\` for the ${kind} of another module` });
    }
    const ofKind = members.get(next.text)?.get(span.text);
    if (ofKind && next.text !== spec.entry.name && between === OF) {
      failures.push({ item: ITEM, where, reason: `write \`${next.text}.${span.text}\` for the ${ofKind} of another module` });
    }
  });
  return failures;
}

/** Every spec writes table headers of distinct tables. */
function tableOwnerFailures(specs: readonly SpecDoc[]): Failure[] {
  const owners = new Map<string, string[]>();
  for (const spec of specs) {
    for (const table of spec.parsed.tables) owners.set(table.name, [...(owners.get(table.name) ?? []), at(spec.entry.specRel, table.n)]);
  }
  const failures: Failure[] = [];
  for (const [table, wheres] of owners) {
    if (wheres.length < 2) continue;
    for (const where of wheres) failures.push({ item: ITEM, where, reason: `table header of \`${table}\` is written in ${String(wheres.length)} specs` });
  }
  return failures;
}

/** The keys of the `LocalDataCore` key tables (header `file kind`, `key`) in `## data` of a spec. */
export function localDataKeys(lines: readonly MdLine[]): string[] {
  return tables(lines, 'data')
    .filter((t) => t.header[0] === 'file kind' && t.header[1] === 'key')
    .flatMap((t) => t.rows.map((row) => firstSpan(row.cells[1] ?? '')))
    .filter((key) => key !== null);
}

export function checkSpecReference(specs: readonly SpecDoc[]): Failure[] {
  const members = new Map(specs.map((s) => [s.entry.name, specMembers(s.lines)]));
  const isKey = keyTest([...specs.flatMap((s) => s.parsed.settings.map((row) => row.key)), ...specs.flatMap((s) => localDataKeys(s.lines))]);
  const failures = tableOwnerFailures(specs);
  for (const spec of specs) {
    for (const line of spec.lines) if (!line.fenced) failures.push(...referenceFailures(spec, line, members, isKey));
  }
  return failures;
}
