/**
 * GDScript tokenizer for the static checks: identifiers, numbers, strings, node paths,
 * operators, comments and line structure. It never throws; unknown characters become `op` tokens.
 */

interface Start {
  line: number;
  col: number;
  indent: number;
}

export type TokenType = 'name' | 'num' | 'str' | 'nodepath' | 'op' | 'newline' | 'eof';

export interface Token {
  type: TokenType;
  /** Source text of the token (for `str`, the raw text with quotes). */
  text: string;
  /** For `str`: the decoded value. For `nodepath`: the path after `$` or `%`. */
  value: string;
  /** For `str`: `string`, `stringname` (`&"..."`) or `nodepath` (`^"..."`). For `nodepath`: `$` or `%`. */
  kind: string;
  /** 1-based line of the first character. */
  line: number;
  /** 1-based line of the last character. */
  endLine: number;
  /** 0-based column. */
  col: number;
  /** Indentation width of the physical line the token starts on (tab = 4). */
  indent: number;
  /** Index in the token list. */
  index: number;
}

export interface Comment {
  line: number;
  /** Text after `#`, without the trailing line break. */
  text: string;
  /** True when code precedes the comment on its line. */
  trailing: boolean;
}

export interface LexResult {
  tokens: Token[];
  comments: Comment[];
}

const OPERATORS = [
  '**=', '<<=', '>>=', ':=', '->', '**', '<<', '>>', '==', '!=', '<=', '>=', '&&', '||',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '..',
];

const KEYWORDS_BEFORE_OPERAND = new Set([
  'return', 'and', 'or', 'not', 'in', 'if', 'elif', 'else', 'while', 'for', 'match', 'when', 'await', 'is', 'as',
]);

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_\u0080-￿]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_\u0080-￿]/.test(ch);
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', "'": "'", '\\': '\\', a: '\u0007', b: '\b', f: '\f', v: '\v' };

function decodeEscapes(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{6}|.)/g, (_m, esc: string) => {
    if (esc.length > 1) return String.fromCodePoint(parseInt(esc.slice(1), 16));
    return ESCAPES[esc] ?? esc;
  });
}

class Lexer {
  private readonly src: string;
  private pos = 0;
  private line = 1;
  private lineStart = 0;
  private lineIndent = 0;
  private lineHasCode = false;
  readonly tokens: Token[] = [];
  readonly comments: Comment[] = [];

  constructor(src: string) {
    this.src = src;
    this.lineIndent = this.measureIndent(0);
  }

  private measureIndent(from: number): number {
    let width = 0;
    for (let i = from; i < this.src.length; i++) {
      const ch = this.src[i];
      if (ch === ' ') width += 1;
      else if (ch === '\t') width += 4;
      else break;
    }
    return width;
  }

  private newLine(at: number): void {
    this.line += 1;
    this.lineStart = at;
    this.lineIndent = this.measureIndent(at);
    this.lineHasCode = false;
  }

  private push(type: TokenType, text: string, value: string, kind: string, startLine: number, col: number, indent: number): void {
    this.tokens.push({ type, text, value, kind, line: startLine, endLine: this.line, col, indent, index: this.tokens.length });
    this.lineHasCode = true;
  }

  private last(): Token | undefined {
    return this.tokens[this.tokens.length - 1];
  }

  /** True when the previous token ends an operand, so `%` is the modulo operator. */
  private afterOperand(): boolean {
    const prev = this.last();
    if (!prev || prev.line !== this.line) return false;
    if (prev.type === 'num' || prev.type === 'str' || prev.type === 'nodepath') return true;
    if (prev.type === 'name') return !KEYWORDS_BEFORE_OPERAND.has(prev.text);
    return prev.text === ')' || prev.text === ']' || prev.text === '}';
  }

  run(): LexResult {
    while (this.pos < this.src.length) this.step();
    return { tokens: this.tokens, comments: this.comments };
  }

  private step(): void {
    const ch = this.src[this.pos] as string;
    if (ch === '\n') {
      this.pos += 1;
      this.newLine(this.pos);
      return;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      this.pos += 1;
      return;
    }
    if (ch === '\\' && /^\\\r?\n/.test(this.src.slice(this.pos, this.pos + 3))) {
      const keepIndent = this.lineIndent;
      const keepCode = this.lineHasCode;
      this.pos += this.src[this.pos + 1] === '\r' ? 3 : 2;
      this.newLine(this.pos);
      this.lineIndent = keepIndent;
      this.lineHasCode = keepCode;
      this.continued.add(this.line);
      return;
    }
    if (ch === '#') {
      this.comment();
      return;
    }
    this.token(ch);
  }

  /** Lines that continue the previous line with a backslash. */
  readonly continued = new Set<number>();

  private comment(): void {
    let end = this.src.indexOf('\n', this.pos);
    if (end === -1) end = this.src.length;
    const text = this.src.slice(this.pos + 1, end).replace(/\r$/, '');
    this.comments.push({ line: this.line, text, trailing: this.lineHasCode });
    this.pos = end;
  }

  private token(ch: string): void {
    const at: Start = { line: this.line, col: this.pos - this.lineStart, indent: this.lineIndent };
    const next = this.src[this.pos + 1] ?? '';
    const quoted = next === '"' || next === "'";
    if ('&^r'.includes(ch) && quoted) this.string(this.pos + 1, ch, at);
    else if (ch === '"' || ch === "'") this.string(this.pos, '', at);
    else if (this.startsNumber(ch, next)) this.number(at.line, at.col, at.indent);
    else if (isIdentStart(ch)) this.ident(at);
    else if (this.startsNodePath(ch, next, quoted)) this.nodePath(ch, at.line, at.col, at.indent);
    else this.op(ch, at);
  }

  private startsNumber(ch: string, next: string): boolean {
    return /[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next) && !this.afterOperand());
  }

  /** `$` always starts a node path; `%` does when it is not the modulo operator. */
  private startsNodePath(ch: string, next: string, quoted: boolean): boolean {
    if (ch === '$') return true;
    return ch === '%' && !this.afterOperand() && (isIdentStart(next) || quoted);
  }

  private ident(at: Start): void {
    let end = this.pos + 1;
    while (end < this.src.length && isIdentPart(this.src[end] as string)) end++;
    const text = this.src.slice(this.pos, end);
    this.pos = end;
    this.push('name', text, text, '', at.line, at.col, at.indent);
  }

  private op(ch: string, at: Start): void {
    const op = OPERATORS.find((candidate) => this.src.startsWith(candidate, this.pos)) ?? ch;
    this.pos += op.length;
    this.push('op', op, op, '', at.line, at.col, at.indent);
  }

  /** End of a string body: the index of the closing quote, or of the line break / end that cut it. */
  private stringEnd(from: number, open: string, raw: boolean): { bodyEnd: number; closed: boolean } {
    const triple = open.length === 3;
    let i = from;
    while (i < this.src.length) {
      const c = this.src[i] as string;
      if (c === '\\' && !raw) {
        if (this.src[i + 1] === '\n') this.newLine(i + 2);
        i += 2;
        continue;
      }
      if (this.src.startsWith(open, i)) return { bodyEnd: i, closed: true };
      if (c === '\n') {
        if (!triple) return { bodyEnd: i, closed: false };
        this.newLine(i + 1);
      }
      i += 1;
    }
    return { bodyEnd: this.src.length, closed: false };
  }

  private string(quoteAt: number, prefix: string, at: Start): void {
    const quote = this.src[quoteAt] as string;
    const open = this.src.startsWith(quote.repeat(3), quoteAt) ? quote.repeat(3) : quote;
    const bodyStart = quoteAt + open.length;
    const { bodyEnd, closed } = this.stringEnd(bodyStart, open, prefix === 'r');
    const end = closed ? bodyEnd + open.length : Math.min(bodyEnd, this.src.length);
    const raw = this.src.slice(bodyStart, bodyEnd);
    const text = this.src.slice(this.pos, end);
    this.pos = end;
    const kind = prefix === '&' ? 'stringname' : prefix === '^' ? 'nodepath' : 'string';
    this.push('str', text, prefix === 'r' ? raw : decodeEscapes(raw), kind, at.line, at.col, at.indent);
  }

  private number(startLine: number, col: number, indent: number): void {
    const rest = this.src.slice(this.pos);
    const match = /^(0x[0-9a-fA-F_]+|0b[01_]+|(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?(?:[eE][+-]?[0-9_]+)?)/.exec(rest);
    let text = match?.[0] ?? '';
    if (text === '' || text === '.') text = rest[0] ?? '';
    // `1.foo()` is not valid GDScript, but keep `x.0` out of numbers: a trailing `.` before a letter is not part of the number.
    if (/\.$/.test(text) && isIdentStart(rest[text.length] ?? '')) text = text.slice(0, -1);
    this.pos += text.length;
    this.push('num', text, text, '', startLine, col, indent);
  }

  private nodePath(sigil: string, startLine: number, col: number, indent: number): void {
    let i = this.pos + 1;
    let path: string;
    const quote = this.src[i];
    if (quote === '"' || quote === "'") {
      const close = this.src.indexOf(quote, i + 1);
      const end = close === -1 ? this.src.length : close + 1;
      path = this.src.slice(i + 1, close === -1 ? end : close);
      i = end;
    } else {
      let end = i;
      while (end < this.src.length && /[A-Za-z0-9_/%\u0080-￿]/.test(this.src[end] as string)) end++;
      path = this.src.slice(i, end);
      i = end;
    }
    const text = this.src.slice(this.pos, i);
    this.pos = i;
    this.push('nodepath', text, path, sigil, startLine, col, indent);
  }
}

/**
 * Tokenizes GDScript. A `newline` token follows the last token of every logical line;
 * its `indent` is the indentation of the next code line.
 */
export function lexGd(src: string): LexResult {
  const lexer = new Lexer(src);
  const { tokens, comments } = lexer.run();
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token;
    out.push({ ...token, index: out.length });
    const next = tokens[i + 1];
    if (next && next.line > token.endLine && !lexer.continued.has(next.line)) {
      out.push({ type: 'newline', text: '\n', value: '', kind: '', line: token.endLine, endLine: token.endLine, col: -1, indent: next.indent, index: out.length });
    }
  }
  const lastLine = tokens[tokens.length - 1]?.endLine ?? 1;
  out.push({ type: 'newline', text: '\n', value: '', kind: '', line: lastLine, endLine: lastLine, col: -1, indent: 0, index: out.length });
  out.push({ type: 'eof', text: '', value: '', kind: '', line: lastLine, endLine: lastLine, col: -1, indent: 0, index: out.length });
  return { tokens: out, comments };
}

/** Numeric value of a GDScript number token. */
export function numberValue(text: string): number {
  const clean = text.replace(/_/g, '');
  if (/^0x/i.test(clean)) return parseInt(clean.slice(2), 16);
  if (/^0b/i.test(clean)) return parseInt(clean.slice(2), 2);
  return Number(clean);
}

/** True when a number token is a real (float) literal. */
export function isRealLiteral(text: string): boolean {
  return !/^0[xb]/i.test(text) && /[.eE]/.test(text);
}
