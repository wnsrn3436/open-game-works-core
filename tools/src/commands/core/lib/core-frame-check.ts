/**
 * `godot` `## frame code` rules that the static check covers (`## test`): core frame code does no node finding
 * (`get_node()`, `$`, `%`, `find_child()`) and no `await`. Frame code is `_process()`, `_physics_process()`,
 * `_input()`, `_unhandled_input()`, `_gui_input()`, `_integrate_forces()`, the methods connected to
 * `SceneTree.process_frame` and `SceneTree.physics_frame`, and the core functions these call (followed through
 * calls whose target the type resolver finds in core code). A connected `Callable` is a lambda, a method, a
 * `<callable>.bind(...)`, or a field that holds one: every value the field's class assigns to the field.
 */
import { at, finding, type Finding } from '../../check/static/lib/context.ts';
import type { ClassDecl, Expr, FuncDecl, GdFile, VarDecl } from '../../check/static/lib/gd-ast.ts';
import { callsOf, resolverFor } from '../../check/static/lib/gd-shared.ts';
import type { ClassIndex, ClassRef, TypeResolver } from '../../check/static/lib/gd-types.ts';
import { allClasses, callTarget, classFuncs, visitClass, visitFuncBody, type Scope } from '../../check/static/lib/gd-walk.ts';
import { isCoreGd } from './core-static-context.ts';

export const NAME = 'frame code';

const FRAME_FUNCTIONS = new Set(['_process', '_physics_process', '_input', '_unhandled_input', '_gui_input', '_integrate_forces']);
const FRAME_SIGNALS = new Set(['process_frame', 'physics_frame']);
const NODE_FINDING = new Set(['get_node', 'find_child']);

type Call = Extract<Expr, { k: 'call' }>;

interface Work {
  file: GdFile;
  cls: ClassDecl;
  fn: FuncDecl;
  /** The frame code entry the function is reached from. */
  root: string;
}

function problem(e: Expr): string | null {
  if (e.k === 'nodepath') return `\`${e.sigil}\` node path`;
  if (e.k === 'await') return '`await`';
  if (e.k !== 'call') return null;
  const name = callTarget(e)?.name ?? '';
  return NODE_FINDING.has(name) ? `\`${name}()\`` : null;
}

class Resolvers {
  private readonly index: ClassIndex;
  private readonly caches = new Map<GdFile, Map<unknown, TypeResolver>>();

  constructor(index: ClassIndex) {
    this.index = index;
  }

  of(file: GdFile, scope: Scope): TypeResolver {
    let cache = this.caches.get(file);
    if (!cache) {
      cache = new Map();
      this.caches.set(file, cache);
    }
    return resolverFor(this.index, file, scope, cache);
  }
}

function isSelf(e: Expr): boolean {
  return e.k === 'name' && e.name === 'self';
}

/** A core function `name` of a class (or its ancestors), as work reached from `root`. */
async function coreFunc(resolver: TypeResolver, ref: ClassRef | null, name: string, root: string): Promise<Work | null> {
  if (!ref) return null;
  const member = await resolver.index.member(ref, name);
  if (member?.decl.k !== 'func' || !isCoreGd(member.owner.file.path)) return null;
  return { file: member.owner.file, cls: member.owner.cls, fn: member.decl, root };
}

/** The class an expression names or holds an object of. */
async function classOfExpr(resolver: TypeResolver, e: Expr): Promise<ClassRef | null> {
  return isSelf(e) ? resolver.self : resolver.classOf(await resolver.typeOf(e));
}

async function calleeOf(call: Call, resolver: TypeResolver, root: string): Promise<Work | null> {
  const target = callTarget(call);
  if (!target) return null;
  const ref = target.recv === null ? resolver.self : await classOfExpr(resolver, target.recv);
  return coreFunc(resolver, ref, target.name, root);
}

/** True for an assignment target that is field `name` of the class: `name` or `self.name`. */
function isField(target: Expr, name: string): boolean {
  if (target.k === 'name') return target.name === name;
  return target.k === 'member' && target.name === name && isSelf(target.obj);
}

/** Every value assigned to field `field` in its own class (its initializer and `=` assignments), with its scope. */
function fieldValues(file: GdFile, cls: ClassDecl, field: VarDecl): { value: Expr; scope: Scope }[] {
  const out: { value: Expr; scope: Scope }[] = [];
  if (field.value) out.push({ value: field.value, scope: { cls, fn: null, method: null } });
  visitClass(cls, {
    stmt(stmt, scope) {
      if (stmt.k === 'assign' && stmt.op === '=' && scope.cls === cls && scope.fn !== null && isField(stmt.target, field.name)) out.push({ value: stmt.value, scope });
    },
  });
  return out;
}

/** The core functions a `Callable` expression names, as work reached from `root`. */
async function callableWorks(file: GdFile, e: Expr, scope: Scope, resolvers: Resolvers, root: string, seen: Set<VarDecl>): Promise<Work[]> {
  if (e.k === 'lambda') return [{ file, cls: scope.cls, fn: e.fn, root }];
  if (e.k === 'call' && e.callee.k === 'member' && e.callee.name === 'bind') return callableWorks(file, e.callee.obj, scope, resolvers, root, seen);
  if (e.k !== 'name' && e.k !== 'member') return [];
  const resolver = resolvers.of(file, scope);
  const ref = e.k === 'name' ? resolver.self : await classOfExpr(resolver, e.obj);
  if (!ref) return [];
  const member = await resolver.index.member(ref, e.name);
  if (!member || !isCoreGd(member.owner.file.path)) return [];
  if (member.decl.k === 'func') return [{ file: member.owner.file, cls: member.owner.cls, fn: member.decl, root }];
  if (member.decl.k !== 'var' || seen.has(member.decl)) return [];
  seen.add(member.decl);
  const out: Work[] = [];
  for (const assigned of fieldValues(member.owner.file, member.owner.cls, member.decl)) {
    out.push(...(await callableWorks(member.owner.file, assigned.value, assigned.scope, resolvers, root, seen)));
  }
  return out;
}

/** The functions connected by `<tree>.process_frame.connect(<callable>)` or `physics_frame`. */
async function connectedWorks(file: GdFile, call: Call, scope: Scope, resolvers: Resolvers): Promise<Work[]> {
  const callee = call.callee;
  if (callee.k !== 'member' || callee.name !== 'connect' || callee.obj.k !== 'member' || !FRAME_SIGNALS.has(callee.obj.name)) return [];
  const arg = call.args[0];
  return arg ? callableWorks(file, arg, scope, resolvers, `SceneTree.${callee.obj.name}`, new Set()) : [];
}

async function roots(files: readonly GdFile[], resolvers: Resolvers): Promise<Work[]> {
  const out: Work[] = [];
  for (const file of files) {
    for (const cls of allClasses(file.top)) {
      for (const fn of classFuncs(cls)) if (FRAME_FUNCTIONS.has(fn.name)) out.push({ file, cls, fn, root: fn.name });
    }
    for (const { call, scope } of callsOf(file)) out.push(...(await connectedWorks(file, call, scope, resolvers)));
  }
  return out;
}

function where(work: Work): string {
  const name = work.fn.name === '' ? 'a lambda' : `\`${work.fn.name}\``;
  return work.fn.name === work.root ? `in ${name}` : `in ${name}, frame code from \`${work.root}\``;
}

/** Frame code findings of the core files (`files` are core `.gd` files). */
export async function frameFindings(files: readonly GdFile[], index: ClassIndex): Promise<Finding[]> {
  const resolvers = new Resolvers(index);
  const queue = await roots(files, resolvers);
  const seen = new Set<FuncDecl>();
  const out: Finding[] = [];
  while (queue.length > 0) {
    const work = queue.shift() as Work;
    if (seen.has(work.fn)) continue;
    seen.add(work.fn);
    const calls: { call: Call; scope: Scope }[] = [];
    visitFuncBody(work.fn, work.cls, {
      expr(e, scope) {
        const what = problem(e);
        if (what) out.push(finding(NAME, at(work.file.path, e.line), `${what} ${where(work)}`));
        if (e.k === 'call') calls.push({ call: e, scope });
      },
    });
    for (const { call, scope } of calls) {
      const next = await calleeOf(call, resolvers.of(work.file, scope), work.root);
      if (next && !seen.has(next.fn)) queue.push(next);
    }
  }
  return out;
}
