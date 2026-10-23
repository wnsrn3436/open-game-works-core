import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isClientContentGd } from './lib/files.ts';
import type { ClassDecl, Expr, FuncDecl, GdFile, MatchBranch, Stmt } from './lib/gd-ast.ts';
import { callsOf, classIndex, resolverFor } from './lib/gd-shared.ts';
import type { ClassIndex, GdType, TypeResolver } from './lib/gd-types.ts';
import { chainText, visitClass, type Scope } from './lib/gd-walk.ts';

/**
 * data mutation: content code assigns to a field of a `GameData` `<Table>Row` or `<Table><Column>Item` value or of a
 * `CoreContract.ItemAmount` inside it, to an element of such a value's list field or of a list returned by a
 * `GameData` container `all_rows()`, `get_rows()` or `DataCore.get_rows`, or calls a list-changing method on those lists,
 * or replaces the container with `GameData.clear()` or `GameData.load_tables()`. A variable at a use has every kind
 * that its assignments on the paths reaching the use give it (branches, `match`, loop passes, `break`, `continue`,
 * `return`). A method starts from the class variables after the class body, each joined with the kinds of every
 * assignment to it in any method or lambda of the class (call order is unknown); a lambda starts from the variables
 * where it is made, its class variables joined the same way unless a local of the code around it has the name.
 */
export const NAME = 'data mutation';

const MUTATORS = new Set([
  'append', 'append_array', 'assign', 'clear', 'erase', 'fill', 'insert', 'pop_at', 'pop_back', 'pop_front', 'push_back',
  'push_front', 'remove_at', 'resize', 'reverse', 'set', 'shuffle', 'sort', 'sort_custom',
]);

/** What a value may be with respect to data: a data row (or item), a data list, or a field of a data row. Empty: none. */
type DataKind = 'row' | 'list' | 'field';
type Kinds = ReadonlySet<DataKind>;
const NONE: Kinds = new Set();

/** Kinds each variable may have at a point; a missing name has no kind from assignments. */
type Env = Map<string, Kinds>;

function emptyEnv(): Env {
  return new Map<string, Kinds>();
}

const LIST_SOURCES = /^(GameData\.[A-Za-z0-9_]+\.(all_rows|get_rows)|DataCore\.get_rows)$/;
const ROW_SOURCES = /^(GameData\.[A-Za-z0-9_]+\.(get_row|empty_row)|DataCore\.get_row)$/;

function isDataRowType(name: string): boolean {
  return /^GameData\.[A-Za-z0-9_]+(Row|Item)$/.test(name);
}

/** Calls that replace the `GameData` container itself. */
const CONTAINER_REPLACERS = new Set(['GameData.clear', 'GameData.load_tables']);
const COLLECTION_TYPES = /^(Array|Dictionary|Packed[A-Za-z0-9]+Array)$/;

function one(kind: DataKind): Kinds {
  return new Set([kind]);
}

/** Kinds of an element of a value with the kinds `inner` (empty unless a list) whose element type is `t`. */
function elementKinds(inner: Kinds, t: GdType | null): Kinds {
  const out = new Set<DataKind>();
  if (inner.has('list')) out.add('row');
  // An element of a collection-valued field (`array<array<T>>`) is a collection of the row, not a row.
  if (inner.has('field')) out.add(t !== null && COLLECTION_TYPES.test(t.name) ? 'field' : 'row');
  return out;
}

/** Kinds where paths join: for each variable, the union over the paths that reach the join. Null: no path does. */
function merge(envs: readonly (Env | null)[]): Env | null {
  const live = envs.filter((e): e is Env => e !== null);
  if (live.length === 0) return null;
  const out: Env = emptyEnv();
  for (const env of live) {
    for (const [name, kinds] of env) out.set(name, new Set([...(out.get(name) ?? NONE), ...kinds]));
  }
  return out;
}

function sameEnv(a: Env, b: Env): boolean {
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(name) ?? NONE;
    const y = b.get(name) ?? NONE;
    if (x.size !== y.size || [...x].some((k) => !y.has(k))) return false;
  }
  return true;
}

/** True when a `match` branch matches every value: a bare `_` without a guard. */
function matchesAll(b: MatchBranch): boolean {
  return b.guard === null && b.patterns.length === 1 && b.patterns[0]?.text === '_';
}

/** Kinds that `break` and `continue` of the innermost loop carry. */
interface LoopExits {
  breaks: Env[];
  continues: Env[];
}

/** Kinds after a statement that does not bind or branch: null after `return`, `break` and `continue`. */
function jump(s: Stmt, env: Env, loop: LoopExits | null): Env | null {
  if (s.k === 'return') return null;
  if (s.k !== 'simple' || (s.word !== 'break' && s.word !== 'continue')) return env;
  (s.word === 'break' ? loop?.breaks : loop?.continues)?.push(env);
  return null;
}

/** A loop statement: its body, and the variable it binds to each element (for `for`). */
interface LoopShape {
  stmt: Stmt;
  body: readonly Stmt[];
  bind: { name: string; kinds: Kinds } | null;
}

class FunctionData {
  private readonly resolver: TypeResolver;
  /** Kinds before each statement of the function, merged over every path and loop pass that reaches it. */
  private readonly before = new Map<Stmt, Env>();
  /** Kinds at the end of the body (for a class: before any method runs). */
  exit: Env = emptyEnv();

  constructor(resolver: TypeResolver) {
    this.resolver = resolver;
  }

  /** Follows the paths of `body` from `entry`. */
  async analyze(body: readonly Stmt[], entry: Env): Promise<void> {
    this.exit = (await this.walk(body, entry, null)) ?? emptyEnv();
  }

  /** Kinds before the innermost statement of this function that holds token `at`. */
  envAt(at: number): Env {
    let best: Stmt | null = null;
    for (const s of this.before.keys()) {
      if (s.t0 <= at && at <= s.t1 && (best === null || s.t1 - s.t0 < best.t1 - best.t0)) best = s;
    }
    return (best && this.before.get(best)) ?? emptyEnv();
  }

  private record(s: Stmt, env: Env): void {
    const prev = this.before.get(s);
    this.before.set(s, prev ? (merge([prev, env]) ?? env) : new Map(env));
  }

  /** Kinds after `stmts`, or null when no path reaches the end. Statements no path reaches are walked with no kinds. */
  private async walk(stmts: readonly Stmt[], entry: Env, loop: LoopExits | null): Promise<Env | null> {
    let env: Env | null = entry;
    for (const s of stmts) {
      const after = await this.step(s, env ?? emptyEnv(), loop);
      if (env !== null) env = after;
    }
    return env;
  }

  private async step(s: Stmt, env: Env, loop: LoopExits | null): Promise<Env | null> {
    if (s.k === 'func' || s.k === 'class') return env;
    if (s.k === 'while') return this.loop({ stmt: s, body: s.body, bind: null }, env);
    this.record(s, env);
    switch (s.k) {
      case 'var':
        return new Map(env).set(s.name, s.value ? await this.kinds(s.value, env) : NONE);
      case 'assign':
        return s.op === '=' && s.target.k === 'name' ? new Map(env).set(s.target.name, await this.kinds(s.value, env)) : env;
      case 'if':
        return this.branches([...s.branches.map((b) => b.body), s.elseBody], env, loop, false);
      case 'match':
        return this.branches(s.branches.map((b) => b.body), env, loop, !s.branches.some(matchesAll));
      case 'for': {
        const element = elementKinds(await this.kinds(s.iter, env), await this.resolver.elementType(s.iter));
        return this.loop({ stmt: s, body: s.body, bind: { name: s.name, kinds: element } }, env);
      }
      default:
        return jump(s, env, loop);
    }
  }

  /** Kinds after one of `bodies` runs from `env`; `skippable`: a path may also run none of them. */
  private async branches(bodies: readonly (readonly Stmt[])[], env: Env, loop: LoopExits | null, skippable: boolean): Promise<Env | null> {
    const outs: (Env | null)[] = skippable ? [env] : [];
    for (const body of bodies) outs.push(await this.walk(body, new Map(env), loop));
    return merge(outs);
  }

  /** Walks a loop body until the kinds at the loop head stop growing; the body may run zero or more times. */
  private async loop(shape: LoopShape, entry: Env): Promise<Env | null> {
    const { stmt, body, bind } = shape;
    // The element variable is local to the loop: outside it, the name keeps the kinds it had before the loop.
    const outside = (e: Env): Env => (bind ? new Map(e).set(bind.name, entry.get(bind.name) ?? NONE) : e);
    let head: Env = new Map(entry);
    const breaks: Env[] = [];
    for (;;) {
      // A `while` condition runs at the head of every pass; a `for` iterable runs once, before the loop.
      if (stmt.k === 'while') this.record(stmt, head);
      const exits: LoopExits = { breaks: [], continues: [] };
      const pass = bind ? new Map(head).set(bind.name, bind.kinds) : new Map(head);
      const end = await this.walk(body, pass, exits);
      breaks.push(...exits.breaks);
      const next = merge([head, end, ...exits.continues].map((e) => (e === null ? null : outside(e)))) ?? head;
      if (sameEnv(next, head)) break;
      head = next;
    }
    return merge([head, ...breaks.map(outside)]);
  }

  async kinds(e: Expr, env: Env): Promise<Kinds> {
    switch (e.k) {
      case 'call':
        return this.callKind(e);
      case 'cast':
        return isDataRowType((await this.resolver.canonical({ name: e.type.name, args: [] })).name) ? one('row') : this.kinds(e.expr, env);
      case 'name': {
        const known = env.get(e.name) ?? NONE;
        return known.size > 0 ? known : this.byType(e);
      }
      case 'member':
        return (await this.kinds(e.obj, env)).has('row') ? one('field') : this.byType(e);
      case 'index': {
        const inner = await this.kinds(e.obj, env);
        return inner.has('list') || inner.has('field') ? elementKinds(inner, await this.resolver.typeOf(e)) : this.byType(e);
      }
      default:
        return NONE;
    }
  }

  private async callKind(e: Extract<Expr, { k: 'call' }>): Promise<Kinds> {
    const chain = chainText(e.callee) ?? '';
    if (LIST_SOURCES.test(chain)) return one('list');
    if (ROW_SOURCES.test(chain)) return one('row');
    if (e.callee.k === 'member' && e.callee.name === 'duplicate') return NONE;
    return this.byType(e);
  }

  private async byType(e: Expr): Promise<Kinds> {
    const t = await this.resolver.typeOf(e);
    return t && isDataRowType(t.name) ? one('row') : NONE;
  }

  /** Why an assignment target changes data, or null. */
  async assignTarget(target: Expr): Promise<string | null> {
    if (target.k !== 'member' && target.k !== 'index') return null;
    if ((await this.kinds(target.obj, this.envAt(target.t0))).size === 0) return null;
    return target.k === 'member' ? `assignment to \`.${target.name}\` of game data` : 'assignment to an element of game data';
  }

  /** Why a call changes data, or null. */
  async mutatingCall(call: Extract<Expr, { k: 'call' }>): Promise<string | null> {
    if (call.callee.k !== 'member' || !MUTATORS.has(call.callee.name)) return null;
    const k = await this.kinds(call.callee.obj, this.envAt(call.t0));
    if (k.has('list') || k.has('field') || (k.has('row') && call.callee.name === 'set')) return `\`${call.callee.name}()\` on game data`;
    return null;
  }
}

interface Item {
  kind: 'assign' | 'call';
  node: Expr;
  line: number;
  scope: Scope;
}

/** An assignment in a method or lambda to a class variable of its class (`name = v` or `self.name = v`). */
interface ClassVarAssign {
  scope: Scope;
  name: string;
  value: Expr;
  at: number;
}

/** Kinds each class may give its class variables at a method entry, beyond those after the class body. */
type ClassVarKinds = Map<ClassDecl, Env>;

function sameClassVarKinds(a: ClassVarKinds, b: ClassVarKinds): boolean {
  if (a.size !== b.size) return false;
  for (const [cls, env] of a) {
    const other = b.get(cls);
    if (!other || !sameEnv(env, other)) return false;
  }
  return true;
}

function classVarNames(cls: ClassDecl): Set<string> {
  return new Set(cls.body.flatMap((s) => (s.k === 'var' ? [s.name] : [])));
}

export async function checkFile(file: GdFile, index: ClassIndex): Promise<Finding[]> {
  const items: Item[] = [];
  /** Where each lambda is made: it starts from the kinds of the enclosing code there. */
  const lambdas = new Map<FuncDecl, { scope: Scope; at: number }>();
  const cache = new Map<unknown, TypeResolver>();
  const varNames = new Map<ClassDecl, Set<string>>();
  const classVars = (cls: ClassDecl): Set<string> => {
    let names = varNames.get(cls);
    if (!names) {
      names = classVarNames(cls);
      varNames.set(cls, names);
    }
    return names;
  };
  const assigns: ClassVarAssign[] = [];
  visitClass(file.top, {
    stmt(s, scope) {
      if (s.k !== 'assign') return;
      items.push({ kind: 'assign', node: s.target, line: s.line, scope });
      if (scope.fn === null || s.op !== '=') return;
      const t = s.target;
      const name = t.k === 'name' ? t.name : t.k === 'member' && t.obj.k === 'name' && t.obj.name === 'self' ? t.name : null;
      if (name === null || !classVars(scope.cls).has(name)) return;
      if (t.k === 'name' && resolverFor(index, file, scope, cache).isLocal(name)) return;
      assigns.push({ scope, name, value: s.value, at: s.t0 });
    },
    expr(e, scope) {
      if (e.k === 'call') items.push({ kind: 'call', node: e, line: e.line, scope });
      if (e.k === 'lambda') lambdas.set(e.fn, { scope, at: e.t0 });
    },
  });
  /** Analyses every function with class variables joined with `extra` at the entries. */
  const analyzer = (extra: ClassVarKinds): ((scope: Scope) => Promise<FunctionData>) => {
    const data = new Map<unknown, Promise<FunctionData>>();
    const analyze = async (scope: Scope): Promise<FunctionData> => {
      const fd = new FunctionData(resolverFor(index, file, scope, cache));
      if (scope.fn === null) {
        await fd.analyze(scope.cls.body, emptyEnv());
        return fd;
      }
      const made = lambdas.get(scope.fn);
      const outer = await dataFor(made ? made.scope : { cls: scope.cls, fn: null, method: null });
      let joined = [...(extra.get(scope.cls) ?? emptyEnv())];
      // In a lambda, a local of the code around it hides the class variable of the same name.
      if (made && made.scope.fn !== null) {
        const around = resolverFor(index, file, made.scope, cache);
        joined = joined.filter(([name]) => !around.isLocal(name));
      }
      const entry = merge([made ? outer.envAt(made.at) : outer.exit, new Map(joined)]) ?? emptyEnv();
      for (const p of scope.fn.params) entry.delete(p.name);
      await fd.analyze(scope.fn.body, entry);
      return fd;
    };
    const dataFor = (scope: Scope): Promise<FunctionData> => {
      const key = scope.fn ?? scope.cls;
      let fd = data.get(key);
      if (!fd) {
        fd = analyze(scope);
        data.set(key, fd);
      }
      return fd;
    };
    return dataFor;
  };
  // Each pass keeps the kinds of the pass before, so the class variable kinds only grow and reach a fixed point.
  let extra: ClassVarKinds = new Map();
  let dataFor = analyzer(extra);
  for (;;) {
    const next: ClassVarKinds = new Map([...extra].map(([cls, env]) => [cls, new Map(env)]));
    for (const a of assigns) {
      const fd = await dataFor(a.scope);
      const kinds = await fd.kinds(a.value, fd.envAt(a.at));
      if (kinds.size === 0) continue;
      const env = next.get(a.scope.cls) ?? emptyEnv();
      env.set(a.name, new Set([...(env.get(a.name) ?? NONE), ...kinds]));
      next.set(a.scope.cls, env);
    }
    if (sameClassVarKinds(next, extra)) break;
    extra = next;
    dataFor = analyzer(extra);
  }
  const out: Finding[] = [];
  for (const item of items) {
    const fd = await dataFor(item.scope);
    const why = item.kind === 'assign' ? await fd.assignTarget(item.node) : item.node.k === 'call' ? await fd.mutatingCall(item.node) : null;
    if (why) out.push(finding(NAME, at(file.path, item.line), why));
  }
  return out;
}

/** Content calls that replace the `GameData` container (the core static check reports these for core code itself). */
export function containerFindings(file: GdFile): Finding[] {
  return callsOf(file).flatMap(({ call }) => {
    const chain = chainText(call.callee);
    return chain !== null && CONTAINER_REPLACERS.has(chain) ? [finding(NAME, at(file.path, call.line), `\`${chain}()\` replaces the data container`)] : [];
  });
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const index = await classIndex(sc);
  const results = sc.filter(isClientContentGd).map(async (p) => {
    const file = await sc.gd(p);
    return [...(await checkFile(file, index)), ...containerFindings(file)];
  });
  return (await Promise.all(results)).flat();
}
