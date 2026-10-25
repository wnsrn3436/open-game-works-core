// Reads one module spec in the tool-read form of `skills/core/SKILL.md` `### tool-read form`.
import {
  arrowTargetAt,
  cellValue,
  codeSpanAt,
  parseSpanList,
  section,
  soleCodeSpan,
  tableAfter,
  tableAt,
  type MdLine,
  type MdSection,
  type MdTable,
} from './spec-md.ts';
import type { ModuleEntry } from './spec-modules.ts';

export interface Issue {
  n: number;
  reason: string;
}

export interface DependencyItem {
  name: string;
  n: number;
  label: 'none' | 'server' | 'optional';
  devOnly: boolean;
}

export interface TableColumn {
  description: string;
  target: string;
  type: string;
  name: string;
}

export interface TableDefinition {
  name: string;
  n: number;
  columns: TableColumn[];
}

export interface TableUse {
  table: string;
  n: number;
  /** The table must have a definition in some module (used table line and reserved `→`). */
  checked: boolean;
}

export interface Condition {
  path: string;
  value: unknown;
}

export interface ReservedName {
  table: 'reserved_id' | 'reserved_string' | 'reserved_sound';
  id: string;
  requiredWhen: Condition | null;
  rowOf: string | null;
}

export interface FormatArgument {
  text: string;
  arguments: { name: string; kind: string }[];
}

export interface SettingRow {
  key: string;
  type: string;
  source: string;
  owner: string;
}

export interface SettingsConstraint {
  left: string;
  factor: number;
  right: string;
}

export interface CollectedDataRow {
  dataType: string;
  description: string;
  source: string;
  purposes: string[];
  linked: boolean;
  tracking: boolean;
  shared: boolean;
  optional: boolean;
  platforms: string[];
  condition: Condition | null;
}

export interface ParsedSpec {
  entry: ModuleEntry;
  issues: Issue[];
  dependencies: DependencyItem[];
  tables: TableDefinition[];
  uses: TableUse[];
  enums: { type: string; elements: string[] }[];
  invariants: Record<string, string>[];
  reserved: (ReservedName & { n: number })[];
  formatArguments: (FormatArgument & { n: number })[];
  settings: (SettingRow & { n: number })[];
  settingsConstraints: (SettingsConstraint & { n: number })[];
  collectedData: CollectedDataRow[];
  adapters: string[];
  lifecycle: boolean;
  operations: SpecOperation[];
}

/** Kind of one operation input: a translation key or anything else. */
export type InputKind = 'translationKey' | 'other';

/** One operation of the `## API` operation table and the kinds of its inputs, in input order. */
export interface SpecOperation {
  name: string;
  inputs: InputKind[];
}

/** Values the collected data table may hold, from `skills/core/SKILL.md` `## collected data`. */
export interface CollectedDataVocabulary {
  dataTypes: ReadonlySet<string>;
  purposes: ReadonlySet<string>;
}

export const ALL_PLATFORMS: readonly string[] = ['android', 'ios', 'web', 'windows', 'macos', 'linux'];

const INVARIANT_COLUMNS = ['kind', 'table', 'column', 'group', 'min', 'max', 'child_table', 'child_column'];
const SETTINGS_COLUMNS = ['key', 'type', 'source', 'owner', 'meaning'];
const CONSTRAINT_COLUMNS = ['left', 'factor', 'right'];
const COLLECTED_COLUMNS = [
  'data type',
  'description',
  'source',
  'purposes',
  'linked',
  'tracking',
  'shared',
  'optional',
  'platforms',
  'condition',
];
const RESERVED_KINDS: Record<string, ReservedName['table']> = {
  'reserved ID': 'reserved_id',
  'reserved string': 'reserved_string',
  'reserved sound': 'reserved_sound',
};
const FORMAT_KINDS = new Set(['integer', 'real', 'string']);
const SETTING_BASE_TYPES = new Set(['integer', 'number', 'string', 'boolean', 'object']);
const CORE_KEY = /^([A-Za-z][A-Za-z0-9-]*)\.([a-z][A-Za-z0-9]*)$/;
const ID_NAME = /^\[[^\]]+\]$/;
const REQUIRED_WHEN = /required when game settings `([^`]+)` is `([^`]+)`/;

const NO_LIFECYCLE = 'has no lifecycle';
const SET_BY_GAME = 'set by the game';
const DEV_DEPENDENCY = 'dev dependency: ';

/** Splits a cell at `, ` outside parentheses and code spans. */
export function splitInputs(cell: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let code = false;
  let start = 0;
  for (let i = 0; i < cell.length; i++) {
    const ch = cell[i];
    if (ch === '`') code = !code;
    else if (!code && ch === '(') depth++;
    else if (!code && ch === ')') depth--;
    else if (!code && depth === 0 && ch === ',' && cell[i + 1] === ' ') {
      parts.push(cell.slice(start, i).trim());
      start = i + 2;
    }
  }
  parts.push(cell.slice(start).trim());
  return parts;
}

/** Input kinds of an `input` cell: `translationKey` for an input whose text has `translation key`. */
export function inputKinds(cell: string): InputKind[] {
  if (cellValue(cell) === 'none') return [];
  return splitInputs(cell.trim()).map((part) => (part.includes('translation key') ? 'translationKey' : 'other'));
}

function sameColumns(header: readonly string[], expected: readonly string[]): boolean {
  return header.length === expected.length && expected.every((name, i) => header[i] === name);
}

function startsWithColumns(header: readonly string[], expected: readonly string[]): boolean {
  return expected.every((name, i) => header[i] === name);
}

function headerText(expected: readonly string[]): string {
  return expected.map((c) => `"${c}"`).join(', ');
}

class SpecReader {
  readonly spec: ParsedSpec;
  private readonly lines: readonly MdLine[];
  private readonly vocabulary: CollectedDataVocabulary;
  private readonly moduleNames: ReadonlySet<string>;

  constructor(entry: ModuleEntry, lines: readonly MdLine[], vocabulary: CollectedDataVocabulary, moduleNames: ReadonlySet<string>) {
    this.lines = lines;
    this.vocabulary = vocabulary;
    this.moduleNames = moduleNames;
    this.spec = {
      entry,
      issues: [],
      dependencies: [],
      tables: [],
      uses: [],
      enums: [],
      invariants: [],
      reserved: [],
      formatArguments: [],
      settings: [],
      settingsConstraints: [],
      collectedData: [],
      adapters: [],
      lifecycle: false,
      operations: [],
    };
  }

  issue(n: number, reason: string): void {
    this.spec.issues.push({ n, reason });
  }

  read(): ParsedSpec {
    this.spec.lifecycle = this.spec.entry.side === 'client' && !this.saysNoLifecycle();
    const api = section(this.lines, 2, 'API');
    if (api) this.readOperations(api);
    const dependency = section(this.lines, 2, 'dependency');
    if (dependency) this.readDependencies(dependency);
    const data = section(this.lines, 2, 'data');
    if (data) this.readData(data);
    this.readInvariantTables();
    const behavior = section(this.lines, 2, 'behavior');
    if (behavior) this.readBehavior(behavior);
    const settings = section(this.lines, 2, 'settings');
    if (settings) this.readSettings(settings);
    this.spec.uses.sort((a, b) => a.n - b.n);
    return this.spec;
  }

  private *body(sec: MdSection): Generator<{ line: MdLine; index: number }> {
    for (let index = sec.start + 1; index < sec.end; index++) {
      const line = this.lines[index] as MdLine;
      if (!line.fenced) yield { line, index };
    }
  }

  // lifecycle sentence and operation table

  private saysNoLifecycle(): boolean {
    const purpose = section(this.lines, 2, 'purpose');
    if (!purpose) return false;
    for (const { line } of this.body(purpose)) if (line.text.includes(NO_LIFECYCLE)) return true;
    return false;
  }

  private readOperations(sec: MdSection): void {
    for (let index = sec.start + 1; index < sec.end; index++) {
      const table = tableAt(this.lines, index);
      if (!table) continue;
      index = table.endIndex - 1;
      if (!startsWithColumns(table.header, ['operation', 'input'])) continue;
      for (const row of table.rows) {
        const names = parseSpanList((row.cells[0] ?? '').trim());
        if (!names || names.rest !== null) continue;
        const inputs = inputKinds(row.cells[1] ?? '');
        for (const item of names.items) this.spec.operations.push({ name: item.text, inputs: [...inputs] });
      }
    }
  }

  // dependency line

  private readDependencies(sec: MdSection): void {
    for (const { line } of this.body(sec)) {
      let text = line.text.startsWith('- ') ? line.text.slice(2) : line.text;
      let label: DependencyItem['label'] = 'none';
      const devLabel = text.startsWith(DEV_DEPENDENCY);
      if (devLabel) {
        text = text.slice(DEV_DEPENDENCY.length);
      } else if (text.startsWith('server dependency: ')) {
        label = 'server';
        text = text.slice('server dependency: '.length);
      } else if (text.startsWith('optional dependency: ')) {
        label = 'optional';
        text = text.slice('optional dependency: '.length);
      }
      const list = parseSpanList(text, { comments: true });
      if (!list) continue;
      for (const item of list.items) {
        if (!this.moduleNames.has(item.text)) this.issue(line.n, `dependency line names \`${item.text}\`, which is not a module`);
        this.spec.dependencies.push({ name: item.text, n: line.n, label, devOnly: devLabel });
      }
    }
  }

  // ## data

  private readData(sec: MdSection): void {
    for (const { line, index } of this.body(sec)) {
      const text = line.text;
      const first = codeSpanAt(text, 0);
      const tableFile = first ? /^data\/tables\/(.+)\.csv$/.exec(first.text) : null;
      if (tableFile) this.readTableDefinition(tableFile[1] as string, line, index, sec.end);
      else if (text.trim() === '`data/enums.csv`') this.readEnumTable(line, index, sec.end);
      else if (text.startsWith('used table: ')) this.readUsedTableLine(line);
      else if (text.trim() === 'format argument') this.readFormatArguments(line, index, sec.end);
      else if (text.trim() in RESERVED_KINDS) this.readReservedTable(line, index, sec.end);
      else this.readReservedLine(line);
    }
  }

  private requireTable(line: MdLine, index: number, end: number, what: string): MdTable | null {
    const table = tableAfter(this.lines, index, end);
    if (!table) this.issue(line.n, `${what} has no table right after the line`);
    return table;
  }

  private readTableDefinition(name: string, line: MdLine, index: number, end: number): void {
    const table = this.requireTable(line, index, end, `table definition of \`${name}\``);
    if (!table) return;
    const definition: TableDefinition = { name, n: line.n, columns: [] };
    this.spec.tables.push(definition);
    if (!startsWithColumns(table.header, ['column', 'type', 'build target'])) {
      this.issue(table.n, `table definition header must start with ${headerText(['column', 'type', 'build target'])}`);
      return;
    }
    for (const row of table.rows) {
      if (cellValue(row.cells[0] ?? '').startsWith('#')) continue;
      const [column, type, target] = [0, 1, 2].map((i) => soleCodeSpan(row.cells[i] ?? ''));
      if (column == null || type == null || target == null) {
        this.issue(row.n, 'table definition cells "column", "type", "build target" must each be one code span');
        continue;
      }
      definition.columns.push({ description: '', target, type, name: column });
      for (const m of type.matchAll(/ref<([^.<>]+)\.[^<>]*>/g)) this.spec.uses.push({ table: m[1] as string, n: row.n, checked: false });
    }
  }

  private readEnumTable(line: MdLine, index: number, end: number): void {
    const table = this.requireTable(line, index, end, 'enum table');
    if (!table) return;
    if (!sameColumns(table.header, ['type', 'element'])) {
      this.issue(table.n, `enum table header must be ${headerText(['type', 'element'])}`);
      return;
    }
    for (const row of table.rows) {
      const type = soleCodeSpan(row.cells[0] ?? '');
      const element = row.cells[1] ?? '';
      if (type !== null && element.startsWith(SET_BY_GAME)) continue;
      const list = parseSpanList(element);
      if (type === null || !list) {
        this.issue(row.n, 'enum table row needs a type code span and element code spans joined by ", " or "set by the game"');
        continue;
      }
      this.spec.enums.push({ type, elements: list.items.map((i) => i.text) });
    }
  }

  private readUsedTableLine(line: MdLine): void {
    const list = parseSpanList(line.text.slice('used table: '.length));
    if (!list) return;
    for (const item of list.items) this.spec.uses.push({ table: item.text, n: line.n, checked: true });
  }

  private readFormatArguments(line: MdLine, index: number, end: number): void {
    const table = this.requireTable(line, index, end, 'format argument table');
    if (!table) return;
    if (!sameColumns(table.header, ['text', 'arguments'])) {
      this.issue(table.n, `format argument table header must be ${headerText(['text', 'arguments'])}`);
      return;
    }
    for (const row of table.rows) {
      const text = soleCodeSpan(row.cells[0] ?? '');
      const args = formatArgumentList(row.cells[1] ?? '');
      if (text === null || args === null) {
        this.issue(row.n, 'format argument row needs a text code span and "none" or `{<name>}`(`<kind>`) joined by ", "');
        continue;
      }
      this.spec.formatArguments.push({ text, arguments: args, n: row.n });
    }
  }

  private readReservedLine(line: MdLine): void {
    const text = line.text.startsWith('- ') ? line.text.slice(2) : line.text;
    const colon = text.indexOf(': ');
    if (colon < 0) return;
    const kinds = text.slice(0, colon).split(', ');
    if (kinds.length === 0 || !kinds.every((k) => k in RESERVED_KINDS)) return;
    const rest = text.slice(colon + 2);
    if (rest === 'none' || rest.startsWith('none. ')) return;
    const single = kinds.length === 1 && kinds[0] === 'reserved ID';
    const list = parseSpanList(rest, { comments: true, arrows: single });
    if (!list || !list.items.every((i) => ID_NAME.test(i.text))) return;
    const requiredWhen = list.rest === null ? null : requiredCondition(list.rest);
    for (const kind of kinds) {
      for (const item of list.items) this.addReserved(RESERVED_KINDS[kind] as ReservedName['table'], item.text, requiredWhen, item.rowOf, line.n);
    }
  }

  private readReservedTable(line: MdLine, index: number, end: number): void {
    const table = tableAfter(this.lines, index, end);
    if (!table || table.header[0] !== 'name') return;
    const kind = RESERVED_KINDS[line.text.trim()] as ReservedName['table'];
    for (const row of table.rows) {
      const list = parseSpanList(row.cells[0] ?? '');
      if (!list || list.rest !== null || !list.items.every((i) => ID_NAME.test(i.text))) continue;
      const second = row.cells[1] ?? '';
      const arrow = kind === 'reserved_id' ? (arrowTargetAt(second, 0)?.table ?? null) : null;
      for (const item of list.items) this.addReserved(kind, item.text, requiredCondition(second), arrow, row.n);
    }
  }

  private addReserved(table: ReservedName['table'], id: string, requiredWhen: Condition | null, rowOf: string | null, n: number): void {
    this.spec.reserved.push({ table, id, requiredWhen, rowOf, n });
    if (rowOf !== null) this.spec.uses.push({ table: rowOf, n, checked: true });
  }

  private readInvariantTables(): void {
    this.lines.forEach((line, index) => {
      if (line.fenced || line.text.trim() !== '`data/invariants.csv`') return;
      const table = this.requireTable(line, index, this.lines.length, 'invariant table');
      if (!table) return;
      if (!sameColumns(table.header, INVARIANT_COLUMNS)) {
        this.issue(table.n, `invariant table header must be ${headerText(INVARIANT_COLUMNS)}`);
        return;
      }
      for (const row of table.rows) this.readInvariantRow(row.n, row.cells);
    });
  }

  private readInvariantRow(n: number, cells: readonly string[]): void {
    const values: Record<string, string> = {};
    for (const [i, column] of INVARIANT_COLUMNS.entries()) {
      const cell = cells[i] ?? '';
      const value = cell === '' ? '' : soleCodeSpan(cell);
      if (value === null || cells.length !== INVARIANT_COLUMNS.length) {
        this.issue(n, 'invariant table cells must be empty or one code span');
        return;
      }
      values[column] = value;
    }
    this.spec.invariants.push(values);
  }

  // ## behavior

  private readBehavior(sec: MdSection): void {
    for (const { line, index } of this.body(sec)) {
      if (line.text === '### real adapter') this.readAdapters(index, sec.end);
      else if (line.text === '### collected data') this.readCollectedData(line, index, sec.end);
    }
  }

  private readAdapters(index: number, end: number): void {
    const table = tableAfter(this.lines, index, end);
    if (!table || !sameColumns(table.header, ['adapter key', 'real adapter'])) return;
    for (const row of table.rows) {
      const key = soleCodeSpan(row.cells[0] ?? '');
      const adapter = soleCodeSpan(row.cells[1] ?? '');
      if (key !== null && adapter !== null) this.spec.adapters.push(adapter);
    }
  }

  private readCollectedData(line: MdLine, index: number, end: number): void {
    const table = this.requireTable(line, index, end, 'collected data table');
    if (!table) return;
    if (!sameColumns(table.header, COLLECTED_COLUMNS)) {
      this.issue(table.n, `collected data table header must be ${headerText(COLLECTED_COLUMNS)}`);
      return;
    }
    for (const row of table.rows) {
      const parsed = collectedDataRow(row.cells, this.vocabulary);
      if (typeof parsed === 'string') this.issue(row.n, parsed);
      else this.spec.collectedData.push(parsed);
    }
  }

  // ## settings

  private readSettings(sec: MdSection): void {
    let first = true;
    for (const { line, index } of this.body(sec)) {
      if (line.text.trim() === 'settings constraint') {
        first = false;
        this.readConstraints(line, index, sec.end);
        continue;
      }
      if (!first || !line.text.trimStart().startsWith('|')) continue;
      first = false;
      const table = tableAfter(this.lines, index - 1, sec.end);
      if (table) this.readSettingsTable(table);
    }
  }

  private readSettingsTable(table: MdTable): void {
    if (!sameColumns(table.header, SETTINGS_COLUMNS)) {
      this.issue(table.n, `settings table header must be ${headerText(SETTINGS_COLUMNS)}`);
      return;
    }
    for (const row of table.rows) {
      const parsed = settingRow(row.cells, this.moduleNames);
      if (typeof parsed === 'string') this.issue(row.n, parsed);
      else this.spec.settings.push({ ...parsed, n: row.n });
    }
  }

  private readConstraints(line: MdLine, index: number, end: number): void {
    const table = this.requireTable(line, index, end, 'settings constraint table');
    if (!table) return;
    if (!sameColumns(table.header, CONSTRAINT_COLUMNS)) {
      this.issue(table.n, `settings constraint table header must be ${headerText(CONSTRAINT_COLUMNS)}`);
      return;
    }
    for (const row of table.rows) {
      const left = soleCodeSpan(row.cells[0] ?? '');
      const factor = (row.cells[1] ?? '').trim();
      const right = soleCodeSpan(row.cells[2] ?? '');
      const keysOk = [left, right].every((k) => k !== null && isCoreKey(k, this.moduleNames));
      if (!keysOk || !/^[1-9][0-9]*$/.test(factor) || row.cells.length !== 3) {
        this.issue(row.n, 'settings constraint row needs core settings key code spans "left", "right" and an integer "factor" of 1 or more');
        continue;
      }
      this.spec.settingsConstraints.push({ left: left as string, factor: Number(factor), right: right as string, n: row.n });
    }
  }
}

/** A settings table `type`: `integer`, `number`, `string`, `boolean`, `object` or `array<T>` of such a type, with an optional `?`. */
export function isSettingType(type: string): boolean {
  const element = (t: string): boolean => {
    if (SETTING_BASE_TYPES.has(t)) return true;
    const inner = /^array<(.+)>$/.exec(t)?.[1];
    return inner !== undefined && element(inner);
  };
  return element(type.endsWith('?') ? type.slice(0, -1) : type);
}

function parseJsonValue(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function requiredCondition(text: string): Condition | null {
  const m = REQUIRED_WHEN.exec(text);
  if (!m) return null;
  const value = parseJsonValue(m[2] as string);
  return value.ok ? { path: m[1] as string, value: value.value } : null;
}

/** `none`, or `` `{<name>}`(`<kind>`) `` joined by `, `. Null when malformed. */
export function formatArgumentList(cell: string): FormatArgument['arguments'] | null {
  const text = cell.trim();
  if (cellValue(text) === 'none') return [];
  const out: FormatArgument['arguments'] = [];
  let pos = 0;
  for (;;) {
    const name = codeSpanAt(text, pos);
    const braced = name ? /^\{([^{}]+)\}$/.exec(name.text) : null;
    if (!name || !braced || text[name.end] !== '(') return null;
    const kind = codeSpanAt(text, name.end + 1);
    if (!kind || text[kind.end] !== ')' || !FORMAT_KINDS.has(kind.text)) return null;
    out.push({ name: braced[1] as string, kind: kind.text });
    pos = kind.end + 1;
    if (pos === text.length) return out;
    if (!text.startsWith(', ', pos)) return null;
    pos += 2;
  }
}

export function isCoreKey(key: string, moduleNames: ReadonlySet<string>): boolean {
  const m = CORE_KEY.exec(key);
  return m !== null && moduleNames.has(m[1] as string);
}

function settingRow(cells: readonly string[], moduleNames: ReadonlySet<string>): SettingRow | string {
  const key = soleCodeSpan(cells[0] ?? '');
  const [type, source, owner] = [1, 2, 3].map((i) => cellValue(cells[i] ?? ''));
  if (key === null) return 'settings "key" cell must be one code span';
  if (!isSettingType(type as string)) return `settings type "${String(type)}" is not integer, number, string, boolean, object or array<T>, with an optional "?"`;
  if (source === 'core') {
    if (!isCoreKey(key, moduleNames)) return `core settings key \`${key}\` is not <module>.<camelCase>`;
    if (owner !== 'content' && owner !== 'human') return `settings owner of a core key must be "content" or "human"`;
  } else if (source === 'game') {
    if (owner !== 'none') return 'settings owner of a game item must be "none"';
  } else {
    return 'settings source must be "core" or "game"';
  }
  return { key, type: type as string, source, owner };
}

function splitList(cell: string): string[] {
  return cell.split(', ').map((item) => cellValue(item));
}

function boolCell(cell: string): boolean | null {
  const value = cellValue(cell);
  return value === 'true' ? true : value === 'false' ? false : null;
}

function noneRow(cells: readonly string[], description: string, source: string): CollectedDataRow | string {
  if (!cells.slice(3).every((cell) => cellValue(cell) === 'none')) {
    return 'collected data row of data type "none" must have "none" in purposes, linked, tracking, shared, optional, platforms, condition';
  }
  return {
    dataType: 'none',
    description,
    source,
    purposes: [],
    linked: false,
    tracking: false,
    shared: false,
    optional: false,
    platforms: [],
    condition: null,
  };
}

function conditionCell(cell: string): Condition | null | undefined {
  const value = cellValue(cell);
  if (value === 'none') return null;
  const m = /^(\S+) = (.+)$/.exec(value);
  if (!m) return undefined;
  const json = parseJsonValue(m[2] as string);
  return json.ok ? { path: m[1] as string, value: json.value } : undefined;
}

function platformsCell(cell: string): string[] | null {
  const items = splitList(cell);
  if (items.length === 1 && items[0] === 'all') return [...ALL_PLATFORMS];
  return items.every((p) => ALL_PLATFORMS.includes(p)) ? items : null;
}

function collectedDataRow(cells: readonly string[], vocabulary: CollectedDataVocabulary): CollectedDataRow | string {
  if (cells.length !== COLLECTED_COLUMNS.length) return `collected data row must have ${String(COLLECTED_COLUMNS.length)} cells`;
  const dataType = cellValue(cells[0] as string);
  const description = (cells[1] as string).trim();
  const source = cellValue(cells[2] as string);
  if (!vocabulary.dataTypes.has(dataType)) return `collected data type "${dataType}" is not a data type of the core skill`;
  if (source === '') return 'collected data source is empty';
  if (dataType === 'none') return noneRow(cells, description, source);
  const purposes = splitList(cells[3] as string);
  if (!purposes.every((p) => vocabulary.purposes.has(p))) return 'collected data purposes must be purposes of the core skill joined by ", "';
  const bools = [4, 5, 6, 7].map((i) => boolCell(cells[i] as string));
  if (bools.some((b) => b === null)) return 'collected data linked, tracking, shared, optional must be "true" or "false"';
  const platforms = platformsCell(cells[8] as string);
  if (!platforms) return `collected data platforms must be "all" or platforms of ${ALL_PLATFORMS.join(', ')} joined by ", "`;
  const condition = conditionCell(cells[9] as string);
  if (condition === undefined) return 'collected data condition must be "none" or "<game settings path> = <JSON value>"';
  const [linked, tracking, shared, optional] = bools as boolean[];
  return {
    dataType,
    description,
    source,
    purposes,
    linked: linked as boolean,
    tracking: tracking as boolean,
    shared: shared as boolean,
    optional: optional as boolean,
    platforms,
    condition,
  };
}

/** Reads one spec. Issues that need the other specs are checked by the caller. */
export function readSpec(
  entry: ModuleEntry,
  lines: readonly MdLine[],
  vocabulary: CollectedDataVocabulary,
  moduleNames: ReadonlySet<string>,
): ParsedSpec {
  return new SpecReader(entry, lines, vocabulary, moduleNames).read();
}
