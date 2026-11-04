import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { cellOf } from './lib/csv.ts';
import { repoPath } from './lib/files.ts';
import { classIndex } from './lib/gd-shared.ts';
import { instanceChain, scriptOf } from './lib/scene-classes.ts';
import { strOf } from './lib/tscn.ts';

/**
 * shortcut root panel (`shortcut-core` `## data`): a `shortcut` row whose `panels` holds the root panel key of the scene
 * of its `scene` column, other than a row whose `stack` is `Root` and whose `panels` is only that key. The root panel key
 * of scene key `scene/<name>` is `root_panel` (`SceneBase`) of the root of `resource/scene/<name>.tscn`: the value written
 * there, else the value written on the root of the scene its root instances (and that scene's base, and so on), else the
 * default of the root script. A row whose scene has no file or whose root panel cannot be read is not checked.
 */
export const NAME = 'shortcut root panel';

const TABLE = 'data/tables/shortcut.csv';

/** Elements of an `array<reskey>` cell: one per line (`data` skill `## type`). */
function keysOf(cell: string): string[] {
  return cell
    .split('\n')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/** `root_panel` of the root of a scene resource; the empty string for none, null when it cannot be read. */
async function rootPanel(sc: StaticContext, path: string): Promise<string | null> {
  if (!sc.has(path)) return null;
  const scene = await sc.scene(path);
  const root = scene.nodes[0];
  if (!root) return null;
  for (const s of [scene, ...(await instanceChain(sc, scene, root))]) {
    const written = s.nodes[0]?.props.get('root_panel');
    if (written) return strOf(written.value);
  }
  const script = await scriptOf(sc, scene, root);
  const scriptPath = script === null ? null : repoPath(script);
  const index = await classIndex(sc);
  const ref = scriptPath === null ? null : await index.byPath(scriptPath);
  const member = ref ? await index.member(ref, 'root_panel') : null;
  if (member?.decl.k !== 'var') return null;
  const value = member.decl.value;
  if (value === null) return '';
  return value.k === 'str' ? value.value : null;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const table = await sc.table(TABLE);
  if (!table) return [];
  const roots = new Map<string, Promise<string | null>>();
  const out: Finding[] = [];
  for (const row of table.rows) {
    const sceneKey = (cellOf(table, row, 'scene') ?? '').trim();
    const panels = keysOf(cellOf(table, row, 'panels') ?? '');
    if (!sceneKey.startsWith('scene/') || panels.length === 0) continue;
    let root = roots.get(sceneKey);
    if (!root) {
      root = rootPanel(sc, `resource/${sceneKey}.tscn`);
      roots.set(sceneKey, root);
    }
    const key = await root;
    if (key === null || key === '' || !panels.includes(key)) continue;
    const stack = (cellOf(table, row, 'stack') ?? '').trim();
    if (stack === 'Root' && panels.length === 1) continue;
    out.push(
      finding(
        NAME,
        at(table.path, row.line),
        `\`panels\` holds \`${key}\`, the root panel key of scene \`${sceneKey}\`; only a \`Root\` row whose \`panels\` is only that key may hold it`,
      ),
    );
  }
  return out;
}
