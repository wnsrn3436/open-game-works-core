import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isClientContentGd, isClientTest } from './lib/files.ts';
import type { Expr, GdFile } from './lib/gd-ast.ts';
import { callsOf } from './lib/gd-shared.ts';
import { callTarget, visitClass, type Scope } from './lib/gd-walk.ts';

/**
 * test input: a client test calls an input handler, a UI element click function or an engine input signal directly.
 * Godot: the input callbacks (`_input()`, `_unhandled_input()`, `_unhandled_key_input()`, `_shortcut_input()`,
 * `_gui_input()`), the `BaseButton` click virtuals (`_pressed()`, `_toggled()`), and emitting the `BaseButton` and
 * `Control` input signals (`pressed`, `button_down`, `button_up`, `toggled`, `gui_input`), also through a variable
 * that holds the signal.
 */
export const NAME = 'test input';

const HANDLERS = new Set(['_input', '_unhandled_input', '_unhandled_key_input', '_shortcut_input', '_gui_input', '_pressed', '_toggled']);
const INPUT_SIGNALS = new Set(['pressed', 'button_down', 'button_up', 'toggled', 'gui_input']);

/** The input signal a value is (`x.pressed`, `Signal(x, "pressed")`), or null. */
function signalOf(e: Expr): string | null {
  if (e.k === 'member' && INPUT_SIGNALS.has(e.name)) return e.name;
  const second = e.k === 'call' ? e.args[1] : undefined;
  if (e.k === 'call' && e.callee.k === 'name' && e.callee.name === 'Signal' && second?.k === 'str' && INPUT_SIGNALS.has(second.value)) return second.value;
  return null;
}

/** Names a named function declares: its parameters, and the `var`, `for` and lambda parameter names in its body. */
function localNames(locals: Map<unknown, Set<string>>, method: unknown, names: readonly string[]): void {
  const set = locals.get(method) ?? new Set<string>();
  for (const name of names) set.add(name);
  locals.set(method, set);
}

/**
 * Variables that hold an input signal, per named function (class variables under the class). An assignment in a
 * function to a class variable that the function does not declare again is a class variable.
 */
function signalVariables(file: GdFile): Map<unknown, Map<string, string>> {
  const out = new Map<unknown, Map<string, string>>();
  const locals = new Map<unknown, Set<string>>();
  const classVars = new Map<unknown, Set<string>>();
  const assigns: { scope: Scope; name: string; value: Expr }[] = [];
  const add = (key: unknown, name: string, value: Expr): void => {
    const signal = signalOf(value);
    if (signal !== null) out.set(key, (out.get(key) ?? new Map<string, string>()).set(name, signal));
  };
  visitClass(file.top, {
    stmt(s, scope) {
      if (s.k === 'func' && scope.method === null) localNames(locals, s, s.params.map((p) => p.name));
      if (s.k === 'var' && scope.method === null) classVars.set(scope.cls, (classVars.get(scope.cls) ?? new Set<string>()).add(s.name));
      if ((s.k === 'var' || s.k === 'for') && scope.method !== null) localNames(locals, scope.method, [s.name]);
      if (s.k === 'var' && s.value) add(scope.method ?? scope.cls, s.name, s.value);
      if (s.k === 'assign' && s.op === '=' && s.target.k === 'name') assigns.push({ scope, name: s.target.name, value: s.value });
    },
    expr(e, scope) {
      if (e.k === 'lambda' && scope.method !== null) localNames(locals, scope.method, e.fn.params.map((p) => p.name));
    },
  });
  for (const { scope, name, value } of assigns) {
    const field = scope.method !== null && !(locals.get(scope.method)?.has(name) ?? false) && (classVars.get(scope.cls)?.has(name) ?? false);
    add(field ? scope.cls : (scope.method ?? scope.cls), name, value);
  }
  return out;
}

/** The input signal an `emit()` or `emit_signal()` call emits, or null. */
function emittedSignal(call: Extract<Expr, { k: 'call' }>, scope: Scope, variables: Map<unknown, Map<string, string>>): string | null {
  const target = callTarget(call);
  const first = call.args[0];
  if (target?.name === 'emit_signal') return first?.k === 'str' && INPUT_SIGNALS.has(first.value) ? first.value : null;
  const recv = target?.name === 'emit' ? target.recv : null;
  if (!recv) return null;
  if (recv.k !== 'name') return signalOf(recv);
  return variables.get(scope.method ?? scope.cls)?.get(recv.name) ?? variables.get(scope.cls)?.get(recv.name) ?? null;
}

export function checkFile(file: GdFile): Finding[] {
  const out: Finding[] = [];
  const variables = signalVariables(file);
  for (const { call, scope } of callsOf(file)) {
    const target = callTarget(call);
    if (target && HANDLERS.has(target.name)) out.push(finding(NAME, at(file.path, call.line), `direct call of \`${target.name}()\``));
    const emitted = emittedSignal(call, scope, variables);
    if (emitted !== null) out.push(finding(NAME, at(file.path, call.line), `direct emit of engine input signal \`${emitted}\``));
  }
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  return (await Promise.all(sc.filter((p) => isClientContentGd(p) && isClientTest(p)).map(async (p) => checkFile(await sc.gd(p))))).flat();
}
