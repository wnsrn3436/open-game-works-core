import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isClientContentGd } from './lib/files.ts';
import type { Expr, GdFile } from './lib/gd-ast.ts';
import { classIndex, exprsOf, resolverFor } from './lib/gd-shared.ts';
import type { ClassIndex, TypeResolver } from './lib/gd-types.ts';
import { isNumberLiteral, visitClass } from './lib/gd-walk.ts';
import type { Scope } from './lib/gd-walk.ts';

/**
 * literal timing: content code assigns (with any assignment operator) a number literal to `AnimationPlayer.speed_scale`
 * or `Timer.wait_time`, or passes a number literal as `AnimationPlayer.play()` `custom_blend` or `custom_speed`,
 * `SceneTree.create_timer()` time, or `Timer.wait_time`. A value built only from number literals (arithmetic, a ternary
 * whose two results are such values, `as`) is a number literal. A receiver whose type is not known counts as the named class.
 */
export const NAME = 'literal timing';

/** True when the expression's type is `base` or a subclass, or unknown. */
async function mayBe(resolver: TypeResolver, recv: Expr | null, base: string): Promise<boolean> {
  if (recv === null) return resolver.index.isA(resolver.self, base);
  const t = await resolver.typeOf(recv);
  if (!t) return true;
  if (t.name === base) return true;
  const ref = await resolver.classOf(t);
  return ref ? resolver.index.isA(ref, base) : false;
}

const PROPERTY_CLASS: Record<string, string> = { speed_scale: 'AnimationPlayer', wait_time: 'Timer' };
const ARITHMETIC = new Set(['+', '-', '*', '/', '%', '**']);

/** True when the value is built only from number literals: arithmetic, a ternary of two such values, `as`. */
export function isLiteralValue(e: Expr): boolean {
  if (isNumberLiteral(e)) return true;
  if (e.k === 'unary') return (e.op === '-' || e.op === '+') && isLiteralValue(e.expr);
  if (e.k === 'binary') return ARITHMETIC.has(e.op) && isLiteralValue(e.left) && isLiteralValue(e.right);
  if (e.k === 'ternary') return isLiteralValue(e.then) && isLiteralValue(e.else);
  if (e.k === 'cast') return isLiteralValue(e.expr);
  return false;
}

async function assignment(target: Expr, value: Expr, resolver: TypeResolver): Promise<string | null> {
  if (!isLiteralValue(value)) return null;
  const name = target.k === 'member' ? target.name : target.k === 'name' ? target.name : null;
  const base = name === null ? undefined : PROPERTY_CLASS[name];
  if (!base || name === null) return null;
  const recv = target.k === 'member' ? target.obj : null;
  if (recv === null && resolver.isLocal(name)) return null;
  return (await mayBe(resolver, recv, base)) ? `number literal assigned to \`${base}.${name}\`` : null;
}

interface CallRule {
  /** Argument positions that must not be number literals. */
  args: number[];
  /** Receiver class; an unknown receiver counts unless `known` is set. */
  cls: string | null;
  known: boolean;
  message: string;
}

const CALL_RULES: Record<string, CallRule> = {
  play: { args: [1, 2], cls: 'AnimationPlayer', known: false, message: 'number literal passed to `AnimationPlayer.play()`' },
  create_timer: { args: [0], cls: null, known: false, message: 'number literal passed to `SceneTree.create_timer()`' },
  set_speed_scale: { args: [0], cls: 'AnimationPlayer', known: false, message: 'number literal passed to `AnimationPlayer.speed_scale`' },
  set_wait_time: { args: [0], cls: 'Timer', known: false, message: 'number literal passed to `Timer.wait_time`' },
  start: { args: [0], cls: 'Timer', known: true, message: 'number literal passed to `Timer.wait_time`' },
};

/** True when the receiver is `base` or a subclass; an unknown type is false. */
async function knownAs(resolver: TypeResolver, recv: Expr | null, base: string): Promise<boolean> {
  if (recv === null) return resolver.index.isA(resolver.self, base);
  const t = await resolver.typeOf(recv);
  if (t?.name === base) return true;
  const ref = await resolver.classOf(t);
  return ref !== null && (await resolver.index.isA(ref, base));
}

async function call(e: Extract<Expr, { k: 'call' }>, resolver: TypeResolver): Promise<string | null> {
  const callee = e.callee;
  if (callee.k !== 'member' && callee.k !== 'name') return null;
  const rule = CALL_RULES[callee.name];
  const literal = (i: number): boolean => {
    const arg = e.args[i];
    return arg !== undefined && isLiteralValue(arg);
  };
  if (!rule?.args.some(literal)) return null;
  const recv = callee.k === 'member' ? callee.obj : null;
  if (rule.cls === null) return rule.message;
  const matches = rule.known ? await knownAs(resolver, recv, rule.cls) : await mayBe(resolver, recv, rule.cls);
  return matches ? rule.message : null;
}

export async function checkFile(file: GdFile, index: ClassIndex): Promise<Finding[]> {
  const out: Finding[] = [];
  const cache = new Map<unknown, TypeResolver>();
  const assigns: { target: Expr; value: Expr; line: number; scope: Scope }[] = [];
  visitClass(file.top, {
    stmt(s, scope) {
      if (s.k === 'assign') assigns.push({ target: s.target, value: s.value, line: s.line, scope });
    },
  });
  for (const a of assigns) {
    const why = await assignment(a.target, a.value, resolverFor(index, file, a.scope, cache));
    if (why) out.push(finding(NAME, at(file.path, a.line), why));
  }
  for (const { expr, scope } of exprsOf(file)) {
    if (expr.k !== 'call') continue;
    const why = await call(expr, resolverFor(index, file, scope, cache));
    if (why) out.push(finding(NAME, at(file.path, expr.line), why));
  }
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const index = await classIndex(sc);
  return (await Promise.all(sc.filter(isClientContentGd).map(async (p) => checkFile(await sc.gd(p), index)))).flat();
}
