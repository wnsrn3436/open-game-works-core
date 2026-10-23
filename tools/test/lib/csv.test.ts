import { describe, expect, it } from 'vitest';
import { parseRecords } from '../../src/commands/agent/lib/csv.ts';
import { parseCsv as dataCsv } from '../../src/commands/data/lib/csv.ts';
import { parseCsv as resourceCsv } from '../../src/commands/resource/lib/csv.ts';
import { formatCsvCell, parseCsvRecords } from '../../src/lib/csv.ts';
import { parseCsv as tableCsv } from '../../src/lib/datatable.ts';

describe('parseCsvRecords', () => {
  it('skips a BOM and gives each record its start line and its offsets in the text', () => {
    const text = '\uFEFFa,"b\r\nc"\r\n\r\nd\re\n';
    expect(parseCsvRecords(text, 'f.csv')).toEqual([
      { cells: ['a', 'b\r\nc'], line: 1, start: 1, end: 9 },
      { cells: [''], line: 3, start: 11, end: 11 },
      { cells: ['d'], line: 4, start: 13, end: 14 },
      { cells: ['e'], line: 5, start: 15, end: 16 },
    ]);
    expect(text.slice(1, 9)).toBe('a,"b\r\nc"');
    expect(parseCsvRecords('a,\n""')).toEqual([
      { cells: ['a', ''], line: 1, start: 0, end: 2 },
      { cells: [''], line: 2, start: 3, end: 5 },
    ]);
    expect(parseCsvRecords('')).toEqual([]);
  });

  it('rejects what RFC 4180 does not allow, naming the file and line', () => {
    expect(() => parseCsvRecords('a\n"x\ny', 'f.csv')).toThrow('f.csv:2: unclosed quote');
    expect(() => parseCsvRecords('a\n"x"y', 'f.csv')).toThrow('f.csv:2: text after a quoted field');
    expect(() => parseCsvRecords('a\nb"c"', 'f.csv')).toThrow('f.csv:2: quote inside an unquoted cell');
    expect(() => parseCsvRecords('a"')).toThrow('invalid CSV: line 1: quote inside an unquoted cell');
  });

  it('quotes a cell only when it needs it', () => {
    expect(['a', 'b,c', 'd"e', 'x\ny', 'r\rs', ''].map(formatCsvCell)).toEqual(['a', '"b,c"', '"d""e"', '"x\ny"', '"r\rs"', '']);
  });

  it('is the one rule of every CSV reader of ogw', () => {
    // each reader had its own copy: the merge kept a BOM, the data table reader took broken quotes as text
    expect(parseRecords('\uFEFFkey\nk1\n')).toEqual([['key'], ['k1']]);
    for (const read of [parseRecords, tableCsv, (text: string) => resourceCsv(text, 'f.csv'), (text: string) => dataCsv(text, 'f.csv')]) {
      expect(() => read('a,b"c\n')).toThrow('quote inside an unquoted cell');
      expect(() => read('"a"b\n')).toThrow('text after a quoted field');
      expect(() => read('"a\n')).toThrow('unclosed quote');
    }
    expect(tableCsv('a\rb')).toEqual([['a'], ['b']]);
  });
});
