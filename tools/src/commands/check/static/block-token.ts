import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isClientContentGd } from './lib/files.ts';
import type { Expr, FuncDecl, GdFile, Stmt } from './lib/gd-ast.ts';
import { chainText, childBodies, exprChildren, stmtExprs, visitClass } from './lib/gd-walk.ts';

/**
 * block token: content code keeps an `InputBlockCore.block` token outside a local variable, passes it to a function
 * other than `unblock` and `is_active`, holds it across a wait (`await`, a lambda that is connected, deferred or uses
 * the token) on a path, or has a path that ends without `unblock` in the function that blocked (`input-block-core`
 * `### acquire and release`).
 */
export const NAME = 'block token';

const TOKEN_USES = new Set(['InputBlockCore.unblock', 'InputBlockCore.is_active']);

/** Expressions of a function body in order, without entering lambdas. */
function ownExprs(stmts: readonly Stmt[], out: Expr[] = []): Expr[] {
  const add = (e: Expr): void => {
    out.push(e);
    if (e.k !== 'lambda') for (const c of exprChildren(e)) add(c);
  };
  for (const s of stmts) {
    if (s.k === 'func' || s.k === 'class') continue;
    for (const e of stmtExprs(s)) add(e);
    for (const body of childBodies(s)) ownExprs(body, out);
  }
  return out;
}

function ownStmts(stmts: readonly Stmt[], out: Stmt[] = []): Stmt[] {
  for (const s of stmts) {
    out.push(s);
    for (const body of childBodies(s)) ownStmts(body, out);
  }
  return out;
}

function isBlockCall(e: Expr): e is Extract<Expr, { k: 'call' }> {
  return e.k === 'call' && chainText(e.callee) === 'InputBlockCore.block';
}

function namesIn(e: Expr, name: string, out: Expr[] = []): Expr[] {
  if (e.k === 'name' && e.name === name) out.push(e);
  if (e.k === 'lambda') {
    for (const inner of ownExprs(e.fn.body)) namesIn(inner, name, out);
    return out;
  }
  for (const c of exprChildren(e)) namesIn(c, name, out);
  return out;
}

interface Holder {
  name: string;
  call: Expr;
}

/** Block calls that land in a local variable, and the findings for the others. */
function holders(fn: FuncDecl, path: string, out: Finding[]): Holder[] {
  const kept: Holder[] = [];
  const keptCalls = new Set<Expr>();
  const locals = new Set([...fn.params.map((p) => p.name), ...ownStmts(fn.body).flatMap((s) => (s.k === 'var' ? [s.name] : []))]);
  for (const s of ownStmts(fn.body)) {
    if (s.k === 'var' && s.value && isBlockCall(s.value)) {
      kept.push({ name: s.name, call: s.value });
      keptCalls.add(s.value);
    }
    if (s.k === 'assign' && s.op === '=' && s.target.k === 'name' && locals.has(s.target.name) && isBlockCall(s.value)) {
      kept.push({ name: s.target.name, call: s.value });
      keptCalls.add(s.value);
    }
  }
  for (const e of ownExprs(fn.body)) {
    if (isBlockCall(e) && !keptCalls.has(e)) out.push(finding(NAME, at(path, e.line), 'block token is not kept in a local variable'));
  }
  return kept;
}

function isTokenCall(e: Expr, name: string, chains: ReadonlySet<string>): e is Extract<Expr, { k: 'call' }> {
  if (e.k !== 'call') return false;
  const arg = e.args[0];
  return chains.has(chainText(e.callee) ?? '') && e.args.length === 1 && arg?.k === 'name' && arg.name === name;
}

const UNBLOCK = new Set(['InputBlockCore.unblock']);

/** Arguments of `unblock(token)` and `is_active(token)`. */
function allowedUses(exprs: readonly Expr[], name: string): Set<Expr> {
  const allowed = new Set<Expr>();
  for (const e of exprs) if (isTokenCall(e, name, TOKEN_USES)) allowed.add(e.args[0] as Expr);
  return allowed;
}

/** Methods that run a lambda later: connecting it to a signal, or deferring it. */
const LATER = new Set(['connect', 'call_deferred']);

/** Lambdas that are a wait: connected to a signal, deferred, or capturing the token. */
function waitLambdas(exprs: readonly Expr[], name: string): Set<Expr> {
  const out = new Set<Expr>();
  for (const e of exprs) {
    if (e.k === 'lambda' && namesIn(e, name).length > 0) out.add(e);
    if (e.k !== 'call' || e.callee.k !== 'member' || !LATER.has(e.callee.name)) continue;
    for (const arg of [e.callee.obj, ...e.args]) if (arg.k === 'lambda') out.add(arg);
  }
  return out;
}

/** Expressions in evaluation order with their sub-expressions, without lambda bodies. */
function flatExprs(list: readonly Expr[]): Expr[] {
  const out: Expr[] = [];
  const add = (e: Expr): void => {
    out.push(e);
    if (e.k !== 'lambda') for (const c of exprChildren(e)) add(c);
  };
  for (const e of list) add(e);
  return out;
}

/** Union of the token states of paths that meet; null is no path. */
function merge(a: boolean | null, b: boolean | null): boolean | null {
  if (a === null) return b;
  if (b === null) return a;
  return a || b;
}

/**
 * Follows every path of a function with whether the token may be held: a wait (`await`, a wait lambda) while it may
 * be held, and a path that returns or ends while it may be held, are findings.
 */
class TokenFlow {
  readonly findings: Finding[] = [];
  private readonly holder: Holder;
  private readonly path: string;
  private readonly waits: Set<Expr>;
  /** Token states at `break` and `continue` of the loops being followed, innermost last. */
  private readonly loops: (boolean | null)[] = [];

  constructor(holder: Holder, path: string, waits: Set<Expr>) {
    this.holder = holder;
    this.path = path;
    this.waits = waits;
  }

  run(fn: FuncDecl): void {
    if (this.exec(fn.body, false) === true) this.leak();
  }

  private report(line: number, what: string): void {
    this.findings.push(finding(NAME, at(this.path, line), `block token \`${this.holder.name}\` is held across ${what}`));
  }

  private leak(): void {
    this.findings.push(finding(NAME, at(this.path, this.holder.call.line), `block token \`${this.holder.name}\` is not released with \`InputBlockCore.unblock\` in the same function`));
  }

  private evaluate(exprs: readonly Expr[], held: boolean): boolean {
    let state = held;
    for (const e of exprs) {
      if (isTokenCall(e, this.holder.name, UNBLOCK)) state = false;
      if (state && e.k === 'await') this.report(e.line, '`await`');
      if (state && e.k === 'lambda' && this.waits.has(e)) this.report(e.line, 'a lambda');
    }
    return exprs.includes(this.holder.call) ? true : state;
  }

  private exec(stmts: readonly Stmt[], held: boolean | null): boolean | null {
    let state = held;
    for (const s of stmts) {
      if (state === null) return null;
      state = this.stmt(s, state);
    }
    return state;
  }

  private loop(s: Extract<Stmt, { k: 'for' | 'while' }>, held: boolean): boolean | null {
    const start = this.evaluate(flatExprs(stmtExprs(s)), held);
    this.loops.push(null);
    const once = this.exec(s.body, start);
    // A second pass carries the state of the end of one iteration into the next.
    const again = this.exec(s.body, merge(start, once));
    const exits = this.loops.pop() ?? null;
    return merge(merge(start, once), merge(again, exits));
  }

  private stmt(s: Stmt, held: boolean): boolean | null {
    switch (s.k) {
      case 'if': {
        let state = held;
        let out: boolean | null = null;
        for (const b of s.branches) {
          state = this.evaluate(flatExprs([b.cond]), state);
          out = merge(out, this.exec(b.body, state));
        }
        return merge(out, this.exec(s.elseBody, state));
      }
      case 'for':
      case 'while':
        return this.loop(s, held);
      case 'match': {
        const state = this.evaluate(flatExprs(stmtExprs(s)), held);
        return s.branches.reduce<boolean | null>((out, b) => merge(out, this.exec(b.body, state)), state);
      }
      case 'return':
        if (this.evaluate(flatExprs(stmtExprs(s)), held)) this.leak();
        return null;
      case 'simple':
        if (s.word !== 'break' && s.word !== 'continue') return held;
        if (this.loops.length > 0) this.loops.push(merge(this.loops.pop() ?? null, held));
        return null;
      default:
        return this.evaluate(flatExprs(stmtExprs(s)), held);
    }
  }
}

function holderFindings(holder: Holder, fn: FuncDecl, exprs: readonly Expr[], path: string): Finding[] {
  const out: Finding[] = [];
  const allowed = allowedUses(exprs, holder.name);
  for (const e of exprs) {
    for (const use of namesIn(e, holder.name)) {
      if (!allowed.has(use) && use.t0 > holder.call.t0) out.push(finding(NAME, at(path, use.line), `block token \`${holder.name}\` is used outside \`unblock\` and \`is_active\``));
    }
  }
  const flow = new TokenFlow(holder, path, waitLambdas(exprs, holder.name));
  flow.run(fn);
  return [...out, ...flow.findings];
}

function checkFunc(fn: FuncDecl, path: string): Finding[] {
  const out: Finding[] = [];
  const exprs = ownExprs(fn.body);
  for (const holder of holders(fn, path, out)) out.push(...holderFindings(holder, fn, exprs, path));
  return dedupe(out);
}

function dedupe(list: Finding[]): Finding[] {
  const seen = new Set<string>();
  return list.filter((f) => {
    const key = `${f.where}|${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function checkFile(file: GdFile): Finding[] {
  const funcs: FuncDecl[] = [];
  visitClass(file.top, {
    stmt(s) {
      if (s.k === 'func') funcs.push(s);
      if (s.k === 'var') funcs.push(...s.accessors);
    },
    expr(e) {
      if (e.k === 'lambda') funcs.push(e.fn);
    },
  });
  const out = funcs.flatMap((fn) => checkFunc(fn, file.path));
  const inFuncs = new Set<Expr>(funcs.flatMap((fn) => ownExprs(fn.body)));
  visitClass(file.top, {
    expr(e) {
      if (isBlockCall(e) && !inFuncs.has(e)) out.push(finding(NAME, at(file.path, e.line), 'block token is not kept in a local variable'));
    },
  });
  return dedupe(out);
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  return (await Promise.all(sc.filter(isClientContentGd).map(async (p) => checkFile(await sc.gd(p))))).flat();
}
