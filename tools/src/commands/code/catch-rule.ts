import { basename, dirname, resolve } from 'node:path';
import type { Rule, Scope } from 'eslint';
import type * as ESTree from 'estree';

type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.FunctionExpression | ESTree.FunctionDeclaration;

const MESSAGE =
  'the error is not used and the handler can end without a throw: check the expected error (isNotFound, whenNotFound) and rethrow the rest, give the result its definition sets with the error message, or pass a cleanup failure to ignoreCleanupError';

/**
 * A way a statement ends other than by a throw: `normal` (it completes), `return`, or `break:<label>` and
 * `continue:<label>` (`<label>` empty for an unlabeled one).
 */
type Exit = string;

const NORMAL: Exit = 'normal';
const BREAK: Exit = 'break:';
const CONTINUE: Exit = 'continue:';

/** The rule state of one file: its source code and whether each function of the file is known to always throw. */
interface Analysis {
  sourceCode: Rule.RuleContext['sourceCode'];
  filename: string;
  throws: Map<FunctionNode, boolean>;
}

function isFunction(node: ESTree.Node | null | undefined): node is FunctionNode {
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression' || node?.type === 'FunctionDeclaration';
}

/**
 * What a name refers to in its file: a function with a body, a variable whose value is another expression, an import,
 * a parameter, `none` for a name that the file does not define (or only declares without a body, as `declare function`
 * and overload signatures do), or `other` (also for a name defined more than once or assigned after its definition,
 * which can hold another value when it is used).
 */
type Definition =
  | { kind: 'function'; node: FunctionNode }
  | { kind: 'value'; node: ESTree.Expression }
  | { kind: 'import'; imported: string | null; source: string }
  | { kind: 'parameter'; def: Scope.Definition }
  | { kind: 'none' }
  | { kind: 'other' };

function classify(variable: Scope.Variable): Definition {
  // an overloaded function has a definition per signature: only the one with a body is the implementation
  const defs = variable.defs.filter((def) => def.type !== 'FunctionName' || isFunction(def.node));
  if (defs.length > 1 || variable.references.some((ref) => ref.isWrite() && ref.init !== true)) return { kind: 'other' };
  const def = defs[0];
  switch (def?.type) {
    case undefined:
      return { kind: 'none' };
    case 'FunctionName':
      return isFunction(def.node) ? { kind: 'function', node: def.node } : { kind: 'none' };
    case 'Variable': {
      const init = def.node.init;
      if (init === null || init === undefined) return { kind: 'other' };
      return isFunction(init) ? { kind: 'function', node: init } : { kind: 'value', node: init };
    }
    case 'ImportBinding':
      return importOf(def);
    case 'Parameter':
      return { kind: 'parameter', def };
    default:
      return { kind: 'other' };
  }
}

/** The name an import binding imports (null for a default or namespace import) and its module. */
function importOf(def: Scope.Definition & { type: 'ImportBinding' }): Definition {
  const spec = def.node;
  const imported = spec.type !== 'ImportSpecifier' ? null : spec.imported.type === 'Identifier' ? spec.imported.name : String(spec.imported.value);
  // a TypeScript `import x = require(...)` has no `source`
  const source = (def.parent as { source?: { value?: unknown } } | null)?.source?.value;
  return { kind: 'import', imported, source: typeof source === 'string' ? source : '' };
}

/** The definition of `name` as seen from `scope`. */
function definitionOf(scope: Scope.Scope, name: string): Definition {
  for (let s: Scope.Scope | null = scope; s !== null; s = s.upper) {
    const variable = s.set.get(name);
    if (variable !== undefined) return classify(variable);
  }
  return { kind: 'none' };
}

/** True for the import of `fail` of `lib/errors.ts`, which always throws. */
function isErrorsFail(a: Analysis, def: Definition): boolean {
  if (def.kind !== 'import' || def.imported !== 'fail' || !def.source.startsWith('.')) return false;
  const file = resolve(dirname(a.filename), def.source);
  return basename(file) === 'errors.ts' && basename(dirname(file)) === 'lib';
}

/**
 * Whether evaluating `node` as a statement always throws: a call of `fail` of `lib/errors.ts`, or of a function of the
 * file whose body always throws (awaited when that function is async).
 */
function throwingCall(a: Analysis, node: ESTree.Expression): boolean {
  const awaited = node.type === 'AwaitExpression';
  const call = awaited ? node.argument : node;
  if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier') return false;
  const def = definitionOf(a.sourceCode.getScope(call), call.callee.name);
  if (isErrorsFail(a, def)) return true;
  if (def.kind !== 'function' || def.node.generator === true || (def.node.async === true && !awaited)) return false;
  return alwaysThrows(a, def.node);
}

/** Whether every path through the body of `fn` ends in a throw. A call of `fn` inside its own body counts as no throw. */
function alwaysThrows(a: Analysis, fn: FunctionNode): boolean {
  const known = a.throws.get(fn);
  if (known !== undefined) return known;
  a.throws.set(fn, false);
  const result = bodyExits(a, fn).size === 0;
  a.throws.set(fn, result);
  return result;
}

function bodyExits(a: Analysis, fn: FunctionNode): Set<Exit> {
  if (fn.body.type === 'BlockStatement') return exits(a, fn.body);
  return throwingCall(a, fn.body) ? new Set() : new Set([NORMAL]);
}

/** The exits of statements run one after the other: a statement after one that cannot complete is not reached. */
function sequence(a: Analysis, body: readonly ESTree.Statement[]): Set<Exit> {
  const out = new Set<Exit>();
  for (const statement of body) {
    const ends = exits(a, statement);
    const goesOn = ends.delete(NORMAL);
    for (const end of ends) out.add(end);
    if (!goesOn) return out;
  }
  out.add(NORMAL);
  return out;
}

type Loop = ESTree.WhileStatement | ESTree.DoWhileStatement | ESTree.ForStatement | ESTree.ForInStatement | ESTree.ForOfStatement;

/** The exits of a loop with the labels `labels`: a break of it completes it, a continue of it goes on in it. */
function loopExits(a: Analysis, node: Loop, labels: readonly string[]): Set<Exit> {
  const body = exits(a, node.body);
  const ownBreak = (end: Exit): boolean => end === BREAK || labels.some((label) => end === `${BREAK}${label}`);
  const ownContinue = (end: Exit): boolean => end === CONTINUE || labels.some((label) => end === `${CONTINUE}${label}`);
  const broke = [...body].some(ownBreak);
  const reachesTest = body.has(NORMAL) || [...body].some(ownContinue);
  const test = node.type === 'ForInStatement' || node.type === 'ForOfStatement' ? undefined : node.test;
  const endless = node.type !== 'ForInStatement' && node.type !== 'ForOfStatement' && (test === null || test === undefined || (test.type === 'Literal' && Boolean(test.value)));
  const out = new Set([...body].filter((end) => end !== NORMAL && !ownBreak(end) && !ownContinue(end)));
  // the test before the first run of the body can end the loop; a do-while tests only after a run that reaches it
  const testEnds = !endless && (node.type !== 'DoWhileStatement' || reachesTest);
  if (broke || testEnds) out.add(NORMAL);
  return out;
}

function switchExits(a: Analysis, node: ESTree.SwitchStatement): Set<Exit> {
  const out = new Set<Exit>();
  let fallsOff = true;
  for (const branch of node.cases) {
    const ends = sequence(a, branch.consequent);
    fallsOff = ends.has(NORMAL);
    for (const end of ends) if (end !== NORMAL) out.add(end);
  }
  const broke = out.delete(BREAK);
  if (broke || fallsOff || !node.cases.some((branch) => branch.test === null || branch.test === undefined)) out.add(NORMAL);
  return out;
}

function tryExits(a: Analysis, node: ESTree.TryStatement): Set<Exit> {
  const out = exits(a, node.block);
  if (node.handler !== null && node.handler !== undefined) for (const end of exits(a, node.handler.body)) out.add(end);
  if (node.finalizer === null || node.finalizer === undefined) return out;
  const last = exits(a, node.finalizer);
  // a finally block that cannot complete replaces every end of the try; one that completes lets each go on
  if (!last.delete(NORMAL)) return last;
  for (const end of last) out.add(end);
  return out;
}

/**
 * The ways `node` ends other than by a throw (outside nested functions); empty when every path through it ends in a
 * throw. `labels` are the labels of `node`.
 */
function exits(a: Analysis, node: ESTree.Statement, labels: readonly string[] = []): Set<Exit> {
  switch (node.type) {
    case 'ThrowStatement':
      return new Set();
    case 'ReturnStatement':
      // `return fail(...)` ends by the throw of its call
      return node.argument !== null && node.argument !== undefined && throwingCall(a, node.argument) ? new Set() : new Set(['return']);
    case 'BreakStatement':
      return new Set([jump(BREAK, node.label)]);
    case 'ContinueStatement':
      return new Set([jump(CONTINUE, node.label)]);
    case 'ExpressionStatement':
      return throwingCall(a, node.expression) ? new Set() : new Set([NORMAL]);
    case 'BlockStatement':
    case 'StaticBlock':
      return sequence(a, node.body);
    default:
      return compoundExits(a, node, labels);
  }
}

function jump(kind: Exit, label: ESTree.Identifier | null | undefined): Exit {
  return `${kind}${label?.name ?? ''}`;
}

/** `exits` of a statement that holds other statements. */
function compoundExits(a: Analysis, node: ESTree.Statement, labels: readonly string[]): Set<Exit> {
  switch (node.type) {
    case 'IfStatement': {
      const out = exits(a, node.consequent);
      for (const end of node.alternate === null || node.alternate === undefined ? [NORMAL] : exits(a, node.alternate)) out.add(end);
      return out;
    }
    case 'LabeledStatement': {
      const label = node.label.name;
      const out = exits(a, node.body, [...labels, label]);
      if (out.delete(`${BREAK}${label}`)) out.add(NORMAL);
      return out;
    }
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
      return loopExits(a, node, labels);
    case 'SwitchStatement':
      return switchExits(a, node);
    case 'TryStatement':
      return tryExits(a, node);
    case 'WithStatement':
      return exits(a, node.body);
    default:
      return new Set([NORMAL]);
  }
}

/** Whether the catch clause or handler uses the error it gets. */
function usesError(sourceCode: Rule.RuleContext['sourceCode'], owner: ESTree.CatchClause | FunctionNode, param: ESTree.Pattern | null | undefined): boolean {
  if (param?.type !== 'Identifier') return param !== null && param !== undefined;
  const variable = sourceCode.getDeclaredVariables(owner).find((v) => v.name === param.name);
  return variable !== undefined && variable.references.length > 0;
}

function swallows(a: Analysis, handler: FunctionNode): boolean {
  return !usesError(a.sourceCode, handler, handler.params[0]) && bodyExits(a, handler).size > 0;
}

/** The `reject` parameter of a `new Promise((resolve, reject) => ...)` executor: it passes the error on. */
function isPromiseReject(def: Scope.Definition): boolean {
  if (def.type !== 'Parameter') return false;
  const executor = def.node as ESTree.Node & { parent?: ESTree.Node };
  const parent = executor.parent;
  return (
    isFunction(executor) &&
    executor.params[1] === (def.name as ESTree.Node) &&
    parent?.type === 'NewExpression' &&
    parent.callee.type === 'Identifier' &&
    parent.callee.name === 'Promise'
  );
}

/** What a factory returns: its expression body or the argument of each of its returns; null when one returns no value. */
function returnedValues(factory: FunctionNode): ESTree.Expression[] | null {
  if (factory.body.type !== 'BlockStatement') return [factory.body];
  const returned: (ESTree.Expression | null | undefined)[] = [];
  const visit = (node: ESTree.Node): void => {
    if (node.type === 'ReturnStatement') returned.push(node.argument);
    if (node.type === 'ReturnStatement' || isFunction(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue;
      const children: unknown[] = Array.isArray(value) ? value : [value];
      for (const child of children) if (typeof child === 'object' && child !== null && 'type' in child) visit(child as ESTree.Node);
    }
  };
  for (const statement of factory.body.body) visit(statement);
  const values: ESTree.Expression[] = [];
  for (const value of returned) if (value !== null && value !== undefined) values.push(value);
  return values.length === 0 || values.length < returned.length ? null : values;
}

/**
 * Whether the handler passed to `.catch(...)` or as the second argument of `.then(...)` can drop its error: an inline
 * function is checked itself; a name, or a factory call, is checked at its definition in the file, following a name
 * whose value is another name or a call; a name that the file does not define passes only when it is
 * `ignoreCleanupError`, a factory call only when it is `whenNotFound(...)`, and a parameter only when it is the `reject`
 * of a promise executor. `seen` holds the names and calls being followed, so that a cycle of them is no handler.
 */
function handlerSwallows(a: Analysis, handler: ESTree.Node, seen: ReadonlySet<ESTree.Node> = new Set()): boolean {
  if (isFunction(handler)) return swallows(a, handler);
  if (seen.has(handler)) return true;
  const next = new Set([...seen, handler]);
  if (handler.type === 'Identifier') return namedSwallows(a, handler, next);
  if (handler.type === 'CallExpression' && handler.callee.type === 'Identifier') return madeSwallows(a, handler.callee, next);
  return true;
}

/** `handlerSwallows` of a handler given by `name`. */
function namedSwallows(a: Analysis, name: ESTree.Identifier, seen: ReadonlySet<ESTree.Node>): boolean {
  const def = definitionOf(a.sourceCode.getScope(name), name.name);
  switch (def.kind) {
    case 'function':
      return swallows(a, def.node);
    case 'value':
      return handlerSwallows(a, def.node, seen);
    case 'parameter':
      return !isPromiseReject(def.def);
    case 'import':
      return def.imported !== 'ignoreCleanupError';
    case 'none':
      return name.name !== 'ignoreCleanupError';
    default:
      return true;
  }
}

/** `handlerSwallows` of a handler made by a call of the factory `factory`. */
function madeSwallows(a: Analysis, factory: ESTree.Identifier, seen: ReadonlySet<ESTree.Node>): boolean {
  const def = definitionOf(a.sourceCode.getScope(factory), factory.name);
  switch (def.kind) {
    case 'function': {
      const made = returnedValues(def.node);
      return made === null || made.some((value) => handlerSwallows(a, value, seen));
    }
    case 'import':
      return def.imported !== 'whenNotFound';
    case 'none':
      return factory.name !== 'whenNotFound';
    default:
      return true;
  }
}

/**
 * `ogw/no-swallowed-error` (ogw.md `## code check`): a `catch` clause, a `.catch(...)` handler or the rejection handler
 * of `.then(...)` fails when it does not use its error and can end other than by a throw.
 */
export const noSwallowedError: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'A caught error is used or the handler throws: a failure does not silently become a default value' },
    schema: [],
    messages: { swallowed: MESSAGE },
  },
  create(context) {
    const a: Analysis = { sourceCode: context.sourceCode, filename: context.physicalFilename, throws: new Map() };
    return {
      CatchClause(node: ESTree.CatchClause) {
        if (!usesError(a.sourceCode, node, node.param) && exits(a, node.body).size > 0) context.report({ node, messageId: 'swallowed' });
      },
      CallExpression(node: ESTree.CallExpression) {
        if (node.callee.type !== 'MemberExpression' || node.callee.property.type !== 'Identifier') return;
        const method = node.callee.property.name;
        const handler = method === 'catch' ? node.arguments[0] : method === 'then' ? node.arguments[1] : undefined;
        if (handler === undefined || handler.type === 'SpreadElement') return;
        if (handlerSwallows(a, handler)) context.report({ node: handler, messageId: 'swallowed' });
      },
    };
  },
};
