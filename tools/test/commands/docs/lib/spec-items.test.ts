import { describe, expect, it } from 'vitest';
import { mdLines } from '../../../../src/commands/core/lib/spec-md.ts';
import { readSpec } from '../../../../src/commands/core/lib/spec-parse.ts';
import type { DocFile } from '../../../../src/commands/docs/lib/files.ts';
import {
  checkAdminOperation,
  checkCoreErrorOwner,
  checkOnceKeyPrefix,
  checkSettingsTable,
  checkSpecDevTable,
  checkSpecHeading,
  checkTestingDev,
  envPath,
  specHeadings,
  type SpecDoc,
} from '../../../../src/commands/docs/lib/spec-items.ts';
import { spec } from '../../core/lib/spec-fixture.ts';

const vocabulary = { dataTypes: new Set(['none']), purposes: new Set<string>() };

function specDoc(name: string, text: string, side: 'client' | 'server' = 'server'): SpecDoc {
  const folder = side === 'server' ? 'skills/server-core/modules' : 'skills/client-core/modules';
  const entry = { name, side, spec: `/h/${folder}/${name}.md`, specRel: `${folder}/${name}.md` };
  const lines = mdLines(text);
  return { entry, lines, parsed: readSpec(entry, lines, vocabulary, new Set([name, 'A', 'B'])) };
}

function doc(rel: string, text: string): DocFile {
  return { rel, abs: `/h/${rel}`, lines: mdLines(text) };
}

const SETTINGS = '| key | type | source | owner | meaning |\n|---|---|---|---|---|\n';

describe('settings table', () => {
  it('fails settings keys and game settings paths written outside the spec ## settings', () => {
    const a = specDoc('A', spec('A', {
      API: 'uses `A.waitMs` and `B.maxMs` and `gamepadSupported` and `B.maxMs`\n```\n`B.maxMs`\n```',
      behavior: 'game settings `environments.DEV.host` and game settings `x.y`, `Unknown.key`, `appId`',
      settings: `${SETTINGS}| \`A.waitMs\` | integer | core | content | m |\n| \`environments.<ENV>.host\` | string | game | none | m |\n\nsee \`B.maxMs\``,
    }), 'client');
    const b = specDoc('B', spec('B', {
      settings: `${SETTINGS}| \`B.maxMs\` | integer | core | content | m |\n| \`gamepadSupported\` | boolean | game | none | m |`,
      API: '`B.maxMs` `appId`',
    }), 'client');
    expect(checkSettingsTable([a, b]).map((f) => `${f.where} ${f.reason}`)).toEqual([
      'skills/client-core/modules/A.md:13 settings key `gamepadSupported` is not in this spec\'s ## settings',
      'skills/client-core/modules/A.md:20 settings key `x.y` is not in this spec\'s ## settings',
    ]);
  });

  it('writes the environment of a path as <ENV>', () => {
    expect(envPath('environments.STG.adapters')).toBe('environments.<ENV>.adapters');
    expect(envPath('environments.QA.adapters')).toBe('environments.QA.adapters');
    expect(envPath('x.environments.DEV.y')).toBe('x.environments.DEV.y');
  });
});

describe('spec heading', () => {
  const core = doc('skills/core/SKILL.md', '# core\n\n## spec\n\n| heading | contents |\n|---|---|\n| `## purpose` | x |\n| `## test` | y |\n');

  it('reads the heading order of the core skill', () => {
    expect(specHeadings(core)).toEqual(['## purpose', '## test']);
    expect(specHeadings(doc('x.md', '# x\n'))).toBeNull();
    expect(specHeadings(doc('x.md', '## spec\n\ntext\n'))).toBeNull();
  });

  it('fails a spec whose ## headings differ', () => {
    const ok = specDoc('ok', '# ok\n## purpose\n### sub\n## test\n```\n## no\n```\n');
    const bad = specDoc('bad', '# bad\n## test\n## purpose\n');
    const short = specDoc('short', '# s\n## purpose\n');
    expect(checkSpecHeading([ok, bad, short], ['## purpose', '## test'])).toEqual([
      { item: 'spec heading', where: 'skills/server-core/modules/bad.md', reason: 'headings are [## test, ## purpose]; the core skill ## spec order is [## purpose, ## test]' },
      { item: 'spec heading', where: 'skills/server-core/modules/short.md', reason: 'headings are [## purpose]; the core skill ## spec order is [## purpose, ## test]' },
    ]);
  });
});

describe('spec DEV table', () => {
  it('needs "failure value" after "output" when an output does not start with none', () => {
    const dev = [
      '| operation | input | output | caller |',
      '|---|---|---|---|',
      '| `a` | x | none | y |',
      '',
      '| operation | input | output | caller |',
      '|---|---|---|---|',
      '| `b` | x | value | y |',
      '',
      '| operation | input | output | failure value | caller |',
      '|---|---|---|---|---|',
      '| `c` | x | value | none | y |',
      '',
      '| message | field |',
      '|---|---|',
      '| `M` | value |',
      '',
      '| operation | input |',
      '|---|---|',
      '| `d` | value |',
    ].join('\n');
    const s = specDoc('m', spec('m', { DEV: dev }));
    expect(checkSpecDevTable([s, specDoc('n', '# n\n')])).toEqual([
      { item: 'spec DEV table', where: 'skills/server-core/modules/m.md:45', reason: 'an output does not start with "none", so the column after "output" must be "failure value"' },
    ]);
  });
});

describe('core error owner', () => {
  const proto = (rows: string): DocFile =>
    doc('skills/server-core/base-proto.md', `# b\n\n## CoreError\n\ntext\n\n| \`CoreError\` | number | module |\n|---|---|---|\n${rows}\n\n## next\n`);

  it('passes when numbers count from 1 and the pairs match the specs', () => {
    const p = proto('| `X` | 1 | `a` |\n| `Y` | 2 | `a` |\n| `Z` | 3 | `b` |');
    const a = specDoc('a', spec('a', { error: '| condition | failure value | log |\n|---|---|---|\n\nAdded `CoreError`: `X`, `Y`. `Z` is added by b' }));
    const b = specDoc('b', spec('b', { error: 'Added `CoreError`: `Z`' }));
    const c = specDoc('c', spec('c', { error: 'Added `CoreError`: none' }));
    expect(checkCoreErrorOwner(p, [a, b, c])).toEqual([]);
  });

  it('fails wrong numbers, missing lines, and pairs on one side only', () => {
    const p = proto('| `X` | 1 | `a` |\n| `Y` | 3 | `a` |\n| `W` | 3 | `b` |');
    const a = specDoc('a', spec('a', { error: 'Added `CoreError`: `X`, `V`' }));
    const b = specDoc('b', spec('b', { error: 'none' }));
    const d = specDoc('d', spec('d', { error: 'Added `CoreError`: none\nAdded `CoreError`: none' }));
    const client = specDoc('Client', spec('Client'), 'client');
    expect(checkCoreErrorOwner(p, [a, b, d, client]).map((f) => `${f.where} ${f.reason}`)).toEqual([
      'skills/server-core/base-proto.md:10 number must be 2',
      'skills/server-core/modules/b.md ## error has 0 lines starting with "Added `CoreError`:"; it must have one',
      'skills/server-core/modules/d.md ## error has 2 lines starting with "Added `CoreError`:"; it must have one',
      'skills/server-core/base-proto.md:10 (Y, a) is in the CoreError table but not in the specs\' "Added `CoreError`:" lines',
      'skills/server-core/base-proto.md:11 (W, b) is in the CoreError table but not in the specs\' "Added `CoreError`:" lines',
      'skills/server-core/modules/a.md:29 (V, a) is in the specs\' "Added `CoreError`:" lines but not in the CoreError table',
    ]);
  });

  it('fails without the CoreError table', () => {
    expect(checkCoreErrorOwner(doc('skills/server-core/base-proto.md', '## CoreError\n\n| a | b |\n|---|---|\n'), [])).toEqual([
      { item: 'core error owner', where: 'skills/server-core/base-proto.md', reason: 'no ## CoreError table with columns CoreError, number, module' },
    ]);
    expect(checkCoreErrorOwner(doc('x.md', '# x\n'), [])).toHaveLength(1);
  });

  it('fails a spec without ## error', () => {
    const p = proto('');
    expect(checkCoreErrorOwner(p, [specDoc('e', '# e\n')])[0]?.reason).toBe('## error has 0 lines starting with "Added `CoreError`:"; it must have one');
  });
});

describe('once_key prefix', () => {
  const ledger = (line: string): SpecDoc => specDoc('item-ledger', spec('item-ledger', { behavior: line }));

  it('compares the item-ledger prefixes with the specs\' prefix lines', () => {
    const l = ledger('- core `once_key` prefix: the start of a `once_key` that a core module passes. `ad:`, `shop:`');
    const ad = specDoc('ads', spec('ads', { behavior: '- `once_key` prefix: `ad:`', API: '- `once_key` prefix: `zz:`' }));
    const shop = specDoc('shop', spec('shop', { behavior: '- `once_key` prefix: `shop:`, `extra:`\n```\n- `once_key` prefix: `fenced:`\n```' }));
    const none = specDoc('none', '# none\n');
    expect(checkOnceKeyPrefix([l, ad, shop, none]).map((f) => `${f.where} ${f.reason}`)).toEqual([
      'skills/server-core/modules/shop.md:17 (extra:) is in the specs\' once_key prefix lines but not in the item-ledger core once_key prefix line',
    ]);
    expect(checkOnceKeyPrefix([l, ad]).map((f) => f.reason)).toEqual([
      '(shop:) is in the item-ledger core once_key prefix line but not in the specs\' once_key prefix lines',
    ]);
  });

  it('fails without item-ledger or its prefix line', () => {
    expect(checkOnceKeyPrefix([])).toEqual([{ item: 'once_key prefix', where: '', reason: 'no item-ledger spec' }]);
    expect(checkOnceKeyPrefix([ledger('none')])[0]?.reason).toBe('no bullet line "- core `once_key` prefix: "');
    expect(checkOnceKeyPrefix([specDoc('item-ledger', '# x\n', 'client')])[0]?.reason).toBe('no item-ledger spec');
  });
});

describe('testing DEV operation', () => {
  const testingSpec = (rows: string): SpecDoc =>
    specDoc('testing', spec('testing', { behavior: `- x\n\n  testing DEV operation\n\n  | module | operation | called by |\n  |---|---|---|\n${rows}` }));
  const dev = (ops: string): string => `| operation | input | output | caller |\n|---|---|---|---|\n${ops}`;

  it('compares the testing table with the specs\' DEV operations that testing calls', () => {
    const t = testingSpec('  | `a` | `set_x` | `call_dev` |\n  | `b` | `gone` | `call_dev` |');
    const a = specDoc('a', spec('a', { DEV: dev('| `set_x` | x | none | content, `testing` |\n| `Cheat` (core cheat). changes: none | x | none | `testing` |\n| `other` | x | none | `routing` |\n| text | x | none | `testing` |') }));
    const b = specDoc('b', spec('b', { DEV: dev('| `new_op` | x | none | `testing` |') }));
    expect(checkTestingDev([t, a, b]).map((f) => `${f.where} ${f.reason}`)).toEqual([
      'skills/server-core/modules/testing.md:24 (b, gone) is in the testing DEV operation table but not in the specs\' ## DEV tables',
      'skills/server-core/modules/b.md:43 (b, new_op) is in the specs\' ## DEV tables but not in the testing DEV operation table',
    ]);
  });

  it('fails without the testing table', () => {
    expect(checkTestingDev([])).toEqual([{ item: 'testing DEV operation', where: '', reason: 'no "testing DEV operation" table with columns module, operation' }]);
    expect(checkTestingDev([specDoc('testing', '# t\n')])[0]?.where).toBe('skills/server-core/modules/testing.md');
    expect(checkTestingDev([specDoc('testing', 'testing DEV operation\n\n| a | b |\n|---|---|\n')])).toHaveLength(1);
  });
});

describe('admin operation', () => {
  const adminSpec = (rows: string): SpecDoc =>
    specDoc('admin-api', spec('admin-api', {
      API: `| module | admin operation | role |\n|---|---|---|\n${rows}\n\n| operation | input | output | failure value | caller |\n|---|---|---|---|---|\n| \`own\` | x | y | none | operator |`,
    }));
  const api = (rows: string): string => `| operation | input | output | failure value | caller |\n|---|---|---|---|---|\n${rows}`;

  it('compares the admin-api table with the specs\' operator operations', () => {
    const admin = adminSpec('| `a` | `x`, `y` | `read` |\n| `game` | content admin operation | role |\n| `b` | `gone` | `ops` |');
    const a = specDoc('a', spec('a', { API: api('| `x` | i | o | none | operator |\n| `y` | i | o | none | `operator` |\n| `z` | i | o | none | content code |') }));
    const b = specDoc('b', spec('b', { API: api('| `extra` | i | o | none | operator |') }));
    expect(checkAdminOperation([admin, a, b]).map((f) => `${f.where} ${f.reason}`)).toEqual([
      'skills/server-core/modules/admin-api.md:17 (b, gone) is in the admin-api admin operation table but not in the specs\' operator operations',
      'skills/server-core/modules/b.md:15 (b, extra) is in the specs\' operator operations but not in the admin-api admin operation table',
    ]);
  });

  it('fails without the admin table', () => {
    expect(checkAdminOperation([])).toEqual([{ item: 'admin operation', where: '', reason: 'no table with columns module, admin operation, role' }]);
    expect(checkAdminOperation([specDoc('admin-api', '# a\n')])[0]?.where).toBe('skills/server-core/modules/admin-api.md');
  });
});
