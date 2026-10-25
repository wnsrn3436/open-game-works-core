import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sceneNodes } from '../../../src/commands/resource/lib/godot.ts';
import { GLYPHS, keyColor } from '../../../src/commands/resource/lib/image.ts';
import { ogw } from '../../helpers/workspace.ts';
import { GAME_SETTINGS, listCsv, makeFixture, pixels, readList, rowOf, translationCsv, type Fixture } from './fixture.ts';

const tools = vi.hoisted(() => ({ ffmpeg: null as string | null, placeholderFont: null as string | null }));
vi.mock('../../../src/commands/env/api.ts', () => ({
  toolProgram: vi.fn((_ctx: unknown, tool: 'ffmpeg' | 'placeholderFont') => Promise.resolve(tools[tool])),
}));

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

function setup(files: Record<string, string | object>): Fixture {
  const f = makeFixture(files);
  tools.ffmpeg = f.ffmpeg;
  tools.placeholderFont = f.font;
  return f;
}

function file(f: Fixture, path: string): Buffer {
  return readFileSync(join(f.game, path));
}

/** Body of each `[sub_resource]` of a Godot text file by its id. */
function subResources(text: string): Map<string, { type: string; body: string }> {
  const result = new Map<string, { type: string; body: string }>();
  const sections = text.split(/^(?=\[)/m);
  for (const section of sections) {
    const header = /^\[sub_resource type="(\w+)" id="(\w+)"\]\n/.exec(section);
    if (header) result.set(header[2] as string, { type: header[1] as string, body: section.slice(header[0].length) });
  }
  return result;
}

/** The `rig_animation_2d` placeholder of `hero` with `size=40x80;animations=idle:800:loop` (`client-core` `engines/godot.md`). */
function expectRigPlaceholder(rigScene: string): void {
    expect(sceneNodes(rigScene)).toEqual([
      { name: 'hero', type: 'Node2D', parent: null },
      { name: 'Skeleton2D', type: 'Skeleton2D', parent: '.' },
      { name: 'root', type: 'Bone2D', parent: 'Skeleton2D' },
      { name: 'body', type: 'Polygon2D', parent: 'Skeleton2D/root' },
      { name: 'AnimationPlayer', type: 'AnimationPlayer', parent: '.' },
    ]);
    expect(rigScene).toContain('polygon = PackedVector2Array(-20.0, -40.0, 20.0, -40.0, 20.0, 40.0, -20.0, 40.0)');
    // the AnimationPlayer's library holds the spec animations
    const libraryId = /\[node name="AnimationPlayer"[^\]]*\]\nlibraries = \{\n&"": SubResource\("(\w+)"\)\n\}/.exec(rigScene)?.[1] ?? '';
    const subs = subResources(rigScene);
    const library = subs.get(libraryId);
    expect(library?.type).toBe('AnimationLibrary');
    const animationIds = [...(library?.body ?? '').matchAll(/&"(\w+)": SubResource\("(\w+)"\)/g)].map((m) => [m[1], m[2]] as const);
    expect(animationIds.map(([name]) => name)).toEqual(['idle']);
    const idle = subs.get(animationIds[0]?.[1] ?? '');
    expect(idle?.type).toBe('Animation');
    expect(idle?.body).toBe('resource_name = "idle"\nlength = 0.8\nloop_mode = 1\n\n');
}

const ALL_TYPES = [
  { key: 'icon/skill_fireball', spec: 'size=64x32;alpha=true', status: 'placeholder' },
  { key: 'sfx/hit', spec: 'length=200;variants=3', status: 'placeholder' },
  { key: 'sfx/click', spec: 'length=100', status: 'placeholder' },
  { key: 'bgm/battle', spec: 'length=1000;loop=true', status: 'placeholder' },
  { key: 'model/crate', spec: 'bounds=1x2.5x0.5', status: 'placeholder' },
  { key: 'rig/hero', spec: '', status: 'placeholder' },
  { key: 'material/stone', spec: '', status: 'placeholder' },
  { key: 'haptic/hit', spec: 'length=120', status: 'placeholder' },
  { key: 'font/main', spec: '', status: 'placeholder' },
  { key: 'sprite_animation/coin', spec: 'size=4x2;animations=spin:500:loop,pop:250:once', status: 'placeholder' },
  { key: 'rig_animation_2d/hero', spec: 'size=40x80;animations=idle:800:loop', status: 'placeholder' },
  { key: 'animation_3d/wave', spec: 'length=1500', status: 'placeholder' },
  { key: 'particle/spark', spec: 'space=2D', status: 'placeholder' },
  { key: 'particle/smoke', spec: 'space=3D;loop=true', status: 'placeholder' },
  { key: 'shader/glow', spec: 'space=3D', status: 'placeholder' },
  { key: 'scene/battle/main', spec: '', status: 'final' },
];

describe('ogw resource placeholder and sync', () => {
  beforeEach(() => {
    tools.ffmpeg = null;
    tools.placeholderFont = null;
  });

  it('makes the placeholder resource of every type, adds platform rows, and writes sha256', async () => {
    const f = setup({
      'resource/resources.csv': listCsv(ALL_TYPES),
      'resource/scene/battle/main.tscn': '[gd_scene format=3]\n\n[node name="main" type="Control"]\n',
    });
    const run = await ogw(f.ws, ['resource', 'placeholder', 'g']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const icon = await pixels(join(f.game, 'resource/icon/skill_fireball.png'));
    expect([icon.width, icon.height]).toEqual([64, 32]);
    expect(rowOf(f.game, 'icon/skill_fireball').sha256).toBe(sha(file(f, 'resource/icon/skill_fireball.png')));
    const hits = [1, 2, 3].map((n) => file(f, `resource/sfx/hit.${String(n)}.wav`));
    expect(hits[0]?.subarray(0, 4).toString()).toBe('RIFF');
    expect(hits[0]?.readUInt32LE(40)).toBe(Math.round(0.2 * 48000) * 2);
    expect(hits[0]?.equals(hits[1] as Buffer)).toBe(true);
    expect(existsSync(join(f.game, 'resource/sfx/hit.wav'))).toBe(false);
    expect(rowOf(f.game, 'sfx/hit').sha256).toBe(sha(hits.map((h) => sha(h)).join('')));
    expect(file(f, 'resource/sfx/click.wav').readUInt32LE(24)).toBe(48000);
    expect(file(f, 'resource/bgm/battle.ogg').toString()).toBe('OggS-fake');
    expect(readFileSync(f.ffmpegLog, 'utf8')).toContain('-c:a libvorbis');
    expect(file(f, 'resource/model/crate.glb').subarray(0, 4).toString()).toBe('glTF');
    expect(file(f, 'resource/model/crate.glb').toString()).toContain('"max":[0.5,2.5,0.25]');
    expect(file(f, 'resource/rig/hero.glb').toString()).toContain('"skins":[{"joints":[1]');
    expect(file(f, 'resource/material/stone.tres').toString()).toBe('[gd_resource type="StandardMaterial3D" format=3]\n\n[resource]\n');
    expect(JSON.parse(file(f, 'resource/haptic/hit.json').toString())).toEqual({ segments: [{ delay_ms: 0, duration_ms: 120, intensity: 1000 }] });
    expect(file(f, 'resource/font/main.ttf').toString()).toBe('FAKE-TTF');
    const frames = file(f, 'resource/sprite_animation/coin.tres').toString();
    expect(frames).toMatch(/^\[gd_resource type="SpriteFrames" format=3\]/);
    expect(frames).toContain('"name": &"spin",\n"speed": 2.0');
    expect(frames).toContain('"loop": false,\n"name": &"pop",\n"speed": 4.0');
    expect(frames).toContain('"height": 2,');
    expect(frames).toContain('"width": 4\n');
    const frameBytes = /"data": PackedByteArray\(([^)]*)\)/.exec(frames)?.[1]?.split(',') ?? [];
    expect(frameBytes).toHaveLength(4 * 2 * 4);
    expect([...frames.matchAll(/"loop": (true|false),\n"name": &"(\w+)"/g)].map((m) => [m[2], m[1]])).toEqual([['spin', 'true'], ['pop', 'false']]);
    expectRigPlaceholder(file(f, 'resource/rig_animation_2d/hero.tscn').toString());
    // Godot's text resource parser needs 4 components in every Color(...).
    const godotTexts = ['sprite_animation/coin.tres', 'rig_animation_2d/hero.tscn', 'animation_3d/wave.tres', 'material/stone.tres', 'particle/spark.tscn', 'particle/smoke.tscn'];
    const colors = godotTexts.flatMap((p) => [...file(f, `resource/${p}`).toString().matchAll(/Color\(([^)]*)\)/g)].map((m) => (m[1] as string).split(',').length));
    expect(colors.length).toBeGreaterThan(0);
    expect(colors.every((n) => n === 4)).toBe(true);
    expect(file(f, 'resource/animation_3d/wave.tres').toString()).toContain('length = 1.5\n');
    expect(file(f, 'resource/particle/spark.tscn').toString()).toContain('type="GPUParticles2D"]\nemitting = false');
    expect(file(f, 'resource/particle/smoke.tscn').toString()).toContain('type="GPUParticles3D"');
    expect(file(f, 'resource/shader/glow.gdshader').toString()).toBe('shader_type spatial;\n');
    const app = rowOf(f.game, 'app_icon/main');
    expect([app.spec, app.status]).toEqual(['size=1024x1024', 'placeholder']);
    expect(rowOf(f.game, 'splash/main').spec).toBe('size=1280x720');
    const splash = await pixels(join(f.game, 'resource/splash/main.png'));
    expect([splash.width, splash.height]).toEqual([1280, 720]);
    expect(rowOf(f.game, 'scene/battle/main').sha256).toBe(sha(file(f, 'resource/scene/battle/main.tscn')));
    expect(readList(f.game).every((r) => r.sha256?.length === 64)).toBe(true);
    expect(run.stdout).toContain('changed resource/resources.csv');

    const again = await ogw(f.ws, ['resource', 'sync', 'g', '--json']);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toEqual({ files: [], rows: [] });
    expect((await ogw(f.ws, ['resource', 'sync', 'g'])).stdout).toBe('no change\n');
  });

  it('keeps the platform row spec at the defined values', async () => {
    const f = setup({
      'resource/resources.csv': listCsv([
        { key: 'app_icon/main', spec: 'size=512x512', status: 'placeholder' },
        { key: 'splash/main', spec: 'size=1280x720', status: 'placeholder' },
      ]),
      'settings.json': { ...GAME_SETTINGS, baseResolution: [108, 192] },
    });
    expect((await ogw(f.ws, ['resource', 'placeholder', 'g'])).code).toBe(0);
    expect(rowOf(f.game, 'app_icon/main').spec).toBe('size=1024x1024');
    expect(rowOf(f.game, 'splash/main').spec).toBe('size=108x192');
    const splash = await pixels(join(f.game, 'resource/splash/main.png'));
    expect([splash.width, splash.height]).toEqual([108, 192]);
    const app = await pixels(join(f.game, 'resource/app_icon/main.png'));
    expect([app.width, app.height]).toEqual([1024, 1024]);
  });

  it('draws the last word of the key on a single-color image placeholder', async () => {
    const key = 'icon/ab_9';
    const f = setup({ 'resource/resources.csv': listCsv([{ key, spec: 'size=48x24;alpha=true', status: 'placeholder' }]) });
    expect((await ogw(f.ws, ['resource', 'placeholder', 'g'])).code).toBe(0);
    const image = await pixels(join(f.game, 'resource/icon/ab_9.png'));
    const background = keyColor(key);
    const luminance = 0.299 * background[0] + 0.587 * background[1] + 0.114 * background[2];
    const ink = luminance > 128 ? [0, 0, 0] : [255, 255, 255];
    // Expected text: 5x7 glyphs of "ab_9", 1 px apart, at scale floor(min(48 * 0.9 / 23, 24 * 0.5 / 7)) = 1, centered.
    const text = 'ab_9';
    const mask = new Set<number>();
    const left = Math.floor((48 - 23) / 2);
    const top = Math.floor((24 - 7) / 2);
    Array.from({ length: text.length }, (_, index) => text.charAt(index)).forEach((ch, index) => {
      const glyph = GLYPHS[ch] as string;
      for (let bit = 0; bit < 35; bit++) if (glyph[bit] === '1') mask.add((top + Math.floor(bit / 5)) * 48 + left + index * 6 + (bit % 5));
    });
    expect(mask.size).toBeGreaterThan(20);
    for (let p = 0; p < 48 * 24; p++) {
      const got = [...image.data.subarray(p * 4, p * 4 + 4)];
      expect(got).toEqual([...(mask.has(p) ? ink : background), 255]);
    }
  });

  it('writes line voice cells and reverts final text voices whose text changed', async () => {
    const cutscene = ['desc,,,', 'All,Client,Client,Client', 'id,int,ref<cutscene_speaker.id>?,reskey?', 'id,step,speaker,voice', '[intro],1,[hero],voice/intro_1', '[intro],2,null,voice/intro_2', '[intro],3,[hero],null', '#[old],1,[hero],voice/old'].join('\n');
    const f = setup({
      'data/tables/cutscene_step.csv': `${cutscene}\n`,
      'data/translations/en.csv': translationCsv([
        ['cutscene_step.text.[intro].1', 'Hello', 'h1new'],
        ['cutscene_step.text.[intro].2', 'Bye', 'h2'],
        ['ui.tip', 'Tip', 'h3'],
      ]),
      'resource/voice/intro_1.wav': 'FINAL-1',
      'resource/voice/intro_2.wav': 'FINAL-2',
      'resource/voice/old.wav': 'FINAL-OLD',
      'resource/voice/tip.wav': 'FINAL-TIP',
      'resource/resources.csv': listCsv([
        { key: 'voice/intro_1', spec: 'length=500', status: 'final', method: 'qwen3-tts', license: 'Apache-2.0', attribution: 'x', text_hash: 'h1old' },
        { key: 'voice/intro_2', spec: 'length=500', status: 'final', method: 'qwen3-tts', license: 'Apache-2.0', text_hash: 'h2' },
        { key: 'voice/old', spec: 'length=500', status: 'final', method: 'qwen3-tts' },
        { key: 'voice/tip', spec: 'length=500', status: 'final', method: 'qwen3-tts', text_key: 'ui.tip', speaker: 'guide', text_hash: 'h3' },
      ]),
    });
    const run = await ogw(f.ws, ['resource', 'sync', 'g']);
    expect(run.stderr).toBe('');
    const one = rowOf(f.game, 'voice/intro_1');
    expect(one).toMatchObject({ text_key: 'cutscene_step.text.[intro].1', speaker: 'hero', status: 'placeholder', method: '', license: '', attribution: '', text_hash: '' });
    expect(file(f, 'resource/voice/intro_1.wav').subarray(0, 4).toString()).toBe('RIFF');
    expect(one.sha256).toBe(sha(file(f, 'resource/voice/intro_1.wav')));
    expect(rowOf(f.game, 'voice/intro_2')).toMatchObject({ text_key: 'cutscene_step.text.[intro].2', speaker: 'none', status: 'final', text_hash: 'h2' });
    expect(file(f, 'resource/voice/intro_2.wav').toString()).toBe('FINAL-2');
    expect(rowOf(f.game, 'voice/old')).toMatchObject({ text_key: '', speaker: '', status: 'final' });
    expect(rowOf(f.game, 'voice/tip')).toMatchObject({ status: 'final', speaker: 'guide' });
    expect(run.stdout).toContain('voice/intro_1 status=placeholder method= license= attribution= sha256=');
  });

  it('makes the placeholder of a requested row from its spec, with or without a file', async () => {
    const f = setup({
      'resource/icon/a.png': 'OLD',
      'resource/resources.csv': listCsv([
        { key: 'icon/a', spec: 'size=8x8', status: 'requested' },
        { key: 'icon/b', spec: 'size=8x8', status: 'requested' },
      ]),
    });
    expect((await ogw(f.ws, ['resource', 'sync', 'g'])).code).toBe(0);
    expect((await pixels(join(f.game, 'resource/icon/a.png'))).width).toBe(8);
    expect(rowOf(f.game, 'icon/a')).toMatchObject({ status: 'requested', sha256: sha(file(f, 'resource/icon/a.png')) });
    expect((await pixels(join(f.game, 'resource/icon/b.png'))).width).toBe(8);
  });

  it('remakes the placeholder of a requested row whose size changed', async () => {
    const f = setup({ 'resource/resources.csv': listCsv([{ key: 'icon/a', spec: 'size=8x8', status: 'placeholder' }]) });
    expect((await ogw(f.ws, ['resource', 'placeholder', 'g'])).code).toBe(0);
    writeFileSync(join(f.game, 'resource/resources.csv'), listCsv([{ key: 'icon/a', spec: 'size=64x64', status: 'requested' }]));
    const out = await ogw(f.ws, ['resource', 'placeholder', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    const image = await pixels(join(f.game, 'resource/icon/a.png'));
    expect([image.width, image.height]).toEqual([64, 64]);
    expect(rowOf(f.game, 'icon/a')).toMatchObject({ status: 'requested', sha256: sha(file(f, 'resource/icon/a.png')) });
  });

  it('remakes the placeholder files of a requested row whose variants changed', async () => {
    const f = setup({ 'resource/resources.csv': listCsv([{ key: 'sfx/hit', spec: 'length=200', status: 'placeholder' }]) });
    expect((await ogw(f.ws, ['resource', 'placeholder', 'g'])).code).toBe(0);
    expect(existsSync(join(f.game, 'resource/sfx/hit.wav'))).toBe(true);
    writeFileSync(join(f.game, 'resource/resources.csv'), listCsv([{ key: 'sfx/hit', spec: 'length=200;variants=3', status: 'requested' }]));
    const out = await ogw(f.ws, ['resource', 'sync', 'g']);
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    expect(existsSync(join(f.game, 'resource/sfx/hit.wav'))).toBe(false);
    for (const n of [1, 2, 3]) expect(existsSync(join(f.game, `resource/sfx/hit.${String(n)}.wav`))).toBe(true);
    expect(rowOf(f.game, 'sfx/hit').status).toBe('requested');
  });

  it('replaces the stale files of a placeholder row', async () => {
    const f = setup({
      'resource/sfx/hit.wav': 'OLD',
      'resource/sfx/hit.4.wav': 'OLD4',
      'resource/sfx/hit.wav.import': 'keep',
      'resource/resources.csv': listCsv([{ key: 'sfx/hit', spec: 'length=10;variants=2', status: 'placeholder' }]),
    });
    expect((await ogw(f.ws, ['resource', 'placeholder', 'g'])).code).toBe(0);
    expect(existsSync(join(f.game, 'resource/sfx/hit.wav'))).toBe(false);
    expect(existsSync(join(f.game, 'resource/sfx/hit.4.wav'))).toBe(false);
    expect(existsSync(join(f.game, 'resource/sfx/hit.1.wav'))).toBe(true);
    expect(existsSync(join(f.game, 'resource/sfx/hit.2.wav'))).toBe(true);
    expect(existsSync(join(f.game, 'resource/sfx/hit.wav.import'))).toBe(true);
  });

  it('accepts a Material subclass and a script class', async () => {
    const f = setup({
      'resource/material/m.tres': '[gd_resource type="ShaderMaterial" format=3]\n',
      'resource/tween/pop.tres': '[gd_resource type="Resource" script_class="TweenDefinition" format=3]\n',
      'resource/resources.csv': listCsv([
        { key: 'material/m', status: 'final' },
        { key: 'tween/pop', status: 'final' },
      ]),
    });
    expect((await ogw(f.ws, ['resource', 'sync', 'g'])).code).toBe(0);
  });

  const failures: [string, Record<string, string>, string][] = [
    ['a missing required item', { 'resource/resources.csv': listCsv([{ key: 'icon/a', spec: 'alpha=true', status: 'placeholder' }]) }, 'icon/a: spec alpha=true: missing item size'],
    ['an item for another type', { 'resource/resources.csv': listCsv([{ key: 'icon/a', spec: 'size=8x8;length=5', status: 'placeholder' }]) }, 'item length is not for type icon'],
    ['an item given twice', { 'resource/resources.csv': listCsv([{ key: 'icon/a', spec: 'size=8x8;size=8x8', status: 'placeholder' }]) }, 'item size given twice'],
    ['an unknown item', { 'resource/resources.csv': listCsv([{ key: 'icon/a', spec: 'size=8x8;dpi=2', status: 'placeholder' }]) }, 'unknown item dpi=2'],
    ['a bad value', { 'resource/resources.csv': listCsv([{ key: 'icon/a', spec: 'size=8', status: 'placeholder' }]) }, 'invalid size value 8'],
    ['an empty spec of a type with required items', { 'resource/resources.csv': listCsv([{ key: 'sfx/a', status: 'placeholder' }]) }, 'sfx/a: spec (empty): missing item length'],
    ['an invalid key', { 'resource/resources.csv': listCsv([{ key: 'thing/a', status: 'placeholder' }]) }, 'thing/a: invalid resource key'],
    ['an invalid status', { 'resource/resources.csv': listCsv([{ key: 'material/a', status: 'done' }]) }, 'material/a: invalid status done'],
    ['a scene that is not final', { 'resource/resources.csv': listCsv([{ key: 'scene/a/b', status: 'placeholder' }]) }, 'scene/a/b: type scene must be final'],
    ['a final row without a file', { 'resource/resources.csv': listCsv([{ key: 'material/a', status: 'final' }]) }, 'material/a: no file resource/material/a.<extension>'],
    ['a wrong extension', { 'resource/material/a.res': 'x', 'resource/resources.csv': listCsv([{ key: 'material/a', status: 'final' }]) }, 'material/a: resource/material/a.res extension is not .tres'],
    ['a wrong class', { 'resource/material/a.tres': '[gd_resource type="Animation" format=3]\n', 'resource/resources.csv': listCsv([{ key: 'material/a', status: 'final' }]) }, 'class Animation is not Material'],
    ['a file with no class', { 'resource/material/a.tres': 'nothing', 'resource/resources.csv': listCsv([{ key: 'material/a', status: 'final' }]) }, 'class none is not Material'],
    ['a wrong root node', { 'resource/particle/a.tscn': '[gd_scene format=3]\n[node name="a" type="GPUParticles2D"]\n', 'resource/resources.csv': listCsv([{ key: 'particle/a', spec: 'space=3D', status: 'final' }]) }, 'root node GPUParticles2D is not GPUParticles3D'],
    ['a wrong variant count', { 'resource/sfx/a.1.wav': 'x', 'resource/resources.csv': listCsv([{ key: 'sfx/a', spec: 'length=5;variants=2', status: 'final' }]) }, 'sfx/a: variants=2 needs files resource/sfx/a.1.<extension>, resource/sfx/a.2.<extension>, found resource/sfx/a.1.wav'],
    ['two files of one key', { 'resource/sfx/a.wav': 'x', 'resource/sfx/a.1.wav': 'x', 'resource/resources.csv': listCsv([{ key: 'sfx/a', spec: 'length=5', status: 'final' }]) }, 'sfx/a: needs one file resource/sfx/a.<extension>, found resource/sfx/a.wav, resource/sfx/a.1.wav'],
    ['a text voice whose text_key is not translated', { 'resource/voice/a.wav': 'x', 'resource/resources.csv': listCsv([{ key: 'voice/a', spec: 'length=5', status: 'final', text_key: 'ui.none', speaker: 's' }]) }, 'voice/a: text_key ui.none is not in data/translations/en.csv'],
    ['a duplicate key', { 'resource/resources.csv': listCsv([{ key: 'material/a', status: 'placeholder' }, { key: 'material/a', status: 'placeholder' }]) }, 'duplicate key material/a'],
    ['a wrong header', { 'resource/resources.csv': 'key,description\n' }, 'header must be key,description,spec'],
  ];

  it.each(failures)('fails without changes on %s', async (_name, files, message) => {
    const f = setup(files);
    const before = readFileSync(join(f.game, 'resource/resources.csv'), 'utf8');
    const run = await ogw(f.ws, ['resource', 'sync', 'g']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(message);
    expect(readFileSync(join(f.game, 'resource/resources.csv'), 'utf8')).toBe(before);
    expect(existsSync(join(f.game, 'resource/app_icon/main.png'))).toBe(false);
  });

  it('tells to run update env when ffmpeg or the placeholder font is missing', async () => {
    const f = setup({ 'resource/resources.csv': listCsv([{ key: 'bgm/a', spec: 'length=100', status: 'placeholder' }]) });
    tools.ffmpeg = null;
    const run = await ogw(f.ws, ['resource', 'placeholder', 'g']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('harness settings tools.ffmpeg is not on this host: run update env');
    expect(existsSync(join(f.game, 'resource/app_icon/main.png'))).toBe(false);
    writeFileSync(join(f.game, 'resource/resources.csv'), listCsv([{ key: 'font/a', status: 'placeholder' }]));
    tools.placeholderFont = null;
    expect((await ogw(f.ws, ['resource', 'placeholder', 'g'])).stderr).toContain('harness settings tools.placeholderFont is not on this host: run update env');
    tools.placeholderFont = join(f.bin, 'ffmpeg');
    expect((await ogw(f.ws, ['resource', 'placeholder', 'g'])).stderr).toContain('placeholder font is not .ttf or .otf');
  });

  it('creates the list with the platform rows when there is none, and needs baseResolution', async () => {
    const f = setup({});
    expect((await ogw(f.ws, ['resource', 'sync', 'g'])).code).toBe(0);
    expect(readList(f.game).map((r) => r.key)).toEqual(['app_icon/main', 'splash/main']);
    writeFileSync(join(f.game, 'settings.json'), JSON.stringify({ engine: 'godot' }));
    writeFileSync(join(f.game, 'resource/resources.csv'), listCsv([]));
    expect((await ogw(f.ws, ['resource', 'sync', 'g'])).stderr).toContain('game settings has no baseResolution for splash/main');
    writeFileSync(join(f.game, 'settings.json'), JSON.stringify({ engine: 'unity', baseResolution: [2, 2] }));
    expect((await ogw(f.ws, ['resource', 'sync', 'g'])).stderr).toContain('not defined: resource types of engine unity');
    writeFileSync(join(f.game, 'settings.json'), JSON.stringify({ baseResolution: [2, 2] }));
    expect((await ogw(f.ws, ['resource', 'sync', 'g'])).stderr).toContain('game settings has no engine');
  });

  it('takes one game', async () => {
    const f = setup({});
    expect((await ogw(f.ws, ['resource', 'sync'])).stderr).toContain('usage: ogw resource sync <game>');
  });
});
