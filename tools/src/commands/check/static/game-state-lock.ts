import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isServerContentTs, isServerTest } from './lib/files.ts';
import { calledName, lineOf, stringText, ts, tsSource } from './lib/ts-source.ts';

/**
 * game state lock: server content code writes a game state row from a value it read without locking the row first
 * (`server-content` `## handler`, `storage` `### game state`). Inside one function body (nested functions are their
 * own bodies), a `put_game_state(ctx, value, expires_at)` whose value comes from an earlier
 * `get_game_state(ctx, kind, key)` of that body is a read-modify-write. The value comes from the read when the value
 * expression holds the read or names a variable bound from it: through a variable declaration, a `for ... of`/`in`
 * variable, or an assignment to the variable or to a field of it, also through other such variables (the arguments
 * of a read pick the row and are not its value). The
 * read-modify-write needs a `lock_game_row(ctx, 'game_state', [kind, key])` of the same body before the read, with
 * the kind and key of the same source text. Server tests are not checked.
 */
export const NAME = 'game state lock';

interface Read {
  pos: number;
  kind: string;
  key: string;
}

interface Lock {
  pos: number;
  kind: string;
  key: string;
}

/** A value flow: the variables `targets` hold what `source` holds. */
interface Flow {
  targets: string[];
  reads: Set<Read>;
  refs: Set<string>;
}

function isFunctionBody(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) ||
    ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
  );
}

/** Visits the nodes under `node` without entering nested function bodies. */
function walkBody(node: ts.Node, fn: (node: ts.Node) => void): void {
  ts.forEachChild(node, (child) => {
    if (isFunctionBody(child)) return;
    fn(child);
    walkBody(child, fn);
  });
}

function text(node: ts.Node | undefined): string | null {
  return node === undefined ? null : node.getText().trim();
}

/** `get_game_state(ctx, kind, key)`, or null. */
function readOf(call: ts.CallExpression): Read | null {
  if (calledName(call) !== 'get_game_state') return null;
  const [kind, key] = [text(call.arguments[1]), text(call.arguments[2])];
  return kind === null || key === null ? null : { pos: call.getStart(), kind, key };
}

/** `lock_game_row(ctx, 'game_state', [kind, key])`, or null. */
function lockOf(call: ts.CallExpression): Lock | null {
  if (calledName(call) !== 'lock_game_row') return null;
  const [table, key] = [call.arguments[1], call.arguments[2]];
  if (table === undefined || stringText(table) !== 'game_state' || key === undefined || !ts.isArrayLiteralExpression(key)) return null;
  if (key.elements.length !== 2) return null;
  return { pos: call.getStart(), kind: text(key.elements[0]) as string, key: text(key.elements[1]) as string };
}

/** True when an identifier is a name, not a reference: a member name, a property name, a declared method name. */
function isName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) return true;
  return false;
}

/** The names a binding name binds. */
function bindingNames(binding: ts.BindingName): string[] {
  if (ts.isIdentifier(binding)) return [binding.text];
  return binding.elements.flatMap((el) => (ts.isBindingElement(el) ? bindingNames(el.name) : []));
}

/** The statements of a block-like scope, or null for another node. */
function statementsOf(scope: ts.Node): readonly ts.Statement[] | null {
  if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) return scope.statements;
  return null;
}

/** Whether the statements declare `name`: `let`/`const`, functions and classes directly in them, `var` anywhere in a function body. */
function statementsDeclare(statements: readonly ts.Statement[], functionScope: boolean, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node, top: boolean): void => {
    if (found) return;
    if (ts.isVariableStatement(node)) {
      const blockScoped = (node.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0;
      if ((blockScoped ? top : functionScope) && node.declarationList.declarations.some((d) => bindingNames(d.name).includes(name))) found = true;
    }
    if (top && (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name) found = true;
    // a `var` of a nested block belongs to this function body; nested functions keep their own
    if (functionScope && !ts.isFunctionLike(node) && !ts.isClassLike(node)) {
      ts.forEachChild(node, (child) => {
        visit(child, false);
      });
    }
  };
  for (const st of statements) visit(st, true);
  return found;
}

/** Whether `scope` declares `name` itself: its parameters, loop or catch variables, or its own statements' declarations. */
function declares(scope: ts.Node, name: string): boolean {
  if (ts.isFunctionLike(scope) && scope.parameters.some((p) => bindingNames(p.name).includes(name))) return true;
  if (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) {
    const init = scope.initializer;
    return init !== undefined && ts.isVariableDeclarationList(init) && init.declarations.some((d) => bindingNames(d.name).includes(name));
  }
  if (ts.isCatchClause(scope)) return scope.variableDeclaration !== undefined && bindingNames(scope.variableDeclaration.name).includes(name);
  const statements = statementsOf(scope);
  if (statements === null) return false;
  return statementsDeclare(statements, ts.isSourceFile(scope) || ts.isFunctionLike(scope.parent), name);
}

/** The variable an identifier names: the scope that declares it and its name; a name no scope declares is global. */
function variableOf(id: ts.Identifier): string {
  for (let node: ts.Node = id.parent; ; node = node.parent) {
    if (declares(node, id.text)) return `${String(node.pos)}:${String(node.end)}:${id.text}`;
    if (ts.isSourceFile(node)) break;
  }
  return `global:${id.text}`;
}

/**
 * The variables an expression refers to, nested functions and their captures included, types left out. The nodes
 * `skip` names are left out: the value of a read is the row, not its arguments. Two variables of the same name in
 * different scopes are different variables.
 */
function refsOf(node: ts.Node, skip: (node: ts.Node) => boolean = () => false, out: Set<string> = new Set()): Set<string> {
  if (skip(node)) return out;
  if (ts.isIdentifier(node)) {
    if (!isName(node)) out.add(variableOf(node));
    return out;
  }
  ts.forEachChild(node, (child) => {
    if (!ts.isTypeNode(child)) refsOf(child, skip, out);
  });
  return out;
}

/** The variables a binding name or an assignment target binds. */
function boundNames(node: ts.Node): string[] {
  if (ts.isIdentifier(node)) return [variableOf(node)];
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return boundNames(node.expression);
  // `a.b.c = ...` and `a[i] = ...` change the variable `a`
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return boundNames(node.expression);
  const out: string[] = [];
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    for (const el of node.elements) if (ts.isBindingElement(el)) out.push(...boundNames(el.name));
  } else if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) {
    out.push(...refsOf(node));
  }
  return out;
}

function isAssignment(node: ts.Node): node is ts.BinaryExpression {
  if (!ts.isBinaryExpression(node)) return false;
  const op = node.operatorToken.kind;
  return op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment;
}

/** Findings of one function body. */
function bodyFindings(path: string, source: ts.SourceFile, body: ts.FunctionLikeDeclaration): Finding[] {
  const reads = new Map<ts.CallExpression, Read>();
  const locks: Lock[] = [];
  const puts: ts.CallExpression[] = [];
  walkBody(body, (node) => {
    if (!ts.isCallExpression(node)) return;
    const read = readOf(node);
    if (read) reads.set(node, read);
    const lock = lockOf(node);
    if (lock) locks.push(lock);
    if (calledName(node) === 'put_game_state' && node.arguments.length >= 2) puts.push(node);
  });
  if (reads.size === 0 || puts.length === 0) return [];

  /** The reads of this body inside `node`, and the variables it refers to. */
  const holds = (node: ts.Node): { reads: Set<Read>; refs: Set<string> } => {
    const inside = new Set<Read>();
    const own = reads.get(node as ts.CallExpression);
    if (own) inside.add(own);
    walkBody(node, (n) => {
      const read = reads.get(n as ts.CallExpression);
      if (read) inside.add(read);
    });
    return { reads: inside, refs: refsOf(node, (n) => reads.has(n as ts.CallExpression)) };
  };

  const flows: Flow[] = [];
  walkBody(body, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) flows.push({ targets: boundNames(node.name), ...holds(node.initializer) });
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      // `for (const row of ...)` declares the variable; `for (row of ...)` assigns one that already exists
      if (ts.isVariableDeclarationList(node.initializer)) {
        for (const decl of node.initializer.declarations) flows.push({ targets: boundNames(decl.name), ...holds(node.expression) });
      } else {
        flows.push({ targets: boundNames(node.initializer), ...holds(node.expression) });
      }
    }
    if (isAssignment(node)) flows.push({ targets: boundNames(node.left), ...holds(node.right) });
  });

  // what each variable holds, to a fixed point over the flows
  const held = new Map<string, Set<Read>>();
  const heldBy = (refs: Set<string>, into: Set<Read>): void => {
    for (const ref of refs) for (const read of held.get(ref) ?? []) into.add(read);
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const flow of flows) {
      const value = new Set(flow.reads);
      heldBy(flow.refs, value);
      for (const target of flow.targets) {
        const set = held.get(target) ?? new Set<Read>();
        const before = set.size;
        for (const read of value) set.add(read);
        held.set(target, set);
        if (set.size !== before) changed = true;
      }
    }
  }

  const out: Finding[] = [];
  for (const put of puts) {
    const value = holds(put.arguments[1] as ts.Expression);
    heldBy(value.refs, value.reads);
    const putPos = put.getStart();
    // the first read of each (kind, key) before the write
    const first = new Map<string, Read>();
    for (const read of [...value.reads].filter((r) => r.pos < putPos).sort((a, b) => a.pos - b.pos)) {
      const id = `${read.kind}\u0000${read.key}`;
      if (!first.has(id)) first.set(id, read);
    }
    for (const read of first.values()) {
      if (locks.some((l) => l.kind === read.kind && l.key === read.key && l.pos < read.pos)) continue;
      out.push(
        finding(
          NAME,
          at(path, lineOf(source, put)),
          `put_game_state of (${read.kind}, ${read.key}) after get_game_state without lock_game_row(ctx, 'game_state', [${read.kind}, ${read.key}]) before the read`,
        ),
      );
    }
  }
  return out;
}

export function fileFindings(path: string, source: ts.SourceFile): Finding[] {
  const out: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionBody(node)) out.push(...bodyFindings(path, source, node));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const files = sc.filter((p) => isServerContentTs(p) && !isServerTest(p));
  const results = await Promise.all(files.map(async (path) => fileFindings(path, await tsSource(sc, path))));
  return results.flat();
}
