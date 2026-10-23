import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mdLines } from '../../../../src/commands/core/lib/spec-md.ts';
import type { DocFile } from '../../../../src/commands/docs/lib/files.ts';
import {
  checkEnglish,
  checkReferences,
  checkSize,
  checkTerms,
  checkWriting,
  definedTerm,
  hasTableOfContents,
  vagueWord,
  vagueWords,
} from '../../../../src/commands/docs/lib/text-items.ts';

function doc(rel: string, text: string, root = '/h'): DocFile {
  return { rel, abs: join(root, rel), lines: mdLines(text) };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('terms', () => {
  it('reads the dash definition line form', () => {
    expect(definedTerm('- core: x')).toBe('core');
    expect(definedTerm('- Core Thing-2 x: y')).toBe('core thing-2 x');
    expect(definedTerm('harness is X')).toBeNull();
    expect(definedTerm('- run state is X. more')).toBeNull();
    expect(definedTerm('- 1abc: x')).toBeNull();
    expect(definedTerm('- a: x')).toBe('a');
    expect(definedTerm('- ab-: x')).toBeNull();
    expect(definedTerm('- `x`: y')).toBeNull();
    expect(definedTerm('  - core: x')).toBeNull();
    expect(definedTerm('- core:x')).toBeNull();
  });

  it('fails every definition line of a name defined twice, case-insensitively', () => {
    const docs = [
      doc('AGENTS.md', '# A\n\n## terms\n\n- core: one\n- table: t\n\n## other\n\n- core: outside terms\n'),
      doc('skills/a/SKILL.md', '# a\n\n- Core: two\n| - table: in a table |\n```\n- table: fenced\n```\n'),
      doc('skills/a/ref.md', '- core: not a SKILL.md\n'),
    ];
    expect(checkTerms(docs)).toEqual([
      { item: 'terms', where: 'AGENTS.md:5', reason: '"core" has 2 definition lines' },
      { item: 'terms', where: 'skills/a/SKILL.md:3', reason: '"core" has 2 definition lines' },
    ]);
  });

  it('fails synonyms written as words outside code', () => {
    const docs = [
      doc('agents/x.md', 'a SubAgent here\n`subagent` and sub-agent and dummyX\n```\nsubagent\n```\nthe main agent and game config, harness config, core config\n'),
      doc('tools/t.md', 'an orchestrator, a final asset, a placeholder asset, a dummy\n'),
      doc('other/x.md', 'subagent\n'),
    ];
    const reasons = checkTerms(docs).map((f) => `${f.where} ${f.reason}`);
    expect(reasons).toEqual([
      'agents/x.md:1 "subagent" is a synonym; write "sub-agent"',
      'agents/x.md:6 "main agent" is a synonym; write "lead agent"',
      'agents/x.md:6 "game config" is a synonym; write "game settings"',
      'agents/x.md:6 "harness config" is a synonym; write "harness settings"',
      'agents/x.md:6 "core config" is a synonym; write "core settings"',
      'tools/t.md:1 "dummy" is a synonym; write "placeholder resource"',
      'tools/t.md:1 "orchestrator" is a synonym; write "lead agent"',
      'tools/t.md:1 "final asset" is a synonym; write "final resource"',
      'tools/t.md:1 "placeholder asset" is a synonym; write "placeholder resource"',
    ]);
  });
});

describe('references', () => {
  function tree(files: Record<string, string>): { root: string; docs: DocFile[] } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-refs-')));
    dirs.push(root);
    const docs: DocFile[] = [];
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
      if (rel.endsWith('.md')) docs.push(doc(rel, text, root));
    }
    return { root, docs };
  }

  it('fails links to missing files and reference files not linked from SKILL.md', () => {
    const { root, docs } = tree({
      'AGENTS.md': '# A\n',
      'settings.json': '{}',
      'skills/a/SKILL.md': '[r](ref.md) [m](missing.md) [w](https://x.org/a) [t](#top) [ok](../../AGENTS.md#terms) [sp](my%20file.md) [bad](a%zz.md)\n```\n[f](fenced.md)\n```\n',
      'skills/a/ref.md': '[back](SKILL.md#x)\n',
      'skills/a/my file.md': 'x\n',
      'skills/a/sub/deep.md': 'x\n',
      'skills/b/SKILL.md': '[other](../a/sub/deep.md)\n',
    });
    expect(checkReferences(root, docs)).toEqual([
      { item: 'references', where: 'skills/a/SKILL.md:1', reason: 'link target missing.md does not exist' },
      { item: 'references', where: 'skills/a/SKILL.md:1', reason: 'link target a%zz.md does not exist' },
      { item: 'references', where: 'skills/a/sub/deep.md', reason: 'reference file is not linked from skills/a/SKILL.md' },
    ]);
  });

  it('fails agent lines that name a harness file without its link', () => {
    const { root, docs } = tree({
      'AGENTS.md': '# A\n',
      'settings.json': '{}',
      'schemas/game-settings.schema.json': '{}',
      'schemas/harness-settings.schema.json': '{}',
      'agents/x.md': [
        'read AGENTS.md',
        'read [AGENTS.md](../AGENTS.md)',
        'the harness settings',
        'the [harness settings](../settings.json)',
        'the [game settings schema](../schemas/game-settings.schema.json)',
        'the game settings schema',
        'the [harness settings schema](../schemas/harness-settings.schema.json) of [harness settings](../settings.json)',
        '```',
        'AGENTS.md',
        '```',
      ].join('\n'),
      'agents/sub/y.md': 'AGENTS.md\n',
    });
    expect(checkReferences(root, docs).map((f) => `${f.where} ${f.reason}`)).toEqual([
      'agents/x.md:1 line names AGENTS.md without a link to ../AGENTS.md',
      'agents/x.md:3 line names harness settings without a link to ../settings.json',
      'agents/x.md:6 line names game settings schema without a link to ../schemas/game-settings.schema.json',
    ]);
  });
});

describe('writing', () => {
  const agents = (list: string) => doc('AGENTS.md', `# a\n\n## harness writing rules\n\n${list}\n\n## other\n\n- Do not use words that cannot be judged: properly\n`);
  const rules = agents('- Do not use words that cannot be judged: properly, if possible, as much as possible');

  it('fails "etc." and "and so on" as words outside code', () => {
    const docs = [rules, doc('x.md', 'A, B, etc.\nfetch and so on\nset `etc` and Etcetera\n```\netc.\n```\n(etc) ETC\n')];
    expect(checkWriting(docs).slice(1)).toEqual([
      { item: 'writing', where: 'x.md:1', reason: 'uses "etc." or "and so on"' },
      { item: 'writing', where: 'x.md:2', reason: 'uses "etc." or "and so on"' },
      { item: 'writing', where: 'x.md:7', reason: 'uses "etc." or "and so on"' },
    ]);
  });

  it('reads the word list of ## harness writing rules', () => {
    expect(vagueWords(rules)).toEqual({ words: ['properly', 'if possible', 'as much as possible'], n: 5 });
    expect(vagueWords(agents('- Do not use words that cannot be judged: a , , b'))).toEqual({ words: ['a', 'b'], n: 5 });
  });

  it('fails without exactly one list line', () => {
    const none = { item: 'writing', where: 'AGENTS.md', reason: '## harness writing rules has 0 lines starting with "- Do not use words that cannot be judged: "; it must have one' };
    expect(vagueWords(undefined)).toEqual(none);
    expect(vagueWords(doc('AGENTS.md', '# a\n- Do not use words that cannot be judged: x\n'))).toEqual(none);
    expect(vagueWords(agents('```\n- Do not use words that cannot be judged: x\n```'))).toEqual(none);
    const two = agents('- Do not use words that cannot be judged: x\n- Do not use words that cannot be judged: y');
    expect(vagueWords(two)).toMatchObject({ reason: '## harness writing rules has 2 lines starting with "- Do not use words that cannot be judged: "; it must have one' });
    expect(checkWriting([doc('x.md', 'properly\n')])).toEqual([none]);
  });

  it('finds a listed word or phrase as whole words in any case', () => {
    const words = ['properly', 'if possible'];
    expect(vagueWord('Do it properly.', words)).toBe('properly');
    expect(vagueWord('(Properly)', words)).toBe('properly');
    expect(vagueWord('"properly"', words)).toBe('properly');
    expect(vagueWord('improperly or properlyx', words)).toBeNull();
    expect(vagueWord('Retry if possible', words)).toBe('if possible');
    expect(vagueWord('if it is possible', words)).toBeNull();
    expect(vagueWord('properly', [])).toBeNull();
  });

  it('fails lines that use a listed word outside code, but not the list line itself', () => {
    const docs = [rules, doc('x.md', 'Write it properly\n`properly`\nIf possible, retry\n```\nproperly\n```\netc. properly\n')];
    expect(checkWriting(docs)).toEqual([
      { item: 'writing', where: 'AGENTS.md:9', reason: 'uses "properly", which cannot be judged' },
      { item: 'writing', where: 'x.md:1', reason: 'uses "properly", which cannot be judged' },
      { item: 'writing', where: 'x.md:3', reason: 'uses "if possible", which cannot be judged' },
      { item: 'writing', where: 'x.md:7', reason: 'uses "etc." or "and so on"' },
      { item: 'writing', where: 'x.md:7', reason: 'uses "properly", which cannot be judged' },
    ]);
  });
});

describe('English', () => {
  it('fails Korean outside code spans and fences of harness documents', () => {
    const text = ['# 제목', '## English', '| 이름 | value |', '|---|---|', '| a | `없음` |', 'game text `시작` (Start) and `{name:이/가}`', '```', '# 제목', '```', '출석 calendar'].join('\n');
    const failures = checkEnglish([doc('skills/a/SKILL.md', text), doc('other.md', '# 제목\n')]);
    expect(failures.map((f) => `${f.where} ${f.reason}`)).toEqual([
      'skills/a/SKILL.md:1 Korean outside code spans',
      'skills/a/SKILL.md:3 Korean outside code spans',
      'skills/a/SKILL.md:10 Korean outside code spans',
    ]);
  });
});

describe('size', () => {
  const long = (n: number): string => Array.from({ length: n }, (_, i) => `line ${String(i)}`).join('\n');

  it('fails a SKILL.md body over 500 lines, not counting the front matter', () => {
    const front = '---\nname: a\ndescription: b\n---\n';
    expect(checkSize([doc('skills/a/SKILL.md', `${front}${long(500)}\n`)])).toEqual([]);
    expect(checkSize([doc('skills/a/SKILL.md', `${front}${long(501)}\n`)])).toEqual([
      { item: 'size', where: 'skills/a/SKILL.md', reason: 'SKILL.md body has 501 lines (max 500)' },
    ]);
    expect(checkSize([doc('skills/a/SKILL.md', `${long(501)}\n`)])).toHaveLength(1);
    expect(checkSize([doc('skills/a/SKILL.md', `---\n${long(501)}\n`)])).toHaveLength(1);
  });

  it('fails a reference file over 100 lines without a table of contents', () => {
    const body = `# R\n\n## one\n${long(50)}\n## two\n${long(50)}\n`;
    expect(checkSize([doc('skills/a/ref.md', body)])).toEqual([
      { item: 'size', where: 'skills/a/ref.md', reason: 'reference file has 104 lines and no table of contents at the top' },
    ]);
    expect(checkSize([doc('skills/a/ref.md', `# R\n\n- one\n- two\n\n${body.slice(5)}`)])).toEqual([]);
    expect(checkSize([doc('skills/a/short.md', '# R\n')])).toEqual([]);
    expect(checkSize([doc('agents/long.md', body)])).toEqual([]);
  });

  it('reads a table of contents of ## and ### titles in order', () => {
    const toc = (bullets: string): boolean => hasTableOfContents(mdLines(`# R\n\nintro\n\n${bullets}\n\n## one\n### sub\n## two\n`));
    expect(toc('- one\n- two')).toBe(true);
    expect(toc('- one\n- sub\n- two')).toBe(true);
    expect(toc('- two\n- one')).toBe(false);
    expect(toc('- one')).toBe(false);
    expect(toc('- one\n- other\n- two')).toBe(false);
    expect(toc('- one\n\n- two')).toBe(false);
    expect(hasTableOfContents(mdLines('# R\n\n- a\n'))).toBe(false);
  });
});
