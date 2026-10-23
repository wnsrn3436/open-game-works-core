import { describe, expect, it } from 'vitest';
import { parseCsv, parseTable, rewriteRows } from '../../../../src/commands/data/lib/csv.ts';

describe('parseCsv', () => {
  it('reads quoted fields, escaped quotes, line breaks in quotes and CRLF', () => {
    const text = 'a,b,c\r\n"x, y","say ""hi""","l1\nl2"\r\n,,\nlast';
    const records = parseCsv(text, 'f.csv');
    expect(records.map((r) => r.fields)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'l1\nl2'],
      ['', '', ''],
      ['last'],
    ]);
    expect(records.map((r) => r.line)).toEqual([1, 2, 4, 5]);
    expect(text.slice(records[1]?.start, records[1]?.end)).toBe('"x, y","say ""hi""","l1\nl2"');
    expect(text.slice(records[3]?.start, records[3]?.end)).toBe('last');
  });

  it('skips a BOM, reads empty lines as one empty field and fails on bad quoting', () => {
    expect(parseCsv('﻿a\n\nb\n', 'f.csv').map((r) => r.fields)).toEqual([['a'], [''], ['b']]);
    expect(parseCsv('', 'f.csv')).toEqual([]);
    expect(() => parseCsv('a\n"open', 'f.csv')).toThrow('f.csv:2: unclosed quote');
    expect(() => parseCsv('"a"b\n', 'f.csv')).toThrow('f.csv:1: text after a quoted field');
    expect(parseCsv('a\rb', 'f.csv').map((r) => r.fields)).toEqual([['a'], ['b']]);
  });
});

describe('parseTable and rewriteRows', () => {
  it('maps rows by header and rewrites only the given rows', () => {
    const text = 'key,source,text\r\nk1,"s, 1",t1\r\n"k2",s2,"t ""2"""\r\nk3,s3\r\n';
    const table = parseTable(text, 'f.csv');
    expect(table.header).toEqual(['key', 'source', 'text']);
    expect(table.rows.map((r) => r.values)).toEqual([
      { key: 'k1', source: 's, 1', text: 't1' },
      { key: 'k2', source: 's2', text: 't "2"' },
      { key: 'k3', source: 's3', text: '' },
    ]);
    expect(table.rows.map((r) => r.line)).toEqual([2, 3, 4]);
    const [first, second, third] = table.rows;
    if (!first || !second || !third) throw new Error('rows');
    second.values.text = 'new\nline';
    first.values.source = 'plain';
    expect(rewriteRows(table, [first, second])).toBe('key,source,text\r\nk1,plain,t1\r\nk2,s2,"new\nline"\r\nk3,s3\r\n');
    expect(rewriteRows(table, [])).toBe(text);
    expect(parseTable('', 'f.csv')).toEqual({ header: [], rows: [], text: '' });
  });
});
