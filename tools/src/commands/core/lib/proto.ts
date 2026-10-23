import { OgwError } from '../../../lib/errors.ts';

/** The part of a `.proto` file the base proto check reads. */
export interface ProtoField {
  name: string;
  /** Label and type as written, for example `repeated ItemAmount` or `map<string,int64>`. */
  type: string;
  number: number;
  /** `(ogw.v)` entries: name to canonical value (decimal integer, JSON string, `true`, `false`). */
  v: Map<string, string>;
}

export interface ProtoMessage {
  name: string;
  fields: ProtoField[];
}

export interface ProtoRpc {
  name: string;
  /** Names of `(ogw.<option>) = true` rpc options. */
  options: string[];
  /** Lines of the comment right before the `rpc`, without `//`. */
  comment: string[];
}

export interface ProtoFile {
  /** Messages in declaration order (nested ones as `Outer.Inner`). */
  messages: ProtoMessage[];
  enums: Map<string, { name: string; number: number }[]>;
  services: Map<string, ProtoRpc[]>;
}

interface Token {
  kind: 'word' | 'string' | 'symbol' | 'comment';
  text: string;
}

const TOKEN = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|-?[A-Za-z0-9_.]+|[{}()[\]<>=;,:]/gy;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const start = TOKEN.lastIndex;
    const match = TOKEN.exec(text);
    if (!match) throw new OgwError(`cannot read proto near: ${text.slice(start, start + 20)}`);
    const value = match[0];
    if (/^\s+$/.test(value)) continue;
    if (value.startsWith('//')) tokens.push({ kind: 'comment', text: value.slice(2).trim() });
    else if (value.startsWith('/*')) tokens.push({ kind: 'comment', text: value.slice(2, -2).trim() });
    else if (value.startsWith('"') || value.startsWith("'")) tokens.push({ kind: 'string', text: value });
    else if (/^[{}()[\]<>=;,:]$/.test(value)) tokens.push({ kind: 'symbol', text: value });
    else tokens.push({ kind: 'word', text: value });
  }
  return tokens;
}

/** Canonical form of a proto constant: integers as decimal, strings as JSON, identifiers as written. */
export function canonicalConstant(token: Token): string {
  if (token.kind === 'string') return JSON.stringify(JSON.parse(token.text.startsWith("'") ? `"${token.text.slice(1, -1)}"` : token.text) as string);
  if (/^-?\d+$/.test(token.text)) return BigInt(token.text).toString();
  if (/^-?0x[0-9a-f]+$/i.test(token.text)) {
    const negative = token.text.startsWith('-');
    const value = BigInt(negative ? token.text.slice(1) : token.text);
    return (negative ? -value : value).toString();
  }
  return token.text;
}

class Parser {
  private i = 0;
  private comments: string[] = [];
  private readonly tokens: Token[];
  readonly file: ProtoFile = { messages: [], enums: new Map(), services: new Map() };

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    while (this.tokens[this.i]?.kind === 'comment') this.comments.push((this.tokens[this.i++] as Token).text);
    return this.tokens[this.i];
  }

  private next(): Token {
    const token = this.peek();
    if (!token) throw new OgwError('unexpected end of proto');
    this.i++;
    return token;
  }

  private takeComments(): string[] {
    const taken = this.comments.flatMap((c) => c.split('\n').map((line) => line.replace(/^\s*\*?\s?/, '').trimEnd()));
    this.comments = [];
    return taken.filter((line) => line !== '');
  }

  private expect(text: string): void {
    const token = this.next();
    if (token.text !== text) throw new OgwError(`proto: expected ${text}, found ${token.text}`);
  }

  private skipStatement(): void {
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token.text === '{') depth++;
      else if (token.text === '}') {
        depth--;
        if (depth === 0) return;
      } else if (token.text === ';' && depth === 0) return;
    }
  }

  parse(): ProtoFile {
    while (this.peek()) {
      const word = this.peek()?.text;
      this.comments = [];
      if (word === 'message') this.message('');
      else if (word === 'enum') this.enumBlock('');
      else if (word === 'service') this.service();
      else this.skipStatement();
    }
    return this.file;
  }

  private message(prefix: string): void {
    this.expect('message');
    const name = `${prefix}${this.next().text}`;
    const message: ProtoMessage = { name, fields: [] };
    this.file.messages.push(message);
    this.expect('{');
    this.messageBody(message, `${name}.`);
  }

  private messageBody(message: ProtoMessage, prefix: string): void {
    for (;;) {
      const word = this.peek()?.text;
      if (word === '}') {
        this.next();
        return;
      }
      if (word === 'message') this.message(prefix);
      else if (word === 'enum') this.enumBlock(prefix);
      else if (word === 'oneof') {
        this.next();
        this.next();
        this.expect('{');
        this.messageBody(message, prefix);
      } else if (word === 'option' || word === 'reserved' || word === 'extensions' || word === 'extend' || word === ';') this.skipStatement();
      else message.fields.push(this.field());
    }
  }

  private field(): ProtoField {
    let type = this.next().text;
    if (type === 'repeated' || type === 'optional' || type === 'required') type = `${type} ${this.next().text}`;
    if (type === 'map' || type.endsWith(' map')) {
      this.expect('<');
      const key = this.next().text;
      this.expect(',');
      const value = this.next().text;
      this.expect('>');
      type = `${type}<${key},${value}>`;
    }
    const name = this.next().text;
    this.expect('=');
    const number = Number(this.next().text);
    const v = new Map<string, string>();
    if (this.peek()?.text === '[') {
      this.next();
      this.fieldOptions(v);
    }
    this.expect(';');
    return { name, type, number, v };
  }

  private optionName(): string {
    let name = '';
    for (;;) {
      const token = this.next();
      if (token.text === '=') return name;
      name += token.text;
    }
  }

  private fieldOptions(v: Map<string, string>): void {
    for (;;) {
      const name = this.optionName();
      if (name === '(ogw.v)') {
        if (this.peek()?.text === '{') {
          this.next();
          this.aggregate(v);
        } else this.next();
      } else if (name.startsWith('(ogw.v).')) {
        v.set(name.slice('(ogw.v).'.length), canonicalConstant(this.next()));
      } else if (this.next().text === '{') {
        this.aggregate(new Map());
      }
      const end = this.next().text;
      if (end === ']') return;
      if (end !== ',') throw new OgwError(`proto: expected , or ] in field options, found ${end}`);
    }
  }

  private aggregate(into: Map<string, string>): void {
    for (;;) {
      const key = this.next();
      if (key.text === '}') return;
      if (key.text === ',' || key.text === ';') continue;
      if (this.peek()?.text === ':') this.next();
      const value = this.next();
      if (value.text === '{') this.aggregate(new Map());
      else into.set(key.text, canonicalConstant(value));
    }
  }

  private enumBlock(prefix: string): void {
    this.expect('enum');
    const name = `${prefix}${this.next().text}`;
    const values: { name: string; number: number }[] = [];
    this.expect('{');
    for (;;) {
      const word = this.peek()?.text;
      if (word === '}') {
        this.next();
        break;
      }
      if (word === 'option' || word === 'reserved' || word === ';') {
        this.skipStatement();
        continue;
      }
      const value = this.next().text;
      this.expect('=');
      const number = Number(this.next().text);
      if (this.peek()?.text === '[') while (this.next().text !== ']');
      this.expect(';');
      values.push({ name: value, number });
    }
    this.file.enums.set(name, values);
  }

  private service(): void {
    this.expect('service');
    const name = this.next().text;
    const rpcs: ProtoRpc[] = [];
    this.expect('{');
    this.comments = [];
    for (;;) {
      const word = this.peek()?.text;
      if (word === '}') {
        this.next();
        break;
      }
      if (word === 'rpc') rpcs.push(this.rpc());
      else {
        this.skipStatement();
        this.comments = [];
      }
    }
    this.file.services.set(name, rpcs);
  }

  private rpc(): ProtoRpc {
    const comment = this.takeComments();
    this.expect('rpc');
    const name = this.next().text;
    while (this.next().text !== 'returns');
    this.expect('(');
    while (this.next().text !== ')');
    const options: string[] = [];
    const after = this.next().text;
    this.comments = [];
    if (after === '{') {
      for (;;) {
        const token = this.next();
        if (token.text === '}') break;
        if (token.text !== 'option') continue;
        const option = this.optionName();
        const value = canonicalConstant(this.next());
        this.expect(';');
        const match = /^\(ogw\.([a-z_]+)\)$/.exec(option);
        if (match && value === 'true') options.push(match[1] as string);
      }
      this.comments = [];
      if (this.peek()?.text === ';') this.next();
    }
    return { name, options: options.sort(), comment };
  }
}

export function parseProto(text: string): ProtoFile {
  return new Parser(tokenize(text)).parse();
}
