import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isServerContentTs } from './lib/files.ts';
import { lineOf, ts, tsChain, tsSource, walkTs } from './lib/ts-source.ts';

/**
 * system clock: server content code reads the system clock. `server-content` `## handler` names `Date.now()`,
 * `new Date()` without arguments, `Date()` called as a function, `performance.now()`, `performance.timeOrigin`,
 * `process.hrtime()`, `process.hrtime.bigint()` and `process.uptime()`. They are found through `globalThis.` and
 * `global.`, through imports of `process` and `perf_hooks`, and as references that are not called (`const now = Date.now`).
 */
export const NAME = 'system clock';

/** Clock functions: a reference to one is a read, called or not. */
const CLOCK_FUNCTIONS = new Set(['Date.now', 'performance.now', 'process.hrtime', 'process.hrtime.bigint', 'process.uptime']);
const CLOCK_PROPERTIES = new Set(['performance.timeOrigin']);
const GLOBAL_PREFIXES = ['globalThis.', 'global.'];

/** Global names a module import gives: `process` of `node:process`, `performance` of `node:perf_hooks`. */
const MODULE_GLOBALS: Record<string, string> = { process: 'process', 'node:process': 'process', perf_hooks: 'perf_hooks', 'node:perf_hooks': 'perf_hooks' };

/** Local names that stand for a clock global or a member of one, from the imports of the file. */
function importAliases(source: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const module = MODULE_GLOBALS[stmt.moduleSpecifier.text];
    const clause = stmt.importClause;
    if (module === undefined || !clause) continue;
    // the `performance` member of `perf_hooks` is the global `performance`: the module name itself drops out ('')
    const whole = module === 'perf_hooks' ? '' : module;
    if (clause.name) aliases.set(clause.name.text, whole);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) aliases.set(bindings.name.text, whole);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        aliases.set(el.name.text, module === 'perf_hooks' ? imported : `${module}.${imported}`);
      }
    }
  }
  return aliases;
}

const aliasCache = new WeakMap<ts.SourceFile, Map<string, string>>();

function aliasesOf(node: ts.Node): Map<string, string> {
  const source = node.getSourceFile();
  let aliases = aliasCache.get(source);
  if (!aliases) {
    aliases = importAliases(source);
    aliasCache.set(source, aliases);
  }
  return aliases;
}

/** The global chain an expression names: `globalThis.`/`global.` dropped and an imported first name replaced; or null. */
function globalChain(node: ts.Node): string | null {
  let chain = tsChain(node);
  if (chain === null) return null;
  for (const prefix of GLOBAL_PREFIXES) if (chain.startsWith(prefix)) chain = chain.slice(prefix.length);
  const dot = chain.indexOf('.');
  const first = dot === -1 ? chain : chain.slice(0, dot);
  const alias = aliasesOf(node).get(first);
  if (alias === undefined) return chain;
  if (alias === '') return dot === -1 ? null : chain.slice(dot + 1);
  return alias + (dot === -1 ? '' : chain.slice(dot));
}

/** True when the node is a name in a declaration or the member name of a property access, not an expression. */
function notAnExpression(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  return ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent);
}

function isCalled(node: ts.Node): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

/** `new Date()` without arguments or `Date()` called as a function, or null. */
function dateRead(node: ts.Node): string | null {
  if (ts.isNewExpression(node) && globalChain(node.expression) === 'Date' && (node.arguments?.length ?? 0) === 0) return 'new Date()';
  return ts.isCallExpression(node) && globalChain(node.expression) === 'Date' ? 'Date()' : null;
}

export function clockRead(node: ts.Node): string | null {
  if (ts.isNewExpression(node) || ts.isCallExpression(node)) return dateRead(node);
  if (!(ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) || notAnExpression(node)) return null;
  return referenceRead(node);
}

/** A clock function or property a name or property access refers to, or null. */
function referenceRead(node: ts.Identifier | ts.PropertyAccessExpression): string | null {
  const chain = globalChain(node);
  if (chain === null) return null;
  if (CLOCK_PROPERTIES.has(chain)) return isCalled(node) ? null : chain;
  if (!CLOCK_FUNCTIONS.has(chain)) return null;
  // `process.hrtime` inside `process.hrtime.bigint` is reported once, as the longer chain
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node && CLOCK_FUNCTIONS.has(globalChain(parent) ?? '')) return null;
  return isCalled(node) ? `${chain}()` : chain;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const results = await Promise.all(
    sc.filter(isServerContentTs).map(async (path) => {
      const source = await tsSource(sc, path);
      const out: Finding[] = [];
      walkTs(source, (node) => {
        const what = clockRead(node);
        if (what) out.push(finding(NAME, at(path, lineOf(source, node)), `\`${what}\``));
      });
      return out;
    }),
  );
  return results.flat();
}
