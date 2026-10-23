import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogEntries } from '../../../src/commands/generation/api.ts';
import { combinedAttribution, combinedLicense } from '../../../src/commands/resource/lib/finalize.ts';
import { ogw, commitAll } from '../../helpers/workspace.ts';
import { listCsv, makeFixture, measuredMethods, pcmWav, pixels, png, readList, realFfmpegs, rowOf, silence, sine, translationCsv, wavLengthMs, type Fixture, type Row } from './fixture.ts';

const tools = vi.hoisted(() => ({ ffmpeg: null as string | null, placeholderFont: null as string | null }));
vi.mock('../../../src/commands/env/api.ts', () => ({
  toolProgram: vi.fn((_ctx: unknown, tool: 'ffmpeg' | 'placeholderFont') => Promise.resolve(tools[tool])),
}));
vi.mock('../../../src/commands/generation/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/generation/api.ts')>()),
  catalogEntries: vi.fn(() => Promise.resolve([])),
}));
const BUS = {
  'SoundCore.busLoudnessLufs': { Bgm: -16, Sfx: -18, Voice: -20, Ui: -22 },
  'SoundCore.busPeakMaxDbtp': { Bgm: -1, Sfx: -1.5, Voice: -2, Ui: -3 },
};
const bus: { settings: Record<string, Record<string, number>> } = vi.hoisted(() => ({ settings: {} }));
vi.mock('../../../src/commands/generate/api.ts', () => ({
  mergedCoreSettings: vi.fn(() => Promise.resolve(bus.settings)),
}));

function setup(rows: Row[], files: Record<string, string> = {}, settingsPatch: Record<string, unknown> = {}): Fixture {
  const f = makeFixture({ 'resource/resources.csv': listCsv(rows), ...files }, settingsPatch);
  tools.ffmpeg = f.ffmpeg;
  tools.placeholderFont = f.font;
  return f;
}

async function sync(f: Fixture): Promise<void> {
  const run = await ogw(f.ws, ['resource', 'sync', 'g']);
  if (run.code !== 0) throw new Error(run.stderr);
  commitAll(f.game, 'sync');
}

function work(f: Fixture, name: string): string {
  const dir = join(f.ws.root, 'work');
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

function finalize(f: Fixture, argv: string[]): ReturnType<typeof ogw> {
  return ogw(f.ws, ['resource', 'finalize', 'g', ...argv]);
}

function snapshot(f: Fixture): string {
  return readFileSync(join(f.game, 'resource/resources.csv'), 'utf8');
}

beforeEach(() => {
  bus.settings = structuredClone(BUS);
});

describe('ogw resource finalize', () => {
  beforeEach(() => {
    tools.ffmpeg = null;
  });

  it('trims a transparent border and fits an alpha image into the size', async () => {
    const f = setup([{ key: 'icon/coin', description: 'a coin', spec: 'size=64x64;alpha=true', status: 'requested' }]);
    await sync(f);
    const input = work(f, 'coin.png');
    await png(input, 30, 10, [10, 20, 30, 255], 2);
    const run = await finalize(f, ['icon/coin', '--method', 'flux2-klein', '--file', input]);
    expect(run.stderr).toBe('');
    const out = await pixels(join(f.game, 'resource/icon/coin.png'));
    expect([out.width, out.height]).toEqual([64, 64]);
    const alpha = (x: number, y: number): number => out.data[(y * 64 + x) * 4 + 3] as number;
    expect(alpha(32, 23)).toBe(0);
    expect(alpha(32, 24)).toBeGreaterThan(0);
    expect(alpha(32, 38)).toBeGreaterThan(0);
    expect(alpha(32, 39)).toBe(0);
    expect(alpha(0, 32)).toBe(255);
    const row = rowOf(f.game, 'icon/coin');
    expect(row).toMatchObject({ status: 'final', method: 'flux2-klein', source: '', license: 'Apache-2.0', attribution: '' });
    expect(run.stdout).toBe(`status=final\nmethod=flux2-klein\nlicense=Apache-2.0\nsha256=${row.sha256 as string}\n`);
  });

  it('covers and crops an opaque image', async () => {
    const f = setup([{ key: 'background/sky', spec: 'size=40x20', status: 'requested' }]);
    await sync(f);
    const input = work(f, 'sky.png');
    // 30x10: red columns 0-4, blue 5-24, green 25-29. Cover 40x20 scales by 2 to 60x20 and keeps the middle 40 columns.
    // Away from the red and green edges by the resampling kernel width, pixels are opaque and blue is their largest channel; fit-and-center would leave rows 0-3 transparent.
    const data = Buffer.alloc(30 * 10 * 4);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 30; x++) data.set(x < 5 ? [255, 0, 0, 255] : x < 25 ? [0, 0, 255, 255] : [0, 255, 0, 255], (y * 30 + x) * 4);
    await sharp(data, { raw: { width: 30, height: 10, channels: 4 } }).png().toFile(input);
    expect((await finalize(f, ['background/sky', '--method', 'flux2-klein', '--file', input])).code).toBe(0);
    const out = await pixels(join(f.game, 'resource/background/sky.png'));
    expect([out.width, out.height]).toEqual([40, 20]);
    const at = (x: number, y: number): number[] => [...out.data.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 4)];
    for (const [x, y] of [[2, 0], [37, 19], [2, 19], [37, 0], [20, 10]] as const) {
      const [r, g, b, a] = at(x, y) as [number, number, number, number];
      expect(a).toBe(255);
      expect(b).toBeGreaterThan(Math.max(r, g));
    }
  });

  it('trims, normalizes loudness by bus and reports the result for sound', async () => {
    const f = setup(
      [
        { key: 'sfx/hit', spec: 'length=100;variants=2', status: 'requested' },
        { key: 'bgm/main', spec: 'length=1000', status: 'requested' },
        { key: 'voice/hi', spec: 'length=500', status: 'requested', text_key: 'ui.hi', speaker: 'mira' },
        { key: 'sfx/loop', spec: 'length=100;loop=true', status: 'requested' },
      ],
      { 'data/translations/en.csv': translationCsv([['ui.hi', 'Hi', 'hash-hi']]) },
    );
    await sync(f);
    const a = work(f, 'a.wav');
    const b = work(f, 'b.wav');
    writeFileSync(a, 'A');
    writeFileSync(b, 'B');
    const run = await finalize(f, ['sfx/hit', '--method', 'moss-sfx', '--file', a, b, '--bus', 'Ui', '--json']);
    expect(run.stderr).toBe('');
    const data = JSON.parse(run.stdout) as { loudness: unknown[]; changed: Record<string, string> };
    expect(data.loudness).toEqual([
      { file: 'resource/sfx/hit.1.wav', integratedLufs: -16, truePeakDbtp: -9 },
      { file: 'resource/sfx/hit.2.wav', integratedLufs: -16, truePeakDbtp: -9 },
    ]);
    expect(data.changed.status).toBe('final');
    expect(readFileSync(join(f.game, 'resource/sfx/hit.1.wav'), 'utf8')).toBe('RIFF-fake');
    const log = readFileSync(f.ffmpegLog, 'utf8');
    // Every file read names its container, so that ffmpeg does not probe it.
    expect(log).toContain(`-f wav -i ${a} -af silenceremove=start_periods=1:start_threshold=-60dB:detection=peak,areverse,silenceremove=start_periods=1:start_threshold=-60dB:detection=peak,areverse -c:a pcm_f32le -f wav -fflags +bitexact`);
    expect(log).toMatch(/-f wav -i \S+\/trimmed\.wav -af loudnorm=I=-22:TP=-3:LRA=20:print_format=json -f null -/);
    expect(log).toMatch(/-f wav -i \S+\/trimmed\.wav -af loudnorm=I=-22:TP=-3:LRA=20:measured_I=-30\.00:measured_TP=-10\.00:measured_LRA=2\.00:measured_thresh=-40\.00:offset=0\.10:linear=true:print_format=summary,aformat=sample_rates=48000 -c:a pcm_s16le -f wav -fflags \+bitexact/);
    expect(log).toMatch(/-f wav -i \S+\/out\.wav -af ebur128=peak=true -f null -/);
    expect(log.split('\n').filter((line) => line !== '' && !/-f (wav|ogg) -i /.test(line))).toEqual([]);
    expect(log).not.toContain('aloop');

    // ace-step writes WAV; finalize encodes it to the engine format of bgm (.ogg).
    const bgm = work(f, 'm.wav');
    writeFileSync(bgm, 'M');
    const music = await finalize(f, ['bgm/main', '--method', 'ace-step', '--file', bgm]);
    expect(music.stdout).toContain('resource/bgm/main.ogg integrated loudness -16 LUFS, true peak -9 dBTP');
    expect(readFileSync(f.ffmpegLog, 'utf8')).toContain(`-f wav -i ${bgm} -af loudnorm=I=-16:TP=-1:LRA=20:print_format=json`);
    expect(readFileSync(f.ffmpegLog, 'utf8')).toContain('-c:a libvorbis -q:a 6 -f ogg');
    expect(readFileSync(f.ffmpegLog, 'utf8')).toMatch(/-f ogg -i \S+\/out\.ogg -af ebur128=peak=true -f null -/);
    expect(readFileSync(join(f.game, 'resource/bgm/main.ogg'), 'utf8')).toBe('OggS-fake');
    expect(existsSync(join(f.game, 'resource/bgm/main.wav'))).toBe(false);

    const loop = work(f, 'l.wav');
    writeFileSync(loop, 'L');
    await finalize(f, ['sfx/loop', '--method', 'moss-sfx', '--file', loop, '--bus', 'Sfx']);
    expect(readFileSync(f.ffmpegLog, 'utf8')).toContain(`-i ${loop} -af loudnorm=I=-18:TP=-1.5:LRA=20`);

    const voice = work(f, 'v.wav');
    writeFileSync(voice, 'V');
    await finalize(f, ['voice/hi', '--method', 'qwen3-tts', '--file', voice]);
    expect(readFileSync(f.ffmpegLog, 'utf8')).toContain('loudnorm=I=-20:TP=-2');
    expect(rowOf(f.game, 'voice/hi')).toMatchObject({ status: 'final', text_hash: 'hash-hi' });
  });

  it('writes text_hash of the line voice text that sync gives the row, when the voice cell came after the last sync', async () => {
    const f = setup(
      [
        { key: 'voice/x', spec: 'length=500', status: 'requested' },
        { key: 'voice/y', spec: 'length=500', status: 'requested', text_key: 'ui.old', speaker: 'mira' },
      ],
      { 'data/translations/en.csv': translationCsv([['ui.old', 'Old', 'hash-old']]) },
    );
    await sync(f);
    const cutscene = ['desc,,,', 'All,Client,Client,Client', 'id,int,ref<cutscene_speaker.id>?,reskey?', 'id,step,speaker,voice', '[intro],1,[hero],voice/x', '[intro],2,null,voice/y'].join('\n');
    mkdirSync(join(f.game, 'data/tables'), { recursive: true });
    writeFileSync(join(f.game, 'data/tables/cutscene_step.csv'), `${cutscene}\n`);
    writeFileSync(
      join(f.game, 'data/translations/en.csv'),
      translationCsv([
        ['ui.old', 'Old', 'hash-old'],
        ['cutscene_step.text.[intro].1', 'Hello', 'hash-1'],
        ['cutscene_step.text.[intro].2', 'Bye', 'hash-2'],
      ]),
    );
    for (const [key, name] of [['voice/x', 'x.wav'], ['voice/y', 'y.wav']] as const) {
      const file = work(f, name);
      writeFileSync(file, 'V');
      const run = await finalize(f, [key, '--method', 'qwen3-tts', '--file', file]);
      expect(run.stderr).toBe('');
      expect(run.code).toBe(0);
    }
    expect(rowOf(f.game, 'voice/x')).toMatchObject({ status: 'final', text_key: 'cutscene_step.text.[intro].1', speaker: 'hero', text_hash: 'hash-1' });
    expect(rowOf(f.game, 'voice/y')).toMatchObject({ status: 'final', text_key: 'cutscene_step.text.[intro].2', speaker: 'none', text_hash: 'hash-2' });
    expect(readFileSync(join(f.game, 'resource/voice/x.wav'), 'utf8')).toBe('RIFF-fake');
  });

  it('gives a sound shorter than one gating block one gain from the sound repeated for 1000 ms', async () => {
    const f = setup([{ key: 'sfx/click', spec: 'length=100', status: 'requested' }]);
    await sync(f);
    const click = work(f, 'click.wav');
    writeFileSync(click, 'SHORT');
    const run = await finalize(f, ['sfx/click', '--method', 'moss-sfx', '--file', click, '--bus', 'Ui', '--json']);
    expect(run.stderr).toBe('');
    expect((JSON.parse(run.stdout) as { loudness: unknown[] }).loudness).toEqual([{ file: 'resource/sfx/click.wav', integratedLufs: -23, truePeakDbtp: -3 }]);
    const log = readFileSync(f.ffmpegLog, 'utf8');
    // Repeated: I -30, true peak -10. Ui bus: -22 LUFS, -3 dBTP. Gain min(-22 - -30, -3 - -10) = 7 dB.
    expect(log).toMatch(/-f wav -i \S+\/trimmed\.wav -af aloop=loop=-1:size=2147483647,atrim=duration=1,loudnorm=I=-22:TP=-3:LRA=20:print_format=json -f null -/);
    expect(log).toMatch(/-f wav -i \S+\/trimmed\.wav -af volume=7\.00dB,aformat=sample_rates=48000 -c:a pcm_s16le -f wav/);
    expect(log).toMatch(/-f wav -i \S+\/out\.wav -af aloop=loop=-1:size=2147483647,atrim=duration=1,ebur128=peak=true -f null -/);
    expect(log).not.toContain('measured_I=-inf');
    expect(readFileSync(join(f.game, 'resource/sfx/click.wav'), 'utf8')).toBe('RIFF-fakeSHORT');
  });

  it('gives a short sound the loudness gain when it is smaller than the true peak gain', async () => {
    const f = setup([{ key: 'sfx/tick', spec: 'length=100', status: 'requested' }]);
    await sync(f);
    const tick = work(f, 'tick.wav');
    writeFileSync(tick, 'HUSHED');
    const run = await finalize(f, ['sfx/tick', '--method', 'moss-sfx', '--file', tick, '--bus', 'Ui']);
    expect(run.stderr).toBe('');
    // Repeated: I -30, true peak -30. Ui bus: -22 LUFS, -3 dBTP. Gain min(-22 - -30, -3 - -30) = 8 dB.
    expect(readFileSync(f.ffmpegLog, 'utf8')).toMatch(/-i \S+\/trimmed\.wav -af volume=8\.00dB,aformat=sample_rates=48000 -c:a pcm_s16le -f wav/);
  });

  it('encodes again with a lower gain while the written true peak is over the bus limit', async () => {
    const f = setup([{ key: 'sfx/boom', spec: 'length=3000', status: 'requested' }]);
    await sync(f);
    const boom = work(f, 'boom.wav');
    writeFileSync(boom, 'PEAKY');
    const run = await finalize(f, ['sfx/boom', '--method', 'moss-sfx', '--file', boom, '--bus', 'Sfx', '--json']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    // loudnorm leaves -0.5 dBTP; the Sfx limit is -1.5: the second encode lowers the gain by 1.0 + 0.1 dB
    expect((JSON.parse(run.stdout) as { loudness: unknown[] }).loudness).toEqual([{ file: 'resource/sfx/boom.wav', integratedLufs: -17.1, truePeakDbtp: -1.6 }]);
    const encodes = readFileSync(f.ffmpegLog, 'utf8').split('\n').filter((line) => line.includes('linear=true'));
    expect(encodes).toHaveLength(2);
    expect(encodes[0]).toContain('linear=true:print_format=summary,aformat=sample_rates=48000');
    expect(encodes[1]).toContain('linear=true:print_format=summary,volume=-1.10dB,aformat=sample_rates=48000');
    expect(rowOf(f.game, 'sfx/boom').status).toBe('final');
  });

  it('fails without a change when the true peak stays over the bus limit', async () => {
    const f = setup([{ key: 'sfx/boom', spec: 'length=3000', status: 'requested' }]);
    await sync(f);
    const before = snapshot(f);
    const boom = work(f, 'boom.wav');
    writeFileSync(boom, 'PEAKY');
    // an ffmpeg whose written file reads -0.5 dBTP whatever the gain
    const stubborn = join(f.bin, 'ffmpeg-stubborn');
    writeFileSync(stubborn, `#!/bin/sh\ncase "$*" in *ebur128*) printf '    I:         -16.0 LUFS\\n    Peak:       -0.5 dBFS\\n' >&2; exit 0;; esac\nexec "${f.ffmpeg}" "$@"\n`);
    chmodSync(stubborn, 0o755);
    tools.ffmpeg = stubborn;
    const run = await finalize(f, ['sfx/boom', '--method', 'moss-sfx', '--file', boom, '--bus', 'Sfx']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('true peak -0.5 dBTP stays over the bus limit -1.5 dBTP after 4 encodes');
    expect(snapshot(f)).toBe(before);
    expect(readFileSync(f.ffmpegLog, 'utf8').split('\n').filter((line) => line.includes('linear=true'))).toHaveLength(4);
  });

  it('runs loudnorm inside its ranges and reaches bus values outside them with its own gain', async () => {
    bus.settings['SoundCore.busLoudnessLufs'] = { ...BUS['SoundCore.busLoudnessLufs'], Ui: -2 };
    bus.settings['SoundCore.busPeakMaxDbtp'] = { ...BUS['SoundCore.busPeakMaxDbtp'], Ui: -12 };
    const f = setup([{ key: 'sfx/hit', spec: 'length=1000', status: 'requested' }]);
    await sync(f);
    const hit = work(f, 'hit.wav');
    writeFileSync(hit, 'H');
    const run = await finalize(f, ['sfx/hit', '--method', 'moss-sfx', '--file', hit, '--bus', 'Ui', '--json']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const log = readFileSync(f.ffmpegLog, 'utf8');
    expect(log).toMatch(/-af loudnorm=I=-5:TP=-9:LRA=20:print_format=json -f null -/);
    expect(log).not.toMatch(/loudnorm=I=-2\b|TP=-12/);
    // +3 dB for the loudness loudnorm cannot reach; then -6.1 dB for the true peak over -12 dBTP
    const encodes = log.split('\n').filter((line) => line.includes('linear=true'));
    expect(encodes.map((line) => /volume=(-?[0-9.]+)dB/.exec(line)?.[1])).toEqual(['3.00', '-3.10']);
    expect((JSON.parse(run.stdout) as { loudness: unknown[] }).loudness).toEqual([{ file: 'resource/sfx/hit.wav', integratedLufs: -19.1, truePeakDbtp: -12.1 }]);
  });

  it('makes the sheet, the SpriteFrames and the sheet row of a sprite animation', async () => {
    const f = setup([{ key: 'sprite_animation/coin', spec: 'size=8x8;animations=spin:500:loop,pop:250:once', status: 'requested' }]);
    await sync(f);
    const sheet = work(f, 'sheet.png');
    await png(sheet, 48, 16, [255, 0, 0, 255]);
    const manifest = work(f, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ frame_layout: { rows: { pop: [{ x: 32, y: 0, w: 16, h: 8 }], spin: [{ x: 0, y: 0, w: 16, h: 16 }, { x: 16, y: 0, w: 16, h: 16 }] } } }));
    const run = await finalize(f, ['sprite_animation/coin', '--method', 'sprite-gen-codex', '--file', sheet, '--manifest', manifest]);
    expect(run.stderr).toBe('');
    const out = await pixels(join(f.game, 'resource/sprite_sheet/coin.png'));
    expect([out.width, out.height]).toEqual([16, 16]);
    const a = (x: number, y: number): number => out.data[(y * 16 + x) * 4 + 3] as number;
    expect([a(4, 4), a(12, 4), a(4, 9), a(4, 14), a(12, 12)]).toEqual([255, 255, 0, 0, 0]);
    expect(a(4, 10)).toBe(255);
    const tres = readFileSync(join(f.game, 'resource/sprite_animation/coin.tres'), 'utf8');
    expect(tres).toContain('[ext_resource type="Texture2D" path="res://resource/sprite_sheet/coin.png" id="1"]');
    expect(tres).toContain('region = Rect2(8, 0, 8, 8)');
    expect(tres).toContain('region = Rect2(0, 8, 8, 8)');
    expect(tres).toContain('"loop": true,\n"name": &"spin",\n"speed": 4.0');
    expect(tres).toContain('"loop": false,\n"name": &"pop",\n"speed": 4.0');
    expect(rowOf(f.game, 'sprite_sheet/coin')).toMatchObject({
      description: 'sprite_animation/coin sheet',
      spec: 'size=16x16;alpha=true',
      status: 'final',
      method: 'sprite-gen-codex',
      license: 'LicenseRef-OpenAI-Output',
    });
    expect(rowOf(f.game, 'sprite_animation/coin').status).toBe('final');
  });

  it('copies the rig scene and part images, writes part rows and removes old part rows', async () => {
    const f = setup([
      { key: 'rig_animation_2d/hero', spec: 'size=20x20;animations=idle:800:loop', status: 'requested' },
      { key: 'image/hero/tail', description: 'rig_animation_2d/hero part tail', spec: 'size=1x1;alpha=true', status: 'final' },
    ], {});
    await png(join(f.game, 'resource/image/hero/tail.png'), 1, 1, [0, 0, 0, 255]);
    await sync(f);
    const rig = await makeRig(f);
    const run = await finalize(f, ['rig_animation_2d/hero', '--method', 'rig-2d', '--file', rig.scene, '--skeleton', rig.skeleton, '--split', rig.split]);
    expect(run.stderr).toBe('');
    expect(readFileSync(join(f.game, 'resource/rig_animation_2d/hero.tscn'), 'utf8')).toBe(readFileSync(rig.scene, 'utf8'));
    expect(existsSync(join(f.game, 'resource/image/hero/body.png'))).toBe(true);
    expect(existsSync(join(f.game, 'resource/image/hero/tail.png'))).toBe(false);
    expect(readList(f.game).map((r) => r.key)).toEqual(['rig_animation_2d/hero', 'app_icon/main', 'splash/main', 'image/hero/body', 'image/hero/head']);
    expect(rowOf(f.game, 'image/hero/head')).toMatchObject({ description: 'rig_animation_2d/hero part head', spec: 'size=12x10;alpha=true', status: 'final', method: 'rig-2d', license: 'Apache-2.0 AND LicenseRef-game-owned' });
  });

  it('checks that the rig canvas is the spec size, the split source is the skeleton spec source and the canvas center is the root origin', async () => {
    const f = setup([{ key: 'rig_animation_2d/hero', spec: 'size=20x20;animations=idle:800:loop', status: 'requested' }]);
    await sync(f);
    const wide = await makeRig(f, '40x20');
    const before = snapshot(f);
    const sized = await finalize(f, ['rig_animation_2d/hero', '--method', 'rig-2d', '--file', wide.scene, '--skeleton', wide.skeleton, '--split', wide.split]);
    expect(sized.code).toBe(1);
    expect(sized.stderr).toContain('--split canvas 40x20 is not spec size 20x20');
    expect(snapshot(f)).toBe(before);

    rmSync(join(f.ws.root, 'work', 'rig'), { recursive: true });
    const rig = await makeRig(f);
    const base = ['rig_animation_2d/hero', '--method', 'rig-2d', '--file', rig.scene, '--skeleton', rig.skeleton, '--split', rig.split];
    const scene = readFileSync(rig.scene, 'utf8');
    // The root bone hips has pivot [10, 12] on a 20x20 canvas: it belongs at (0, 2) of the root node.
    writeFileSync(rig.scene, scene.replace('position = Vector2(0, 2)', 'position = Vector2(10, 12)'));
    expect((await finalize(f, base)).stderr).toContain('rig scene root Bone2D hips is at (10, 12) of the root node, not its pivot minus half the canvas (0, 2)');
    writeFileSync(rig.scene, scene.replace('parent="."]\n[node name="hips"', 'parent="."]\nposition = Vector2(1, 0)\n[node name="hips"'));
    expect((await finalize(f, base)).stderr).toContain('rig scene root Bone2D hips is at (1, 2) of the root node');
    writeFileSync(rig.scene, scene.replace('[node name="Skeleton2D" type="Skeleton2D" parent="."]', '[node name="Skeleton2D" type="Node2D" parent="."]'));
    expect((await finalize(f, base)).stderr).toContain('rig scene has no Bone2D hips under a Skeleton2D child of the root');
    const skeleton = readFileSync(rig.skeleton, 'utf8');
    writeFileSync(rig.skeleton, JSON.stringify({ ...(JSON.parse(skeleton) as object), source: join(f.ws.root, 'other.png') }));
    writeFileSync(rig.scene, scene);
    expect((await finalize(f, base)).stderr).toContain(`--split source ${join(f.ws.root, 'work', 'rig', 'source.png')} is not the skeleton spec source ${join(f.ws.root, 'other.png')}`);
    expect(snapshot(f)).toBe(before);

    // The Skeleton2D position and the root Bone2D position add up to the canvas rule.
    writeFileSync(rig.skeleton, skeleton);
    writeFileSync(rig.scene, scene.replace('parent="."]\n[node name="hips"', 'parent="."]\nposition = Vector2(-1.5, 0.5)\n[node name="hips"').replace('position = Vector2(0, 2)', 'position = Vector2(1.5, 1.5)'));
    const run = await finalize(f, base);
    expect(run.stderr).toBe('');
    expect(rowOf(f.game, 'rig_animation_2d/hero').status).toBe('final');
  });

  it('checks the rig inputs', async () => {
    const f = setup([{ key: 'rig_animation_2d/hero', spec: 'size=20x20;animations=idle:800:loop', status: 'requested' }]);
    await sync(f);
    const rig = await makeRig(f);
    const base = ['rig_animation_2d/hero', '--method', 'rig-2d', '--file', rig.scene, '--skeleton', rig.skeleton, '--split', rig.split];
    writeFileSync(rig.scene, readFileSync(rig.scene, 'utf8').replace('name="head" type="Sprite2D"', 'name="face" type="Sprite2D"').replace('&"idle"', '&"walk"').replace('name="neck" type="Bone2D"', 'name="nape" type="Bone2D"'));
    const before = snapshot(f);
    const run = await finalize(f, base);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('rig scene Bone2D names are not the skeleton spec bones\nrig scene part node names are not the skeleton spec parts\nrig scene AnimationPlayer animations are not the skeleton spec animations');
    expect(snapshot(f)).toBe(before);
    const skeleton = JSON.parse(readFileSync(rig.skeleton, 'utf8')) as { parts: { image: string }[]; animations: { duration_ms: number }[] };
    (skeleton.parts[0] as { image: string }).image = 'image/other/body';
    (skeleton.animations[0] as { duration_ms: number }).duration_ms = 900;
    writeFileSync(rig.skeleton, JSON.stringify(skeleton));
    const bad = await finalize(f, base);
    expect(bad.stderr).toContain('part body image is not image/hero/body');
    expect(bad.stderr).toContain('skeleton spec animations are not the spec animations in order, name, length and repeat');
    const split = JSON.parse(readFileSync(rig.split, 'utf8')) as { parts: unknown[] };
    split.parts.reverse();
    writeFileSync(rig.split, JSON.stringify(split));
    expect((await finalize(f, base)).stderr).toContain('--split parts are not the skeleton spec parts');
    split.parts.reverse();
    writeFileSync(rig.split, JSON.stringify(split));
    await png((split.parts[0] as { file: string }).file, 12, 8, [9, 9, 9, 255]);
    expect((await finalize(f, base)).stderr).toContain('ogw resource rig-check is fail');
  });

  it('copies other types unchanged and combines licenses with --inputs', async () => {
    const f = setup(
      [
        { key: 'haptic/hit', spec: 'length=50', status: 'requested' },
        { key: 'icon/a', spec: 'size=4x4', status: 'final', license: 'CC-BY-4.0', attribution: 'Bob' },
        { key: 'icon/b', spec: 'size=4x4', status: 'final', license: 'MIT OR Apache-2.0', attribution: 'Alice' },
      ],
      {},
      { resourceGeneration: measuredMethods().map((m) => ((m as { name: string }).name === 'procedural' ? { ...(m as object), attribution: 'Studio' } : m)) },
    );
    await png(join(f.game, 'resource/icon/a.png'), 4, 4, [1, 1, 1, 255]);
    await png(join(f.game, 'resource/icon/b.png'), 4, 4, [1, 1, 1, 255]);
    await sync(f);
    const input = work(f, 'hit.json');
    writeFileSync(input, '{"segments":[{"delay_ms":0,"duration_ms":50,"intensity":500}]}');
    const run = await finalize(f, ['haptic/hit', '--method', 'procedural', '--file', input, '--inputs', 'icon/b', 'icon/a']);
    expect(run.stderr).toBe('');
    expect(readFileSync(join(f.game, 'resource/haptic/hit.json'), 'utf8')).toBe(readFileSync(input, 'utf8'));
    expect(rowOf(f.game, 'haptic/hit')).toMatchObject({ license: 'CC-BY-4.0 AND LicenseRef-game-owned AND (MIT OR Apache-2.0)', attribution: 'Alice; Bob; Studio' });
  });

  it('combines licenses and attributions by the rules', () => {
    expect(combinedLicense(['MIT', 'Apache-2.0', 'MIT'])).toBe('Apache-2.0 AND MIT');
    expect(combinedLicense(['MIT', 'unknown'])).toBe('unknown');
    expect(combinedLicense(['b OR a'])).toBe('(b OR a)');
    expect(combinedAttribution(['', 'b', 'a', 'b'])).toBe('a; b');
  });

  it('takes source, license and attribution of a catalog file from ogw generation list', async () => {
    const f = setup([{ key: 'font/body', status: 'requested' }, { key: 'icon/a', spec: 'size=4x4', status: 'final', license: 'MIT', attribution: 'Ann' }]);
    await png(join(f.game, 'resource/icon/a.png'), 4, 4, [1, 1, 1, 255]);
    await sync(f);
    const file = touch(f, 'Body.ttf');
    vi.mocked(catalogEntries).mockResolvedValueOnce([
      { path: `${file}.other`, license: 'X', source: 'x', attribution: 'x', charset: [] },
      { path: file, license: 'OFL-1.1', source: 'https://github.com/google/fonts/blob/abc/ofl/body/Body.ttf', attribution: 'Copyright Body', charset: ['latin'] },
    ]);
    const run = await finalize(f, ['font/body', '--method', 'font-catalog', '--file', file, '--inputs', 'icon/a']);
    expect(run.stderr).toBe('');
    expect(vi.mocked(catalogEntries)).toHaveBeenCalledWith(expect.anything(), 'font-catalog');
    expect(rowOf(f.game, 'font/body')).toMatchObject({
      status: 'final',
      method: 'font-catalog',
      source: 'https://github.com/google/fonts/blob/abc/ofl/body/Body.ttf',
      license: 'MIT AND OFL-1.1',
      attribution: 'Ann; Copyright Body',
    });
    expect(readFileSync(join(f.game, 'resource/font/body.ttf'), 'utf8')).toBe('x');
  });

  it('checks every catalog --file and combines the rights of all of them', async () => {
    const sfxCatalog = { name: 'sfx-catalog', kind: 'catalog', resourceTypes: ['sfx'], safetyTimeoutMs: 300000, pins: [{ kind: 'git', source: 'https://example.com/sfx.git', revision: 'abc', files: 'sfx' }], measured: [{ result: 'ok' }] };
    const f = setup([{ key: 'sfx/hit', spec: 'length=100;variants=2', status: 'requested' }], {}, { resourceGeneration: [...measuredMethods(), sfxCatalog] });
    await sync(f);
    const one = touch(f, 'one.wav');
    const two = touch(f, 'two.wav');
    const argv = ['sfx/hit', '--method', 'sfx-catalog', '--file', one, two, '--bus', 'Sfx'];
    vi.mocked(catalogEntries).mockResolvedValueOnce([{ path: one, license: 'CC0-1.0', source: 'https://s/1', attribution: '', charset: [] }]);
    const before = snapshot(f);
    const bad = await finalize(f, argv);
    expect(bad.stderr).toContain(`--file ${two} is not a path ogw generation list sfx-catalog gives`);
    expect(snapshot(f)).toBe(before);
    vi.mocked(catalogEntries).mockResolvedValueOnce([
      { path: two, license: 'CC-BY-4.0', source: 'https://s/2', attribution: 'Bea', charset: [] },
      { path: one, license: 'CC0-1.0', source: 'https://s/1', attribution: '', charset: [] },
    ]);
    const run = await finalize(f, argv);
    expect(run.stderr).toBe('');
    expect(rowOf(f.game, 'sfx/hit')).toMatchObject({ status: 'final', source: 'https://s/1 https://s/2', license: 'CC-BY-4.0 AND CC0-1.0', attribution: 'Bea' });
  });

  it('removes the other files of the key', async () => {
    const f = setup([{ key: 'texture/wall', spec: 'size=4x4', status: 'requested' }]);
    await png(join(f.game, 'resource/texture/wall.1.png'), 4, 4, [1, 1, 1, 255]);
    const run = await finalize(f, await okPng(f, ['texture/wall', '--method', 'flux2-klein']));
    expect(run.stderr).toBe('');
    expect(existsSync(join(f.game, 'resource/texture/wall.1.png'))).toBe(false);
    expect(existsSync(join(f.game, 'resource/texture/wall.png'))).toBe(true);
  });

  const failures: [string, Row[], (f: Fixture) => Promise<string[]>, string][] = [
    ['a key not in the list', [], () => Promise.resolve(['icon/zz', '--method', 'flux2-klein', '--file', 'x.png']), 'icon/zz is not in resource/resources.csv'],
    ['a row that is not requested', [{ key: 'icon/a', spec: 'size=4x4', status: 'placeholder' }], (f) => okPng(f, ['icon/a', '--method', 'flux2-klein']), 'icon/a status is placeholder, not requested'],
    ['a method not for the type', [{ key: 'icon/a', spec: 'size=4x4', status: 'requested' }], (f) => okPng(f, ['icon/a', '--method', 'ace-step']), 'method ace-step is not in ogw generation methods for icon/a: flux2-klein'],
    ['a wrong extension', [{ key: 'icon/a', spec: 'size=4x4', status: 'requested' }], (f) => Promise.resolve(['icon/a', '--method', 'flux2-klein', '--file', touch(f, 'a.jpg')]), 'extension is not .png'],
    ['a missing file', [{ key: 'icon/a', spec: 'size=4x4', status: 'requested' }], () => Promise.resolve(['icon/a', '--method', 'flux2-klein', '--file', '/nonexistent/a.png']), '--file /nonexistent/a.png does not exist'],
    ['too many files', [{ key: 'icon/a', spec: 'size=4x4', status: 'requested' }], (f) => okPng(f, ['icon/a', '--method', 'flux2-klein', '--file', touch(f, 'b.png')]), '--file needs 1 file(s), got 2'],
    ['an input that is not final', [{ key: 'icon/a', spec: 'size=4x4', status: 'requested' }], (f) => okPng(f, ['icon/a', '--method', 'flux2-klein', '--inputs', 'icon/a', 'icon/q']), '--inputs icon/a is not final\n--inputs icon/q is not in resource/resources.csv'],
    ['sfx without --bus', [{ key: 'sfx/a', spec: 'length=5', status: 'requested' }], (f) => Promise.resolve(['sfx/a', '--method', 'moss-sfx', '--file', touch(f, 'a.wav')]), '--bus Sfx or --bus Ui is required for sfx'],
    ['--bus for another type', [{ key: 'icon/a', spec: 'size=4x4', status: 'requested' }], (f) => okPng(f, ['icon/a', '--method', 'flux2-klein', '--bus', 'Sfx']), '--bus is only for sfx'],
    ['--manifest for another type', [{ key: 'icon/a', spec: 'size=4x4', status: 'requested' }], (f) => okPng(f, ['icon/a', '--method', 'flux2-klein', '--manifest', 'm.json']), '--manifest is only for sprite_animation'],
    ['--skeleton for another type', [{ key: 'icon/a', spec: 'size=4x4', status: 'requested' }], (f) => okPng(f, ['icon/a', '--method', 'flux2-klein', '--skeleton', 's.json']), '--skeleton and --split are only for rig_animation_2d'],
    ['a sprite animation without --manifest', [{ key: 'sprite_animation/a', spec: 'size=4x4;animations=x:1:loop', status: 'requested' }], (f) => okPng(f, ['sprite_animation/a', '--method', 'sprite-gen-codex']), '--manifest is required for sprite_animation'],
    ['a rig without --split', [{ key: 'rig_animation_2d/a', spec: 'size=4x4;animations=x:1:loop', status: 'requested' }], (f) => Promise.resolve(['rig_animation_2d/a', '--method', 'rig-2d', '--file', touch(f, 'a.tscn'), '--skeleton', 's']), '--skeleton and --split are required for rig_animation_2d'],
    ['manifest states that are not the animations', [{ key: 'sprite_animation/a', spec: 'size=4x4;animations=x:1:loop', status: 'requested' }], async (f) => {
      const m = work(f, 'm.json');
      writeFileSync(m, JSON.stringify({ frame_layout: { rows: { y: [] } } }));
      return okPng(f, ['sprite_animation/a', '--method', 'sprite-gen-codex', '--manifest', m]);
    }, 'manifest states y are not the spec animations x\nmanifest state y has no frame'],
    ['a manifest without frame_layout', [{ key: 'sprite_animation/a', spec: 'size=4x4;animations=x:1:loop', status: 'requested' }], async (f) => {
      const m = work(f, 'm.json');
      writeFileSync(m, JSON.stringify({ frame_layout: { rows: { x: [{ x: 0 }] } } }));
      return okPng(f, ['sprite_animation/a', '--method', 'sprite-gen-codex', '--manifest', m]);
    }, 'frame_layout.rows.x is not a list of {x, y, w, h}'],
    ['a frame outside the sheet', [{ key: 'sprite_animation/a', spec: 'size=4x4;animations=x:1:loop', status: 'requested' }], async (f) => {
      const m = work(f, 'm.json');
      writeFileSync(m, JSON.stringify({ frame_layout: { rows: { x: [{ x: 3, y: 0, w: 4, h: 4 }] } } }));
      return okPng(f, ['sprite_animation/a', '--method', 'sprite-gen-codex', '--manifest', m]);
    }, 'is outside the sheet 4x4'],
    ['a row that holds a dependent key', [
      { key: 'sprite_animation/a', spec: 'size=4x4;animations=x:1:loop', status: 'requested' },
      { key: 'sprite_sheet/a', description: 'mine', spec: 'size=4x4', status: 'placeholder' },
    ], async (f) => {
      const m = work(f, 'm.json');
      writeFileSync(m, JSON.stringify({ frame_layout: { rows: { x: [{ x: 0, y: 0, w: 4, h: 4 }] } } }));
      return okPng(f, ['sprite_animation/a', '--method', 'sprite-gen-codex', '--manifest', m]);
    }, 'sprite_sheet/a is in resource/resources.csv but is not a dependent row of sprite_animation/a'],
    ['a fully transparent alpha image', [{ key: 'icon/a', spec: 'size=4x4;alpha=true', status: 'requested' }], async (f) => {
      const file = work(f, 'clear.png');
      await png(file, 4, 4, [0, 0, 0, 0]);
      return ['icon/a', '--method', 'flux2-klein', '--file', file];
    }, 'every pixel has alpha 0'],
    ['a text voice without a translation', [{ key: 'voice/a', spec: 'length=5', status: 'requested', text_key: 'ui.x', speaker: 's' }], (f) => Promise.resolve(['voice/a', '--method', 'qwen3-tts', '--file', touch(f, 'a.wav')]), 'voice/a: text_key ui.x is not in data/translations/en.csv'],
    ['a catalog file that ogw generation list does not give', [{ key: 'font/a', status: 'requested' }], (f) => Promise.resolve(['font/a', '--method', 'font-catalog', '--file', touch(f, 'a.ttf')]), 'a.ttf is not a path ogw generation list font-catalog gives'],
    ['a bgm file that is neither the engine format nor WAV', [{ key: 'bgm/a', spec: 'length=5', status: 'requested' }], (f) => Promise.resolve(['bgm/a', '--method', 'ace-step', '--file', touch(f, 'a.mp3')]), 'extension is not .ogg or .wav'],
    ['a silent sound', [{ key: 'sfx/a', spec: 'length=5', status: 'requested' }], (f) => {
      const file = work(f, 'quiet.wav');
      writeFileSync(file, 'SILENT');
      return Promise.resolve(['sfx/a', '--method', 'moss-sfx', '--file', file, '--bus', 'Sfx']);
    }, 'quiet.wav: no loudness to measure; the sound is silent'],
    ['a skeleton spec bone without a pivot', [{ key: 'rig_animation_2d/hero', spec: 'size=20x20;animations=idle:800:loop', status: 'requested' }], async (f) => {
      const rig = await makeRig(f);
      const skeleton = JSON.parse(readFileSync(rig.skeleton, 'utf8')) as { bones: { pivot?: unknown }[] };
      delete (skeleton.bones[0] as { pivot?: unknown }).pivot;
      writeFileSync(rig.skeleton, JSON.stringify(skeleton));
      return ['rig_animation_2d/hero', '--method', 'rig-2d', '--file', rig.scene, '--skeleton', rig.skeleton, '--split', rig.split];
    }, 'bone hips has no pivot'],
    ['a list that sync rejects', [{ key: 'icon/a', spec: 'size=4x4', status: 'requested' }, { key: 'material/b', status: 'final' }], (f) => okPng(f, ['icon/a', '--method', 'flux2-klein']), 'material/b: no file resource/material/b.<extension>'],
  ];

  it.each(failures)('changes nothing on %s', async (_name, rows, argv, message) => {
    const f = setup(rows, { 'data/translations/en.csv': translationCsv([['ui.y', 'Y', 'h']]) });
    const before = snapshot(f);
    const run = await finalize(f, await argv(f));
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(message);
    expect(snapshot(f)).toBe(before);
    expect(existsSync(join(f.game, 'resource/icon/a.png'))).toBe(false);
    expect(existsSync(join(f.game, 'resource/app_icon'))).toBe(false);
  });

  it('tells to run update env when ffmpeg is missing, and needs a method and a file', async () => {
    const f = setup([{ key: 'bgm/a', spec: 'length=5', status: 'requested' }]);
    const before = snapshot(f);
    tools.ffmpeg = null;
    const run = await finalize(f, ['bgm/a', '--method', 'ace-step', '--file', touch(f, 'a.ogg')]);
    expect(run.stderr).toContain('harness settings tools.ffmpeg is not on this host: run update env');
    expect(snapshot(f)).toBe(before);
    expect((await finalize(f, ['bgm/a', '--file', 'x'])).stderr).toContain('usage: ogw resource finalize');
    expect((await finalize(f, ['bgm/a', '--method', 'ace-step'])).stderr).toContain('usage: ogw resource finalize');
  });

  it('needs the flux2-klein steps for rig-2d', async () => {
    const f = setup([{ key: 'rig_animation_2d/a', spec: 'size=4x4;animations=x:1:loop', status: 'requested' }], {}, { resourceGeneration: measuredMethods(['flux2-klein']) });
    const run = await finalize(f, ['rig_animation_2d/a', '--method', 'rig-2d', '--file', touch(f, 'a.tscn'), '--skeleton', 's', '--split', 't']);
    expect(run.stderr).toContain('method rig-2d is not in ogw generation methods for rig_animation_2d/a: none');
  });
});

// The pinned ffmpeg first: it is the program finalize runs.
const realFfmpeg = (await realFfmpegs())[0]?.program ?? null;

// Runs only on a host with ffmpeg: the trim, loudness and true peak come from the real program.
describe.runIf(realFfmpeg !== null)('ogw resource finalize with real ffmpeg', () => {
  const sfx = { lufs: -18, peak: -1.5 };

  function setupReal(): Fixture {
    const f = setup([
      { key: 'sfx/pad', spec: 'length=1000', status: 'requested' },
      { key: 'sfx/long', spec: 'length=1500', status: 'requested' },
      { key: 'sfx/click', spec: 'length=200', status: 'requested' },
      { key: 'sfx/spiky', spec: 'length=2000', status: 'requested' },
    ]);
    tools.ffmpeg = realFfmpeg;
    return f;
  }

  async function finalizeSound(f: Fixture, key: string, wav: Buffer): Promise<{ integratedLufs: number; truePeakDbtp: number }> {
    const file = work(f, `${key.replace('/', '-')}.wav`);
    writeFileSync(file, wav);
    const run = await finalize(f, [key, '--method', 'moss-sfx', '--file', file, '--bus', 'Sfx', '--json']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const [loudness] = (JSON.parse(run.stdout) as { loudness: { integratedLufs: number; truePeakDbtp: number }[] }).loudness;
    return loudness as { integratedLufs: number; truePeakDbtp: number };
  }

  it('trims silence on both ends where every channel is silent, and meets the bus loudness and true peak', async () => {
    const f = setupReal();
    await sync(f);
    // Stereo: 300 ms silence, 1000 ms tone on the left channel only (the right channel stays silent), 300 ms silence.
    const left = [...silence(300), ...sine(1000, 440, 0.3), ...silence(300)];
    const pad = await finalizeSound(f, 'sfx/pad', pcmWav([left, new Array<number>(left.length).fill(0)]));
    expect(wavLengthMs(join(f.game, 'resource/sfx/pad.wav'))).toBeGreaterThan(980);
    expect(wavLengthMs(join(f.game, 'resource/sfx/pad.wav'))).toBeLessThan(1020);
    expect(Math.abs(pad.integratedLufs - sfx.lufs)).toBeLessThanOrEqual(0.5);
    expect(pad.truePeakDbtp).toBeLessThanOrEqual(sfx.peak);

    const long = await finalizeSound(f, 'sfx/long', pcmWav([sine(1500, 1000, 0.05)]));
    expect(Math.abs(long.integratedLufs - sfx.lufs)).toBeLessThanOrEqual(0.5);
    expect(long.truePeakDbtp).toBeLessThanOrEqual(sfx.peak);

    // Shorter than one 400 ms gating block: loudness of the sound repeated, at the target since the peak allows it.
    const click = await finalizeSound(f, 'sfx/click', pcmWav([sine(200, 1000, 0.05)]));
    expect(Math.abs(click.integratedLufs - sfx.lufs)).toBeLessThanOrEqual(0.5);
    expect(click.truePeakDbtp).toBeLessThanOrEqual(sfx.peak);
    expect(wavLengthMs(join(f.game, 'resource/sfx/click.wav'))).toBeGreaterThan(190);
    expect(rowOf(f.game, 'sfx/click').status).toBe('final');
  });

  it('keeps the true peak of a long sound that loudnorm limits dynamically under the bus limit', async () => {
    const f = setupReal();
    await sync(f);
    // 6000 ms of decaying noise bursts every 500 ms: loudnorm falls back to its dynamic limiter, which overshoots.
    let seed = 1;
    const noise = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 1073741824 - 1;
    };
    const bursts = Array.from({ length: 6 * 48000 }, (_, i) => 0.35 * noise() * Math.exp(-((i / 48000) % 0.5) / 0.05));
    const loud = await finalizeSound(f, 'sfx/long', pcmWav([bursts]));
    expect(loud.truePeakDbtp).toBeLessThanOrEqual(sfx.peak);
    expect(rowOf(f.game, 'sfx/long').status).toBe('final');

    // A 6000 ms 12 kHz tone with a loudness target that its peak limit does not allow
    bus.settings['SoundCore.busLoudnessLufs'] = { ...BUS['SoundCore.busLoudnessLufs'], Ui: -8 };
    bus.settings['SoundCore.busPeakMaxDbtp'] = { ...BUS['SoundCore.busPeakMaxDbtp'], Ui: -9 };
    const file = work(f, 'tone.wav');
    writeFileSync(file, pcmWav([sine(6000, 12000, 0.5)]));
    const run = await finalize(f, ['sfx/pad', '--method', 'moss-sfx', '--file', file, '--bus', 'Ui', '--json']);
    expect(run.stderr).toBe('');
    const [tone] = (JSON.parse(run.stdout) as { loudness: { truePeakDbtp: number }[] }).loudness;
    expect(tone?.truePeakDbtp).toBeLessThanOrEqual(-9);
  });

  it('finalizes a sound for bus values outside the ranges loudnorm accepts', async () => {
    bus.settings['SoundCore.busLoudnessLufs'] = { ...BUS['SoundCore.busLoudnessLufs'], Ui: -30 };
    bus.settings['SoundCore.busPeakMaxDbtp'] = { ...BUS['SoundCore.busPeakMaxDbtp'], Ui: -12 };
    const f = setupReal();
    await sync(f);
    const file = work(f, 'quiet.wav');
    writeFileSync(file, pcmWav([sine(1000, 440, 0.3)]));
    const run = await finalize(f, ['sfx/pad', '--method', 'moss-sfx', '--file', file, '--bus', 'Ui', '--json']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const [quiet] = (JSON.parse(run.stdout) as { loudness: { integratedLufs: number; truePeakDbtp: number }[] }).loudness;
    expect(quiet?.truePeakDbtp).toBeLessThanOrEqual(-12);
    expect(Math.abs((quiet?.integratedLufs ?? 0) - -30)).toBeLessThanOrEqual(0.5);
    expect(rowOf(f.game, 'sfx/pad').status).toBe('final');
  });

  it('reads a trimmed tonal sound that ffmpeg would probe as another container', async () => {
    const f = setupReal();
    await sync(f);
    // Short 2 kHz bursts every 250 ms over a quiet 300 Hz tone: once trimmed, the PCM data probes as MPEG-TS.
    const samples = Array.from({ length: 2 * 48000 }, (_, i) => {
      const t = i / 48000;
      return t % 0.25 < 0.01 ? 0.9 * Math.sin(2 * Math.PI * 2000 * t) : 0.003 * Math.sin(2 * Math.PI * 300 * t);
    });
    const spiky = await finalizeSound(f, 'sfx/spiky', pcmWav([samples]));
    expect(spiky.truePeakDbtp).toBeLessThanOrEqual(sfx.peak);
    expect(rowOf(f.game, 'sfx/spiky').status).toBe('final');
  });
});

function touch(f: Fixture, name: string): string {
  const path = work(f, name);
  writeFileSync(path, 'x');
  return path;
}

async function okPng(f: Fixture, argv: string[]): Promise<string[]> {
  const file = work(f, 'ok.png');
  await png(file, 4, 4, [1, 2, 3, 255]);
  return [...argv, '--file', file];
}

/** Layers, a source illustration, a skeleton spec with pivots, a rig split on a canvas of `size` and a rig scene for `rig_animation_2d/hero`. */
async function makeRig(f: Fixture, size = '20x20'): Promise<{ scene: string; skeleton: string; split: string }> {
  const dir = work(f, 'rig');
  const layers = join(dir, 'layers');
  mkdirSync(layers, { recursive: true });
  const raw = (rects: [number, number, number, number][]): Buffer => {
    const data = Buffer.alloc(20 * 20 * 4);
    for (const [x0, y0, x1, y1] of rects) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([200, 10, 10, 255], (y * 20 + x) * 4);
    return data;
  };
  const save = (path: string, data: Buffer): Promise<unknown> => sharp(data, { raw: { width: 20, height: 20, channels: 4 } }).png().toFile(path);
  const source = join(dir, 'source.png');
  await save(source, raw([[4, 6, 16, 18], [7, 2, 13, 6]]));
  await save(join(layers, 'body.png'), raw([[4, 6, 16, 18]]));
  await save(join(layers, 'head.png'), raw([[7, 2, 13, 6]]));
  const skeleton = join(dir, 'skeleton.json');
  writeFileSync(skeleton, JSON.stringify({
    source,
    parts: [
      { name: 'body', bone: 'hips', image: 'image/hero/body', filled: false },
      { name: 'head', bone: 'neck', image: 'image/hero/head', filled: false },
    ],
    bones: [{ name: 'hips', parent: null, pivot: [10, 12] }, { name: 'neck', parent: 'hips', pivot: [10, 6] }],
    animations: [{ name: 'idle', loop: true, duration_ms: 800 }],
  }));
  const out = join(dir, 'split');
  const run = await ogw(f.ws, ['resource', 'rig-split', '--source', source, '--skeleton', skeleton, '--layers', layers, '--size', size, '--out', out]);
  if (run.code !== 0) throw new Error(run.stderr);
  const scene = join(dir, 'hero.tscn');
  writeFileSync(scene, [
    '[gd_scene format=3]',
    '',
    '[sub_resource type="Animation" id="Animation_1"]',
    'resource_name = "idle"',
    '',
    '[sub_resource type="AnimationLibrary" id="AnimationLibrary_1"]',
    '_data = {',
    '&"idle": SubResource("Animation_1")',
    '}',
    '',
    '[node name="hero" type="Node2D"]',
    '[node name="Skeleton2D" type="Skeleton2D" parent="."]',
    '[node name="hips" type="Bone2D" parent="Skeleton2D"]',
    'position = Vector2(0, 2)',
    '[node name="neck" type="Bone2D" parent="Skeleton2D/hips"]',
    'position = Vector2(0, -6)',
    '[node name="body" type="Sprite2D" parent="Skeleton2D/hips"]',
    '[node name="head" type="Sprite2D" parent="Skeleton2D/hips/neck"]',
    '[node name="AnimationPlayer" type="AnimationPlayer" parent="."]',
    '',
  ].join('\n'));
  return { scene, skeleton, split: join(out, 'rig-split.json') };
}
