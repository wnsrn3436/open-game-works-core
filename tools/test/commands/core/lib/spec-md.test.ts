import { describe, expect, it } from 'vitest';
import {
  arrowTargetAt,
  cellValue,
  codeSpanAt,
  codeSpans,
  headingLevel,
  isSeparatorLine,
  isTableLine,
  linkTargets,
  mdLines,
  parseSpanList,
  section,
  sections,
  soleCodeSpan,
  splitCells,
  tableAfter,
  tableAt,
  withoutCodeSpans,
} from '../../../../src/commands/core/lib/spec-md.ts';

describe('mdLines', () => {
  it('numbers lines from 1 and marks code fences with their fence lines', () => {
    const lines = mdLines('a\n```\nb\n  ```\nc\n');
    expect(lines.map((l) => [l.n, l.text, l.fenced])).toEqual([
      [1, 'a', false],
      [2, '```', true],
      [3, 'b', true],
      [4, '  ```', true],
      [5, 'c', false],
    ]);
  });

  it('drops a carriage return and keeps a last line without newline', () => {
    expect(mdLines('a\r\nb').map((l) => l.text)).toEqual(['a', 'b']);
    expect(mdLines('')).toEqual([]);
  });
});

describe('code spans', () => {
  it('reads single and double backtick spans and strips one padding space', () => {
    expect(codeSpans('x `a` y `` b`c `` z').map((s) => s.text)).toEqual(['a', 'b`c']);
    expect(codeSpanAt('` a `', 0)).toEqual({ text: 'a', start: 0, end: 5 });
    expect(codeSpanAt('`  `', 0)?.text).toBe('  ');
  });

  it('ignores unclosed backticks and escaped backticks', () => {
    expect(codeSpans('a `b')).toEqual([]);
    expect(codeSpans('\\`a `b`').map((s) => s.text)).toEqual(['b']);
    expect(codeSpanAt('x', 0)).toBeNull();
    expect(codeSpanAt('``a`', 0)).toBeNull();
  });

  it('replaces code spans by a space', () => {
    expect(withoutCodeSpans('a `b` c `d`e')).toBe('a   c  e');
  });

  it('reads a cell that is one code span', () => {
    expect(soleCodeSpan(' `a` ')).toBe('a');
    expect(soleCodeSpan('`a` b')).toBeNull();
    expect(soleCodeSpan('a')).toBeNull();
    expect(cellValue(' `a` ')).toBe('a');
    expect(cellValue(' a b ')).toBe('a b');
  });
});

describe('tables', () => {
  it('splits cells at unescaped pipes', () => {
    expect(splitCells('| a | b \\| c |')).toEqual(['a', 'b | c']);
    expect(splitCells('  | a |  |')).toEqual(['a', '']);
    expect(splitCells('a | b')).toEqual(['a', 'b']);
  });

  it('tells table and separator lines', () => {
    expect(isTableLine('  | a |')).toBe(true);
    expect(isTableLine('a |')).toBe(false);
    expect(isSeparatorLine('|---|:-:|')).toBe(true);
    expect(isSeparatorLine('| a |')).toBe(false);
    expect(isSeparatorLine('|   |')).toBe(false);
    expect(isSeparatorLine('---')).toBe(false);
  });

  it('reads a table with its rows and end', () => {
    const lines = mdLines('x\n| a | b |\n|---|---|\n| 1 | 2 |\n  | 3 | 4 |\ny\n');
    expect(tableAt(lines, 0)).toBeNull();
    const table = tableAt(lines, 1);
    expect(table).toEqual({
      n: 2,
      header: ['a', 'b'],
      rows: [
        { n: 4, cells: ['1', '2'] },
        { n: 5, cells: ['3', '4'] },
      ],
      endIndex: 5,
    });
  });

  it('finds the table right after a line, across blank lines only', () => {
    const lines = mdLines('t\n\n| a |\n|---|\n| 1 |\n');
    expect(tableAfter(lines, 0)?.header).toEqual(['a']);
    expect(tableAfter(mdLines('t\ntext\n| a |\n|---|\n'), 0)).toBeNull();
    expect(tableAfter(mdLines('t\n\n'), 0)).toBeNull();
    expect(tableAfter(lines, 0, 2)).toBeNull();
  });

  it('does not read a table inside a code fence', () => {
    const lines = mdLines('```\n| a |\n|---|\n```\n');
    expect(tableAt(lines, 1)).toBeNull();
  });

  it('ends a table at a fence line', () => {
    const lines = mdLines('| a |\n|---|\n| 1 |\n```\n| 2 |\n```\n');
    expect(tableAt(lines, 0)?.rows).toEqual([{ n: 3, cells: ['1'] }]);
  });
});

describe('sections', () => {
  const lines = mdLines('# T\n## a\nx\n### s\n## b\n```\n## no\n```\n# U\n## c\n');

  it('reads heading levels outside fences', () => {
    expect(lines.map(headingLevel)).toEqual([1, 2, 0, 3, 2, 0, 0, 0, 1, 2]);
  });

  it('ends a section at the next heading of the same or a higher level', () => {
    expect(sections(lines, 2)).toEqual([
      { title: 'a', start: 1, end: 4 },
      { title: 'b', start: 4, end: 8 },
      { title: 'c', start: 9, end: 10 },
    ]);
    expect(section(lines, 3, 's')).toEqual({ title: 's', start: 3, end: 4 });
    expect(section(lines, 2, 'z')).toBeNull();
  });
});

describe('parseSpanList', () => {
  it('reads code spans joined by ", " up to the end of the line or ". "', () => {
    expect(parseSpanList('`a`, `b`')).toEqual({ items: [{ text: 'a', rowOf: null }, { text: 'b', rowOf: null }], rest: null });
    expect(parseSpanList('`a`. rest')).toEqual({ items: [{ text: 'a', rowOf: null }], rest: 'rest' });
  });

  it('is null when a code span is followed by other text', () => {
    expect(parseSpanList('`a` is x')).toBeNull();
    expect(parseSpanList('`a`, b')).toBeNull();
    expect(parseSpanList('a')).toBeNull();
    expect(parseSpanList('`a`.')).toBeNull();
  });

  it('reads comments only when asked', () => {
    expect(parseSpanList('`a`(x (y)), `b`', { comments: true })?.items.map((i) => i.text)).toEqual(['a', 'b']);
    expect(parseSpanList('`a`(x)')).toBeNull();
    expect(parseSpanList('`a`(x', { comments: true })).toBeNull();
  });

  it('reads arrows only when asked', () => {
    expect(parseSpanList('`[a]` → row of `t`. x', { arrows: true })).toEqual({ items: [{ text: '[a]', rowOf: 't' }], rest: 'x' });
    expect(parseSpanList('`[a]` → row of `t`')).toBeNull();
    expect(parseSpanList('`[a]` → `t`', { arrows: true })).toBeNull();
  });
});

describe('linkTargets', () => {
  it('reads link targets outside code spans', () => {
    expect(linkTargets('[a](x.md) and [`b`](../y.md#z) `[c](no.md)`')).toEqual(['x.md', '../y.md#z']);
    expect(linkTargets('[a](f(1).md)')).toEqual(['f(1).md']);
  });
});

describe('arrowTargetAt', () => {
  it('reads `` → row of `<table>` ``', () => {
    expect(arrowTargetAt('x → row of `shop` y', 2)).toEqual({ table: 'shop', end: 17 });
    expect(arrowTargetAt('→ `shop`의 행', 0)).toBeNull();
    expect(arrowTargetAt('→ row `shop`', 0)).toBeNull();
    expect(arrowTargetAt('→ `shop` row', 0)).toBeNull();
  });
});
