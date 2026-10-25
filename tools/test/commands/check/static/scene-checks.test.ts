import { describe, expect, it, vi } from 'vitest';
import * as actionReference from '../../../../src/commands/check/static/action-reference.ts';
import * as anchorReference from '../../../../src/commands/check/static/anchor-reference.ts';
import * as sceneLinks from '../../../../src/commands/check/static/scene-links.ts';
import * as themeOnly from '../../../../src/commands/check/static/theme-only.ts';
import * as virtualPadLayout from '../../../../src/commands/check/static/virtual-pad-layout.ts';
import { instanceChain } from '../../../../src/commands/check/static/lib/scene-classes.ts';
import type { SceneNode, TextScene } from '../../../../src/commands/check/static/lib/tscn.ts';
import { CORE_STUBS, lines, memContext, sorted } from './helpers.ts';

const keys = vi.hoisted(() => ({ asked: [] as string[][] }));

vi.mock('../../../../src/commands/check/static/lib/engine.ts', () => ({
  godotKeyNames: (_sc: unknown, names: string[]) => {
    keys.asked.push(names);
    return Promise.resolve(new Map(names.map((n) => [n, ['Space', 'A', 'Escape'].includes(n)])));
  },
  gameEngine: () => Promise.resolve('godot'),
}));

const EXT = {
  button: '[ext_resource type="Script" path="res://core/ui_core/ui_button.gd" id="b"]',
  anchor: '[ext_resource type="Script" path="res://core/ui_core/ui_anchor.gd" id="a"]',
  vbutton: '[ext_resource type="Script" path="res://core/virtual_pad_core/virtual_button.gd" id="vb"]',
  stick: '[ext_resource type="Script" path="res://core/virtual_pad_core/virtual_joystick.gd" id="vj"]',
  layout: '[ext_resource type="Script" path="res://core/virtual_pad_core/virtual_pad_layout.gd" id="vl"]',
};

const PROJECT = '[application]\nconfig/name="g"\n\n[input]\n\njump={\n"deadzone": 0.5,\n"events": []\n}\nui_accept={\n"events": []\n}\n';

describe('action reference', () => {
  it('finds unknown actions in scenes, prompt tokens and input prompts', async () => {
    keys.asked = [];
    const sc = memContext({
      ...CORE_STUBS,
      'client/project.godot': PROJECT,
      'client/features/hud/hud_jump_button.gd': 'class_name HudJumpButton\nextends UIButton\n',
      'resource/scene/hud/main.tscn': [
        '[gd_scene format=3]',
        EXT.button,
        EXT.stick,
        '[ext_resource type="Script" path="res://features/hud/hud_jump_button.gd" id="hb"]',
        '',
        '[node name="Root" type="Control"]',
        '',
        '[node name="Ok" type="Node" parent="."]',
        'script = ExtResource("b")',
        'action = "jump"',
        '',
        '[node name="Bad" type="Node" parent="."]',
        'script = ExtResource("hb")',
        'action = "fly"',
        '',
        '[node name="Back" type="Node" parent="."]',
        'script = ExtResource("b")',
        'action = "back"',
        '',
        '[node name="Stick" type="Control" parent="."]',
        'script = ExtResource("vj")',
        'action_negative_x = &"left"',
        'action_positive_x = &"cutscene_skip"',
        'action_negative_y = &""',
        '',
        '[node name="Plain" type="Label" parent="."]',
        'action = "nothing"',
        '',
      ].join('\n'),
      'data/tables/shop.csv': ',,\nAll,Client,Server\nid(key),tstring<id>,string\nid,desc,note\n[a],"Press {action:jump} or {action:dash}",{action:zzz}\n',
      'data/translations/ko.csv': 'key,source,source_hash,current_hash,text\nshop.desc.[a],x,1,1,{action:ui_accept} 누름\n',
      'data/tables/input_prompt.csv': ',,,\nAll,Client,Client,Client\nid(key),enum<InputPromptFamily>,string,reskey?\nid,family,input,icon\n[p1],Touch,jump,\n[p2],Touch,swim,\n[p3],KeyboardMouse,Space,\n[p4],KeyboardMouse,mouse_left,\n[p5],KeyboardMouse,Spcae,\n[p6],Xbox,a,\n',
    });
    expect(lines(await actionReference.run(sc))).toEqual(sorted([
      'resource/scene/hud/main.tscn:14 | action reference: `UIButton` node `Bad` action `fly` is not in the input map',
      'resource/scene/hud/main.tscn:18 | action reference: `UIButton` node `Back` uses action `back`',
      'resource/scene/hud/main.tscn:22 | action reference: `VirtualJoystick` node `Stick` action_negative_x `left` is not in the input map',
      'data/tables/shop.csv:5 | action reference: input prompt token `{action:dash}` is not in the input map',
      'data/translations/ko.csv:2 | action reference: input prompt token `{action:ui_accept}` is not in the input map',
      'data/tables/input_prompt.csv:6 | action reference: `Touch` input `swim` is not in the input map',
      'data/tables/input_prompt.csv:9 | action reference: `KeyboardMouse` input `Spcae` is not a key name or a mouse button name',
    ]));
    expect(keys.asked).toEqual([['Space', 'Spcae']]);
  });

  it('uses the core actions without a project file', async () => {
    const sc = memContext({});
    expect([...(await actionReference.actionList(sc))]).toEqual(['back', 'cutscene_advance', 'cutscene_skip']);
  });
});

describe('anchor reference', () => {
  const anchorScene = (name: string, withButton: boolean): string =>
    [
      '[gd_scene format=3]',
      EXT.anchor,
      EXT.button,
      '[ext_resource type="PackedScene" path="res://resource/prefab/shop/slot.tscn" id="slot"]',
      '',
      '[node name="Root" type="Control"]',
      '',
      '[node name="Buy" type="Button" parent="."]',
      '',
      '[node name="Anchor" type="Node" parent="Buy"]',
      'script = ExtResource("a")',
      `anchor_name = "${name}"`,
      '',
      ...(withButton ? ['[node name="Click" type="Node" parent="Buy"]', 'script = ExtResource("b")', ''] : []),
      '[node name="Slot" parent="." instance=ExtResource("slot")]',
      '',
    ].join('\n');
  const slot = ['[gd_scene format=3]', EXT.anchor, '', '[node name="Slot" type="Control"]', '', '[node name="A" type="Node" parent="."]', 'script = ExtResource("a")', 'anchor_name = "slot"', ''].join('\n');
  const steps = ',,,,,\nAll,All,Client,Client,Client,Client\nid,int,string,reskey?,reskey?,enum<TutorialComplete>\nid,step,anchor,panel,popup,complete\n';

  it('finds anchors that no UIAnchor has, panel anchors, step anchors and AnchorTap elements without a button', async () => {
    const sc = memContext({
      ...CORE_STUBS,
      'settings.json': '{"gamepadSupported": true}',
      'resource/prefab/shop/panel.tscn': anchorScene('buy', false),
      'resource/prefab/shop/slot.tscn': slot,
      'resource/prefab/shop/other.tscn': anchorScene('other', true),
      'data/tables/tutorial_step.csv': `${steps}[t],1,buy,prefab/shop/panel,null,AnchorTap\n[t],2,slot.3,prefab/shop/panel,null,Advance\n[t],3,slot,prefab/shop/panel,,Advance\n[t],4,other,prefab/shop/panel,,Advance\n[t],5,ghost,,,Advance\n[t],6,,,,Advance\n[t],7,other,,prefab/shop/other,AnchorTap\n`,
      'client/dev/bot/scenario.json': { steps: [{ kind: 'input', command: 'tap_anchor', args: ['buy.2'], timeoutMs: 1 }, { kind: 'setup', command: 'get_anchor', args: ['nowhere'], timeoutMs: 1 }] },
      'client/dev/bot/fixtures/a.json': { steps: [{ kind: 'setup', command: 'tap_anchor', args: ['lost'], timeoutMs: 1 }] },
    });
    expect(lines(await anchorReference.run(sc))).toEqual(sorted([
      'data/tables/tutorial_step.csv:8 | anchor reference: anchor `other` is not in `prefab/shop/panel`',
      'data/tables/tutorial_step.csv:9 | anchor reference: anchor `ghost` is on no `UIAnchor`',
      'client/dev/bot/scenario.json:11 | anchor reference: step anchor `nowhere` is on no `UIAnchor`',
      'client/dev/bot/fixtures/a.json:3 | anchor reference: step anchor `lost` is on no `UIAnchor`',
      'resource/prefab/shop/panel.tscn:10 | anchor reference: UI element of `AnchorTap` anchor `buy` has no `UIButton` child',
    ]));
  });

  it('finds the UIButton inside the scene the UI element instances', async () => {
    const buttonScene = ['[gd_scene format=3]', EXT.button, '', '[node name="Button" type="Button"]', '', '[node name="Click" type="Node" parent="."]', 'script = ExtResource("b")', ''].join('\n');
    const baseButton = ['[gd_scene format=3]', '[ext_resource type="PackedScene" path="res://resource/prefab/common/button.tscn" id="btn"]', '', '[node name="Base" parent="." instance=ExtResource("btn")]', ''].join('\n');
    const shop = (target: string): string =>
      [
        '[gd_scene format=3]',
        EXT.anchor,
        `[ext_resource type="PackedScene" path="res://resource/prefab/common/${target}.tscn" id="btn"]`,
        '',
        '[node name="Root" type="Control"]',
        '',
        '[node name="Buy" parent="." instance=ExtResource("btn")]',
        '',
        '[node name="Anchor" type="Node" parent="Buy"]',
        'script = ExtResource("a")',
        'anchor_name = "buy"',
        '',
      ].join('\n');
    const sc = memContext({
      ...CORE_STUBS,
      'settings.json': '{"gamepadSupported": true}',
      'resource/prefab/common/button.tscn': buttonScene,
      'resource/prefab/common/base_button.tscn': baseButton.replace('[node name="Base" parent="." instance=ExtResource("btn")]', '[node name="Base" instance=ExtResource("btn")]'),
      'resource/prefab/common/label.tscn': '[gd_scene format=3]\n\n[node name="Label" type="Label"]\n',
      'resource/prefab/shop/a.tscn': shop('button'),
      'resource/prefab/shop/b.tscn': shop('base_button').replace('anchor_name = "buy"', 'anchor_name = "buy2"'),
      'resource/prefab/shop/c.tscn': shop('label').replace('anchor_name = "buy"', 'anchor_name = "buy3"'),
      'data/tables/tutorial_step.csv': `${steps}[t],1,buy,,,AnchorTap\n[t],2,buy2,,,AnchorTap\n[t],3,buy3,,,AnchorTap\n`,
    });
    expect(lines(await anchorReference.run(sc))).toEqual(['resource/prefab/shop/c.tscn:9 | anchor reference: UI element of `AnchorTap` anchor `buy3` has no `UIButton` child']);
  });

  it('skips the gamepad check when gamepad is not supported', async () => {
    const sc = memContext({
      ...CORE_STUBS,
      'settings.json': '{}',
      'resource/prefab/shop/panel.tscn': anchorScene('buy', false),
      'resource/prefab/shop/slot.tscn': slot,
      'data/tables/tutorial_step.csv': `${steps}[t],1,buy,,,AnchorTap\n`,
    });
    expect(await anchorReference.run(sc)).toEqual([]);
    expect(anchorReference.baseName('a.b.12')).toBe('a.b');
    expect(anchorReference.baseName('a.b')).toBe('a.b');
  });
});

describe('virtual pad layout', () => {
  const layout = (mode: string | null, children: string[]): string =>
    [
      '[gd_scene format=3]',
      EXT.layout,
      EXT.vbutton,
      EXT.stick,
      '',
      '[node name="Pad" type="Control"]',
      'script = ExtResource("vl")',
      ...(mode === null ? [] : [`joystick_mode = ${mode}`]),
      '',
      ...children,
    ].join('\n');
  const button = (name: string, action: string, parent = '.'): string => `[node name="${name}" type="Control" parent="${parent}"]\nscript = ExtResource("vb")\naction = &"${action}"\n`;

  it('finds mixed joystick modes and repeated actions', async () => {
    const sc = memContext({
      ...CORE_STUBS,
      'resource/prefab/pad/a.tscn': layout('1', [button('Jump', 'jump'), button('Jump2', 'jump'), button('Deep', 'jump', 'Jump')]),
      'resource/prefab/pad/b.tscn': layout(null, [
        button('Fire', 'fire'),
        '[node name="Stick" type="Control" parent="."]\nscript = ExtResource("vj")\naction_negative_x = &"left"\naction_positive_x = &"fire"\n',
      ]),
      'resource/prefab/pad/c.tscn': layout('0', []),
      'resource/prefab/other.tscn': '[gd_scene format=3]\n\n[node name="X" type="Control"]\njoystick_mode = 2\n',
    });
    expect(lines(await virtualPadLayout.run(sc))).toEqual(sorted([
      'resource/prefab/pad/a.tscn:16 | virtual pad layout: action `jump` of `Jump2` is also used by `Jump`',
      'resource/prefab/pad/b.tscn:16 | virtual pad layout: action `fire` of `Stick` is also used by `Fire`',
      'resource/prefab/pad/a.tscn:6 | virtual pad layout: layout prefabs use more than one `joystick_mode` (1, 0); this one uses 1',
      'resource/prefab/pad/b.tscn:6 | virtual pad layout: layout prefabs use more than one `joystick_mode` (1, 0); this one uses 1',
      'resource/prefab/pad/c.tscn:6 | virtual pad layout: layout prefabs use more than one `joystick_mode` (1, 0); this one uses 0',
    ]));
  });

  it('follows the base scene of a derived layout for joystick_mode and buttons', async () => {
    const derived = (extra: string): string =>
      ['[gd_scene format=3]', EXT.vbutton, '[ext_resource type="PackedScene" path="res://resource/prefab/pad/base.tscn" id="base"]', '', '[node name="Derived" instance=ExtResource("base")]', '', extra].join('\n');
    const sc = memContext({
      ...CORE_STUBS,
      'resource/prefab/pad/base.tscn': layout('2', [button('Jump', 'jump')]),
      'resource/prefab/pad/derived.tscn': derived('[node name="Jump" parent="."]\naction = &"dash"\n'),
      'resource/prefab/pad/twice.tscn': derived(button('Jump2', 'jump')),
    });
    expect(lines(await virtualPadLayout.run(sc))).toEqual(['resource/prefab/pad/twice.tscn:9 | virtual pad layout: action `jump` of `Jump2` is also used by `Jump`']);
  });

  it('accepts one mode across layouts', async () => {
    const sc = memContext({ ...CORE_STUBS, 'resource/prefab/pad/a.tscn': layout('1', [button('A', 'a')]), 'resource/prefab/pad/b.tscn': layout(null, []) });
    expect(await virtualPadLayout.run(sc)).toEqual([]);
  });
});

describe('instance chain', () => {
  const inst = (name: string, target: string | null): string =>
    target === null
      ? `[gd_scene format=3]\n\n[node name="${name}" type="Control"]\n`
      : `[gd_scene format=3]\n[ext_resource type="PackedScene" path="res://resource/prefab/${target}.tscn" id="s"]\n\n[node name="${name}" instance=ExtResource("s")]\n`;
  const rootOf = (scene: TextScene): SceneNode => scene.nodes[0] as SceneNode;

  it('follows the root instances of the scenes a node instances, nearest first', async () => {
    const sc = memContext({
      'resource/prefab/a.tscn': inst('A', 'b'),
      'resource/prefab/b.tscn': inst('B', 'c'),
      'resource/prefab/c.tscn': inst('C', null),
      'resource/prefab/missing.tscn': inst('M', 'nowhere'),
    });
    const a = await sc.scene('resource/prefab/a.tscn');
    expect((await instanceChain(sc, a, rootOf(a))).map((s) => s.path)).toEqual(['resource/prefab/b.tscn', 'resource/prefab/c.tscn']);
    const c = await sc.scene('resource/prefab/c.tscn');
    expect(await instanceChain(sc, c, rootOf(c))).toEqual([]);
    const m = await sc.scene('resource/prefab/missing.tscn');
    expect(await instanceChain(sc, m, rootOf(m))).toEqual([]);
  });

  it('stops a scene that instances itself after 8 scenes', async () => {
    const sc = memContext({ 'resource/prefab/loop.tscn': inst('L', 'loop') });
    const s = await sc.scene('resource/prefab/loop.tscn');
    expect(await instanceChain(sc, s, rootOf(s))).toHaveLength(8);
  });
});

describe('theme only', () => {
  it('finds style overrides, theme properties and StyleBoxFlat in scenes and prefabs only', async () => {
    const scene = [
      '[gd_scene format=3]',
      '[sub_resource type="StyleBoxFlat" id="s"]',
      '[node name="Root" type="Control"]',
      'theme = ExtResource("t")',
      '[node name="Title" type="Label" parent="."]',
      'theme_type_variation = &"TitleLabel"',
      'theme_override_font_sizes/font_size = 40',
      'theme_override_styles/panel = SubResource("s")',
    ].join('\n');
    const sc = memContext({
      'resource/scene/lobby/main.tscn': scene,
      'resource/prefab/common/card.tscn': '[gd_scene format=3]\n[node name="Card" type="PanelContainer"]\ntheme_type_variation = &"Card"\n',
      'client/common/theme.tres': '[gd_resource type="Theme" format=3]\n[sub_resource type="StyleBoxFlat" id="x"]\n',
      'resource/rig_animation_2d/hero.tscn': '[gd_scene format=3]\ntheme_override_constants/x = 1\n',
    });
    expect(lines(await themeOnly.run(sc))).toEqual([
      'resource/scene/lobby/main.tscn:2 | theme only: StyleBoxFlat; panel and button styles are StyleBoxTexture of the theme',
      'resource/scene/lobby/main.tscn:4 | theme only: theme property; the theme of the game applies to every node',
      'resource/scene/lobby/main.tscn:7 | theme only: theme_override_font_sizes/font_size sets a style of its own; give the node a theme_type_variation of the theme',
      'resource/scene/lobby/main.tscn:8 | theme only: theme_override_styles/panel sets a style of its own; give the node a theme_type_variation of the theme',
    ]);
  });
});

describe('scene links', () => {
  it('finds a path of another letter case, missing and twice-declared ids, roots, parents and connections', async () => {
    const scene = [
      '[gd_scene format=3]',
      '[ext_resource type="Texture2D" path="res://resource/icon/Coin.png" id="1"]',
      '[ext_resource type="Texture2D" path="res://resource/icon/gem.png" id="2"]',
      '[ext_resource type="Texture2D" path="res://resource/icon/gem.png" id="2"]',
      '[ext_resource type="PackedScene" path="res://resource/prefab/lobby/card.tscn" id="3"]',
      '[ext_resource type="Script" path="res://core/ui_core/ui_button.gd" id="4"]',
      '[node name="Root" type="Control"]',
      '[node name="Icon" type="TextureRect" parent="."]',
      'texture = ExtResource("1")',
      'material = SubResource("m")',
      '[node name="Card" parent="." instance=ExtResource("3")]',
      '[node name="Inner" type="Label" parent="Card/Body"]',
      '[node name="Lost" type="Label" parent="Gone"]',
      '[node name="Second" type="Control"]',
      '[connection signal="pressed" from="Icon" to="." method="on_press"]',
      '[connection signal="pressed" from="Nope" to="." method="on_press"]',
    ].join('\n');
    const sc = memContext({
      'resource/scene/lobby/main.tscn': scene,
      'resource/icon/coin.png': 'x',
      'resource/prefab/lobby/card.tscn': '[gd_scene format=3]\n[node name="Card" type="Control"]\n',
    });
    expect(lines(await sceneLinks.run(sc))).toEqual([
      'resource/scene/lobby/main.tscn:2 | scene links: ext_resource res://resource/icon/Coin.png: the file is resource/icon/coin.png: the letter case differs',
      'resource/scene/lobby/main.tscn:4 | scene links: ext_resource id "2" is declared twice',
      'resource/scene/lobby/main.tscn:4 | scene links: ext_resource res://resource/icon/gem.png: no such file',
      'resource/scene/lobby/main.tscn:8 | scene links: SubResource("m") is not declared',
      'resource/scene/lobby/main.tscn:13 | scene links: parent "Gone" of node Lost is not a node of the scene',
      'resource/scene/lobby/main.tscn:14 | scene links: the scene has 2 root nodes, not 1',
      'resource/scene/lobby/main.tscn:16 | scene links: connection from "Nope" is not a node of the scene',
    ]);
  });
});
