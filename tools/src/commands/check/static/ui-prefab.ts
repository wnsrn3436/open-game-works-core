import { LIST_PATH, parseKey } from '../../resource/lib/list.ts';
import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { godotInherits } from './lib/engine.ts';
import { instanceChain, nodeClass } from './lib/scene-classes.ts';
import { settingsLine } from './lib/settings-lines.ts';

/**
 * UI prefab (`client-content` Godot `## scene and prefab`): merged core settings `UICore.systemPopupResource` and
 * `UICore.loadingIconResource` are each the key of a `prefab` row of `resources.csv` whose `.tscn` exists; the root of the
 * system popup prefab has a script that is or inherits `UIPopup` (its own, else the root script of the scene it
 * instances), and the root of the loading icon prefab is a `Control`: its node type, or when it instances a scene the node
 * type of that scene's root, is `Control` or inherits it in the pinned Godot. A key that the merged core settings do not
 * have is not checked. The `where` is the line of the value of `core.<key>` in `settings.json` (`settingsLine`).
 */
export const NAME = 'UI prefab';

const POPUP = 'UICore.systemPopupResource';
const ICON = 'UICore.loadingIconResource';

/** The node type of a scene's root: its own, else the root type of the scenes it instances. */
async function rootType(sc: StaticContext, path: string): Promise<string | null> {
  const scene = await sc.scene(path);
  const root = scene.nodes[0];
  if (!root) return null;
  if (root.type !== null) return root.type;
  for (const sub of await instanceChain(sc, scene, root)) if (sub.nodes[0]?.type) return sub.nodes[0].type;
  return null;
}

/** Why the prefab of a key breaks the rule, or null. */
async function problem(sc: StaticContext, key: string, value: unknown, prefabs: ReadonlySet<string>): Promise<string | null> {
  const what = key === POPUP ? 'the system popup prefab' : 'the loading icon prefab';
  if (typeof value !== 'string' || value === '') return `\`${key}\` is empty; set it to ${what} of the game, drawn in its UI style`;
  if (parseKey(value)?.type !== 'prefab' || !prefabs.has(value)) return `\`${key}\` \`${value}\` is not the key of a \`prefab\` row of ${LIST_PATH}`;
  const path = `resource/${value}.tscn`;
  if (!sc.has(path)) return `\`${key}\` \`${value}\` has no file ${path}`;
  const scene = await sc.scene(path);
  const root = scene.nodes[0];
  if (!root) return `${path} has no root node`;
  if (key === POPUP) return (await nodeClass(sc, scene, root, ['UIPopup'])) === null ? `the root of ${path} (\`${key}\`) has no script that is or inherits \`UIPopup\`` : null;
  const type = await rootType(sc, path);
  if (type === null) return `the root of ${path} (\`${key}\`) has no node type`;
  return (await godotInherits(sc, [type], 'Control')).get(type) === true ? null : `the root of ${path} (\`${key}\`) is a \`${type}\`, not a \`Control\``;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const core = await sc.coreSettings();
  const keys = [POPUP, ICON].filter((key) => key in core);
  if (keys.length === 0) return [];
  const list = await sc.headerTable(LIST_PATH);
  const prefabs = new Set((list?.rows ?? []).map((r) => r.values.key ?? '').filter((k) => k !== ''));
  const text = sc.has('settings.json') ? await sc.text('settings.json') : '';
  const out: Finding[] = [];
  for (const key of keys) {
    const why = await problem(sc, key, core[key], prefabs);
    if (why !== null) out.push(finding(NAME, at('settings.json', settingsLine(text, `core.${key}`)), why));
  }
  return out;
}
