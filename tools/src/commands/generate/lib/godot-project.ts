import { OgwError } from '../../../lib/errors.ts';
import { GDSCRIPT_ERROR_WARNINGS } from '../../code/gdscript-checks.ts';
import { compareBytes } from './core-spec.ts';
import { inputEvents, intProperty, numberProperty, parseCfg, quote, settingName, type CfgEntry } from './godot-cfg.ts';

/** Key prefixes `client/boot/project_settings.cfg` may set (`client-content` Godot `## engine settings`). */
export const ALLOWED_PREFIXES: readonly string[] = [
  'layer_names/',
  'input/',
  'physics/common/',
  'physics/2d/',
  'physics/3d/',
  'rendering/textures/canvas_textures/',
  'rendering/2d/',
  'rendering/anti_aliasing/',
  'rendering/lights_and_shadows/',
  'rendering/environment/defaults/',
];

const ALLOWED_EVENTS: ReadonlySet<string> = new Set([
  'InputEventKey',
  'InputEventMouseButton',
  'InputEventJoypadButton',
  'InputEventJoypadMotion',
]);

/** Godot `Key` values of the core action default keys. */
const KEY_ESCAPE = 4194305;
const KEY_TAB = 4194306;
const KEY_ENTER = 4194309;
const KEY_SPACE = 32;
/** Godot `JoyButton` values of the core action default gamepad buttons. */
const JOY_A = 0;
const JOY_B = 1;
const JOY_START = 6;

/** Inputs of an action: keys, mouse buttons, gamepad buttons and gamepad axis directions (`<axis>+` or `<axis>-`). */
export interface Binding {
  keys: number[];
  mouseButtons: number[];
  buttons: number[];
  axes: string[];
}

function keysAndButtons(keys: number[], buttons: number[]): Binding {
  return { keys, mouseButtons: [], buttons, axes: [] };
}

/** Core actions and their default binding (`InputCore` `### action`). */
export const CORE_ACTIONS: ReadonlyMap<string, Binding> = new Map([
  ['back', keysAndButtons([KEY_ESCAPE], [JOY_B])],
  ['cutscene_advance', keysAndButtons([KEY_SPACE, KEY_ENTER], [JOY_A])],
  ['cutscene_skip', keysAndButtons([KEY_TAB], [JOY_START])],
]);

/** `InputCore` binding context of an action name. */
export function bindingContext(action: string): 'Ui' | 'Cutscene' | 'Gameplay' {
  if (action === 'back' || action.startsWith('menu_')) return 'Ui';
  if (action.startsWith('cutscene_')) return 'Cutscene';
  return 'Gameplay';
}

/** The binding of an input action value. A gamepad axis event with `axis_value` 0 has no direction. */
export function bindingOf(entry: CfgEntry): Binding {
  const result = keysAndButtons([], []);
  for (const event of inputEvents(entry.value)) {
    if (event.className === 'InputEventKey') {
      const keycode = intProperty(event.text, 'keycode');
      result.keys.push(keycode !== 0 ? keycode : intProperty(event.text, 'physical_keycode'));
    } else if (event.className === 'InputEventMouseButton') {
      result.mouseButtons.push(intProperty(event.text, 'button_index'));
    } else if (event.className === 'InputEventJoypadButton') {
      result.buttons.push(intProperty(event.text, 'button_index'));
    } else if (event.className === 'InputEventJoypadMotion') {
      const value = numberProperty(event.text, 'axis_value');
      if (value !== 0) result.axes.push(`${String(intProperty(event.text, 'axis'))}${value > 0 ? '+' : '-'}`);
    }
  }
  return result;
}

const INPUT_PREFIX = 'input/';

/** The input action name of an entry whose full setting name starts with `input/`, in or outside a section. */
function inputAction(entry: CfgEntry): string | undefined {
  const name = settingName(entry);
  return name.startsWith(INPUT_PREFIX) ? name.slice(INPUT_PREFIX.length) : undefined;
}

function entryErrors(entry: CfgEntry, file: string): string[] {
  const name = settingName(entry);
  const where = `${file}:${String(entry.line)}`;
  if (!ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix))) return [`${where}: key ${name} is not allowed`];
  const action = inputAction(entry);
  if (action === undefined) return [];
  const errors: string[] = [];
  if (CORE_ACTIONS.has(action)) errors.push(`${where}: core action ${action} is set`);
  if (action.startsWith('ui_')) errors.push(`${where}: engine action ${action} is set`);
  for (const event of inputEvents(entry.value)) {
    if (!ALLOWED_EVENTS.has(event.className)) errors.push(`${where}: input event ${event.className} is not allowed in ${action}`);
  }
  return errors;
}

function shares<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.some((value) => b.includes(value));
}

function overlapErrors(actions: ReadonlyMap<string, Binding>): string[] {
  const names = [...actions.keys()];
  const errors: string[] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i] as string;
      const b = names[j] as string;
      if (bindingContext(a) !== bindingContext(b)) continue;
      const x = actions.get(a) as Binding;
      const y = actions.get(b) as Binding;
      const shared = [
        shares(x.keys, y.keys) ? 'a key' : '',
        shares(x.mouseButtons, y.mouseButtons) ? 'a mouse button' : '',
        shares(x.buttons, y.buttons) ? 'a gamepad button' : '',
        shares(x.axes, y.axes) ? 'a gamepad axis direction' : '',
      ].filter((what) => what !== '');
      if (shared.length > 0) errors.push(`overlapping actions ${a} and ${b} share ${shared.join(', ')}`);
    }
  }
  return errors;
}

/**
 * Parses and checks `client/boot/project_settings.cfg`. Throws one error listing every violation:
 * keys outside the allowed prefixes, core actions, `ui_` actions, input events outside the allowed
 * classes, and overlapping actions (core actions included) sharing a key, mouse button, gamepad button or
 * gamepad axis direction.
 */
export function checkContentSettings(text: string, file: string): CfgEntry[] {
  const entries = parseCfg(text, file);
  const errors = entries.flatMap((entry) => entryErrors(entry, file));
  const actions = new Map<string, Binding>(CORE_ACTIONS);
  for (const entry of entries) {
    const action = inputAction(entry);
    if (action !== undefined && !CORE_ACTIONS.has(action)) actions.set(action, bindingOf(entry));
  }
  errors.push(...overlapErrors(actions));
  if (errors.length > 0) throw new OgwError(errors.join('\n'));
  return entries;
}

function keyEvent(keycode: number): string {
  return `Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"pressed":false,"keycode":${String(keycode)},"physical_keycode":0,"key_label":0,"unicode":0,"location":0,"echo":false,"script":null)`;
}

function buttonEvent(button: number): string {
  return `Object(InputEventJoypadButton,"resource_local_to_scene":false,"resource_name":"","device":-1,"button_index":${String(button)},"pressure":0.0,"pressed":false,"script":null)`;
}

function actionValue(binding: Binding): string {
  const events = [...binding.keys.map(keyEvent), ...binding.buttons.map(buttonEvent)];
  return `{\n"deadzone": 0.5,\n"events": [${events.join('\n, ')}\n]\n}`;
}

export interface ProjectValues {
  appName: string;
  /** Language tag with `-` replaced by `_` → app name in that language. */
  localizedNames: [string, string][];
  iconPath: string;
  splashPath: string;
  baseResolution: [number, number];
}

function harnessSettings(values: ProjectValues): [string, string][] {
  const [width, height] = values.baseResolution;
  const localized = values.localizedNames.map(([code, name]) => `${quote(code)}: ${quote(name)}`).join(',\n');
  return [
    ['application/config/name', quote(values.appName)],
    ['application/config/name_localized', localized === '' ? '{}' : `{\n${localized}\n}`],
    ['application/config/icon', quote(values.iconPath)],
    ['application/boot_splash/image', quote(values.splashPath)],
    ['application/run/main_scene', quote('res://boot/boot.tscn')],
    ['display/window/handheld/orientation', width > height ? '4' : '5'],
    ['display/window/size/viewport_width', String(width)],
    ['display/window/size/viewport_height', String(height)],
    ...engineSettings(),
  ];
}

/** The harness tool settings of every Godot project: renderer, import, export, GDScript warnings and core actions. */
function engineSettings(): [string, string][] {
  return [
    ['rendering/renderer/rendering_method', quote('forward_plus')],
    ['rendering/renderer/rendering_method.mobile', quote('mobile')],
    ['rendering/renderer/rendering_method.web', quote('gl_compatibility')],
    ['rendering/rendering_device/fallback_to_opengl3', 'true'],
    ['rendering/textures/vram_compression/import_s3tc_bptc', 'true'],
    ['rendering/textures/vram_compression/import_etc2_astc', 'true'],
    ['editor/export/convert_text_resources_to_binary', 'false'],
    ['editor/import/use_multiple_threads', 'false'],
    // the browser runtime plays through the engine mixer too, so bus effects (the `Master` limiter) run there
    ['audio/general/default_playback_type.web', '0'],
    ...GDSCRIPT_ERROR_WARNINGS.map((name): [string, string] => [`debug/gdscript/warnings/${name}`, '2']),
    ...[...CORE_ACTIONS].map(([action, binding]): [string, string] => [`input/${action}`, actionValue(binding)]),
  ];
}

/** Sections of `config_version=5` text from settings `<section>/<key>`, sections and keys in byte order. */
function renderSettings(settings: readonly [string, string][]): string {
  const sections = new Map<string, Map<string, string>>();
  for (const [name, value] of settings) {
    const slash = name.indexOf('/');
    const section = name.slice(0, slash);
    const keys = sections.get(section) ?? new Map<string, string>();
    keys.set(name.slice(slash + 1), value);
    sections.set(section, keys);
  }
  const out = ['config_version=5', ''];
  for (const section of [...sections.keys()].sort(compareBytes)) {
    out.push(`[${section}]`, '');
    const keys = sections.get(section) as Map<string, string>;
    for (const key of [...keys.keys()].sort(compareBytes)) out.push(`${key}=${keys.get(key) as string}`);
    out.push('');
  }
  return out.join('\n');
}

/**
 * The core project's `project.godot` (`client-core` Godot `## folder`): the engine settings, the name `ogw-core` and no
 * physics object picking. `mainScene` is the main scene of the browser run's export copy (`client-core` Godot `## test`).
 */
export function renderCoreProjectGodot(mainScene: string | null = null): string {
  const main: [string, string][] = mainScene === null ? [] : [['application/run/main_scene', quote(mainScene)]];
  // no core module uses physics object picking: without it a mouse event creates no root 2D physics space
  const picking: [string, string] = ['physics/common/enable_object_picking', 'false'];
  return renderSettings([['application/config/name', quote('ogw-core')], ...main, picking, ...engineSettings()]);
}

/** `client/project.godot`: the harness tool settings with the content settings merged in. */
export function renderProjectGodot(values: ProjectValues, content: readonly CfgEntry[]): string {
  // the harness tool settings come last, so they win over a content setting of the same name
  return renderSettings([...content.map((entry): [string, string] => [settingName(entry), entry.value]), ...harnessSettings(values)]);
}
