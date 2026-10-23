import { describe, expect, it, vi } from 'vitest';
import * as dataLiteral from '../../../../src/commands/check/static/data-literal.ts';
import * as devReference from '../../../../src/commands/check/static/dev-reference.ts';
import * as embeddedScript from '../../../../src/commands/check/static/embedded-script.ts';
import * as featureBoundary from '../../../../src/commands/check/static/feature-boundary.ts';
import * as settingsAccess from '../../../../src/commands/check/static/settings-access.ts';
import * as systemClock from '../../../../src/commands/check/static/system-clock.ts';
import { lines, memContext, sorted } from './helpers.ts';

vi.mock('../../../../src/commands/generate/api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  gameCoreSpec: async () => (await import('./helpers.ts')).CORE_SPEC,
}));

describe('feature boundary', () => {
  it('finds cross-feature classes and paths, class name prefixes and scene references', async () => {
    const sc = memContext({
      'client/features/shop/shop_panel.gd': 'class_name ShopPanel\nvar x: QuestBoard\nvar p := "res://features/quest/quest_board.gd"\nvar q := "res://features/shop/a.gd"\nvar c: CommonButton\n',
      'client/features/shop/bad_name.gd': 'class_name BadName\n',
      'client/features/quest/quest_board.gd': 'class_name QuestBoard\n',
      'client/common/common_button.gd': 'class_name CommonButton\n',
      'client/common/helper.gd': 'class_name Helper\n',
      'client/common/no_name.gd': 'extends Node\n',
      'resource/scene/shop/main.tscn': [
        '[gd_scene format=3]',
        '[ext_resource type="Script" path="res://features/shop/shop_panel.gd" id="1"]',
        '[ext_resource type="Script" path="res://features/quest/quest_board.gd" id="2"]',
        '[ext_resource type="PackedScene" path="res://resource/prefab/quest/card.tscn" id="3"]',
        '[ext_resource type="PackedScene" path="res://resource/prefab/common/button.tscn" id="4"]',
        '[ext_resource type="Script" path="res://dev/x.gd" id="5"]',
        '[ext_resource type="Script" path="res://common/common_button.gd" id="6"]',
        '[ext_resource type="Texture2D" path="res://resource/image/shop/bg.png" id="7"]',
        '',
      ].join('\n'),
      'resource/prefab/common/button.tscn': [
        '[gd_scene format=3]',
        '[ext_resource type="Script" path="res://features/shop/shop_panel.gd" id="1"]',
        '[ext_resource type="Script" path="res://common/common_button.gd" id="2"]',
        '[ext_resource type="Script" path="res://boot/content_boot.gd" id="3"]',
        '[ext_resource type="Script" path="res://generated/data/game_data.gd" id="4"]',
        '[ext_resource type="Texture2D" path="res://resource/image/common/bg.png" id="5"]',
        '[ext_resource type="Script" path="res://core/ui_core/ui_core.gd" id="6"]',
        '',
      ].join('\n'),
    });
    expect(lines(await featureBoundary.run(sc))).toEqual(sorted([
      'client/common/helper.gd:1 | feature boundary: class_name `Helper` does not start with `Common`',
      'client/features/shop/bad_name.gd:1 | feature boundary: class_name `BadName` does not start with `Shop`',
      'client/features/shop/shop_panel.gd:2 | feature boundary: uses class `QuestBoard` of feature `quest`',
      'client/features/shop/shop_panel.gd:3 | feature boundary: uses `res://features/quest/`',
      'resource/prefab/common/button.tscn:2 | feature boundary: common prefab points to `res://features/shop/shop_panel.gd`',
      'resource/prefab/common/button.tscn:4 | feature boundary: points to `res://boot/content_boot.gd` outside `res://resource/`, `res://common/`, `res://core/`',
      'resource/prefab/common/button.tscn:5 | feature boundary: points to `res://generated/data/game_data.gd` outside `res://resource/`, `res://common/`, `res://core/`',
      'resource/scene/shop/main.tscn:3 | feature boundary: points to `res://features/quest/quest_board.gd` outside `res://resource/`, `res://features/shop/`, `res://common/`, `res://core/`',
      'resource/scene/shop/main.tscn:4 | feature boundary: points to `res://resource/prefab/quest/card.tscn` of feature `quest`',
      'resource/scene/shop/main.tscn:6 | feature boundary: points to `res://dev/x.gd` outside `res://resource/`, `res://features/shop/`, `res://common/`, `res://core/`',
    ]));
  });
});

describe('DEV reference', () => {
  it('finds DEV classes, res://dev/ paths and server imports of server/dev/ outside DEV code', async () => {
    const sc = memContext({
      'client/dev/features/shop/shop_dev.gd': 'class_name ShopDev\nvar a := "res://dev/x.gd"\n',
      'client/dev/generated/dev_registration.gd': 'class_name DevRegistration\n',
      'client/features/shop/shop_panel.gd': 'class_name ShopPanel\nfunc f() -> void:\n\tShopDev.register()\n\tvar p := "res://dev/generated/dev_registration.gd"\n',
      'client/core/qa_core/x.gd': 'var a := "res://dev/y.gd"\n',
      'client/dev/generated/data/game_data_dev.gd': 'class_name GameDataDev\n',
      'client/tests/shop/test_shop.gd': 'extends UnitTestCase\nfunc test_a() -> void:\n\tGameDataDev.set_price(5)\n\tShopDev.register()\n',
      'resource/scene/shop/main.tscn': '[gd_scene format=3]\n[ext_resource type="Script" path="res://dev/a.gd" id="1"]\n',
      'resource/x.tres': '[gd_resource type="Resource" script_class="DevRegistration" format=3]\n',
      'server/handlers/Buy.ts': "import { cheat } from '../dev/cheats.ts';\nexport * from '../dev/x.ts';\nimport { ok } from '../common/ok.ts';\nconst m = await import('../dev/y.ts');\nimport lib from 'pg';\n",
      'server/dev/main.ts': "import { a } from './a.ts';\n",
      'server/core/start.ts': "await import('../dev/main.ts');\n",
    });
    expect(lines(await devReference.run(sc))).toEqual(sorted([
      'client/features/shop/shop_panel.gd:3 | DEV reference: uses DEV class `ShopDev`',
      'client/features/shop/shop_panel.gd:4 | DEV reference: uses a DEV code `res://` path',
      'resource/scene/shop/main.tscn:2 | DEV reference: uses a DEV code `res://` path',
      'resource/x.tres:1 | DEV reference: uses DEV class `DevRegistration`',
      "server/handlers/Buy.ts:1 | DEV reference: imports DEV code `../dev/cheats.ts`",
      "server/handlers/Buy.ts:2 | DEV reference: imports DEV code `../dev/x.ts`",
      "server/handlers/Buy.ts:4 | DEV reference: imports DEV code `../dev/y.ts`",
    ]));
  });

  it('finds references to core DEV code on both sides', async () => {
    const sc = memContext({
      'client/core/qa_core/dev/qa_core.gd': 'class_name QACore\nextends RefCounted\n',
      'client/core/qa_core/qa_types.gd': 'class_name QATypes\nextends RefCounted\n',
      'client/core/unit_test_core/dev/unit_test_case.gd': 'class_name UnitTestCase\nextends RefCounted\n',
      'client/features/x/x_view.gd': 'class_name XView\nfunc f() -> void:\n\tQACore.mark("a")\n\tQATypes.x()\n\tvar p := "res://core/qa_core/dev/qa_core.gd"\n\tvar q := "res://core/qa_core/qa_types.gd"\n',
      'client/dev/features/x/x_dev.gd': 'class_name XDev\nfunc f() -> void:\n\tQACore.mark("a")\n',
      'client/tests/x/test_x.gd': 'extends UnitTestCase\n',
      'server/handlers/A.ts': "import { cheat } from '../core/cheat/dev/index.ts';\nimport { ok } from '../core/routing/index.ts';\n",
      'server/tests/a.test.ts': "import { connect_server } from '../core/testing/dev/index.ts';\n",
      'server/dev/populate.ts': "import { connect_server } from '../core/testing/dev/index.ts';\n",
    });
    expect(lines(await devReference.run(sc))).toEqual(sorted([
      'client/features/x/x_view.gd:3 | DEV reference: uses DEV class `QACore`',
      'client/features/x/x_view.gd:5 | DEV reference: uses a DEV code `res://` path',
      "server/handlers/A.ts:1 | DEV reference: imports DEV code `../core/cheat/dev/index.ts`",
    ]));
  });
});

describe('class index', () => {
  it('indexes a class_name that follows annotations on its line', async () => {
    const sc = memContext({
      'client/features/quest/quest_base.gd': '@abstract class_name QuestBase extends Node\n',
      'client/features/quest/quest_icon.gd': '@icon("res://resource/image/quest/icon.svg") class_name QuestIcon\nextends Node\n',
      'client/features/shop/shop_p.gd': 'class_name ShopP\nextends QuestBase\nvar i: QuestIcon\n',
      'client/dev/features/shop/shop_dev.gd': '@abstract class_name ShopDev extends RefCounted\n',
      'client/features/shop/shop_q.gd': 'class_name ShopQ\nfunc f() -> void:\n\tShopDev.register()\n',
    });
    expect(lines(await featureBoundary.run(sc))).toEqual(sorted([
      'client/features/shop/shop_p.gd:2 | feature boundary: uses class `QuestBase` of feature `quest`',
      'client/features/shop/shop_p.gd:3 | feature boundary: uses class `QuestIcon` of feature `quest`',
    ]));
    expect(lines(await devReference.run(sc))).toEqual(['client/features/shop/shop_q.gd:3 | DEV reference: uses DEV class `ShopDev`']);
  });
});

describe('embedded script', () => {
  it('finds GDScript embedded in scenes and resources', async () => {
    const sc = memContext({
      'resource/scene/a/main.tscn': '[gd_scene format=3]\n\n[sub_resource type="GDScript" id="s1"]\nscript/source = "extends Node"\n',
      'client/features/a/x.tres': '[gd_resource type="GDScript" format=3]\n',
      'resource/scene/a/ok.tscn': '[gd_scene format=3]\n[ext_resource type="Script" path="res://features/a/a.gd" id="1"]\n',
      'client/core/a/b.tscn': '[sub_resource type="GDScript" id="1"]\n',
    });
    expect(lines(await embeddedScript.run(sc))).toEqual([
      'client/features/a/x.tres:1 | embedded script: script embedded in the file; put it in a `.gd` file',
      'resource/scene/a/main.tscn:3 | embedded script: script embedded in the file; put it in a `.gd` file',
    ]);
  });
});

describe('settings access and system clock', () => {
  it('finds settings reads in client and server content code', async () => {
    const sc = memContext({
      'client/features/a/a_x.gd': 'func f() -> void:\n\tvar v := CoreSettings.get_int("a")\n\tvar p := "res://generated/core_settings.json"\n\tvar q := "user://settings.json"\n',
      'client/dev/features/a/a_dev.gd': 'var v := CoreSettings.x\n',
      'server/handlers/A.ts': "const a = readFileSync('settings.json');\nconst b = `core-settings.json`;\nconst c = 'other.json';\n",
      'server/dev/populate.ts': "const a = 'settings.json';\n",
    });
    expect(lines(await settingsAccess.run(sc))).toEqual(sorted([
      'client/features/a/a_x.gd:2 | settings access: `CoreSettings`',
      'client/features/a/a_x.gd:3 | settings access: `settings.json`',
      'client/features/a/a_x.gd:4 | settings access: `settings.json`',
      'server/handlers/A.ts:1 | settings access: `settings.json`',
      'server/handlers/A.ts:2 | settings access: `settings.json`',
    ]));
  });

  it('finds system clock reads in server content code', async () => {
    const sc = memContext({
      'server/handlers/A.ts': [
        'const a = Date.now();',
        'const b = new Date();',
        'const c = new Date(5);',
        'const d = performance.now();',
        'const e = performance.timeOrigin;',
        'const f = process.hrtime.bigint();',
        'const g = process.uptime();',
        'const h = Date();',
        'const i = core.server_time.now(ctx);',
        'const j = Math.floor(performance.timeOrigin);',
        '',
      ].join('\n'),
      'server/core/clock.ts': 'const a = Date.now();\n',
      'server/generated/x.ts': 'const a = Date.now();\n',
    });
    expect(lines(await systemClock.run(sc))).toEqual([
      'server/handlers/A.ts:1 | system clock: `Date.now()`',
      'server/handlers/A.ts:2 | system clock: `new Date()`',
      'server/handlers/A.ts:4 | system clock: `performance.now()`',
      'server/handlers/A.ts:5 | system clock: `performance.timeOrigin`',
      'server/handlers/A.ts:6 | system clock: `process.hrtime.bigint()`',
      'server/handlers/A.ts:7 | system clock: `process.uptime()`',
      'server/handlers/A.ts:8 | system clock: `Date()`',
      'server/handlers/A.ts:10 | system clock: `performance.timeOrigin`',
    ]);
  });

  it('finds the clock through globalThis, imports and uncalled references', async () => {
    const sc = memContext({
      'server/handlers/B.ts': [
        "import { hrtime, uptime as up } from 'node:process';",
        "import proc from 'process';",
        "import { performance as perf } from 'node:perf_hooks';",
        'const a = globalThis.Date.now();',
        'const b = new globalThis.Date();',
        'const c = hrtime.bigint();',
        'const d = up();',
        'const now = Date.now;',
        'const e = proc.hrtime();',
        'const f = perf.now();',
        'const g = global.performance.timeOrigin;',
        'const h = other.hrtime();',
        'const i = new globalThis.Date(5);',
        "import * as hooks from 'node:perf_hooks';",
        'const j = hooks.performance.now();',
        '',
      ].join('\n'),
    });
    expect(lines(await systemClock.run(sc))).toEqual([
      'server/handlers/B.ts:4 | system clock: `Date.now()`',
      'server/handlers/B.ts:5 | system clock: `new Date()`',
      'server/handlers/B.ts:6 | system clock: `process.hrtime.bigint()`',
      'server/handlers/B.ts:7 | system clock: `process.uptime()`',
      'server/handlers/B.ts:8 | system clock: `Date.now`',
      'server/handlers/B.ts:9 | system clock: `process.hrtime()`',
      'server/handlers/B.ts:10 | system clock: `performance.now()`',
      'server/handlers/B.ts:11 | system clock: `performance.timeOrigin`',
      'server/handlers/B.ts:15 | system clock: `performance.now()`',
    ]);
  });
});

describe('data literal', () => {
  it('finds ID names of the data and resource keys in string literals, outside log calls, on both sides', async () => {
    const sc = memContext({
      'data/tables/item.csv': 'desc,desc\nAll,All\nid,int\nid,price\n[sword_basic],0\n',
      'client/features/shop/shop_panel.gd': [
        'class_name ShopPanel',
        'func f() -> void:',
        '\tvar id := "[sword_basic]"',
        '\tResourceCore.load_resource("prefab/enemy/slime")',
        '\tlabel.text = "[b]x[/b]"',
        '\tLogCore.info("shop", "bought [sword_basic] for 3")',
        '\tvar path := "Panel/Label"',
        '',
      ].join('\n'),
      'server/handlers/Buy.ts': [
        "const id = 'x[sword_basic]';",
        "const key = 'icon/skill_fireball';",
        "export function register(core: { logging: { log: (...args: unknown[]) => null } }): void {",
        "  const { logging } = core;",
        "  core.logging.log(null, 'info', 'retry [sword_basic]', { attempt: 3 });",
        "  logging.log(null, 'info', 'retry', { attempt: 4 });",
        "  Math.log(6);",
        "}",
        '',
      ].join('\n'),
    });
    expect(lines(await dataLiteral.run(sc))).toEqual(sorted([
      'client/features/shop/shop_panel.gd:3 | data literal: ID name `[sword_basic]` in a string literal',
      'client/features/shop/shop_panel.gd:4 | data literal: resource key `prefab/enemy/slime` in a string literal',
      'server/handlers/Buy.ts:1 | data literal: ID name `[sword_basic]` in a string literal',
      'server/handlers/Buy.ts:2 | data literal: resource key `icon/skill_fireball` in a string literal',
      'server/handlers/Buy.ts:7 | data literal: number literal `6` outside a constants file',
    ]));
  });

  it('finds numbers outside constants files, uncommented constants and translation key literals', async () => {
    const sc = memContext({
      'client/features/shop/shop_panel.gd': [
        'class_name ShopPanel',
        'var a := 0 + 1 - 1 + 2 + 0.5 + 1.0',
        'var b := 3',
        'var c := -1',
        'var d := -2',
        'var e := x - 5',
        'func f() -> void:',
        '\tLogCore.info("tag", 42)',
        '\tLocalizationCore.get_text("shop.title")',
        '\tLocalizationCore.get_text("")',
        '\tLocalizationCore.bind_text(label, "a.b")',
        '\tMessageCore.show_toast(GameData.key)',
        '\tRequirementCore.register_judge(t, f, [], "guide.key")',
        '\tvar arr := [0x10]',
        '',
      ].join('\n'),
      'client/features/shop/constants.gd': 'const GRID := 8 # board width is a code structure\nconst SPEED := 300\n## doc\nconst MASK := 0xFF #\nvar RATE := 300\n',
      'client/tests/shop/test_a.gd': 'var a := 99\n',
      'server/handlers/Buy.ts': 'const a = 10;\nconst b = -1;\nconst c = 0.5;\nconst d = 100n;\ntype T = 5 | 6;\nconst e = -3;\n',
      'server/common/constants.ts': 'export const A = 5; // modulo of the ring buffer\nexport const B = 6;\nconst C = {\n  x: 1,\n}; // reason\nlet D = 4;\nexport function f() { return 500; }\n',
      'server/tests/buy.test.ts': 'const a = 77;\n',
    });
    expect(lines(await dataLiteral.run(sc))).toEqual(sorted([
      'client/features/shop/constants.gd:2 | data literal: constant `SPEED` has no same-line comment with the reason it is not game data',
      'client/features/shop/constants.gd:4 | data literal: constant `MASK` has no same-line comment with the reason it is not game data',
      'client/features/shop/constants.gd:5 | data literal: number literal `300` outside a named constant declaration',
      'client/features/shop/shop_panel.gd:3 | data literal: number literal `3` outside a constants file',
      'client/features/shop/shop_panel.gd:5 | data literal: number literal `-2` outside a constants file',
      'client/features/shop/shop_panel.gd:6 | data literal: number literal `5` outside a constants file',
      'client/features/shop/shop_panel.gd:9 | data literal: string literal passed as a translation key to `LocalizationCore.get_text`',
      'client/features/shop/shop_panel.gd:11 | data literal: string literal passed as a translation key to `LocalizationCore.bind_text`',
      'client/features/shop/shop_panel.gd:13 | data literal: string literal passed as a translation key to `RequirementCore.register_judge`',
      'client/features/shop/shop_panel.gd:14 | data literal: number literal `0x10` outside a constants file',
      'server/common/constants.ts:2 | data literal: constant has no same-line comment with the reason it is not game data',
      'server/common/constants.ts:6 | data literal: number literal `4` outside a named constant declaration',
      'server/common/constants.ts:7 | data literal: number literal `500` outside a named constant declaration',
      'server/handlers/Buy.ts:1 | data literal: number literal `10` outside a constants file',
      'server/handlers/Buy.ts:4 | data literal: number literal `100n` outside a constants file',
      'server/handlers/Buy.ts:6 | data literal: number literal `-3` outside a constants file',
    ]));
  });
});
