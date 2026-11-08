import { describe, expect, it, vi } from 'vitest';
import * as botScenario from '../../../../src/commands/check/static/bot-scenario.ts';
import * as gamepadInput from '../../../../src/commands/check/static/gamepad-input.ts';
import * as optionEntry from '../../../../src/commands/check/static/option-entry.ts';
import * as sharedFormula from '../../../../src/commands/check/static/shared-formula.ts';
import { absentLines, lines, memContext, sorted } from './helpers.ts';

const modules = vi.hoisted(() => ({ value: { client: [] as string[], server: [] as string[] } }));
/** The merged core settings the static context reads. */
const coreSettings = vi.hoisted((): { value: Record<string, unknown> } => ({ value: {} }));

vi.mock('../../../../src/commands/generate/api.ts', () => ({
  gameModules: () => Promise.resolve(modules.value),
  mergedCoreSettings: () => Promise.resolve(coreSettings.value),
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

const UI_VOLUME = ['SoundCore.get_volume(SoundCore.SoundBus.UI)', 'SoundCore.set_volume(SoundCore.SoundBus.UI, 1.0)'];
const BASE_MODULES = ['AuthCore', 'BootstrapCore', 'InputCore', 'LocalizationCore', 'NativeUiCore', 'ResolutionCore', 'SoundCore', 'UICore'];
/**
 * One event of an action: a class name, or `InputEventJoypadMotion@<axis>` for a motion event of that `JoyAxis` value,
 * whose `resource_name` value `"axis"` is a value, not the `axis` property.
 */
const inputEvent = (cls: string): string => {
  const [name = '', axis] = cls.split('@');
  const motion = axis === undefined ? '' : `"resource_name":"axis","axis":${axis},"axis_value":-1.0,`;
  return `Object(${name},"resource_local_to_scene":false,"device":-1,${motion}"script":null)`;
};
/** A `project.godot` whose `[input]` holds each action with one event per class. */
const project = (actions: Record<string, string[]>): string => {
  const body = Object.entries(actions).map(([name, classes]) => `${name}={\n"deadzone": 0.5,\n"events": [${classes.map(inputEvent).join('\n, ')}\n]\n}`);
  return `[application]\n\nconfig/name="g"\n\n[input]\n\n${body.join('\n')}\n`;
};
const CORE_INPUT = {
  back: ['InputEventKey', 'InputEventJoypadButton'],
  cutscene_advance: ['InputEventKey', 'InputEventJoypadButton'],
  cutscene_skip: ['InputEventKey', 'InputEventJoypadButton'],
};
/** 1-based line of the first line of `text` that starts with `prefix`. */
const lineOf = (text: string, prefix: string): number => text.split('\n').findIndex((l) => l.startsWith(prefix)) + 1;

describe('option entry', () => {
  const ALL_CALLS = [
    'AuthCore.open_terms_document', 'AuthCore.withdraw', 'AuthCore.get_public_code', 'NativeUiCore.copy_text', 'UICore.open_licenses',
    'AuthCore.issue_deletion_code', 'SoundCore.reset_volume_settings', ...UI_VOLUME,
  ];
  const code = (calls: string[]): string => `class_name OptionsPanel\nfunc f() -> void:\n${calls.map((c) => `\t${c.includes('(') ? c : `${c}()`}`).join('\n')}\n`;

  it('requires the calls every game needs, outside DEV and test code', async () => {
    modules.value = { client: BASE_MODULES, server: [] };
    const sc = memContext({
      'settings.json': '{\n  "engine": "godot"\n}\n',
      'client/features/options/options_panel.gd': code(ALL_CALLS.slice(1)),
      'client/dev/x.gd': code(['AuthCore.open_terms_document']),
      'client/tests/x.gd': code(['AuthCore.open_terms_document']),
    });
    expect(absentLines(await optionEntry.run(sc))).toEqual(['client/features:1 | option entry: no `AuthCore.open_terms_document` call in client content code']);
    const ok = memContext({ 'settings.json': '{}', 'client/features/options/options_panel.gd': code(ALL_CALLS) });
    expect(await optionEntry.run(ok)).toEqual([]);
    // the reset entry every game has resets the volume settings
    const noReset = memContext({ 'settings.json': '{}', 'client/features/options/options_panel.gd': code(ALL_CALLS.filter((c) => c !== 'SoundCore.reset_volume_settings')) });
    expect(absentLines(await optionEntry.run(noReset))).toEqual(['client/features:1 | option entry: no `SoundCore.reset_volume_settings` call in client content code']);
  });

  it('requires a volume of the Ui bus that UICore plays', async () => {
    modules.value = { client: BASE_MODULES, server: [] };
    const sc = memContext({ 'settings.json': '{}', 'client/features/options/options_panel.gd': code(ALL_CALLS.filter((c) => !UI_VOLUME.includes(c))) });
    expect(absentLines(await optionEntry.run(sc))).toEqual([
      'client/features:1 | option entry: no `SoundCore.get_volume` call with `SoundCore.SoundBus.UI` in client content code',
      'client/features:1 | option entry: no `SoundCore.set_volume` call with `SoundCore.SoundBus.UI` in client content code',
    ]);
  });

  it('requires the conditional calls from settings, modules and iap products', async () => {
    modules.value = { client: [...BASE_MODULES, 'AdCore', 'PaymentCore', 'PushCore'], server: [] };
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
      // the first login adapter that is not null makes the social login entries required: STG, not the null one of DEV
      `settings.json:${String(line('login-google'))} | option entry: no \`AuthCore.list_linked_providers\` call in client content code`,
      `settings.json:${String(line('login-google'))} | option entry: no \`AuthCore.link_account\` call in client content code`,
      `settings.json:${String(line('login-google'))} | option entry: no \`AuthCore.switch_account\` call in client content code`,
      `settings.json:${String(line('privacyChoices'))} | option entry: no \`AuthCore.open_privacy_choices\` call in client content code`,
      `settings.json:${String(line('coreModules'))} | option entry: no \`AdCore.is_ad_privacy_options_required\` call in client content code`,
      `settings.json:${String(line('coreModules'))} | option entry: no \`AdCore.open_ad_privacy_options\` call in client content code`,
      `settings.json:${String(line('adPush'))} | option entry: no \`PushCore.get_push_consent\` call in client content code`,
      `settings.json:${String(line('adPush'))} | option entry: no \`PushCore.set_push_consent\` call in client content code`,
      'data/tables/iap_product.csv:6 | option entry: no `PaymentCore.restore_purchases` call in client content code',
      'data/tables/iap_product.csv:6 | option entry: no `PaymentCore.open_subscription_management` call in client content code',
    ]));
  });

  const STICK_AXES = [
    'InputCore.is_pad_axis_inverted', 'InputCore.set_pad_axis_inverted', 'InputCore.list_pad_axis_sensitivities', 'InputCore.get_pad_axis_sensitivity',
    'InputCore.set_pad_axis_sensitivity', 'InputCore.reset_pad_axes',
  ];
  const LANGUAGE_CALLS = ['LocalizationCore.list_languages(languages)', 'LocalizationCore.get_language', 'LocalizationCore.select_language(1)', 'BootstrapCore.request_restart'];
  const SCREEN_MODE_CALLS = ['ResolutionCore.is_screen_mode_supported', 'ResolutionCore.get_screen_mode', 'ResolutionCore.set_screen_mode(ResolutionCore.ScreenMode.FULLSCREEN)'];
  const PLAY = [
    'class_name PlayScene',
    'func f(scope: Object) -> void:',
    '\tSoundCore.play_bgm(ResourceKey.BGM__MAIN, scope)',
    '\tSoundCore.play(ResourceKey.SFX__HIT, SoundCore.SoundBus.SFX, scope)',
    '\tSoundCore.play(ResourceKey.VOICE__HI, SoundCore.SoundBus.VOICE, scope)',
    '\tSoundCore.play_haptic(ResourceKey.HAPTIC__HIT, scope)',
    '\tAccessibilityCore.play_voice(ResourceKey.VOICE__HI, scope, "k")',
    '\tCameraCore.shake(0.5)',
    '\tScreenEffectCore.flash(ScreenEffectCore.ScreenEffectChannel.WORLD, self, Color.WHITE, 1.0, 10, 10, 10)',
    '',
  ].join('\n');

  it('requires the standard option calls from settings, calls and the input map', async () => {
    modules.value = { client: [...BASE_MODULES, 'AccessibilityCore', 'CameraCore', 'ScreenEffectCore'], server: [] };
    coreSettings.value = { 'AccessibilityCore.textScales': [1000, 1250] };
    const settingsText = JSON.stringify(
      { supportedLanguages: ['ko', 'en'], buildPlatforms: ['android', 'macos'], gamepadSupported: true, coreModules: { client: ['AccessibilityCore'] }, core: { 'AccessibilityCore.textScales': [1000, 1250] } },
      null,
      2,
    );
    const projectText = project({ ...CORE_INPUT, aim: ['InputEventJoypadMotion@2'], jump: ['InputEventKey', 'InputEventJoypadButton'] });
    const files = { 'settings.json': settingsText, 'client/project.godot': projectText, 'client/features/play/play_scene.gd': PLAY };
    const s = (key: string): string => `settings.json:${String(lineOf(settingsText, `  "${key}"`))}`;
    const p = (row: number): string => `client/features/play/play_scene.gd:${String(row)}`;
    const godot = (action: string): string => `client/project.godot:${String(lineOf(projectText, `${action}=`))}`;
    const missing = (where: string, calls: string[]): string[] => calls.map((c) => `${where} | option entry: no ${c} in client content code`);
    const volume = (bus: string): string[] => [`\`SoundCore.get_volume\` call with \`SoundCore.SoundBus.${bus}\``, `\`SoundCore.set_volume\` call with \`SoundCore.SoundBus.${bus}\``];
    const calls = (list: string[]): string[] => list.map((c) => `\`${c}\` call`);
    expect(lines(await optionEntry.run(memContext({ ...files, 'client/features/options/options_panel.gd': code(ALL_CALLS) })))).toEqual(sorted([
      ...missing(s('supportedLanguages'), calls(['LocalizationCore.list_languages', 'LocalizationCore.get_language', 'LocalizationCore.select_language', 'BootstrapCore.request_restart'])),
      ...missing(s('buildPlatforms'), calls(['ResolutionCore.is_screen_mode_supported', 'ResolutionCore.get_screen_mode', 'ResolutionCore.set_screen_mode'])),
      ...missing(p(3), volume('BGM')),
      ...missing(p(4), volume('SFX')),
      ...missing(p(5), volume('VOICE')),
      ...missing(p(6), calls(['SoundCore.is_haptic_enabled', 'SoundCore.set_haptic_enabled'])),
      ...missing(p(7), calls(['AccessibilityCore.get_settings', 'AccessibilityCore.set_subtitles'])),
      ...missing(p(8), calls(['AccessibilityCore.set_reduce_shake'])),
      ...missing(p(9), calls(['AccessibilityCore.set_reduce_flash'])),
      ...missing(s('coreModules'), calls(['AccessibilityCore.reset_settings'])),
      // get_settings is reported once, at the first entry that needs it
      ...missing(`settings.json:${String(lineOf(settingsText, '    "AccessibilityCore.textScales"'))}`, calls(['AccessibilityCore.list_text_scales', 'AccessibilityCore.set_text_scale'])),
      ...missing(godot('jump'), calls(['InputCore.get_keys', 'InputCore.wait_key', 'InputCore.set_keys', 'InputCore.cancel_wait_key', 'InputCore.reset_keys'])),
      ...missing(godot('aim'), calls(['InputCore.get_pad_buttons', 'InputCore.wait_pad_button', 'InputCore.set_pad_buttons', 'InputCore.reset_pad_buttons'])),
      ...missing(godot('aim'), calls(STICK_AXES)),
    ]));
    const options = [
      ...ALL_CALLS, ...LANGUAGE_CALLS, ...SCREEN_MODE_CALLS,
      ...['BGM', 'SFX', 'VOICE'].flatMap((b) => [`SoundCore.get_volume(SoundCore.SoundBus.${b})`, `SoundCore.set_volume(SoundCore.SoundBus.${b}, 1.0)`]),
      'SoundCore.is_haptic_enabled', 'SoundCore.set_haptic_enabled(true)', 'AccessibilityCore.get_settings', 'AccessibilityCore.set_subtitles(true)',
      'AccessibilityCore.set_reduce_shake(true)', 'AccessibilityCore.set_reduce_flash(true)', 'AccessibilityCore.reset_settings',
      'AccessibilityCore.list_text_scales(scales)', 'AccessibilityCore.set_text_scale(1250)', 'InputCore.get_keys(&"jump", keys)', 'InputCore.wait_key',
      'InputCore.set_keys(&"jump", keys)', 'InputCore.cancel_wait_key', 'InputCore.reset_keys', 'InputCore.get_pad_buttons(&"jump", keys)',
      'InputCore.wait_pad_button', 'InputCore.set_pad_buttons(&"jump", keys)', 'InputCore.reset_pad_buttons', ...STICK_AXES,
    ];
    expect(await optionEntry.run(memContext({ ...files, 'client/features/options/options_panel.gd': code(options) }))).toEqual([]);
  });

  it('requires the text scale entry when AccessibilityCore is used and the merged AccessibilityCore.textScales has 2 or more values', async () => {
    const options = (calls: string[]): string => code([...ALL_CALLS, ...calls]);
    const textScale = ['list_text_scales', 'get_settings', 'set_text_scale'];
    const missing = (where: string, ops: string[]): string[] => ops.map((op) => `${where} | option entry: no \`AccessibilityCore.${op}\` call in client content code`);
    // without AccessibilityCore, neither text scale nor its part of reset, whatever the text scales
    modules.value = { client: BASE_MODULES, server: [] };
    coreSettings.value = { 'AccessibilityCore.textScales': [1000, 1250, 1500] };
    expect(await optionEntry.run(memContext({ 'settings.json': '{}', 'client/features/options/options_panel.gd': options([]) }))).toEqual([]);
    modules.value = { client: [...BASE_MODULES, 'AccessibilityCore'], server: [] };
    // one text scale: no choice to offer, only the reset of the accessibility options
    coreSettings.value = { 'AccessibilityCore.textScales': [1000] };
    expect(absentLines(await optionEntry.run(memContext({ 'settings.json': '{}', 'client/features/options/options_panel.gd': options([]) })))).toEqual(missing('settings.json:1', ['reset_settings']));
    // the text scales of the core settings, which game settings `core` does not override: at the value that holds their place
    coreSettings.value = { 'AccessibilityCore.textScales': [1000, 1250, 1500] };
    const settingsText = JSON.stringify({ engine: 'godot', coreModules: { client: ['AccessibilityCore'] }, core: { 'NetworkCore.retryCount': 2 } }, null, 2);
    const coreLine = `settings.json:${String(lineOf(settingsText, '  "core"'))}`;
    expect(absentLines(await optionEntry.run(memContext({ 'settings.json': settingsText, 'client/features/options/options_panel.gd': options([]) })))).toEqual(sorted([
      ...missing(`settings.json:${String(lineOf(settingsText, '  "coreModules"'))}`, ['reset_settings']),
      ...missing(coreLine, textScale),
    ]));
    expect(absentLines(await optionEntry.run(memContext({ 'settings.json': '{}', 'client/features/options/options_panel.gd': options(['AccessibilityCore.reset_settings', 'AccessibilityCore.get_settings']) })))).toEqual(
      missing('settings.json:1', ['list_text_scales', 'set_text_scale']),
    );
    const all = options(['AccessibilityCore.reset_settings', 'AccessibilityCore.list_text_scales(scales)', 'AccessibilityCore.get_settings', 'AccessibilityCore.set_text_scale(1500)']);
    expect(await optionEntry.run(memContext({ 'settings.json': settingsText, 'client/features/options/options_panel.gd': all }))).toEqual([]);
    // calls in DEV code and regression tests do not count
    expect(absentLines(await optionEntry.run(memContext({ 'settings.json': settingsText, 'client/features/options/options_panel.gd': options([]), 'client/dev/x.gd': all, 'client/tests/x.gd': all })))).toHaveLength(4);
  });

  it('requires the stick axes entry for a Gameplay content action with a stick axis direction while gamepadSupported is true', async () => {
    modules.value = { client: BASE_MODULES, server: [] };
    const pad = ['InputCore.get_pad_buttons', 'InputCore.wait_pad_button', 'InputCore.set_pad_buttons', 'InputCore.cancel_wait_key', 'InputCore.reset_pad_buttons'];
    const panel = (calls: string[]): string => code([...ALL_CALLS, ...pad, ...calls]);
    const run = async (actions: Record<string, string[]>, settings: object, calls: string[] = []): Promise<string[]> =>
      absentLines(await optionEntry.run(memContext({ 'settings.json': JSON.stringify(settings), 'client/project.godot': project({ ...CORE_INPUT, ...actions }), 'client/features/options/options_panel.gd': panel(calls) })));
    const missing = (action: string, actions: Record<string, string[]>): string[] =>
      sorted(STICK_AXES.map((c) => `client/project.godot:${String(lineOf(project({ ...CORE_INPUT, ...actions }), `${action}=`))} | option entry: no \`${c}\` call in client content code`));
    const supported = { gamepadSupported: true };
    // a Ui action (menu_*), a Cutscene action (cutscene_*), a trigger axis (4, 5) and a gamepad button need no stick axes
    const others = { menu_down: ['InputEventJoypadMotion@3'], cutscene_next: ['InputEventJoypadMotion@1'], zoom: ['InputEventJoypadMotion@4'], brake: ['InputEventJoypadMotion@5'], fire: ['InputEventJoypadButton'] };
    expect(await run(others, supported)).toEqual([]);
    // each stick axis (JoyAxis 0 to 3) of a Gameplay action: at the first such action, after the actions that need none
    for (const axis of ['0', '1', '2', '3']) {
      const actions = { ...others, look: ['InputEventKey', `InputEventJoypadMotion@${axis}`], steer: ['InputEventJoypadMotion@0'] };
      expect(await run(actions, supported)).toEqual(missing('look', actions));
    }
    // an InputEventJoypadMotion without an axis has the default axis of the engine, 0 (left_x)
    expect(await run({ look: ['InputEventJoypadMotion'] }, supported)).toEqual(missing('look', { look: ['InputEventJoypadMotion'] }));
    // without gamepad support, the gamepad input check fails instead
    expect(await run({ look: ['InputEventJoypadMotion@3'] }, {})).toEqual([]);
    expect(await run({ look: ['InputEventJoypadMotion@3'] }, { gamepadSupported: false })).toEqual([]);
    expect(await run({ look: ['InputEventJoypadMotion@3'] }, supported, ['InputCore.is_pad_axis_inverted(&"right_y")', 'InputCore.set_pad_axis_inverted(&"right_y", true)', 'InputCore.list_pad_axis_sensitivities(buffer)', 'InputCore.get_pad_axis_sensitivity(&"right_y")', 'InputCore.set_pad_axis_sensitivity(&"right_y", 2000)', 'InputCore.reset_pad_axes'])).toEqual([]);
  });

  it('points at the line of the settings value by its path, not at another line that holds its name', async () => {
    modules.value = { client: BASE_MODULES, server: [] };
    const settingsText = JSON.stringify({ humanDecided: ['supportedLanguages', 'buildPlatforms'], note: { supportedLanguages: 1 }, supportedLanguages: ['ko', 'en'], buildPlatforms: ['macos'] }, null, 2);
    const s = (key: string): string => `settings.json:${String(lineOf(settingsText, `  "${key}"`))}`;
    const found = lines(await optionEntry.run(memContext({ 'settings.json': settingsText, 'client/features/options/options_panel.gd': code(ALL_CALLS) })));
    expect(found).toContain(`${s('supportedLanguages')} | option entry: no \`BootstrapCore.request_restart\` call in client content code`);
    expect(found).toContain(`${s('buildPlatforms')} | option entry: no \`ResolutionCore.get_screen_mode\` call in client content code`);
    // the first line that holds `"supportedLanguages"` is line 3, a value of humanDecided
    expect(s('supportedLanguages')).toBe('settings.json:9');
  });

  it('requires no standard option whose condition does not hold', async () => {
    modules.value = { client: BASE_MODULES, server: [] };
    const sc = memContext({
      'settings.json': JSON.stringify({ supportedLanguages: ['en'], buildPlatforms: ['android', 'ios'], gamepadSupported: true }),
      'client/project.godot': project({ ...CORE_INPUT, jump: ['InputEventKey', 'InputEventMouseButton'] }),
      'client/features/options/options_panel.gd': code(ALL_CALLS),
      'client/features/play/play_scene.gd': 'class_name PlayScene\nfunc f(scope: Object) -> void:\n\tSoundCore.play(ResourceKey.SFX__A, SoundCore.SoundBus.UI, scope)\n',
      'client/dev/cheat.gd': PLAY,
      'client/tests/test_play.gd': PLAY,
    });
    expect(await optionEntry.run(sc)).toEqual([]);
    const web = memContext({
      'settings.json': JSON.stringify({ supportedLanguages: ['en'], buildPlatforms: ['web'] }),
      'client/project.godot': project({ ...CORE_INPUT, jump: ['InputEventMouseButton', 'InputEventJoypadButton'] }),
      'client/features/options/options_panel.gd': code(ALL_CALLS),
    });
    expect(absentLines(await optionEntry.run(web)).map((l) => l.replace(/^.* \| /, ''))).toEqual(sorted(
      ['cancel_wait_key', 'get_keys', 'reset_keys', 'set_keys', 'wait_key'].map((op) => `option entry: no \`InputCore.${op}\` call in client content code`),
    ));
    const coreOnly = memContext({
      'settings.json': JSON.stringify({ buildPlatforms: ['windows'], gamepadSupported: true }),
      'client/project.godot': project(CORE_INPUT),
      'client/features/options/options_panel.gd': code([...ALL_CALLS, ...SCREEN_MODE_CALLS]),
    });
    expect(await optionEntry.run(coreOnly)).toEqual([]);
  });

  it('plays Sfx for a positional player and Voice for a cutscene voice', async () => {
    modules.value = { client: BASE_MODULES, server: [] };
    const cutscene = ',,\nAll,All,Client\nid(key),string,reskey?\nid,kind,voice\n[intro_1],Line,null\n[intro_2],Line,voice/intro_2\n';
    const scene = '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n\n[node name="Hum" type="AudioStreamPlayer2D" parent="."]\n';
    const volume = (where: string, bus: string): string[] =>
      ['get_volume', 'set_volume'].map((op) => `${where} | option entry: no \`SoundCore.${op}\` call with \`SoundCore.SoundBus.${bus}\` in client content code`);
    const sc = memContext({
      'settings.json': '{}',
      'client/features/options/options_panel.gd': code(ALL_CALLS),
      'resource/scene/main.tscn': scene,
      'data/tables/cutscene_step.csv': cutscene,
    });
    expect(absentLines(await optionEntry.run(sc))).toEqual(sorted([...volume('data/tables/cutscene_step.csv:6', 'VOICE'), ...volume('resource/scene/main.tscn:5', 'SFX')]));
    const spawned = memContext({
      'settings.json': '{}',
      'client/features/options/options_panel.gd': code(ALL_CALLS),
      'client/features/world/world.gd': 'class_name World\nfunc f() -> void:\n\tvar p: AudioStreamPlayer3D = AudioStreamPlayer3D.new()\n\tadd_child(p)\n',
    });
    expect(absentLines(await optionEntry.run(spawned))).toEqual(volume('client/features/world/world.gd:3', 'SFX'));
  });

  it('reports a bus argument that is not a SoundBus element', async () => {
    modules.value = { client: BASE_MODULES, server: [] };
    const sc = memContext({
      'settings.json': '{}',
      'client/features/options/options_panel.gd': code([...ALL_CALLS, 'SoundCore.set_volume(bus, 1.0)', 'SoundCore.get_volume(SoundCore.SoundBus.LOUD)']),
      'client/features/play/play_scene.gd': 'class_name PlayScene\nfunc f(bus: int, scope: Object) -> void:\n\tSoundCore.play(ResourceKey.SFX__A, bus, scope)\n\tSoundCore.play(ResourceKey.SFX__A)\n',
    });
    const bad = (where: string, op: string): string => `${where} | option entry: the \`SoundBus\` argument of \`SoundCore.${op}\` is not a \`SoundCore.SoundBus\` element`;
    expect(lines(await optionEntry.run(sc))).toEqual([
      bad('client/features/options/options_panel.gd:12', 'set_volume'),
      bad('client/features/options/options_panel.gd:13', 'get_volume'),
      bad('client/features/play/play_scene.gd:3', 'play'),
      bad('client/features/play/play_scene.gd:4', 'play'),
    ]);
  });

  it('requires the module of each needed call to be a module the game uses', async () => {
    modules.value = { client: BASE_MODULES.filter((m) => m !== 'NativeUiCore'), server: [] };
    const sc = memContext({
      'settings.json': '{}',
      'client/features/options/options_panel.gd': code([...ALL_CALLS, 'AccessibilityCore.get_settings', 'AccessibilityCore.set_reduce_shake(true)']),
      'client/features/play/play_scene.gd': 'class_name PlayScene\nfunc f() -> void:\n\tCameraCore.shake(0.5)\n',
    });
    expect(absentLines(await optionEntry.run(sc))).toEqual(sorted([
      'client/features/play/play_scene.gd:3 | option entry: `AccessibilityCore` (for `AccessibilityCore.get_settings`) is not a module the game uses',
      'client/features:1 | option entry: `NativeUiCore` (for `NativeUiCore.copy_text`) is not a module the game uses',
    ]));
  });
});

describe('gamepad input', () => {
  const CONTENT = [
    'class_name PlayHud',
    'func f() -> void:',
    '\tif InputCore.get_device() == InputCore.InputDevice.GAMEPAD:',
    '\t\tpass',
    '\tvar family: GameData.InputPromptFamily = GameData.InputPromptFamily.PLAY_STATION',
    '\tInputCore.get_pad_buttons(&"jump", PackedStringArray())',
    '\tEventCore.subscribe(GamepadConnectionChangedEvent, _on_pad)',
    '\tif InputCore.get_device() == InputCore.InputDevice.TOUCH and family == GameData.InputPromptFamily.TOUCH:',
    '\t\tInputCore.get_keys(&"jump", PackedStringArray())',
    '',
  ].join('\n');
  const PROJECT = project({ ...CORE_INPUT, aim: ['InputEventJoypadMotion'], fire: ['InputEventKey', 'InputEventMouseButton'], jump: ['InputEventKey', 'InputEventJoypadButton'] });

  it('reports gamepad bindings of content actions and gamepad names in content code while gamepadSupported is not true', async () => {
    const files = { 'client/project.godot': PROJECT, 'client/features/play/play_hud.gd': CONTENT, 'client/dev/pad.gd': CONTENT, 'client/tests/test_pad.gd': CONTENT };
    const unsupported = 'while game settings `gamepadSupported` is not `true`';
    const name = (row: number, text: string): string => `client/features/play/play_hud.gd:${String(row)} | gamepad input: \`${text}\` is gamepad input ${unsupported}`;
    const action = (text: string): string =>
      `client/project.godot:${String(lineOf(PROJECT, `${text}=`))} | gamepad input: action \`${text}\` has a gamepad button or gamepad axis direction in its default binding ${unsupported}`;
    const expected = sorted([
      action('aim'), action('jump'),
      name(3, 'InputCore.InputDevice.GAMEPAD'), name(5, 'GameData.InputPromptFamily.PLAY_STATION'), name(6, 'InputCore.get_pad_buttons'), name(7, 'GamepadConnectionChangedEvent'),
    ]);
    expect(lines(await gamepadInput.run(memContext({ ...files, 'settings.json': '{}' })))).toEqual(expected);
    expect(lines(await gamepadInput.run(memContext({ ...files, 'settings.json': '{"gamepadSupported": false}' })))).toEqual(expected);
    expect(await gamepadInput.run(memContext({ ...files, 'settings.json': '{"gamepadSupported": true}' }))).toEqual([]);
  });

  it('reports the stick axis option operations of InputCore while gamepadSupported is not true', async () => {
    const ops = ['set_pad_axis_inverted(&"right_y", true)', 'is_pad_axis_inverted(&"right_y")', 'set_pad_axis_sensitivity(&"right_x", 2000)', 'get_pad_axis_sensitivity(&"right_x")', 'list_pad_axis_sensitivities(buffer)', 'reset_pad_axes()'];
    const content = ['class_name PlayOptions', 'func f(buffer: PackedInt32Array) -> void:', ...ops.map((op) => `\tInputCore.${op}`), ''].join('\n');
    const files = { 'client/project.godot': project(CORE_INPUT), 'client/features/options/stick_options.gd': content, 'client/dev/pad.gd': content };
    const unsupported = 'while game settings `gamepadSupported` is not `true`';
    expect(lines(await gamepadInput.run(memContext({ ...files, 'settings.json': '{}' })))).toEqual(
      sorted(ops.map((op, i) => `client/features/options/stick_options.gd:${String(i + 3)} | gamepad input: \`InputCore.${op.slice(0, op.indexOf('('))}\` is gamepad input ${unsupported}`)),
    );
    expect(await gamepadInput.run(memContext({ ...files, 'settings.json': '{"gamepadSupported": true}' }))).toEqual([]);
  });

  it('passes core actions with gamepad bindings, ui_ actions and content actions without them', async () => {
    const sc = memContext({
      'settings.json': '{}',
      'client/project.godot': project({ ...CORE_INPUT, fire: ['InputEventKey', 'InputEventMouseButton'], ui_accept: ['InputEventJoypadButton'] }),
      'client/features/play/play_hud.gd': 'class_name PlayHud\nfunc f() -> void:\n\tif InputCore.get_device() == InputCore.InputDevice.KEYBOARD_MOUSE:\n\t\tInputCore.get_keys(&"fire", PackedStringArray())\n',
    });
    expect(await gamepadInput.run(sc)).toEqual([]);
  });
});
