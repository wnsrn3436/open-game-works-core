import { CORE_ACTIONS } from './action-reference.ts';
import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isClientContentGd, isClientDev, isClientTest } from './lib/files.ts';
import { exprsOf } from './lib/gd-shared.ts';
import { chainText } from './lib/gd-walk.ts';
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
    for (const { expr } of exprsOf(await sc.gd(path))) {
      const name = chainText(expr);
      if (name === null || !PAD_NAMES.has(name)) continue;
      const where = at(path, expr.line);
      if (seen.has(`${where} ${name}`)) continue;
      seen.add(`${where} ${name}`);
      out.push(finding(NAME, where, `\`${name}\` is gamepad input ${UNSUPPORTED}`));
    }
  }
  return out;
}
