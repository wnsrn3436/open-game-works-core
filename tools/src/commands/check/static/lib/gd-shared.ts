import type { StaticContext } from './context.ts';
import type { ClassDecl, Expr, FuncDecl, GdFile } from './gd-ast.ts';
import { ClassIndex, TypeResolver } from './gd-types.ts';
import { visitClass, type Scope } from './gd-walk.ts';

const indexes = new WeakMap<StaticContext, Promise<ClassIndex>>();

/** The class index of the checkout, built once per static check run. */
export function classIndex(sc: StaticContext): Promise<ClassIndex> {
  let index = indexes.get(sc);
  if (!index) {
    index = ClassIndex.build(sc);
    indexes.set(sc, index);
  }
  return index;
}

/** Functions around a scope, outermost first. */
export function fnsOf(scope: Scope): FuncDecl[] {
  const out: FuncDecl[] = [];
  if (scope.method) out.push(scope.method);
  if (scope.fn && scope.fn !== scope.method) out.push(scope.fn);
  return out;
}

/** A type resolver for a scope in a file. Cached per scope function. */
export function resolverFor(index: ClassIndex, file: GdFile, scope: Scope, cache: Map<unknown, TypeResolver>): TypeResolver {
  const key = scope.fn ?? scope.cls;
  let resolver = cache.get(key);
  if (!resolver) {
    resolver = new TypeResolver(index, { file, cls: scope.cls, fns: fnsOf(scope) });
    cache.set(key, resolver);
  }
  return resolver;
}

/** Every expression of a file with its scope, in source order. */
export function exprsOf(file: GdFile): { expr: Expr; scope: Scope }[] {
  const out: { expr: Expr; scope: Scope }[] = [];
  visitClass(file.top, {
    expr(expr, scope) {
      out.push({ expr, scope });
    },
  });
  return out;
}

/** Calls of a file with their scope. */
export function callsOf(file: GdFile): { call: Extract<Expr, { k: 'call' }>; scope: Scope }[] {
  return exprsOf(file).flatMap(({ expr, scope }) => (expr.k === 'call' ? [{ call: expr, scope }] : []));
}

/** True when an expression is a string literal (any kind) that is not empty. */
export function isNonEmptyString(expr: Expr | undefined): boolean {
  return expr?.k === 'str' && expr.value !== '';
}

export function isStringLiteral(expr: Expr | undefined): boolean {
  return expr?.k === 'str';
}

export type { ClassDecl };
