import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isClientContentGd, isConstantsFile, snake } from './lib/files.ts';
import type { Expr, GdFile } from './lib/gd-ast.ts';
import type { Token } from './lib/gd-lexer.ts';
import { callsOf, classIndex, isStringLiteral, resolverFor } from './lib/gd-shared.ts';
import type { ClassIndex, TypeResolver } from './lib/gd-types.ts';
import { chainText, visitClass } from './lib/gd-walk.ts';

/**
 * forbidden GDScript API: content code uses an API of the forbidden table of `client-core` Godot `## GDScript`,
 * `Variant`, untyped `Array`/`Dictionary` (written, or inferred by `:=` from an array or dictionary literal), `Array[T]` of a value type with a Packed array, `# ogw:input_boundary`, `assert`, `Tween.tween_property()`,
 * `create_tween()`, `uid://` strings, `OS.is_debug_build()`, `OS.has_feature()`, `Engine.is_editor_hint()`,
 * `@tool`, `static var`, and `@warning_ignore`/`@warning_ignore_start` of a type rule warning (allowed only in core adapters);
 * a node lookup (`get_node()`, `get_node_or_null()`, `$`, `%`, `find_child()`) outside the value of an `@onready var`
 * (client-content engines/godot `## GDScript`: node references are `@onready var` or `@export var` fields); a
 * `client/features/` file whose name is not the snake_case of its `class_name` (`## feature folder`).
 */
export const NAME = 'forbidden GDScript API';

const ALWAYS = new Set(['emit_signal', 'has_method', 'has_signal', 'get_meta', 'set_meta', 'has_meta', 'remove_meta', 'call_group', 'propagate_call', 'create_tween', 'tween_property']);
const CALL_BY_NAME = new Set(['call', 'callv', 'call_deferred']);
const PROPERTY_BY_NAME = new Set(['get', 'set', 'set_deferred', 'get_indexed', 'set_indexed']);
const OBJECT_ONLY_PROPERTY = new Set(['set_deferred', 'get_indexed', 'set_indexed']);
const SIGNAL_BY_NAME = new Set(['connect', 'disconnect', 'is_connected']);
const COLLECTIONS = /^(Array|Dictionary|String|Packed[A-Za-z0-9]+Array)$/;
const FORBIDDEN_CHAINS = new Set(['OS.is_debug_build', 'OS.has_feature', 'Engine.is_editor_hint']);

/** The Packed arrays of a value element type (`client-core` Godot `## GDScript`: a value type list is a Packed array). */
const PACKED_OF: Record<string, string> = {
  int: '`PackedInt32Array` or `PackedInt64Array`',
  float: '`PackedFloat32Array` or `PackedFloat64Array`',
  String: '`PackedStringArray`',
  Vector2: '`PackedVector2Array`',
  Vector3: '`PackedVector3Array`',
  Color: '`PackedColorArray`',
};

/** `Array[T]` at token `i` whose `T` has a Packed array, or null. */
function packedProblem(tokens: readonly Token[], i: number): string | null {
  const [open, element, close] = [tokens[i + 1], tokens[i + 2], tokens[i + 3]];
  if (open?.text !== '[' || element?.type !== 'name' || close?.text !== ']' || !Object.hasOwn(PACKED_OF, element.text)) return null;
  return `\`Array[${element.text}]\`; use ${PACKED_OF[element.text] as string}`;
}

/** What a token starts that is forbidden, or null. */
function tokenProblem(tokens: readonly Token[], i: number): string | null {
  const t = tokens[i] as Token;
  const next = tokens[i + 1];
  const nextIs = (text: string): boolean => next?.text === text && next.type !== 'str';
  if (t.type === 'str') return t.value.includes('uid://') ? '`uid://` string' : null;
  if (t.type === 'op') return t.text === '@' && nextIs('tool') ? '`@tool`' : null;
  if (t.type !== 'name') return null;
  if (t.text === 'Variant') return '`Variant` notation';
  if ((t.text === 'Array' || t.text === 'Dictionary') && !nextIs('[')) return `untyped \`${t.text}\``;
  if (t.text === 'Array') return packedProblem(tokens, i);
  if (t.text === 'assert') return '`assert`';
  if (t.text === 'static' && nextIs('var')) return '`static var`';
  return null;
}

/** Warnings `project.godot` sets to error for the type rules (`client-core` Godot `## GDScript`). */
const TYPE_RULE_WARNINGS = new Set(['untyped_declaration', 'inference_on_variant', 'unsafe_property_access', 'unsafe_method_access', 'unsafe_cast', 'unsafe_call_argument']);
const WARNING_IGNORE = new Set(['warning_ignore', 'warning_ignore_start']);

/** Type rule warnings an `@warning_ignore(...)` or `@warning_ignore_start(...)` at token `i` (`@`) silences. */
function ignoredTypeWarnings(tokens: readonly Token[], i: number): string[] {
  const name = tokens[i + 1];
  if (tokens[i]?.text !== '@' || name?.type !== 'name' || !WARNING_IGNORE.has(name.text) || tokens[i + 2]?.text !== '(') return [];
  const out: string[] = [];
  for (let j = i + 3; j < tokens.length; j++) {
    const t = tokens[j] as Token;
    if (t.type === 'op' && t.text === ')') break;
    if (t.type === 'str' && TYPE_RULE_WARNINGS.has(t.value)) out.push(`\`@${name.text}("${t.value}")\``);
  }
  return out;
}

function tokenFindings(file: GdFile): Finding[] {
  const out: Finding[] = [];
  for (const t of file.tokens) {
    const problem = tokenProblem(file.tokens, t.index);
    if (problem) out.push(finding(NAME, at(file.path, t.line), problem));
    if (t.type === 'op') for (const ignored of ignoredTypeWarnings(file.tokens, t.index)) out.push(finding(NAME, at(file.path, t.line), ignored));
  }
  for (const c of file.comments) {
    if (c.text.trim().startsWith('ogw:input_boundary')) out.push(finding(NAME, at(file.path, c.line), '`# ogw:input_boundary`'));
  }
  return out;
}

/** `:=` declarations whose value is an array or dictionary literal: their inferred type is an untyped `Array` or `Dictionary`. */
function inferredCollectionFindings(file: GdFile): Finding[] {
  const out: Finding[] = [];
  visitClass(file.top, {
    stmt(s) {
      if (s.k !== 'var' || !s.inferred || s.value === null) return;
      if (s.value.k === 'array') out.push(finding(NAME, at(file.path, s.line), `untyped \`Array\` inferred by \`:=\` for \`${s.name}\``));
      if (s.value.k === 'dict') out.push(finding(NAME, at(file.path, s.line), `untyped \`Dictionary\` inferred by \`:=\` for \`${s.name}\``));
    },
  });
  return out;
}

const NODE_LOOKUPS = new Set(['get_node', 'get_node_or_null', 'find_child']);

/** The node lookup an expression is, or null. */
function nodeLookup(e: Expr): string | null {
  if (e.k === 'nodepath') return `\`${e.sigil}\` node path`;
  if (e.k !== 'call') return null;
  const name = e.callee.k === 'name' ? e.callee.name : e.callee.k === 'member' ? e.callee.name : null;
  return name !== null && NODE_LOOKUPS.has(name) ? `\`${name}()\`` : null;
}

/** Node lookups outside the values of `@onready var` declarations. */
function nodeLookupFindings(file: GdFile): Finding[] {
  const onready: [number, number][] = [];
  visitClass(file.top, {
    stmt(s) {
      if (s.k === 'var' && s.value !== null && s.annotations.some((a) => a.name === 'onready')) onready.push([s.value.t0, s.value.t1]);
    },
  });
  const out: Finding[] = [];
  visitClass(file.top, {
    expr(e) {
      const what = nodeLookup(e);
      if (what === null || onready.some(([a, b]) => e.t0 >= a && e.t1 <= b)) return;
      out.push(finding(NAME, at(file.path, e.line), `${what} outside an \`@onready var\`; keep node references in \`@onready var\` or \`@export var\` fields`));
    },
  });
  return out;
}

/** A `client/features/` file, other than the constants file, whose name is not the snake_case of its `class_name`. */
function fileNameFindings(file: GdFile): Finding[] {
  if (!file.path.startsWith('client/features/') || isConstantsFile(file.path)) return [];
  const declared = file.top.body.find((s) => s.k === 'class_name');
  if (declared?.k !== 'class_name') return [];
  const base = file.path.slice(file.path.lastIndexOf('/') + 1, -'.gd'.length);
  const expected = snake(declared.name);
  if (base === expected) return [];
  return [finding(NAME, at(file.path, declared.line), `file name \`${base}.gd\` is not the snake_case of \`class_name ${declared.name}\` (\`${expected}.gd\`)`)];
}

async function receiverIs(resolver: TypeResolver, recv: Expr, test: (name: string) => boolean): Promise<boolean | null> {
  if (recv.k === 'name' && (recv.name === 'self' || recv.name === 'super')) return false;
  const t = await resolver.typeOf(recv);
  if (!t || t.name === '#class') return null;
  return test(t.name);
}

function bareProblem(call: Extract<Expr, { k: 'call' }>, name: string): string | null {
  if ((name === 'Callable' || name === 'Signal') && call.args.length >= 2) return `\`${name}(obj, "name")\``;
  if (ALWAYS.has(name) || CALL_BY_NAME.has(name) || PROPERTY_BY_NAME.has(name) || SIGNAL_BY_NAME.has(name)) return `\`${name}()\``;
  return null;
}

async function callByName(call: Extract<Expr, { k: 'call' }>, name: string, recv: Expr, resolver: TypeResolver): Promise<string | null> {
  const isCallable = await receiverIs(resolver, recv, (n) => n === 'Callable');
  const byName = isStringLiteral(call.args[0]) || (name === 'callv' && call.args.length >= 2);
  return isCallable === false || (isCallable === null && byName) ? `\`${name}()\` by method name` : null;
}

async function propertyByName(name: string, recv: Expr, resolver: TypeResolver): Promise<string | null> {
  const isCollection = await receiverIs(resolver, recv, (n) => COLLECTIONS.test(n));
  return isCollection === false || (isCollection === null && OBJECT_ONLY_PROPERTY.has(name)) ? `\`${name}()\` by property name` : null;
}

async function signalByName(call: Extract<Expr, { k: 'call' }>, name: string, recv: Expr, resolver: TypeResolver): Promise<string | null> {
  if (isStringLiteral(call.args[0]) || (name !== 'connect' && call.args.length >= 2)) return `Object \`${name}()\``;
  return (await receiverIs(resolver, recv, (n) => n === 'Signal')) === false ? `Object \`${name}()\`` : null;
}

/** Why a call is forbidden, or null. */
export async function forbiddenCall(call: Extract<Expr, { k: 'call' }>, resolver: TypeResolver): Promise<string | null> {
  const chain = chainText(call.callee);
  if (chain !== null && FORBIDDEN_CHAINS.has(chain)) return `\`${chain}()\``;
  if (call.callee.k === 'name') return bareProblem(call, call.callee.name);
  if (call.callee.k !== 'member') return null;
  const { name, obj: recv } = call.callee;
  if (ALWAYS.has(name)) return `\`${name}()\``;
  if (CALL_BY_NAME.has(name)) return callByName(call, name, recv, resolver);
  if (PROPERTY_BY_NAME.has(name)) return propertyByName(name, recv, resolver);
  if (SIGNAL_BY_NAME.has(name)) return signalByName(call, name, recv, resolver);
  return null;
}

export async function checkFile(file: GdFile, index: ClassIndex): Promise<Finding[]> {
  const out = [...tokenFindings(file), ...inferredCollectionFindings(file), ...nodeLookupFindings(file), ...fileNameFindings(file)];
  const cache = new Map<unknown, TypeResolver>();
  for (const { call, scope } of callsOf(file)) {
    const why = await forbiddenCall(call, resolverFor(index, file, scope, cache));
    if (why) out.push(finding(NAME, at(file.path, call.line), why));
  }
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const index = await classIndex(sc);
  const results = await Promise.all(sc.filter(isClientContentGd).map(async (path) => checkFile(await sc.gd(path), index)));
  return results.flat();
}
