import { describe, expect, it } from 'vitest';
import { inputEvents, intProperty, numberProperty, parseCfg, quote, settingName } from '../../../../src/commands/generate/lib/godot-cfg.ts';
import {
  bindingContext,
  checkContentSettings,
  CORE_ACTIONS,
  renderProjectGodot,
} from '../../../../src/commands/generate/lib/godot-project.ts';

const key = (code: number, field = 'keycode'): string =>
  `Object(InputEventKey,"device":-1,"${field}":${String(code)},"unicode":0,"script":null)`;
const button = (index: number): string => `Object(InputEventJoypadButton,"device":-1,"button_index":${String(index)},"pressure":0.0)`;
const mouse = (index: number): string => `Object(InputEventMouseButton,"device":-1,"button_index":${String(index)},"pressed":false)`;
const axis = (index: number, value: number): string => `Object(InputEventJoypadMotion,"device":-1,"axis":${String(index)},"axis_value":${value.toFixed(1)})`;
const action = (...events: string[]): string => `{\n"deadzone": 0.5,\n"events": [${events.join(', ')}]\n}`;

describe('parseCfg', () => {
  it('reads sections, keys and values over several lines', () => {
    const text = '; comment\nconfig_version=5\n\n[input]\n\njump={\n"deadzone": 0.5,\n"events": ["a\\"]"]\n}\n# note\n[rendering]\nx/y="s"\r\n';
    const entries = parseCfg(text, 'f.cfg');
    expect(entries).toEqual([
      { section: '', key: 'config_version', value: '5', line: 2 },
      { section: 'input', key: 'jump', value: '{\n"deadzone": 0.5,\n"events": ["a\\"]"]\n}', line: 6 },
      { section: 'rendering', key: 'x/y', value: '"s"', line: 12 },
    ]);
    expect(entries.map(settingName)).toEqual(['config_version', 'input/jump', 'rendering/x/y']);
  });

  it('fails on a line without = and on an unclosed value', () => {
    expect(() => parseCfg('[a]\njunk\n', 'f.cfg')).toThrow('f.cfg:2: not a key=value line');
    expect(() => parseCfg('=1\n', 'f.cfg')).toThrow('f.cfg:1: not a key=value line');
    expect(() => parseCfg('[a]\nx={\n"y": 1\n', 'f.cfg')).toThrow('f.cfg:2: value is not closed');
    expect(() => parseCfg('x="abc\n', 'f.cfg')).toThrow('f.cfg:1: value is not closed');
  });
});

describe('inputEvents', () => {
  it('splits Object(...) items and reads integer properties', () => {
    const events = inputEvents(action(key(65), button(2), 'Object(InputEventAction,"action":"a(b)")'));
    expect(events.map((e) => e.className)).toEqual(['InputEventKey', 'InputEventJoypadButton', 'InputEventAction']);
    expect(events[2]?.text).toBe('Object(InputEventAction,"action":"a(b)")');
    expect(intProperty(events[0]?.text ?? '', 'keycode')).toBe(65);
    expect(intProperty(events[0]?.text ?? '', 'physical_keycode')).toBe(0);
    expect(intProperty('"x": -3', 'x')).toBe(-3);
    expect(numberProperty('"axis_value":-0.5', 'axis_value')).toBe(-0.5);
    expect(numberProperty('"axis_value": 1', 'axis_value')).toBe(1);
    expect(numberProperty('"axis_value":1e-3', 'axis_value')).toBe(0.001);
    expect(numberProperty('"axis": 1', 'axis_value')).toBe(0);
    expect(inputEvents('{}')).toEqual([]);
  });

  it('quotes strings', () => {
    expect(quote('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
  });
});

describe('bindingContext', () => {
  it('names the InputCore binding context', () => {
    expect(bindingContext('back')).toBe('Ui');
    expect(bindingContext('menu_open')).toBe('Ui');
    expect(bindingContext('cutscene_skip')).toBe('Cutscene');
    expect(bindingContext('jump')).toBe('Gameplay');
    expect(bindingContext('backpack')).toBe('Gameplay');
  });
});

describe('checkContentSettings', () => {
  it('accepts allowed keys and returns the entries', () => {
    const text = `[input]\n\njump=${action(key(32))}\nmenu_open=${action(key(77))}\n[physics]\n\ncommon/physics_ticks_per_second=30\n2d/x=1\n3d/y=1\n[layer_names]\n2d_physics/layer_1="w"\n[rendering]\ntextures/canvas_textures/default_texture_filter=0\n2d/snap=true\nanti_aliasing/quality/msaa_2d=1\nlights_and_shadows/a=1\nenvironment/defaults/default_clear_color=Color(0, 0, 0, 1)\n`;
    expect(checkContentSettings(text, 'p.cfg').map((e) => settingName(e))).toEqual([
      'input/jump',
      'input/menu_open',
      'physics/common/physics_ticks_per_second',
      'physics/2d/x',
      'physics/3d/y',
      'layer_names/2d_physics/layer_1',
      'rendering/textures/canvas_textures/default_texture_filter',
      'rendering/2d/snap',
      'rendering/anti_aliasing/quality/msaa_2d',
      'rendering/lights_and_shadows/a',
      'rendering/environment/defaults/default_clear_color',
    ]);
  });

  it('lets a Gameplay action share the back key and the cutscene_advance key', () => {
    const text = `[input]\nescape_game=${action(key(4194305), button(1))}\nfire=${action(key(32), button(0))}\n`;
    expect(checkContentSettings(text, 'p.cfg')).toHaveLength(2);
  });

  it('reports every violation', () => {
    const text = [
      'config_version=5',
      '[application]',
      'config/name="x"',
      '[rendering]',
      'renderer/rendering_method="mobile"',
      '[input]',
      `back=${action(key(1))}`,
      `ui_accept=${action(key(2))}`,
      `touch=${action('Object(InputEventScreenTouch,"index":0)')}`,
      `menu_a=${action(key(4194305))}`,
      `cutscene_next=${action(button(0))}`,
      `run=${action(key(70))}`,
      `walk=${action(key(70, 'physical_keycode'))}`,
      `fly=${action(button(5))}`,
      `swim=${action(button(5))}`,
      `aim=${action(mouse(2))}`,
      `zoom=${action(mouse(2), key(90))}`,
      `left=${action(axis(0, -1))}`,
      `steer=${action(axis(0, -0.5))}`,
      `right=${action(axis(0, 1))}`,
      `idle=${action(axis(0, 0))}`,
      `menu_b=${action(mouse(1))}`,
    ].join('\n');
    let message = '';
    try {
      checkContentSettings(text, 'p.cfg');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.split('\n')).toEqual([
      'p.cfg:1: key config_version is not allowed',
      'p.cfg:3: key application/config/name is not allowed',
      'p.cfg:5: key rendering/renderer/rendering_method is not allowed',
      'p.cfg:7: core action back is set',
      'p.cfg:11: engine action ui_accept is set',
      'p.cfg:15: input event InputEventScreenTouch is not allowed in touch',
      'overlapping actions back and menu_a share a key',
      'overlapping actions cutscene_advance and cutscene_next share a gamepad button',
      'overlapping actions run and walk share a key',
      'overlapping actions fly and swim share a gamepad button',
      'overlapping actions aim and zoom share a mouse button',
      'overlapping actions left and steer share a gamepad axis direction',
    ]);
  });
});

describe('checkContentSettings with top-level input keys', () => {
  it('checks an input/ key written outside any section as an input action', () => {
    const text = [
      `input/ui_accept=${action(key(65))}`,
      `input/menu_close=${action(key(4194305))}`,
      `input/touch=${action('Object(InputEventScreenTouch,"index":0)')}`,
      `input/back=${action(key(1))}`,
    ].join('\n');
    let message = '';
    try {
      checkContentSettings(text, 'p.cfg');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.split('\n')).toEqual([
      'p.cfg:1: engine action ui_accept is set',
      'p.cfg:9: input event InputEventScreenTouch is not allowed in touch',
      'p.cfg:13: core action back is set',
      'overlapping actions back and menu_close share a key',
    ]);
  });
});

describe('renderProjectGodot', () => {
  it('writes the harness settings and merges the content settings in sorted sections', () => {
    const content = parseCfg(`[input]\njump=${action(key(32))}\n[physics]\ncommon/physics_ticks_per_second=30\n`, 'p.cfg');
    const text = renderProjectGodot(
      {
        appName: 'My "Game"',
        localizedNames: [
          ['ko', '게임'],
          ['zh_Hans', '游戏'],
        ],
        iconPath: 'res://resource/app_icon/main.png',
        splashPath: 'res://resource/splash/main.png',
        baseResolution: [1080, 1920],
      },
      content,
    );
    const back = [...CORE_ACTIONS.keys()];
    expect(back).toEqual(['back', 'cutscene_advance', 'cutscene_skip']);
    expect(text.startsWith('config_version=5\n\n[application]\n\n')).toBe(true);
    const lines = text.split('\n');
    expect(lines).toContain('config/name="My \\"Game\\""');
    expect(text).toContain('config/name_localized={\n"ko": "게임",\n"zh_Hans": "游戏"\n}');
    expect(lines).toContain('config/icon="res://resource/app_icon/main.png"');
    expect(lines).toContain('boot_splash/image="res://resource/splash/main.png"');
    expect(lines).toContain('run/main_scene="res://boot/boot.tscn"');
    expect(lines).toContain('window/handheld/orientation=5');
    expect(lines).toContain('window/size/viewport_width=1080');
    expect(lines).toContain('window/size/viewport_height=1920');
    expect(lines).toContain('renderer/rendering_method="forward_plus"');
    expect(lines).toContain('renderer/rendering_method.mobile="mobile"');
    expect(lines).toContain('renderer/rendering_method.web="gl_compatibility"');
    expect(lines).toContain('rendering_device/fallback_to_opengl3=true');
    expect(lines).toContain('textures/vram_compression/import_s3tc_bptc=true');
    expect(lines).toContain('textures/vram_compression/import_etc2_astc=true');
    expect(lines).toContain('export/convert_text_resources_to_binary=false');
    expect(lines).toContain('import/use_multiple_threads=false');
    for (const w of ['untyped_declaration', 'inference_on_variant', 'unsafe_property_access', 'unsafe_method_access', 'unsafe_cast', 'unsafe_call_argument']) {
      expect(lines).toContain(`gdscript/warnings/${w}=2`);
    }
    expect(lines).toContain('common/physics_ticks_per_second=30');
    expect(text).not.toContain('[autoload]');
    const sections = lines.filter((l) => l.startsWith('['));
    expect(sections).toEqual(['[application]', '[audio]', '[debug]', '[display]', '[editor]', '[input]', '[physics]', '[rendering]']);
    const input = text.slice(text.indexOf('[input]'), text.indexOf('[physics]'));
    expect(input.indexOf('back=')).toBeLessThan(input.indexOf('cutscene_advance='));
    expect(input.indexOf('cutscene_skip=')).toBeLessThan(input.indexOf('jump='));
    const events = (name: string): string[] => {
      const entry = parseCfg(input, 'x').find((e) => e.key === name);
      return inputEvents(entry?.value ?? '').map((e) => `${e.className}:${String(intProperty(e.text, 'keycode') || intProperty(e.text, 'button_index'))}`);
    };
    expect(events('back')).toEqual(['InputEventKey:4194305', 'InputEventJoypadButton:1']);
    expect(events('cutscene_advance')).toEqual(['InputEventKey:32', 'InputEventKey:4194309', 'InputEventJoypadButton:0']);
    expect(events('cutscene_skip')).toEqual(['InputEventKey:4194306', 'InputEventJoypadButton:6']);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('sets landscape orientation and an empty localized name list', () => {
    const text = renderProjectGodot(
      { appName: '', localizedNames: [], iconPath: 'i', splashPath: 's', baseResolution: [1920, 1080] },
      [],
    );
    expect(text.split('\n')).toContain('window/handheld/orientation=4');
    expect(text).toContain('config/name_localized={}');
  });
});
