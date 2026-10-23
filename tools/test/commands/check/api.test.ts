import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergedChecks, mergedResult, placeholderFailures, type CheckResult } from '../../../src/commands/check/api.ts';
import { translationTable } from '../../../src/commands/data/lib/translation-state.ts';
import { todoOf } from '../../../src/commands/translation/lib/files.ts';
import { createContext } from '../../../src/lib/command.ts';
import { commitAll, makeGame, makeWorkspace } from '../../helpers/workspace.ts';

function context(env: NodeJS.ProcessEnv, cwd: string): ReturnType<typeof createContext> {
  return createContext({ cwd, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
}

describe('placeholderFailures', () => {
  it('reports placeholder resources, missing and stale translations and empty glossary cells at HEAD', async () => {
    const ws = makeWorkspace();
    const root = makeGame(ws, 'g', {
      'settings.json': { sourceLanguage: 'ko', supportedLanguages: ['ko', 'en', 'ja'] },
      'resource/resources.csv': 'key,description,spec,status\nui/a,,,final\nui/b,,,placeholder\n"ui/c",,,requested\n',
      'data/translations/ko.csv': 'key,source,source_hash,current_hash,text\nt.a,가,1,1,가\n',
      'data/translations/en.csv': 'key,source,source_hash,current_hash,text\nt.a,가,1,1,A\nt.b,나,,2,\nt.c,다,1,2,C\n',
      'data/glossary.csv': 'source,id_name,note,source_hash,en,ja\n검,[sword],,h,Sword,\n방패,[shield],,h,,盾\n',
    });
    writeFileSync(join(root, 'resource/resources.csv'), 'key,status\n');
    const ctx = context(ws.env, root);
    const game = await ctx.game('g');
    expect(await placeholderFailures(ctx, game)).toEqual([
      { where: 'resource/resources.csv:3', message: 'placeholder ui/b', evidence: [] },
      { where: 'resource/resources.csv:4', message: 'placeholder ui/c', evidence: [] },
      { where: 'data/translations/en.csv:3', message: 'translation_missing en t.b', evidence: [] },
      { where: 'data/translations/en.csv:4', message: 'translation_stale en t.c', evidence: [] },
      { where: 'data/translations/ja.csv:1', message: 'translation_missing ja file missing', evidence: [] },
      { where: 'data/glossary.csv:2', message: 'translation_missing ja glossary 검', evidence: [] },
      { where: 'data/glossary.csv:3', message: 'translation_missing en glossary 방패', evidence: [] },
    ]);
    commitAll(root, 'resources cleared');
    expect((await placeholderFailures(ctx, game)).filter((f) => f.where.startsWith('resource/'))).toEqual([]);
  });

  it('uses the sourceLanguage default and has nothing to report without files', async () => {
    const ws = makeWorkspace();
    const root = makeGame(ws, 'g', { 'settings.json': { supportedLanguages: ['ko'] } });
    const ctx = context(ws.env, root);
    expect(await placeholderFailures(ctx, await ctx.game('g'))).toEqual([]);
    const bare = makeGame(ws, 'h', { 'README.md': 'x' });
    expect(await placeholderFailures(ctx, await ctx.game('h'))).toEqual([]);
    expect(bare).toBe(join(ws.games, 'h'));
  });

  it('reads translation files and the glossary with the rows ogw translation todo lists', async () => {
    const ws = makeWorkspace();
    const en = 'key,source,source_hash,current_hash,text\n\nt.a,"가\n\n나",,1,\r\n,,,,\nt.b,다,1,2,B\n\n';
    const glossary = 'source,id_name,note,source_hash,en\n\n검,[sword],,h,\n';
    const root = makeGame(ws, 'g', {
      'settings.json': { sourceLanguage: 'ko', supportedLanguages: ['ko', 'en'] },
      'data/translations/en.csv': en,
      'data/glossary.csv': glossary,
    });
    const ctx = context(ws.env, root);
    const failures = await placeholderFailures(ctx, await ctx.game('g'));
    expect(failures).toEqual([
      { where: 'data/translations/en.csv:3', message: 'translation_missing en t.a', evidence: [] },
      { where: 'data/translations/en.csv:7', message: 'translation_stale en t.b', evidence: [] },
      { where: 'data/glossary.csv:3', message: 'translation_missing en glossary 검', evidence: [] },
    ]);
    const todo = todoOf(translationTable(en, 'en.csv'), translationTable(glossary, 'glossary.csv'), 'en');
    expect(todo.missing.map((row) => row.key)).toEqual(['t.a']);
    expect(todo.stale.map((row) => row.key)).toEqual(['t.b']);
    expect(todo.glossary.map((row) => row.line)).toEqual([3]);
  });

  it('reports an unreadable resource list, translation file or glossary at its line 1', async () => {
    const ws = makeWorkspace();
    const root = makeGame(ws, 'g', {
      'settings.json': { sourceLanguage: 'ko', supportedLanguages: ['ko', 'en'] },
      'data/translations/en.csv': 'key,source,source_hash,current_hash,text\nt.a,"open,,1,A\n',
      'data/glossary.csv': 'source,id_name,note,source_hash,en\n"검,[sword],,h,Sword\n',
      'resource/resources.csv': 'key,status\nui/a,final\na,"b\n',
    });
    const ctx = context(ws.env, root);
    expect(await placeholderFailures(ctx, await ctx.game('g'))).toEqual([
      { where: 'resource/resources.csv:1', message: 'placeholder resource list unreadable: resource/resources.csv:3: unclosed quote', evidence: [] },
      { where: 'data/translations/en.csv:1', message: 'translation_missing en file unreadable: data/translations/en.csv:2: unclosed quote', evidence: [] },
      { where: 'data/glossary.csv:1', message: 'translation_missing en glossary unreadable: data/glossary.csv:2: unclosed quote', evidence: [] },
    ]);
    expect(() => translationTable('key,text\n"x\n', 'en.csv')).toThrow('en.csv:2: unclosed quote');
  });

  it('ignores supportedLanguages entries that are not strings', async () => {
    const ws = makeWorkspace();
    const root = makeGame(ws, 'g', {
      'settings.json': { sourceLanguage: 'ko', supportedLanguages: 'en' },
      'data/glossary.csv': 'source,id_name,note,source_hash\n검,[sword],,h\n',
    });
    const ctx = context(ws.env, root);
    expect(await placeholderFailures(ctx, await ctx.game('g'))).toEqual([]);
  });
});

describe('platform items of a check', () => {
  const item = (name: string, platform: string | null, result: CheckResult['result']): CheckResult => ({ name, platform, result, failures: [], warnings: [] });
  it('any fail is fail, all pass is pass, else unknown', () => {
    expect(mergedResult([item('performance', 'ios', 'pass'), item('performance', 'web', 'fail')])).toBe('fail');
    expect(mergedResult([item('performance', 'ios', 'unknown'), item('performance', 'web', 'fail')])).toBe('fail');
    expect(mergedResult([item('performance', 'ios', 'pass'), item('performance', 'web', 'pass')])).toBe('pass');
    expect(mergedResult([item('performance', 'ios', 'pass'), item('performance', 'web', 'unknown')])).toBe('unknown');
    expect(mergedResult([])).toBe('unknown');
  });
  it('gives one result per check name in first-seen order', () => {
    expect(
      mergedChecks([
        item('static check', null, 'pass'),
        item('performance', 'ios', 'pass'),
        item('performance', 'web', 'unknown'),
        item('UI quality', 'ios', 'fail'),
        item('UI quality', 'web', 'pass'),
      ]),
    ).toEqual([
      { name: 'static check', result: 'pass' },
      { name: 'performance', result: 'unknown' },
      { name: 'UI quality', result: 'fail' },
    ]);
  });
});
