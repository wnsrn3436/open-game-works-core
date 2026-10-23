import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFromHarness, collectedDataVocabulary } from '../../../../src/commands/core/lib/spec-build.ts';
import { readModuleEntries } from '../../../../src/commands/core/lib/spec-modules.ts';
import { formatArgumentList, isCoreKey } from '../../../../src/commands/core/lib/spec-parse.ts';
import { realHarness } from '../../../helpers/workspace.ts';
import { BASIC_CLIENT, BASIC_SERVER, spec, writeSpecHarness, type FixtureModule } from './spec-fixture.ts';

const dirs: string[] = [];
function harness(client: readonly FixtureModule[] = BASIC_CLIENT, server: readonly FixtureModule[] = BASIC_SERVER): string {
  const dir = writeSpecHarness(client, server);
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function withModule(name: string, file: string, body: string, side: 'client' | 'server' = 'client'): string {
  const extra = { name, file, body };
  return side === 'client' ? harness([...BASIC_CLIENT, extra]) : harness(BASIC_CLIENT, [...BASIC_SERVER, extra]);
}

describe('module entries', () => {
  it('reads both module tables with the side and the spec path', async () => {
    const entries = await readModuleEntries(harness());
    expect(entries.map((e) => [e.name, e.side, e.specRel])).toEqual([
      ['LogCore', 'client', 'skills/client-core/modules/log-core.md'],
      ['AlphaCore', 'client', 'skills/client-core/modules/alpha-core.md'],
      ['BetaCore', 'client', 'skills/client-core/modules/beta-core.md'],
      ['DeltaCore', 'client', 'skills/client-core/modules/delta-core.md'],
      ['QaCore', 'client', 'skills/client-core/modules/qa-core.md'],
      ['gamma', 'server', 'skills/server-core/modules/gamma.md'],
      ['storage', 'server', 'skills/server-core/modules/storage.md'],
    ]);
  });

  it('fails on a missing skill, section, table or malformed row', async () => {
    const dir = harness();
    writeFileSync(join(dir, 'skills/server-core/SKILL.md'), '# s\n\n## other\n');
    await expect(readModuleEntries(dir)).rejects.toThrow('skills/server-core/SKILL.md: no "## module" section');
    writeFileSync(join(dir, 'skills/server-core/SKILL.md'), '# s\n\n## module\n\n| a | b |\n|---|---|\n');
    await expect(readModuleEntries(dir)).rejects.toThrow('no module table with columns "module", "spec"');
    writeFileSync(join(dir, 'skills/server-core/SKILL.md'), '# s\n\n## module\n\n| module | spec |\n|---|---|\n| gamma | none |\n');
    await expect(readModuleEntries(dir)).rejects.toThrow('skills/server-core/SKILL.md:7: module row needs');
    rmSync(join(dir, 'skills/server-core/SKILL.md'));
    await expect(readModuleEntries(dir)).rejects.toThrow('file not found');
  });
});

describe('collected data vocabulary', () => {
  it('reads data types and purposes of the core skill', async () => {
    const vocabulary = await collectedDataVocabulary(harness());
    expect([...vocabulary.dataTypes]).toEqual(['none', 'user_id', 'device_id']);
    expect([...vocabulary.purposes]).toEqual(['app_functionality', 'analytics', 'fraud_prevention']);
  });

  it('fails without the tables', async () => {
    const dir = harness();
    writeFileSync(join(dir, 'skills/core/SKILL.md'), '# core\n\n## collected data\n\nnone\n');
    await expect(collectedDataVocabulary(dir)).rejects.toThrow('needs the "data type" and "purpose" tables');
    writeFileSync(join(dir, 'skills/core/SKILL.md'), '# core\n');
    await expect(collectedDataVocabulary(dir)).rejects.toThrow('needs the "data type" and "purpose" tables');
  });
});

describe('buildFromHarness', () => {
  it('builds every field of a module object in the core spec file form', async () => {
    const result = await buildFromHarness(harness());
    expect(result.errors).toEqual([]);
    expect([...result.modules.keys()]).toEqual(['LogCore', 'AlphaCore', 'BetaCore', 'DeltaCore', 'QaCore', 'gamma', 'storage']);
    expect(result.modules.get('AlphaCore')).toEqual({
      name: 'AlphaCore',
      side: 'client',
      lifecycle: true,
      dependencies: ['LogCore', 'BetaCore', 'gamma'],
      optionalDependencies: ['DeltaCore'],
      devDependencies: ['QaCore'],
      settings: [
        { key: 'AlphaCore.waitMs', type: 'integer', source: 'core', owner: 'content' },
        { key: 'gamepadSupported', type: 'boolean?', source: 'game', owner: 'none' },
        { key: 'AlphaCore.listOfLists', type: 'array<array<string>>', source: 'core', owner: 'human' },
      ],
      settingsConstraints: [{ left: 'AlphaCore.waitMs', factor: 2, right: 'BetaCore.maxMs' }],
      tables: [
        {
          name: 'alpha',
          columns: [
            { description: '', target: 'All', type: 'id(key)', name: 'id' },
            { description: '', target: 'Client', type: 'ref<beta.id>?', name: 'beta' },
            { description: '', target: 'All', type: 'array<ref<gamma_table.id>>', name: 'gammas' },
          ],
        },
      ],
      usedTables: ['beta', 'gamma_table'],
      enums: [{ type: 'AlphaKind', elements: ['One', 'Two'] }],
      invariants: [{ kind: 'order_column', table: 'alpha', column: 'id', group: '', min: '1', max: '', child_table: '', child_column: '' }],
      reserved: [
        { table: 'reserved_string', id: '[alpha_title]', requiredWhen: null, rowOf: null },
        { table: 'reserved_string', id: '[alpha_body]', requiredWhen: null, rowOf: null },
        { table: 'reserved_id', id: '[alpha_row]', requiredWhen: { path: 'alpha.on', value: true }, rowOf: 'beta' },
        { table: 'reserved_string', id: '[alpha_multi]', requiredWhen: null, rowOf: null },
        { table: 'reserved_sound', id: '[alpha_multi]', requiredWhen: null, rowOf: null },
        { table: 'reserved_id', id: '[alpha_x]', requiredWhen: { path: 'alpha.mode', value: 'hard' }, rowOf: 'alpha' },
        { table: 'reserved_id', id: '[alpha_y]', requiredWhen: { path: 'alpha.mode', value: 'hard' }, rowOf: 'alpha' },
        { table: 'reserved_id', id: '[alpha_z]', requiredWhen: null, rowOf: null },
        { table: 'reserved_sound', id: '[alpha_click]', requiredWhen: null, rowOf: null },
      ],
      formatArguments: [
        { text: '[alpha_title]', arguments: [{ name: 'count', kind: 'integer' }, { name: 'name', kind: 'string' }] },
        { text: 'alpha.id', arguments: [] },
      ],
      collectedData: [
        {
          dataType: 'device_id',
          description: 'ad ID',
          source: 'ads-admob',
          purposes: ['analytics', 'fraud_prevention'],
          linked: false,
          tracking: true,
          shared: true,
          optional: false,
          platforms: ['android', 'ios'],
          condition: null,
        },
        {
          dataType: 'user_id',
          description: 'user ID',
          source: 'module',
          purposes: ['app_functionality'],
          linked: true,
          tracking: false,
          shared: false,
          optional: true,
          platforms: ['android', 'ios', 'web', 'windows', 'macos', 'linux'],
          condition: { path: 'consent.age', value: true },
        },
        {
          dataType: 'none',
          description: 'nothing',
          source: 'ads-other',
          purposes: [],
          linked: false,
          tracking: false,
          shared: false,
          optional: false,
          platforms: [],
          condition: null,
        },
      ],
      adapters: ['ads-admob'],
      operations: [
        { name: 'show', inputs: ['translationKey', 'other', 'other'] },
        { name: 'log_a', inputs: ['other', 'other'] },
        { name: 'log_b', inputs: ['other', 'other'] },
        { name: 'reset', inputs: [] },
        { name: 'bind', inputs: ['other', 'translationKey'] },
      ],
    });
    expect(result.modules.get('gamma')).toMatchObject({ dependencies: [], devDependencies: ['storage'], enums: [], usedTables: [] });
    expect(result.modules.get('LogCore')).toMatchObject({ lifecycle: false, settings: [], tables: [], reserved: [], collectedData: [], adapters: [], operations: [] });
    expect(result.modules.get('BetaCore')).toMatchObject({ lifecycle: true });
    expect(result.modules.get('storage')).toMatchObject({ lifecycle: false });
  });

  it('reports a dependency line that names no module, but not lines that are not dependency lines', async () => {
    const body = spec('EpsCore', { dependency: '`LogCore`, `Missing`\n\n- `Other` is note\n- optional dependency: `Gone`' });
    const result = await buildFromHarness(withModule('EpsCore', 'eps-core', body));
    expect(result.errors).toEqual([
      'skills/client-core/modules/eps-core.md:9: dependency line names `Missing`, which is not a module',
      'skills/client-core/modules/eps-core.md:12: dependency line names `Gone`, which is not a module',
    ]);
  });

  it('reports tables named by used table lines and arrows without a table definition', async () => {
    const body = spec('EpsCore', { data: 'used table: `nowhere`\n\n- reserved ID: `[eps_a]` → row of `void`\n\nreserved ID\n\n| name | used by |\n|---|---|\n| `[eps_b]` | → row of `beta` |' });
    const result = await buildFromHarness(withModule('EpsCore', 'eps-core', body));
    expect(result.errors).toEqual([
      'skills/client-core/modules/eps-core.md:37: table `nowhere` has no table definition in any module',
      'skills/client-core/modules/eps-core.md:39: table `void` has no table definition in any module',
    ]);
  });

  it('reports table definition, enum, invariant and format argument form violations', async () => {
    const data = [
      '`data/tables/eps.csv`',
      '',
      '| column | type |',
      '|---|---|',
      '',
      '`data/tables/eps2.csv`',
      '',
      '| column | type | build target |',
      '|---|---|---|',
      '| `id` | id | `All` |',
      '',
      '`data/tables/eps3.csv`',
      'text',
      '',
      '`data/enums.csv`',
      '',
      '| type | element | x |',
      '|---|---|---|',
      '',
      '`data/enums.csv`',
      '',
      '| type | element |',
      '|---|---|',
      '| `K` | `A`; `B` |',
      '| K | `A` |',
      '',
      '`data/invariants.csv`',
      '',
      '| kind | table |',
      '|---|---|',
      '',
      '`data/invariants.csv`',
      '',
      '| kind | table | column | group | min | max | child_table | child_column |',
      '|---|---|---|---|---|---|---|---|',
      '| order_column | `eps` | | | | | | |',
      '| `a` | | | | | | |',
      '',
      'format argument',
      '',
      '| text | args |',
      '|---|---|',
      '',
      'format argument',
      '',
      '| text | arguments |',
      '|---|---|',
      '| `[nope]` | none |',
      '| `beta.nope` | none |',
      '| `nodot` | none |',
      '| `beta.id` | `{n}`(`float`) |',
      '| text | none |',
    ].join('\n');
    const result = await buildFromHarness(withModule('EpsCore', 'eps-core', spec('EpsCore', { data })));
    const f = 'skills/client-core/modules/eps-core.md';
    expect(result.errors).toEqual([
      `${f}:39: table definition header must start with "column", "type", "build target"`,
      `${f}:46: table definition cells "column", "type", "build target" must each be one code span`,
      `${f}:48: table definition of \`eps3\` has no table right after the line`,
      `${f}:53: enum table header must be "type", "element"`,
      `${f}:60: enum table row needs a type code span and element code spans joined by ", " or "set by the game"`,
      `${f}:61: enum table row needs a type code span and element code spans joined by ", " or "set by the game"`,
      `${f}:65: invariant table header must be "kind", "table", "column", "group", "min", "max", "child_table", "child_column"`,
      `${f}:72: invariant table cells must be empty or one code span`,
      `${f}:73: invariant table cells must be empty or one code span`,
      `${f}:77: format argument table header must be "text", "arguments"`,
      `${f}:84: format argument text \`[nope]\` is not a reserved string, reserved ID or <table>.<column> of a table definition`,
      `${f}:85: format argument text \`beta.nope\` is not a reserved string, reserved ID or <table>.<column> of a table definition`,
      `${f}:86: format argument text \`nodot\` is not a reserved string, reserved ID or <table>.<column> of a table definition`,
      `${f}:87: format argument row needs a text code span and "none" or \`{<name>}\`(\`<kind>\`) joined by ", "`,
      `${f}:88: format argument row needs a text code span and "none" or \`{<name>}\`(\`<kind>\`) joined by ", "`,
    ]);
  });

  it('reports enum, invariant and format argument lines without a table', async () => {
    const data = '`data/enums.csv`\n\ntext\n\n`data/invariants.csv`\n\nformat argument\n';
    const result = await buildFromHarness(withModule('EpsCore', 'eps-core', spec('EpsCore', { data })));
    const f = 'skills/client-core/modules/eps-core.md';
    expect(result.errors).toEqual([
      `${f}:37: enum table has no table right after the line`,
      `${f}:41: invariant table has no table right after the line`,
      `${f}:43: format argument table has no table right after the line`,
    ]);
  });

  it('reports settings table and settings constraint table violations', async () => {
    const settings = [
      '| key | type | source | owner | meaning |',
      '|---|---|---|---|---|',
      '| key | integer | core | content | m |',
      '| `EpsCore.a` | int | core | content | m |',
      '| `EpsCore.Bad` | integer | core | content | m |',
      '| `Unknown.a` | integer | core | content | m |',
      '| `EpsCore.b` | integer | core | none | m |',
      '| `g` | integer | game | content | m |',
      '| `g` | integer | other | none | m |',
      '| `g` | array<thing> | game | none | m |',
      '| `g` | array<array<thing>> | game | none | m |',
      '| `g` | array<array<integer>>? | game | none | m |',
      '',
      'settings constraint',
      '',
      '| left | factor | right |',
      '|---|---|---|',
      '| `EpsCore.a` | 0 | `EpsCore.b` |',
      '| `EpsCore.a` | 2 | `nokey` |',
      '| `AlphaCore.waitMs` | 2 | `BetaCore.maxMs` |',
      '',
      'settings constraint',
      '',
      '| a | b |',
      '|---|---|',
      '',
      'settings constraint',
    ].join('\n');
    const result = await buildFromHarness(withModule('EpsCore', 'eps-core', spec('EpsCore', { settings })));
    const f = 'skills/client-core/modules/eps-core.md';
    expect(result.errors).toEqual([
      `${f}:35: settings "key" cell must be one code span`,
      `${f}:36: settings type "int" is not integer, number, string, boolean, object or array<T>, with an optional "?"`,
      `${f}:37: core settings key \`EpsCore.Bad\` is not <module>.<camelCase>`,
      `${f}:38: core settings key \`Unknown.a\` is not <module>.<camelCase>`,
      `${f}:39: settings owner of a core key must be "content" or "human"`,
      `${f}:40: settings owner of a game item must be "none"`,
      `${f}:41: settings source must be "core" or "game"`,
      `${f}:42: settings type "array<thing>" is not integer, number, string, boolean, object or array<T>, with an optional "?"`,
      `${f}:43: settings type "array<array<thing>>" is not integer, number, string, boolean, object or array<T>, with an optional "?"`,
      `${f}:50: settings constraint row needs core settings key code spans "left", "right" and an integer "factor" of 1 or more`,
      `${f}:51: settings constraint row needs core settings key code spans "left", "right" and an integer "factor" of 1 or more`,
      `${f}:52: the same settings constraint is also in skills/client-core/modules/alpha-core.md:${String(result.specs[1]?.settingsConstraints[0]?.n)}`,
      `${f}:56: settings constraint table header must be "left", "factor", "right"`,
      `${f}:59: settings constraint table has no table right after the line`,
    ]);
  });

  it('reports a settings table with another header', async () => {
    const settings = '| key | type |\n|---|---|\n| `EpsCore.a` | integer |';
    const result = await buildFromHarness(withModule('EpsCore', 'eps-core', spec('EpsCore', { settings })));
    expect(result.errors).toEqual(['skills/client-core/modules/eps-core.md:33: settings table header must be "key", "type", "source", "owner", "meaning"']);
  });

  it('reports collected data table violations', async () => {
    const head = '| data type | description | source | purposes | linked | tracking | shared | optional | platforms | condition |\n|---|---|---|---|---|---|---|---|---|---|';
    const rows = [
      '| `pet_name` | d | `module` | `analytics` | `true` | `true` | `true` | `true` | `all` | `none` |',
      '| `user_id` | d | | `analytics` | `true` | `true` | `true` | `true` | `all` | `none` |',
      '| `none` | d | `module` | `analytics` | `none` | `none` | `none` | `none` | `none` | `none` |',
      '| `user_id` | d | `module` | `fun` | `true` | `true` | `true` | `true` | `all` | `none` |',
      '| `user_id` | d | `module` | `analytics` | `yes` | `true` | `true` | `true` | `all` | `none` |',
      '| `user_id` | d | `module` | `analytics` | `true` | `true` | `true` | `true` | `ps5` | `none` |',
      '| `user_id` | d | `module` | `analytics` | `true` | `true` | `true` | `true` | `all` | `a.b = nope` |',
      '| `user_id` | d | `module` | `analytics` | `true` | `true` | `true` | `true` | `all` | `a.b` |',
      '| `user_id` | d |',
    ];
    const behavior = ['### collected data', '', head, ...rows, '', '### collected data', '', '| data type | x |', '|---|---|', '', '### collected data', 'text'].join('\n');
    const result = await buildFromHarness(withModule('EpsCore', 'eps-core', spec('EpsCore', { behavior })));
    const f = 'skills/client-core/modules/eps-core.md';
    expect(result.errors).toEqual([
      `${f}:21: collected data type "pet_name" is not a data type of the core skill`,
      `${f}:22: collected data source is empty`,
      `${f}:23: collected data row of data type "none" must have "none" in purposes, linked, tracking, shared, optional, platforms, condition`,
      `${f}:24: collected data purposes must be purposes of the core skill joined by ", "`,
      `${f}:25: collected data linked, tracking, shared, optional must be "true" or "false"`,
      `${f}:26: collected data platforms must be "all" or platforms of android, ios, web, windows, macos, linux joined by ", "`,
      `${f}:27: collected data condition must be "none" or "<game settings path> = <JSON value>"`,
      `${f}:28: collected data condition must be "none" or "<game settings path> = <JSON value>"`,
      `${f}:29: collected data row must have 10 cells`,
      `${f}:33: collected data table header must be "data type", "description", "source", "purposes", "linked", "tracking", "shared", "optional", "platforms", "condition"`,
      `${f}:36: collected data table has no table right after the line`,
    ]);
  });

  it('keeps adapters only from a table with the adapter header', async () => {
    const behavior = '### real adapter\n\n| key | adapter |\n|---|---|\n| `a` | `b` |\n\n### real adapter\n\ntext';
    const result = await buildFromHarness(withModule('EpsCore', 'eps-core', spec('EpsCore', { behavior })));
    expect(result.errors).toEqual([]);
    expect(result.modules.get('EpsCore')).toMatchObject({ adapters: [] });
  });

  it('sorts errors by module order and line', async () => {
    const body = spec('EpsCore', { dependency: '`Zed`', data: 'used table: `nowhere`' });
    const result = await buildFromHarness(harness([{ name: 'EpsCore', file: 'eps-core', body }, ...BASIC_CLIENT]));
    expect(result.errors).toEqual([
      'skills/client-core/modules/eps-core.md:9: dependency line names `Zed`, which is not a module',
      'skills/client-core/modules/eps-core.md:37: table `nowhere` has no table definition in any module',
    ]);
  });

  it('fails when a spec file is missing', async () => {
    const dir = harness();
    rmSync(join(dir, 'skills/client-core/modules/beta-core.md'));
    await expect(buildFromHarness(dir)).rejects.toThrow('spec file not found: skills/client-core/modules/beta-core.md');
  });

  it('reads the real harness specs without throwing', async () => {
    const result = await buildFromHarness(realHarness);
    expect(result.modules.size).toBe(result.entries.length);
    expect(result.modules.size).toBeGreaterThan(40);
  });
});

describe('helpers', () => {
  it('reads format argument lists', () => {
    expect(formatArgumentList('none')).toEqual([]);
    expect(formatArgumentList('`none`')).toEqual([]);
    expect(formatArgumentList('`{a}`(`real`)')).toEqual([{ name: 'a', kind: 'real' }]);
    expect(formatArgumentList('`{a}`(`real`),`{b}`(`real`)')).toBeNull();
    expect(formatArgumentList('`a`(`real`)')).toBeNull();
    expect(formatArgumentList('`{a}`')).toBeNull();
    expect(formatArgumentList('`{a}`(`real`')).toBeNull();
    expect(formatArgumentList('`{a}`(real)')).toBeNull();
  });

  it('tells core settings keys', () => {
    const names = new Set(['UICore', 'item-ledger']);
    expect(isCoreKey('UICore.fadeMs', names)).toBe(true);
    expect(isCoreKey('item-ledger.historyRetentionMs', names)).toBe(true);
    expect(isCoreKey('UICore.FadeMs', names)).toBe(false);
    expect(isCoreKey('Other.fadeMs', names)).toBe(false);
    expect(isCoreKey('UICore.fade.ms', names)).toBe(false);
  });
});
