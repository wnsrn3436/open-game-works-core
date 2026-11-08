import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isClientTest, isServerTest } from './lib/files.ts';
import type { GdFile } from './lib/gd-ast.ts';
import { callTarget, visitClass } from './lib/gd-walk.ts';
import { lineOf, ts, tsSource, walkTs } from './lib/ts-source.ts';

/**
 * test skip: a regression test skips or focuses a test. In a `.gd` file of `client/tests/`: a `pending()` call (bare or on
 * `self`), a `skip_script` declared or assigned, and a `should_skip_script()` declared (`client-content` Godot
 * `## regression test`). In a `.ts` file of `server/tests/`: a member `skip`, `only`, `todo`, `skipIf` or `runIf` of a
 * member chain that starts at `describe`, `it`, `test` or `suite` when the file declares no name of that start (an import
 * from `vitest` declares none: it gives the same functions as the globals), and a
 * `skip()` call on the first parameter of the function given to `it` or `test`, also through a destructured `skip`
 * (`server-content` `## regression test`).
 */
export const NAME = 'test skip';

function gdFindings(file: GdFile): Finding[] {
  const out: Finding[] = [];
  const add = (line: number, what: string): void => {
    out.push(finding(NAME, at(file.path, line), `${what} skips a test; a regression test runs every test`));
  };
  visitClass(file.top, {
    stmt(s) {
      if (s.k === 'var' && s.name === 'skip_script') add(s.line, '`skip_script`');
      if (s.k === 'assign' && s.target.k === 'name' && s.target.name === 'skip_script') add(s.line, '`skip_script`');
      if (s.k === 'assign' && s.target.k === 'member' && s.target.name === 'skip_script' && s.target.obj.k === 'name' && s.target.obj.name === 'self') add(s.line, '`skip_script`');
      if (s.k === 'func' && s.name === 'should_skip_script') add(s.line, '`should_skip_script()`');
    },
    expr(e) {
      if (e.k !== 'call') return;
      const target = callTarget(e);
      const onSelf = target !== null && (target.recv === null || (target.recv.k === 'name' && target.recv.name === 'self'));
      if (onSelf && target.name === 'pending') add(e.line, '`pending()`');
    },
  });
  return out;
}

const ROOTS = new Set(['describe', 'it', 'test', 'suite']);
const SKIP_MEMBERS = new Set(['skip', 'only', 'todo', 'skipIf', 'runIf']);
const TEST_FUNCTIONS = new Set(['it', 'test']);

/** Whether an import clause or one of its names is of an import from `vitest`, whose test functions are those of the globals. */
function fromVitest(node: ts.ImportClause | ts.ImportSpecifier | ts.NamespaceImport): boolean {
  const clause = ts.isImportClause(node) ? node : ts.isNamespaceImport(node) ? node.parent : node.parent.parent;
  const declaration = clause.parent;
  return ts.isImportDeclaration(declaration) && ts.isStringLiteral(declaration.moduleSpecifier) && declaration.moduleSpecifier.text === 'vitest';
}

/** Names that a file declares: variables, parameters, functions, classes and imports other than those from `vitest`. */
function declaredNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const bind = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bind(el.name);
  };
  walkTs(source, (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) bind(node.name);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) names.add(node.name.text);
    if (ts.isImportClause(node) && node.name && !fromVitest(node)) names.add(node.name.text);
    if ((ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) && !fromVitest(node)) names.add(node.name.text);
  });
  return names;
}

/** The identifier a member chain starts at (`describe` of `describe.concurrent.skip`), or null. */
function chainRoot(node: ts.Expression): ts.Identifier | null {
  let e = node;
  while (ts.isPropertyAccessExpression(e)) e = e.expression;
  return ts.isIdentifier(e) ? e : null;
}

/** Local names that stand for the `skip` of a test context: the first parameter, or a destructured `skip` of it. */
function contextSkips(fn: ts.SignatureDeclaration): { context: string | null; skip: string | null } {
  const first = fn.parameters[0];
  if (first === undefined) return { context: null, skip: null };
  if (ts.isIdentifier(first.name)) return { context: first.name.text, skip: null };
  if (ts.isObjectBindingPattern(first.name)) {
    for (const el of first.name.elements) {
      const key = el.propertyName ?? el.name;
      if (ts.isIdentifier(key) && key.text === 'skip' && ts.isIdentifier(el.name)) return { context: null, skip: el.name.text };
    }
  }
  return { context: null, skip: null };
}

function tsFindings(source: ts.SourceFile, path: string): Finding[] {
  const out: Finding[] = [];
  const declared = declaredNames(source);
  const add = (node: ts.Node, what: string, verb: string): void => {
    out.push(finding(NAME, at(path, lineOf(source, node)), `${what} ${verb}; a regression test runs every test`));
  };
  walkTs(source, (node) => {
    if (ts.isPropertyAccessExpression(node) && SKIP_MEMBERS.has(node.name.text)) {
      const root = chainRoot(node.expression);
      if (root !== null && ROOTS.has(root.text) && !declared.has(root.text)) add(node, `\`${node.getText(source)}\``, node.name.text === 'only' ? 'focuses a test, which skips the others' : 'skips a test');
    }
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || !TEST_FUNCTIONS.has(node.expression.text) || declared.has(node.expression.text)) return;
    const fn = node.arguments.find((a): a is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
    if (fn === undefined) return;
    const { context, skip } = contextSkips(fn);
    walkTs(fn.body, (inner) => {
      if (!ts.isCallExpression(inner)) return;
      const callee = inner.expression;
      const onContext = context !== null && ts.isPropertyAccessExpression(callee) && callee.name.text === 'skip' && ts.isIdentifier(callee.expression) && callee.expression.text === context;
      const destructured = skip !== null && ts.isIdentifier(callee) && callee.text === skip;
      if (onContext || destructured) add(inner, `\`${callee.getText(source)}()\``, 'skips a test');
    });
  });
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const client = await Promise.all(sc.filter((p) => isClientTest(p) && p.endsWith('.gd')).map(async (p) => gdFindings(await sc.gd(p))));
  const server = await Promise.all(sc.filter((p) => isServerTest(p) && /\.(ts|mts|cts)$/.test(p)).map(async (p) => tsFindings(await tsSource(sc, p), p)));
  return [...client.flat(), ...server.flat()];
}
