// A small harness with module tables and specs for core spec tests.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const CORE_SKILL = `# core

## collected data

data type

| data type | meaning |
|---|---|
| \`none\` | x |
| \`user_id\` | x |
| \`device_id\` | x |

purpose

| purpose | meaning |
|---|---|
| \`app_functionality\` | x |
| \`analytics\` | x |
| \`fraud_prevention\` | x |
`;

export interface FixtureModule {
  name: string;
  file: string;
  body: string;
}

function moduleSkill(title: string, modules: readonly FixtureModule[]): string {
  const rows = modules.map((m) => `| \`${m.name}\` | [${m.file}](modules/${m.file}.md) | role |`).join('\n');
  return `# ${title}\n\n## module\n\n| module | spec | role |\n|---|---|---|\n${rows}\n\n## other\n`;
}

export function spec(name: string, sections: Partial<Record<string, string>> = {}): string {
  const headings = ['purpose', 'dependency', 'API', 'behavior', 'hook', 'event', 'error', 'settings', 'data', 'DEV', 'test'];
  return `# ${name}\n\n${headings.map((h) => `## ${h}\n\n${sections[h] ?? 'none'}\n`).join('\n')}`;
}

/** Writes the skill files and specs into `root` (a new temporary folder when not given). */
export function writeSpecHarness(client: readonly FixtureModule[], server: readonly FixtureModule[], root?: string): string {
  const dir = root ?? realpathSync(mkdtempSync(join(tmpdir(), 'ogw-spec-')));
  const files: Record<string, string> = {
    'skills/core/SKILL.md': CORE_SKILL,
    'skills/client-core/SKILL.md': moduleSkill('client core', client),
    'skills/server-core/SKILL.md': moduleSkill('server core', server),
  };
  for (const m of client) files[`skills/client-core/modules/${m.file}.md`] = m.body;
  for (const m of server) files[`skills/server-core/modules/${m.file}.md`] = m.body;
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

export const ALPHA = spec('AlphaCore', {
  API: [
    '| operation | input | output | failure value | caller |',
    '|---|---|---|---|---|',
    '| `show` | translation key, `FormatArgs`(optional, can be left out), extra text | none | none | content code |',
    '| `log_a`, `log_b` | tag, message | none | none | all code |',
    '| `reset` | none | none | none | content code |',
    '| `Login` (core rpc). changes: none | `LoginRequest` | x | x | client |',
    '',
    '- `AlphaParam`: body translation key',
    '',
    '| type | fields |',
    '|---|---|',
    '| `AlphaParam` | translation key |',
    '',
    '### component',
    '',
    '| component | operation | input | output | failure value | caller |',
    '|---|---|---|---|---|---|',
    '| `AlphaButton` | `set_label` | translation key | none | none | content code |',
    '',
    '| operation | input | output | failure value | caller |',
    '|---|---|---|---|---|',
    '| `bind` | UI text element, translation key or none | none | none | content code |',
    '```',
    '| operation | input |',
    '|---|---|',
    '| `fenced` | translation key |',
    '```',
  ].join('\n'),
  dependency: [
    '`LogCore`(log only), `BetaCore`',
    '',
    '- server dependency: `gamma`',
    '- optional dependency: `DeltaCore`. description',
    '- dev dependency: `QaCore`',
    '- `LogCore` is note',
    '```',
    '`Nope`',
    '```',
  ].join('\n'),
  behavior: [
    'text',
    '',
    '### real adapter',
    '',
    '| adapter key | real adapter |',
    '|---|---|',
    '| `ads` | `ads-admob` |',
    '| ads | bad |',
    '',
    '### collected data',
    '',
    '| data type | description | source | purposes | linked | tracking | shared | optional | platforms | condition |',
    '|---|---|---|---|---|---|---|---|---|---|',
    '| `device_id` | ad ID | `ads-admob` | `analytics`, `fraud_prevention` | `false` | `true` | `true` | `false` | `android`, `ios` | `none` |',
    '| `user_id` | user ID | `module` | `app_functionality` | `true` | `false` | `false` | `true` | `all` | `consent.age = true` |',
    '| `none` | nothing | `ads-other` | `none` | `none` | `none` | `none` | `none` | `none` | `none` |',
  ].join('\n'),
  settings: [
    '| key | type | source | owner | meaning |',
    '|---|---|---|---|---|',
    '| `AlphaCore.waitMs` | integer | core | content | m |',
    '| `gamepadSupported` | boolean? | game | none | m |',
    '| `AlphaCore.listOfLists` | `array<array<string>>` | core | human | m |',
    '',
    'settings constraint',
    '',
    '| left | factor | right |',
    '|---|---|---|',
    '| `AlphaCore.waitMs` | 2 | `BetaCore.maxMs` |',
  ].join('\n'),
  data: [
    '`data/tables/alpha.csv`. note',
    '',
    '| column | type | build target | extra |',
    '|---|---|---|---|',
    '| `id` | `id(key)` | `All` | x |',
    '| `#note` | | | |',
    '| `beta` | `ref<beta.id>?` | `Client` | |',
    '| `gammas` | `array<ref<gamma_table.id>>` | `All` | |',
    '',
    'used table: `gamma_table`, `beta`. note',
    '',
    '`data/enums.csv`',
    '',
    '| type | element |',
    '|---|---|',
    '| `AlphaKind` | `One`, `Two`. the game does not change them |',
    '| `AlphaCue` | set by the game. note |',
    '',
    '`data/invariants.csv`',
    '',
    '| kind | table | column | group | min | max | child_table | child_column |',
    '|---|---|---|---|---|---|---|---|',
    '| `order_column` | `alpha` | `id` | | `1` | | | |',
    '',
    '- reserved string: `[alpha_title]`(title), `[alpha_body]`',
    '- reserved ID: `[alpha_row]` → row of `beta`. required when game settings `alpha.on` is `true`',
    'reserved sound, reserved string: none',
    '- reserved string, reserved sound: `[alpha_multi]`',
    '- reserved sound: `notIdName`',
    '',
    'reserved ID',
    '',
    '| name | used by |',
    '|---|---|',
    '| `[alpha_x]`, `[alpha_y]` | → row of `alpha`. required when game settings `alpha.mode` is `"hard"` |',
    '| `[alpha_z]` | plain |',
    '| alpha_bad | skipped |',
    '',
    'reserved sound',
    '',
    '| name | used by |',
    '|---|---|',
    '| `[alpha_click]` | → row of `beta` |',
    '',
    'format argument',
    '',
    '| text | arguments |',
    '|---|---|',
    '| `[alpha_title]` | `{count}`(`integer`), `{name}`(`string`) |',
    '| `alpha.id` | none |',
  ].join('\n'),
});

export const BETA = spec('BetaCore', {
  dependency: '`LogCore`',
  settings: ['| key | type | source | owner | meaning |', '|---|---|---|---|---|', '| `BetaCore.maxMs` | integer | core | human | m |'].join('\n'),
  data: ['`data/tables/beta.csv`', '', '| column | type | build target |', '|---|---|---|', '| `id` | `id(key)` | `All` |'].join('\n'),
});

export const GAMMA = spec('gamma', {
  dependency: '- dev dependency: `storage`',
  data: ['`data/tables/gamma_table.csv`', '', '| column | type | build target |', '|---|---|---|', '| `id` | `id(key)` | `All` |', '', '`data/enums.csv`: none'].join('\n'),
});

export const BASIC_CLIENT: FixtureModule[] = [
  { name: 'LogCore', file: 'log-core', body: spec('LogCore', { purpose: 'Writes logs. This module has no module state and has no lifecycle.' }) },
  { name: 'AlphaCore', file: 'alpha-core', body: ALPHA },
  { name: 'BetaCore', file: 'beta-core', body: BETA },
  { name: 'DeltaCore', file: 'delta-core', body: spec('DeltaCore') },
  { name: 'QaCore', file: 'qa-core', body: spec('QaCore') },
];

export const BASIC_SERVER: FixtureModule[] = [
  { name: 'gamma', file: 'gamma', body: GAMMA },
  { name: 'storage', file: 'storage', body: spec('storage') },
];
