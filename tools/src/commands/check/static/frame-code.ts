import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isClientContentGd } from './lib/files.ts';
import type { ClassDecl, Expr, FuncDecl, GdFile } from './lib/gd-ast.ts';
import { allClasses, callTarget, classFuncs, visitFuncBody } from './lib/gd-walk.ts';

/**
 * frame code: the body of `_process()`, `_physics_process()`, `_input()`, `_unhandled_input()`, `_unhandled_key_input()`,
 * `_shortcut_input()`, `_gui_input()` and the bodies of every same-class function they call, following the calls
 * transitively (client-content engines/godot `## GDScript`), use `get_node()`, `$` and `%` node paths, `find_child()`,
 * `PackedScene.instantiate()`, `queue_free()` or `await`.
 */
export const NAME = 'frame code';

export const FRAME_FUNCTIONS = new Set(['_process', '_physics_process', '_input', '_unhandled_input', '_unhandled_key_input', '_shortcut_input', '_gui_input']);
const FORBIDDEN_CALLS = new Set(['get_node', 'find_child', 'queue_free']);

/** Same-class functions a function body calls directly (`f()` or `self.f()`). */
export function sameClassCallees(fn: FuncDecl, cls: ClassDecl): FuncDecl[] {
  const funcs = new Map(classFuncs(cls).map((f) => [f.name, f]));
  const out = new Set<FuncDecl>();
  visitFuncBody(fn, cls, {
    expr(e) {
      if (e.k !== 'call') return;
      const target = callTarget(e);
      if (!target) return;
      const onSelf = target.recv === null || (target.recv.k === 'name' && target.recv.name === 'self');
      const callee = onSelf ? funcs.get(target.name) : undefined;
      if (callee && callee !== fn) out.add(callee);
    },
  });
  return [...out];
}

/** Same-class functions `fn` calls, following the calls transitively (each function once), in the order reached. */
export function reachedCallees(fn: FuncDecl, cls: ClassDecl): FuncDecl[] {
  const visited = new Set<FuncDecl>([fn]);
  const queue = [fn];
  const out: FuncDecl[] = [];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const callee of sameClassCallees(next, cls)) {
      if (visited.has(callee)) continue;
      visited.add(callee);
      out.push(callee);
      queue.push(callee);
    }
  }
  return out;
}

function forbidden(e: Expr): string | null {
  if (e.k === 'nodepath') return `\`${e.sigil}\` node path`;
  if (e.k === 'await') return '`await`';
  if (e.k !== 'call') return null;
  const target = callTarget(e);
  if (!target) return null;
  if (FORBIDDEN_CALLS.has(target.name)) return `\`${target.name}()\``;
  if (target.name === 'instantiate' && target.recv !== null) return '`PackedScene.instantiate()`';
  return null;
}

export function checkFile(file: GdFile): Finding[] {
  const out: Finding[] = [];
  for (const cls of allClasses(file.top)) {
    const frames = classFuncs(cls).filter((f) => FRAME_FUNCTIONS.has(f.name));
    const targets = new Map<FuncDecl, string>();
    for (const frame of frames) {
      targets.set(frame, frame.name);
      for (const callee of reachedCallees(frame, cls)) if (!targets.has(callee)) targets.set(callee, `${callee.name}\` called from \`${frame.name}`);
    }
    for (const [fn, label] of targets) {
      visitFuncBody(fn, cls, {
        expr(e) {
          const what = forbidden(e);
          if (what) out.push(finding(NAME, at(file.path, e.line), `${what} in \`${label}\``));
        },
      });
    }
  }
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  return (await Promise.all(sc.filter(isClientContentGd).map(async (p) => checkFile(await sc.gd(p))))).flat();
}
