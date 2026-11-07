import { describe, expect, it } from 'vitest';
import * as themeOnly from '../../../../src/commands/check/static/theme-only.ts';
import { stringColor } from '../../../../src/commands/check/static/lib/tint.ts';
import { lines, memContext } from './helpers.ts';

const EXT = [
  '[ext_resource type="Texture2D" path="res://resource/nine_slice/plate.png" id="n"]',
  '[ext_resource type="Texture2D" path="res://resource/image/band.png" id="i"]',
  '[ext_resource type="Texture2D" path="res://resource/icon/coin.png" id="c"]',
  '[ext_resource type="Script" path="res://features/shop/shop_panel.gd" id="s"]',
];

describe('theme only: tint', () => {
  it('finds a tint of a nine_slice or image in a .tscn and a .tres, and passes alpha only, white and icons', async () => {
    const scene = [
      '[gd_scene format=3]',
      ...EXT.slice(0, 3),
      '[sub_resource type="StyleBoxTexture" id="box"]',
      'texture = ExtResource("n")',
      'modulate_color = Color(0.2, 0.4, 1, 1)',
      '[node name="Root" type="Control"]',
      '[node name="Plate" type="NinePatchRect" parent="."]',
      'texture = ExtResource("n")',
      'self_modulate = Color(1, 0.5, 0.5, 1)',
      '[node name="Band" type="TextureRect" parent="."]',
      'texture = ExtResource("i")',
      'modulate = Color(1, 1, 1, 0.5)',
      '[node name="Tag" type="TextureButton" parent="."]',
      'texture_pressed = ExtResource("i")',
      'modulate = Color(0, 0, 0, 1)',
      '[node name="Coin" type="TextureRect" parent="."]',
      'texture = ExtResource("c")',
      'self_modulate = Color(1, 0, 0, 1)',
      '[node name="Label" type="Label" parent="."]',
      'modulate = Color(1, 0, 0, 1)',
      '[node name="Hero" type="Sprite2D" parent="."]',
      'texture = ExtResource("i")',
      'modulate = Color(1, 0, 0, 1)',
    ].join('\n');
    const theme = [
      '[gd_resource type="Theme" format=3]',
      EXT[0],
      '[sub_resource type="StyleBoxTexture" id="a"]',
      'texture = ExtResource("n")',
      'modulate_color = Color(1, 1, 1, 0.8)',
      '[sub_resource type="StyleBoxTexture" id="b"]',
      'texture = ExtResource("n")',
      'modulate_color = Color(0.9, 1, 1, 1)',
    ].join('\n');
    const box = ['[gd_resource type="StyleBoxTexture" format=3]', EXT[1], '[resource]', 'texture = ExtResource("i")', 'modulate_color = Color(1, 1, 0, 1)'].join('\n');
    const sc = memContext({
      'resource/prefab/shop/panel.tscn': scene,
      'client/common/theme.tres': theme,
      'client/common/band_box.tres': box,
      'client/dev/debug_theme.tres': theme,
    });
    expect(lines(await themeOnly.run(sc))).toEqual([
      'client/common/band_box.tres:5 | theme only: `modulate_color` Color(1, 1, 0, 1) tints StyleBoxTexture of `image/band`; draw the color in its art, or change only alpha',
      'client/common/theme.tres:8 | theme only: `modulate_color` Color(0.9, 1, 1, 1) tints StyleBoxTexture of `nine_slice/plate`; draw the color in its art, or change only alpha',
      'resource/prefab/shop/panel.tscn:7 | theme only: `modulate_color` Color(0.2, 0.4, 1, 1) tints StyleBoxTexture of `nine_slice/plate`; draw the color in its art, or change only alpha',
      'resource/prefab/shop/panel.tscn:11 | theme only: `self_modulate` Color(1, 0.5, 0.5, 1) tints NinePatchRect `Plate` of `nine_slice/plate`; draw the color in its art, or change only alpha',
      'resource/prefab/shop/panel.tscn:17 | theme only: `modulate` Color(0, 0, 0, 1) tints TextureButton `Tag` of `image/band`; draw the color in its art, or change only alpha',
    ]);
  });

  it('finds a tint of an instanced node by the type and texture of the scene it instances', async () => {
    const sc = memContext({
      'resource/prefab/common/plate.tscn': ['[gd_scene format=3]', EXT[0], '[node name="Plate" type="NinePatchRect"]', 'texture = ExtResource("n")'].join('\n'),
      'resource/scene/lobby/lobby.tscn': [
        '[gd_scene format=3]',
        '[ext_resource type="PackedScene" path="res://resource/prefab/common/plate.tscn" id="p"]',
        '[node name="Root" type="Node"]',
        '[node name="Plate" parent="." instance=ExtResource("p")]',
        'self_modulate = Color(0.5, 0.5, 0.5, 1)',
      ].join('\n'),
    });
    expect(lines(await themeOnly.run(sc))).toEqual([
      'resource/scene/lobby/lobby.tscn:5 | theme only: `self_modulate` Color(0.5, 0.5, 0.5, 1) tints NinePatchRect `Plate` of `nine_slice/plate`; draw the color in its art, or change only alpha',
    ]);
  });

  it('finds a tint that the script of a node assigns from a Color value written in code', async () => {
    const script = [
      'class_name ShopPanel',
      'extends NinePatchRect',
      '',
      'const SALE: Color = Color(1, 0.3, 0.3)',
      'const FADE: Color = Color(1, 1, 1, 0.4)',
      '',
      '@onready var _band: TextureRect = $Band',
      '@onready var _tag: TextureButton = %Tag',
      '@onready var _coin: TextureRect = get_node("Coin")',
      '@export var plate_ref: NinePatchRect',
      '',
      'func show_sale(dynamic: Color) -> void:',
      '\tself_modulate = SALE',
      '\t_band.modulate = Color.RED',
      '\t_band.modulate = FADE',
      '\t_band.modulate = Color.WHITE',
      '\t_tag.self_modulate = Color8(255, 0, 0)',
      '\t_coin.modulate = Color.RED',
      '\tplate_ref.self_modulate = Color("#ff8080")',
      '\t_band.modulate = dynamic',
      '\tself.modulate = Color(1, 1, 1, 0.2)',
      '',
      'func local_shadow() -> void:',
      '\tvar modulate_copy: Color = Color.RED',
      '\tvar _band: TextureRect = TextureRect.new()',
      '\t_band.modulate = Color.BLUE',
    ].join('\n');
    const scene = [
      '[gd_scene format=3]',
      ...EXT,
      '[node name="Root" type="NinePatchRect"]',
      'texture = ExtResource("n")',
      'script = ExtResource("s")',
      'plate_ref = NodePath("Inner/Plate")',
      '[node name="Band" type="TextureRect" parent="."]',
      'texture = ExtResource("i")',
      '[node name="Box" type="Control" parent="."]',
      '[node name="Tag" type="TextureButton" parent="Box"]',
      'unique_name_in_owner = true',
      'texture_normal = ExtResource("n")',
      '[node name="Coin" type="TextureRect" parent="."]',
      'texture = ExtResource("c")',
      '[node name="Inner" type="Control" parent="."]',
      '[node name="Plate" type="NinePatchRect" parent="Inner"]',
      'texture = ExtResource("i")',
    ].join('\n');
    const sc = memContext({ 'client/features/shop/shop_panel.gd': script, 'resource/prefab/shop/panel.tscn': scene });
    expect(lines(await themeOnly.run(sc))).toEqual([
      'client/features/shop/shop_panel.gd:13 | theme only: `self_modulate` `SALE` tints NinePatchRect `.` of `nine_slice/plate` in resource/prefab/shop/panel.tscn; draw the color in its art, or change only alpha',
      'client/features/shop/shop_panel.gd:14 | theme only: `modulate` `Color.RED` tints TextureRect `Band` of `image/band` in resource/prefab/shop/panel.tscn; draw the color in its art, or change only alpha',
      'client/features/shop/shop_panel.gd:17 | theme only: `self_modulate` `Color8(255,0,0)` tints TextureButton `Box/Tag` of `nine_slice/plate` in resource/prefab/shop/panel.tscn; draw the color in its art, or change only alpha',
      'client/features/shop/shop_panel.gd:19 | theme only: `self_modulate` `Color("#ff8080")` tints NinePatchRect `Inner/Plate` of `image/band` in resource/prefab/shop/panel.tscn; draw the color in its art, or change only alpha',
    ]);
  });

  it('reads HTML and named color strings', () => {
    expect(stringColor('#fff')).toEqual([1, 1, 1, 1]);
    expect(stringColor('ffffff80')).toEqual([1, 1, 1, 128 / 255]);
    expect(stringColor('#ff000080')).toEqual([1, 0, 0, 128 / 255]);
    expect(stringColor('White')).toEqual([1, 1, 1, 1]);
    expect(stringColor('transparent')).toEqual([1, 1, 1, 0]);
    expect(stringColor('red')).toEqual([0, 0, 0, 1]);
    expect(stringColor('#12345')).toBeNull();
  });
});
