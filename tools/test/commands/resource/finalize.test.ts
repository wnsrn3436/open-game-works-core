import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogEntries } from '../../../src/commands/generation/api.ts';
import { combinedAttribution, combinedLicense, soundShape, type Loudness } from '../../../src/commands/resource/lib/finalize.ts';
import { dcOffsets, integratedLoudness, maxMomentaryLoudness, truePeak } from '../../../src/commands/resource/lib/loudness.ts';
import { parseSpec } from '../../../src/commands/resource/lib/spec.ts';
import { changeRuns, newRunState } from '../../../src/lib/runstate.ts';
import { ogw, commitAll } from '../../helpers/workspace.ts';
import { floatUv, glbOf } from './lib/glb-fixture.ts';
import { listCsv, makeFixture, measuredMethods, pcmWav, pixels, png, readList, readPcm, realFfmpegs, rowOf, silence, sine, spiky, translationCsv, wavLengthMs, type Fixture, type Row } from './fixture.ts';

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

describe('soundShape', () => {
  const shape = (key: string, spec: string, music: string | null = null): ReturnType<typeof soundShape> =>
    soundShape(key, parseSpec(key, key.slice(0, key.indexOf('/')), spec), music);

  it('makes the seam of a looped bgm one bar of --music', async () => {
    const music = join(mkdtempSync(join(tmpdir(), 'ogw-sound-shape-')), 'music.json');
    writeFileSync(music, JSON.stringify({ bpm: 120, beatsPerBar: 3 }));
    expect(await shape('bgm/a', 'length=20000;loop=true', music)).toEqual({ kind: 'loop', lengthMs: 20000, seamMs: 1500, barMs: 1500 });
  });

  it('makes the seam of a looped sfx 500 ms or a quarter of its length, whichever is shorter', async () => {
    expect(await shape('sfx/a', 'length=1000;loop=true')).toEqual({ kind: 'loop', lengthMs: 1000, seamMs: 250, barMs: null });
    expect(await shape('sfx/a', 'length=4000;loop=true')).toEqual({ kind: 'loop', lengthMs: 4000, seamMs: 500, barMs: null });
  });

  it('trims a sound played once except bgm, and cuts only an sfx to its length', async () => {
    expect(await shape('sfx/a', 'length=300')).toEqual({ kind: 'once', trim: true, maxMs: 300 });
    expect(await shape('voice/a', 'length=300')).toEqual({ kind: 'once', trim: true, maxMs: null });
    expect(await shape('bgm/a', 'length=300')).toEqual({ kind: 'once', trim: false, maxMs: null });
  });
});

describe('ogw resource finalize', () => {
  beforeEach(() => {
    tools.ffmpeg = null;
  });

  it('trims a transparent border and fits an alpha image into the size', async () => {
    const f = setup([{ key: 'image/coin', description: 'a coin', spec: 'size=64x64;alpha=true', status: 'requested' }]);
    await sync(f);
    const input = work(f, 'coin.png');
    await png(input, 30, 10, [10, 20, 30, 255], 2);
    const run = await finalize(f, ['image/coin', '--method', 'flux2-klein', '--file', input]);
    expect(run.stderr).toBe('');
    const out = await pixels(join(f.game, 'resource/image/coin.png'));
    expect([out.width, out.height]).toEqual([64, 64]);
    const alpha = (x: number, y: number): number => out.data[(y * 64 + x) * 4 + 3] as number;
    expect(alpha(32, 23)).toBe(0);
    expect(alpha(32, 24)).toBeGreaterThan(0);
    expect(alpha(32, 38)).toBeGreaterThan(0);
    expect(alpha(32, 39)).toBe(0);
    expect(alpha(0, 32)).toBe(255);
    const row = rowOf(f.game, 'image/coin');
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

  it('removes the DC offset, shapes, matches the loudness by bus through the limiter and reports the result for sound', async () => {
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
    writeFileSync(a, pcmWav([[...silence(50), ...sine(300, 440, 0.3)]]));
    writeFileSync(b, pcmWav([sine(300, 880, 0.05)]));
    const run = await finalize(f, ['sfx/hit', '--method', 'moss-sfx', '--file', a, b, '--bus', 'Ui', '--json']);
    expect(run.stderr).toBe('');
    const data = JSON.parse(run.stdout) as { loudness: Loudness[]; changed: Record<string, string> };
    // Ui bus: -22 LUFS, -3 dBTP; each variant is at the target, so the variants are within 1 LU of each other
    expect(data.loudness.map((l) => l.file)).toEqual(['resource/sfx/hit.1.wav', 'resource/sfx/hit.2.wav']);
    for (const l of data.loudness) {
      expect(Math.abs(l.loudnessLufs - -22)).toBeLessThanOrEqual(0.5);
      expect(l.truePeakDbtp).toBeLessThanOrEqual(-3);
    }
    expect(data.changed.status).toBe('final');
    // the leading silence is cut and the sound is cut to its 100 ms length
    expect(wavLengthMs(join(f.game, 'resource/sfx/hit.1.wav'))).toBeCloseTo(100, 0);
    expect(Math.abs((maxMomentaryLoudness(readPcm(join(f.game, 'resource/sfx/hit.1.wav'))) as number) - -22)).toBeLessThanOrEqual(0.5);
    const log = readFileSync(f.ffmpegLog, 'utf8');
    // Every file read names its container, so that ffmpeg does not probe it; ffmpeg only decodes and encodes.
    expect(log).toContain(`-f wav -i ${a} -af aformat=sample_rates=48000 -c:a pcm_f32le -f wav -fflags +bitexact`);
    expect(log).toMatch(/-f wav -i \S+\/leveled\.wav -c:a pcm_s16le -f wav -fflags \+bitexact/);
    expect(log).toMatch(/-f wav -i \S+\/out\.wav -af aformat=sample_rates=48000 -c:a pcm_f32le -f wav/);
    expect(log.split('\n').filter((line) => line !== '' && !/-f (wav|ogg) -i /.test(line))).toEqual([]);
    expect(log).not.toMatch(/loudnorm|silenceremove|ebur128|aloop/);

    // ace-step writes WAV; finalize encodes it to the engine format of bgm (.ogg). A bgm played once is not trimmed or cut.
    const bgm = work(f, 'm.wav');
    writeFileSync(bgm, 'M');
    const music = await finalize(f, ['bgm/main', '--method', 'ace-step', '--file', bgm, '--json']);
    expect(music.stderr).toBe('');
    const [main] = (JSON.parse(music.stdout) as { loudness: Loudness[] }).loudness;
    expect(main?.file).toBe('resource/bgm/main.ogg');
    expect(Math.abs((main?.loudnessLufs ?? 0) - -16)).toBeLessThanOrEqual(0.5);
    expect(readFileSync(f.ffmpegLog, 'utf8')).toContain('-c:a libvorbis -q:a 6 -f ogg');
    expect(readFileSync(f.ffmpegLog, 'utf8')).toMatch(/-f ogg -i \S+\/out\.ogg -af aformat=sample_rates=48000 -c:a pcm_f32le/);
    expect(readFileSync(join(f.game, 'resource/bgm/main.ogg')).toString('ascii', 0, 9)).toBe('OggS-fake');
    expect(readPcm(join(f.game, 'resource/bgm/main.ogg')).samples.length).toBe(480000);
    expect(existsSync(join(f.game, 'resource/bgm/main.wav'))).toBe(false);

    // A loop shorter than 400 ms is measured repeated: its integrated loudness is the target, while the loop played
    // once (its maximum momentary loudness) is 6 dB under it.
    const loop = work(f, 'l.wav');
    writeFileSync(loop, pcmWav([[...sine(600, 440, 0.2), ...silence(200)]]));
    const looped = await finalize(f, ['sfx/loop', '--method', 'moss-sfx', '--file', loop, '--bus', 'Sfx', '--json']);
    expect(looped.stderr).toBe('');
    expect(Math.abs(((JSON.parse(looped.stdout) as { loudness: Loudness[] }).loudness[0]?.loudnessLufs ?? 0) - -18)).toBeLessThanOrEqual(0.5);
    const loopPcm = readPcm(join(f.game, 'resource/sfx/loop.wav'));
    expect(loopPcm.samples.length).toBe(4800);
    expect(Math.abs((maxMomentaryLoudness(loopPcm) as number) - -24)).toBeLessThanOrEqual(0.5);

    const voice = work(f, 'v.wav');
    writeFileSync(voice, pcmWav([sine(1000, 440, 0.3)]));
    const said = await finalize(f, ['voice/hi', '--method', 'qwen3-tts', '--file', voice, '--json']);
    expect(said.stderr).toBe('');
    const [hi] = (JSON.parse(said.stdout) as { loudness: Loudness[] }).loudness;
    expect(Math.abs((hi?.loudnessLufs ?? 0) - -20)).toBeLessThanOrEqual(0.5);
    expect(hi?.truePeakDbtp).toBeLessThanOrEqual(-2);
    expect(rowOf(f.game, 'voice/hi')).toMatchObject({ status: 'final', text_hash: 'hash-hi' });
  });

  it('prints the loudness and true peak of each written file', async () => {
    const f = setup([{ key: 'sfx/hit', spec: 'length=1000', status: 'requested' }]);
    await sync(f);
    const run = await finalize(f, ['sfx/hit', '--method', 'moss-sfx', '--file', touch(f, 'h.wav'), '--bus', 'Sfx']);
    expect(run.stdout).toMatch(/^resource\/sfx\/hit\.wav loudness -1[78](\.[0-9]+)? LUFS, true peak -[0-9.]+ dBTP$/m);
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
    expect(readFileSync(join(f.game, 'resource/voice/x.wav')).toString('ascii', 0, 4)).toBe('RIFF');
  });

  it('matches an sfx to the bus loudness plus its level offset', async () => {
    const f = setup([
      { key: 'sfx/pick', spec: 'length=3000;level=quiet', status: 'requested' },
      { key: 'sfx/roar', spec: 'length=3000;level=loud', status: 'requested' },
    ]);
    await sync(f);
    const pick = await finalize(f, ['sfx/pick', '--method', 'moss-sfx', '--file', touch(f, 'p.wav'), '--bus', 'Sfx', '--json']);
    const roar = await finalize(f, ['sfx/roar', '--method', 'moss-sfx', '--file', touch(f, 'r.wav'), '--bus', 'Sfx', '--json']);
    // Sfx bus -18 LUFS: quiet -8 dB, loud +4 dB
    expect(Math.abs(((JSON.parse(pick.stdout) as { loudness: Loudness[] }).loudness[0]?.loudnessLufs ?? 0) - -26)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(((JSON.parse(roar.stdout) as { loudness: Loudness[] }).loudness[0]?.loudnessLufs ?? 0) - -14)).toBeLessThanOrEqual(0.5);
  });

  it('makes a looped bgm of whole bars from the tempo of --music', async () => {
    const f = setup([{ key: 'bgm/run', spec: 'length=7000;loop=true', status: 'requested' }]);
    await sync(f);
    const music = work(f, 'music.json');
    writeFileSync(music, JSON.stringify({ bpm: 240, beatsPerBar: 4 }));
    const run = await finalize(f, ['bgm/run', '--method', 'ace-step', '--file', touch(f, 'm.wav'), '--music', music]);
    expect(run.stderr).toBe('');
    expect(rowOf(f.game, 'bgm/run').status).toBe('final');
    // 7 bars of 1000 ms of the 10 s tone
    expect(readPcm(join(f.game, 'resource/bgm/run.ogg')).samples.length).toBe(7 * 48000);
    writeFileSync(music, JSON.stringify({ bpm: 0, beatsPerBar: 4 }));
    const f2 = setup([{ key: 'bgm/run', spec: 'length=7000;loop=true', status: 'requested' }]);
    await sync(f2);
    const bad = await finalize(f2, ['bgm/run', '--method', 'ace-step', '--file', touch(f2, 'm.wav'), '--music', music]);
    expect(bad.stderr).toContain('bpm must be a number over 0 and beatsPerBar an integer of 1 or more');
  });

  it('fails without a change a looped bgm whose loudness range is over 7 LU', async () => {
    const f = setup([{ key: 'bgm/run', spec: 'length=20000;loop=true', status: 'requested' }]);
    await sync(f);
    const music = work(f, 'music.json');
    writeFileSync(music, JSON.stringify({ bpm: 240, beatsPerBar: 4 }));
    const before = snapshot(f);
    // 11 s of a tone, then 11 s of it 10 dB lower: a loudness range of about 10 LU
    const dropping = work(f, 'drop.wav');
    writeFileSync(dropping, pcmWav([[...sine(11000, 440, 0.3), ...sine(11000, 440, 0.095)]]));
    const bad = await finalize(f, ['bgm/run', '--method', 'ace-step', '--file', dropping, '--music', music]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/drop\.wav: the loudness range is (9|10|11)\.[0-9] LU, over the 7\.0 LU of a looped bgm/);
    expect(snapshot(f)).toBe(before);
    // 6 dB lower: under 7 LU
    const steady = work(f, 'steady.wav');
    writeFileSync(steady, pcmWav([[...sine(11000, 440, 0.3), ...sine(11000, 440, 0.15)]]));
    const ok = await finalize(f, ['bgm/run', '--method', 'ace-step', '--file', steady, '--music', music]);
    expect(ok.stderr).toBe('');
    expect(rowOf(f.game, 'bgm/run').status).toBe('final');
  });

  it('measures an sfx played once by its maximum momentary loudness, so that a short sound counts its energy over 400 ms', async () => {
    const f = setup([{ key: 'sfx/click', spec: 'length=100', status: 'requested' }]);
    await sync(f);
    const click = work(f, 'click.wav');
    writeFileSync(click, pcmWav([sine(100, 1000, 0.05)]));
    const run = await finalize(f, ['sfx/click', '--method', 'moss-sfx', '--file', click, '--bus', 'Ui', '--json']);
    expect(run.stderr).toBe('');
    const [result] = (JSON.parse(run.stdout) as { loudness: Loudness[] }).loudness;
    expect(Math.abs((result?.loudnessLufs ?? 0) - -22)).toBeLessThanOrEqual(0.5);
    // 100 ms of a 400 ms window: its loudness while it sounds is 6 dB over the target
    const written = readPcm(join(f.game, 'resource/sfx/click.wav'));
    const whileSounding = integratedLoudness({ ...written, samples: Float32Array.from({ length: 48000 }, (_, i) => written.samples[i % written.samples.length] as number) });
    expect(Math.abs((whileSounding as number) - -16)).toBeLessThanOrEqual(0.5);

    // a longer sfx too: 1500 ms of a quiet tone and 500 ms of it 9 dB louder, whose integrated loudness is 2 LU lower
    const f2 = setup([{ key: 'sfx/swell', spec: 'length=2000', status: 'requested' }]);
    await sync(f2);
    const swell = work(f2, 'swell.wav');
    writeFileSync(swell, pcmWav([[...sine(1500, 1000, 0.03), ...sine(500, 1000, 0.085)]]));
    expect((await finalize(f2, ['sfx/swell', '--method', 'moss-sfx', '--file', swell, '--bus', 'Ui'])).stderr).toBe('');
    const loudest = readPcm(join(f2.game, 'resource/sfx/swell.wav'));
    expect(Math.abs((maxMomentaryLoudness(loudest) as number) - -22)).toBeLessThanOrEqual(0.5);
    expect(integratedLoudness(loudest) as number).toBeLessThan(-23.5);
  });

  it('limits the true peak so that a peaky sound reaches its loudness', async () => {
    const f = setup([{ key: 'sfx/tick', spec: 'length=1000', status: 'requested' }]);
    await sync(f);
    // A tone with a one-sample peak every 100 ms, 14 dB over the tone: the gain to the target puts the peaks over the
    // Sfx limit of -1.5 dBTP, and the limiter takes them down by less than 6 dB.
    const tick = work(f, 'tick.wav');
    writeFileSync(tick, pcmWav([spiky(1000, 0.1, 0.5)]));
    const run = await finalize(f, ['sfx/tick', '--method', 'moss-sfx', '--file', tick, '--bus', 'Sfx', '--json']);
    expect(run.stderr).toBe('');
    const [result] = (JSON.parse(run.stdout) as { loudness: Loudness[] }).loudness;
    expect(Math.abs((result?.loudnessLufs ?? 0) - -18)).toBeLessThanOrEqual(0.5);
    expect(result?.truePeakDbtp).toBeLessThanOrEqual(-1.5);
    expect(truePeak(readPcm(join(f.game, 'resource/sfx/tick.wav'))) as number).toBeLessThanOrEqual(-1.5);
  });

  it('fails without a change when the loudness stays more than 0.5 LU under the target with 6 dB of limiting', async () => {
    const f = setup([{ key: 'sfx/tick', spec: 'length=1000', status: 'requested' }]);
    await sync(f);
    const before = snapshot(f);
    // the peaks are 30 dB over the tone
    const tick = work(f, 'tick.wav');
    writeFileSync(tick, pcmWav([spiky(1000, 0.0158, 0.5)]));
    const run = await finalize(f, ['sfx/tick', '--method', 'moss-sfx', '--file', tick, '--bus', 'Sfx']);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/tick\.wav: with 6 dB of limiting, the most the limiter takes off a peak, the sound reaches -[0-9.]+ LUFS, more than 0\.5 LU under the target -18\.0 LUFS/);
    expect(snapshot(f)).toBe(before);
  });

  it('fails without a change an sfx played once that is shorter than half the length it was made for', async () => {
    const moss = { ...(measuredMethods().find((m) => (m as { name: string }).name === 'moss-sfx') as object), measured: [{ durationMs: 1000, result: 'ok' }] };
    const f = setup(
      [
        { key: 'sfx/a', spec: 'length=200', status: 'requested' },
        { key: 'sfx/b', spec: 'length=3000', status: 'requested' },
      ],
      {},
      { resourceGeneration: [...measuredMethods().filter((m) => (m as { name: string }).name !== 'moss-sfx'), moss] },
    );
    await sync(f);
    const before = snapshot(f);
    // 60 ms of a tone, and the ring of the DC filter after it
    const short = work(f, 'short.wav');
    writeFileSync(short, pcmWav([[...sine(60, 500, 0.3), ...silence(500)]]));
    const bad = await finalize(f, ['sfx/a', '--method', 'moss-sfx', '--file', short, '--bus', 'Sfx']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/short\.wav: the sound is (6|7|8|9)[0-9]\.[0-9] ms after the cuts, shorter than half of the 200\.0 ms it was made for/);
    expect(snapshot(f)).toBe(before);
    const half = work(f, 'half.wav');
    writeFileSync(half, pcmWav([[...sine(110, 500, 0.3), ...silence(500)]]));
    expect((await finalize(f, ['sfx/a', '--method', 'moss-sfx', '--file', half, '--bus', 'Sfx'])).stderr).toBe('');
    // made with the fallback stage of 1000 ms for its 3000 ms: half of 1000 ms is enough
    const fallback = work(f, 'fallback.wav');
    writeFileSync(fallback, pcmWav([[...sine(600, 500, 0.3), ...silence(500)]]));
    expect((await finalize(f, ['sfx/b', '--method', 'moss-sfx', '--file', fallback, '--bus', 'Sfx'])).stderr).toBe('');
  });

  it('removes a DC offset before it measures', async () => {
    const f = setup([{ key: 'sfx/hum', spec: 'length=1000', status: 'requested' }]);
    await sync(f);
    // a tone on an offset of 0.05 (-26 dBFS)
    const hum = work(f, 'hum.wav');
    writeFileSync(hum, pcmWav([sine(1000, 440, 0.1).map((v) => v + 0.05)]));
    expect((await finalize(f, ['sfx/hum', '--method', 'moss-sfx', '--file', hum, '--bus', 'Sfx'])).stderr).toBe('');
    expect(Math.abs(dcOffsets(readPcm(join(f.game, 'resource/sfx/hum.wav')))[0] as number)).toBeLessThan(10 ** (-50 / 20));
  });

  it('encodes again with a lower limiter ceiling while the written true peak is over the bus limit', async () => {
    const f = setup([{ key: 'sfx/boom', spec: 'length=1000', status: 'requested' }]);
    await sync(f);
    // the limiter puts the peaks at its ceiling of -1.6 dBTP; an encode raises the largest sample by 1 dB, to -0.6
    const boom = work(f, 'boom.wav');
    writeFileSync(boom, pcmWav([spiky(1000, 0.1, 0.5)]));
    writeFileSync(join(f.bin, 'encode-overshoot-db'), '1');
    const run = await finalize(f, ['sfx/boom', '--method', 'moss-sfx', '--file', boom, '--bus', 'Sfx', '--json']);
    expect(run.stderr).toBe('');
    const [result] = (JSON.parse(run.stdout) as { loudness: Loudness[] }).loudness;
    // the second encode starts from a ceiling 1.0 + 0.1 dB lower: -2.7 dBTP, -1.7 once encoded
    expect(result?.truePeakDbtp).toBeLessThanOrEqual(-1.5);
    expect(Math.abs((result?.loudnessLufs ?? 0) - -18)).toBeLessThanOrEqual(0.5);
    expect(readFileSync(f.ffmpegLog, 'utf8').split('\n').filter((line) => line.includes('leveled.wav'))).toHaveLength(2);
    expect(rowOf(f.game, 'sfx/boom').status).toBe('final');
  });

  it('fails without a change when the true peak stays over the bus limit', async () => {
    const f = setup([{ key: 'sfx/boom', spec: 'length=1000', status: 'requested' }]);
    await sync(f);
    const before = snapshot(f);
    // an encode that raises the largest sample 20 dB, over the limit whatever the limiter does under 6 dB
    writeFileSync(join(f.bin, 'encode-overshoot-db'), '20');
    const run = await finalize(f, ['sfx/boom', '--method', 'moss-sfx', '--file', touch(f, 'boom.wav'), '--bus', 'Sfx']);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/boom\.wav: true peak [0-9.-]+ dBTP stays over the bus limit -1\.5 dBTP after 4 encodes/);
    expect(snapshot(f)).toBe(before);
    expect(readFileSync(f.ffmpegLog, 'utf8').split('\n').filter((line) => line.includes('leveled.wav'))).toHaveLength(4);
  });

  it('fails without a change when the written loudness is more than 0.5 LU from the target', async () => {
    const f = setup([{ key: 'sfx/hit', spec: 'length=1000', status: 'requested' }]);
    await sync(f);
    const before = snapshot(f);
    // an encode that lowers the level by 1 dB
    writeFileSync(join(f.bin, 'encode-gain-db'), '-1');
    const run = await finalize(f, ['sfx/hit', '--method', 'moss-sfx', '--file', touch(f, 'hit.wav'), '--bus', 'Sfx']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('hit.wav: the written loudness -19.0 LUFS is more than 0.5 LU from the target -18.0 LUFS');
    expect(snapshot(f)).toBe(before);
    // 0.4 dB is within it
    writeFileSync(join(f.bin, 'encode-gain-db'), '-0.4');
    expect((await finalize(f, ['sfx/hit', '--method', 'moss-sfx', '--file', touch(f, 'hit.wav'), '--bus', 'Sfx'])).stderr).toBe('');
  });

  it('fails without a change on a silent sound', async () => {
    const f = setup([{ key: 'sfx/none', spec: 'length=1000', status: 'requested' }]);
    await sync(f);
    const before = snapshot(f);
    const silent = work(f, 'silent.wav');
    writeFileSync(silent, 'SILENT');
    const run = await finalize(f, ['sfx/none', '--method', 'moss-sfx', '--file', silent, '--bus', 'Sfx']);
    expect(run.stderr).toContain('silent.wav: no loudness to measure; the sound is silent');
    expect(snapshot(f)).toBe(before);
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

  it('packs frames with sprite-sheet into a sheet a temporary sprite animation is finalized from', async () => {
    const f = setup([{ key: 'sprite_animation/coin', spec: 'size=8x8;animations=spin:500:loop,pop:250:once', status: 'requested' }]);
    await sync(f);
    const frames = [work(f, 'a.png'), work(f, 'b.png'), work(f, 'c.png')];
    await png(frames[0] as string, 16, 16, [255, 0, 0, 255]);
    await png(frames[1] as string, 8, 16, [0, 255, 0, 255]);
    await png(frames[2] as string, 16, 8, [0, 0, 255, 255]);
    const out = work(f, 'packed');
    const pack = await ogw(f.ws, ['resource', 'sprite-sheet', '--frames', `spin=${frames[0] as string},${frames[1] as string}`, '--frames', `pop=${frames[2] as string}`, '--out', out]);
    expect(pack.stderr).toBe('');
    const sheet = await pixels(join(out, 'sheet.png'));
    expect([sheet.width, sheet.height]).toEqual([32, 32]);
    // the 8-wide frame sits at the center of its 16x16 cell
    const at = (x: number, y: number): number[] => [...sheet.data.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)];
    expect(at(18, 8)[3]).toBe(0);
    expect(at(22, 8)).toEqual([0, 255, 0, 255]);
    // the 8-tall frame of pop sits at the center of its cell, rows 16 to 32
    expect(at(8, 19)[3]).toBe(0);
    expect(at(8, 20)).toEqual([0, 0, 255, 255]);
    expect(at(8, 27)).toEqual([0, 0, 255, 255]);
    expect(at(8, 28)[3]).toBe(0);
    expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))).toEqual({
      frame_layout: { rows: { spin: [{ x: 0, y: 0, w: 16, h: 16 }, { x: 16, y: 0, w: 16, h: 16 }], pop: [{ x: 0, y: 16, w: 16, h: 16 }] } },
    });
    const run = await finalize(f, ['sprite_animation/coin', '--method', 'flux2-klein', '--file', join(out, 'sheet.png'), '--manifest', join(out, 'manifest.json')]);
    expect(run.stderr).toBe('');
    expect(rowOf(f.game, 'sprite_animation/coin')).toMatchObject({ status: 'temporary', method: 'flux2-klein' });
    expect(rowOf(f.game, 'sprite_sheet/coin').status).toBe('temporary');
    // sync keeps the made sheet of a temporary sprite animation and its sha256
    const sheetFile = join(f.game, 'resource/sprite_sheet/coin.png');
    const made = readFileSync(sheetFile);
    const madeSha = rowOf(f.game, 'sprite_sheet/coin').sha256;
    // the file is the packed sheet scaled to the 8x8 cells, not the placeholder of a sync that ran inside finalize
    const madePixels = await pixels(sheetFile);
    const madeAt = (x: number, y: number): number[] => [...madePixels.data.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
    expect([madePixels.width, madePixels.height, madeAt(4, 4), madeAt(11, 4), madeAt(4, 11), madeAt(12, 12)[3]]).toEqual([16, 16, [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], 0]);
    commitAll(f.game, 'temporary');
    await sync(f);
    expect(readFileSync(sheetFile).equals(made)).toBe(true);
    expect(rowOf(f.game, 'sprite_sheet/coin')).toMatchObject({ status: 'temporary', sha256: madeSha });
    // a failure writes nothing: no --out folder, and an earlier sheet and manifest stay as they are
    const packed = [readFileSync(join(out, 'sheet.png')), readFileSync(join(out, 'manifest.json'))];
    const fresh = work(f, 'fresh');
    for (const [argv, message] of [
      [['--frames', `spin=${frames[0] as string}`, '--frames', 'pop=/nonexistent.png'], '--frames file /nonexistent.png does not exist'],
      [['--frames', `spin=${frames[0] as string}`, '--frames', `pop=${join(out, 'manifest.json')}`], 'is not a PNG'],
      [['--frames', `spin=${frames[0] as string}`, '--frames', `spin=${frames[1] as string}`], '--frames gives animation spin twice'],
      [['--frames', 'spin'], '--frames item must be <animation>=<file>,<file>...: spin'],
    ] as const) {
      for (const folder of [out, fresh]) {
        const bad = await ogw(f.ws, ['resource', 'sprite-sheet', ...argv, '--out', folder]);
        expect(bad.code).toBe(1);
        expect(bad.stderr).toContain(message);
      }
      expect(existsSync(fresh)).toBe(false);
      expect([readFileSync(join(out, 'sheet.png')), readFileSync(join(out, 'manifest.json'))]).toEqual(packed);
    }
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
      { path: `${file}.other`, license: 'X', source: 'x', attribution: 'x', charset: [], style: [] },
      { path: file, license: 'OFL-1.1', source: 'https://github.com/google/fonts/blob/abc/ofl/body/Body.ttf', attribution: 'Copyright Body', charset: ['latin'], style: [] },
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
    vi.mocked(catalogEntries).mockResolvedValueOnce([{ path: one, license: 'CC0-1.0', source: 'https://s/1', attribution: '', charset: [], style: [] }]);
    const before = snapshot(f);
    const bad = await finalize(f, argv);
    expect(bad.stderr).toContain(`--file ${two} is not a path ogw generation list sfx-catalog gives`);
    expect(snapshot(f)).toBe(before);
    vi.mocked(catalogEntries).mockResolvedValueOnce([
      { path: two, license: 'CC-BY-4.0', source: 'https://s/2', attribution: 'Bea', charset: [], style: [] },
      { path: one, license: 'CC0-1.0', source: 'https://s/1', attribution: '', charset: [], style: [] },
    ]);
    const run = await finalize(f, argv);
    expect(run.stderr).toBe('');
    expect(rowOf(f.game, 'sfx/hit')).toMatchObject({ status: 'final', source: 'https://s/1 https://s/2', license: 'CC-BY-4.0 AND CC0-1.0', attribution: 'Bea' });
  });

  it('makes a row temporary when its method is the temporary method, and final when the image method makes it again', async () => {
    const f = setup([{ key: 'image/a', spec: 'size=4x4', status: 'requested' }], {}, { imageMethod: 'sprite-gen-codex' });
    await sync(f);
    const file = join(f.game, 'resource/image/a.png');
    const placeholder = readFileSync(file);
    const temp = await finalize(f, await okPng(f, ['image/a', '--method', 'flux2-klein']));
    expect(temp.stderr).toBe('');
    expect(rowOf(f.game, 'image/a')).toMatchObject({ status: 'temporary', method: 'flux2-klein' });
    const made = readFileSync(file);
    const madeSha = rowOf(f.game, 'image/a').sha256;
    expect(made.equals(placeholder)).toBe(false);
    commitAll(f.game, 'temporary');
    // sync keeps the made file of a temporary row and its sha256
    await sync(f);
    expect(readFileSync(file).equals(made)).toBe(true);
    expect(rowOf(f.game, 'image/a')).toMatchObject({ status: 'temporary', sha256: madeSha });
    const again = await finalize(f, await okPng(f, ['image/a', '--method', 'sprite-gen-codex']));
    expect(again.stderr).toBe('');
    expect(rowOf(f.game, 'image/a')).toMatchObject({ status: 'final', method: 'sprite-gen-codex' });
  });

  it('refuses a fully opaque file for an alpha image and a UI piece made without the UI kit sheet', async () => {
    const f = setup([
      { key: 'image/hero', spec: 'size=4x4;alpha=true', status: 'requested' },
      { key: 'image/ui_kit', spec: 'size=4x4', status: 'final', method: 'flux2-klein' },
      { key: 'icon/coin', spec: 'size=4x4', status: 'requested' },
      { key: 'nine_slice/panel', spec: 'size=256x256;slice=8,8,8,8;alpha=true', status: 'requested' },
      { key: 'sprite_sheet/fx', spec: 'size=4x4;alpha=true', status: 'requested' },
    ]);
    await png(join(f.game, 'resource/image/ui_kit.png'), 4, 4, [9, 9, 9, 255]);
    await sync(f);
    const before = snapshot(f);
    // every image type with alpha in spec, not only the types that step 2 fits into size
    for (const argv of [['image/hero', '--method', 'flux2-klein'], ['nine_slice/panel', '--method', 'flux2-klein', '--inputs', 'image/ui_kit'], ['sprite_sheet/fx', '--method', 'flux2-klein']]) {
      const opaque = await finalize(f, await okPng(f, argv));
      expect(opaque.code).toBe(1);
      expect(opaque.stderr).toContain('every pixel is opaque; the background is baked in');
    }
    expect(snapshot(f)).toBe(before);
    const clear = work(f, 'clear-border.png');
    await png(clear, 4, 4, [1, 2, 3, 255], 1);
    const panel = await finalize(f, ['nine_slice/panel', '--method', 'flux2-klein', '--inputs', 'image/ui_kit', '--file', clear]);
    expect(panel.stderr).toBe('');
    expect(rowOf(f.game, 'nine_slice/panel').status).toBe('final');
    const bare = await finalize(f, await okPng(f, ['icon/coin', '--method', 'flux2-klein']));
    expect(bare.stderr).toContain('--inputs needs image/ui_kit: icon keys are made from the UI kit sheet');
    const kit = await finalize(f, await okPng(f, ['icon/coin', '--method', 'flux2-klein', '--inputs', 'image/ui_kit']));
    expect(kit.stderr).toBe('');
  });

  it('refuses a nine_slice or icon key while image/ui_kit is not final or not in resources.csv', async () => {
    for (const status of ['placeholder', 'requested', 'temporary', null]) {
      const kit = status === null ? [] : [{ key: 'image/ui_kit', spec: 'size=4x4', status, ...(status === 'temporary' ? { method: 'flux2-klein' } : {}) }];
      const f = setup([...kit, { key: 'icon/coin', spec: 'size=4x4', status: 'requested' }, { key: 'nine_slice/panel', spec: 'size=256x256;slice=8,8,8,8', status: 'requested' }]);
      if (status === 'temporary') await png(join(f.game, 'resource/image/ui_kit.png'), 4, 4, [9, 9, 9, 255]);
      await sync(f);
      const before = snapshot(f);
      const what = status === null ? 'not in resource/resources.csv' : status;
      for (const key of ['icon/coin', 'nine_slice/panel']) {
        const run = await finalize(f, await okPng(f, [key, '--method', 'flux2-klein']));
        expect(run.code).toBe(1);
        expect(run.stderr).toContain(`image/ui_kit is ${what}, not final: ${key.split('/')[0] as string} keys are made from the final UI kit sheet`);
      }
      expect(snapshot(f)).toBe(before);
    }
  });

  it('refuses a model GLB whose mesh node has a transform or whose UVs overlap', async () => {
    const f = setup([{ key: 'model/crate', spec: 'bounds=1x1x1', status: 'requested' }]);
    await sync(f);
    const before = snapshot(f);
    const moved = work(f, 'moved.glb');
    writeFileSync(moved, glbOf([{ uv: floatUv([0, 0, 1, 0, 0, 1, 0.2, 0.2, 0.6, 0.2, 0.2, 0.6]) }], { translation: [0, 0.5, 0] }));
    const run = await finalize(f, ['model/crate', '--method', 'blender', '--file', moved]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`${moved}: node 0 of mesh 0 has translation [0, 0.5, 0]; apply it to the mesh so that the node transform is the identity`);
    expect(run.stderr).toContain(`${moved}: TEXCOORD_0 triangles overlap: triangle 0 of mesh 0 primitive 0 and triangle 1 of mesh 0 primitive 0; unwrap the UVs`);
    expect(snapshot(f)).toBe(before);
    const clean = work(f, 'clean.glb');
    writeFileSync(clean, glbOf([{ uv: floatUv([0, 0, 0.5, 0, 0, 0.5, 0.5, 0.5]), indices: [0, 1, 2, 1, 3, 2] }]));
    const ok = await finalize(f, ['model/crate', '--method', 'blender', '--file', clean]);
    expect(ok.stderr).toBe('');
    expect(rowOf(f.game, 'model/crate')).toMatchObject({ status: 'final', method: 'blender' });
  });

  it('takes a logo from the image method of the game or the logotype method, and only with alpha=true in its spec', async () => {
    const f = setup([
      { key: 'image/logo/ko', spec: 'size=4x4', status: 'requested' },
      { key: 'image/logo/en', spec: 'size=4x4;alpha=true', status: 'requested' },
      { key: 'image/logo/ja', spec: 'size=4x4;alpha=true', status: 'requested' },
    ]);
    await sync(f);
    // sync writes alpha=true in a logo row; a row edited after it without alpha=true is refused
    expect(rowOf(f.game, 'image/logo/ko').spec).toBe('size=4x4;alpha=true');
    const list = join(f.game, 'resource/resources.csv');
    const text = readFileSync(list, 'utf8').split('\n').map((l) => (l.startsWith('image/logo/ko,') ? l.replace('size=4x4;alpha=true', 'size=4x4') : l));
    writeFileSync(list, text.join('\n'));
    const clear = work(f, 'logo.png');
    await png(clear, 4, 4, [250, 200, 120, 255], 1);
    const opaqueSpec = await finalize(f, ['image/logo/ko', '--method', 'logotype', '--file', clear]);
    expect(opaqueSpec.stderr).toContain('image/logo/ko: a logo has alpha=true in spec, so that it is fitted whole and not cropped');
    // another image method than the game's draws no logo
    const other = await finalize(f, ['image/logo/en', '--method', 'sprite-gen-grok', '--file', clear]);
    expect(other.code).toBe(1);
    // flux2-klein is the image method of this game
    const drawn = await finalize(f, ['image/logo/en', '--method', 'flux2-klein', '--file', clear]);
    expect(drawn.stderr).toBe('');
    expect(rowOf(f.game, 'image/logo/en')).toMatchObject({ status: 'final', method: 'flux2-klein' });
    const lettered = await finalize(f, ['image/logo/ja', '--method', 'logotype', '--file', clear]);
    expect(lettered.stderr).toBe('');
    expect(rowOf(f.game, 'image/logo/ja')).toMatchObject({ status: 'final', method: 'logotype' });
  });

  describe('a final row asked again', () => {
    const made = (key: string, method = 'flux2-klein'): Row => ({ key, spec: 'size=4x4', status: 'final', method, source: 'generated', license: 'Apache-2.0' });
    const firstPixel = async (f: Fixture, key: string): Promise<number[]> => [...(await pixels(join(f.game, `resource/${key}.png`))).data.subarray(0, 4)];

    async function madeGame(rows: Row[], settingsPatch: Record<string, unknown> = {}): Promise<Fixture> {
      const f = setup(rows, {}, settingsPatch);
      for (const row of rows) if (row.status === 'final') await png(join(f.game, `resource/${String(row.key)}.png`), 4, 4, [9, 9, 9, 255]);
      await sync(f);
      await changeRuns({ name: 'g', root: f.game, mainRoot: f.game, commonDir: join(f.game, '.git'), inWorktree: false }, (runs) => {
        runs.push(newRunState({ name: 'loop-1', kind: 'loop', branch: 'loop/loop-1', baseCommit: 'x' }));
      });
      return f;
    }

    it('stays in the game through sync until finalize replaces it, and a final row no request holds is refused', async () => {
      const f = await madeGame([made('image/a'), made('image/b')]);
      expect((await ogw(f.ws, ['resource', 'request', 'g', 'image/a'])).stderr).toBe('');
      await sync(f);
      expect(rowOf(f.game, 'image/a').status).toBe('final');
      expect(await firstPixel(f, 'image/a')).toEqual([9, 9, 9, 255]);
      const run = await finalize(f, await okPng(f, ['image/a', '--method', 'flux2-klein']));
      expect(run.stderr).toBe('');
      expect(rowOf(f.game, 'image/a')).toMatchObject({ status: 'final', method: 'flux2-klein' });
      expect(await firstPixel(f, 'image/a')).toEqual([1, 2, 3, 255]);
      const refused = await finalize(f, await okPng(f, ['image/b', '--method', 'flux2-klein']));
      expect(refused.stderr).toContain('image/b status is final, not requested');
      expect(await firstPixel(f, 'image/b')).toEqual([9, 9, 9, 255]);
    });

    it('is not replaced with the temporary method', async () => {
      const f = await madeGame([made('image/a', 'sprite-gen-codex')], { imageMethod: 'sprite-gen-codex' });
      expect((await ogw(f.ws, ['resource', 'request', 'g', 'image/a'])).stderr).toBe('');
      const run = await finalize(f, await okPng(f, ['image/a', '--method', 'flux2-klein']));
      expect(run.stderr).toContain('image/a is final: the temporary method flux2-klein does not replace it');
      expect(rowOf(f.game, 'image/a')).toMatchObject({ status: 'final', method: 'sprite-gen-codex' });
      expect(await firstPixel(f, 'image/a')).toEqual([9, 9, 9, 255]);
    });

    it('is finalized when sync turned it back to placeholder, as a text voice whose line changed', async () => {
      const f = await madeGame([{ key: 'image/p', spec: 'size=4x4', status: 'placeholder' }]);
      mkdirSync(join(f.game, 'records/loops/loop-1/resource-requests'), { recursive: true });
      writeFileSync(join(f.game, 'records/loops/loop-1/resource-requests/100.md'), '## keys\n\nimage/p\n\n## see\n\nnone\n\n## base\n\nnone\n');
      const run = await finalize(f, await okPng(f, ['image/p', '--method', 'flux2-klein']));
      expect(run.stderr).toBe('');
      expect(rowOf(f.game, 'image/p').status).toBe('final');
    });
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
    ['a looped bgm without --music', [{ key: 'bgm/a', spec: 'length=8000;loop=true', status: 'requested' }], (f) => Promise.resolve(['bgm/a', '--method', 'ace-step', '--file', touch(f, 'a.wav')]), '--music is required for a bgm whose loop is true'],
    ['--music for a bgm that does not loop', [{ key: 'bgm/a', spec: 'length=8000', status: 'requested' }], (f) => Promise.resolve(['bgm/a', '--method', 'ace-step', '--file', touch(f, 'a.wav'), '--music', touch(f, 'm.json')]), '--music is only for a bgm whose loop is true'],
    ['a missing --music file', [{ key: 'bgm/a', spec: 'length=8000;loop=true', status: 'requested' }], (f) => Promise.resolve(['bgm/a', '--method', 'ace-step', '--file', touch(f, 'a.wav'), '--music', '/nonexistent/m.json']), '--music /nonexistent/m.json does not exist'],
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
    ['a fully transparent alpha image', [{ key: 'image/a', spec: 'size=4x4;alpha=true', status: 'requested' }], async (f) => {
      const file = work(f, 'clear.png');
      await png(file, 4, 4, [0, 0, 0, 0]);
      return ['image/a', '--method', 'flux2-klein', '--file', file];
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
    ['a list that sync rejects', [{ key: 'image/a', spec: 'size=4x4', status: 'requested' }, { key: 'material/b', status: 'final' }], (f) => okPng(f, ['image/a', '--method', 'flux2-klein']), 'material/b: no file resource/material/b.<extension>'],
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

// Runs only on a host with ffmpeg: the decode and encode of the real program, around the processing of finalize.
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

  async function finalizeSound(f: Fixture, key: string, wav: Buffer): Promise<Loudness> {
    const file = work(f, `${key.replace('/', '-')}.wav`);
    writeFileSync(file, wav);
    const run = await finalize(f, [key, '--method', 'moss-sfx', '--file', file, '--bus', 'Sfx', '--json']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const [loudness] = (JSON.parse(run.stdout) as { loudness: Loudness[] }).loudness;
    return loudness as Loudness;
  }

  it('trims silence on both ends where every channel is silent, and meets the bus loudness and true peak', async () => {
    const f = setupReal();
    await sync(f);
    // Stereo: 300 ms silence, 1000 ms tone on the left channel only (the right channel stays silent), 300 ms silence.
    const left = [...silence(300), ...sine(1000, 440, 0.3), ...silence(300)];
    const pad = await finalizeSound(f, 'sfx/pad', pcmWav([left, new Array<number>(left.length).fill(0)]));
    expect(wavLengthMs(join(f.game, 'resource/sfx/pad.wav'))).toBeGreaterThan(980);
    expect(wavLengthMs(join(f.game, 'resource/sfx/pad.wav'))).toBeLessThan(1020);
    expect(Math.abs(pad.loudnessLufs - sfx.lufs)).toBeLessThanOrEqual(0.5);
    expect(pad.truePeakDbtp).toBeLessThanOrEqual(sfx.peak);

    const long = await finalizeSound(f, 'sfx/long', pcmWav([sine(1500, 1000, 0.05)]));
    expect(Math.abs(long.loudnessLufs - sfx.lufs)).toBeLessThanOrEqual(0.5);
    expect(long.truePeakDbtp).toBeLessThanOrEqual(sfx.peak);

    // Shorter than one 400 ms window: its maximum momentary loudness, which the written file has
    const click = await finalizeSound(f, 'sfx/click', pcmWav([sine(200, 1000, 0.05)]));
    expect(Math.abs(click.loudnessLufs - sfx.lufs)).toBeLessThanOrEqual(0.5);
    expect(Math.abs((maxMomentaryLoudness(readPcm(join(f.game, 'resource/sfx/click.wav'))) as number) - sfx.lufs)).toBeLessThanOrEqual(0.5);
    expect(click.truePeakDbtp).toBeLessThanOrEqual(sfx.peak);
    expect(wavLengthMs(join(f.game, 'resource/sfx/click.wav'))).toBeGreaterThan(190);
    expect(rowOf(f.game, 'sfx/click').status).toBe('final');
  });

  it('keeps the true peak of the written file under the bus limit at the target loudness', async () => {
    const f = setupReal();
    await sync(f);
    // 6000 ms of decaying noise bursts every 500 ms
    let seed = 1;
    const noise = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 1073741824 - 1;
    };
    const bursts = Array.from({ length: 6 * 48000 }, (_, i) => 0.35 * noise() * Math.exp(-((i / 48000) % 0.5) / 0.05));
    const loud = await finalizeSound(f, 'sfx/long', pcmWav([bursts]));
    expect(loud.truePeakDbtp).toBeLessThanOrEqual(sfx.peak);
    expect(Math.abs(loud.loudnessLufs - sfx.lufs)).toBeLessThanOrEqual(0.5);
    expect(rowOf(f.game, 'sfx/long').status).toBe('final');

    // A 6000 ms 12 kHz tone whose loudness target is near its true peak limit: the limiter reaches it
    bus.settings['SoundCore.busLoudnessLufs'] = { ...BUS['SoundCore.busLoudnessLufs'], Ui: -9.5 };
    bus.settings['SoundCore.busPeakMaxDbtp'] = { ...BUS['SoundCore.busPeakMaxDbtp'], Ui: -9 };
    const file = work(f, 'tone.wav');
    writeFileSync(file, pcmWav([sine(6000, 12000, 0.5)]));
    const run = await finalize(f, ['sfx/pad', '--method', 'moss-sfx', '--file', file, '--bus', 'Ui', '--json']);
    expect(run.stderr).toBe('');
    const [tone] = (JSON.parse(run.stdout) as { loudness: Loudness[] }).loudness;
    expect(tone?.truePeakDbtp).toBeLessThanOrEqual(-9);
    expect(Math.abs((tone?.loudnessLufs ?? 0) - -9.5)).toBeLessThanOrEqual(0.5);
  });

  it('finalizes a sound for bus values far from its own', async () => {
    bus.settings['SoundCore.busLoudnessLufs'] = { ...BUS['SoundCore.busLoudnessLufs'], Ui: -30 };
    bus.settings['SoundCore.busPeakMaxDbtp'] = { ...BUS['SoundCore.busPeakMaxDbtp'], Ui: -12 };
    const f = setupReal();
    await sync(f);
    const file = work(f, 'quiet.wav');
    writeFileSync(file, pcmWav([sine(1000, 440, 0.3)]));
    const run = await finalize(f, ['sfx/pad', '--method', 'moss-sfx', '--file', file, '--bus', 'Ui', '--json']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const [quiet] = (JSON.parse(run.stdout) as { loudness: Loudness[] }).loudness;
    expect(quiet?.truePeakDbtp).toBeLessThanOrEqual(-12);
    expect(Math.abs((quiet?.loudnessLufs ?? 0) - -30)).toBeLessThanOrEqual(0.5);
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
