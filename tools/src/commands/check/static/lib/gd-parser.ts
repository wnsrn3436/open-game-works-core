import type { Annotation, ClassDecl, Expr, FuncDecl, GdFile, MatchBranch, Param, Stmt, TypeRef, VarDecl } from './gd-ast.ts';
import { lexGd, type Token } from './gd-lexer.ts';

/**
 * Error-tolerant GDScript parser. It builds statements, functions, classes and expressions;
 * text it cannot read becomes `error` nodes and parsing continues on the next line.
 */

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '&=', '|=', '^=']);
const CLOSERS = new Set([')', ']', '}']);
const BINARY_PREC: Record<string, number> = {
  '**': 16, '*': 13, '/': 13, '%': 13, '+': 12, '-': 12, '<<': 11, '>>': 11, '&': 10, '^': 9, '|': 8,
  '==': 7, '!=': 7, '<': 7, '>': 7, '<=': 7, '>=': 7, '&&': 4, '||': 3,
};
const NAME_PREC: Record<string, number> = { in: 6, and: 4, or: 3, if: 2, as: 1, is: 17 };
const POSTFIX_PREC = 19;
const SIMPLE_WORDS = new Set(['pass', 'break', 'continue', 'breakpoint']);
const DECL_STARTS = new Set(['var', 'func', 'static', 'const', 'signal']);

/** Bracket depth change of a token. */
function depthChange(t: Token): number {
  if (t.type !== 'op') return 0;
  if ('([{'.includes(t.text)) return 1;
  return CLOSERS.has(t.text) ? -1 : 0;
}

/** True when a token ends the patterns of a `match` branch. */
function endsPattern(t: Token, depth: number): boolean {
  if (t.type === 'eof') return true;
  if (depth !== 0) return false;
  return t.type === 'newline' || (t.type === 'op' && t.text === ':') || (t.type === 'name' && t.text === 'when');
}

type Make<K extends Expr['k']> = Omit<Extract<Expr, { k: K }>, 'k' | 'line' | 't0' | 't1'>;

class Parser {
  private readonly toks: Token[];
  private i = 0;
  private readonly sig: boolean[] = [true];
  private readonly classes: ClassDecl[] = [];
  private pending: Annotation[] = [];

  constructor(tokens: Token[]) {
    this.toks = tokens;
  }

  // ---- token access ----

  private raw(): Token {
    return this.toks[this.i] as Token;
  }

  private cur(): Token {
    if (!this.sig[this.sig.length - 1]) {
      while (this.raw().type === 'newline') this.i++;
    }
    return this.raw();
  }

  private next(): Token {
    const t = this.cur();
    if (t.type !== 'eof') this.i++;
    return t;
  }

  private peekAfter(): Token {
    let j = this.i + 1;
    if (!this.sig[this.sig.length - 1]) while (this.toks[j]?.type === 'newline') j++;
    return (this.toks[j] ?? this.toks[this.toks.length - 1]) as Token;
  }

  private isOp(text: string): boolean {
    const t = this.cur();
    return t.type === 'op' && t.text === text;
  }

  private isName(text: string): boolean {
    const t = this.cur();
    return t.type === 'name' && t.text === text;
  }

  private accept(text: string): boolean {
    const t = this.cur();
    if ((t.type === 'op' || t.type === 'name') && t.text === text) {
      this.i++;
      return true;
    }
    return false;
  }

  private last(): number {
    return Math.max(0, this.i - 1);
  }

  /** True inside `(`, `[` or `{` (a lambda body inside a call counts). */
  private inBrackets(): boolean {
    return this.sig.includes(false);
  }

  private atLineEnd(): boolean {
    const t = this.raw();
    if (t.type === 'newline' || t.type === 'eof' || (t.type === 'op' && t.text === ';')) return true;
    return this.inBrackets() && t.type === 'op' && (CLOSERS.has(t.text) || t.text === ',');
  }

  private skipToLineEnd(): void {
    let depth = 0;
    for (;;) {
      const t = this.raw();
      if (t.type === 'eof') return;
      if (t.type === 'newline' && depth === 0) return;
      if (t.type === 'op' && '([{'.includes(t.text)) depth++;
      if (t.type === 'op' && CLOSERS.has(t.text)) {
        if (depth === 0 && this.inBrackets()) return;
        depth = Math.max(0, depth - 1);
      }
      this.i++;
    }
  }

  private withSig<T>(value: boolean, fn: () => T): T {
    this.sig.push(value);
    try {
      return fn();
    } finally {
      this.sig.pop();
    }
  }

  private node<K extends Expr['k']>(k: K, t0: number, fields: Make<K>): Expr {
    return { k, line: (this.toks[t0] as Token).line, t0, t1: this.last(), ...fields } as Expr;
  }

  // ---- file and blocks ----

  parseFile(): Stmt[] {
    const out: Stmt[] = [];
    while (this.raw().type !== 'eof') {
      const before = this.i;
      out.push(...this.parseBlockAt(this.raw().indent, -1));
      if (this.i === before) this.i++;
    }
    return out;
  }

  private parseBlockAt(blockIndent: number, headerIndent: number): Stmt[] {
    const out: Stmt[] = [];
    for (;;) {
      const t = this.raw();
      if (t.type === 'eof') break;
      if (t.type === 'newline') {
        this.i++;
        continue;
      }
      if (t.type === 'op' && (CLOSERS.has(t.text) || t.text === ',') && this.inBrackets()) break;
      if (t.indent < blockIndent || t.indent <= headerIndent) break;
      const before = this.i;
      out.push(...this.parseStatement());
      if (this.i === before) this.i++;
    }
    return out;
  }

  /** Body after `:` of a compound statement or function. */
  private parseSuite(header: Token): Stmt[] {
    if (this.raw().type === 'newline') {
      while (this.raw().type === 'newline') this.i++;
      const first = this.raw();
      if (first.type === 'eof' || first.indent <= header.indent) return [];
      if (first.type === 'op' && CLOSERS.has(first.text)) return [];
      return this.parseBlockAt(first.indent, header.indent);
    }
    return this.parseSimpleLine();
  }

  private parseSimpleLine(): Stmt[] {
    const out: Stmt[] = [this.parseSimple()];
    while (this.raw().type === 'op' && this.raw().text === ';') {
      this.i++;
      if (this.atLineEnd()) break;
      out.push(this.parseSimple());
    }
    // A statement that ended with a block (lambda body, property accessors) already consumed its line break.
    if (this.toks[this.i - 1]?.type === 'newline') return out;
    if (this.raw().type !== 'newline' && !this.atLineEnd()) this.skipToLineEnd();
    if (this.raw().type === 'newline' && this.sig[this.sig.length - 1]) this.i++;
    return out;
  }

  // ---- statements ----

  private parseStatement(): Stmt[] {
    const t = this.cur();
    if (t.type === 'op' && t.text === '@') return this.parseAnnotated();
    if (t.type !== 'name') return this.parseSimpleLine();
    switch (t.text) {
      case 'func':
        return [this.parseFunc(false)];
      case 'static':
        if (this.peekAfter().text === 'func') {
          this.i++;
          return [this.parseFunc(true)];
        }
        return this.parseSimpleLine();
      case 'class':
        return [this.parseClass()];
      case 'if':
        return [this.parseIf()];
      case 'for':
        return [this.parseFor()];
      case 'while':
        return [this.parseWhile()];
      case 'match':
        return [this.parseMatch()];
      default:
        return this.parseSimpleLine();
    }
  }

  private parseAnnotationList(): Annotation[] {
    const list: Annotation[] = [];
    for (;;) {
      while (this.isOp('@')) {
        const at = this.next();
        const name = this.next().text;
        const args = this.raw().type === 'op' && this.raw().text === '(' ? this.parseArgs() : [];
        list.push({ name, args, line: at.line });
      }
      if (this.raw().type !== 'newline') return list;
      let j = this.i;
      while (this.toks[j]?.type === 'newline') j++;
      const after = this.toks[j];
      if (!after || !((after.type === 'name' && DECL_STARTS.has(after.text)) || (after.type === 'op' && after.text === '@'))) return list;
      this.i = j;
    }
  }

  private parseAnnotated(): Stmt[] {
    const t0 = this.i;
    const list = this.parseAnnotationList();
    if (this.raw().type === 'newline' || this.raw().type === 'eof') {
      if (this.raw().type === 'newline') this.i++;
      return list.map((annotation) => ({ k: 'annotation', annotation, line: annotation.line, t0, t1: this.last() }));
    }
    this.pending = list;
    const isStaticFunc = this.isName('static') && this.peekAfter().text === 'func';
    if (isStaticFunc) this.i++;
    if (this.isName('func')) return [this.parseFunc(isStaticFunc)];
    const stmts = this.parseSimpleLine();
    this.pending = [];
    return stmts;
  }

  private takePending(): Annotation[] {
    const list = this.pending;
    this.pending = [];
    return list;
  }

  private parseSimple(): Stmt {
    const t = this.cur();
    const t0 = this.i;
    if (t.type === 'name') {
      const special = this.parseKeywordSimple(t, t0);
      if (special) return special;
    }
    const expr = this.parseExpr();
    const op = this.cur();
    if (op.type === 'op' && ASSIGN_OPS.has(op.text)) {
      this.i++;
      const value = this.parseExpr();
      return { k: 'assign', target: expr, op: op.text, value, line: t.line, t0, t1: this.last() };
    }
    return { k: 'expr', expr, line: t.line, t0, t1: this.last() };
  }

  private parseKeywordSimple(t: Token, t0: number): Stmt | null {
    if (SIMPLE_WORDS.has(t.text)) {
      this.i++;
      return { k: 'simple', word: t.text, line: t.line, t0, t1: t0 };
    }
    switch (t.text) {
      case 'return': {
        this.i++;
        const value = this.atLineEnd() ? null : this.parseExpr();
        return { k: 'return', value, line: t.line, t0, t1: this.last() };
      }
      case 'var':
      case 'const':
        return this.parseVar(false);
      case 'static':
        this.i++;
        return this.parseVar(true);
      case 'class_name':
        return this.parseClassName();
      case 'extends':
        return this.parseExtends();
      case 'signal':
        return this.parseSignal();
      case 'enum':
        return this.parseEnum();
      default:
        return null;
    }
  }

  private parseClassName(): Stmt {
    const t = this.next();
    const name = this.next().text;
    const stmt: Stmt = { k: 'class_name', name, line: t.line, t0: t.index, t1: this.last() };
    if (this.isName('extends')) this.pendingExtends = this.parseExtends();
    return stmt;
  }

  /** `extends` that followed `class_name` on the same line. */
  pendingExtends: Stmt | null = null;

  private parseExtends(): Stmt {
    const t = this.next();
    let name: string | null = null;
    let path: string | null = null;
    const target = this.cur();
    if (target.type === 'str') {
      path = this.next().value;
      while (this.accept('.')) this.next();
    } else if (target.type === 'name') {
      name = this.next().text;
      while (this.isOp('.')) {
        this.i++;
        name += `.${this.next().text}`;
      }
    }
    return { k: 'extends', name, path, line: t.line, t0: t.index, t1: this.last() };
  }

  private parseSignal(): Stmt {
    const t = this.next();
    const name = this.next().text;
    if (this.raw().type === 'op' && this.raw().text === '(') this.parseParams();
    return { k: 'signal', name, line: t.line, t0: t.index, t1: this.last() };
  }

  private parseEnum(): Stmt {
    const t = this.next();
    const name = this.cur().type === 'name' ? this.next().text : null;
    const members: { name: string; value: Expr | null }[] = [];
    if (this.isOp('{')) {
      this.i++;
      this.withSig(false, () => {
        while (!this.isOp('}') && this.cur().type !== 'eof') {
          const before = this.i;
          const member = this.next();
          const value = this.accept('=') ? this.parseExpr() : null;
          if (member.type === 'name') members.push({ name: member.text, value });
          this.accept(',');
          if (this.i === before) this.i++;
        }
        this.accept('}');
      });
    }
    return { k: 'enum', name, members, line: t.line, t0: t.index, t1: this.last() };
  }

  private parseVar(isStatic: boolean): VarDecl {
    const annotations = this.takePending();
    const kw = this.next();
    const t0 = isStatic ? kw.index - 1 : kw.index;
    const name = this.next().text;
    let type: TypeRef | null = null;
    let inferred = false;
    let value: Expr | null = null;
    if (this.accept(':=')) {
      inferred = true;
      value = this.parseExpr();
    } else if (this.isOp(':') && this.peekAfter().type !== 'newline') {
      this.i++;
      type = this.parseType();
      if (this.accept('=')) value = this.parseExpr();
    } else if (this.accept('=')) {
      value = this.parseExpr();
    }
    const decl: VarDecl = {
      k: 'var', name, isConst: kw.text === 'const', isStatic, type, inferred, value, annotations, accessors: [],
      line: kw.line, t0, t1: this.last(),
    };
    if (this.isOp(':')) {
      this.i++;
      decl.accessors = this.parseAccessors(kw);
      decl.t1 = this.last();
    }
    return decl;
  }

  private parseAccessors(header: Token): FuncDecl[] {
    const out: FuncDecl[] = [];
    if (this.raw().type !== 'newline') {
      while (this.cur().type === 'name' && (this.cur().text === 'get' || this.cur().text === 'set')) {
        const acc = this.parseAccessor(header);
        if (acc) out.push(acc);
        if (!this.accept(',')) break;
      }
      return out;
    }
    while (this.raw().type === 'newline') this.i++;
    const indent = this.raw().indent;
    if (indent <= header.indent) return out;
    while (this.raw().type === 'name' && this.raw().indent === indent && (this.raw().text === 'get' || this.raw().text === 'set')) {
      const acc = this.parseAccessor(this.raw());
      if (acc) out.push(acc);
      this.accept(',');
      while (this.raw().type === 'newline') this.i++;
    }
    return out;
  }

  private parseAccessor(header: Token): FuncDecl | null {
    const t = this.next();
    if (this.accept('=')) {
      this.next();
      return null;
    }
    const params = this.raw().type === 'op' && this.raw().text === '(' ? this.parseParams() : [];
    if (!this.accept(':')) return null;
    const body = this.parseSuite(header);
    return { k: 'func', name: t.text, isStatic: false, params, returnType: null, body, annotations: [], line: t.line, t0: t.index, t1: this.last(), endLine: (this.toks[this.last()] as Token).endLine };
  }

  private parseParams(): Param[] {
    const params: Param[] = [];
    this.i++;
    this.withSig(false, () => {
      while (!this.isOp(')') && this.cur().type !== 'eof') {
        const before = this.i;
        while (this.isOp('..') || this.isOp('.')) this.i++;
        const nameTok = this.next();
        let type: TypeRef | null = null;
        let inferred = false;
        let value: Expr | null = null;
        if (this.accept(':=')) {
          inferred = true;
          value = this.parseExpr();
        } else {
          if (this.accept(':')) type = this.parseType();
          if (this.accept('=')) value = this.parseExpr();
        }
        if (nameTok.type === 'name') params.push({ name: nameTok.text, type, inferred, value, line: nameTok.line });
        if (!this.accept(',') && !this.isOp(')')) this.skipUntilCloser();
        if (this.i === before) this.i++;
      }
      this.accept(')');
    });
    return params;
  }

  private skipUntilCloser(): void {
    while (this.cur().type !== 'eof' && !this.isOp(')') && !this.isOp(',')) this.i++;
  }

  private parseFunc(isStatic: boolean, fromExpr = false): FuncDecl {
    const annotations = fromExpr ? [] : this.takePending();
    const kw = this.next();
    const t0 = isStatic ? kw.index - 1 : kw.index;
    const name = this.cur().type === 'name' ? this.next().text : '';
    const params = this.isOp('(') ? this.parseParams() : [];
    const returnType = this.accept('->') ? this.parseType() : null;
    let body: Stmt[] = [];
    if (this.accept(':')) {
      body = fromExpr ? this.withSig(true, () => this.parseSuite(kw)) : this.parseSuite(kw);
    } else if (!fromExpr) {
      this.skipToLineEnd();
    }
    const end = this.toks[this.last()] as Token;
    return { k: 'func', name, isStatic, params, returnType, body, annotations, line: kw.line, t0, t1: this.last(), endLine: end.endLine };
  }

  private parseClass(): ClassDecl {
    const kw = this.next();
    const name = this.next().text;
    let extendsName: string | null = null;
    let extendsPath: string | null = null;
    if (this.isName('extends')) {
      const ext = this.parseExtends();
      if (ext.k === 'extends') {
        extendsName = ext.name;
        extendsPath = ext.path;
      }
    }
    const cls: ClassDecl = {
      k: 'class', name, extendsName, extendsPath, body: [], isTop: false,
      outer: this.classes[this.classes.length - 1] ?? null, line: kw.line, t0: kw.index, t1: kw.index,
    };
    this.classes.push(cls);
    if (this.accept(':')) cls.body = this.parseSuite(kw);
    this.classes.pop();
    cls.t1 = this.last();
    return cls;
  }

  pushTop(cls: ClassDecl): void {
    this.classes.push(cls);
  }

  private parseIf(): Stmt {
    const kw = this.next();
    const branches: { cond: Expr; body: Stmt[] }[] = [];
    let elseBody: Stmt[] = [];
    let cond = this.parseExpr();
    this.accept(':');
    branches.push({ cond, body: this.parseSuite(kw) });
    for (;;) {
      const t = this.raw();
      if (t.type !== 'name' || t.indent !== kw.indent) break;
      if (t.text === 'elif') {
        this.i++;
        cond = this.parseExpr();
        this.accept(':');
        branches.push({ cond, body: this.parseSuite(t) });
      } else if (t.text === 'else') {
        this.i++;
        this.accept(':');
        elseBody = this.parseSuite(t);
        break;
      } else {
        break;
      }
    }
    return { k: 'if', branches, elseBody, line: kw.line, t0: kw.index, t1: this.last() };
  }

  private parseFor(): Stmt {
    const kw = this.next();
    const name = this.next().text;
    const varType = this.accept(':') ? this.parseType() : null;
    this.accept('in');
    const iter = this.parseExpr();
    this.accept(':');
    const body = this.parseSuite(kw);
    return { k: 'for', name, varType, iter, body, line: kw.line, t0: kw.index, t1: this.last() };
  }

  private parseWhile(): Stmt {
    const kw = this.next();
    const cond = this.parseExpr();
    this.accept(':');
    const body = this.parseSuite(kw);
    return { k: 'while', cond, body, line: kw.line, t0: kw.index, t1: this.last() };
  }

  private parseMatch(): Stmt {
    const kw = this.next();
    const subject = this.parseExpr();
    this.accept(':');
    const branches: MatchBranch[] = [];
    if (this.raw().type === 'newline') {
      while (this.raw().type === 'newline') this.i++;
      const indent = this.raw().indent;
      while (this.raw().type !== 'eof' && this.raw().indent === indent && indent > kw.indent) {
        const before = this.i;
        branches.push(this.parseBranch());
        while (this.raw().type === 'newline') this.i++;
        if (this.i === before) this.i++;
      }
    }
    return { k: 'match', subject, branches, line: kw.line, t0: kw.index, t1: this.last() };
  }

  private parseBranch(): MatchBranch {
    const first = this.raw();
    const patterns: Token[] = [];
    let depth = 0;
    while (!endsPattern(this.raw(), depth)) {
      const t = this.raw();
      depth += depthChange(t);
      if (t.type !== 'newline') patterns.push(t);
      this.i++;
    }
    const guard = this.accept('when') ? this.parseExpr() : null;
    const body = this.accept(':') ? this.parseSuite(first) : [];
    return { patterns, guard, body, line: first.line };
  }

  // ---- types ----

  parseType(): TypeRef {
    const t = this.next();
    let name = t.text;
    while (this.isOp('.') && this.peekAfter().type === 'name') {
      this.i++;
      name += `.${this.next().text}`;
    }
    const args: TypeRef[] = [];
    if (this.isOp('[')) {
      this.i++;
      this.withSig(false, () => {
        while (!this.isOp(']') && this.cur().type !== 'eof') {
          const before = this.i;
          args.push(this.parseType());
          this.accept(',');
          if (this.i === before) this.i++;
        }
        this.accept(']');
      });
    }
    return { name, args, line: t.line };
  }

  // ---- expressions ----

  parseExpr(minPrec = 0): Expr {
    let left = this.parsePrefix();
    for (;;) {
      const prec = this.infixPrec();
      if (prec <= minPrec) return left;
      left = this.parseInfix(left, prec);
    }
  }

  private infixPrec(): number {
    const t = this.cur();
    if (t.type === 'op') {
      if (t.text === '.' || t.text === '(' || t.text === '[') return POSTFIX_PREC;
      return BINARY_PREC[t.text] ?? 0;
    }
    if (t.type !== 'name') return 0;
    if (t.text === 'not') return this.peekAfter().text === 'in' ? NAME_PREC.in ?? 0 : 0;
    return NAME_PREC[t.text] ?? 0;
  }

  private parseInfix(left: Expr, prec: number): Expr {
    const t = this.next();
    const t0 = left.t0;
    if (t.type === 'op') {
      if (t.text === '.') return this.node('member', t0, { obj: left, name: this.next().text });
      if (t.text === '(') {
        this.i--;
        const args = this.parseArgs();
        return this.node('call', t0, { callee: left, args });
      }
      if (t.text === '[') {
        const index = this.withSig(false, () => {
          const e = this.parseExpr();
          this.accept(']');
          return e;
        });
        return this.node('index', t0, { obj: left, index });
      }
      const right = this.parseExpr(prec);
      return this.node('binary', t0, { op: t.text, left, right });
    }
    return this.parseNameInfix(left, t, prec);
  }

  private parseNameInfix(left: Expr, t: Token, prec: number): Expr {
    const t0 = left.t0;
    switch (t.text) {
      case 'is': {
        this.accept('not');
        return this.node('is', t0, { expr: left, type: this.parseType() });
      }
      case 'as':
        return this.node('cast', t0, { expr: left, type: this.parseType() });
      case 'if': {
        const cond = this.parseExpr(prec);
        this.accept('else');
        const otherwise = this.parseExpr(prec - 1);
        return this.node('ternary', t0, { cond, then: left, else: otherwise });
      }
      case 'not': {
        this.accept('in');
        return this.node('binary', t0, { op: 'not in', left, right: this.parseExpr(prec) });
      }
      default:
        return this.node('binary', t0, { op: t.text, left, right: this.parseExpr(prec) });
    }
  }

  private parseArgs(): Expr[] {
    const args: Expr[] = [];
    this.i++;
    this.withSig(false, () => {
      while (!this.isOp(')') && this.cur().type !== 'eof') {
        const before = this.i;
        args.push(this.parseExpr());
        if (!this.accept(',') && !this.isOp(')')) this.skipUntilCloser();
        if (this.i === before) this.i++;
      }
      this.accept(')');
    });
    return args;
  }

  private parsePrefix(): Expr {
    const t = this.cur();
    const t0 = this.i;
    switch (t.type) {
      case 'num':
        this.i++;
        return this.node('num', t0, { text: t.text });
      case 'str':
        this.i++;
        return this.node('str', t0, { value: t.value, kind: t.kind });
      case 'nodepath':
        this.i++;
        return this.node('nodepath', t0, { sigil: t.kind, path: t.value });
      case 'name':
        return this.parseNamePrefix(t, t0);
      case 'op':
        return this.parseOpPrefix(t, t0);
      default:
        return { k: 'error', line: t.line, t0, t1: t0 };
    }
  }

  private parseNamePrefix(t: Token, t0: number): Expr {
    switch (t.text) {
      case 'not':
        this.i++;
        return this.node('unary', t0, { op: 'not', expr: this.parseExpr(5) });
      case 'await':
        this.i++;
        return this.node('await', t0, { expr: this.parseExpr(18) });
      case 'func':
        return this.node('lambda', t0, { fn: this.parseFunc(false, true) });
      default:
        this.i++;
        return this.node('name', t0, { name: t.text });
    }
  }

  private parseOpPrefix(t: Token, t0: number): Expr {
    switch (t.text) {
      case '(': {
        this.i++;
        return this.withSig(false, () => {
          const e = this.parseExpr();
          this.accept(')');
          return e;
        });
      }
      case '[':
        return this.parseArray(t0);
      case '{':
        return this.parseDict(t0);
      case '-':
      case '+':
        this.i++;
        return this.node('unary', t0, { op: t.text, expr: this.parseExpr(14) });
      case '~':
        this.i++;
        return this.node('unary', t0, { op: '~', expr: this.parseExpr(15) });
      case '!':
        this.i++;
        return this.node('unary', t0, { op: 'not', expr: this.parseExpr(5) });
      default:
        if (!CLOSERS.has(t.text) && t.text !== ',' && t.text !== ':' && !ASSIGN_OPS.has(t.text)) this.i++;
        return { k: 'error', line: t.line, t0, t1: this.last() };
    }
  }

  private parseArray(t0: number): Expr {
    this.i++;
    const items: Expr[] = [];
    this.withSig(false, () => {
      while (!this.isOp(']') && this.cur().type !== 'eof') {
        const before = this.i;
        items.push(this.parseExpr());
        this.accept(',');
        if (this.i === before) this.i++;
      }
      this.accept(']');
    });
    return this.node('array', t0, { items });
  }

  private parseDict(t0: number): Expr {
    this.i++;
    const entries: { key: Expr; value: Expr }[] = [];
    this.withSig(false, () => {
      while (!this.isOp('}') && this.cur().type !== 'eof') {
        const before = this.i;
        const key = this.parseExpr();
        const value = this.accept(':') || this.accept('=') ? this.parseExpr() : key;
        entries.push({ key, value });
        this.accept(',');
        if (this.i === before) this.i++;
      }
      this.accept('}');
    });
    return this.node('dict', t0, { entries });
  }
}

/** Parses GDScript source. */
export function parseGd(path: string, source: string): GdFile {
  const { tokens, comments } = lexGd(source);
  const parser = new Parser(tokens);
  const top: ClassDecl = { k: 'class', name: null, extendsName: null, extendsPath: null, body: [], isTop: true, outer: null, line: 1, t0: 0, t1: Math.max(0, tokens.length - 1) };
  parser.pushTop(top);
  const body = parser.parseFile();
  top.body = body;
  for (const stmt of body) {
    if (stmt.k === 'class_name' && top.name === null) top.name = stmt.name;
    if (stmt.k === 'extends') {
      top.extendsName = stmt.name;
      top.extendsPath = stmt.path;
    }
  }
  const pending = parser.pendingExtends;
  if (pending?.k === 'extends' && top.extendsName === null && top.extendsPath === null) {
    top.extendsName = pending.name;
    top.extendsPath = pending.path;
  }
  return { path, source, tokens, comments, top };
}

/** Parses one GDScript expression (for tests and for values read from other files). */
export function parseGdExpr(source: string): Expr {
  const { tokens } = lexGd(source);
  return new Parser(tokens).parseExpr();
}
