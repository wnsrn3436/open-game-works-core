import ts from 'typescript';
import type { StaticContext } from './context.ts';

const sources = new WeakMap<StaticContext, Map<string, Promise<ts.SourceFile>>>();

/** A parsed TypeScript file of the checkout (cached per static check run). */
export function tsSource(sc: StaticContext, path: string): Promise<ts.SourceFile> {
  let map = sources.get(sc);
  if (!map) {
    map = new Map();
    sources.set(sc, map);
  }
  let source = map.get(path);
  if (!source) {
    source = sc.text(path).then((text) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
    map.set(path, source);
  }
  return source;
}

/** Visits every node depth first. */
export function walkTs(node: ts.Node, fn: (node: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => {
    walkTs(child, fn);
  });
}

/** 1-based line of a node's start. */
export function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** Text of a string-like literal, or null. */
export function stringText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  return null;
}

/** `a.b.c` for identifiers and property accesses, or null. */
export function tsChain(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const left = tsChain(node.expression);
    return left === null ? null : `${left}.${node.name.text}`;
  }
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  return null;
}

/** Called name of a call: `f(...)` → `f`, `a.b.f(...)` → `f`. */
export function calledName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

export { ts };
