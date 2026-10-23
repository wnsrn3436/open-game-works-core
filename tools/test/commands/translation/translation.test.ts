import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { todoOf, linesAbout, formatTodo } from '../../../src/commands/translation/lib/files.ts';
import { parseTable } from '../../../src/commands/data/lib/csv.ts';
import { ogw, commitAll, makeGame, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { GAME_SETTINGS, makeRelease, toolCalls, write } from '../generate/helpers.ts';

vi.mock('../../../src/commands/core/api.ts', async () => (await import('../generate/helpers.ts')).coreApiMock);
vi.mock('../../../src/commands/generate/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/generate/api.ts')>()),
  runGenerate: vi.fn(() => Promise.resolve()),
}));

const GLOSSARY = 'source,id_name,note,source_hash,en,zh-Hans\nSword,[sword],weapon,h1,,검\nFire,,element,h2,Fire!,火\n';
const HEADER = 'key,source,source_hash,current_hash,text';

function setup(en: string): { ws: TestWorkspace; root: string; release: string } {
  const ws = makeWorkspace();
  const release = makeRelease(ws, '1.0.0');
  const root = makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS, 'data/glossary.csv': GLOSSARY, 'data/translations/en.csv': en });
  return { ws, root, release };
}

describe('ogw translation todo', () => {
  const en = [
    HEADER,
    'item.name.[sword],Sword of Fire,,c1,',
    'item.desc.[sword],"A sword, hot",a,b,old text',
    'item.name.[shield],Shield,s,s,Shield EN',
  ].join('\n') + '\n';

  it('runs ogw data and lists empty glossary cells, missing and stale translations', async () => {
    const { ws, release } = setup(en);
    const run = await ogw(ws, ['translation', 'todo', 'g', 'en']);
    expect(run.code).toBe(0);
    expect(toolCalls(release, 'data-tool.tgz')).toHaveLength(1);
    expect(run.stdout).toBe(
      [
        'glossary data/glossary.csv:2 source="Sword" id_name="[sword]" note="weapon"',
        'missing "item.name.[sword]"',
        '    source: "Sword of Fire"',
        '    glossary: "Sword" -> ""',
        '    glossary: "Fire" -> "Fire!"',
        'stale "item.desc.[sword]"',
        '    source: "A sword, hot"',
        '    text: "old text"',
        '',
      ].join('\n'),
    );
    const json = JSON.parse((await ogw(ws, ['translation', 'todo', 'g', 'zh-Hans', '--json'])).stdout) as {
      glossary: unknown[];
      missing: unknown[];
    };
    expect(json.glossary).toEqual([]);
    expect(json.missing).toEqual([]);
  });

  it('does not list blank lines of the translation file as rows', async () => {
    const { ws } = setup(`${HEADER}\n\nitem.name.[axe],Axe,,c1,\n\n`);
    const json = JSON.parse((await ogw(ws, ['translation', 'todo', 'g', 'en', '--json'])).stdout) as { missing: { key: string }[] };
    expect(json.missing.map((row) => row.key)).toEqual(['item.name.[axe]']);
  });

  it('lists the files as ogw data left them and changes nothing more', async () => {
    const { ws, root } = setup(en);
    const regenerated = `${HEADER}\nitem.name.[axe],Axe,,c9,\nitem.name.[shield],Shield,s,t,Shield EN\n`;
    const glossary = 'source,id_name,note,source_hash,en,zh-Hans\nAxe,[axe],tool,h3,,斧\n';
    write(join(root, 'fake-data-tool.json'), { write: { 'data/translations/en.csv': regenerated, 'data/glossary.csv': glossary } });
    commitAll(root, 'fake data tool');
    const head = sh(root, 'git', ['rev-parse', 'HEAD']);
    const run = await ogw(ws, ['translation', 'todo', 'g', 'en']);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(
      [
        'glossary data/glossary.csv:2 source="Axe" id_name="[axe]" note="tool"',
        'missing "item.name.[axe]"',
        '    source: "Axe"',
        '    glossary: "Axe" -> ""',
        'stale "item.name.[shield]"',
        '    source: "Shield"',
        '    text: "Shield EN"',
        '',
      ].join('\n'),
    );
    expect(readFileSync(join(root, 'data', 'translations', 'en.csv'), 'utf8')).toBe(regenerated);
    expect(readFileSync(join(root, 'data', 'glossary.csv'), 'utf8')).toBe(glossary);
    expect(sh(root, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(sh(root, 'git', ['status', '--porcelain', '--', 'fake-data-tool.json', 'settings.json'])).toBe('');
  });

  it('refuses the source language and unsupported languages without running ogw data', async () => {
    const { ws, release } = setup(en);
    const ko = await ogw(ws, ['translation', 'todo', 'g', 'ko']);
    expect(ko.code).toBe(1);
    expect(ko.stderr).toContain('ko is not a translation language of g: en, zh-Hans');
    expect((await ogw(ws, ['translation', 'todo', 'g', 'fr'])).code).toBe(1);
    expect(toolCalls(release, 'data-tool.tgz')).toEqual([]);
    expect((await ogw(ws, ['translation', 'todo', 'g'])).stderr).toContain('usage: ogw translation todo <game> <language>');
  });

  it('fails with the data check lines when ogw data fails', async () => {
    const { ws, root } = setup(en);
    write(join(root, 'fake-data-tool.json'), { stdout: 'data/a.csv:1:1 ERROR structure s\n', stderr: 'why\n', exitCode: 1 });
    const run = await ogw(ws, ['translation', 'todo', 'g', 'en']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('ogw data failed\ndata/a.csv:1:1 ERROR structure s\nwhy\n');
  });
});

describe('ogw translation done', () => {
  const head = [HEADER, 'k1,Sword,,c1,', 'k2,Fire,a,b,old', 'k4,Fire two,a,b,x', 'k6,Same,s,s,same'].join('\r\n') + '\r\n';
  const edited = [HEADER, 'k1,Sword,,c1,Sword EN', 'k2,Fire,a,b,old', 'k4,Fire two,a,b,x', 'k5,"Five, 5",,c5,five', 'k6,Same,s,s,same', 'k7,Seven,,c7,'].join('\r\n') + '\r\n';

  function prepared(): { ws: TestWorkspace; root: string; release: string } {
    const result = setup(head);
    write(join(result.root, 'data', 'translations', 'en.csv'), edited);
    return result;
  }

  it('sets source_hash on changed and kept rows and lists what is left with the data check lines', async () => {
    const { ws, root } = prepared();
    write(join(root, 'fake-data-tool.json'), {
      stdout: 'data/translations/en.csv:3:1 WARN translation_stale k2\ndata/glossary.csv:2:5 WARN translation_missing g\ndata/translations/ja.csv:1:1 WARN translation_missing x\n',
    });
    const run = await ogw(ws, ['translation', 'done', 'g', 'en', '--keep', 'k4']);
    expect(run.code).toBe(0);
    expect(readFileSync(join(root, 'data', 'translations', 'en.csv'), 'utf8')).toBe(
      [HEADER, 'k1,Sword,c1,c1,Sword EN', 'k2,Fire,a,b,old', 'k4,Fire two,b,b,x', 'k5,"Five, 5",c5,c5,five', 'k6,Same,s,s,same', 'k7,Seven,,c7,'].join('\r\n') + '\r\n',
    );
    expect(run.stdout).toBe(
      [
        'glossary data/glossary.csv:2 source="Sword" id_name="[sword]" note="weapon"',
        'missing "k7"',
        '    source: "Seven"',
        'stale "k2"',
        '    source: "Fire"',
        '    text: "old"',
        '    glossary: "Fire" -> "Fire!"',
        'data/translations/en.csv:3:1 WARN translation_stale k2',
        'data/glossary.csv:2:5 WARN translation_missing g',
        '',
      ].join('\n'),
    );
  });

  it('marks every non-empty row when HEAD has no translation file and changes nothing when nothing is new', async () => {
    const ws = makeWorkspace();
    makeRelease(ws, '1.0.0');
    const root = makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS });
    write(join(root, 'data', 'translations', 'en.csv'), `${HEADER}\nk1,S,,c1,T\nk2,S,,c2,\n`);
    expect((await ogw(ws, ['translation', 'done', 'g', 'en'])).code).toBe(0);
    expect(readFileSync(join(root, 'data', 'translations', 'en.csv'), 'utf8')).toBe(`${HEADER}\nk1,S,c1,c1,T\nk2,S,,c2,\n`);
    commitAll(root, 'done');
    expect((await ogw(ws, ['translation', 'done', 'g', 'en'])).stdout).toBe('missing "k2"\n    source: "S"\n');
  });

  it('fails without changes on a --keep key that is not stale, before or after ogw data', async () => {
    const { ws, root, release } = prepared();
    const before = await ogw(ws, ['translation', 'done', 'g', 'en', '--keep', 'k6', 'k2', 'k7', 'nope']);
    expect(before.code).toBe(1);
    expect(before.stderr).toContain('not stale translation rows of data/translations/en.csv: k6, k7, nope');
    expect(toolCalls(release, 'data-tool.tgz')).toEqual([]);
    write(join(root, 'fake-data-tool.json'), { write: { 'data/translations/en.csv': edited.replace('k2,Fire,a,b,old', 'k2,Fire,b,b,old') } });
    const after = await ogw(ws, ['translation', 'done', 'g', 'en', '--keep', 'k2']);
    expect(after.code).toBe(1);
    expect(after.stderr).toContain('not stale translation rows of data/translations/en.csv: k2');
    expect(readFileSync(join(root, 'data', 'translations', 'en.csv'), 'utf8')).toContain('k1,Sword,,c1,Sword EN');
  });

  it('fails without changes when ogw data fails, and when the file is missing after ogw data', async () => {
    const { ws, root } = prepared();
    write(join(root, 'fake-data-tool.json'), { stdout: 'data/translations/en.csv:2:1 ERROR translation_format f\n', exitCode: 1 });
    const run = await ogw(ws, ['translation', 'done', 'g', 'en']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('ogw data failed\ndata/translations/en.csv:2:1 ERROR translation_format f\n');
    expect(readFileSync(join(root, 'data', 'translations', 'en.csv'), 'utf8')).toBe(edited);
    const ws2 = makeWorkspace();
    makeRelease(ws2, '1.0.0');
    makeGame(ws2, 'g', { 'settings.json': GAME_SETTINGS });
    const missing = await ogw(ws2, ['translation', 'done', 'g', 'zh-Hans']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('data/translations/zh-Hans.csv does not exist after ogw data');
    expect((await ogw(ws2, ['translation', 'done', 'g', 'ko'])).code).toBe(1);
  });
});

describe('translation helpers', () => {
  it('todoOf without files and linesAbout with absolute paths', () => {
    expect(todoOf(null, null, 'en')).toEqual({ glossary: [], missing: [], stale: [] });
    expect(formatTodo({ glossary: [], missing: [], stale: [] })).toBe('');
    const glossary = parseTable('source,id_name,note,source_hash,en\n,,,h,\n', 'g.csv');
    const table = parseTable(`${HEADER}\nk,abc,,x,\n`, 't.csv');
    expect(todoOf(table, glossary, 'en').missing).toEqual([{ key: 'k', source: 'abc', glossary: [] }]);
    const line = (where: string) => ({ level: 'WARN' as const, code: 'c', where, message: '', text: where });
    expect(linesAbout([line('/abs/data/glossary.csv:1:1'), line('C:\\g\\data\\glossary.csv:1:1'), line('xdata/glossary.csv:1:1')], ['data/glossary.csv'])).toHaveLength(2);
  });
});

describe('formatTodo', () => {
  it('keeps a source text with line breaks and separators on one line', () => {
    const table = parseTable(`${HEADER}\nk1,"Hello\nstale item.name.[x]",,c1,\n`, 'en.csv');
    const glossary = parseTable('source,id_name,note,source_hash,en\n"a -> b",,"x source=y",h,\n', 'glossary.csv');
    expect(formatTodo(todoOf(table, glossary, 'en')).split('\n')).toEqual([
      'glossary data/glossary.csv:2 source="a -> b" id_name="" note="x source=y"',
      'missing "k1"',
      '    source: "Hello\\nstale item.name.[x]"',
    ]);
  });
});
