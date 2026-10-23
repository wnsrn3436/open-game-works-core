import { describe, expect, it } from 'vitest';
import * as blockToken from '../../../../src/commands/check/static/block-token.ts';
import * as dataMutation from '../../../../src/commands/check/static/data-mutation.ts';
import * as debugText from '../../../../src/commands/check/static/debug-text.ts';
import * as determinism from '../../../../src/commands/check/static/determinism.ts';
import * as engineRandom from '../../../../src/commands/check/static/engine-random.ts';
import * as forbiddenApi from '../../../../src/commands/check/static/forbidden-api.ts';
import * as frameCode from '../../../../src/commands/check/static/frame-code.ts';
import * as framePolling from '../../../../src/commands/check/static/frame-polling.ts';
import * as literalTiming from '../../../../src/commands/check/static/literal-timing.ts';
import * as resourceLoad from '../../../../src/commands/check/static/resource-load.ts';
import * as testInput from '../../../../src/commands/check/static/test-input.ts';
import { CORE_STUBS, lines, memContext, sorted } from './helpers.ts';

const gd = (body: string): string => body.replace(/^\n/, '');

describe('forbidden GDScript API', () => {
  it('finds forbidden notations, APIs and annotations in content code', async () => {
    const sc = memContext({
      ...CORE_STUBS,
      'client/features/shop/shop_panel.gd': gd(`
@tool
class_name ShopPanel
extends Node
static var count: int = 0
var a: Array = []
var b: Array[int] = []
var c: Dictionary = {}
var v: Variant
var dict: Dictionary[String, int] = {}
var rows: Array[int] = []
var n: Node
var names: Array[String] = []
var grid: Array[PackedInt32Array] = []
var nodes: Array[Node] = []
var flags: Array[bool] = []

# ogw:input_boundary
func f() -> void:
	assert(true)
	var t := create_tween()
	t.tween_property(self, "x", 1, 1)
	var u := "uid://abc"
	if OS.is_debug_build() or OS.has_feature("x") or Engine.is_editor_hint():
		pass
	call("f")
	n.call("f")
	n.call_deferred("f")
	var cb: Callable = f
	cb.call()
	cb.call_deferred()
	get("x")
	n.get("x")
	dict.get("x")
	rows.set(0, 1)
	n.set_deferred("x", 1)
	emit_signal("x")
	n.connect("s", f)
	n.ready.connect(f)
	n.ready.disconnect(f)
	n.disconnect("s", f)
	n.has_method("f")
	n.set_meta("a", 1)
	var c2 := Callable(n, "f")
	get_tree().call_group("g", "f")
	n.propagate_call("f")
	@warning_ignore("unsafe_method_access", "unused_variable")
	v.foo()
	@warning_ignore_start("unsafe_cast")
	@warning_ignore("integer_division")
`),
      'client/core/x/core_thing.gd': 'class_name CoreThing\nvar v: Variant\n',
      'client/generated/data/other.gd': 'var v: Variant\n',
    });
    expect(lines(await forbiddenApi.run(sc))).toEqual(sorted([
      'client/features/shop/shop_panel.gd:1 | forbidden GDScript API: `@tool`',
      'client/features/shop/shop_panel.gd:17 | forbidden GDScript API: `# ogw:input_boundary`',
      'client/features/shop/shop_panel.gd:19 | forbidden GDScript API: `assert`',
      'client/features/shop/shop_panel.gd:20 | forbidden GDScript API: `create_tween()`',
      'client/features/shop/shop_panel.gd:21 | forbidden GDScript API: `tween_property()`',
      'client/features/shop/shop_panel.gd:22 | forbidden GDScript API: `uid://` string',
      'client/features/shop/shop_panel.gd:23 | forbidden GDScript API: `Engine.is_editor_hint()`',
      'client/features/shop/shop_panel.gd:23 | forbidden GDScript API: `OS.has_feature()`',
      'client/features/shop/shop_panel.gd:23 | forbidden GDScript API: `OS.is_debug_build()`',
      'client/features/shop/shop_panel.gd:25 | forbidden GDScript API: `call()`',
      'client/features/shop/shop_panel.gd:26 | forbidden GDScript API: `call()` by method name',
      'client/features/shop/shop_panel.gd:27 | forbidden GDScript API: `call_deferred()` by method name',
      'client/features/shop/shop_panel.gd:31 | forbidden GDScript API: `get()`',
      'client/features/shop/shop_panel.gd:32 | forbidden GDScript API: `get()` by property name',
      'client/features/shop/shop_panel.gd:35 | forbidden GDScript API: `set_deferred()` by property name',
      'client/features/shop/shop_panel.gd:36 | forbidden GDScript API: `emit_signal()`',
      'client/features/shop/shop_panel.gd:37 | forbidden GDScript API: Object `connect()`',
      'client/features/shop/shop_panel.gd:40 | forbidden GDScript API: Object `disconnect()`',
      'client/features/shop/shop_panel.gd:41 | forbidden GDScript API: `has_method()`',
      'client/features/shop/shop_panel.gd:42 | forbidden GDScript API: `set_meta()`',
      'client/features/shop/shop_panel.gd:43 | forbidden GDScript API: `Callable(obj, "name")`',
      'client/features/shop/shop_panel.gd:44 | forbidden GDScript API: `call_group()`',
      'client/features/shop/shop_panel.gd:45 | forbidden GDScript API: `propagate_call()`',
      'client/features/shop/shop_panel.gd:46 | forbidden GDScript API: `@warning_ignore("unsafe_method_access")`',
      'client/features/shop/shop_panel.gd:48 | forbidden GDScript API: `@warning_ignore_start("unsafe_cast")`',
      'client/features/shop/shop_panel.gd:4 | forbidden GDScript API: `static var`',
      'client/features/shop/shop_panel.gd:6 | forbidden GDScript API: `Array[int]`; use `PackedInt32Array` or `PackedInt64Array`',
      'client/features/shop/shop_panel.gd:10 | forbidden GDScript API: `Array[int]`; use `PackedInt32Array` or `PackedInt64Array`',
      'client/features/shop/shop_panel.gd:12 | forbidden GDScript API: `Array[String]`; use `PackedStringArray`',
      'client/features/shop/shop_panel.gd:5 | forbidden GDScript API: untyped `Array`',
      'client/features/shop/shop_panel.gd:7 | forbidden GDScript API: untyped `Dictionary`',
      'client/features/shop/shop_panel.gd:8 | forbidden GDScript API: `Variant` notation',
    ]));
  });
});

describe('forbidden GDScript API: inferred collections, node references, file names', () => {
  it('finds := array and dictionary literals, node lookups outside @onready var values and file names off the class_name', async () => {
    const sc = memContext({
      'client/features/shop/shop_panel.gd': gd(`
class_name ShopPanel
extends Node
@onready var label: Label = $Label
@onready var title: Label = get_node("Title")
@export var icon: TextureRect
var typed: Array[Node] = []
var typed_dict: Dictionary[String, Node] = {}
func f() -> void:
	var a := []
	var d := {}
	var e := [] as Array[Node]
	$Label.visible = false
	var other := get_node_or_null("Other")
	var found := find_child("x")
	var unique := %Unique
`),
      'client/features/shop/foo.gd': 'class_name ShopThing\nextends Node\n',
      'client/features/shop/shop_ui_box.gd': 'class_name ShopUIBox\nextends Node\n',
      'client/features/shop/constants.gd': 'class_name ShopConstants\nconst GRID := 8\n',
      'client/common/whatever.gd': 'class_name CommonLoader\nextends Node\n',
    });
    expect(lines(await forbiddenApi.run(sc))).toEqual(sorted([
      'client/features/shop/foo.gd:1 | forbidden GDScript API: file name `foo.gd` is not the snake_case of `class_name ShopThing` (`shop_thing.gd`)',
      'client/features/shop/shop_panel.gd:9 | forbidden GDScript API: untyped `Array` inferred by `:=` for `a`',
      'client/features/shop/shop_panel.gd:10 | forbidden GDScript API: untyped `Dictionary` inferred by `:=` for `d`',
      'client/features/shop/shop_panel.gd:12 | forbidden GDScript API: `$` node path outside an `@onready var`; keep node references in `@onready var` or `@export var` fields',
      'client/features/shop/shop_panel.gd:13 | forbidden GDScript API: `get_node_or_null()` outside an `@onready var`; keep node references in `@onready var` or `@export var` fields',
      'client/features/shop/shop_panel.gd:14 | forbidden GDScript API: `find_child()` outside an `@onready var`; keep node references in `@onready var` or `@export var` fields',
      'client/features/shop/shop_panel.gd:15 | forbidden GDScript API: `%` node path outside an `@onready var`; keep node references in `@onready var` or `@export var` fields',
    ]));
  });
});

describe('resource load and engine random', () => {
  it('finds engine load functions', async () => {
    const sc = memContext({
      'client/common/common_loader.gd': gd(`
class_name CommonLoader
var img: Image
func f() -> void:
	var a := load("res://a.tscn")
	const B = preload("res://b.gd")
	ResourceLoader.load("x")
	ResourceLoader.load_threaded_request("x")
	ResourceLoader.load_threaded_get("x")
	img.load("x")
	Image.load_from_file("x")
	ResourceCore.load("key", scope)
	DataCore.load()
	var img2 := Image.new()
	img2.load("user://a.png")
`),
    });
    expect(lines(await resourceLoad.run(sc))).toEqual(sorted([
      'client/common/common_loader.gd:10 | resource load: `Image.load_from_file()`',
      'client/common/common_loader.gd:14 | resource load: `Image.load()`',
      'client/common/common_loader.gd:4 | resource load: `load()`',
      'client/common/common_loader.gd:5 | resource load: `preload()`',
      'client/common/common_loader.gd:6 | resource load: `ResourceLoader.load()`',
      'client/common/common_loader.gd:7 | resource load: `ResourceLoader.load_threaded_request()`',
      'client/common/common_loader.gd:8 | resource load: `ResourceLoader.load_threaded_get()`',
      'client/common/common_loader.gd:9 | resource load: `Image.load()`',
    ]));
  });

  it('finds engine random functions', async () => {
    const sc = memContext({
      'client/common/common_dice.gd': gd(`
class_name CommonDice
func f(items: Array[int]) -> void:
	randomize()
	var a := randi() + randi_range(1, 2) + randf() + randf_range(0, 1) + randfn(0, 1)
	seed(1)
	rand_from_seed(1)
	var r := RandomNumberGenerator.new()
	items.shuffle()
	items.pick_random()
	UtilCore.shuffle_indices(r, 3)
	var d := CommonCardsDeck.new()
	d.shuffle(r)
	var p := PackedInt32Array()
	p.shuffle()
	unknown.pick_random()
`),
      'client/common/common_cards_deck.gd': 'class_name CommonCardsDeck\nextends RefCounted\nfunc shuffle(rng: UtilCore) -> void:\n\tpass\n',
    });
    expect(lines(await engineRandom.run(sc))).toEqual(sorted([
      'client/common/common_dice.gd:3 | engine random: `randomize()`',
      'client/common/common_dice.gd:4 | engine random: `randf()`',
      'client/common/common_dice.gd:4 | engine random: `randf_range()`',
      'client/common/common_dice.gd:4 | engine random: `randfn()`',
      'client/common/common_dice.gd:4 | engine random: `randi()`',
      'client/common/common_dice.gd:4 | engine random: `randi_range()`',
      'client/common/common_dice.gd:5 | engine random: `seed()`',
      'client/common/common_dice.gd:6 | engine random: `rand_from_seed()`',
      'client/common/common_dice.gd:7 | engine random: `RandomNumberGenerator`',
      'client/common/common_dice.gd:8 | engine random: `Array.shuffle()`',
      'client/common/common_dice.gd:9 | engine random: `Array.pick_random()`',
      'client/common/common_dice.gd:14 | engine random: `Array.shuffle()`',
      'client/common/common_dice.gd:15 | engine random: `Array.pick_random()`',
    ]));
  });
});

describe('frame code', () => {
  it('finds node lookups, instantiate, queue_free and await in frame functions and their same-class callees', async () => {
    const sc = memContext({
      'client/features/battle/battle_view.gd': gd(`
class_name BattleView
extends Node2D
var scene: PackedScene
func _process(delta: float) -> void:
	var a := get_node("A")
	var b := $B
	_helper()
	self._other()
	outside.helper()
func _helper() -> void:
	var c := %Unique
	find_child("x")
	scene.instantiate()
	queue_free()
	await get_tree().process_frame
func _other() -> void:
	pass
func _ready() -> void:
	var d := $D
func _gui_input(event: InputEvent) -> void:
	_helper()
`),
    });
    expect(lines(await frameCode.run(sc))).toEqual(sorted([
      'client/features/battle/battle_view.gd:11 | frame code: `%` node path in `_helper` called from `_process`',
      'client/features/battle/battle_view.gd:12 | frame code: `find_child()` in `_helper` called from `_process`',
      'client/features/battle/battle_view.gd:13 | frame code: `PackedScene.instantiate()` in `_helper` called from `_process`',
      'client/features/battle/battle_view.gd:14 | frame code: `queue_free()` in `_helper` called from `_process`',
      'client/features/battle/battle_view.gd:15 | frame code: `await` in `_helper` called from `_process`',
      'client/features/battle/battle_view.gd:5 | frame code: `get_node()` in `_process`',
      'client/features/battle/battle_view.gd:6 | frame code: `$` node path in `_process`',
    ]));
  });

  it('follows same-class calls transitively, each function once', async () => {
    const sc = memContext({
      'client/features/battle/battle_chain.gd': gd(`
class_name BattleChain
extends Node
func _process(delta: float) -> void:
	_a()
func _a() -> void:
	_b()
func _b() -> void:
	var label := $Label
	_a()
	_b()
`),
    });
    expect(lines(await frameCode.run(sc))).toEqual(['client/features/battle/battle_chain.gd:8 | frame code: `$` node path in `_b` called from `_process`']);
  });

  it('checks every frame function', async () => {
    const names = ['_process', '_physics_process', '_input', '_unhandled_input', '_unhandled_key_input', '_shortcut_input', '_gui_input'];
    const body = names.map((name) => `func ${name}(x: float) -> void:\n\tvar n := get_node("A")\n`).join('');
    const sc = memContext({ 'client/features/battle/battle_frames.gd': `class_name BattleFrames\nextends Node\n${body}func _ready() -> void:\n\tvar n := get_node("A")\n` });
    expect(lines(await frameCode.run(sc))).toEqual(sorted(names.map((name, i) => `client/features/battle/battle_frames.gd:${String(4 + i * 2)} | frame code: \`get_node()\` in \`${name}\``)));
  });
});

describe('literal timing', () => {
  it('finds number literals for animation speed, blend, timers', async () => {
    const sc = memContext({
      'client/features/fx/fx_view.gd': gd(`
class_name FxView
extends Node
@onready var anim: AnimationPlayer = $Anim
@onready var timer: Timer = $Timer
@onready var sprite: AnimatedSprite2D = $Sprite
func f() -> void:
	anim.speed_scale = 2.0
	anim.play("hit", -1, 1.5)
	anim.play("hit")
	get_tree().create_timer(0.5)
	timer.wait_time = 3
	timer.start(1.0)
	timer.set_wait_time(2)
	sprite.play("run", 2.0)
	sprite.speed_scale = 2.0
	unknown.speed_scale = 1.0
	anim.speed_scale = Data.speed()
	var speed_scale := 3
	speed_scale = 4
	var t2 := Timer.new()
	t2.start(1.5)
`),
    });
    expect(lines(await literalTiming.run(sc))).toEqual(sorted([
      'client/features/fx/fx_view.gd:21 | literal timing: number literal passed to `Timer.wait_time`',
      'client/features/fx/fx_view.gd:10 | literal timing: number literal passed to `SceneTree.create_timer()`',
      'client/features/fx/fx_view.gd:11 | literal timing: number literal assigned to `Timer.wait_time`',
      'client/features/fx/fx_view.gd:12 | literal timing: number literal passed to `Timer.wait_time`',
      'client/features/fx/fx_view.gd:13 | literal timing: number literal passed to `Timer.wait_time`',
      'client/features/fx/fx_view.gd:16 | literal timing: number literal assigned to `AnimationPlayer.speed_scale`',
      'client/features/fx/fx_view.gd:7 | literal timing: number literal assigned to `AnimationPlayer.speed_scale`',
      'client/features/fx/fx_view.gd:8 | literal timing: number literal passed to `AnimationPlayer.play()`',
    ]));
  });
});

describe('literal timing: assignment operators and literal-only values', () => {
  it('finds compound assignments, ternaries, arithmetic and casts of number literals', async () => {
    const sc = memContext({
      'client/features/fx/fx_more.gd': gd(`
class_name FxMore
extends Node
@onready var anim: AnimationPlayer = $Anim
@onready var timer: Timer = $Timer
var fast: bool
var base: float
func f() -> void:
	anim.speed_scale *= 2.0
	anim.speed_scale = 1.5 if fast else 1.0
	get_tree().create_timer(0.25 * 2)
	timer.wait_time += 1 as float
	anim.speed_scale = base if fast else 1.0
	anim.speed_scale *= base
	get_tree().create_timer(base * 2)
`),
    });
    expect(lines(await literalTiming.run(sc))).toEqual(sorted([
      'client/features/fx/fx_more.gd:8 | literal timing: number literal assigned to `AnimationPlayer.speed_scale`',
      'client/features/fx/fx_more.gd:9 | literal timing: number literal assigned to `AnimationPlayer.speed_scale`',
      'client/features/fx/fx_more.gd:10 | literal timing: number literal passed to `SceneTree.create_timer()`',
      'client/features/fx/fx_more.gd:11 | literal timing: number literal assigned to `Timer.wait_time`',
    ]));
  });
});

describe('test input and frame polling', () => {
  it('finds direct input calls in client tests only', async () => {
    const body = gd(`
extends UnitTestCase
func test_a() -> void:
	panel._input(event)
	panel._gui_input(event)
	button._pressed()
	button.pressed.emit()
	button.toggled.emit(true)
	button.emit_signal("pressed")
	InputCore.inject_device_input(event)
	panel._unhandled_input(event)
	panel._unhandled_key_input(event)
	panel._shortcut_input(event)
	button._toggled(true)
	button.button_down.emit()
	button.button_up.emit()
	panel.gui_input.emit(event)
	var s: Signal = button.pressed
	s.emit()
	var other: Signal = button.visibility_changed
	other.emit()
	Signal(button, "toggled").emit(true)
`);
    const sc = memContext({ 'client/tests/shop/test_a.gd': body, 'client/features/shop/shop_x.gd': body });
    expect(lines(await testInput.run(sc))).toEqual(sorted([
      'client/tests/shop/test_a.gd:10 | test input: direct call of `_unhandled_input()`',
      'client/tests/shop/test_a.gd:11 | test input: direct call of `_unhandled_key_input()`',
      'client/tests/shop/test_a.gd:12 | test input: direct call of `_shortcut_input()`',
      'client/tests/shop/test_a.gd:13 | test input: direct call of `_toggled()`',
      'client/tests/shop/test_a.gd:14 | test input: direct emit of engine input signal `button_down`',
      'client/tests/shop/test_a.gd:15 | test input: direct emit of engine input signal `button_up`',
      'client/tests/shop/test_a.gd:16 | test input: direct emit of engine input signal `gui_input`',
      'client/tests/shop/test_a.gd:18 | test input: direct emit of engine input signal `pressed`',
      'client/tests/shop/test_a.gd:21 | test input: direct emit of engine input signal `toggled`',
      'client/tests/shop/test_a.gd:3 | test input: direct call of `_input()`',
      'client/tests/shop/test_a.gd:4 | test input: direct call of `_gui_input()`',
      'client/tests/shop/test_a.gd:5 | test input: direct call of `_pressed()`',
      'client/tests/shop/test_a.gd:6 | test input: direct emit of engine input signal `pressed`',
      'client/tests/shop/test_a.gd:7 | test input: direct emit of engine input signal `toggled`',
      'client/tests/shop/test_a.gd:8 | test input: direct emit of engine input signal `pressed`',
    ]));
  });

  it('follows an input signal put in a class variable inside a function', async () => {
    const sc = memContext({
      'client/tests/shop/test_c.gd': gd(`
extends UnitTestCase
var _sig: Signal
var _other: Signal
func before_each() -> void:
	_sig = button.pressed
	var _other: Signal = button.toggled
func test_a() -> void:
	_sig.emit()
	_other.emit(true)
func test_b(_sig: Signal) -> void:
	_sig = button.button_down
func test_c() -> void:
	_sig.emit()
`),
    });
    expect(lines(await testInput.run(sc))).toEqual(sorted([
      'client/tests/shop/test_c.gd:8 | test input: direct emit of engine input signal `pressed`',
      'client/tests/shop/test_c.gd:13 | test input: direct emit of engine input signal `pressed`',
    ]));
  });

  it('finds loops that wait for frames', async () => {
    const sc = memContext({
      'client/tests/shop/test_b.gd': gd(`
extends UnitTestCase
func test_a() -> void:
	for i in range(10):
		await UnitTestCore.wait_frames(1)
		if done:
			break
	while not done:
		if x:
			await get_tree().process_frame
	while not done:
		await latch.wait()
	await UnitTestCore.wait_frames(2)
	for j in range(3):
		var f := func() -> void:
			await get_tree().physics_frame
`),
    });
    expect(lines(await framePolling.run(sc))).toEqual(sorted([
      'client/tests/shop/test_b.gd:3 | frame polling: `for` loop waits for frames',
      'client/tests/shop/test_b.gd:7 | frame polling: `while` loop waits for frames',
    ]));
  });
});

describe('block token', () => {
  it('accepts a token kept in a local and released before any wait', async () => {
    const sc = memContext({
      'client/features/shop/shop_buy.gd': gd(`
class_name ShopBuy
func ok() -> void:
	var token := InputBlockCore.block("ui")
	if InputBlockCore.is_active(token):
		_do()
	InputBlockCore.unblock(token)
	await later()
`),
    });
    expect(await blockToken.run(sc)).toEqual([]);
  });

  it('follows each path: a release before an await on one path, and lambdas that are not waits', async () => {
    const sc = memContext({
      'client/features/shop/shop_buy.gd': gd(`
class_name ShopBuy
func early(ok: bool) -> void:
	var t := InputBlockCore.block("ui")
	if not ok:
		InputBlockCore.unblock(t)
		await MessageCore.show_popup(1)
		return
	InputBlockCore.unblock(t)
func sorts(items: Array[int]) -> void:
	var t := InputBlockCore.block("ui")
	items.sort_custom(func(a: int, b: int) -> bool: return a < b)
	InputBlockCore.unblock(t)
func leaks(ok: bool) -> void:
	var t := InputBlockCore.block("ui")
	if ok:
		return
	InputBlockCore.unblock(t)
func loops(items: Array[int]) -> void:
	var t := InputBlockCore.block("ui")
	for i in items:
		if i > 0:
			break
		await later()
	InputBlockCore.unblock(t)
func deferred() -> void:
	var t := InputBlockCore.block("ui")
	(func() -> void: pass).call_deferred()
	InputBlockCore.unblock(t)
`),
    });
    expect(lines(await blockToken.run(sc))).toEqual(sorted([
      'client/features/shop/shop_buy.gd:14 | block token: block token `t` is not released with `InputBlockCore.unblock` in the same function',
      'client/features/shop/shop_buy.gd:23 | block token: block token `t` is held across `await`',
      'client/features/shop/shop_buy.gd:27 | block token: block token `t` is held across a lambda',
    ]));
  });

  it('finds tokens outside locals, passed on, held across waits or never released', async () => {
    const sc = memContext({
      'client/features/shop/shop_buy.gd': gd(`
class_name ShopBuy
var _token: int = InputBlockCore.block("ui")
func field() -> void:
	_token = InputBlockCore.block("ui")
func passed() -> void:
	var t := InputBlockCore.block("ui")
	keep(t)
	InputBlockCore.unblock(t)
func waits() -> void:
	var t := InputBlockCore.block("ui")
	await something()
	InputBlockCore.unblock(t)
func never() -> void:
	var t := InputBlockCore.block("ui")
func lambda() -> void:
	var t := InputBlockCore.block("ui")
	button.pressed.connect(func() -> void: InputBlockCore.unblock(t))
func returned() -> int:
	return InputBlockCore.block("ui")
`),
    });
    expect(lines(await blockToken.run(sc))).toEqual(sorted([
      'client/features/shop/shop_buy.gd:11 | block token: block token `t` is held across `await`',
      'client/features/shop/shop_buy.gd:14 | block token: block token `t` is not released with `InputBlockCore.unblock` in the same function',
      'client/features/shop/shop_buy.gd:16 | block token: block token `t` is not released with `InputBlockCore.unblock` in the same function',
      'client/features/shop/shop_buy.gd:17 | block token: block token `t` is held across a lambda',
      'client/features/shop/shop_buy.gd:17 | block token: block token `t` is used outside `unblock` and `is_active`',
      'client/features/shop/shop_buy.gd:19 | block token: block token is not kept in a local variable',
      'client/features/shop/shop_buy.gd:2 | block token: block token is not kept in a local variable',
      'client/features/shop/shop_buy.gd:4 | block token: block token is not kept in a local variable',
      'client/features/shop/shop_buy.gd:7 | block token: block token `t` is used outside `unblock` and `is_active`',
    ]));
  });
});

describe('data mutation', () => {
  it('finds changes to rows, row lists and container lists', async () => {
    const sc = memContext({
      ...CORE_STUBS,
      'client/features/shop/shop_logic.gd': gd(`
class_name ShopLogic
func f(id: int, param_row: GameData.ItemRow) -> void:
	var row := GameData.ItemTable.get_row(id)
	row.price = 3
	row.tags.append(1)
	row.cost[0].amount = 5
	var rows := GameData.ItemTable.all_rows()
	rows.sort_custom(func(a: GameData.ItemRow, b: GameData.ItemRow) -> bool: return a.price < b.price)
	rows[0] = row
	GameData.ItemTable.all_rows().clear()
	for r in GameData.ItemTable.all_rows():
		r.price += 1
	param_row.price = 1
	var group := DataCore.get_rows(g, key)
	group.append(row)
	var picked: Array[GameData.ItemRow] = []
	picked.append(row)
	var copy := rows.duplicate()
	copy.clear()
	var price := row.price
	price = 4
	(DataCore.get_row(index, key) as GameData.ItemRow).price = 2
`),
    });
    expect(lines(await dataMutation.run(sc))).toEqual(sorted([
      'client/features/shop/shop_logic.gd:10 | data mutation: `clear()` on game data',
      'client/features/shop/shop_logic.gd:12 | data mutation: assignment to `.price` of game data',
      'client/features/shop/shop_logic.gd:13 | data mutation: assignment to `.price` of game data',
      'client/features/shop/shop_logic.gd:15 | data mutation: `append()` on game data',
      'client/features/shop/shop_logic.gd:22 | data mutation: assignment to `.price` of game data',
      'client/features/shop/shop_logic.gd:4 | data mutation: assignment to `.price` of game data',
      'client/features/shop/shop_logic.gd:5 | data mutation: `append()` on game data',
      'client/features/shop/shop_logic.gd:6 | data mutation: assignment to `.amount` of game data',
      'client/features/shop/shop_logic.gd:8 | data mutation: `sort_custom()` on game data',
      'client/features/shop/shop_logic.gd:9 | data mutation: assignment to an element of game data',
    ]));
  });

  it('knows class variables, nested list fields, container replacement and reassigned variables', async () => {
    const sc = memContext({
      ...CORE_STUBS,
      'client/features/shop/shop_grid.gd': gd(`
class_name ShopGrid
var _rows := GameData.ItemTable.all_rows()
func f(id: int) -> void:
	_rows.clear()
	var row := GameData.ItemTable.get_row(id)
	row.cells[0].append(true)
	row.cells[0][1] = true
	GameData.clear()
	GameData.load_tables(tables)
	var rows := GameData.ItemTable.all_rows()
	rows.sort()
	rows = rows.duplicate()
	rows.sort()
	for c in row.cells:
		c.append(true)
		c[0] = true
	for t in row.tags:
		t = 1
`),
    });
    expect(lines(await dataMutation.run(sc))).toEqual(sorted([
      'client/features/shop/shop_grid.gd:4 | data mutation: `clear()` on game data',
      'client/features/shop/shop_grid.gd:6 | data mutation: `append()` on game data',
      'client/features/shop/shop_grid.gd:7 | data mutation: assignment to an element of game data',
      'client/features/shop/shop_grid.gd:8 | data mutation: `GameData.clear()` replaces the data container',
      'client/features/shop/shop_grid.gd:9 | data mutation: `GameData.load_tables()` replaces the data container',
      'client/features/shop/shop_grid.gd:11 | data mutation: `sort()` on game data',
      'client/features/shop/shop_grid.gd:15 | data mutation: `append()` on game data',
      'client/features/shop/shop_grid.gd:16 | data mutation: assignment to an element of game data',
    ]));
  });

  it('gives a class variable at a method entry the kinds of its assignments in every method and lambda', async () => {
    const sc = memContext({
      ...CORE_STUBS,
      'client/features/shop/shop_cache.gd': gd(`
class_name ShopCache
var _rows: Array[GameData.ItemRow] = []
var _first: Array = []
var _second: Array = []
var _plain: Array = []
func _ready() -> void:
	_rows = GameData.ItemTable.all_rows()
	_plain = []
	var later := func() -> void: self._second = GameData.ItemTable.all_rows()
func sort_it() -> void:
	_rows.sort()
	_rows[0] = null
	_first.reverse()
	_second.clear()
	_plain.sort()
func copy_first() -> void:
	_first = _second
func shadow(_plain: Array) -> void:
	_plain = GameData.ItemTable.all_rows()
func local_shadow() -> void:
	var _plain := GameData.ItemTable.all_rows()
	_plain = GameData.ItemTable.all_rows()
	var cb := func() -> void: _plain.sort()
func reset() -> void:
	_rows = []
	_rows.sort()
`),
    });
    expect(lines(await dataMutation.run(sc))).toEqual(sorted([
      'client/features/shop/shop_cache.gd:11 | data mutation: `sort()` on game data',
      'client/features/shop/shop_cache.gd:12 | data mutation: assignment to an element of game data',
      'client/features/shop/shop_cache.gd:13 | data mutation: `reverse()` on game data',
      'client/features/shop/shop_cache.gd:14 | data mutation: `clear()` on game data',
      'client/features/shop/shop_cache.gd:23 | data mutation: `sort()` on game data',
    ]));
  });

  it('keeps every kind a variable may have on the paths that reach a use', async () => {
    const sc = memContext({
      ...CORE_STUBS,
      'client/features/shop/shop_paths.gd': gd(`
class_name ShopPaths
func branch(c: bool) -> void:
	var rows := GameData.ItemTable.all_rows()
	if c:
		rows = []
	rows.sort()
func both(c: bool) -> void:
	var rows := GameData.ItemTable.all_rows()
	if c:
		rows = []
	else:
		rows = rows.duplicate()
	rows.sort()
func early(c: bool) -> void:
	var rows := GameData.ItemTable.all_rows()
	if c:
		rows = []
	else:
		return
	rows.sort()
func loop(n: int) -> void:
	var rows := []
	for i in n:
		rows.sort()
		rows = GameData.ItemTable.all_rows()
	rows.reverse()
func matched(m: int) -> void:
	var rows := GameData.ItemTable.all_rows()
	match m:
		1:
			rows = []
	rows.shuffle()
	var rest := GameData.ItemTable.all_rows()
	match m:
		1:
			rest = []
		_:
			rest = rest.duplicate()
	rest.shuffle()
func skipped(n: int) -> void:
	var rows := []
	while n > 0:
		n -= 1
		if n == 3:
			continue
		rows = GameData.ItemTable.all_rows()
	rows.clear()
func captured(c: bool) -> void:
	var rows := GameData.ItemTable.all_rows()
	if c:
		rows = []
	var cb := func() -> void: rows.sort()
	var rows2 := []
	var cb2 := func() -> void: rows2.sort()
func shadowed(_rows: Array) -> void:
	_rows.sort()
var _rows := GameData.ItemTable.all_rows()
func stopped(n: int) -> void:
	var rows := GameData.ItemTable.all_rows()
	while n < 10:
		if n > 0:
			break
		rows = []
		n += 1
	rows.sort()
`),
    });
    expect(lines(await dataMutation.run(sc))).toEqual(sorted([
      'client/features/shop/shop_paths.gd:6 | data mutation: `sort()` on game data',
      'client/features/shop/shop_paths.gd:24 | data mutation: `sort()` on game data',
      'client/features/shop/shop_paths.gd:26 | data mutation: `reverse()` on game data',
      'client/features/shop/shop_paths.gd:32 | data mutation: `shuffle()` on game data',
      'client/features/shop/shop_paths.gd:47 | data mutation: `clear()` on game data',
      'client/features/shop/shop_paths.gd:52 | data mutation: `sort()` on game data',
      'client/features/shop/shop_paths.gd:65 | data mutation: `sort()` on game data',
    ]));
  });
});

describe('determinism', () => {
  it('finds non-RefCounted classes, reals, division and calls outside the allowed list', async () => {
    const sc = memContext({
      ...CORE_STUBS,
      'client/features/match/sim/match_sim.gd': gd(`
class_name MatchSim
extends Node
var speed: float = 1.5
var board: MatchBoard
var rng: RefCounted
func tick(input: int, items: Array[int], text: String) -> int:
	var a := input / 2
	var b := input % 3
	a /= 2
	var c := UtilCore.floor_div(input, 2) + absi(input) + len(items) + items.size()
	var d := UtilCore.next_float(rng)
	var e := text.to_float()
	var f := text.length()
	var row := GameData.ItemTable.get_row(input)
	board.step(input)
	MatchBoard.make()
	CommonGrid.new()
	OtherSim.run()
	Time.get_ticks_msec()
	print(input)
	_local()
	something.call()
	return DataCore.get_row(i, k).id
func _local() -> void:
	pass
`),
      'client/features/match/sim/match_board.gd': 'class_name MatchBoard\nextends RefCounted\nfunc step(i: int) -> void:\n\tpass\nstatic func make() -> MatchBoard:\n\treturn MatchBoard.new()\n',
      'client/common/sim/common_grid.gd': 'class_name CommonGrid\nextends RefCounted\nclass Cell:\n\tvar v: int\nclass Inner extends Node:\n\tvar w: int\nclass Ok extends RefCounted:\n\tvar u: int\n',
      'client/features/other/sim/other_sim.gd': 'class_name OtherSim\nextends RefCounted\nstatic func run() -> void:\n\tpass\n',
    });
    expect(lines(await determinism.run(sc))).toEqual(sorted([
      'client/common/sim/common_grid.gd:5 | determinism: class `Inner` does not `extends RefCounted`',
      'client/features/match/sim/match_sim.gd:11 | determinism: call of `UtilCore.next_float()`',
      'client/features/match/sim/match_sim.gd:12 | determinism: call of `text.to_float()`',
      'client/features/match/sim/match_sim.gd:18 | determinism: call of `OtherSim.run()`',
      'client/features/match/sim/match_sim.gd:19 | determinism: call of `Time.get_ticks_msec()`',
      'client/features/match/sim/match_sim.gd:20 | determinism: call of `print()`',
      'client/features/match/sim/match_sim.gd:22 | determinism: call of `something.call()` whose receiver type is not known; declare the receiver type',
      'client/features/match/sim/match_sim.gd:2 | determinism: class does not `extends RefCounted`',
      'client/features/match/sim/match_sim.gd:3 | determinism: real literal `1.5`',
      'client/features/match/sim/match_sim.gd:3 | determinism: real type `float`',
      'client/features/match/sim/match_sim.gd:7 | determinism: operator `/`; use `UtilCore.floor_div` or `UtilCore.floor_mod`',
      'client/features/match/sim/match_sim.gd:8 | determinism: operator `%`; use `UtilCore.floor_div` or `UtilCore.floor_mod`',
      'client/features/match/sim/match_sim.gd:9 | determinism: operator `/=`; use `UtilCore.floor_div` or `UtilCore.floor_mod`',
    ]));
  });

  it('judges self.<method>() and super.<method>() calls like bare calls', async () => {
    const sc = memContext({
      ...CORE_STUBS,
      'client/features/m/sim/m_base.gd': 'class_name MBase\nextends RefCounted\nfunc step() -> int:\n\treturn 1\n',
      'client/features/m/sim/m_sim.gd': gd(`
class_name MSim
extends MBase
func f() -> int:
	var id: int = self.get_instance_id()
	var h: int = get_instance_id()
	var s: int = self.step() + super.step() + self.g()
	return super.get_instance_id()
func g() -> int:
	return 1
`),
    });
    expect(lines(await determinism.run(sc))).toEqual(sorted([
      'client/features/m/sim/m_sim.gd:2 | determinism: class does not `extends RefCounted`',
      'client/features/m/sim/m_sim.gd:4 | determinism: call of `self.get_instance_id()`',
      'client/features/m/sim/m_sim.gd:5 | determinism: call of `get_instance_id()`',
      'client/features/m/sim/m_sim.gd:7 | determinism: call of `super.get_instance_id()`',
    ]));
  });
});

describe('debug text', () => {
  it('finds string literals put in UI text by code and scenes', async () => {
    const sc = memContext({
      'client/features/shop/shop_view.gd': gd(`
class_name ShopView
extends Label
@onready var label: Label = $L
func f(count: int) -> void:
	label.text = "Score: " + str(count)
	label.text = LocalizationCore.get_text(key)
	label.text = ""
	text = "Hi"
	label.set_text("x" if count > 0 else "y")
	label.text = "%d" % count
	label.text = tr_key(count, "not shown")
func g(text: String) -> void:
	text = "local"
	set_text("DEBUG")
	label.text = "Score: {0}".format([count])
	label.text = LocalizationCore.get_text(key).format(["not shown"])
`),
      'client/dev/features/shop/shop_dev.gd': 'func f() -> void:\n\tlabel.text = "debug"\n',
      'client/tests/shop/test_shop.gd': 'extends UnitTestCase\nfunc test_a() -> void:\n\tlabel.text = "Hello"\n',
      'resource/scene/shop/main.tscn': '[gd_scene format=3]\n\n[node name="Root" type="Control"]\n\n[node name="Title" type="Label" parent="."]\ntext = "Shop"\n\n[node name="Empty" type="Label" parent="."]\ntext = ""\n',
    });
    expect(lines(await debugText.run(sc))).toEqual(sorted([
      'client/features/shop/shop_view.gd:10 | debug text: string literal in UI text',
      'client/features/shop/shop_view.gd:14 | debug text: string literal in UI text',
      'client/features/shop/shop_view.gd:15 | debug text: string literal in UI text',
      'client/features/shop/shop_view.gd:5 | debug text: string literal in UI text',
      'client/features/shop/shop_view.gd:8 | debug text: string literal in UI text',
      'client/features/shop/shop_view.gd:9 | debug text: string literal in UI text',
      'client/features/shop/shop_view.gd:9 | debug text: string literal in UI text',
      'resource/scene/shop/main.tscn:6 | debug text: string literal in UI text of node `Title`',
    ]));
  });

  it('finds += assignments, add_text(), append_text() and values cast with as', async () => {
    const sc = memContext({
      'client/features/shop/shop_log.gd': gd(`
class_name ShopLog
extends Node
@onready var label: Label = $L
@onready var rich: RichTextLabel = $R
func f(count: int) -> void:
	label.text += "!"
	rich.add_text("added")
	rich.append_text("[b]appended[/b]")
	label.text = "cast" as String
	label.text += LocalizationCore.get_text(key)
	rich.add_text(LocalizationCore.get_text(key))
`),
    });
    expect(lines(await debugText.run(sc))).toEqual(sorted([
      'client/features/shop/shop_log.gd:6 | debug text: string literal in UI text',
      'client/features/shop/shop_log.gd:7 | debug text: string literal in UI text',
      'client/features/shop/shop_log.gd:8 | debug text: string literal in UI text',
      'client/features/shop/shop_log.gd:9 | debug text: string literal in UI text',
    ]));
  });
});
