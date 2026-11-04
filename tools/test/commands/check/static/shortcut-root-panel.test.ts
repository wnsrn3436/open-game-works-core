import { describe, expect, it } from 'vitest';
import * as shortcutRootPanel from '../../../../src/commands/check/static/shortcut-root-panel.ts';
import { lines, memContext, sorted, type Files } from './helpers.ts';

const SCENE_BASE = (rootDefault: string): Files => ({
  'client/core/scene_core/scene_base.gd': `class_name SceneBase\nextends Node\n\n@export var root_panel: String = "${rootDefault}"\n`,
  'client/features/lobby/lobby_scene.gd': 'class_name LobbyScene\nextends SceneBase\n',
});

/** A scene resource whose root has the script `LobbyScene`, with `root_panel` written when it is not null. */
const scene = (rootPanel: string | null): string =>
  [
    '[gd_scene format=3]',
    '[ext_resource type="Script" path="res://features/lobby/lobby_scene.gd" id="s"]',
    '',
    '[node name="Scene" type="Node"]',
    'script = ExtResource("s")',
    ...(rootPanel === null ? [] : [`root_panel = "${rootPanel}"`]),
    '',
  ].join('\n');

/** A scene resource whose root instances `base`, with `root_panel` written when it is not null. */
const derived = (base: string, rootPanel: string | null): string =>
  [
    '[gd_scene format=3]',
    `[ext_resource type="PackedScene" path="res://resource/scene/${base}.tscn" id="base"]`,
    '',
    '[node name="Derived" instance=ExtResource("base")]',
    ...(rootPanel === null ? [] : [`root_panel = "${rootPanel}"`]),
    '',
  ].join('\n');

const HEADER = ',,,,,\nAll,Client,Client,Client,Client,Client\nid(key),reskey,array<reskey>,enum<ShortcutStack>,array<int>,requirement\nid,scene,panels,stack,args,requirement\n';

describe('shortcut root panel', () => {
  it('finds rows whose panels hold the root panel key of their scene, other than a Root row with only that key', async () => {
    const sc = memContext({
      ...SCENE_BASE(''),
      'resource/scene/lobby.tscn': scene('prefab/ui/lobby_main'),
      'resource/scene/battle.tscn': scene(null),
      'data/tables/shortcut.csv': [
        HEADER.trimEnd(),
        '[s_two],scene/lobby,"prefab/ui/lobby_main\nprefab/ui/shop",Root,,',
        '[s_top],scene/lobby,prefab/ui/lobby_main,Top,,',
        '[s_root],scene/lobby,prefab/ui/lobby_main,Root,,',
        '[s_other],scene/lobby,"prefab/ui/shop\nprefab/ui/item",Top,,',
        '[s_after],scene/lobby,"prefab/ui/shop\nprefab/ui/lobby_main",Top,,',
        '[s_empty],scene/lobby,,Top,,',
        '[s_none],scene/battle,prefab/ui/lobby_main,Top,,',
        '[s_missing],scene/nowhere,prefab/ui/lobby_main,Top,,',
        '#[s_comment],scene/lobby,prefab/ui/lobby_main,Top,,',
        '',
      ].join('\n'),
    });
    const where = (line: number): string =>
      `data/tables/shortcut.csv:${String(line)} | shortcut root panel: \`panels\` holds \`prefab/ui/lobby_main\`, the root panel key of scene \`scene/lobby\`; only a \`Root\` row whose \`panels\` is only that key may hold it`;
    expect(lines(await shortcutRootPanel.run(sc))).toEqual(sorted([where(5), where(7), where(11)]));
  });

  it('reads the root panel of the base scene the scene instances, under the one written on the scene', async () => {
    const sc = memContext({
      ...SCENE_BASE(''),
      'resource/scene/town_base.tscn': scene('prefab/ui/town_main'),
      'resource/scene/town.tscn': derived('town_base', null),
      'resource/scene/port.tscn': derived('town', null),
      'resource/scene/camp.tscn': derived('town_base', ''),
      'data/tables/shortcut.csv': `${HEADER}[s_town],scene/town,prefab/ui/town_main,Top,,\n[s_port],scene/port,"prefab/ui/town_main\nprefab/ui/shop",Root,,\n[s_camp],scene/camp,prefab/ui/town_main,Top,,\n`,
    });
    expect(lines(await shortcutRootPanel.run(sc))).toEqual(sorted([
      'data/tables/shortcut.csv:5 | shortcut root panel: `panels` holds `prefab/ui/town_main`, the root panel key of scene `scene/town`; only a `Root` row whose `panels` is only that key may hold it',
      'data/tables/shortcut.csv:6 | shortcut root panel: `panels` holds `prefab/ui/town_main`, the root panel key of scene `scene/port`; only a `Root` row whose `panels` is only that key may hold it',
    ]));
  });

  it('reads the script default and skips a scene whose root panel cannot be read', async () => {
    const sc = memContext({
      ...SCENE_BASE('prefab/ui/default_main'),
      'resource/scene/lobby.tscn': scene(null),
      'resource/scene/plain.tscn': '[gd_scene format=3]\n\n[node name="Plain" type="Node"]\n',
      'resource/scene/odd.tscn': scene(null).replace('script = ExtResource("s")', 'script = ExtResource("s")\nroot_panel = 3'),
      'data/tables/shortcut.csv': `${HEADER}[s_lobby],scene/lobby,prefab/ui/default_main,Top,,\n[s_plain],scene/plain,prefab/ui/default_main,Top,,\n[s_odd],scene/odd,prefab/ui/default_main,Top,,\n`,
    });
    expect(lines(await shortcutRootPanel.run(sc))).toEqual([
      'data/tables/shortcut.csv:5 | shortcut root panel: `panels` holds `prefab/ui/default_main`, the root panel key of scene `scene/lobby`; only a `Root` row whose `panels` is only that key may hold it',
    ]);
  });

  it('finds nothing without the table, its rows or the scene file', async () => {
    expect(await shortcutRootPanel.run(memContext({ ...SCENE_BASE(''), 'resource/scene/lobby.tscn': scene('prefab/ui/lobby_main') }))).toEqual([]);
    expect(await shortcutRootPanel.run(memContext({ ...SCENE_BASE(''), 'resource/scene/lobby.tscn': scene('prefab/ui/lobby_main'), 'data/tables/shortcut.csv': HEADER }))).toEqual([]);
    expect(await shortcutRootPanel.run(memContext({ ...SCENE_BASE(''), 'data/tables/shortcut.csv': `${HEADER}[s_top],scene/lobby,prefab/ui/lobby_main,Top,,\n` }))).toEqual([]);
  });
});
