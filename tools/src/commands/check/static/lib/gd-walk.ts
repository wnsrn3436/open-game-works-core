import type { ClassDecl, Expr, FuncDecl, Stmt } from './gd-ast.ts';

/** Where a statement or expression sits. */
export interface Scope {
  cls: ClassDecl;
  /** Innermost function (a lambda counts), or null at class level. */
  fn: FuncDecl | null;
  /** Outermost named function of the class the node is in, or null at class level. */
  method: FuncDecl | null;
}

/** Statement lists directly nested in a statement (not counting lambdas inside expressions). */
export function childBodies(stmt: Stmt): Stmt[][] {
  switch (stmt.k) {
    case 'if':
      return [...stmt.branches.map((b) => b.body), stmt.elseBody];
    case 'for':
    case 'while':
      return [stmt.body];
    case 'match':
      return stmt.branches.map((b) => b.body);
    default:
      return [];
  }
}

/** Expressions directly held by a statement. */
export function stmtExprs(stmt: Stmt): Expr[] {
  switch (stmt.k) {
    case 'expr':
      return [stmt.expr];
    case 'assign':
      return [stmt.target, stmt.value];
    case 'var':
      return stmt.value ? [stmt.value] : [];
    case 'if':
      return stmt.branches.map((b) => b.cond);
    case 'for':
      return [stmt.iter];
    case 'while':
      return [stmt.cond];
    case 'match':
      return [stmt.subject, ...stmt.branches.flatMap((b) => (b.guard ? [b.guard] : []))];
    case 'return':
      return stmt.value ? [stmt.value] : [];
    case 'enum':
      return stmt.members.flatMap((m) => (m.value ? [m.value] : []));
    case 'func':
      return stmt.params.flatMap((p) => (p.value ? [p.value] : []));
    case 'annotation':
      return stmt.annotation.args;
    default:
      return [];
  }
}

/** Sub-expressions of an expression (lambda bodies not included). */
export function exprChildren(expr: Expr): Expr[] {
  switch (expr.k) {
    case 'member':
      return [expr.obj];
    case 'call':
      return [expr.callee, ...expr.args];
    case 'index':
      return [expr.obj, expr.index];
    case 'unary':
    case 'await':
    case 'cast':
    case 'is':
      return [expr.expr];
    case 'binary':
      return [expr.left, expr.right];
    case 'ternary':
      return [expr.cond, expr.then, expr.else];
    case 'array':
      return expr.items;
    case 'dict':
      return expr.entries.flatMap((e) => [e.key, e.value]);
    default:
      return [];
  }
}

export interface Visitor {
  stmt?(stmt: Stmt, scope: Scope): void;
  expr?(expr: Expr, scope: Scope): void;
}

function visitExpr(expr: Expr, scope: Scope, v: Visitor): void {
  v.expr?.(expr, scope);
  if (expr.k === 'lambda') {
    visitFunc(expr.fn, scope, v, true);
    return;
  }
  for (const child of exprChildren(expr)) visitExpr(child, scope, v);
}

function visitFunc(fn: FuncDecl, scope: Scope, v: Visitor, lambda: boolean): void {
  for (const p of fn.params) if (p.value) visitExpr(p.value, scope, v);
  const inner: Scope = { cls: scope.cls, fn, method: lambda ? scope.method : fn };
  visitStmts(fn.body, inner, v);
}

/** Visits statements and expressions in order, nested bodies, lambdas, accessors and inner classes included. */
export function visitStmts(stmts: readonly Stmt[], scope: Scope, v: Visitor): void {
  for (const stmt of stmts) {
    v.stmt?.(stmt, scope);
    if (stmt.k === 'func') {
      for (const a of stmt.annotations) for (const e of a.args) visitExpr(e, scope, v);
      visitFunc(stmt, scope, v, false);
      continue;
    }
    if (stmt.k === 'class') {
      visitStmts(stmt.body, { cls: stmt, fn: null, method: null }, v);
      continue;
    }
    if (stmt.k === 'var') {
      for (const a of stmt.annotations) for (const e of a.args) visitExpr(e, scope, v);
      for (const acc of stmt.accessors) visitFunc(acc, scope, v, scope.fn !== null);
    }
    for (const e of stmtExprs(stmt)) visitExpr(e, scope, v);
    for (const body of childBodies(stmt)) visitStmts(body, scope, v);
  }
}

/** Visits a whole class (the script class for `file.top`). */
export function visitClass(cls: ClassDecl, v: Visitor): void {
  visitStmts(cls.body, { cls, fn: null, method: null }, v);
}

/** Visits one function body (its lambdas included). */
export function visitFuncBody(fn: FuncDecl, cls: ClassDecl, v: Visitor): void {
  visitStmts(fn.body, { cls, fn, method: fn }, v);
}

/** Every expression inside an expression (itself included, lambdas included). */
export function eachExpr(expr: Expr, fn: (e: Expr) => void): void {
  fn(expr);
  if (expr.k === 'lambda') {
    visitStmts(expr.fn.body, { cls: dummyClass, fn: expr.fn, method: null }, { expr: fn });
    return;
  }
  for (const child of exprChildren(expr)) eachExpr(child, fn);
}

const dummyClass: ClassDecl = { k: 'class', name: null, extendsName: null, extendsPath: null, body: [], isTop: false, outer: null, line: 0, t0: 0, t1: 0 };

/** Functions declared directly in a class. */
export function classFuncs(cls: ClassDecl): FuncDecl[] {
  return cls.body.filter((s): s is FuncDecl => s.k === 'func');
}

/** Inner classes declared directly in a class. */
export function innerClasses(cls: ClassDecl): ClassDecl[] {
  return cls.body.filter((s): s is ClassDecl => s.k === 'class');
}

/** The class and every inner class, depth first. */
export function allClasses(cls: ClassDecl): ClassDecl[] {
  return [cls, ...innerClasses(cls).flatMap(allClasses)];
}

/** `a.b.c` for a chain of names and members, or null. */
export function chainText(expr: Expr): string | null {
  if (expr.k === 'name') return expr.name;
  if (expr.k === 'member') {
    const left = chainText(expr.obj);
    return left === null ? null : `${left}.${expr.name}`;
  }
  return null;
}

/** For a call: the receiver expression (null for a bare call) and the called name. */
export function callTarget(call: Extract<Expr, { k: 'call' }>): { recv: Expr | null; name: string } | null {
  if (call.callee.k === 'name') return { recv: null, name: call.callee.name };
  if (call.callee.k === 'member') return { recv: call.callee.obj, name: call.callee.name };
  return null;
}

/** True for a numeric literal, with an optional leading `-` or `+`. */
export function isNumberLiteral(expr: Expr): boolean {
  if (expr.k === 'num') return true;
  return expr.k === 'unary' && (expr.op === '-' || expr.op === '+') && expr.expr.k === 'num';
}
