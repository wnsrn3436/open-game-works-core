import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isClientContentGd } from './lib/files.ts';
import type { Expr, GdFile } from './lib/gd-ast.ts';
import { callsOf, classIndex, resolverFor } from './lib/gd-shared.ts';
import type { ClassIndex, TypeResolver } from './lib/gd-types.ts';
import type { Scope } from './lib/gd-walk.ts';

/**
 * engine random: content code calls an engine random function of the `UtilCore` row of `client-core` Godot
 * `## engine behavior`: `randf()`, `randf_range()`, `randfn()`, `randi()`, `randi_range()`, `randomize()`,
 * `rand_from_seed()`, `seed()`, `RandomNumberGenerator`, `Array.shuffle()`, `Array.pick_random()`. In content code
 * `shuffle()` and `pick_random()` count on an Array receiver or one whose type is not known.
 */
export const NAME = 'engine random';

const GLOBAL_FUNCTIONS = new Set(['randf', 'randf_range', 'randfn', 'randi', 'randi_range', 'randomize', 'rand_from_seed', 'seed']);
const ARRAY_METHODS = new Set(['shuffle', 'pick_random']);
const ARRAY_TYPES = /^(Array|Packed[A-Za-z0-9]+Array)$/;

interface Problem {
  line: number;
  message: string;
  /** Receiver of an `Array.shuffle()` or `Array.pick_random()` call, with the scope of the call. */
  recv: { expr: Expr; scope: Scope } | null;
}

function problems(file: GdFile): Problem[] {
  const out: Problem[] = [];
  for (const t of file.tokens) {
    if (t.type === 'name' && t.text === 'RandomNumberGenerator') out.push({ line: t.line, message: '`RandomNumberGenerator`', recv: null });
  }
  for (const { call, scope } of callsOf(file)) {
    const callee = call.callee;
    if (callee.k === 'name' && GLOBAL_FUNCTIONS.has(callee.name)) out.push({ line: call.line, message: `\`${callee.name}()\``, recv: null });
    if (callee.k === 'member' && ARRAY_METHODS.has(callee.name)) out.push({ line: call.line, message: `\`Array.${callee.name}()\``, recv: { expr: callee.obj, scope } });
  }
  return out;
}

/** Findings with `shuffle()` and `pick_random()` on any receiver (the core static check). */
export function checkFile(file: GdFile): Finding[] {
  return problems(file).map((p) => finding(NAME, at(file.path, p.line), p.message));
}

/** Findings of content code: `shuffle()` and `pick_random()` only on an Array receiver or one of unknown type. */
export async function checkContentFile(file: GdFile, index: ClassIndex): Promise<Finding[]> {
  const out: Finding[] = [];
  const cache = new Map<unknown, TypeResolver>();
  for (const p of problems(file)) {
    if (p.recv !== null) {
      const t = await resolverFor(index, file, p.recv.scope, cache).typeOf(p.recv.expr);
      if (t !== null && !ARRAY_TYPES.test(t.name)) continue;
    }
    out.push(finding(NAME, at(file.path, p.line), p.message));
  }
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const index = await classIndex(sc);
  return (await Promise.all(sc.filter(isClientContentGd).map(async (p) => checkContentFile(await sc.gd(p), index)))).flat();
}
