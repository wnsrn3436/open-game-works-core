// Harness consistency check items that read the module specs:
// settings table, spec heading, spec DEV table, core error owner, once_key prefix,
// testing DEV operation, admin operation.
import {
  cellValue,
  codeSpans,
  headingLevel,
  section,
  tableAt,
  tableAfter,
  type MdLine,
  type MdSection,
  type MdTable,
} from '../../core/lib/spec-md.ts';
import type { ModuleEntry } from '../../core/lib/spec-modules.ts';
import type { ParsedSpec } from '../../core/lib/spec-parse.ts';
import { at, type DocFile, type Failure } from './files.ts';

export interface SpecDoc {
  entry: ModuleEntry;
  lines: MdLine[];
  parsed: ParsedSpec;
}

/** The tables of a section. */
export function tablesIn(lines: readonly MdLine[], sec: MdSection): MdTable[] {
  const tables: MdTable[] = [];
  for (let i = sec.start + 1; i < sec.end; i++) {
    const table = tableAt(lines, i);
    if (!table) continue;
    tables.push(table);
    i = table.endIndex - 1;
  }
  return tables;
}

/** The text of the first code span of a cell. */
export function firstSpan(cell: string): string | null {
  return codeSpans(cell)[0]?.text ?? null;
}

// settings table

function settingsSectionSpans(spec: SpecDoc, sec: MdSection | null): Set<string> {
  if (!sec) return new Set();
  return new Set(spec.lines.slice(sec.start, sec.end).filter((l) => !l.fenced).flatMap((l) => codeSpans(l.text).map((s) => s.text)));
}

/** A game settings path with the environment written as `<ENV>`. */
export function envPath(path: string): string {
  return path.replace(/^environments\.(LOCAL|DEV|STG|PROD)\./, 'environments.<ENV>.');
}

/**
 * Core settings keys and game settings paths written outside `## settings` are in that spec's `## settings`.
 * A code span is a settings key or path when some spec's settings table has it as `key`, or when it
 * follows the words `game settings `.
 */
export function checkSettingsTable(specs: readonly SpecDoc[]): Failure[] {
  const known = new Set(specs.flatMap((s) => s.parsed.settings.map((row) => row.key)));
  const failures: Failure[] = [];
  for (const spec of specs) {
    const sec = section(spec.lines, 2, 'settings');
    const listed = new Set([...settingsSectionSpans(spec, sec)].map(envPath));
    spec.lines.forEach((line, i) => {
      if (line.fenced || (sec && i >= sec.start && i < sec.end)) return;
      const reported = new Set<string>();
      for (const span of codeSpans(line.text)) {
        const path = envPath(span.text);
        const gamePath = line.text.slice(0, span.start).endsWith('game settings ');
        if ((!gamePath && !known.has(path)) || listed.has(path) || reported.has(path)) continue;
        reported.add(path);
        failures.push({ item: 'settings table', where: at(spec.entry.specRel, line.n), reason: `settings key \`${span.text}\` is not in this spec's ## settings` });
      }
    });
  }
  return failures;
}

// spec heading

/** The heading order of `skills/core/SKILL.md` `## spec`. */
export function specHeadings(core: DocFile): string[] | null {
  const sec = section(core.lines, 2, 'spec');
  if (!sec) return null;
  const table = tablesIn(core.lines, sec).find((t) => t.header[0] === 'heading');
  return table ? table.rows.map((r) => cellValue(r.cells[0] ?? '')) : null;
}

export function checkSpecHeading(specs: readonly SpecDoc[], expected: readonly string[]): Failure[] {
  const failures: Failure[] = [];
  for (const spec of specs) {
    const actual = spec.lines.filter((l) => headingLevel(l) === 2).map((l) => l.text.trim());
    if (actual.length === expected.length && actual.every((h, i) => h === expected[i])) continue;
    failures.push({
      item: 'spec heading',
      where: spec.entry.specRel,
      reason: `headings are [${actual.join(', ')}]; the core skill ## spec order is [${expected.join(', ')}]`,
    });
  }
  return failures;
}

// spec DEV table

export function checkSpecDevTable(specs: readonly SpecDoc[]): Failure[] {
  const failures: Failure[] = [];
  for (const spec of specs) {
    const sec = section(spec.lines, 2, 'DEV');
    if (!sec) continue;
    for (const table of tablesIn(spec.lines, sec)) {
      if (table.header[0] !== 'operation') continue;
      const output = table.header.indexOf('output');
      if (output < 0) continue;
      const needs = table.rows.some((r) => !cellValue(r.cells[output] ?? '').startsWith('none'));
      if (needs && table.header[output + 1] !== 'failure value') {
        failures.push({ item: 'spec DEV table', where: at(spec.entry.specRel, table.n), reason: 'an output does not start with "none", so the column after "output" must be "failure value"' });
      }
    }
  }
  return failures;
}

// set comparison

function pairKey(a: string, b: string): string {
  return `${a}\u0000${b}`;
}

function compareSets(item: string, left: Map<string, string>, leftName: string, right: Map<string, string>, rightName: string): Failure[] {
  const failures: Failure[] = [];
  for (const [key, where] of left) {
    if (!right.has(key)) failures.push({ item, where, reason: `(${key.split('\u0000').join(', ')}) is in ${leftName} but not in ${rightName}` });
  }
  for (const [key, where] of right) {
    if (!left.has(key)) failures.push({ item, where, reason: `(${key.split('\u0000').join(', ')}) is in ${rightName} but not in ${leftName}` });
  }
  return failures;
}

function serverSpecs(specs: readonly SpecDoc[]): SpecDoc[] {
  return specs.filter((s) => s.entry.specRel.startsWith('skills/server-core/modules/'));
}

// core error owner

function coreErrorTable(doc: DocFile): MdTable | null {
  const sec = section(doc.lines, 2, 'CoreError');
  if (!sec) return null;
  return tablesIn(doc.lines, sec).find((t) => t.header.map(cellValue).join('|') === 'CoreError|number|module') ?? null;
}

/** Start of the line that names the `CoreError` values a server module adds. */
const ADDED_ERRORS = 'Added `CoreError`: ';

function addedErrors(spec: SpecDoc, item: string, failures: Failure[], into: Map<string, string>): void {
  const sec = section(spec.lines, 2, 'error');
  const lines = sec ? spec.lines.slice(sec.start + 1, sec.end).filter((l) => !l.fenced && l.text.startsWith(ADDED_ERRORS)) : [];
  if (lines.length !== 1) {
    failures.push({ item, where: spec.entry.specRel, reason: `## error has ${String(lines.length)} lines starting with "${ADDED_ERRORS.trim()}"; it must have one` });
    return;
  }
  const line = lines[0] as MdLine;
  const colon = line.text.indexOf(': ');
  let body = colon < 0 ? '' : line.text.slice(colon + 2);
  const stop = body.indexOf('. ');
  if (stop >= 0) body = body.slice(0, stop);
  if (body.trim() === 'none') return;
  for (const span of codeSpans(body)) into.set(pairKey(span.text, spec.entry.name), at(spec.entry.specRel, line.n));
}

export function checkCoreErrorOwner(baseProto: DocFile, specs: readonly SpecDoc[]): Failure[] {
  const item = 'core error owner';
  const table = coreErrorTable(baseProto);
  if (!table) return [{ item, where: baseProto.rel, reason: 'no ## CoreError table with columns CoreError, number, module' }];
  const failures: Failure[] = [];
  const fromTable = new Map<string, string>();
  table.rows.forEach((row, i) => {
    if ((row.cells[1] ?? '').trim() !== String(i + 1)) {
      failures.push({ item, where: at(baseProto.rel, row.n), reason: `number must be ${String(i + 1)}` });
    }
    fromTable.set(pairKey(cellValue(row.cells[0] ?? ''), cellValue(row.cells[2] ?? '')), at(baseProto.rel, row.n));
  });
  const fromSpecs = new Map<string, string>();
  for (const spec of serverSpecs(specs)) addedErrors(spec, item, failures, fromSpecs);
  return [...failures, ...compareSets(item, fromTable, 'the CoreError table', fromSpecs, `the specs' "${ADDED_ERRORS.trim()}" lines`)];
}

// once_key prefix

const ONCE_KEY_LINE = '- `once_key` prefix: ';

export function checkOnceKeyPrefix(specs: readonly SpecDoc[]): Failure[] {
  const item = 'once_key prefix';
  const server = serverSpecs(specs);
  const ledger = server.find((s) => s.entry.name === 'item-ledger');
  if (!ledger) return [{ item, where: '', reason: 'no item-ledger spec' }];
  const defining = ledger.lines.find((l) => !l.fenced && l.text.startsWith('- core `once_key` prefix: '));
  if (!defining) return [{ item, where: ledger.entry.specRel, reason: 'no bullet line "- core `once_key` prefix: "' }];
  const core = new Map<string, string>();
  for (const span of codeSpans(defining.text)) if (span.text.endsWith(':')) core.set(span.text, at(ledger.entry.specRel, defining.n));
  const used = new Map<string, string>();
  for (const spec of server) {
    if (spec === ledger) continue;
    const sec = section(spec.lines, 2, 'behavior');
    if (!sec) continue;
    for (const line of spec.lines.slice(sec.start + 1, sec.end)) {
      if (line.fenced || !line.text.startsWith(ONCE_KEY_LINE)) continue;
      for (const span of codeSpans(line.text.slice(ONCE_KEY_LINE.length))) used.set(span.text, at(spec.entry.specRel, line.n));
    }
  }
  return compareSets(item, core, 'the item-ledger core once_key prefix line', used, 'the specs\' once_key prefix lines');
}

// operation tables

interface OperationRow {
  spec: SpecDoc;
  n: number;
  operation: string;
  caller: string;
}

/** Rows of the tables in `## <title>` whose header starts with `operation` and has a `caller` column. */
function operationRows(spec: SpecDoc, title: string): OperationRow[] {
  const sec = section(spec.lines, 2, title);
  if (!sec) return [];
  const rows: OperationRow[] = [];
  for (const table of tablesIn(spec.lines, sec)) {
    const caller = table.header.indexOf('caller');
    if (table.header[0] !== 'operation' || caller < 0) continue;
    for (const row of table.rows) rows.push({ spec, n: row.n, operation: row.cells[0] ?? '', caller: row.cells[caller] ?? '' });
  }
  return rows;
}

function addOperation(into: Map<string, string>, row: OperationRow): void {
  const name = firstSpan(row.operation);
  if (name !== null) into.set(pairKey(row.spec.entry.name, name), at(row.spec.entry.specRel, row.n));
}

// testing DEV operation

function testingTable(testing: SpecDoc | undefined): MdTable | null {
  if (!testing) return null;
  const index = testing.lines.findIndex((l) => !l.fenced && l.text.trim() === 'testing DEV operation');
  const table = index >= 0 ? tableAfter(testing.lines, index) : null;
  return table && table.header[0] === 'module' && table.header[1] === 'operation' ? table : null;
}

export function checkTestingDev(specs: readonly SpecDoc[]): Failure[] {
  const item = 'testing DEV operation';
  const server = serverSpecs(specs);
  const testing = server.find((s) => s.entry.name === 'testing');
  const table = testingTable(testing);
  if (!testing || !table) {
    return [{ item, where: testing?.entry.specRel ?? '', reason: 'no "testing DEV operation" table with columns module, operation' }];
  }
  const listed = new Map<string, string>();
  for (const row of table.rows) listed.set(pairKey(cellValue(row.cells[0] ?? ''), cellValue(row.cells[1] ?? '')), at(testing.entry.specRel, row.n));
  const fromSpecs = new Map<string, string>();
  for (const row of server.flatMap((spec) => operationRows(spec, 'DEV'))) {
    if (row.operation.includes('(core cheat)') || !codeSpans(row.caller).some((s) => s.text === 'testing')) continue;
    addOperation(fromSpecs, row);
  }
  return compareSets(item, listed, 'the testing DEV operation table', fromSpecs, 'the specs\' ## DEV tables');
}

// admin operation

function adminTable(admin: SpecDoc | undefined): MdTable | null {
  for (let i = 0; admin && i < admin.lines.length; i++) {
    const t = tableAt(admin.lines, i);
    if (t && t.header.join('|') === 'module|admin operation|role') return t;
  }
  return null;
}

export function checkAdminOperation(specs: readonly SpecDoc[]): Failure[] {
  const item = 'admin operation';
  const server = serverSpecs(specs);
  const admin = server.find((s) => s.entry.name === 'admin-api');
  const table = adminTable(admin);
  if (!admin || !table) return [{ item, where: admin?.entry.specRel ?? '', reason: 'no table with columns module, admin operation, role' }];
  const listed = new Map<string, string>();
  for (const row of table.rows) {
    const module = cellValue(row.cells[0] ?? '');
    if (module === 'game') continue;
    for (const span of codeSpans(row.cells[1] ?? '')) listed.set(pairKey(module, span.text), at(admin.entry.specRel, row.n));
  }
  const fromSpecs = new Map<string, string>();
  for (const row of server.filter((s) => s !== admin).flatMap((spec) => operationRows(spec, 'API'))) {
    if (cellValue(row.caller) === 'operator') addOperation(fromSpecs, row);
  }
  return compareSets(item, listed, 'the admin-api admin operation table', fromSpecs, 'the specs\' operator operations');
}
