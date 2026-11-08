import type { StaticContext } from './context.ts';
import { parseTextScene, type Variant } from './tscn.ts';

/** One action of the game's input map (`project.godot` `input/` keys without `ui_` actions) and what its default binding holds. */
export interface InputMapAction {
  name: string;
  /** Line of the action key in `client/project.godot`. */
  line: number;
  /** The default binding has a key or mouse button (`InputEventKey`, `InputEventMouseButton`). */
  keys: boolean;
  /** The default binding has a gamepad button or gamepad axis direction (`InputEventJoypadButton`, `InputEventJoypadMotion`). */
  pad: boolean;
  /** The default binding has a direction of a stick axis: an `InputEventJoypadMotion` whose `axis` is a stick axis. */
  stickAxis: boolean;
}

export const PROJECT_FILE = 'client/project.godot';

const KEY_EVENTS = new Set(['InputEventKey', 'InputEventMouseButton']);
const PAD_EVENTS = new Set(['InputEventJoypadButton', 'InputEventJoypadMotion']);

/**
 * The `JoyAxis` values of the stick axes `left_x`, `left_y`, `right_x`, `right_y` (`JOY_AXIS_LEFT_X` to
 * `JOY_AXIS_RIGHT_Y`; Godot gamepad axis names of the engine-specific implementation rules).
 */
const STICK_AXES = new Set([0, 1, 2, 3]);
/** The `axis` of an `InputEventJoypadMotion` that does not store one: the default of the engine, `JOY_AXIS_LEFT_X`. */
const DEFAULT_AXIS = 0;

interface InputEvent {
  cls: string;
  args: Variant[];
}

/** The `Object(<class>, ...)` items of an action's `events`, with their args. */
function inputEvents(value: Variant): InputEvent[] {
  if (value.t !== 'dict') return [];
  const events = value.entries.find((e) => e.key.t === 'str' && e.key.v === 'events')?.value;
  if (events?.t !== 'arr') return [];
  return events.items.flatMap((item) => {
    if (item.t !== 'call' || item.name !== 'Object') return [];
    const first = item.args[0];
    return first?.t === 'raw' ? [{ cls: first.text.trim(), args: item.args }] : [];
  });
}

/** The value of property `name` of an `Object(<class>, "<property>":<value>, ...)` item. */
function eventProperty(event: InputEvent, name: string): Variant | undefined {
  for (let i = 1; i < event.args.length - 1; i += 2) {
    const key = event.args[i];
    if (key?.t === 'str' && key.v === name) return event.args[i + 1];
  }
  return undefined;
}

function isStickAxisDirection(event: InputEvent): boolean {
  if (event.cls !== 'InputEventJoypadMotion') return false;
  const axis = eventProperty(event, 'axis');
  return STICK_AXES.has(axis?.t === 'num' ? axis.v : DEFAULT_AXIS);
}

/** The actions of the input map in file order; empty when the game has no `client/project.godot`. */
export async function inputMapActions(sc: StaticContext): Promise<InputMapAction[]> {
  if (!sc.has(PROJECT_FILE)) return [];
  const project = parseTextScene(PROJECT_FILE, await sc.text(PROJECT_FILE));
  const out: InputMapAction[] = [];
  for (const section of project.sections.filter((s) => s.tag === 'input')) {
    for (const [name, prop] of section.props) {
      if (name.startsWith('ui_')) continue;
      const events = inputEvents(prop.value);
      out.push({
        name,
        line: prop.line,
        keys: events.some((e) => KEY_EVENTS.has(e.cls)),
        pad: events.some((e) => PAD_EVENTS.has(e.cls)),
        stickAxis: events.some(isStickAxisDirection),
      });
    }
  }
  return out;
}
