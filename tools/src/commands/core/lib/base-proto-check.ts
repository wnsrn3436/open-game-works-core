import { readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists } from '../../../lib/fsx.ts';
import { codeSpans, markdownTables, stripTicks, type MdTable } from './markdown.ts';
import { parseProto, type ProtoFile, type ProtoMessage } from './proto.ts';

/** Integer of a spec cell number such as `2^63−1`, `−2^63`, `-86399999`. */
export function evalInt(expr: string): bigint {
  const text = expr.replace(/−/g, '-').replace(/\s+/g, '');
  if (!/^[-+]?\d+(\^\d+)?([-+]\d+(\^\d+)?)*$/.test(text)) throw new OgwError(`not an integer: ${expr}`);
  let total = 0n;
  for (const match of text.matchAll(/([-+]?)(\d+)(?:\^(\d+))?/g)) {
    const base = BigInt(match[2] as string);
    const value = match[3] === undefined ? base : base ** BigInt(match[3]);
    total += match[1] === '-' ? -value : value;
  }
  return total;
}

/** `(ogw.v)` cell of a request field table: option name to canonical value (see `ProtoField.v`). */
export function parseVCell(cell: string): Map<string, string> {
  const v = new Map<string, string>();
  if (cell.trim() === 'none') return v;
  for (const part of cell.split(/,\s*(?=`)/)) {
    const match = /^`([a-z_]+)`:\s*(.+)$/.exec(part.trim());
    if (!match) throw new OgwError(`cannot read (ogw.v) entry: ${part}`);
    const value = (match[2] as string).trim();
    const span = /^`([^`]*)`$/.exec(value)?.[1];
    if (span === undefined) v.set(match[1] as string, evalInt(value).toString());
    else v.set(match[1] as string, span === 'true' || span === 'false' ? span : JSON.stringify(span));
  }
  return v;
}

function normalType(type: string): string {
  return type.trim().replace(/\s+/g, ' ').replace(/\s*([<>,])\s*/g, '$1');
}

function mapText(v: Map<string, string>): string {
  return [...v].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, value]) => `${k}: ${value}`).join(', ') || 'none';
}

interface SpecRow {
  file: string;
  line: number;
  message: string;
  field: string;
  type: string;
  v: Map<string, string> | null;
}

interface SpecOp {
  file: string;
  line: number;
  name: string;
  service: 'Core' | 'CoreCheat';
  options: string[];
  changes: string;
}

const OP = /^`([A-Za-z0-9]+)` \(core (rpc|cheat)((?:, `[a-z_]+`)*)\)\. changes: (.+)$/;

function readFieldTable(file: string, table: MdTable, rows: SpecRow[]): void {
  const header = table.header.join('|');
  const request = header === 'message|field|type|(ogw.v)';
  if (!request && header !== 'message|field|type') return;
  for (const row of table.rows) {
    const [message = '', field = '', type = '', v = ''] = row.cells.map((cell, i) => (i < 3 ? stripTicks(cell) : cell));
    rows.push({ file, line: row.line, message, field, type, v: request ? parseVCell(v) : null });
  }
}

function readOps(file: string, table: MdTable, ops: SpecOp[]): void {
  if (table.section !== 'API' && table.section !== 'DEV') return;
  for (const row of table.rows) {
    const match = OP.exec(row.cells[0] ?? '');
    if (!match) continue;
    const kind = match[2] as string;
    if ((kind === 'rpc') !== (table.section === 'API')) continue;
    ops.push({
      file,
      line: row.line,
      name: match[1] as string,
      service: kind === 'rpc' ? 'Core' : 'CoreCheat',
      options: codeSpans(match[3] as string).sort(),
      changes: stripTicks(match[4] as string).trim(),
    });
  }
}

/** Spec files of the server modules: the `spec` links of `server-core` `## module`. */
async function serverSpecFiles(harness: string): Promise<string[]> {
  const skill = join(harness, 'skills', 'server-core', 'SKILL.md');
  const tables = markdownTables(await readFile(skill, 'utf8')).filter((t) => t.section === 'module' && t.header[1] === 'spec');
  const files: string[] = [];
  for (const row of tables.flatMap((t) => t.rows)) {
    const link = /\]\(([^)]+)\)/.exec(row.cells[1] ?? '')?.[1];
    if (link) files.push(join(dirname(skill), link));
  }
  return files;
}

function rel(harness: string, file: string): string {
  return relative(harness, file).split(sep).join('/');
}

function fieldErrors(rows: readonly SpecRow[], proto: ProtoFile): string[] {
  const errors: string[] = [];
  const byMessage = new Map<string, SpecRow[]>();
  for (const row of rows) byMessage.set(row.message, [...(byMessage.get(row.message) ?? []), row]);
  const messages = new Map(proto.messages.map((m) => [m.name, m]));
  for (const [name, specRows] of byMessage) {
    const message = messages.get(name);
    const first = specRows[0] as SpecRow;
    if (!message) {
      errors.push(`${first.file}:${String(first.line)}: message ${name} is not in core.proto`);
      continue;
    }
    specRows.forEach((row, index) => {
      errors.push(...rowErrors(row, index + 1, message));
    });
    for (const field of message.fields) {
      if (!specRows.some((row) => row.field === field.name)) errors.push(`${first.file}:${String(first.line)}: ${name}.${field.name} is in core.proto but not in the spec`);
    }
  }
  return errors;
}

function rowErrors(row: SpecRow, number: number, message: ProtoMessage): string[] {
  const where = `${row.file}:${String(row.line)}: ${row.message}.${row.field}`;
  const field = message.fields.find((f) => f.name === row.field);
  if (!field) return [`${where} is not in core.proto`];
  const errors: string[] = [];
  if (normalType(field.type) !== normalType(row.type)) errors.push(`${where}: type is ${field.type} in core.proto, ${row.type} in the spec`);
  if (field.number !== number) errors.push(`${where}: field number is ${String(field.number)} in core.proto, ${String(number)} by the spec`);
  if (row.v && mapText(field.v) !== mapText(row.v)) errors.push(`${where}: (ogw.v) is ${mapText(field.v)} in core.proto, ${mapText(row.v)} in the spec`);
  return errors;
}

function opErrors(ops: readonly SpecOp[], proto: ProtoFile): string[] {
  const errors: string[] = [];
  for (const service of ['Core', 'CoreCheat'] as const) {
    const rpcs = proto.services.get(service) ?? [];
    const specOps = ops.filter((op) => op.service === service);
    for (const op of specOps) {
      const where = `${op.file}:${String(op.line)}: rpc ${op.name} of service ${service}`;
      const rpc = rpcs.find((r) => r.name === op.name);
      if (!rpc) {
        errors.push(`${where} is not in core.proto`);
        continue;
      }
      if (rpc.options.join(',') !== op.options.join(',')) errors.push(`${where}: options are ${rpc.options.join(', ') || 'none'} in core.proto, ${op.options.join(', ') || 'none'} in the spec`);
      const last = rpc.comment.at(-1) ?? '';
      if (last !== `changes: ${op.changes}`) errors.push(`${where}: last comment line is "${last}" in core.proto, "changes: ${op.changes}" in the spec`);
    }
    for (const rpc of rpcs) if (!specOps.some((op) => op.name === rpc.name)) errors.push(`ogw/core.proto: rpc ${rpc.name} of service ${service} is in no spec`);
  }
  return errors;
}

function coreErrorErrors(table: MdTable | undefined, file: string, proto: ProtoFile): string[] {
  if (!table) return [`${file}: no CoreError table`];
  const values = proto.enums.get('CoreError') ?? [];
  const expected = [{ name: 'CORE_ERROR_UNSPECIFIED', number: 0, line: 0 }, ...table.rows.map((row) => ({
    name: `CORE_ERROR_${stripTicks(row.cells[0] ?? '')}`,
    number: Number(stripTicks(row.cells[1] ?? '')),
    line: row.line,
  }))];
  const errors: string[] = [];
  for (const want of expected) {
    const have = values.find((v) => v.name === want.name);
    const where = `${file}:${String(want.line)}: CoreError ${want.name}`;
    if (!have) errors.push(`${where} = ${String(want.number)} is not in core.proto`);
    else if (have.number !== want.number) errors.push(`${where} is ${String(have.number)} in core.proto, ${String(want.number)} in the table`);
  }
  for (const have of values) if (!expected.some((w) => w.name === have.name)) errors.push(`ogw/core.proto: CoreError value ${have.name} = ${String(have.number)} is not in the table`);
  return errors;
}

function kindOrderErrors(table: MdTable | undefined, file: string, proto: ProtoFile): string[] {
  if (!table) return [`${file}: no core UserState kind table`];
  const order = proto.messages.map((m) => m.name);
  const errors: string[] = [];
  let previous = -1;
  let previousName = '';
  for (const row of table.rows) {
    const kind = stripTicks(row.cells[0] ?? '');
    const index = order.indexOf(kind);
    if (index === -1) errors.push(`${file}:${String(row.line)}: message ${kind} is not in core.proto`);
    else if (index < previous) errors.push(`${file}:${String(row.line)}: message ${kind} is declared before ${previousName} in core.proto`);
    else {
      previous = index;
      previousName = kind;
    }
  }
  return errors;
}

/** The base proto check of `ogw core test` (`base-proto` `## base proto check`). */
export async function baseProtoErrors(ctx: Context, implDir: string): Promise<string[]> {
  const harness = (await ctx.workspace()).harness;
  const protoFile = join(implDir, 'proto', 'ogw', 'core.proto');
  if (!exists(protoFile)) return ['open-game-works-core-impl/proto/ogw/core.proto is missing'];
  const proto = parseProto(await readFile(protoFile, 'utf8'));
  const rows: SpecRow[] = [];
  const ops: SpecOp[] = [];
  for (const file of await serverSpecFiles(harness)) {
    for (const table of markdownTables(await readFile(file, 'utf8'))) {
      readFieldTable(rel(harness, file), table, rows);
      readOps(rel(harness, file), table, ops);
    }
  }
  const baseFile = join(harness, 'skills', 'server-core', 'base-proto.md');
  const baseTables = markdownTables(await readFile(baseFile, 'utf8'));
  const baseRel = rel(harness, baseFile);
  return [
    ...fieldErrors(rows, proto),
    ...opErrors(ops, proto),
    ...coreErrorErrors(baseTables.find((t) => t.section === 'CoreError'), baseRel, proto),
    ...kindOrderErrors(baseTables.find((t) => t.section === 'core UserState kind'), baseRel, proto),
  ];
}
