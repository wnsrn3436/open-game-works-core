import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { cellOf } from './lib/csv.ts';
import { godotKeyNames } from './lib/engine.ts';
import { nodeClass, sceneFiles } from './lib/scene-classes.ts';
import { parseTextScene, strOf } from './lib/tscn.ts';

/**
 * action reference: a reference to an action that is not in the game's input map (`project.godot` `input/` keys
 * without `ui_` actions, core actions included): `UIButton`, `VirtualButton`, `VirtualJoystick` node actions,
 * a `UIButton` with action `back`, input prompt tokens `{action:<action>}` in `tstring` cells and translations,
 * and `input_prompt` rows (`Touch` input not an action, `KeyboardMouse` input not a key or mouse button name).
 */
export const NAME = 'action reference';

export const CORE_ACTIONS = ['back', 'cutscene_advance', 'cutscene_skip'];
const MOUSE_BUTTONS = new Set(['mouse_left', 'mouse_right', 'mouse_middle']);
const ACTION_PROPS = ['action', 'action_negative_x', 'action_positive_x', 'action_negative_y', 'action_positive_y'];
const BUTTON_CLASSES = ['UIButton', 'VirtualButton', 'VirtualJoystick'];
const TOKEN = /\{action:([^}]*)\}/g;

/** Actions of the input map. */
export async function actionList(sc: StaticContext): Promise<Set<string>> {
  const actions = new Set(CORE_ACTIONS);
  if (!sc.has('client/project.godot')) return actions;
  const project = parseTextScene('client/project.godot', await sc.text('client/project.godot'));
  for (const section of project.sections.filter((s) => s.tag === 'input')) {
    for (const key of section.props.keys()) if (!key.startsWith('ui_')) actions.add(key);
  }
  return actions;
}

async function sceneFindings(sc: StaticContext, path: string, actions: Set<string>): Promise<Finding[]> {
  const scene = await sc.scene(path);
  const out: Finding[] = [];
  for (const node of scene.nodes) {
    const cls = await nodeClass(sc, scene, node, BUTTON_CLASSES);
    if (cls === null) continue;
    for (const prop of ACTION_PROPS) {
      const entry = node.props.get(prop);
      const value = strOf(entry?.value);
      if (!entry || value === null || value === '') continue;
      if (!actions.has(value)) out.push(finding(NAME, at(path, entry.line), `\`${cls}\` node \`${node.path}\` ${prop} \`${value}\` is not in the input map`));
      else if (cls === 'UIButton' && prop === 'action' && value === 'back') out.push(finding(NAME, at(path, entry.line), `\`UIButton\` node \`${node.path}\` uses action \`back\``));
    }
  }
  return out;
}

function tokenFindings(path: string, line: number, text: string, actions: Set<string>): Finding[] {
  const out: Finding[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const action = m[1] as string;
    if (!actions.has(action)) out.push(finding(NAME, at(path, line), `input prompt token \`{action:${action}}\` is not in the input map`));
  }
  return out;
}

async function tableFindings(sc: StaticContext, path: string, actions: Set<string>): Promise<Finding[]> {
  const table = await sc.table(path);
  if (!table) return [];
  const columns = table.types.flatMap((t, i) => (t.startsWith('tstring') ? [i] : []));
  return table.rows.flatMap((row) => columns.flatMap((i) => tokenFindings(path, row.line, row.cells[i] ?? '', actions)));
}

async function translationFindings(sc: StaticContext, path: string, actions: Set<string>): Promise<Finding[]> {
  const rows = (await sc.headerTable(path))?.rows ?? [];
  return rows.flatMap((row) => tokenFindings(path, row.line, row.values.text ?? '', actions));
}

async function promptFindings(sc: StaticContext, actions: Set<string>): Promise<Finding[]> {
  const table = await sc.table('data/tables/input_prompt.csv');
  if (!table) return [];
  const out: Finding[] = [];
  const keyRows: { input: string; line: number }[] = [];
  for (const row of table.rows) {
    const family = cellOf(table, row, 'family');
    const input = cellOf(table, row, 'input') ?? '';
    if (family === 'Touch' && !actions.has(input)) out.push(finding(NAME, at(table.path, row.line), `\`Touch\` input \`${input}\` is not in the input map`));
    if (family === 'KeyboardMouse' && !MOUSE_BUTTONS.has(input)) keyRows.push({ input, line: row.line });
  }
  const keys = await godotKeyNames(sc, [...new Set(keyRows.map((r) => r.input))]);
  for (const row of keyRows) {
    if (!keys.get(row.input)) out.push(finding(NAME, at(table.path, row.line), `\`KeyboardMouse\` input \`${row.input}\` is not a key name or a mouse button name`));
  }
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const actions = await actionList(sc);
  const jobs = [
    ...sceneFiles(sc).map((p) => sceneFindings(sc, p, actions)),
    ...sc.filter((p) => /^data\/tables\/[^/]+\.csv$/.test(p)).map((p) => tableFindings(sc, p, actions)),
    ...sc.filter((p) => /^data\/translations\/[^/]+\.csv$/.test(p)).map((p) => translationFindings(sc, p, actions)),
    promptFindings(sc, actions),
  ];
  return (await Promise.all(jobs)).flat();
}
