import { describe, expect, it } from 'vitest';
import { toneWav, variantFrequency } from '../../../../src/commands/resource/lib/audio.ts';
import { formatCsv, parseCsv, parseTable } from '../../../../src/commands/resource/lib/csv.ts';
import { classProblem, engineType, godotFloat, rigSceneNames, tresClass, tscnRootType } from '../../../../src/commands/resource/lib/godot.ts';
import { listSha, parseKey, sha256Hex } from '../../../../src/commands/resource/lib/list.ts';
import { requestFileKeys, requestFileText } from '../../../../src/commands/resource/lib/request.ts';
import { parseSpec, specProblems } from '../../../../src/commands/resource/lib/spec.ts';

describe('csv', () => {
  it('reads quoted cells, doubled quotes, CRLF, a BOM and a last row without a line break', () => {
    expect(parseCsv('﻿a,"b,c","d""e"\r\n"x\ny",,z', 'f')).toEqual([['a', 'b,c', 'd"e'], ['x\ny', '', 'z']]);
    expect(parseCsv('a\n\nb\n', 'f')).toEqual([['a'], [''], ['b']]);
    expect(parseCsv('', 'f')).toEqual([]);
  });

  it('rejects broken quotes', () => {
    expect(() => parseCsv('"a', 'f.csv')).toThrow('f.csv:1: unclosed quote');
    expect(() => parseCsv('a\na"b', 'f.csv')).toThrow('f.csv:2: quote inside an unquoted cell');
    // text after a closing quote was read into the cell before the CSV parsers were one
    expect(() => parseCsv('"a"b\n', 'f.csv')).toThrow('f.csv:1: text after a quoted field');
  });

  it('writes cells that need quotes and reads them back', () => {
    const rows = [['a', 'b,c', 'd"e', 'x\ny', '']];
    const text = formatCsv(rows);
    expect(text).toBe('a,"b,c","d""e","x\ny",\n');
    expect(parseCsv(text, 'f')).toEqual(rows);
  });

  it('reads records by the last header row and checks the cell count', () => {
    const table = parseTable('d1,d2\nid,v\n[a],1\n[b],2\n', 't', 2);
    expect(table).toEqual({ header: ['id', 'v'], records: [{ id: '[a]', v: '1' }, { id: '[b]', v: '2' }], lines: [3, 4] });
    expect(() => parseTable('a,b\n1\n', 't.csv')).toThrow('t.csv:2: 1 cells, header has 2');
    expect(() => parseTable('a\n', 't.csv', 2)).toThrow('t.csv: missing header');
  });
});

describe('spec', () => {
  it('parses every item with its value', () => {
    expect(parseSpec('k', 'nine_slice', 'size=10x20;alpha=true;slice=1,2,3,0')).toMatchObject({ size: [10, 20], alpha: true, slice: [1, 2, 3, 0] });
    expect(parseSpec('k', 'sfx', 'length=300;loop=true;variants=4')).toMatchObject({ lengthMs: 300, loop: true, variants: 4 });
    expect(parseSpec('k', 'model', 'bounds=1.5x2x0.25')).toMatchObject({ bounds: [1.5, 2, 0.25] });
    expect(parseSpec('k', 'sfx', 'length=300;level=quiet').level).toBe('quiet');
    expect(parseSpec('k', 'sfx', 'length=300;level=loud').level).toBe('loud');
    expect(parseSpec('k', 'particle', 'space=3D;loop=false')).toMatchObject({ space: '3D', loop: false });
    expect(parseSpec('k', 'sprite_animation', 'size=8x8;animations=idle:800:loop,hit_back:50:once').animations).toEqual([
      { name: 'idle', lengthMs: 800, loop: true },
      { name: 'hit_back', lengthMs: 50, loop: false },
    ]);
    expect(parseSpec('k', 'material', '')).toEqual({ size: null, alpha: false, slice: null, lengthMs: null, loop: false, animations: null, variants: 1, level: 'normal', bounds: null, space: null });
  });

  it.each([
    ['icon', 'size=0x4', 'invalid size value 0x4'],
    ['icon', 'size=4x4;alpha=yes', 'invalid alpha value yes'],
    ['nine_slice', 'size=4x4;slice=1,2,3', 'invalid slice value 1,2,3'],
    ['nine_slice', 'size=4x4;slice=1,2,3,-1', 'invalid slice value 1,2,3,-1'],
    ['sfx', 'length=0', 'invalid length value 0'],
    ['sfx', 'length=10;loop=1', 'invalid loop value 1'],
    ['sfx', 'length=10;variants=0', 'invalid variants value 0'],
    ['sfx', 'length=10;level=high', 'invalid level value high'],
    ['bgm', 'length=10;level=quiet', 'item level is not for type bgm'],
    ['model', 'bounds=1x2', 'invalid bounds value 1x2'],
    ['model', 'bounds=1x0x2', 'invalid bounds value 1x0x2'],
    ['shader', 'space=4D', 'invalid space value 4D'],
    ['sprite_animation', 'size=4x4;animations=idle:800', 'invalid animations value idle:800'],
    ['sprite_animation', 'size=4x4;animations=idle:800:loop:x', 'invalid animations value'],
    ['sprite_animation', 'size=4x4;animations=Idle:800:loop', 'invalid animations value'],
    ['sprite_animation', 'size=4x4;animations=idle:0:loop', 'invalid animations value'],
    ['sprite_animation', 'size=4x4;animations=idle:8:twice', 'invalid animations value'],
    ['sprite_animation', 'size=4x4;animations=a:8:loop,a:9:once', 'invalid animations value'],
    ['rig', 'size', 'unknown item size'],
    ['texture', 'size=4x4;loop=true', 'item loop is not for type texture'],
    ['model', '', 'missing item bounds'],
  ])('rejects %s spec %s', (type, cell, message) => {
    expect(specProblems(type, cell).join('; ')).toContain(message);
    expect(() => parseSpec('k', type, cell)).toThrow(message);
  });
});

describe('godot', () => {
  it('reads the class of .tres and the root node of .tscn', () => {
    expect(tresClass('[gd_resource type="Resource" script_class="TweenDefinition" load_steps=2 format=3]')).toBe('TweenDefinition');
    expect(tresClass('x\n[gd_resource type="Animation" format=3]')).toBe('Animation');
    expect(tresClass('[gd_scene format=3]')).toBeNull();
    expect(tscnRootType('[gd_scene]\n[node name="a" type="Node2D"]\n[node name="b" type="Sprite2D" parent="."]')).toBe('Node2D');
    expect(tscnRootType('[node name="a" parent="."]')).toBeNull();
  });

  it('checks classes by the table', () => {
    const spec = parseSpec('k', 'particle', 'space=2D');
    expect(classProblem(engineType('godot', 'particle'), spec, '.tscn', '[node name="a" type="GPUParticles2D"]')).toBeNull();
    expect(classProblem(engineType('godot', 'particle'), spec, '.tscn', '[node name="a"]')).toBe('root node none is not GPUParticles2D');
    expect(classProblem(engineType('godot', 'scene'), spec, '.tscn', '[node name="a" type="Control"]')).toBeNull();
    expect(classProblem(engineType('godot', 'rig_animation_2d'), spec, '.tscn', '[node name="a" type="Node3D"]')).toBe('root node Node3D is not Node2D');
    expect(classProblem(engineType('godot', 'sprite_animation'), spec, '.tres', '[gd_resource type="SpriteFrames"]')).toBeNull();
    expect(classProblem(engineType('godot', 'material'), spec, '.tres', '[gd_resource type="ORMMaterial3D"]')).toBeNull();
    expect(classProblem(engineType('godot', 'image'), spec, '.png', 'anything')).toBeNull();
    expect(() => engineType('godot', 'nothing')).toThrow('not defined: resource type nothing');
    expect(engineType('godot', 'font').extensions).toEqual(['.ttf', '.otf']);
  });

  it('writes floats and reads rig scene names', () => {
    expect([godotFloat(1), godotFloat(0.25), godotFloat(0)]).toEqual(['1.0', '0.25', '0.0']);
    const names = rigSceneNames('[node name="r" type="Node2D"]\n[node name="b" type="Bone2D" parent="."]\n[node name="p" type="Polygon2D" parent="."]\n[node name="s" type="Sprite2D" parent="b"]\n_data = {\n"idle": SubResource("A"),\n&"run": SubResource("B")\n}\n');
    expect(names).toEqual({ bones: ['b'], parts: ['p', 's'], animations: ['idle', 'run'] });
  });
});

describe('list', () => {
  it('parses resource keys', () => {
    expect(parseKey('prefab/enemy/slime_king')).toEqual({ type: 'prefab', name: 'enemy/slime_king', last: 'slime_king' });
    expect(parseKey('icon')).toBeNull();
    expect(parseKey('icon/Fire')).toBeNull();
    expect(parseKey('icon/a//b')).toBeNull();
    expect(parseKey('weapon/a')).toBeNull();
  });

  it('hashes one file, or the joined hex digests of variant files', () => {
    const a = Buffer.from('a');
    const b = Buffer.from('b');
    expect(listSha([a])).toBe(sha256Hex(a));
    expect(listSha([a, b])).toBe(sha256Hex(sha256Hex(a) + sha256Hex(b)));
  });
});

describe('request file', () => {
  it('writes the three sections and reads the keys back', () => {
    const text = requestFileText(['icon/a', 'icon/b'], [], 'icon/c');
    expect(text).toBe('## keys\n\nicon/a\nicon/b\n\n## see\n\nnone\n\n## base\n\nicon/c\n');
    expect(requestFileKeys(text)).toEqual(['icon/a', 'icon/b']);
    expect(requestFileKeys('## keys\r\n\r\nnone\r\n## see\r\nicon/x\r\n')).toEqual([]);
  });
});

describe('audio', () => {
  it('writes a 16-bit mono PCM WAV of the length with faded ends', () => {
    const wav = toneWav(10, 440);
    expect(wav.length).toBe(44 + 480 * 2);
    expect([wav.toString('ascii', 0, 4), wav.toString('ascii', 8, 12), wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt16LE(34)]).toEqual(['RIFF', 'WAVE', 1, 1, 16]);
    expect(wav.readUInt32LE(4)).toBe(36 + 960);
    expect(wav.readInt16LE(44)).toBe(0);
    expect(Math.max(...Array.from({ length: 480 }, (_, i) => Math.abs(wav.readInt16LE(44 + i * 2))))).toBeLessThanOrEqual(Math.round(0.3 * 32767));
    expect([variantFrequency(1), variantFrequency(3)]).toEqual([440, 660]);
  });
});
