import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { baseProtoErrors, evalInt, parseVCell } from '../../../../src/commands/core/lib/base-proto-check.ts';
import { codeSpans, markdownTables, stripTicks, tableCells } from '../../../../src/commands/core/lib/markdown.ts';
import { canonicalConstant, parseProto, tokenize } from '../../../../src/commands/core/lib/proto.ts';
import type { Context } from '../../../../src/lib/command.ts';
import { realHarness } from '../../../helpers/workspace.ts';

const ctx = { workspace: () => Promise.resolve({ harness: realHarness }) } as unknown as Context;

describe('markdown and proto readers', () => {
  it('reads tables outside code fences with line numbers and sections', () => {
    const text = ['## API', '', '| a | `b` |', '|---|---|', '| 1 | `x` |', '', '```', '| no | no |', '```', '## DEV', '| c |', '|---|', '| 2 |'].join('\n');
    expect(markdownTables(text)).toEqual([
      { section: 'API', header: ['a', 'b'], rows: [{ line: 5, cells: ['1', '`x`'] }] },
      { section: 'DEV', header: ['c'], rows: [{ line: 13, cells: ['2'] }] },
    ]);
    expect(tableCells('| a | b |')).toEqual(['a', 'b']);
    expect(stripTicks('`a`, `b`')).toBe('a, b');
    expect(codeSpans('(core rpc, `retry`, `silent`)')).toEqual(['retry', 'silent']);
  });

  it('evaluates spec integers and (ogw.v) cells', () => {
    expect(evalInt('2^63−1')).toBe(9223372036854775807n);
    expect(evalInt('−2^63')).toBe(-9223372036854775808n);
    expect(evalInt('-86399999')).toBe(-86399999n);
    expect(evalInt('999912')).toBe(999912n);
    expect(() => evalInt('lots')).toThrow('not an integer: lots');
    expect(parseVCell('none').size).toBe(0);
    expect(Object.fromEntries(parseVCell('`min`: 1, `max`: 2^31−1, `table`: `item`, `unique`: `true`, `max_len_key`: `routing.maxBodyBytes`'))).toEqual({
      min: '1',
      max: '2147483647',
      table: '"item"',
      unique: 'true',
      max_len_key: '"routing.maxBodyBytes"',
    });
    expect(() => parseVCell('min 1')).toThrow('cannot read (ogw.v) entry');
  });

  it('parses messages, options, enums, services and rpc comments', () => {
    const proto = parseProto(`
syntax = "proto3";
package ogw.core;
import "ogw/options.proto";
option java_package = "x";
/* block */
message A {
  // field comment
  int32 id = 1 [(ogw.v) = {min: 1, max: 0x10, table: 'item'}, deprecated = true];
  repeated string names = 2 [(ogw.v).max_count = 3, (ogw.v).unique = true];
  map<string, int64> m = 3;
  oneof pick { bool yes = 4; }
  reserved 9;
  message Inner { int64 v = 1 [(ogw.v) = {min: -5; max: 5}]; }
  enum E { E_UNSPECIFIED = 0; }
  int32 other = 5 [(other.opt) = {x: 1}];
}
enum CoreError { option allow_alias = true; CORE_ERROR_UNSPECIFIED = 0; CORE_ERROR_X = 1 [deprecated = true]; }
service Core {
  option (x) = true;
  // Does a thing.
  // changes: none
  rpc Do (DoRequest) returns (DoResponse) { option (ogw.retry) = true; option (ogw.silent) = false; option deprecated = true; };
  rpc Plain (PlainRequest) returns (stream PlainResponse);
}
extend google.protobuf.FieldOptions { optional int32 z = 5; }
`);
    expect(proto.messages.map((m) => m.name)).toEqual(['A', 'A.Inner']);
    const a = proto.messages[0];
    expect(a?.fields.map((f) => [f.name, f.type, f.number, Object.fromEntries(f.v)])).toEqual([
      ['id', 'int32', 1, { min: '1', max: '16', table: '"item"' }],
      ['names', 'repeated string', 2, { max_count: '3', unique: 'true' }],
      ['m', 'map<string,int64>', 3, {}],
      ['yes', 'bool', 4, {}],
      ['other', 'int32', 5, {}],
    ]);
    expect(Object.fromEntries(proto.messages[1]?.fields[0]?.v ?? [])).toEqual({ min: '-5', max: '5' });
    expect(proto.enums.get('CoreError')).toEqual([{ name: 'CORE_ERROR_UNSPECIFIED', number: 0 }, { name: 'CORE_ERROR_X', number: 1 }]);
    expect(proto.enums.has('A.E')).toBe(true);
    expect(proto.services.get('Core')).toEqual([
      { name: 'Do', options: ['retry'], comment: ['Does a thing.', 'changes: none'] },
      { name: 'Plain', options: [], comment: [] },
    ]);
    expect(canonicalConstant({ kind: 'word', text: '-0x10' })).toBe('-16');
    expect(() => tokenize('message A { int32 x = 1; } @')).toThrow('cannot read proto');
    expect(() => parseProto('message A { int32 x = 1 [(ogw.v) = 1 2]; }')).toThrow('expected , or ]');
    expect(() => parseProto('message A { int32 x 1; }')).toThrow('expected =');
    expect(() => parseProto('message A {')).toThrow('unexpected end of proto');
  });
});

type SpecTable = ReturnType<typeof markdownTables>[number];
type SpecOp = { service: string; name: string; options: string[]; changes: string };

/** Adds the fields of a `message|field|type` table to `messages`. */
function addMessageFields(table: SpecTable, messages: Map<string, string[]>): void {
  const header = table.header.join('|');
  if (header !== 'message|field|type|(ogw.v)' && header !== 'message|field|type') return;
  for (const row of table.rows) {
    const [message = '', field = '', type = ''] = row.cells.slice(0, 3).map(stripTicks);
    const v = header.endsWith('(ogw.v)') ? parseVCell(row.cells[3] ?? '') : new Map<string, string>();
    const list = messages.get(message) ?? [];
    const options = v.size > 0 ? ` [(ogw.v) = {${[...v].map(([k, value]) => `${k}: ${value}`).join(', ')}}]` : '';
    list.push(`  ${type} ${field} = ${String(list.length + 1)}${options};`);
    messages.set(message, list);
  }
}

/** Adds the core rpc rows of an `## API` table and the core cheat rows of a `## DEV` table to `ops`. */
function addOps(table: SpecTable, ops: SpecOp[]): void {
  if (table.section !== 'API' && table.section !== 'DEV') return;
  for (const row of table.rows) {
    const match = /^`([A-Za-z0-9]+)` \(core (rpc|cheat)((?:, `[a-z_]+`)*)\)\. changes: (.+)$/.exec(row.cells[0] ?? '');
    if (!match || (match[2] === 'rpc') !== (table.section === 'API')) continue;
    ops.push({ service: match[2] === 'rpc' ? 'Core' : 'CoreCheat', name: match[1] ?? '', options: codeSpans(match[3] ?? ''), changes: stripTicks(match[4] ?? '') });
  }
}

function serviceLines(ops: readonly SpecOp[]): string[] {
  const out: string[] = [];
  for (const service of ['Core', 'CoreCheat']) {
    out.push(`service ${service} {`);
    for (const op of ops.filter((o) => o.service === service)) {
      const options = op.options.map((o) => ` option (ogw.${o}) = true;`).join('');
      out.push(`  // ${op.name}.`, `  // changes: ${op.changes}`, `  rpc ${op.name}(${op.name}Request) returns (${op.name}Response) {${options} }`);
    }
    out.push('}');
  }
  return out;
}

/** A core.proto that matches the server module specs and `base-proto` tables of the real harness. */
function matchingProto(): string {
  const specDir = join(realHarness, 'skills', 'server-core', 'modules');
  const messages = new Map<string, string[]>();
  const ops: SpecOp[] = [];
  for (const file of readdirSync(specDir).sort()) {
    for (const table of markdownTables(readFileSync(join(specDir, file), 'utf8'))) {
      addMessageFields(table, messages);
      addOps(table, ops);
    }
  }
  const base = markdownTables(readFileSync(join(realHarness, 'skills', 'server-core', 'base-proto.md'), 'utf8'));
  const kinds = (base.find((t) => t.section === 'core UserState kind')?.rows ?? []).map((r) => stripTicks(r.cells[0] ?? ''));
  const errors = (base.find((t) => t.section === 'CoreError')?.rows ?? []).map((r) => `  CORE_ERROR_${stripTicks(r.cells[0] ?? '')} = ${stripTicks(r.cells[1] ?? '')};`);
  const out = ['syntax = "proto3";', 'package ogw.core;', ''];
  const names = [...kinds, ...[...messages.keys()].filter((m) => !kinds.includes(m))];
  for (const name of names) out.push(`message ${name} {`, ...(messages.get(name) ?? []), '}');
  out.push('enum CoreError {', '  CORE_ERROR_UNSPECIFIED = 0;', ...errors, '}', ...serviceLines(ops));
  return `${out.join('\n')}\n`;
}

describe('base proto check', () => {
  let proto = '';
  let impl = '';

  beforeAll(() => {
    proto = matchingProto();
    impl = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-base-proto-')));
    mkdirSync(join(impl, 'proto', 'ogw'), { recursive: true });
  });

  async function check(text: string): Promise<string[]> {
    writeFileSync(join(impl, 'proto', 'ogw', 'core.proto'), text);
    return baseProtoErrors(ctx, impl);
  }

  it('passes a core.proto that matches the specs', async () => {
    expect(await check(proto)).toEqual([]);
  });

  it('reports a missing core.proto', async () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-base-proto-')));
    expect(await baseProtoErrors(ctx, empty)).toEqual(['open-game-works-core-impl/proto/ogw/core.proto is missing']);
  });

  it('reports each kind of difference with the spec line', async () => {
    const changed = proto
      .replace('  int32 calendar_id = 1 [(ogw.v) = {table: "attendance_calendar"}];', '  int64 calendar_id = 2 [(ogw.v) = {table: "item"}];\n  bool extra = 3;')
      .replace('rpc ClaimAttendance(ClaimAttendanceRequest) returns (ClaimAttendanceResponse) { option (ogw.retry) = true; }', 'rpc ClaimAttendance(ClaimAttendanceRequest) returns (ClaimAttendanceResponse) { }')
      .replace('  // changes: none\n  rpc BeginAdReward', '  // changes: something\n  rpc BeginAdReward')
      .replace('  CORE_ERROR_RATE_LIMITED = 2;', '  CORE_ERROR_RATE_LIMITED = 20;\n  CORE_ERROR_EXTRA = 99;')
      .replace('service Core {', 'service Core {\n  rpc Unknown(UnknownRequest) returns (UnknownResponse);')
      .replace(/message ItemBalanceUserState \{[^}]*\}\n/, '');
    const errors = await check(changed);
    const line = (text: string): string => errors.find((e) => e.includes(text)) ?? `missing: ${text}`;
    expect(line('ClaimAttendanceRequest.calendar_id: type')).toMatch(/^skills\/server-core\/modules\/attendance\.md:\d+: ClaimAttendanceRequest\.calendar_id: type is int64 in core\.proto, int32 in the spec$/);
    expect(line('calendar_id: field number')).toContain('field number is 2 in core.proto, 1 by the spec');
    expect(line('calendar_id: (ogw.v)')).toContain('(ogw.v) is table: "item" in core.proto, table: "attendance_calendar" in the spec');
    expect(line('ClaimAttendanceRequest.extra')).toContain('is in core.proto but not in the spec');
    expect(line('rpc ClaimAttendance of service Core: options')).toContain('options are none in core.proto, retry in the spec');
    expect(line('rpc BeginAdReward of service Core: last comment')).toContain('last comment line is "changes: something" in core.proto, "changes: none" in the spec');
    expect(line('CoreError CORE_ERROR_RATE_LIMITED')).toMatch(/^skills\/server-core\/base-proto\.md:\d+: CoreError CORE_ERROR_RATE_LIMITED is 20 in core\.proto, 2 in the table$/);
    expect(errors).toContain('ogw/core.proto: CoreError value CORE_ERROR_EXTRA = 99 is not in the table');
    expect(errors).toContain('ogw/core.proto: rpc Unknown of service Core is in no spec');
    expect(line('message ItemBalanceUserState')).toContain('is not in core.proto');
  });

  it('reports missing rpcs, enum values, fields and kind order', async () => {
    const swapped = proto
      .replace(/message GachaPityUserState \{[^}]*\}\n/, '')
      .replace('enum CoreError {', (m) => `${(/message GachaPityUserState \{[^}]*\}\n/.exec(proto) ?? [''])[0]}${m}`)
      .replace('  CORE_ERROR_INVALID_REQUEST = 1;\n', '')
      .replace(/  \/\/ ClaimAttendance\.\n.*\n.*\n/, '')
      .replace('  int32 day = 1;\n', '');
    const errors = await check(swapped);
    expect(errors.some((e) => /base-proto\.md:\d+: message MissionProgressUserState is declared before GachaPityUserState in core\.proto/.test(e))).toBe(true);
    expect(errors.some((e) => /CoreError CORE_ERROR_INVALID_REQUEST = 1 is not in core\.proto$/.test(e))).toBe(true);
    expect(errors.some((e) => /attendance\.md:\d+: rpc ClaimAttendance of service Core is not in core\.proto$/.test(e))).toBe(true);
    expect(errors.some((e) => /attendance\.md:\d+: ClaimAttendanceResponse\.day is not in core\.proto$/.test(e))).toBe(true);
    expect(await check(proto.replace(/enum CoreError \{[^}]*\}/, ''))).toContain('skills/server-core/base-proto.md:0: CoreError CORE_ERROR_UNSPECIFIED = 0 is not in core.proto');
  });
});
