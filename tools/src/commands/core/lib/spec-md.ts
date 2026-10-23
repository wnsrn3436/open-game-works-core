// Markdown reading shared by `ogw core spec` and `ogw docs check`.

export interface MdLine {
  /** 1-based line number. */
  n: number;
  text: string;
  /** Inside a code fence (the fence lines included). */
  fenced: boolean;
}

/** Splits a markdown file into lines and marks code fences: lines between lines whose text without leading spaces starts with three backticks. */
export function mdLines(text: string): MdLine[] {
  const raw = text.split('\n');
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  let inFence = false;
  return raw.map((line, i) => {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    const isFence = text.trimStart().startsWith('```');
    const fenced = inFence || isFence;
    if (isFence) inFence = !inFence;
    return { n: i + 1, text, fenced };
  });
}

export interface CodeSpan {
  text: string;
  start: number;
  /** Index after the closing backticks. */
  end: number;
}

function backtickRun(text: string, at: number): number {
  let end = at;
  while (text[end] === '`') end++;
  return end - at;
}

/** The code span that starts at `at`, or null. */
export function codeSpanAt(text: string, at: number): CodeSpan | null {
  if (text[at] !== '`') return null;
  const size = backtickRun(text, at);
  let i = at + size;
  while (i < text.length) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    const run = backtickRun(text, i);
    if (run === size) {
      let inner = text.slice(at + size, i);
      if (inner.length > 1 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '') inner = inner.slice(1, -1);
      return { text: inner, start: at, end: i + run };
    }
    i += run;
  }
  return null;
}

/** Every code span of a line, in order. Backslash escapes outside code spans are skipped. */
export function codeSpans(text: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch !== '`') {
      i++;
      continue;
    }
    const span = codeSpanAt(text, i);
    if (span) {
      spans.push(span);
      i = span.end;
    } else {
      i += backtickRun(text, i);
    }
  }
  return spans;
}

/** The text with code spans replaced by one space each. */
export function withoutCodeSpans(text: string): string {
  let out = '';
  let at = 0;
  for (const span of codeSpans(text)) {
    out += `${text.slice(at, span.start)} `;
    at = span.end;
  }
  return out + text.slice(at);
}

/** The code span text when the whole (trimmed) text is one code span, else null. */
export function soleCodeSpan(text: string): string | null {
  const trimmed = text.trim();
  const span = codeSpanAt(trimmed, 0);
  return span && span.end === trimmed.length ? span.text : null;
}

/** The code span text when the text is one code span, else the trimmed text. */
export function cellValue(text: string): string {
  return soleCodeSpan(text) ?? text.trim();
}

export function isTableLine(text: string): boolean {
  return text.trimStart().startsWith('|');
}

/** A separator line: only `|`, `-`, `:` and spaces, with at least one `-`. */
export function isSeparatorLine(text: string): boolean {
  return /^[|\-: ]+$/.test(text.trim()) && text.includes('-') && isTableLine(text);
}

/** Cells of a table line, split at unescaped `|`; `\|` becomes `|`. */
export function splitCells(text: string): string[] {
  let body = text.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch === '\\' && body[i + 1] === '|') {
      current += '|';
      i++;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

export interface MdTableRow {
  n: number;
  cells: string[];
}

export interface MdTable {
  /** Line number of the header line. */
  n: number;
  header: string[];
  rows: MdTableRow[];
  /** Index (into the line array) after the last row. */
  endIndex: number;
}

/** The table whose header is at `index` (the next line is a separator line), or null. */
export function tableAt(lines: readonly MdLine[], index: number): MdTable | null {
  const head = lines[index];
  const sep = lines[index + 1];
  if (!head || !sep || head.fenced || !isTableLine(head.text) || !isSeparatorLine(sep.text)) return null;
  const rows: MdTableRow[] = [];
  let i = index + 2;
  for (; i < lines.length; i++) {
    const line = lines[i] as MdLine;
    if (line.fenced || !isTableLine(line.text)) break;
    rows.push({ n: line.n, cells: splitCells(line.text) });
  }
  return { n: head.n, header: splitCells(head.text), rows, endIndex: i };
}

/** The table that comes right after line `index`, with only blank lines between, or null. */
export function tableAfter(lines: readonly MdLine[], index: number, end = lines.length): MdTable | null {
  let i = index + 1;
  while (i < end && (lines[i] as MdLine).text.trim() === '') i++;
  if (i >= end) return null;
  return tableAt(lines, i);
}

export interface MdSection {
  /** Heading text without the `#` marks. */
  title: string;
  /** Index of the heading line. */
  start: number;
  /** Index after the last line of the section. */
  end: number;
}

/** Heading level (1-6) of a line outside code fences, or 0. */
export function headingLevel(line: MdLine): number {
  if (line.fenced) return 0;
  const match = /^(#{1,6}) /.exec(line.text);
  return match ? (match[1] as string).length : 0;
}

/** Sections of one heading level. A section ends at the next heading of that level or a higher one. */
export function sections(lines: readonly MdLine[], level: number): MdSection[] {
  const out: MdSection[] = [];
  let current: MdSection | null = null;
  lines.forEach((line, i) => {
    const l = headingLevel(line);
    if (l === 0 || l > level) return;
    if (current) current.end = i;
    current = null;
    if (l === level) {
      current = { title: line.text.slice(level + 1).trim(), start: i, end: lines.length };
      out.push(current);
    }
  });
  return out;
}

export function section(lines: readonly MdLine[], level: number, title: string): MdSection | null {
  return sections(lines, level).find((s) => s.title === title) ?? null;
}

export interface SpanListItem {
  text: string;
  /** Table of a `` → row of `<table>` `` suffix. */
  rowOf: string | null;
}

export interface SpanList {
  items: SpanListItem[];
  /** Text after the `. ` that ends the list, or null when the list ends the line. */
  rest: string | null;
}

export interface SpanListOptions {
  /** Each code span may be followed by a `(...)` comment. */
  comments?: boolean;
  /** Each code span may be followed by `` → row of `<table>` ``. */
  arrows?: boolean;
}

function closingParen(text: string, at: number): number {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

const ARROW = '→ ';
const ROW_PREFIX = 'row of ';

/** `` → row of `<table>` `` starting at `at`: the table and the index after it. */
export function arrowTargetAt(text: string, at: number): { table: string; end: number } | null {
  if (!text.startsWith(ARROW, at)) return null;
  const after = at + ARROW.length;
  if (!text.startsWith(ROW_PREFIX, after)) return null;
  const span = codeSpanAt(text, after + ROW_PREFIX.length);
  return span ? { table: span.text, end: span.end } : null;
}

/** `` → row of `<table>` `` after a space at `at` (the list line form). */
function arrowAt(text: string, at: number): { table: string; end: number } | null {
  return text[at] === ' ' ? arrowTargetAt(text, at + 1) : null;
}

/**
 * A list of code spans joined by `, ` that starts at the beginning of `text` and ends at the end
 * of the text or at `. `. Null when the text is not such a list.
 */
export function parseSpanList(text: string, options: SpanListOptions = {}): SpanList | null {
  const items: SpanListItem[] = [];
  let pos = 0;
  for (;;) {
    const span = codeSpanAt(text, pos);
    if (!span) return null;
    pos = span.end;
    if (options.comments && text[pos] === '(') {
      pos = closingParen(text, pos);
      if (pos < 0) return null;
    }
    let rowOf: string | null = null;
    const arrow = options.arrows ? arrowAt(text, pos) : null;
    if (arrow) {
      rowOf = arrow.table;
      pos = arrow.end;
    }
    items.push({ text: span.text, rowOf });
    if (pos === text.length) return { items, rest: null };
    if (text.startsWith('. ', pos)) return { items, rest: text.slice(pos + 2) };
    if (!text.startsWith(', ', pos)) return null;
    pos += 2;
  }
}

/** Markdown link targets `[text](target)` of a line outside code spans. */
export function linkTargets(text: string): string[] {
  const plain = withoutCodeSpans(text);
  const targets: string[] = [];
  const re = /\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/g;
  for (let m = re.exec(plain); m; m = re.exec(plain)) targets.push(m[1] as string);
  return targets;
}
