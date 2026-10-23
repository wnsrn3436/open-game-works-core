import { parseKey } from '../../resource/lib/list.ts';
import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { cellOf } from './lib/csv.ts';
import { isClientContentGd, isClientTest, isConstantsFile, isServerContentTs, isServerTest } from './lib/files.ts';
import type { GdFile } from './lib/gd-ast.ts';
import { numberValue, type Token } from './lib/gd-lexer.ts';
import { callsOf } from './lib/gd-shared.ts';
import { chainText, visitClass } from './lib/gd-walk.ts';
import { translationKeyInputs } from './lib/specs.ts';
import { lineOf, ts, tsSource, walkTs } from './lib/ts-source.ts';

/**
 * data literal (`data` `## content code rules`): a number literal outside the constants files other than
 * `0`, `1`, `-1`, `2`, `0.5`, and such a literal in a constants file outside its named constant declarations;
 * a constants file constant declaration without a same-line reason comment;
 * a non-empty string literal passed to a core operation input the core spec calls a translation key;
 * a string literal that holds an ID name of the data (an `id` cell of a `data/tables/` or `data/system/` table) or
 * that is a resource key (`resource` `## resource key`).
 * Test code and log calls (client `LogCore.*`, server `logging` `log`) are not read.
 */
export const NAME = 'data literal';

const ALLOWED = new Set([0, 1, -1, 2, 0.5]);
const OPERAND_END = new Set(['num', 'str', 'nodepath']);
const KEYWORDS = new Set(['return', 'and', 'or', 'not', 'in', 'if', 'elif', 'else', 'while', 'for', 'match', 'when', 'await', 'is', 'as', 'var', 'const']);

function endsOperand(t: Token | undefined): boolean {
  if (!t) return false;
  if (OPERAND_END.has(t.type)) return true;
  if (t.type === 'name') return !KEYWORDS.has(t.text);
  return t.type === 'op' && (t.text === ')' || t.text === ']' || t.text === '}');
}

/** Value of a number token with a unary minus in front applied. */
function signedValue(tokens: readonly Token[], t: Token): number {
  const prev = tokens[t.index - 1];
  const negative = prev?.type === 'op' && prev.text === '-' && !endsOperand(tokens[t.index - 2]);
  return negative ? -numberValue(t.text) : numberValue(t.text);
}

/** ID names of the data: the `id` cells of the tables in `data/tables/` and `data/system/`. */
export async function dataIdNames(sc: StaticContext): Promise<Set<string>> {
  const names = new Set<string>();
  for (const path of sc.filter((p) => /^data\/(tables|system)\/[^/]+\.csv$/.test(p))) {
    const table = await sc.table(path);
    for (const row of table?.rows ?? []) {
      const id = table ? cellOf(table, row, 'id') : undefined;
      if (id !== undefined && /^\[[a-z0-9_]+\]$/.test(id.trim())) names.add(id.trim());
    }
  }
  return names;
}

const ID_NAME_IN_TEXT = /\[[a-z0-9_]+\]/g;

/** What makes a string literal game data: an ID name of the data in it, or the whole value being a resource key; or null. */
function stringProblem(value: string, ids: ReadonlySet<string>): string | null {
  const id = (value.match(ID_NAME_IN_TEXT) ?? []).find((name) => ids.has(name));
  if (id !== undefined) return `ID name \`${id}\` in a string literal`;
  return parseKey(value) === null ? null : `resource key \`${value}\` in a string literal`;
}

function logRanges(file: GdFile): [number, number][] {
  return callsOf(file)
    .filter(({ call }) => (chainText(call.callee) ?? '').startsWith('LogCore.'))
    .map(({ call }) => [call.t0, call.t1]);
}

/** Where a number literal may be: outside a constants file, or outside a named constant declaration in one. */
function placeText(path: string): string {
  return isConstantsFile(path) ? 'outside a named constant declaration' : 'outside a constants file';
}

/** Number literals other than the allowed values, outside log calls and the token ranges `skip`. */
function gdNumbers(file: GdFile, skip: [number, number][] = []): Finding[] {
  const ranges = [...logRanges(file), ...skip];
  const out: Finding[] = [];
  for (const t of file.tokens) {
    if (t.type !== 'num' || ranges.some(([a, b]) => t.index >= a && t.index <= b)) continue;
    const value = signedValue(file.tokens, t);
    if (!ALLOWED.has(value)) out.push(finding(NAME, at(file.path, t.line), `number literal \`${value < 0 ? '-' : ''}${t.text}\` ${placeText(file.path)}`));
  }
  return out;
}

/** A constants file: each constant declaration has a same-line reason comment, and numbers are only in constant declarations. */
function gdConstants(file: GdFile): Finding[] {
  const out: Finding[] = [];
  const declarations: [number, number][] = [];
  visitClass(file.top, {
    stmt(s) {
      if (s.k !== 'var' || !s.isConst) return;
      declarations.push([s.t0, s.t1]);
      const commented = file.comments.some((c) => c.line === s.line && c.trailing && c.text.trim() !== '');
      if (!commented) out.push(finding(NAME, at(file.path, s.line), `constant \`${s.name}\` has no same-line comment with the reason it is not game data`));
    },
  });
  return [...out, ...gdNumbers(file, declarations)];
}

function gdTranslationKeys(file: GdFile, inputs: Map<string, number[]>): Finding[] {
  const out: Finding[] = [];
  for (const { call } of callsOf(file)) {
    const chain = chainText(call.callee);
    const positions = chain === null ? undefined : inputs.get(chain);
    for (const i of positions ?? []) {
      const arg = call.args[i];
      if (arg?.k === 'str' && arg.value !== '') out.push(finding(NAME, at(file.path, arg.line), `string literal passed as a translation key to \`${chain ?? ''}\``));
    }
  }
  return out;
}

/** String literals that hold an ID name of the data or are a resource key, outside log calls. */
function gdStrings(file: GdFile, ids: ReadonlySet<string>): Finding[] {
  const ranges = logRanges(file);
  const out: Finding[] = [];
  for (const t of file.tokens) {
    if (t.type !== 'str' || ranges.some(([a, b]) => t.index >= a && t.index <= b)) continue;
    const problem = stringProblem(t.value, ids);
    if (problem !== null) out.push(finding(NAME, at(file.path, t.line), problem));
  }
  return out;
}

export function checkGd(file: GdFile, inputs: Map<string, number[]>, ids: ReadonlySet<string> = new Set()): Finding[] {
  const numbers = isConstantsFile(file.path) ? gdConstants(file) : gdNumbers(file);
  return [...numbers, ...gdTranslationKeys(file, inputs), ...gdStrings(file, ids)];
}

function tsNumber(node: ts.Node): number | null {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isBigIntLiteral(node)) return Number(node.text.replace(/n$/, ''));
  return null;
}

/**
 * Calls of the server `logging` `log` operation (`server-core` `logging`) through the `logging` module object of
 * content `register(core)`: `core.logging.log(...)`, or `logging.log(...)` once taken out of it. Their arguments are a
 * log message.
 */
function tsLogCalls(source: ts.SourceFile): Set<ts.Node> {
  const calls = new Set<ts.Node>();
  walkTs(source, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'log') return;
    const receiver = node.expression.expression;
    if ((ts.isIdentifier(receiver) && receiver.text === 'logging') || (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'logging')) calls.add(node);
  });
  return calls;
}

/** `stringProblem` of a string literal expression (not a literal type or a module name), or null. */
function tsStringProblem(node: ts.Node, ids: ReadonlySet<string>): string | null {
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return null;
  const parent = node.parent;
  if (ts.isLiteralTypeNode(parent) || ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return null;
  return stringProblem(node.text, ids);
}

export function checkTs(path: string, source: ts.SourceFile, ids: ReadonlySet<string> = new Set()): Finding[] {
  const out: Finding[] = [];
  const logCalls = tsLogCalls(source);
  const inLog = (node: ts.Node): boolean => ts.findAncestor(node, (n) => logCalls.has(n)) !== undefined;
  /** Top-level `const` statements of a constants file: the named constant declarations. */
  const declarations = new Set<ts.Node>();
  if (isConstantsFile(path)) {
    for (const stmt of source.statements) {
      if (!ts.isVariableStatement(stmt) || !(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;
      declarations.add(stmt);
      const endLine = source.getLineAndCharacterOfPosition(stmt.end).line;
      const comments = ts.getTrailingCommentRanges(source.text, stmt.end) ?? [];
      const commented = comments.some((c) => source.getLineAndCharacterOfPosition(c.pos).line === endLine);
      if (!commented) out.push(finding(NAME, at(path, lineOf(source, stmt)), 'constant has no same-line comment with the reason it is not game data'));
    }
  }
  const declared = (node: ts.Node): boolean => ts.findAncestor(node, (n) => declarations.has(n)) !== undefined;
  walkTs(source, (node) => {
    const problem = inLog(node) ? null : tsStringProblem(node, ids);
    if (problem !== null) out.push(finding(NAME, at(path, lineOf(source, node)), problem));
    const raw = tsNumber(node);
    if (raw === null || ts.isLiteralTypeNode(node.parent) || declared(node) || inLog(node)) return;
    const negative = ts.isPrefixUnaryExpression(node.parent) && node.parent.operator === ts.SyntaxKind.MinusToken;
    const value = negative ? -raw : raw;
    if (!ALLOWED.has(value)) out.push(finding(NAME, at(path, lineOf(source, node)), `number literal \`${negative ? '-' : ''}${node.getText(source)}\` ${placeText(path)}`));
  });
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const inputs = await translationKeyInputs(sc);
  const ids = await dataIdNames(sc);
  const gd = sc.filter((p) => isClientContentGd(p) && !isClientTest(p)).map(async (p) => checkGd(await sc.gd(p), inputs, ids));
  const tsFiles = sc.filter((p) => isServerContentTs(p) && !isServerTest(p)).map(async (p) => checkTs(p, await tsSource(sc, p), ids));
  return (await Promise.all([...gd, ...tsFiles])).flat();
}
