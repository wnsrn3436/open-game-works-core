import type { Rule, Scope } from 'eslint';
import type * as ESTree from 'estree';

/**
 * Handler helpers that `ogw/no-swallowed-error` accepts by name (ogw.md `## code check`): `whenNotFound(value)` turns
 * only a not-found error into `value` and rethrows the rest, and `ignoreCleanupError` is the handler of a best-effort
 * cleanup whose failure cannot change a result.
 */
export const HANDLER_HELPERS: readonly string[] = ['whenNotFound', 'ignoreCleanupError'];

/** Calls that never return: a statement that calls one ends its path with a throw. */
const THROWING_CALLS: readonly string[] = ['fail'];

type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.FunctionExpression | ESTree.FunctionDeclaration;

const MESSAGE =
  'the error is not used and the handler can end without a throw: check the expected error (isNotFound, whenNotFound) and rethrow the rest, give the result its definition sets with the error message, or pass a cleanup failure to ignoreCleanupError';

function isFunction(node: ESTree.Node | null | undefined): node is FunctionNode {
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression' || node?.type === 'FunctionDeclaration';
}

function throwingCall(node: ESTree.Expression): boolean {
  const call = node.type === 'AwaitExpression' ? node.argument : node;
  return call.type === 'CallExpression' && call.callee.type === 'Identifier' && THROWING_CALLS.includes(call.callee.name);
}

/** Whether `node` contains a statement that leaves it other than by a throw (outside nested functions). */
function leaves(node: ESTree.Node): boolean {
  if (node.type === 'ReturnStatement' || node.type === 'BreakStatement' || node.type === 'ContinueStatement') return true;
  if (isFunction(node)) return false;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    const children: unknown[] = Array.isArray(value) ? value : [value];
    for (const child of children) if (typeof child === 'object' && child !== null && 'type' in child && leaves(child as ESTree.Node)) return true;
  }
  return false;
}

/** Whether every path through `node` ends in a throw. */
function alwaysThrows(node: ESTree.Statement | ESTree.Expression): boolean {
  switch (node.type) {
    case 'ThrowStatement':
      return true;
    case 'ExpressionStatement':
      return throwingCall(node.expression);
    case 'BlockStatement': {
      const last = node.body.at(-1);
      return last !== undefined && !node.body.some(leaves) && alwaysThrows(last);
    }
    case 'IfStatement':
      return node.alternate !== null && node.alternate !== undefined && alwaysThrows(node.consequent) && alwaysThrows(node.alternate);
    default:
      return !node.type.endsWith('Statement') && !node.type.endsWith('Declaration') && throwingCall(node as ESTree.Expression);
  }
}

/** Whether the catch clause or handler uses the error it gets. */
function usesError(sourceCode: Rule.RuleContext['sourceCode'], owner: ESTree.CatchClause | FunctionNode, param: ESTree.Pattern | null | undefined): boolean {
  if (param?.type !== 'Identifier') return param !== null && param !== undefined;
  const variable = sourceCode.getDeclaredVariables(owner).find((v) => v.name === param.name);
  return variable !== undefined && variable.references.length > 0;
}

function swallows(sourceCode: Rule.RuleContext['sourceCode'], handler: FunctionNode): boolean {
  return !usesError(sourceCode, handler, handler.params[0]) && !alwaysThrows(handler.body);
}

/** The function a name refers to in its file, or null. */
function definedFunction(scope: Scope.Scope, name: string): { node: FunctionNode | null; def: Scope.Definition | null } {
  for (let s: Scope.Scope | null = scope; s !== null; s = s.upper) {
    const variable = s.set.get(name);
    if (variable === undefined) continue;
    const def = variable.defs[0] ?? null;
    if (def?.type === 'FunctionName') return { node: def.node, def };
    if (def?.type === 'Variable' && isFunction(def.node.init)) return { node: def.node.init, def };
    return { node: null, def };
  }
  return { node: null, def: null };
}

/** The `reject` parameter of a `new Promise((resolve, reject) => ...)` executor: it passes the error on. */
function isPromiseReject(def: Scope.Definition | null): boolean {
  if (def?.type !== 'Parameter') return false;
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

/** The functions a factory returns: its expression body or the argument of each of its returns; null when one is no function. */
function returnedFunctions(factory: FunctionNode): FunctionNode[] | null {
  if (factory.body.type !== 'BlockStatement') return isFunction(factory.body) ? [factory.body] : null;
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
  const made: FunctionNode[] = [];
  for (const value of returned) if (isFunction(value)) made.push(value);
  return made.length === 0 || made.length < returned.length ? null : made;
}

/**
 * Whether the handler passed to `.catch(...)` or as the second argument of `.then(...)` can drop its error: an inline
 * function is checked itself, a name or a factory call is checked at its definition in the file, and a name that is
 * not defined in the file passes only when it is one of `HANDLER_HELPERS` or the `reject` of a promise executor.
 */
function handlerSwallows(context: Rule.RuleContext, handler: ESTree.Node): boolean {
  const sourceCode = context.sourceCode;
  if (isFunction(handler)) return swallows(sourceCode, handler);
  const scope = sourceCode.getScope(handler);
  if (handler.type === 'Identifier') {
    if (HANDLER_HELPERS.includes(handler.name)) return false;
    const { node, def } = definedFunction(scope, handler.name);
    if (node !== null) return swallows(sourceCode, node);
    return !isPromiseReject(def);
  }
  if (handler.type === 'CallExpression' && handler.callee.type === 'Identifier') {
    if (HANDLER_HELPERS.includes(handler.callee.name)) return false;
    const { node } = definedFunction(scope, handler.callee.name);
    const made = node === null ? null : returnedFunctions(node);
    return made === null || made.some((fn) => swallows(sourceCode, fn));
  }
  return true;
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
    return {
      CatchClause(node: ESTree.CatchClause) {
        if (!usesError(context.sourceCode, node, node.param) && !alwaysThrows(node.body)) context.report({ node, messageId: 'swallowed' });
      },
      CallExpression(node: ESTree.CallExpression) {
        if (node.callee.type !== 'MemberExpression' || node.callee.property.type !== 'Identifier') return;
        const method = node.callee.property.name;
        const handler = method === 'catch' ? node.arguments[0] : method === 'then' ? node.arguments[1] : undefined;
        if (handler === undefined || handler.type === 'SpreadElement') return;
        if (handlerSwallows(context, handler)) context.report({ node: handler, messageId: 'swallowed' });
      },
    };
  },
};
