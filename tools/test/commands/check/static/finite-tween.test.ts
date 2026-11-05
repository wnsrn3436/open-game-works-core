import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as finiteTween from '../../../../src/commands/check/static/finite-tween.ts';
import { lines, memContext, type Files } from './helpers.ts';

const state = vi.hoisted((): { core: Record<string, unknown> } => ({ core: {} }));

vi.mock('../../../../src/commands/generate/api.ts', async (original) => ({
  ...(await original<typeof import('../../../../src/commands/generate/api.ts')>()),
  mergedCoreSettings: () => Promise.resolve(state.core),
}));

const UI: Files = {
  'client/core/ui_core/ui_panel.gd': 'class_name UIPanel\nextends Control\n\n@export var open_tween: String = ""\n@export var close_tween: String = ""\n',
  'client/core/ui_core/ui_popup.gd': 'class_name UIPopup\nextends Control\n\n@export var open_tween: String = ""\n@export var close_tween: String = ""\n',
  'client/features/shop/shop_panel.gd': 'class_name ShopPanel\nextends UIPanel\n',
  'client/features/shop/reward_popup.gd': 'class_name RewardPopup\nextends UIPopup\n',
  'client/features/shop/banner.gd': 'class_name Banner\nextends Control\n\nvar open_tween: String = ""\n',
};

/** A tween preset whose `[resource]` has `repeat_count` when it is not null. */
const preset = (repeat: number | null): string =>
  ['[gd_resource type="Resource" format=3]', '', '[resource]', ...(repeat === null ? [] : [`repeat_count = ${String(repeat)}`]), 'steps = []', ''].join('\n');

/** A prefab whose root has `script` (or instances `instance`) and the given property lines. */
const prefab = (root: { script?: string; instance?: string }, props: string[]): string =>
  [
    '[gd_scene format=3]',
    ...(root.script ? [`[ext_resource type="Script" path="res://features/shop/${root.script}.gd" id="s"]`] : []),
    ...(root.instance ? [`[ext_resource type="PackedScene" path="res://resource/prefab/${root.instance}.tscn" id="i"]`] : []),
    '',
    root.instance ? '[node name="Root" instance=ExtResource("i")]' : '[node name="Root" type="Control"]',
    ...(root.script ? ['script = ExtResource("s")'] : []),
    ...props,
    '',
  ].join('\n');

const PRESETS: Files = {
  'resource/tween/loop.tres': preset(0),
  'resource/tween/once.tres': preset(1),
  'resource/tween/plain.tres': preset(null),
};

describe('finite tween', () => {
  beforeEach(() => {
    state.core = {};
  });

  it('finds open and close tweens of UIPanel and UIPopup prefabs that name a preset repeating forever, also through an instanced base', async () => {
    const sc = memContext({
      ...UI,
      ...PRESETS,
      'resource/prefab/shop/shop_panel.tscn': prefab({ script: 'shop_panel' }, ['open_tween = "tween/loop"', 'close_tween = "tween/once"']),
      'resource/prefab/shop/reward_popup.tscn': prefab({ script: 'reward_popup' }, ['open_tween = "tween/plain"', 'close_tween = "tween/loop"']),
      'resource/prefab/shop/reward_popup_big.tscn': prefab({ instance: 'shop/reward_popup' }, ['open_tween = "tween/loop"']),
      'resource/prefab/shop/banner.tscn': prefab({ script: 'banner' }, ['open_tween = "tween/loop"']),
      'resource/prefab/shop/missing.tscn': prefab({ script: 'shop_panel' }, ['open_tween = "tween/none"', 'close_tween = ""']),
    });
    expect(lines(await finiteTween.run(sc))).toEqual([
      'resource/prefab/shop/reward_popup_big.tscn:5 | finite tween: `open_tween` names `tween/loop`, whose preset resource/tween/loop.tres repeats forever (repeat count 0)',
      'resource/prefab/shop/reward_popup.tscn:7 | finite tween: `close_tween` names `tween/loop`, whose preset resource/tween/loop.tres repeats forever (repeat count 0)',
      'resource/prefab/shop/shop_panel.tscn:6 | finite tween: `open_tween` names `tween/loop`, whose preset resource/tween/loop.tres repeats forever (repeat count 0)',
    ]);
  });

  it('finds the MessageCore tween settings that name a preset repeating forever', async () => {
    state.core = {
      'MessageCore.toastEnterTween': 'tween/loop',
      'MessageCore.toastExitTween': 'tween/once',
      'MessageCore.blackBoxEnterTween': '',
      'MessageCore.blackBoxExitTween': 'tween/loop',
    };
    const sc = memContext({ ...UI, ...PRESETS });
    expect(lines(await finiteTween.run(sc))).toEqual([
      'resource/tween/loop.tres:4 | finite tween: `MessageCore.blackBoxExitTween` names `tween/loop`, and this preset repeats forever (repeat count 0)',
      'resource/tween/loop.tres:4 | finite tween: `MessageCore.toastEnterTween` names `tween/loop`, and this preset repeats forever (repeat count 0)',
    ]);
  });

  it('finds content code that sets open_tween or close_tween of a UIPanel or UIPopup, and not other properties of that name', async () => {
    const sc = memContext({
      ...UI,
      'client/features/shop/shop_panel.gd': [
        'class_name ShopPanel',
        'extends UIPanel',
        '',
        'func _init() -> void:',
        '\topen_tween = "tween/once"',
        '',
        'func pick(popup: RewardPopup, banner: Banner, other) -> void:',
        '\tpopup.close_tween = "tween/once"',
        '\tbanner.open_tween = "tween/once"',
        '\tother.open_tween += "x"',
        '\tset("close_tween", "tween/once")',
        '\tpopup.set_deferred("open_tween", "tween/once")',
        '\tbanner.set("open_tween", "tween/once")',
        '',
        'func local() -> void:',
        '\tvar close_tween := ""',
        '\tclose_tween = "x"',
        '',
      ].join('\n'),
    });
    expect(lines(await finiteTween.run(sc))).toEqual([
      'client/features/shop/shop_panel.gd:5 | finite tween: code sets `open_tween` of a UIPanel or UIPopup; it is set in the .tscn',
      'client/features/shop/shop_panel.gd:8 | finite tween: code sets `close_tween` of a UIPanel or UIPopup; it is set in the .tscn',
      'client/features/shop/shop_panel.gd:10 | finite tween: code sets `open_tween` of a UIPanel or UIPopup; it is set in the .tscn',
      'client/features/shop/shop_panel.gd:11 | finite tween: code sets `close_tween` of a UIPanel or UIPopup; it is set in the .tscn',
      'client/features/shop/shop_panel.gd:12 | finite tween: code sets `open_tween` of a UIPanel or UIPopup; it is set in the .tscn',
    ]);
  });
});
