import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as uiPrefab from '../../../../src/commands/check/static/ui-prefab.ts';
import { lines, memContext, type Files } from './helpers.ts';

const state = vi.hoisted((): { core: Record<string, unknown>; asked: string[][] } => ({ core: {}, asked: [] }));

vi.mock('../../../../src/commands/generate/api.ts', async (original) => ({
  ...(await original<typeof import('../../../../src/commands/generate/api.ts')>()),
  mergedCoreSettings: () => Promise.resolve(state.core),
}));

vi.mock('../../../../src/commands/check/static/lib/engine.ts', () => ({
  godotInherits: (_sc: unknown, names: string[], base: string) => {
    state.asked.push([base, ...names]);
    return Promise.resolve(new Map(names.map((n) => [n, ['Control', 'TextureRect', 'CenterContainer'].includes(n)])));
  },
  gameEngine: () => Promise.resolve('godot'),
}));

const LIST = ['key,description,spec,status,method,source,license,attribution,sha256', 'prefab/common/popup,x,,final,,,,,', 'prefab/common/icon,x,,final,,,,,', 'prefab/common/plain,x,,final,,,,,', 'image/icon,x,size=8x8,final,,,,,', ''].join('\n');

const BASE: Files = {
  'client/core/ui_core/ui_popup.gd': 'class_name UIPopup\nextends Control\n',
  'client/core/ui_core/ui_system_popup.gd': 'class_name UISystemPopup\nextends UIPopup\n',
  'client/common/common_popup.gd': 'class_name CommonPopup\nextends UISystemPopup\n',
  'resource/resources.csv': LIST,
  'settings.json': '{\n  "core": {\n    "UICore.systemPopupResource": "prefab/common/popup",\n    "UICore.loadingIconResource": "prefab/common/icon"\n  }\n}\n',
  'resource/prefab/common/popup.tscn': '[gd_scene format=3]\n[ext_resource type="Script" path="res://common/common_popup.gd" id="s"]\n[node name="Popup" type="Control"]\nscript = ExtResource("s")\n',
  'resource/prefab/common/icon.tscn': '[gd_scene format=3]\n[node name="Icon" type="TextureRect"]\n',
  'resource/prefab/common/plain.tscn': '[gd_scene format=3]\n[node name="Plain" type="Node2D"]\n',
};

beforeEach(() => {
  state.core = { 'UICore.systemPopupResource': 'prefab/common/popup', 'UICore.loadingIconResource': 'prefab/common/icon' };
  state.asked = [];
});

describe('UI prefab', () => {
  it('passes a popup root that inherits UIPopup and an icon root that is a Control', async () => {
    expect(await uiPrefab.run(memContext(BASE))).toEqual([]);
    expect(state.asked).toEqual([['Control', 'TextureRect']]);
  });

  it('reads the root class through the scene a root instances', async () => {
    const files: Files = {
      ...BASE,
      'resource/prefab/common/popup.tscn': '[gd_scene format=3]\n[ext_resource type="PackedScene" path="res://resource/prefab/common/base.tscn" id="b"]\n[node name="Popup" instance=ExtResource("b")]\n',
      'resource/prefab/common/base.tscn': '[gd_scene format=3]\n[ext_resource type="Script" path="res://core/ui_core/ui_popup.gd" id="s"]\n[node name="Base" type="CenterContainer"]\nscript = ExtResource("s")\n',
      'resource/prefab/common/icon.tscn': '[gd_scene format=3]\n[ext_resource type="PackedScene" path="res://resource/prefab/common/base.tscn" id="b"]\n[node name="Icon" instance=ExtResource("b")]\n',
    };
    expect(await uiPrefab.run(memContext(files))).toEqual([]);
    expect(state.asked).toEqual([['Control', 'CenterContainer']]);
  });

  it('fails an empty key, a key that is not a prefab row or has no file, and a root of another class', async () => {
    state.core = { 'UICore.systemPopupResource': '', 'UICore.loadingIconResource': 'image/icon' };
    expect(lines(await uiPrefab.run(memContext(BASE)))).toEqual([
      'settings.json:3 | UI prefab: `UICore.systemPopupResource` is empty; set it to the system popup prefab of the game, drawn in its UI style',
      'settings.json:4 | UI prefab: `UICore.loadingIconResource` `image/icon` is not the key of a `prefab` row of resource/resources.csv',
    ]);
    state.core = { 'UICore.systemPopupResource': 'prefab/common/plain', 'UICore.loadingIconResource': 'prefab/common/plain' };
    expect(lines(await uiPrefab.run(memContext(BASE)))).toEqual([
      'settings.json:3 | UI prefab: the root of resource/prefab/common/plain.tscn (`UICore.systemPopupResource`) has no script that is or inherits `UIPopup`',
      'settings.json:4 | UI prefab: the root of resource/prefab/common/plain.tscn (`UICore.loadingIconResource`) is a `Node2D`, not a `Control`',
    ]);
    state.core = { 'UICore.systemPopupResource': 'prefab/common/gone', 'UICore.loadingIconResource': 'prefab/common/icon' };
    const noIcon = Object.fromEntries(Object.entries(BASE).filter(([path]) => path !== 'resource/prefab/common/icon.tscn'));
    // a core settings default is not in settings.json: its where is line 1
    expect(lines(await uiPrefab.run(memContext({ ...noIcon, 'settings.json': '{}\n', 'resource/resources.csv': `${LIST}prefab/common/gone,x,,final,,,,,\n` })))).toEqual([
      'settings.json:1 | UI prefab: `UICore.loadingIconResource` `prefab/common/icon` has no file resource/prefab/common/icon.tscn',
      'settings.json:1 | UI prefab: `UICore.systemPopupResource` `prefab/common/gone` has no file resource/prefab/common/gone.tscn',
    ]);
    // with `core` in settings.json but not the key, the where is the line of `core`, the value that would hold it
    const withCore = { ...noIcon, 'settings.json': '{\n  "engine": "godot",\n  "core": {\n    "NetworkCore.retryCount": 1\n  }\n}\n', 'resource/resources.csv': `${LIST}prefab/common/gone,x,,final,,,,,\n` };
    expect(lines(await uiPrefab.run(memContext(withCore)))).toEqual([
      'settings.json:3 | UI prefab: `UICore.loadingIconResource` `prefab/common/icon` has no file resource/prefab/common/icon.tscn',
      'settings.json:3 | UI prefab: `UICore.systemPopupResource` `prefab/common/gone` has no file resource/prefab/common/gone.tscn',
    ]);
  });

  it('checks nothing when the merged core settings have no such key', async () => {
    state.core = {};
    expect(await uiPrefab.run(memContext(BASE))).toEqual([]);
  });
});
