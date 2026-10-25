import { describe, expect, it, vi } from 'vitest';
import * as botScenario from '../../../../src/commands/check/static/bot-scenario.ts';
import * as optionEntry from '../../../../src/commands/check/static/option-entry.ts';
import * as sharedFormula from '../../../../src/commands/check/static/shared-formula.ts';
import { absentLines, lines, memContext, sorted } from './helpers.ts';

const modules = vi.hoisted(() => ({ value: { client: [] as string[], server: [] as string[] } }));

vi.mock('../../../../src/commands/generate/api.ts', () => ({
  gameModules: () => Promise.resolve(modules.value),
}));

const step = (fields: object): object => ({ timeoutMs: 1000, ...fields });

const BASE_STEPS = [
  step({ kind: 'setup', command: 'shop.open_main' }),
  step({ kind: 'input', command: 'tap_anchor', args: ['buy'] }),
  step({ kind: 'auto', command: 'shop.bot_next_input', until: { path: 'state.boot_stage', op: 'eq', value: 'Done' } }),
  step({ kind: 'save' }),
  step({ kind: 'setup', command: 'force_network_failure', args: ['connection_failed'] }),
  step({ kind: 'setup', command: 'force_network_failure', args: ['none'] }),
  step({ kind: 'input', command: 'tap', args: ['1', '2'], until: { all: [{ path: 'telemetry.inputs', op: 'count_gte', value: 1 }] } }),
];
const GOAL = { path: 'telemetry.goal_intervals', op: 'count_gte', value: 1 };

describe('bot scenario', () => {
  it('accepts a complete scenario and fixture', async () => {
    modules.value = { client: [], server: [] };
    const sc = memContext({
      'client/dev/bot/scenario.json': { steps: BASE_STEPS, goal: GOAL },
      'client/dev/bot/fixtures/after_tutorial.json': { steps: [step({ kind: 'setup', command: 'set_server_time_offset', args: ['1000'] })] },
    });
    expect(await botScenario.run(sc)).toEqual([]);
  });

  it('reports a missing scenario and malformed JSON', async () => {
    modules.value = { client: [], server: [] };
    expect(absentLines(await botScenario.run(memContext({})))).toEqual(['client/dev/bot:1 | bot scenario: scenario file is missing']);
    expect(absentLines(await botScenario.run(memContext({ 'client/dev/bot/scenario.json': '{"steps": []}' })))).toContain('client/dev/bot/scenario.json:1 | bot scenario: no `goal`');
    expect(lines(await botScenario.run(memContext({ 'client/dev/bot/scenario.json': '{\n"steps": [' })))).toEqual(['client/dev/bot/scenario.json:2 | bot scenario: not JSON']);
    expect(lines(await botScenario.run(memContext({ 'client/dev/bot/scenario.json': '[]' })))).toEqual(['client/dev/bot/scenario.json:1 | bot scenario: scenario is not a JSON object']);
  });

  it('finds malformed steps, conditions and goal', async () => {
    modules.value = { client: [], server: [] };
    const text = JSON.stringify(
      {
        steps: [
          step({ kind: 'jump' }),
          step({ kind: 'input', command: 'go_to_scene', args: ['x'] }),
          step({ kind: 'setup', command: 'Bad.Name' }),
          step({ kind: 'auto', command: 'shop.bot_next_input' }),
          step({ kind: 'save', command: 'x' }),
          { kind: 'input', command: 'tap', args: [1], extra: true, timeoutMs: 0 },
          step({ kind: 'setup', command: 'restart', until: { path: 'other.x', op: 'eq', value: 1 } }),
          step({ kind: 'setup', command: 'restart', until: { all: {} } }),
          step({ kind: 'setup', command: 'restart', until: { path: 'state.x', op: 'gt', value: 1 } }),
          step({ kind: 'setup', command: 'restart', until: { path: 'state.x', op: 'eq' } }),
          step({ kind: 'setup', command: 'restart', social: 'clan' }),
          step({ kind: 'input' }),
          5,
        ],
        goal: { path: 'telemetry.goal_intervals', op: 'count_gte', value: 0 },
        more: 1,
      },
      null,
      2,
    );
    const sc = memContext({ 'client/dev/bot/scenario.json': text });
    const stepLines = text
      .split('\n')
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /^ {4}[{0-9]/.test(l))
      .map(({ i }) => i);
    const at = (i: number): number => stepLines[i] ?? -1;
    const found = lines(await botScenario.run(sc));
    expect(found).toContain(`client/dev/bot/scenario.json:${String(at(0) + 1)} | bot scenario: \`kind\` must be \`input\`, \`setup\`, \`auto\` or \`save\``);
    expect(found).toContain(`client/dev/bot/scenario.json:${String(at(1) + 1)} | bot scenario: \`go_to_scene\` is not an input built-in command`);
    expect(found).toContain(`client/dev/bot/scenario.json:${String(at(2) + 1)} | bot scenario: \`Bad.Name\` is not a setup built-in command or a content command`);
    expect(found).toContain(`client/dev/bot/scenario.json:${String(at(3) + 1)} | bot scenario: \`auto\` step has no \`until\``);
    expect(found).toContain(`client/dev/bot/scenario.json:${String(at(4) + 1)} | bot scenario: \`save\` step has a \`command\``);
    expect(found).toContain(`client/dev/bot/scenario.json:${String(at(5) + 1)} | bot scenario: unknown step field \`extra\``);
    expect(found).toContain(`client/dev/bot/scenario.json:${String(at(5) + 1)} | bot scenario: \`args\` must be a list of strings`);
    expect(found).toContain(`client/dev/bot/scenario.json:${String(at(5) + 1)} | bot scenario: \`timeoutMs\` must be an integer of 1 or more`);
    expect(found).toContain(`client/dev/bot/scenario.json:${String(at(11) + 1)} | bot scenario: step has no \`command\``);
    expect(found).toContain(`client/dev/bot/scenario.json:${String(at(10) + 1)} | bot scenario: \`social\` must be \`friend\`, \`guild\` or \`chat\``);
    expect(found.filter((l) => l.includes('condition `path` must start'))).toHaveLength(1);
    expect(found.filter((l) => l.includes('`all` condition must be'))).toHaveLength(1);
    expect(found.filter((l) => l.includes('condition `op` must be one of'))).toHaveLength(1);
    expect(found.filter((l) => l.includes('condition must have exactly `path`, `op`, `value`'))).toHaveLength(1);
    expect(found.filter((l) => l.includes('step is not an object'))).toHaveLength(1);
    expect(found).toContain('client/dev/bot/scenario.json:1 | bot scenario: unknown field `more`');
    expect(found.filter((l) => l.includes('`goal` has no'))).toHaveLength(1);
    expect(found).not.toContain('client/dev/bot/scenario.json:1 | bot scenario: no `save` step');
    expect(found).toHaveLength(18);
    expect(found).toContain('client/dev/bot/scenario.json:1 | bot scenario: no reconnect steps (`force_network_failure` `connection_failed`, then `none`, then a step with `until`)');
  });

  it('requires tutorial, realtime, room and social steps when the game has them', async () => {
    modules.value = { client: ['RealtimeCore'], server: ['friend', 'chat'] };
    const files = {
      'data/tables/tutorial.csv': ',,,\nAll,Client,Client,Client\nid(key),int,requirement,bool\nid,order,start_requirement,skippable\n[tut_b],2,,false\n[tut_a],1,,false\n',
      'data/tables/match_mode.csv': ',\nAll,All\nid(key),bool\nid,allow_room\n[duel],true\n',
    };
    const missingFound = await botScenario.run(memContext({ ...files, 'client/dev/bot/scenario.json': { steps: BASE_STEPS, goal: GOAL } }));
    const missing = lines(missingFound);
    expect(absentLines(missingFound)).toEqual(missing);
    expect(missing).toEqual(sorted([
      'client/dev/bot/scenario.json:1 | bot scenario: no `drop_matchmaker` step followed by a step with `until`',
      'client/dev/bot/scenario.json:1 | bot scenario: no `drop_peer` `other` step followed by a step with `until`',
      'client/dev/bot/scenario.json:1 | bot scenario: no `setup` `restart` step with `until` match state `Playing`',
      'client/dev/bot/scenario.json:1 | bot scenario: no room steps (`until` room code not empty, then `until` match state `Playing`)',
      'client/dev/bot/scenario.json:1 | bot scenario: no step with `social` `chat` and `until`',
      'client/dev/bot/scenario.json:1 | bot scenario: no step with `social` `friend` and `until`',
      'client/dev/bot/scenario.json:1 | bot scenario: no tutorial resume steps for `[tut_a]`',
    ]));
    const playing = { path: 'state.match_state', op: 'eq', value: 'Playing' };
    const full = [
      ...BASE_STEPS,
      step({ kind: 'input', command: 'tap', args: ['1', '1'], until: { path: 'state.tutorial.id', op: 'eq', value: '[tut_a]' } }),
      step({ kind: 'save' }),
      step({ kind: 'input', command: 'tap', args: ['1', '1'], until: { path: 'state.completed_tutorials.[tut_a]', op: 'eq', value: true } }),
      step({ kind: 'setup', command: 'drop_peer', args: ['other'] }),
      step({ kind: 'setup', command: 'drop_matchmaker' }),
      step({ kind: 'input', command: 'tap', args: ['1', '1'], until: playing }),
      step({ kind: 'setup', command: 'restart', until: playing }),
      step({ kind: 'input', command: 'tap', args: ['1', '1'], until: { path: 'state.room_code', op: 'ne', value: '' } }),
      step({ kind: 'setup', command: 'shop.open_room', until: playing }),
      step({ kind: 'setup', command: 'social.wait', social: 'friend', until: { path: 'state.x', op: 'eq', value: 1 } }),
      step({ kind: 'setup', command: 'social.wait', social: 'chat', until: { path: 'state.y', op: 'eq', value: 1 } }),
    ];
    expect(await botScenario.run(memContext({ ...files, 'client/dev/bot/scenario.json': { steps: full, goal: { all: [GOAL] } } }))).toEqual([]);
  });

  it('checks save fixtures', async () => {
    modules.value = { client: [], server: [] };
    const sc = memContext({
      'client/dev/bot/scenario.json': { steps: BASE_STEPS, goal: GOAL },
      'client/dev/bot/fixtures/BadName.json': { steps: [] },
      'client/dev/bot/fixtures/input_step.json': { steps: [step({ kind: 'input', command: 'tap', args: ['1', '1'] })] },
      'client/dev/bot/fixtures/shape.json': { moves: [] },
      'client/dev/bot/fixtures/broken.json': '{',
    });
    expect(lines(await botScenario.run(sc))).toEqual([
      'client/dev/bot/fixtures/BadName.json:1 | bot scenario: save fixture file name must be `<snake_case name>.json`',
      'client/dev/bot/fixtures/broken.json:1 | bot scenario: not JSON',
      'client/dev/bot/fixtures/input_step.json:3 | bot scenario: save fixture step `kind` must be `setup`',
      'client/dev/bot/fixtures/shape.json:1 | bot scenario: save fixture must be `{"steps": [<step>, ...]}`',
    ]);
  });
});

describe('shared formula', () => {
  const fixture = { cases: [{ name: 'a', input: 1, expected: 2 }] };

  it('accepts a formula with one mark per side, a fixture and test calls', async () => {
    const sc = memContext({
      'client/features/idle/idle_calc.gd': 'class_name IdleCalc\n# ogw:shared idle.production\nstatic func production(t: int) -> int:\n\treturn t\n',
      'server/common/idle.ts': '// ogw:shared idle.production\nexport function production(t: number): number {\n  return t;\n}\n',
      'data/fixtures/idle.production.json': fixture,
      'client/tests/idle/test_calc.gd': 'extends UnitTestCase\nfunc test_a() -> void:\n\tvar text := UnitTestCore.read_shared_fixture("idle.production")\n',
      'server/tests/idle.test.ts': "const f = testing.read_shared_fixture('idle.production');\n",
    });
    expect(await sharedFormula.run(sc)).toEqual([]);
  });

  it('finds a client mark that is not right above a function', async () => {
    const sc = memContext({
      'client/features/idle/idle_calc.gd': 'class_name IdleCalc\n# ogw:shared idle.production\n\nstatic func production(t: int) -> int:\n\treturn t\n',
      'server/common/idle.ts': '// ogw:shared idle.production\nexport function production(t: number): number {\n  return t;\n}\n',
      'data/fixtures/idle.production.json': fixture,
      'client/tests/idle/test_calc.gd': 'extends UnitTestCase\nfunc test_a() -> void:\n\tvar text := UnitTestCore.read_shared_fixture("idle.production")\n',
      'server/tests/idle.test.ts': "const f = testing.read_shared_fixture('idle.production');\n",
    });
    expect(lines(await sharedFormula.run(sc))).toEqual(['client/features/idle/idle_calc.gd:2 | shared formula: `idle.production` mark is not on the line right above a function']);
  });

  it('finds wrong mark counts, fixture problems, missing test calls and judge elements without a formula', async () => {
    const sc = memContext({
      'client/features/idle/idle_calc.gd': 'class_name IdleCalc\n# ogw:shared idle.production\nfunc a() -> void:\n\tpass\n# ogw:shared idle.production\nfunc b() -> void:\n\tpass\nvar x := 1 # ogw:shared idle.trailing\n',
      'client/dev/x.gd': '# ogw:shared idle.dev\n',
      'client/boot/content_boot.gd': 'func content_init() -> bool:\n\tRequirementCore.register_judge(GameData.RequirementType.ITEM_COUNT, judge, [], key)\n\treturn true\n',
      'server/main.ts': 'export function register(core) {\n  core.validation.register_requirement_judge(GameData.RequirementType.QuestCleared, judge);\n}\n',
      'server/common/a.ts': '// ogw:shared other.calc\n\nconst x = 1;\n// ogw:shared Price\nexport const price = (n: number): number => n;\n',
      'data/fixtures/idle.production.json': { cases: [] },
      'data/fixtures/other.calc.json': { cases: [{ name: 'a', input: 1 }, { name: 2, input: 1, expected: 1 }] },
      'data/fixtures/requirement.item_count.json': 'nope',
      'client/tests/t.gd': 'func t() -> void:\n\tUnitTestCore.read_shared_fixture("other.calc")\n',
    });
    const shared = await sharedFormula.run(sc);
    expect(absentLines(shared)).toEqual(lines(shared.filter((f) => / has 0 |is missing|call in /.test(f.message))));
    expect(absentLines(shared)).toHaveLength(18);
    expect(lines(shared)).toEqual(sorted([
      'client/features/idle/idle_calc.gd:2 | shared formula: `idle.production` has 2 `# ogw:shared` marks in client/, not 1',
      'client/features/idle/idle_calc.gd:5 | shared formula: `idle.production` has 2 `# ogw:shared` marks in client/, not 1',
      'client/features/idle/idle_calc.gd:2 | shared formula: `idle.production` has 0 `// ogw:shared` marks in server/, not 1',
      'data/fixtures/idle.production.json:2 | shared formula: fixture has no case',
      'client/features/idle/idle_calc.gd:2 | shared formula: no `read_shared_fixture("idle.production")` call in client/tests/',
      'client/features/idle/idle_calc.gd:2 | shared formula: no `read_shared_fixture("idle.production")` call in server/tests/',
      'server/common/a.ts:1 | shared formula: `other.calc` has 0 `# ogw:shared` marks in client/, not 1',
      'data/fixtures/other.calc.json:3 | shared formula: case 0 must be `{"name": "<case>", "input": <JSON>, "expected": <JSON>}`',
      'data/fixtures/other.calc.json:7 | shared formula: case 1 must be `{"name": "<case>", "input": <JSON>, "expected": <JSON>}`',
      'server/common/a.ts:1 | shared formula: no `read_shared_fixture("other.calc")` call in server/tests/',
      'server/common/a.ts:1 | shared formula: `other.calc` mark is not on the line right above a function',
      'server/common/a.ts:4 | shared formula: `data/fixtures/Price.json` is missing',
      'server/common/a.ts:4 | shared formula: `Price` has 0 `# ogw:shared` marks in client/, not 1',
      'server/common/a.ts:4 | shared formula: name `Price` is not `<feature>.<formula>` or `requirement.<element>` with snake_case parts',
      'server/common/a.ts:4 | shared formula: no `read_shared_fixture("Price")` call in client/tests/',
      'server/common/a.ts:4 | shared formula: no `read_shared_fixture("Price")` call in server/tests/',
      'client/boot/content_boot.gd:2 | shared formula: `requirement.item_count` has 0 `# ogw:shared` marks in client/, not 1',
      'client/boot/content_boot.gd:2 | shared formula: `requirement.item_count` has 0 `// ogw:shared` marks in server/, not 1',
      'data/fixtures/requirement.item_count.json:1 | shared formula: fixture is not JSON',
      'client/boot/content_boot.gd:2 | shared formula: no `read_shared_fixture("requirement.item_count")` call in client/tests/',
      'client/boot/content_boot.gd:2 | shared formula: no `read_shared_fixture("requirement.item_count")` call in server/tests/',
      'server/main.ts:2 | shared formula: `requirement.quest_cleared` has 0 `# ogw:shared` marks in client/, not 1',
      'server/main.ts:2 | shared formula: `requirement.quest_cleared` has 0 `// ogw:shared` marks in server/, not 1',
      'server/main.ts:2 | shared formula: `data/fixtures/requirement.quest_cleared.json` is missing',
      'server/main.ts:2 | shared formula: no `read_shared_fixture("requirement.quest_cleared")` call in client/tests/',
      'server/main.ts:2 | shared formula: no `read_shared_fixture("requirement.quest_cleared")` call in server/tests/',
    ]));
  });
});

describe('option entry', () => {
  const ALL_CALLS = [
    'AuthCore.open_terms_document', 'AuthCore.withdraw', 'AuthCore.get_public_code', 'NativeUiCore.copy_text', 'UICore.open_licenses',
    'AuthCore.issue_deletion_code',
  ];
  const code = (calls: string[]): string => `class_name OptionsPanel\nfunc f() -> void:\n${calls.map((c) => `\t${c}()`).join('\n')}\n`;

  it('requires the calls every game needs, outside DEV and test code', async () => {
    modules.value = { client: [], server: [] };
    const sc = memContext({
      'settings.json': '{\n  "engine": "godot"\n}\n',
      'client/features/options/options_panel.gd': code(ALL_CALLS.slice(1)),
      'client/dev/x.gd': code(['AuthCore.open_terms_document']),
    });
    expect(absentLines(await optionEntry.run(sc))).toEqual(['client/features:1 | option entry: no `AuthCore.open_terms_document` call in client content code']);
    const ok = memContext({ 'settings.json': '{}', 'client/features/options/options_panel.gd': code(ALL_CALLS) });
    expect(await optionEntry.run(ok)).toEqual([]);
  });

  it('requires the conditional calls from settings, modules and iap products', async () => {
    modules.value = { client: ['AdCore'], server: [] };
    const settings = {
      environments: { DEV: { adapters: { 'login-apple': null } }, STG: { adapters: { 'login-google': 'sandbox' } }, PROD: {} },
      consent: { privacyChoices: true },
      pushConsent: { adPush: true },
      buildPlatforms: ['ios'],
      coreModules: { client: ['AdCore'], server: [] },
    };
    const iap = ',,,,\nAll,All,All,All,All\nid(key),enum<IapType>,string,string,string\nid,type,sku_apple,sku_google,x\n[gems],Consumable,a,b,\n[vip],Subscription,vip,,\n[noads],NonConsumable,,g,\n';
    const sc = memContext({ 'settings.json': JSON.stringify(settings, null, 2), 'client/features/options/options_panel.gd': code(ALL_CALLS), 'data/tables/iap_product.csv': iap });
    const text = JSON.stringify(settings, null, 2).split('\n');
    const line = (key: string): number => text.findIndex((l) => l.includes(`"${key}"`)) + 1;
    expect(lines(await optionEntry.run(sc))).toEqual(sorted([
      `settings.json:${String(line('environments'))} | option entry: no \`AuthCore.list_linked_providers\` call in client content code`,
      `settings.json:${String(line('environments'))} | option entry: no \`AuthCore.link_account\` call in client content code`,
      `settings.json:${String(line('environments'))} | option entry: no \`AuthCore.switch_account\` call in client content code`,
      `settings.json:${String(line('privacyChoices'))} | option entry: no \`AuthCore.open_privacy_choices\` call in client content code`,
      `settings.json:${String(line('coreModules'))} | option entry: no \`AdCore.is_ad_privacy_options_required\` call in client content code`,
      `settings.json:${String(line('coreModules'))} | option entry: no \`AdCore.open_ad_privacy_options\` call in client content code`,
      `settings.json:${String(line('adPush'))} | option entry: no \`PushCore.get_push_consent\` call in client content code`,
      `settings.json:${String(line('adPush'))} | option entry: no \`PushCore.set_push_consent\` call in client content code`,
      'data/tables/iap_product.csv:6 | option entry: no `PaymentCore.restore_purchases` call in client content code',
      'data/tables/iap_product.csv:6 | option entry: no `PaymentCore.open_subscription_management` call in client content code',
    ]));
  });
});
