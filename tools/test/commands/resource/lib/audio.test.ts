import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { processSound, type SoundTarget } from '../../../../src/commands/resource/lib/audio.ts';
import { pcmWav, realFfmpegs, sine } from '../fixture.ts';
import { makeWorkspace } from '../../../helpers/workspace.ts';

let workspaceEnv: NodeJS.ProcessEnv | undefined;
/** A workspace env, so the private temp folders of processSound stay out of the real harness repo. */
const testEnv = (): NodeJS.ProcessEnv => (workspaceEnv ??= makeWorkspace().env);

const SFX: SoundTarget = { trim: true, loudnessLufs: -18, peakMaxDbtp: -1.5, ogg: false };

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
    expect(Math.abs((result.integratedLufs ?? 0) - SFX.loudnessLufs)).toBeLessThanOrEqual(0.5);
    expect(result.truePeakDbtp).toBeLessThanOrEqual(SFX.peakMaxDbtp);
    const format = wavFormat(result.bytes);
    expect(format).toMatchObject({ channels, rate: 48000 });
    expect(Math.abs(format.lengthMs - ms)).toBeLessThan(20);
  });

  it.runIf(ogg)('writes a 1800 ms stereo sound as OGG', async () => {
    const result = await processSound(program, soundFile(1800, 2), { ...SFX, ogg: true }, testEnv());
    expect(result.bytes.subarray(0, 4).toString('ascii')).toBe('OggS');
    expect(Math.abs((result.integratedLufs ?? 0) - SFX.loudnessLufs)).toBeLessThanOrEqual(0.5);
    expect(result.truePeakDbtp).toBeLessThanOrEqual(SFX.peakMaxDbtp);
  });

  it.each([
    [100, 1],
    [100, 2],
    [60, 2],
    [150, 2],
  ])('gives a %i ms sfx of %i channels the bus loudness measured repeated', async (ms, channels) => {
    const result = await processSound(program, soundFile(ms, channels), SFX, testEnv());
    expect(Math.abs((result.integratedLufs ?? 0) - SFX.loudnessLufs)).toBeLessThanOrEqual(0.5);
    expect(result.truePeakDbtp).toBeLessThanOrEqual(SFX.peakMaxDbtp);
    expect(wavFormat(result.bytes).channels).toBe(channels);
  }, 20_000);

  // Untrimmed, so that the written file keeps these sample counts: ffmpeg 6.0 repeating a file of them with
  // `-stream_loop -1` and `-t 1` measures it and does not end.
  it.each([
    [4800, 1],
    [4800, 2],
    [2400, 2],
    [4810, 2],
  ])('ends for a sound of %i samples of %i channels measured repeated', async (samples, channels) => {
    const result = await processSound(program, soundFile((samples * 1000) / 48000, channels), { ...SFX, trim: false }, testEnv());
    expect(Math.abs((result.integratedLufs ?? 0) - SFX.loudnessLufs)).toBeLessThanOrEqual(0.5);
    expect(wavFormat(result.bytes).lengthMs).toBeCloseTo((samples * 1000) / 48000, 6);
  }, 20_000);
});
