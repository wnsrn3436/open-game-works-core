import { describe, expect, it } from 'vitest';
import { formatCsv, parseCsv, parseRecords, column } from '../../../../src/commands/agent/lib/csv.ts';
import {
  glossaryLanguages,
  mergeGlossary,
  mergeResources,
  mergeTranslation,
  translationCounts,
} from '../../../../src/commands/agent/lib/rowmerge.ts';

describe('csv', () => {
  it('parses quoted fields, escaped quotes, commas and line breaks', () => {
    expect(parseRecords('a,"b,""c""",d\r\n"x\ny",,\n')).toEqual([
      ['a', 'b,"c"', 'd'],
      ['x\ny', '', ''],
    ]);
    expect(parseRecords('a,b')).toEqual([['a', 'b']]);
    expect(parseRecords('')).toEqual([]);
  });

  it('rejects broken quoting', () => {
    expect(() => parseRecords('"abc')).toThrow('invalid CSV: line 1: unclosed quote');
    expect(() => parseRecords('"a"b,c')).toThrow('text after');
    // RFC 4180: a quote only in a quoted cell
    expect(() => parseRecords('a\nsay "hi"\n')).toThrow('invalid CSV: line 2: quote inside an unquoted cell');
  });

  it('skips a UTF-8 BOM', () => {
    expect(parseCsv('\uFEFFkey,text\nk1,x\n').header).toEqual(['key', 'text']);
  });

  it('round-trips with minimal quoting and keeps the line ending', () => {
    const table = parseCsv('k,v\r\n1,"a,b"\r\n2,"say ""hi"""\r\n');
    expect(table.eol).toBe('\r\n');
    expect(formatCsv(table)).toBe('k,v\r\n1,"a,b"\r\n2,"say ""hi"""\r\n');
    expect(formatCsv(parseCsv('k\nline\n'))).toBe('k\nline\n');
    expect(formatCsv({ header: ['a'], rows: [['x\ny']], eol: '\n' })).toBe('a\n"x\ny"\n');
  });

  it('finds columns', () => {
    const table = parseCsv('a,b\n');
    expect(column(table, 'b')).toBe(1);
    expect(() => column(table, 'c')).toThrow('no column c');
  });
});

const RES_BASE = 'key,status\na,placeholder\nb,placeholder\nc,placeholder\n';

describe('mergeResources', () => {
  it('takes each side changes by key and appends rows the sub-agent added', () => {
    const ours = 'key,status\na,placeholder\nb,changed-by-branch\nd,new\n';
    const theirs = 'key,status\na,final\nb,placeholder\nc,placeholder\ne,added\n';
    expect(mergeResources(RES_BASE, ours, theirs)).toEqual({ text: 'key,status\na,final\nb,changed-by-branch\nd,new\ne,added\n' });
  });

  it('keeps a row both sides changed the same way and drops a row deleted on one side only', () => {
    const ours = 'key,status\na,final\nb,placeholder\n';
    const theirs = 'key,status\na,final\nb,placeholder\nc,placeholder\n';
    expect(mergeResources(RES_BASE, ours, theirs)).toEqual({ text: 'key,status\na,final\nb,placeholder\n' });
  });

  it('is a conflict when both sides change a key differently, or one deletes what the other changed', () => {
    expect(mergeResources(RES_BASE, 'key,status\na,x\n', 'key,status\na,y\n')).toEqual({ conflict: 'resource/resources.csv: key a changed on both sides' });
    expect(mergeResources(RES_BASE, 'key,status\nb,placeholder\nc,placeholder\n', 'key,status\na,final\nb,placeholder\nc,placeholder\n')).toHaveProperty('conflict');
    expect(mergeResources(RES_BASE, 'key,other\n', RES_BASE)).toEqual({ conflict: 'resource/resources.csv: header differs' });
  });

  it('handles missing files', () => {
    expect(mergeResources(null, null, null)).toEqual({ text: null });
    expect(mergeResources(null, null, 'key,status\na,new\n')).toEqual({ text: 'key,status\na,new\n' });
  });
});

const TR_HEAD = 'key,source,source_hash,current_hash,text\n';

describe('mergeTranslation', () => {
  it('takes rows and source from the branch and text and source_hash from the sub-agent', () => {
    const base = `${TR_HEAD}k1,Hello,,h1,\nk2,Bye,,h2,\nk3,Gone,,h3,\n`;
    const ours = `${TR_HEAD}k1,Hello!,,h9,\nk2,Bye,,h2,\nk4,New,,h4,\n`;
    const theirs = `${TR_HEAD}k1,Hello,h1,h1,Annyeong\nk2,Bye,,h2,\nk3,Gone,h3,h3,Gan\nk5,Extra,h5,h5,x\n`;
    expect(mergeTranslation('data/translations/ko.csv', base, ours, theirs)).toEqual({
      text: `${TR_HEAD}k1,Hello!,h1,h9,Annyeong\nk2,Bye,,h2,\nk4,New,,h4,\n`,
    });
  });

  it('is a conflict when both sides change text or source_hash of a key, even to the same value', () => {
    const base = `${TR_HEAD}k1,Hello,,h1,\n`;
    const both = `${TR_HEAD}k1,Hello,,h1,Same\n`;
    expect(mergeTranslation('data/translations/ko.csv', base, both, both)).toEqual({
      conflict: 'data/translations/ko.csv: text of key k1 changed on both sides',
    });
  });

  it('has no file when the branch has none', () => {
    expect(mergeTranslation('p', 'x', null, 'y')).toEqual({ text: null });
  });

  it('reads a side that starts with a UTF-8 BOM', () => {
    const base = `${TR_HEAD}k1,Hello,,h1,\n`;
    expect(mergeTranslation('p', base, base, `\uFEFF${TR_HEAD}k1,Hello,h1,h1,Annyeong\n`)).toEqual({ text: `${TR_HEAD}k1,Hello,h1,h1,Annyeong\n` });
  });

  it('fails on a side without the key column instead of matching no row', () => {
    const base = `${TR_HEAD}k1,Hello,,h1,\n`;
    expect(() => mergeTranslation('p', base, base, 'id,source,source_hash,current_hash,text\nk1,Hello,h1,h1,An\n')).toThrow('CSV has no column key');
    expect(() => mergeResources(RES_BASE, 'status\nfinal\n', RES_BASE)).toThrow('CSV has no column key');
  });

  it('treats a key without a base row as empty on the base', () => {
    const ours = `${TR_HEAD}k1,Hi,,h1,\n`;
    const theirs = `${TR_HEAD}k1,Hi,h1,h1,An\n`;
    expect(mergeTranslation('p', TR_HEAD, ours, theirs)).toEqual({ text: `${TR_HEAD}k1,Hi,h1,h1,An\n` });
  });
});

const GL_HEAD = 'source,id_name,note,source_hash,ko,ja\n';

describe('mergeGlossary', () => {
  it('takes rows, source, id_name and note from the branch and language cells from the sub-agent', () => {
    const base = `${GL_HEAD}Sword,[sword],,s1,,\nShield,[shield],,s2,,\nOld,[old],,s3,,\n`;
    const ours = `${GL_HEAD}Sword,[sword],a note,s1,,\nShield2,[shield],,s9,,\nAxe,[axe],,s4,,\n`;
    const theirs = `${GL_HEAD}Sword,[sword],,s1,검,\nShield,[shield],,s2,방패,\nOld,[old],,s3,옛,\n`;
    expect(mergeGlossary(base, ours, theirs)).toEqual({ text: `${GL_HEAD}Sword,[sword],a note,s1,검,\nShield2,[shield],,s9,,\nAxe,[axe],,s4,,\n` });
  });

  it('accepts the same value on both sides and rejects different values', () => {
    const base = `${GL_HEAD}Sword,[sword],,s1,,\n`;
    expect(mergeGlossary(base, `${GL_HEAD}Sword,[sword],,s1,검,\n`, `${GL_HEAD}Sword,[sword],,s1,검,\n`)).toEqual({ text: `${GL_HEAD}Sword,[sword],,s1,검,\n` });
    expect(mergeGlossary(base, `${GL_HEAD}Sword,[sword],,s1,칼,\n`, `${GL_HEAD}Sword,[sword],,s1,검,\n`)).toHaveProperty('conflict');
    expect(mergeGlossary(base, null, base)).toEqual({ text: null });
  });

  it('reads a side that starts with a UTF-8 BOM, and fails on a side without source or id_name', () => {
    const base = `${GL_HEAD}Sword,[sword],,s1,,\n`;
    expect(mergeGlossary(base, base, `\uFEFF${GL_HEAD}Sword,[sword],,s1,검,\n`)).toEqual({ text: `${GL_HEAD}Sword,[sword],,s1,검,\n` });
    expect(() => mergeGlossary(base, base, 'source,note,source_hash,ko,ja\nSword,,s1,검,\n')).toThrow('CSV has no column id_name');
  });

  it('names the language columns', () => {
    expect(glossaryLanguages(['source', 'id_name', 'note', 'source_hash', 'ko', 'ja'])).toEqual(['ko', 'ja']);
  });
});

describe('translationCounts', () => {
  it('counts rows whose text or language cell changed, per language', () => {
    const before = {
      translations: new Map([['ko', `${TR_HEAD}k1,A,,h,\nk2,B,,h,old\n`]]),
      glossary: `${GL_HEAD}Sword,[sword],,s1,,\n`,
    };
    const after = {
      translations: new Map([
        ['ko', `${TR_HEAD}k1,A,h,h,new\nk2,B,,h,old\nk3,C,h,h,x\n`],
        ['ja', `${TR_HEAD}k1,A,h,h,jp\n`],
      ]),
      glossary: `${GL_HEAD}Sword,[sword],,s1,검,剣\n`,
    };
    expect(translationCounts(before, after)).toEqual({ ja: { text: 1, glossary: 1 }, ko: { text: 2, glossary: 1 } });
    expect(translationCounts({ translations: new Map(), glossary: null }, { translations: new Map(), glossary: null })).toEqual({});
  });

  it('has no counts for a language whose file is not UTF-8 on a side', () => {
    const before = { translations: new Map([['ko', `${TR_HEAD}k1,A,,h,\n`], ['ja', `${TR_HEAD}k1,A,,h,\n`]]), glossary: null };
    const after = { translations: new Map([['ko', undefined], ['ja', `${TR_HEAD}k1,A,h,h,jp\n`]]), glossary: null };
    expect(translationCounts(before, after)).toEqual({ ja: { text: 1, glossary: 0 } });
  });
});
