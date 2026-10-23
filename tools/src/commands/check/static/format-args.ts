import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { cellOf, type DataTable } from './lib/csv.ts';
import { isServerContentTs } from './lib/files.ts';
import { acceptedKinds, formatArgs } from './lib/format.ts';
import { calledName, lineOf, stringText, ts, tsChain, tsSource, walkTs } from './lib/ts-source.ts';

/**
 * format args (`push`, `mailbox`, `data` `### format`): a `queue_push`, `send_mail` or `grant_or_mail` call in server
 * content code that picks the message or mail template with a `ReservedId` accessor and passes `args` as an array
 * literal, where an element `name` is not a string literal, the `name` set differs from the format argument names of
 * the row `title` and `body`, or a formatter in the source text or a translation does not take the element's value kind.
 * The value kind of an element is `integer` for `int_value` and `string` for `text_value` (directly or in `value`).
 */
export const NAME = 'format args';

type Kind = 'integer' | 'string';

interface Target {
  table: 'push_message' | 'mail_template';
  id: ts.Expression | undefined;
  args: ts.Expression | undefined;
}

function property(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) return p.initializer;
  }
  return undefined;
}

function targetOf(call: ts.CallExpression): Target | null {
  const name = calledName(call);
  if (name === 'queue_push') return { table: 'push_message', id: call.arguments[2], args: call.arguments[3] };
  if (name === 'grant_or_mail') return { table: 'mail_template', id: call.arguments[3], args: call.arguments[4] };
  const input = call.arguments[1];
  if (name === 'send_mail' && input && ts.isObjectLiteralExpression(input)) {
    return { table: 'mail_template', id: property(input, 'template_id'), args: property(input, 'args') };
  }
  return null;
}

/** Accessor name of a `ReservedId.<name>()` call, or null. */
function reservedAccessor(e: ts.Expression | undefined): string | null {
  if (!e || !ts.isCallExpression(e) || e.arguments.length > 0) return null;
  const chain = tsChain(e.expression);
  const m = chain === null ? null : /(?:^|\.)ReservedId\.([A-Za-z0-9_]+)$/.exec(chain);
  return m ? (m[1] as string) : null;
}

function kindOf(obj: ts.ObjectLiteralExpression): Kind | null {
  const holder = property(obj, 'value');
  const target = holder && ts.isObjectLiteralExpression(holder) ? holder : obj;
  if (property(target, 'int_value')) return 'integer';
  if (property(target, 'text_value')) return 'string';
  const kind = tsChain(property(obj, 'kind') ?? obj);
  if (kind?.endsWith('.Int')) return 'integer';
  if (kind?.endsWith('.Text')) return 'string';
  return null;
}

interface RowTexts {
  /** Source texts of `title` and `body`. */
  sources: string[];
  /** Translation keys of `title` and `body`. */
  keys: string[];
}

function rowTexts(table: DataTable, idName: string): RowTexts | null {
  const row = table.rows.find((r) => r.cells[0] === idName);
  if (!row) return null;
  const sources: string[] = [];
  const keys: string[] = [];
  for (const column of ['title', 'body']) {
    const index = table.names.indexOf(column);
    if (index === -1) continue;
    sources.push(row.cells[index] ?? '');
    const keyColumns = /^tstring<([^>]*)>$/.exec(table.types[index] ?? '')?.[1]?.split(',').map((c) => c.trim()) ?? ['id'];
    const tableName = table.path.replace(/^.*\//, '').replace(/\.csv$/, '');
    keys.push([tableName, column, ...keyColumns.map((c) => cellOf(table, row, c) ?? '')].join('.'));
  }
  return { sources, keys };
}

class Data {
  private readonly sc: StaticContext;
  private translations: Map<string, string[]> | null = null;

  constructor(sc: StaticContext) {
    this.sc = sc;
  }

  async target(accessor: string, table: string): Promise<RowTexts | null> {
    const reserved = await this.sc.table('data/system/reserved_id.csv');
    const row = reserved?.rows.find((r) => r.cells[0] === `[${accessor}]`);
    const value = reserved && row ? cellOf(reserved, row, 'value') : undefined;
    if (!value) return null;
    const data = await this.sc.table(`data/tables/${table}.csv`);
    return data ? rowTexts(data, value.trim()) : null;
  }

  /** Non-empty translation texts by key, every language. */
  async texts(key: string): Promise<string[]> {
    if (!this.translations) {
      const map = new Map<string, string[]>();
      for (const path of this.sc.filter((p) => /^data\/translations\/[^/]+\.csv$/.test(p))) {
        for (const row of (await this.sc.headerTable(path))?.rows ?? []) {
          const text = row.values.text ?? '';
          const k = row.values.key ?? '';
          if (text !== '') map.set(k, [...(map.get(k) ?? []), text]);
        }
      }
      this.translations = map;
    }
    return this.translations.get(key) ?? [];
  }
}

/** `name` → value kind of the `args` elements; findings for elements without a string literal `name`. */
function elementKinds(args: ts.ArrayLiteralExpression, where: string, out: Finding[]): Map<string, Kind | null> {
  const kinds = new Map<string, Kind | null>();
  for (const el of args.elements) {
    const name = ts.isObjectLiteralExpression(el) ? property(el, 'name') : undefined;
    const text = name ? stringText(name) : null;
    if (!ts.isObjectLiteralExpression(el) || text === null) out.push(finding(NAME, where, '`args` element `name` is not a string literal'));
    else kinds.set(text, kindOf(el));
  }
  return kinds;
}

function formatterFindings(texts: readonly string[], kinds: Map<string, Kind | null>, where: string): Finding[] {
  const out: Finding[] = [];
  const reported = new Set<string>();
  for (const arg of texts.flatMap(formatArgs)) {
    const kind = kinds.get(arg.name);
    const key = `${arg.name}:${arg.formatter ?? ''}`;
    if (!kind || acceptedKinds(arg.formatter).has(kind) || reported.has(key)) continue;
    reported.add(key);
    out.push(finding(NAME, where, `formatter \`${arg.formatter ?? 'none'}\` of \`{${arg.name}}\` does not take a ${kind} value`));
  }
  return out;
}

async function callFindings(call: ts.CallExpression, data: Data, where: string): Promise<Finding[]> {
  const target = targetOf(call);
  const accessor = reservedAccessor(target?.id);
  if (!target || accessor === null || !target.args || !ts.isArrayLiteralExpression(target.args)) return [];
  const out: Finding[] = [];
  const kinds = elementKinds(target.args, where, out);
  const texts = await data.target(accessor, target.table);
  if (!texts) return out;
  const expected = new Set(texts.sources.flatMap((t) => formatArgs(t).map((a) => a.name)));
  const given = [...kinds.keys()].sort();
  if (given.length !== expected.size || given.some((n) => !expected.has(n))) {
    out.push(finding(NAME, where, `\`args\` names {${given.join(', ')}} differ from the format arguments {${[...expected].sort().join(', ')}} of the \`${target.table}\` row of \`[${accessor}]\``));
  }
  const translations = (await Promise.all(texts.keys.map((k) => data.texts(k)))).flat();
  out.push(...formatterFindings([...texts.sources, ...translations], kinds, where));
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const data = new Data(sc);
  const out: Finding[] = [];
  for (const path of sc.filter(isServerContentTs)) {
    const source = await tsSource(sc, path);
    const calls: ts.CallExpression[] = [];
    walkTs(source, (node) => {
      if (ts.isCallExpression(node)) calls.push(node);
    });
    for (const call of calls) out.push(...(await callFindings(call, data, at(path, lineOf(source, call)))));
  }
  return out;
}
