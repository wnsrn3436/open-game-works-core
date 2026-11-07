import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { processSound, readWavF32, removeDc, shapeSound, soundLoudness, writeWavF32, type Pcm, type SoundTarget } from '../../../../src/commands/resource/lib/audio.ts';
import { dcOffsets, integratedLoudness, maxMomentaryLoudness } from '../../../../src/commands/resource/lib/loudness.ts';
import { pcmWav, realFfmpegs, sine } from '../fixture.ts';
import { makeWorkspace } from '../../../helpers/workspace.ts';

let workspaceEnv: NodeJS.ProcessEnv | undefined;
/** A workspace env, so the private temp folders of processSound stay out of the real harness repo. */
const testEnv = (): NodeJS.ProcessEnv => (workspaceEnv ??= makeWorkspace().env);

const SFX: SoundTarget = { shape: { kind: 'once', trim: true, maxMs: null }, momentary: true, loudnessLufs: -18, peakMaxDbtp: -1.5, ogg: false, minLengthMs: null, maxRangeLu: null };

/** Channel count, sample rate and length in ms of PCM WAV bytes, from their `fmt ` and `data` chunks. */
function wavFormat(bytes: Buffer): { channels: number; rate: number; lengthMs: number } {
  let channels = 0;
  let rate = 0;
  let blockAlign = 0;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      channels = bytes.readUInt16LE(at + 10);
      rate = bytes.readUInt32LE(at + 12);
      blockAlign = bytes.readUInt16LE(at + 20);
    }
    if (id === 'data') return { channels, rate, lengthMs: (size / blockAlign / rate) * 1000 };
    at += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

/** A WAV file of a 440 Hz tone of `ms` ms in every channel. */
function soundFile(ms: number, channels: number): string {
  const file = join(mkdtempSync(join(tmpdir(), 'audio-')), 'in.wav');
  const tone = sine(ms, 440, 0.3);
  writeFileSync(file, pcmWav(Array.from({ length: channels }, () => tone)));
  return file;
}

/** Mono PCM at 1000 Hz, so that one frame is one ms. */
function pcm(values: number[]): Pcm {
  return { channels: 1, sampleRate: 1000, samples: Float32Array.from(values), chunks: Buffer.alloc(0) };
}

describe('shapeSound', () => {
  it('cuts a sound played once to its length and fades its ends', () => {
    const out = shapeSound(pcm(Array.from({ length: 400 }, () => 1)), { kind: 'once', trim: true, maxMs: 300 }, 'f');
    expect(out.samples.length).toBe(300);
    // 2 ms fade in, 50 ms fade out (a quarter of 300 ms is longer)
    expect([out.samples[0], out.samples[1], out.samples[2]]).toEqual([0, 0.5, 1]);
    expect(out.samples[299]).toBe(0);
    expect(out.samples[249]).toBeCloseTo(1, 6);
    expect(out.samples[274]).toBeCloseTo(25 / 50, 6);
  });

  it('fades a short sound out over its last quarter', () => {
    const out = shapeSound(pcm(Array.from({ length: 40 }, () => 1)), { kind: 'once', trim: false, maxMs: null }, 'f');
    expect(out.samples.length).toBe(40);
    expect(out.samples[29]).toBeCloseTo(1, 6);
    expect(out.samples[34]).toBeCloseTo(5 / 10, 6);
  });

  it('loops whole bars and crossfades the seam so that the end runs into the start', () => {
    // A ramp: frame i holds i. bpm 240 in 4/4 at 1000 Hz is a 1000-frame bar.
    const ramp = pcm(Array.from({ length: 6500 }, (_, i) => i));
    const out = shapeSound(ramp, { kind: 'loop', lengthMs: 5200, seamMs: 1000, barMs: 1000 }, 'f');
    // At most 5200 and at most 6500 - 1000: 5 bars
    expect(out.samples.length).toBe(5000);
    expect(out.samples[4999]).toBe(4999);
    // The first frame is almost all of frame 5000, the frame after the end
    expect(Math.abs((out.samples[0] as number) - 5000)).toBeLessThan(10);
    // Past the seam, the file as it was
    expect(out.samples[1000]).toBe(1000);
    const t = (999.5 / 1000) * (Math.PI / 2);
    expect(out.samples[999]).toBeCloseTo(999 * Math.sin(t) + 5999 * Math.cos(t), 2);
  });

  it('loops an sfx to its length with the seam it is given', () => {
    const out = shapeSound(pcm(Array.from({ length: 900 }, () => 0.5)), { kind: 'loop', lengthMs: 500, seamMs: 125, barMs: null }, 'f');
    expect(out.samples.length).toBe(500);
    expect(() => shapeSound(pcm(Array.from({ length: 200 }, () => 0.5)), { kind: 'loop', lengthMs: 500, seamMs: 125, barMs: null }, 'f')).toThrow('f: too short for a loop of 500 ms with a 125 ms seam');
  });

  it('fails a looped bgm shorter than 4 bars and a seam', () => {
    expect(() => shapeSound(pcm(Array.from({ length: 4500 }, () => 0.5)), { kind: 'loop', lengthMs: 8000, seamMs: 1000, barMs: 1000 }, 'f')).toThrow('f: a loop needs 4 bars of 1000.0 ms and a one-bar seam; the file is 4500 ms');
  });

  it('cuts the frames under -60 dBFS in every channel at both ends of a sound played once, and at the end of a loop', () => {
    // 0.0009 is under -60 dBFS (0.001); 0.002 is not
    const values = [0, 0.0009, 0.002, 1, 1, 1, -0.002, 0.0005, 0];
    const once = shapeSound(pcm(values), { kind: 'once', trim: true, maxMs: null }, 'f');
    expect(once.samples.length).toBe(5);
    expect(shapeSound(pcm(values), { kind: 'once', trim: false, maxMs: null }, 'f').samples.length).toBe(9);
    const stereo: Pcm = { channels: 2, sampleRate: 1000, samples: Float32Array.from([0, 0, 0, 0.5, 0.5, 0, 0, 0]), chunks: Buffer.alloc(0) };
    // a frame is kept when any channel is at least -60 dBFS
    expect(shapeSound(stereo, { kind: 'once', trim: true, maxMs: null }, 'f').samples.length).toBe(4);
    const loop = shapeSound(pcm([0, 0, ...Array.from({ length: 20 }, () => 1), 0, 0]), { kind: 'loop', lengthMs: 100, seamMs: 2, barMs: null }, 'f');
    // the leading silence stays (a loop keeps its start), the trailing silence goes: 22 frames, 2 of them the seam
    expect(loop.samples.length).toBe(20);
    expect(loop.samples[0]).toBeCloseTo(Math.cos((0.5 / 2) * (Math.PI / 2)), 6);
  });

  it('removes a DC offset with a high-pass filter that starts from silence and leaves silence silent', () => {
    // a 100 Hz tone on an offset of 0.1, at 48 kHz
    const tone = Float32Array.from({ length: 48000 }, (_, i) => 0.1 + 0.2 * Math.sin((2 * Math.PI * 100 * i) / 48000));
    const out = removeDc({ channels: 1, sampleRate: 48000, samples: tone, chunks: Buffer.alloc(0) });
    // after the step at the start has died away (10 time constants of the 5 Hz filter: 318 ms), no offset
    const settled = { channels: 1, sampleRate: 48000, samples: out.samples.slice(19200), chunks: Buffer.alloc(0) };
    expect(Math.abs(dcOffsets(settled)[0] as number)).toBeLessThan(1e-4);
    // the tone itself keeps its level (0.07 dB at 100 Hz)
    const rms = Math.sqrt(settled.samples.reduce((a, v) => a + v * v, 0) / settled.samples.length);
    expect(20 * Math.log10(rms / (0.2 / Math.SQRT2))).toBeGreaterThan(-0.1);
    // a one-sided pulse and then silence: the silence 500 ms later is back under -60 dBFS
    const pulse = Float32Array.from({ length: 48000 }, (_, i) => (i < 2400 ? 0.5 * Math.sin((Math.PI * i) / 2400) : 0));
    const after = removeDc({ channels: 1, sampleRate: 48000, samples: pulse, chunks: Buffer.alloc(0) });
    expect(Math.max(...after.samples.slice(2400 + 24000).map(Math.abs))).toBeLessThan(0.001);
    // a sound that starts at full level keeps its start: there was silence before it
    const abrupt = removeDc({ channels: 1, sampleRate: 48000, samples: Float32Array.from({ length: 4800 }, () => 0.5), chunks: Buffer.alloc(0) });
    expect(abrupt.samples[0] as number).toBeCloseTo(0.5, 3);
  });

  it('measures a sound played once as an sfx and a sound shorter than 400 ms by their maximum momentary loudness, any other by its integrated loudness', () => {
    const burst = (ms: number): Pcm => ({ channels: 1, sampleRate: 48000, samples: Float32Array.from({ length: (ms * 48000) / 1000 }, (_, i) => 0.1 * Math.sin((2 * Math.PI * 1000 * i) / 48000)), chunks: Buffer.alloc(0) });
    const once = { kind: 'once', trim: false, maxMs: null } as const;
    const loop = { kind: 'loop', lengthMs: 100, seamMs: 10, barMs: null } as const;
    expect(soundLoudness(burst(2000), { shape: once, momentary: true })).toBe(maxMomentaryLoudness(burst(2000)));
    expect(soundLoudness(burst(2000), { shape: once, momentary: false })).toBe(integratedLoudness(burst(2000)));
    expect(soundLoudness(burst(100), { shape: once, momentary: false })).toBe(maxMomentaryLoudness(burst(100)));
    // a 100 ms loop measured repeated: the level of the tone, 6 dB over the loop played once
    expect(soundLoudness(burst(100), { shape: loop, momentary: false }) as number).toBeCloseTo(integratedLoudness(burst(2000)) as number, 1);
  });

  it('reads and writes 32-bit float WAV and keeps other chunks', () => {
    const chunk = Buffer.concat([Buffer.from('ogwm'), Buffer.from([4, 0, 0, 0]), Buffer.from('mark')]);
    const wav = writeWavF32({ channels: 2, sampleRate: 48000, samples: Float32Array.from([0.25, -0.5, 1, 0]), chunks: chunk });
    const back = readWavF32(wav);
    expect(back).toMatchObject({ channels: 2, sampleRate: 48000 });
    expect([...back.samples]).toEqual([0.25, -0.5, 1, 0]);
    expect(back.chunks.equals(chunk)).toBe(true);
  });
});

const programs = await realFfmpegs();

// Runs each real ffmpeg of this host, since ffmpeg versions differ in filter graph behavior.
describe.runIf(programs.length > 0).each(programs)('processSound with the $name ffmpeg', ({ program, ogg }) => {
  it.each([
    [600, 1],
    [600, 2],
    [1800, 1],
    [1800, 2],
  ])('writes a %i ms sfx of %i channels as 48 kHz WAV of the same channels at the bus loudness', async (ms, channels) => {
    const result = await processSound(program, soundFile(ms, channels), SFX, testEnv());
    expect(Math.abs(result.loudnessLufs - SFX.loudnessLufs)).toBeLessThanOrEqual(0.5);
    expect(result.truePeakDbtp).toBeLessThanOrEqual(SFX.peakMaxDbtp);
    const format = wavFormat(result.bytes);
    expect(format).toMatchObject({ channels, rate: 48000 });
    expect(Math.abs(format.lengthMs - ms)).toBeLessThan(20);
  });

  it.runIf(ogg)('writes a 1800 ms stereo sound as OGG', async () => {
    const result = await processSound(program, soundFile(1800, 2), { ...SFX, ogg: true }, testEnv());
    expect(result.bytes.subarray(0, 4).toString('ascii')).toBe('OggS');
    expect(Math.abs(result.loudnessLufs - SFX.loudnessLufs)).toBeLessThanOrEqual(0.5);
    expect(result.truePeakDbtp).toBeLessThanOrEqual(SFX.peakMaxDbtp);
  });

  it.each([
    [100, 1],
    [100, 2],
    [60, 2],
    [150, 2],
  ])('gives a %i ms sfx of %i channels the bus loudness as its maximum momentary loudness', async (ms, channels) => {
    const result = await processSound(program, soundFile(ms, channels), SFX, testEnv());
    expect(Math.abs(result.loudnessLufs - SFX.loudnessLufs)).toBeLessThanOrEqual(0.5);
    expect(result.truePeakDbtp).toBeLessThanOrEqual(SFX.peakMaxDbtp);
    expect(wavFormat(result.bytes).channels).toBe(channels);
  }, 20_000);

  // Untrimmed, so that the written file keeps these sample counts.
  it.each([
    [4800, 1],
    [4800, 2],
    [2400, 2],
    [4810, 2],
  ])('keeps the length of a sound of %i samples of %i channels', async (samples, channels) => {
    const result = await processSound(program, soundFile((samples * 1000) / 48000, channels), { ...SFX, shape: { kind: 'once', trim: false, maxMs: null } }, testEnv());
    expect(Math.abs(result.loudnessLufs - SFX.loudnessLufs)).toBeLessThanOrEqual(0.5);
    expect(wavFormat(result.bytes).lengthMs).toBeCloseTo((samples * 1000) / 48000, 6);
  }, 20_000);
});
