import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  gameLicenses,
  godotExtension,
  godotResourceKeys,
  resourceKeyConstant,
  resourceKeyGd,
  resourceKeyPaths,
  resourceKeyTs,
  readResourceRows,
  variantCount,
} from '../../../../src/commands/generate/lib/resources.ts';
import { write } from '../helpers.ts';

const HEADER = 'key,description,spec,status,method,source,license,attribution,sha256,text_key,speaker,text_hash';

describe('readResourceRows', () => {
  it('reads key, spec, license, source and attribution; none without a file', () => {
    const text = `${HEADER}\nicon/a,d,size=1x1,final,m,https://s,CC-BY-4.0,"Ann, Bob",x,,,\n`;
    expect(readResourceRows(text, 'r.csv')).toEqual([
      { key: 'icon/a', spec: 'size=1x1', license: 'CC-BY-4.0', source: 'https://s', attribution: 'Ann, Bob' },
    ]);
    expect(readResourceRows(null, 'r.csv')).toEqual([]);
    expect(readResourceRows('key\nicon/b\n', 'r.csv')).toEqual([{ key: 'icon/b', spec: '', license: '', source: '', attribution: '' }]);
  });
});

describe('variantCount', () => {
  it('reads variants or 1', () => {
    expect(variantCount('length=800;variants=3')).toBe(3);
    expect(variantCount('length=800')).toBe(1);
    expect(variantCount('')).toBe(1);
    expect(() => variantCount('variants=0')).toThrow('invalid variants in spec: variants=0');
    expect(() => variantCount('variants=x')).toThrow('invalid variants');
    expect(() => variantCount('variants=1.5')).toThrow('invalid variants');
  });
});

describe('godotExtension', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ogw-res-'));
  write(join(dir, 'font', 'a.otf'), 'x');
  write(join(dir, 'font', 'b.ttf'), 'x');
  write(join(dir, 'font', 'c.ttf'), 'x');
  write(join(dir, 'font', 'c.otf'), 'x');

  it('maps every resource type to its extension', () => {
    const expected: Record<string, string> = {
      image: '.png', sprite_sheet: '.png', texture_atlas: '.png', icon: '.png', background: '.png', nine_slice: '.png',
      texture: '.png', skybox: '.png', tileset: '.png', app_icon: '.png', splash: '.png', model: '.glb', rig: '.glb',
      material: '.tres', sprite_animation: '.tres', rig_animation_2d: '.tscn', animation_3d: '.tres', tween: '.tres',
      particle: '.tscn', shader: '.gdshader', sfx: '.wav', voice: '.wav', bgm: '.ogg', haptic: '.json', scene: '.tscn', prefab: '.tscn',
    };
    for (const [type, ext] of Object.entries(expected)) expect(godotExtension(`${type}/x`, dir)).toBe(ext);
  });

  it('looks at the file for fonts and fails on unknown types', () => {
    expect(godotExtension('font/a', dir)).toBe('.otf');
    expect(godotExtension('font/b', dir)).toBe('.ttf');
    expect(godotExtension('font/c', dir)).toBe('.ttf');
    expect(() => godotExtension('font/none', dir)).toThrow('no .ttf or .otf file for resource key font/none');
    expect(() => godotExtension('movie/x', dir)).toThrow('unknown resource type in key movie/x');
    expect(() => godotExtension('toString/x', dir)).toThrow('unknown resource type in key toString/x');
  });

  it('builds the resource key list', () => {
    const rows = [
      { key: 'scene/lobby/main', spec: '', license: '', source: '', attribution: '' },
      { key: 'font/a', spec: '', license: '', source: '', attribution: '' },
      { key: 'sfx/hit', spec: 'length=100;variants=3', license: '', source: '', attribution: '' },
    ];
    const list = godotResourceKeys(rows, dir);
    expect(list).toEqual({
      'scene/lobby/main': { path: 'res://resource/scene/lobby/main.tscn', variants: 1 },
      'font/a': { path: 'res://resource/font/a.otf', variants: 1 },
      'sfx/hit': { path: 'res://resource/sfx/hit.wav', variants: 3 },
    });
    expect(Object.keys(list)).toEqual(['scene/lobby/main', 'font/a', 'sfx/hit']);
  });

  it('lists the variant files of a key list value', () => {
    expect(resourceKeyPaths({ path: 'res://resource/sfx/hit.wav', variants: 1 })).toEqual(['res://resource/sfx/hit.wav']);
    expect(resourceKeyPaths({ path: 'res://resource/sfx/hit.wav', variants: 3 })).toEqual([
      'res://resource/sfx/hit.1.wav',
      'res://resource/sfx/hit.2.wav',
      'res://resource/sfx/hit.3.wav',
    ]);
    expect(resourceKeyPaths({ path: 'res://resource/sfx/a.b/hit.wav', variants: 2 })).toEqual([
      'res://resource/sfx/a.b/hit.1.wav',
      'res://resource/sfx/a.b/hit.2.wav',
    ]);
  });
});

describe('resource key constants', () => {
  it('names a constant by the upper-case key with / as __', () => {
    expect(resourceKeyConstant('prefab/enemy/slime')).toBe('PREFAB__ENEMY__SLIME');
    expect(resourceKeyConstant('icon/skill_fireball')).toBe('ICON__SKILL_FIREBALL');
  });

  it('writes the GDScript class and the TypeScript module in key byte order', () => {
    const keys = ['scene/lobby/main', 'icon/sword'];
    expect(resourceKeyGd(keys)).toBe(
      'class_name ResourceKey\nextends RefCounted\n\nconst ICON__SWORD: String = "icon/sword"\nconst SCENE__LOBBY__MAIN: String = "scene/lobby/main"\n',
    );
    expect(resourceKeyTs(keys)).toBe(
      'export const ICON__SWORD: string = "icon/sword";\nexport const SCENE__LOBBY__MAIN: string = "scene/lobby/main";\n',
    );
  });

  it('writes empty files without keys and fails on two keys with one constant name', () => {
    expect(resourceKeyGd([])).toBe('class_name ResourceKey\nextends RefCounted\n');
    expect(resourceKeyTs([])).toBe('export {};\n');
    expect(() => resourceKeyGd(['icon/a__b', 'icon/a/b'])).toThrow('resource keys icon/a/b and icon/a__b have the same constant name ICON__A__B');
  });
});

describe('gameLicenses', () => {
  const release = {
    components: [
      { name: 'Godot', version: '4', license: 'MIT', url: 'u', notice: 'n', platforms: ['android'], modules: [] },
      { name: 'rtc', version: '1', license: 'MIT', url: 'u', notice: '', platforms: ['macos'], modules: ['RealtimeCore'] },
      { name: 'net', version: '2', license: 'BSD', url: 'u', notice: '', platforms: ['ios'], modules: ['X', 'NetworkCore'] },
    ],
    texts: { MIT: 'mit', BSD: 'bsd' },
  };
  const row = (key: string, attribution: string, license = 'CC-BY-4.0', source = 's1') => ({ key, spec: '', license, source, attribution });

  it('keeps engine and used-module components, then groups attributed resources by name', () => {
    const rows = [
      row('icon/z', 'Ann'),
      row('icon/a', 'Ann'),
      row('bgm/x', ''),
      row('sfx/b', 'Ann', 'CC0-1.0'),
      row('icon/m', 'Ann', 'CC-BY-4.0', 's2'),
      row('bgm/c', 'Bob'),
    ];
    const manifest = gameLicenses(release, 'l.json', new Set(['NetworkCore']), rows, ['android', 'ios']);
    expect(manifest.texts).toEqual({ MIT: 'mit', BSD: 'bsd' });
    expect(manifest.components.map((c) => c.name)).toEqual(['Godot', 'net', 'bgm/c', 'icon/a, icon/z', 'icon/m', 'sfx/b']);
    expect(manifest.components[3]).toEqual({
      name: 'icon/a, icon/z',
      version: '',
      license: 'CC-BY-4.0',
      url: 's1',
      notice: 'Ann',
      platforms: ['android', 'ios'],
      modules: [],
    });
  });

  it('rejects a bad release manifest', () => {
    expect(() => gameLicenses(null, 'l.json', new Set(), [], [])).toThrow('invalid license manifest: l.json');
    expect(() => gameLicenses({ components: {}, texts: {} }, 'l.json', new Set(), [], [])).toThrow('invalid license manifest');
    expect(() => gameLicenses({ components: [], texts: [] }, 'l.json', new Set(), [], [])).toThrow('invalid license manifest');
  });
});
