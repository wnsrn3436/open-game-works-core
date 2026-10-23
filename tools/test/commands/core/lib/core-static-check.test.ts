import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Context } from '../../../../src/lib/command.ts';
import { godotCoreStaticCheck } from '../../../../src/commands/core/lib/core-static-check.ts';
import { writeFiles } from '../helpers.ts';

const ctx = {} as Context;

/** Runs the Godot core static check on a temp `open-game-works-core-impl/` whose `client/godot/` holds `files`. */
async function check(files: Record<string, string>): Promise<string[]> {
  const impl = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-core-static-')));
  writeFiles(impl, Object.fromEntries(Object.entries(files).map(([p, text]) => [`client/godot/${p}`, text])));
  return godotCoreStaticCheck(ctx, impl);
}

const gd = (lines: string[]): string => `${lines.join('\n')}\n`;
const P = 'client/godot/core';
const FILE = 'resource loading: file other than `.gd` and `.uid` in core code; core makes its screen elements with code';
const VARIANT = 'GDScript: `Variant` notation outside the parameters and body of an input boundary function';
const UNTYPED = (t: string): string => `GDScript: untyped \`${t}\` outside the parameters and body of an input boundary function`;
const MARKER = 'GDScript: `# ogw:input_boundary` is not a comment line of its own directly above a `func` line';

describe('godotCoreStaticCheck GDScript', () => {
  it('allows Variant and untyped Array, Dictionary only in the parameters and body of an input boundary function', async () => {
    const out = await check({
      'core/auth_core/auth_core.gd': gd([
        'class_name AuthCore',
        '# ogw:input_boundary',
        'static func _read(raw: Variant, n: int = 0) -> Variant:',
        '\tvar d: Dictionary[Variant, Variant] = {}',
        '\tfor k: Variant in d:',
        '\t\tpass',
        '\tvar x: Variant = Array()',
        '\tif raw is Dictionary:',
        '\t\tvar m: Dictionary = raw as Dictionary',
        '\treturn raw',
        'static var _v: Variant',
        '',
        '# ogw:input_boundary',
        '',
        'static func _other(a: Variant) -> void:',
        '\tvar w: Variant',
        'static func _t(a: int) -> void: # ogw:input_boundary',
        '\tvar b: Array = []',
        '\tvar c: Dictionary = {}',
        '\tassert(a > 0)',
        '\tvar s: String = "uid://abc"',
        '\tvar e: Array[int] = []',
        '# ogw:input_boundary',
        'static func _list(raw: Array) -> Array:',
        '\treturn raw',
      ]),
    });
    expect(out).toEqual([
      `${P}/auth_core/auth_core.gd:3: ${VARIANT}`,
      `${P}/auth_core/auth_core.gd:11: ${VARIANT}`,
      `${P}/auth_core/auth_core.gd:13: ${MARKER}`,
      `${P}/auth_core/auth_core.gd:15: ${VARIANT}`,
      `${P}/auth_core/auth_core.gd:16: ${VARIANT}`,
      `${P}/auth_core/auth_core.gd:17: ${MARKER}`,
      `${P}/auth_core/auth_core.gd:18: ${UNTYPED('Array')}`,
      `${P}/auth_core/auth_core.gd:19: ${UNTYPED('Dictionary')}`,
      `${P}/auth_core/auth_core.gd:20: GDScript: \`assert\``,
      `${P}/auth_core/auth_core.gd:21: GDScript: \`uid://\` string`,
      `${P}/auth_core/auth_core.gd:24: ${UNTYPED('Array')}`,
    ]);
  });

  it('flags name-string APIs, OS feature checks, and tween calls outside TweenCore, but not static var or the editor hint', async () => {
    const body = gd([
      'class_name X',
      'static var _count: int = 0',
      'static func f(o: Object, c: Callable) -> void:',
      '\to.call("go")',
      '\tc.call()',
      '\to.emit_signal("done")',
      '\tvar t: Tween = o.create_tween()',
      '\tt.tween_property(o, "x", 1, 1)',
      '\tif OS.is_debug_build() or OS.has_feature("web") or Engine.is_editor_hint():',
      '\t\tpass',
    ]);
    const out = await check({ 'core/ui_core/ui_core.gd': body, 'core/tween_core/tween_core.gd': body.replace('class_name X', 'class_name TweenCore') });
    expect(out).toEqual([
      `${P}/tween_core/tween_core.gd:4: GDScript: \`call()\` by method name`,
      `${P}/tween_core/tween_core.gd:6: GDScript: \`emit_signal()\``,
      `${P}/tween_core/tween_core.gd:9: GDScript: \`OS.has_feature()\``,
      `${P}/tween_core/tween_core.gd:9: GDScript: \`OS.is_debug_build()\``,
      `${P}/ui_core/ui_core.gd:4: GDScript: \`call()\` by method name`,
      `${P}/ui_core/ui_core.gd:6: GDScript: \`emit_signal()\``,
      `${P}/ui_core/ui_core.gd:7: GDScript: \`create_tween()\``,
      `${P}/ui_core/ui_core.gd:8: GDScript: \`tween_property()\``,
      `${P}/ui_core/ui_core.gd:9: GDScript: \`OS.has_feature()\``,
      `${P}/ui_core/ui_core.gd:9: GDScript: \`OS.is_debug_build()\``,
    ]);
  });

  it('allows @warning_ignore("unsafe_method_access") only in core adapters', async () => {
    const body = gd([
      'extends RefCounted',
      'func buy(id: String) -> void:',
      '\tvar s: Object = Engine.get_singleton("Store")',
      '\t@warning_ignore("unsafe_method_access")',
      '\ts.purchase(id)',
      '\t@warning_ignore("unsafe_cast")',
      '\tpass',
    ]);
    const out = await check({
      'core/payment_core/adapters/apple_adapter.gd': body,
      'core/payment_core/dev/adapters/fake_adapter.gd': body,
      'core/payment_core/payment_core.gd': body,
    });
    expect(out).toEqual([`${P}/payment_core/payment_core.gd:4: GDScript: \`@warning_ignore("unsafe_method_access")\` outside a core adapter`]);
  });
});

describe('godotCoreStaticCheck frame code', () => {
  it('follows frame code into the core functions it calls and the methods connected to frame signals', async () => {
    const out = await check({
      'core/scene_core/scene_core_node.gd': gd([
        'class_name SceneCoreNode',
        'extends Node',
        'func _process(_d: float) -> void:',
        '\t_step()',
        '\tvar n: Node = get_node("a")',
        'func _step() -> void:',
        '\tawait get_tree().create_timer(1.0).timeout',
        '\tFrameHelper.go()',
        '\t_step()',
        'func _ready() -> void:',
        '\tget_tree().process_frame.connect(_on_frame)',
        '\tget_tree().physics_frame.connect(func() -> void: find_child("y"))',
        '\tvar m: Node = $Child',
        'func _on_frame() -> void:',
        '\tvar c: Node = find_child("x")',
        'func _integrate_forces(_s: PhysicsDirectBodyState3D) -> void:',
        '\tvar u: Node = %Unique',
      ]),
      'core/scene_core/frame_helper.gd': gd([
        'class_name FrameHelper',
        'static func go() -> void:',
        '\tvar h: FrameHelper = null',
        '\th.deep()',
        'func deep() -> void:',
        '\tvar p: Node = get_node("p")',
        'static func unused() -> void:',
        '\tvar q: Node = get_node("q")',
      ]),
    });
    expect(out).toEqual([
      `${P}/scene_core/frame_helper.gd:6: frame code: \`get_node()\` in \`deep\`, frame code from \`_process\``,
      `${P}/scene_core/scene_core_node.gd:5: frame code: \`get_node()\` in \`_process\``,
      `${P}/scene_core/scene_core_node.gd:7: frame code: \`await\` in \`_step\`, frame code from \`_process\``,
      `${P}/scene_core/scene_core_node.gd:12: frame code: \`find_child()\` in a lambda, frame code from \`SceneTree.physics_frame\``,
      `${P}/scene_core/scene_core_node.gd:15: frame code: \`find_child()\` in \`_on_frame\`, frame code from \`SceneTree.process_frame\``,
      `${P}/scene_core/scene_core_node.gd:17: frame code: \`%\` node path in \`_integrate_forces\``,
    ]);
  });

  it('treats every frame entry point as frame code', async () => {
    const out = await check({
      'core/input_core/input_core_node.gd': gd([
        'class_name InputCoreNode',
        'extends Control',
        'func _physics_process(_d: float) -> void:',
        '	var a: Node = get_node("a")',
        'func _input(_e: InputEvent) -> void:',
        '	var b: Node = find_child("b")',
        'func _unhandled_input(_e: InputEvent) -> void:',
        '	var c: Node = $C',
        'func _gui_input(_e: InputEvent) -> void:',
        '	await get_tree().create_timer(1.0).timeout',
        'func _ready() -> void:',
        '	var d: Node = get_node("d")',
      ]),
    });
    expect(out).toEqual([
      `${P}/input_core/input_core_node.gd:4: frame code: \`get_node()\` in \`_physics_process\``,
      `${P}/input_core/input_core_node.gd:6: frame code: \`find_child()\` in \`_input\``,
      `${P}/input_core/input_core_node.gd:8: frame code: \`$\` node path in \`_unhandled_input\``,
      `${P}/input_core/input_core_node.gd:10: frame code: \`await\` in \`_gui_input\``,
    ]);
  });

  it('follows a Callable field and a bound Callable connected to a frame signal', async () => {
    const out = await check({
      'core/scene_core/scene_core_node.gd': gd([
        'class_name SceneCoreNode',
        'extends Node',
        'var _cb: Callable',
        'func _ready() -> void:',
        '	_cb = _on_frame',
        '	get_tree().process_frame.connect(_cb)',
        '	get_tree().physics_frame.connect(_on_physics.bind(1))',
        'func _on_frame() -> void:',
        '	var c: Node = find_child("x")',
        '	await get_tree().create_timer(1.0).timeout',
        'func _on_physics(_n: int) -> void:',
        '	var p: Node = get_node("p")',
      ]),
    });
    expect(out).toEqual([
      `${P}/scene_core/scene_core_node.gd:9: frame code: \`find_child()\` in \`_on_frame\`, frame code from \`SceneTree.process_frame\``,
      `${P}/scene_core/scene_core_node.gd:10: frame code: \`await\` in \`_on_frame\`, frame code from \`SceneTree.process_frame\``,
      `${P}/scene_core/scene_core_node.gd:12: frame code: \`get_node()\` in \`_on_physics\`, frame code from \`SceneTree.physics_frame\``,
    ]);
  });
});

describe('godotCoreStaticCheck resource loading', () => {
  it('allows engine load functions only in ResourceCore, own-folder preload constants and the two DEV loads', async () => {
    const out = await check({
      'core/resource_core/resource_core.gd': gd(['class_name ResourceCore', 'static func f() -> void:', '\tvar r: Resource = load("res://a.png")']),
      'core/ui_core/ui_core.gd': gd([
        'class_name UICore',
        'const HELPER := preload("res://core/ui_core/helper.gd")',
        'const OTHER := preload("res://core/log_core/x.gd")',
        'const SCENE := preload("res://core/ui_core/a.tscn")',
        'static func f() -> void:',
        '\tvar r: Resource = load("res://a.png")',
        '\tvar h: GDScript = preload("res://core/ui_core/helper.gd")',
        '\tvar i: Image = Image.load_from_file("a.png")',
        '\tResourceLoader.load_threaded_request("res://a.png")',
        '\tvar l: Resource = ResourceLoader.load("res://a.png")',
        '\tvar g: Resource = ResourceLoader.load_threaded_get("res://a.png")',
        '\tvar m: Image = Image.new()',
        '\tm.load("a.png")',
      ]),
      'core/core_settings.gd': gd(['class_name CoreSettings', 'const H := preload("res://core/x.gd")']),
      'core/core_build_info.gd': gd(['class_name CoreBuildInfo', 'const DEV_ENTRY_PATH := "res://core/bootstrap_core/dev/bootstrap_core_dev.gd"']),
      'core/bootstrap_core/bootstrap_core.gd': gd([
        'class_name BootstrapCore',
        'const DEV_ENTRY := "res://core/bootstrap_core/dev/bootstrap_core_dev.gd"',
        'static func f() -> void:',
        '\tvar a: Resource = load(DEV_ENTRY)',
        '\tvar b: Resource = load(CoreBuildInfo.DEV_ENTRY_PATH)',
        '\tvar c: Resource = load("res://core/bootstrap_core/dev/bootstrap_core_dev.gd")',
        '\tvar d: Resource = load(CoreBuildInfo.MISSING)',
      ]),
      'core/bootstrap_core/dev/bootstrap_core_dev.gd': gd([
        'class_name BootstrapCoreDev',
        'const REG := "res://dev/generated/dev_registration.gd"',
        'static func f() -> void:',
        '\tvar a: Resource = load(REG)',
        '\tvar b: Resource = load(BootstrapCore.DEV_ENTRY)',
      ]),
    });
    expect(out).toEqual([
      `${P}/bootstrap_core/bootstrap_core.gd:6: DEV reference: uses a \`dev/\` path`,
      `${P}/bootstrap_core/bootstrap_core.gd:6: resource loading: \`load()\` outside ResourceCore`,
      `${P}/bootstrap_core/bootstrap_core.gd:7: resource loading: \`load()\` outside ResourceCore`,
      `${P}/bootstrap_core/dev/bootstrap_core_dev.gd:5: resource loading: \`load()\` outside ResourceCore`,
      `${P}/core_settings.gd:2: resource loading: \`preload()\` outside ResourceCore`,
      `${P}/ui_core/ui_core.gd:3: resource loading: \`preload()\` outside ResourceCore`,
      `${P}/ui_core/ui_core.gd:4: resource loading: \`preload()\` outside ResourceCore`,
      `${P}/ui_core/ui_core.gd:6: resource loading: \`load()\` outside ResourceCore`,
      `${P}/ui_core/ui_core.gd:7: resource loading: \`preload()\` outside ResourceCore`,
      `${P}/ui_core/ui_core.gd:8: resource loading: \`Image.load_from_file()\` outside ResourceCore`,
      `${P}/ui_core/ui_core.gd:9: resource loading: \`ResourceLoader.load_threaded_request()\` outside ResourceCore`,
      `${P}/ui_core/ui_core.gd:10: resource loading: \`ResourceLoader.load()\` outside ResourceCore`,
      `${P}/ui_core/ui_core.gd:11: resource loading: \`ResourceLoader.load_threaded_get()\` outside ResourceCore`,
      `${P}/ui_core/ui_core.gd:13: resource loading: \`Image.load()\` outside ResourceCore`,
    ]);
  });

  it('allows PackedScene.instantiate() only in the listed modules and flags resource files outside core tests', async () => {
    const body = gd([
      'class_name M',
      'static func f(s: PackedScene, g: Grid, u) -> void:',
      '\tvar a: Node = s.instantiate()',
      '\tvar b: Node = g.instantiate()',
      '\tvar c: Node = u.instantiate()',
      'class Grid:',
      '\tfunc instantiate() -> Node:',
      '\t\treturn null',
    ]);
    const out = await check({
      'core/pool_core/pool_core.gd': body.replace('class_name M', 'class_name PoolCore'),
      'core/log_core/log_core.gd': body.replace('class_name M', 'class_name LogCore'),
      'core/log_core/icon.png': 'png',
      'core/log_core/look.tres': 'tres',
      'core/log_core/tests/resources/a.png': 'png',
      'core/log_core/log_core.gd.uid': 'uid://x',
      'core/log_core/notes.json': '{}',
      'core/log_core/dev/fake.txt': 'x',
    });
    expect(out).toEqual([
      `${P}/log_core/dev/fake.txt:1: ${FILE}`,
      `${P}/log_core/icon.png:1: ${FILE}`,
      `${P}/log_core/log_core.gd:3: resource loading: \`PackedScene.instantiate()\` outside the modules \`## resource loading\` lets call it`,
      `${P}/log_core/log_core.gd:5: resource loading: \`PackedScene.instantiate()\` outside the modules \`## resource loading\` lets call it`,
      `${P}/log_core/look.tres:1: ${FILE}`,
      `${P}/log_core/notes.json:1: ${FILE}`,
    ]);
  });
});

describe('godotCoreStaticCheck DEV reference', () => {
  it('flags DEV classes and dev/ paths in core code outside DEV code and core tests', async () => {
    const out = await check({
      'core/ui_core/dev/ui_core_dev.gd': gd(['class_name UICoreDev', 'static func f() -> void:', '\tUICoreDev.f()']),
      'core/ui_core/ui_core.gd': gd([
        'class_name UICore',
        'static func f() -> void:',
        '\tUICoreDev.f()',
        '\tvar j: String = ContractJsonDev.to_json(null)',
        '\tvar p: String = "res://core/qa_core/dev/qa.gd"',
        '\tvar q: String = "res://dev/generated/dev_registration.gd"',
        '\tvar r: String = "res://core/bootstrap_core/dev/bootstrap_core_dev.gd"',
      ]),
      'core/ui_core/tests/test_ui.gd': gd(['extends UnitTestCase', 'func test_a() -> void:', '\tUICoreDev.f()']),
      'dev/generated/data/game_data_dev.gd': gd(['class_name GameDataDev']),
      'core/log_core/log_core.gd': gd(['class_name LogCore', 'static func f() -> void:', '\tGameDataDev.clear_settings()']),
    });
    expect(out).toEqual([
      `${P}/log_core/log_core.gd:3: DEV reference: uses DEV class \`GameDataDev\``,
      `${P}/ui_core/ui_core.gd:3: DEV reference: uses DEV class \`UICoreDev\``,
      `${P}/ui_core/ui_core.gd:4: DEV reference: uses DEV class \`ContractJsonDev\``,
      `${P}/ui_core/ui_core.gd:5: DEV reference: uses a \`dev/\` path`,
      `${P}/ui_core/ui_core.gd:6: DEV reference: uses a \`dev/\` path`,
      `${P}/ui_core/ui_core.gd:7: DEV reference: uses a \`dev/\` path`,
    ]);
  });
});

describe('godotCoreStaticCheck engine random, log_debug and data changes', () => {
  it('flags engine random functions in every core file', async () => {
    const out = await check({
      'core/util_core/util_core.gd': gd(['class_name UtilCore', 'static func f(a: Array[int]) -> int:', '\ta.shuffle()', '\treturn randi()']),
    });
    expect(out).toEqual([
      `${P}/util_core/util_core.gd:3: engine random: \`Array.shuffle()\``,
      `${P}/util_core/util_core.gd:4: engine random: \`randi()\``,
    ]);
  });

  it('allows log_debug only as a one-line statement of the removal form', async () => {
    const out = await check({
      'core/log_core/log_core.gd': gd([
        'class_name LogCore',
        'static func log_debug(tag: String, message: String) -> void:',
        '\tpass',
        'static func f(x: bool) -> void:',
        '\tLogCore.log_debug("t", "m")',
        '\t\tLogCore.log_debug("t", "m")   ',
        '\tLogCore.log_debug("t", "m")  # note',
        '\tif x: LogCore.log_debug("t", "m")',
        '\tLogCore.log_debug("t",',
        '\t\t"m")',
        '\tvar f: Callable = LogCore.log_debug',
        '\tLogCore.log_debug("a", "b"); pass',
        '\tlog_debug("t", "m")',
        '\tLogCore.log_debug("t", "m")\r',
      ]),
    });
    const form = 'log_debug: `log_debug` is not a one-line statement `LogCore.log_debug(...)` that STG and PROD builds replace with `pass`';
    expect(out).toEqual([7, 8, 9, 11, 12, 13, 14].map((line) => `${P}/log_core/log_core.gd:${String(line)}: ${form}`));
  });

  it('flags game data row, list and container changes outside DataCore', async () => {
    const body = gd([
      'class_name Q',
      'static func f() -> void:',
      '\tvar rows: Array[GameData.ItemRow] = GameData.ItemTable.all_rows()',
      '\trows.append(GameData.ItemTable.empty_row())',
      '\tvar row: GameData.ItemRow = GameData.ItemTable.get_row(1)',
      '\trow.amount = 2',
      '\tGameData.clear()',
      '\tGameData.load_tables({})',
    ]);
    const out = await check({ 'core/data_core/data_core.gd': body, 'core/mission_core/mission_core.gd': body });
    expect(out).toEqual([
      `${P}/mission_core/mission_core.gd:4: data change: \`append()\` on game data`,
      `${P}/mission_core/mission_core.gd:6: data change: assignment to \`.amount\` of game data`,
      `${P}/mission_core/mission_core.gd:7: data change: \`GameData.clear()\` changes game data containers outside DataCore`,
      `${P}/mission_core/mission_core.gd:8: data change: \`GameData.load_tables()\` changes game data containers outside DataCore`,
    ]);
  });

  it('passes a project without core code', async () => {
    expect(await check({ 'engine.json': '{}' })).toEqual([]);
  });
});

describe('godotCoreStaticCheck private names', () => {
  it('refuses a `_` name of a class of another module folder, and allows it in its own module folder and outside module folders', async () => {
    const out = await check({
      'core/auth_core/auth_core.gd': gd(['class_name AuthCore', 'static func _hidden() -> void:', '\tpass']),
      'core/auth_core/dev/auth_core_dev.gd': gd(['class_name AuthCoreDev', 'static func _use() -> void:', '\tAuthCore._hidden()']),
      'core/auth_core/tests/test_auth.gd': gd(['extends RefCounted', 'func test_a() -> void:', '\tAuthCoreDev._use()']),
      'core/core_settings.gd': gd(['class_name CoreSettings', 'static var _test_values: Dictionary[String, int] = {}']),
      'core/bootstrap_core/dev/bootstrap_core_dev.gd': gd([
        'class_name BootstrapCoreDev',
        'static func pass_storage() -> void:',
        '\tAuthCoreDev._use()',
        '\tCoreSettings._test_values.clear()',
        '\tAuthCore.init()',
      ]),
    });
    expect(out).toEqual([`${P}/bootstrap_core/dev/bootstrap_core_dev.gd:3: private name: \`AuthCoreDev._use\` is a \`_\` name of module folder \`auth_core\` used outside it`]);
  });
});
