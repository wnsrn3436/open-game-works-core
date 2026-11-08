import { CORE_ACTIONS } from './action-reference.ts';
import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isClientContentGd, isClientDev, isClientTest } from './lib/files.ts';
import type { GdFile } from './lib/gd-ast.ts';
import type { Token } from './lib/gd-lexer.ts';
import { inputMapActions, PROJECT_FILE } from './lib/input-map.ts';

/**
 * gamepad input (`client-content` `### UI composition`): while game settings `gamepadSupported` is not `true`, an
 * action of the input map other than the core actions has a gamepad button or gamepad axis direction in its default
 * binding, or client content code outside `client/dev/` and `client/tests/` names a gamepad-only part of `InputCore`
 * (ogw.md `## static check`).
 */
export const NAME = 'gamepad input';

const PAD_NAMES = new Set([
  'InputCore.InputDevice.GAMEPAD',
  'GameData.InputPromptFamily.GENERIC',
  'GameData.InputPromptFamily.XBOX',
  'GameData.InputPromptFamily.PLAY_STATION',
  'GameData.InputPromptFamily.NINTENDO',
  'InputCore.get_connected_gamepads',
  'InputCore.get_pad_buttons',
  'InputCore.set_pad_buttons',
  'InputCore.reset_pad_buttons',
  'InputCore.wait_pad_button',
  'InputCore.set_pad_axis_inverted',
  'InputCore.is_pad_axis_inverted',
  'InputCore.set_pad_axis_sensitivity',
  'InputCore.get_pad_axis_sensitivity',
  'InputCore.list_pad_axis_sensitivities',
  'InputCore.reset_pad_axes',
  'GamepadConnectionChangedEvent',
]);

const UNSUPPORTED = 'while game settings `gamepadSupported` is not `true`';

export async function run(sc: StaticContext): Promise<Finding[]> {
  if ((await sc.settings()).gamepadSupported === true) return [];
  const out: Finding[] = [];
  for (const action of await inputMapActions(sc)) {
    if (CORE_ACTIONS.includes(action.name) || !action.pad) continue;
    out.push(finding(NAME, at(PROJECT_FILE, action.line), `action \`${action.name}\` has a gamepad button or gamepad axis direction in its default binding ${UNSUPPORTED}`));
  }
  for (const path of sc.filter((p) => isClientContentGd(p) && !isClientDev(p) && !isClientTest(p))) {
    const seen = new Set<string>();
    for (const { name, line } of dottedNames(await sc.gd(path))) {
      if (!PAD_NAMES.has(name)) continue;
      const where = at(path, line);
      if (seen.has(`${where} ${name}`)) continue;
      seen.add(`${where} ${name}`);
      out.push(finding(NAME, where, `\`${name}\` is gamepad input ${UNSUPPORTED}`));
    }
  }
  return out;
}

/**
 * Each dotted name of a file that does not come after a `.` (`InputCore.InputDevice.GAMEPAD`), with each of its leading
 * parts (`InputCore`, `InputCore.InputDevice`), at the line of its first name: the names of expressions, types (of
 * variables, parameters and return values, `is` and `as`) and match patterns alike.
 */
function dottedNames(file: GdFile): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  const tokens = file.tokens;
  const dot = (t: Token | undefined): boolean => t?.type === 'op' && t.text === '.';
  for (const [i, first] of tokens.entries()) {
    if (first.type !== 'name' || dot(tokens[i - 1])) continue;
    let name = first.text;
    out.push({ name, line: first.line });
    for (let j = i + 1; dot(tokens[j]) && tokens[j + 1]?.type === 'name'; j += 2) {
      name = `${name}.${(tokens[j + 1] as Token).text}`;
      out.push({ name, line: first.line });
    }
  }
  return out;
}
