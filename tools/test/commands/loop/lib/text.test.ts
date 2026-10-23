import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../../../src/commands/agent/lib/csv.ts';
import { rowsByKey } from '../../../../src/commands/loop/lib/csv.ts';
import {
  cell,
  column,
  document,
  escapeCell,
  parseTable,
  renderTable,
  section,
  sectionText,
  splitRow,
  trimBlank,
  unquote,
} from '../../../../src/commands/loop/lib/markdown.ts';

describe('markdown', () => {
  const text = '# t\n\n## a\n\nline 1\n### sub\nline 2\n\n## b\nx\n# top\ny\n';

  it('reads a section up to the next # or ## heading', () => {
    expect(section(text, 'a')).toEqual(['', 'line 1', '### sub', 'line 2', '']);
    expect(section(text, 'b')).toEqual(['x']);
    expect(section(text, 'c')).toBeNull();
    expect(sectionText(text, 'a')).toBe('line 1\n### sub\nline 2');
    expect(sectionText(text, 'c')).toBeNull();
    expect(trimBlank(['', ' ', 'a', '', 'b', '  '])).toEqual(['a', '', 'b']);
  });

  it('splits rows on unescaped pipes', () => {
    expect(splitRow('| a | b \\| c | `d` |')).toEqual(['a', 'b | c', '`d`']);
    expect(splitRow('a | b')).toEqual(['a', 'b']);
    expect(splitRow('| a | b\\|')).toEqual(['a', 'b|']);
  });

  it('parses the first table', () => {
    const table = parseTable(['intro', '| `id` | Note |', '|---|:-:|', '| x | `y` |', '| z |', 'after', '| q | r |']);
    expect(table?.header).toEqual(['id', 'Note']);
    expect(table?.rows).toEqual([{ cells: ['x', '`y`'], line: 3 }, { cells: ['z'], line: 4 }]);
    if (!table) throw new Error('no table');
    expect(column(table, 'note')).toBe(1);
    expect(column(table, 'missing')).toBe(-1);
    expect(cell(table.rows[0] as { cells: string[] }, 1)).toBe('y');
    expect(cell(table.rows[1] as { cells: string[] }, 1)).toBe('');
    expect(cell(table.rows[0] as { cells: string[] }, -1)).toBe('');
    expect(parseTable(['| a |', 'not a separator'])).toBeNull();
    expect(parseTable(['| a |'])).toBeNull();
  });

  it('renders tables and documents', () => {
    expect(renderTable(['a', 'b'], [['1|2', 'x\ny']])).toBe('| a | b |\n|---|---|\n| 1\\|2 | x y |');
    expect(escapeCell('a|b')).toBe('a\\|b');
    expect(unquote(' `x` ')).toBe('x');
    expect(unquote('`')).toBe('`');
    expect(document([['a', ' body '], ['b', '  ']])).toBe('## a\n\nbody\n\n## b\n\nnone\n');
  });
});

describe('csv', () => {
  it('maps rows by key columns', () => {
    const csv = parseCsv('source,id_name,ko\nA,[a],가\nB,,나\n');
    expect([...rowsByKey(csv, ['source', 'id_name']).keys()]).toEqual(['A\u0000[a]', 'B\u0000']);
    expect(rowsByKey(csv, ['missing']).size).toBe(0);
  });
});

