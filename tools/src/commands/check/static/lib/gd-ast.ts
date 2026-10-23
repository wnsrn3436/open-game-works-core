import type { Comment, Token } from './gd-lexer.ts';

/** A type written in GDScript: a dotted name with optional type arguments, for example `Array[GameData.ItemRow]`. */
export interface TypeRef {
  name: string;
  args: TypeRef[];
  line: number;
}

interface Node {
  line: number;
  /** First and last token index of the node. */
  t0: number;
  t1: number;
}

export type Expr =
  | (Node & { k: 'name'; name: string })
  | (Node & { k: 'num'; text: string })
  | (Node & { k: 'str'; value: string; kind: string })
  | (Node & { k: 'nodepath'; sigil: string; path: string })
  | (Node & { k: 'member'; obj: Expr; name: string })
  | (Node & { k: 'call'; callee: Expr; args: Expr[] })
  | (Node & { k: 'index'; obj: Expr; index: Expr })
  | (Node & { k: 'unary'; op: string; expr: Expr })
  | (Node & { k: 'binary'; op: string; left: Expr; right: Expr })
  | (Node & { k: 'ternary'; cond: Expr; then: Expr; else: Expr })
  | (Node & { k: 'array'; items: Expr[] })
  | (Node & { k: 'dict'; entries: { key: Expr; value: Expr }[] })
  | (Node & { k: 'lambda'; fn: FuncDecl })
  | (Node & { k: 'await'; expr: Expr })
  | (Node & { k: 'cast'; expr: Expr; type: TypeRef })
  | (Node & { k: 'is'; expr: Expr; type: TypeRef })
  | (Node & { k: 'error' });

export interface Annotation {
  name: string;
  args: Expr[];
  line: number;
}

export interface VarDecl extends Node {
  k: 'var';
  name: string;
  isConst: boolean;
  isStatic: boolean;
  type: TypeRef | null;
  /** True for `:=`. */
  inferred: boolean;
  value: Expr | null;
  annotations: Annotation[];
  /** Property getter and setter bodies. */
  accessors: FuncDecl[];
}

export interface Param {
  name: string;
  type: TypeRef | null;
  inferred: boolean;
  value: Expr | null;
  line: number;
}

export interface FuncDecl extends Node {
  k: 'func';
  name: string;
  isStatic: boolean;
  params: Param[];
  returnType: TypeRef | null;
  body: Stmt[];
  annotations: Annotation[];
  /** Last line of the body. */
  endLine: number;
}

export interface ClassDecl extends Node {
  k: 'class';
  /** `class_name` of the file, or the inner class name; null for a script without `class_name`. */
  name: string | null;
  /** `extends` target: a class name (dotted) or a `res://` path. */
  extendsName: string | null;
  extendsPath: string | null;
  body: Stmt[];
  isTop: boolean;
  outer: ClassDecl | null;
}

export interface MatchBranch {
  patterns: Token[];
  guard: Expr | null;
  body: Stmt[];
  line: number;
}

export type Stmt =
  | (Node & { k: 'expr'; expr: Expr })
  | (Node & { k: 'assign'; target: Expr; op: string; value: Expr })
  | VarDecl
  | FuncDecl
  | ClassDecl
  | (Node & { k: 'if'; branches: { cond: Expr; body: Stmt[] }[]; elseBody: Stmt[] })
  | (Node & { k: 'for'; name: string; varType: TypeRef | null; iter: Expr; body: Stmt[] })
  | (Node & { k: 'while'; cond: Expr; body: Stmt[] })
  | (Node & { k: 'match'; subject: Expr; branches: MatchBranch[] })
  | (Node & { k: 'return'; value: Expr | null })
  | (Node & { k: 'simple'; word: string })
  | (Node & { k: 'class_name'; name: string })
  | (Node & { k: 'extends'; name: string | null; path: string | null })
  | (Node & { k: 'signal'; name: string })
  | (Node & { k: 'enum'; name: string | null; members: { name: string; value: Expr | null }[] })
  | (Node & { k: 'annotation'; annotation: Annotation })
  | (Node & { k: 'error' });

export interface GdFile {
  /** Game-repo relative path. */
  path: string;
  source: string;
  tokens: Token[];
  comments: Comment[];
  /** The script class: the top-level statements. */
  top: ClassDecl;
}
