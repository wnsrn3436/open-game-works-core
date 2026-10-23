/** JSON parsing that keeps the 1-based line of every value, keyed by JSON pointer (`/steps/0/until`). */
export interface JsonWithLines {
  value: unknown;
  lines: Map<string, number>;
}

export class JsonPosError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

class JsonReader {
  private readonly src: string;
  private pos = 0;
  private line = 1;
  readonly lines = new Map<string, number>();

  constructor(src: string) {
    this.src = src;
  }

  private fail(message: string): never {
    throw new JsonPosError(message, this.line);
  }

  private ws(): void {
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === '\n') this.line++;
      else if (ch !== ' ' && ch !== '\t' && ch !== '\r') return;
      this.pos++;
    }
  }

  readTop(): unknown {
    const value = this.value('');
    this.ws();
    if (this.pos < this.src.length) this.fail('extra text after the JSON value');
    return value;
  }

  private value(pointer: string): unknown {
    this.ws();
    this.lines.set(pointer, this.line);
    const ch = this.src[this.pos];
    if (ch === '{') return this.object(pointer);
    if (ch === '[') return this.array(pointer);
    if (ch === '"') return this.string();
    const literal = /^(true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(this.src.slice(this.pos));
    if (!literal) this.fail('invalid JSON value');
    this.pos += literal[0].length;
    return JSON.parse(literal[0]) as unknown;
  }

  private object(pointer: string): Record<string, unknown> {
    this.pos++;
    const out: Record<string, unknown> = {};
    this.ws();
    if (this.src[this.pos] === '}') {
      this.pos++;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.src[this.pos] !== '"') this.fail('expected a string key');
      const key = this.string();
      this.ws();
      if (this.src[this.pos] !== ':') this.fail('expected `:`');
      this.pos++;
      // an own property for every key, `__proto__` included (an assignment would set the prototype), as `JSON.parse` does
      Object.defineProperty(out, key, { value: this.value(`${pointer}/${escapePointer(key)}`), enumerable: true, writable: true, configurable: true });
      this.ws();
      const sep = this.src[this.pos++];
      if (sep === '}') return out;
      if (sep !== ',') this.fail('expected `,` or `}`');
    }
  }

  private array(pointer: string): unknown[] {
    this.pos++;
    const out: unknown[] = [];
    this.ws();
    if (this.src[this.pos] === ']') {
      this.pos++;
      return out;
    }
    for (;;) {
      out.push(this.value(`${pointer}/${String(out.length)}`));
      this.ws();
      const sep = this.src[this.pos++];
      if (sep === ']') return out;
      if (sep !== ',') this.fail('expected `,` or `]`');
    }
  }

  private string(): string {
    const match = /^"(?:[^"\\\n\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(this.src.slice(this.pos));
    if (!match) this.fail('invalid string');
    this.pos += match[0].length;
    return JSON.parse(match[0]) as string;
  }
}

/** Parses JSON text. Throws `JsonPosError` with the line of the problem. */
export function parseJsonWithLines(text: string): JsonWithLines {
  const reader = new JsonReader(text.startsWith('﻿') ? text.slice(1) : text);
  const value = reader.readTop();
  return { value, lines: reader.lines };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
