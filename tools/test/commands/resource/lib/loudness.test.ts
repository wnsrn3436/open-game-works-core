import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Pcm } from '../../../../src/commands/resource/lib/audio.ts';
import { integratedLoudness, limitTruePeak, loudnessRange, maxMomentaryLoudness, truePeak } from '../../../../src/commands/resource/lib/loudness.ts';
import { run } from '../../../../src/lib/proc.ts';
import { pcmWav, realFfmpegs } from '../fixture.ts';

const RATE = 48000;

/** A sine of `frequency` at `dbfs` peak level for `seconds`, in every channel, with a phase offset in radians. */
function tone(seconds: number, frequency: number, dbfs: number, channels = 2, phase = 0): Pcm {
  const amplitude = 10 ** (dbfs / 20);
  const frames = Math.round(seconds * RATE);
  const samples = new Float32Array(frames * channels);
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) samples[f * channels + c] = amplitude * Math.sin((2 * Math.PI * frequency * f) / RATE + phase);
  return { channels, sampleRate: RATE, samples, chunks: Buffer.alloc(0) };
}

/** The sound with 10 ms raised-cosine ramps at both ends, so that its start and end add no peaks between samples. */
function ramped(pcm: Pcm): Pcm {
  const frames = pcm.samples.length / pcm.channels;
  const ramp = RATE / 100;
  const samples = Float32Array.from(pcm.samples, (v, i) => {
    const f = Math.floor(i / pcm.channels);
    const edge = Math.min(f, frames - 1 - f);
    return edge >= ramp ? v : v * 0.5 * (1 - Math.cos((Math.PI * edge) / ramp));
  });
  return { ...pcm, samples };
}

function joined(...parts: Pcm[]): Pcm {
  const samples = new Float32Array(parts.reduce((n, p) => n + p.samples.length, 0));
  let at = 0;
  for (const p of parts) {
    samples.set(p.samples, at);
    at += p.samples.length;
  }
  return { ...(parts[0] as Pcm), samples };
}

function silence(seconds: number, channels = 2): Pcm {
  return { channels, sampleRate: RATE, samples: new Float32Array(Math.round(seconds * RATE) * channels), chunks: Buffer.alloc(0) };
}

describe('loudness', () => {
  // EBU Tech 3341 test signals
  it('gives -23 LUFS for a stereo 1 kHz sine at -23 dBFS, integrated and maximum momentary, and 3 dB less in mono', () => {
    expect(integratedLoudness(tone(20, 1000, -23)) as number).toBeCloseTo(-23, 1);
    expect(maxMomentaryLoudness(tone(20, 1000, -23)) as number).toBeCloseTo(-23, 1);
    expect(integratedLoudness(tone(20, 1000, -23, 1)) as number).toBeCloseTo(-26, 1);
  });

  it('gates the integrated loudness: -36 dBFS for 10 s, -23 dBFS for 60 s and -36 dBFS for 10 s is -23 LUFS', () => {
    const signal = joined(tone(10, 1000, -36), tone(60, 1000, -23), tone(10, 1000, -36));
    expect(integratedLoudness(signal) as number).toBeCloseTo(-23, 1);
    // under the absolute gate of -70 LUFS there is no loudness
    expect(integratedLoudness(tone(5, 1000, -72))).toBeNull();
    expect(integratedLoudness(tone(0.3, 1000, -23))).toBeNull();
  });

  it('counts the energy of a sound shorter than 400 ms over the whole 400 ms window, wherever it falls', () => {
    // 100 ms of the -23 LUFS tone: a quarter of the energy of the window
    expect(maxMomentaryLoudness(tone(0.1, 1000, -23)) as number).toBeCloseTo(-23 - 6.02, 1);
    expect(maxMomentaryLoudness(joined(silence(0.37), tone(0.1, 1000, -23), silence(0.05))) as number).toBeCloseTo(-29.02, 1);
    // the loudest window of a sound that gets louder
    expect(maxMomentaryLoudness(joined(tone(2, 1000, -30), tone(1, 1000, -20), tone(2, 1000, -30))) as number).toBeCloseTo(-20, 1);
    expect(maxMomentaryLoudness(silence(1))).toBeNull();
  });

  // EBU Tech 3342 test signals
  it('gives the loudness range of a 20 s stereo 1 kHz sine at -20 dBFS and then -30 dBFS as 10 LU, and of -20 then -15 as 5 LU', () => {
    expect(loudnessRange(joined(tone(20, 1000, -20), tone(20, 1000, -30))) as number).toBeCloseTo(10, 0);
    expect(loudnessRange(joined(tone(20, 1000, -20), tone(20, 1000, -15))) as number).toBeCloseTo(5, 0);
    expect(loudnessRange(tone(2, 1000, -20))).toBeNull();
  });

  it('finds the true peak between samples: a 12 kHz sine whose samples miss its peaks by 3 dB', () => {
    // at a quarter of the sample rate with a 45 degree phase, every sample is at 0.707 of the peak
    const quarter = ramped(tone(1, 12000, -6, 1, Math.PI / 4));
    expect(Math.max(...quarter.samples.map(Math.abs))).toBeCloseTo(10 ** (-6 / 20) * Math.SQRT1_2, 4);
    expect(truePeak(quarter) as number).toBeCloseTo(-6, 1);
    expect(truePeak(silence(1))).toBeNull();
  });
});

describe('limitTruePeak', () => {
  /** A 1 kHz tone at -20 dBFS with a 2 ms burst at -2 dBFS at 1 s. */
  function burst(): Pcm {
    const pcm = tone(3, 1000, -20, 1);
    for (let f = RATE; f < RATE + 96; f++) pcm.samples[f] = 10 ** (-2 / 20) * Math.sin((2 * Math.PI * 1000 * f) / RATE);
    return pcm;
  }

  const gainAt = (limited: Pcm, original: Pcm, ms: number): number => {
    const f = Math.round((ms * RATE) / 1000);
    let peak = 0;
    let base = 0;
    for (let i = f; i < f + 48; i++) {
      peak = Math.max(peak, Math.abs(limited.samples[i] as number));
      base = Math.max(base, Math.abs(original.samples[i] as number));
    }
    return peak / base;
  };

  it('keeps the true peak at the ceiling, reaching the gain over 5 ms before the peak and releasing it over 50 ms', () => {
    const original = burst();
    const limited = limitTruePeak(original, -6, false);
    expect(truePeak(limited) as number).toBeLessThanOrEqual(-5.95);
    // 4 dB off the burst
    expect(20 * Math.log10(gainAt(limited, original, 1000))).toBeCloseTo(-4, 0);
    // untouched more than 5 ms before it, and back within 2 % ten time constants after it
    expect(gainAt(limited, original, 994)).toBeCloseTo(1, 3);
    expect(gainAt(limited, original, 1002 + 500)).toBeGreaterThan(0.98);
    // one release time constant after the look-ahead window, about 1/e of the reduction is left
    const left = (1 - gainAt(limited, original, 1002 + 55)) / (1 - gainAt(limited, original, 1002));
    expect(left).toBeGreaterThan(0.25);
    expect(left).toBeLessThan(0.5);
    // a sound under the ceiling is returned as it is
    expect(limitTruePeak(tone(1, 1000, -20, 1), -6, false).samples).toEqual(tone(1, 1000, -20, 1).samples);
  });

  it('limits a loop as it repeats: a peak at its start lowers the gain at its end', () => {
    const loop = tone(1, 1000, -20, 1);
    for (let f = 0; f < 96; f++) loop.samples[f] = 10 ** (-2 / 20) * Math.sin((2 * Math.PI * 1000 * f) / RATE);
    const circular = limitTruePeak(loop, -6, true);
    const once = limitTruePeak(loop, -6, false);
    const end = loop.samples.length - 24;
    const ratio = (pcm: Pcm): number => Math.abs(pcm.samples[end] as number) / Math.abs(loop.samples[end] as number);
    expect(ratio(once)).toBeCloseTo(1, 6);
    expect(ratio(circular)).toBeLessThan(0.9);
    expect(truePeak(circular) as number).toBeLessThanOrEqual(-5.95);
  });
});

const programs = await realFfmpegs();

// The meter against the ebur128 filter of each real ffmpeg of this host
describe.runIf(programs.length > 0).each(programs)('loudness against ebur128 of the $name ffmpeg', ({ program }) => {
  async function ebur128(pcm: Pcm): Promise<{ i: number; tp: number }> {
    const file = join(mkdtempSync(join(tmpdir(), 'ogw-ebur128-')), 'in.wav');
    const channels = Array.from({ length: pcm.channels }, (_, c) => Array.from({ length: pcm.samples.length / pcm.channels }, (_, f) => pcm.samples[f * pcm.channels + c] as number));
    writeFileSync(file, pcmWav(channels));
    const result = await run(program, ['-hide_banner', '-nostdin', '-f', 'wav', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { timeoutMs: 60_000 });
    const last = (pattern: RegExp): number => Number([...result.stderr.matchAll(pattern)].pop()?.[1]);
    return { i: last(/I:\s+(-?[0-9.]+) LUFS/g), tp: last(/Peak:\s+(-?[0-9.]+) dBFS/g) };
  }

  it.each([
    ['a stereo 1 kHz sine', (): Pcm => ramped(tone(5, 1000, -12))],
    ['a mono 100 Hz sine', (): Pcm => ramped(tone(5, 100, -6, 1))],
    ['a 12 kHz sine with peaks between samples', (): Pcm => ramped(tone(5, 12000, -3, 1, Math.PI / 4))],
    ['decaying noise bursts', (): Pcm => {
      let seed = 7;
      const samples = Float32Array.from({ length: 5 * RATE }, (_, i) => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return 0.5 * (seed / 1073741824 - 1) * Math.exp(-((i / RATE) % 0.5) / 0.05);
      });
      return { channels: 1, sampleRate: RATE, samples, chunks: Buffer.alloc(0) };
    }],
  ])('measures %s as ebur128 does, within 0.2 dB', async (_name, make) => {
    const pcm = make();
    const reference = await ebur128(pcm);
    // the WAV of the reference is 16-bit: measure what it holds
    const held = { ...pcm, samples: pcm.samples.map((v) => Math.round(v * 32767) / 32767) };
    expect(Math.abs((integratedLoudness(held) as number) - reference.i)).toBeLessThanOrEqual(0.2);
    expect(Math.abs((truePeak(held) as number) - reference.tp)).toBeLessThanOrEqual(0.2);
  });
});
