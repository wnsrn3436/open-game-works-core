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
}

export const PROJECT_FILE = 'client/project.godot';

const KEY_EVENTS = new Set(['InputEventKey', 'InputEventMouseButton']);
const PAD_EVENTS = new Set(['InputEventJoypadButton', 'InputEventJoypadMotion']);

/** Class names of the `Object(<class>, ...)` items of an action's `events`. */
function eventClasses(value: Variant): string[] {
  if (value.t !== 'dict') return [];
  const events = value.entries.find((e) => e.key.t === 'str' && e.key.v === 'events')?.value;
  if (events?.t !== 'arr') return [];
  return events.items.flatMap((item) => {
    const first = item.t === 'call' && item.name === 'Object' ? item.args[0] : undefined;
    return first?.t === 'raw' ? [first.text.trim()] : [];
  });
}

/** The actions of the input map in file order; empty when the game has no `client/project.godot`. */
export async function inputMapActions(sc: StaticContext): Promise<InputMapAction[]> {
  if (!sc.has(PROJECT_FILE)) return [];
  const project = parseTextScene(PROJECT_FILE, await sc.text(PROJECT_FILE));
  const out: InputMapAction[] = [];
  for (const section of project.sections.filter((s) => s.tag === 'input')) {
    for (const [name, prop] of section.props) {
      if (name.startsWith('ui_')) continue;
      const classes = eventClasses(prop.value);
      out.push({ name, line: prop.line, keys: classes.some((c) => KEY_EVENTS.has(c)), pad: classes.some((c) => PAD_EVENTS.has(c)) });
    }
  }
  return out;
}
