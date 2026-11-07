import { readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { run } from '../../../lib/proc.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';
import { integratedLoudness, limitTruePeak, loudnessRange, maxMomentaryLoudness, truePeak } from './loudness.ts';

export const SAMPLE_RATE = 48000;

/** 16-bit PCM mono WAV of silence of the length. */
export function silentWav(lengthMs: number): Buffer {
  const samples = Math.max(1, Math.round((lengthMs * SAMPLE_RATE) / 1000));
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const BITEXACT = ['-fflags', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1'];

function codecArgs(ogg: boolean): string[] {
  return ogg ? ['-c:a', 'libvorbis', '-q:a', '6', '-f', 'ogg'] : ['-c:a', 'pcm_s16le', '-f', 'wav'];
}

async function ffmpeg(program: string, args: readonly string[], input?: Buffer): Promise<string> {
  const result = await run(program, ['-hide_banner', '-nostdin', '-y', ...args], { input, timeoutMs: LIMITS.programMs });
  if (result.timedOut) throw new OgwError('ffmpeg timed out');
  if (result.code !== 0) throw new OgwError(`ffmpeg failed: ${result.stderr.trim().split('\n').slice(-3).join(' ')}`);
  return result.stderr;
}

async function withTemp<T>(env: NodeJS.ProcessEnv, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await newPrivateTempFolder('ogw-sound-', env);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Ogg Vorbis bytes of WAV bytes. */
export async function encodeOgg(program: string, wav: Buffer, env: NodeJS.ProcessEnv): Promise<Buffer> {
  return withTemp(env, async (dir) => {
    const out = join(dir, 'out.ogg');
    await ffmpeg(program, ['-f', 'wav', '-i', 'pipe:0', ...codecArgs(true), ...BITEXACT, out], wav);
    return readFile(out);
  });
}

/**
 * How a sound is shaped before its loudness is matched (`production.md` `## finalize` step 2). `once`: cut the leading
 * and trailing parts below -60 dBFS when `trim`, cut to `maxMs`, then fade in and out. `loop`: a loop of whole
 * `barMs` bars (any length when null) at most `lengthMs` long, made after the silence at the end is cut, whose `seamMs`
 * start is crossfaded with what follows it.
 */
export type SoundShape = { kind: 'once'; trim: boolean; maxMs: number | null } | { kind: 'loop'; lengthMs: number; seamMs: number; barMs: number | null };

export interface SoundTarget {
  shape: SoundShape;
  /** The loudness is the maximum momentary loudness (an `sfx` played once); otherwise the integrated loudness. */
  momentary: boolean;
  loudnessLufs: number;
  peakMaxDbtp: number;
  ogg: boolean;
  /** The shortest a shaped sound may be (half the length it was made for); null for no check. */
  minLengthMs: number | null;
  /** The widest loudness range (LU) of the shaped sound; null for no check. */
  maxRangeLu: number | null;
}

export interface SoundResult {
  bytes: Buffer;
  loudnessLufs: number;
  truePeakDbtp: number;
}

/** Below this absolute sample value in every channel, the start and end of a sound are cut (-60 dBFS). */
const TRIM_LEVEL = 10 ** (-60 / 20);
/** Fade in of a sound played once. */
const FADE_IN_MS = 2;
/** Longest fade out of a sound played once; a shorter sound fades out over its last quarter. */
const FADE_OUT_MS = 50;
/** Fewest bars of a looped `bgm`. */
const MIN_LOOP_BARS = 4;
/** Cutoff of the first-order high-pass filter that removes the DC offset. */
const DC_CUTOFF_HZ = 5;

/** Interleaved 32-bit float samples, and the WAV chunks other than `fmt ` and `data`, kept as they are. */
export interface Pcm {
  channels: number;
  sampleRate: number;
  samples: Float32Array;
  chunks: Buffer;
}

/** Reads a 32-bit float WAV (the format the `decoded.wav` step writes). */
export function readWavF32(bytes: Buffer): Pcm {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new OgwError('not a WAV file');
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let samples: Float32Array | null = null;
  const chunks: Buffer[] = [];
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const end = Math.min(at + 8 + size + (size % 2), bytes.length);
    if (id === 'fmt ') {
      channels = bytes.readUInt16LE(at + 10);
      sampleRate = bytes.readUInt32LE(at + 12);
      bits = bytes.readUInt16LE(at + 22);
    } else if (id === 'data') {
      if (bits !== 32 || channels < 1) throw new OgwError('WAV data is not 32-bit float');
      const data = bytes.subarray(at + 8, Math.min(at + 8 + size, bytes.length));
      samples = new Float32Array(Math.floor(data.length / 4 / channels) * channels);
      for (let i = 0; i < samples.length; i++) samples[i] = data.readFloatLE(i * 4);
    } else {
      chunks.push(bytes.subarray(at, end));
    }
    at = end;
  }
  if (samples === null) throw new OgwError('WAV file has no data chunk');
  return { channels, sampleRate, samples, chunks: Buffer.concat(chunks) };
}

/** A 32-bit float WAV of the samples. */
export function writeWavF32(pcm: Pcm): Buffer {
  const data = Buffer.alloc(pcm.samples.length * 4);
  for (let i = 0; i < pcm.samples.length; i++) data.writeFloatLE(pcm.samples[i] as number, i * 4);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length + pcm.chunks.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(pcm.channels, 22);
  header.writeUInt32LE(pcm.sampleRate, 24);
  header.writeUInt32LE(pcm.sampleRate * pcm.channels * 4, 28);
  header.writeUInt16LE(pcm.channels * 4, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data, pcm.chunks]);
}

function frames(pcm: Pcm, ms: number): number {
  return Math.round((ms * pcm.sampleRate) / 1000);
}

function frameCount(pcm: Pcm): number {
  return pcm.samples.length / pcm.channels;
}

function lengthMs(pcm: Pcm): number {
  return (frameCount(pcm) * 1000) / pcm.sampleRate;
}

/** Each channel through a first-order high-pass filter at `DC_CUTOFF_HZ`, with silence before the sound. */
export function removeDc(pcm: Pcm): Pcm {
  const { channels } = pcm;
  const count = frameCount(pcm);
  const samples = new Float32Array(pcm.samples.length);
  const alpha = 1 / (1 + (2 * Math.PI * DC_CUTOFF_HZ) / pcm.sampleRate);
  for (let c = 0; c < channels; c++) {
    let previousIn = 0;
    let previousOut = 0;
    for (let f = 0; f < count; f++) {
      const value = pcm.samples[f * channels + c] as number;
      previousOut = alpha * (previousOut + value - previousIn);
      previousIn = value;
      samples[f * channels + c] = previousOut;
    }
  }
  return { ...pcm, samples };
}

/** Whether some channel of frame `f` is at least `TRIM_LEVEL`. */
function audible(pcm: Pcm, f: number): boolean {
  for (let c = 0; c < pcm.channels; c++) if (Math.abs(pcm.samples[f * pcm.channels + c] as number) >= TRIM_LEVEL) return true;
  return false;
}

/** Cuts the frames below `TRIM_LEVEL` in every channel at the end, and at the start when `start`. */
function trimmed(pcm: Pcm, start: boolean): Pcm {
  const count = frameCount(pcm);
  let first = 0;
  if (start) while (first < count && !audible(pcm, first)) first++;
  let end = count;
  while (end > first && !audible(pcm, end - 1)) end--;
  return { ...pcm, samples: pcm.samples.slice(first * pcm.channels, end * pcm.channels) };
}

/** Cuts the silence when `trim`, cuts to `maxMs`, then fades in over `FADE_IN_MS` and out over `FADE_OUT_MS` or the last quarter, whichever is shorter. */
function shapeOnce(source: Pcm, trim: boolean, maxMs: number | null): Pcm {
  const pcm = trim ? trimmed(source, true) : source;
  const { channels } = pcm;
  let count = frameCount(pcm);
  if (maxMs !== null) count = Math.min(count, frames(pcm, maxMs));
  const samples = pcm.samples.slice(0, count * channels);
  const fadeIn = Math.min(frames(pcm, FADE_IN_MS), Math.floor(count / 2));
  const fadeOut = Math.min(frames(pcm, FADE_OUT_MS), Math.floor(count / 4));
  for (let f = 0; f < count; f++) {
    let gain = 1;
    if (f < fadeIn) gain = f / fadeIn;
    const fromEnd = count - 1 - f;
    if (fromEnd < fadeOut) gain = Math.min(gain, fromEnd / fadeOut);
    if (gain === 1) continue;
    for (let c = 0; c < channels; c++) samples[f * channels + c] = (samples[f * channels + c] as number) * gain;
  }
  return { ...pcm, samples };
}

/**
 * The loop, after the silence at the end is cut: the first L frames, with the first X frames the equal-power
 * crossfade of themselves (fading in) and the X frames after L (fading out), so that the last frame runs on into the
 * first. For `barMs`, X is one bar and L whole bars; otherwise X is `seamMs` and L is `lengthMs` or what the file leaves
 * after X.
 */
function shapeLoop(source: Pcm, shape: { lengthMs: number; seamMs: number; barMs: number | null }, file: string): Pcm {
  const pcm = trimmed(source, false);
  const { channels } = pcm;
  const count = frameCount(pcm);
  const want = frames(pcm, shape.lengthMs);
  let seam: number;
  let length: number;
  if (shape.barMs === null) {
    seam = frames(pcm, shape.seamMs);
    length = Math.min(want, count - seam);
    if (length <= seam) throw new OgwError(`${file}: too short for a loop of ${String(shape.lengthMs)} ms with a ${String(shape.seamMs)} ms seam`);
  } else {
    const bar = (shape.barMs * pcm.sampleRate) / 1000;
    seam = Math.round(bar);
    const bars = Math.floor(Math.min(want, count - seam) / bar);
    if (bars < MIN_LOOP_BARS) throw new OgwError(`${file}: a loop needs ${String(MIN_LOOP_BARS)} bars of ${shape.barMs.toFixed(1)} ms and a one-bar seam; the file is ${String(Math.round((count * 1000) / pcm.sampleRate))} ms`);
    length = Math.round(bars * bar);
  }
  const samples = pcm.samples.slice(0, length * channels);
  for (let f = 0; f < seam; f++) {
    const t = ((f + 0.5) / seam) * (Math.PI / 2);
    for (let c = 0; c < channels; c++) {
      const head = pcm.samples[f * channels + c] as number;
      const tail = pcm.samples[(length + f) * channels + c] as number;
      samples[f * channels + c] = head * Math.sin(t) + tail * Math.cos(t);
    }
  }
  return { ...pcm, samples };
}

/** The sound shaped (`SoundShape`); its DC offset is removed before (`removeDc`). */
export function shapeSound(pcm: Pcm, shape: SoundShape, file: string): Pcm {
  return shape.kind === 'once' ? shapeOnce(pcm, shape.trim, shape.maxMs) : shapeLoop(pcm, shape, file);
}

/**
 * A sound shorter than one BS.1770-4 gating block (400 ms) has no integrated loudness. A loop that short is measured
 * repeated for this long (`production.md` `## finalize` step 2).
 */
export const SHORT_SOUND_LOOP_MS = 1000;
const GATING_BLOCK_MS = 400;

function repeated(pcm: Pcm, ms: number): Pcm {
  const want = frames(pcm, ms) * pcm.channels;
  const samples = new Float32Array(want);
  for (let i = 0; i < want; i++) samples[i] = pcm.samples[i % pcm.samples.length] as number;
  return { ...pcm, samples };
}

/**
 * The loudness of `production.md` `## finalize` step 2: the maximum momentary loudness of an `sfx` played once and of
 * any other sound played once that is shorter than 400 ms, otherwise the integrated loudness, of a loop shorter than
 * 400 ms repeated for `SHORT_SOUND_LOOP_MS`. Null for silence.
 */
export function soundLoudness(pcm: Pcm, target: Pick<SoundTarget, 'shape' | 'momentary'>): number | null {
  const short = lengthMs(pcm) < GATING_BLOCK_MS;
  if (target.shape.kind === 'once') return target.momentary || short ? maxMomentaryLoudness(pcm) : integratedLoudness(pcm);
  return integratedLoudness(short ? repeated(pcm, SHORT_SOUND_LOOP_MS) : pcm);
}

/**
 * Input arguments of a sound file with its container format named, so that ffmpeg does not probe it: tonal PCM data
 * can out-score the WAV probe and be read as another container. The format is `ogg` for `.ogg`, else `wav`.
 */
function input(file: string): string[] {
  return ['-f', extname(file).toLowerCase() === '.ogg' ? 'ogg' : 'wav', '-i', file];
}

/**
 * Resamples to `SAMPLE_RATE` and keeps the channel layout. `aformat` and not `aresample`: ffmpeg 6.0 finds no channel
 * layout for the output of an `aresample` filter in some graphs; it gives the resampler it inserts for `aformat` the
 * input layout.
 */
const RESAMPLE = `aformat=sample_rates=${String(SAMPLE_RATE)}`;

/** The file as 32-bit float PCM at `SAMPLE_RATE`, through `<dir>/<name>`. */
async function decode(program: string, file: string, dir: string, name: string): Promise<Pcm> {
  const out = join(dir, name);
  await ffmpeg(program, [...input(file), '-af', RESAMPLE, '-c:a', 'pcm_f32le', '-f', 'wav', ...BITEXACT, out]);
  return readWavF32(await readFile(out));
}

/** Encodes of one sound at most: each one after the first lowers the limiter ceiling by the true peak excess of the one before. */
const PEAK_PASSES = 4;
/** How far under the true peak limit the limiter ceiling starts, and the extra cut after a true peak excess. */
const PEAK_MARGIN_DB = 0.1;
/** Gain passes of the limiter at most, and how near the loudness of the limited sound must come to the target. */
const LEVEL_PASSES = 12;
const LEVEL_TOLERANCE_LU = 0.05;
/** How far the loudness of a written file may be from the target. */
const WRITTEN_TOLERANCE_LU = 0.5;

function scaled(pcm: Pcm, gainDb: number): Pcm {
  const gain = 10 ** (gainDb / 20);
  return { ...pcm, samples: pcm.samples.map((v) => v * gain) };
}

function fixed(value: number): string {
  return value.toFixed(1);
}

/** The most the limiter takes off a peak. */
const MAX_LIMITING_DB = 6;

/**
 * The sound times a gain, through the true peak limiter with `ceilingDbtp`, with the gain raised until the loudness of
 * the limited sound is within `LEVEL_TOLERANCE_LU` of the target, and at most to the gain that takes `MAX_LIMITING_DB`
 * off the highest peak (`measured.peak`, the true peak of the sound), where it must be within `WRITTEN_TOLERANCE_LU`.
 * Each pass after the first moves the gain by the miss over the slope of the two passes before (secant), the slope kept
 * in [0.02, 1].
 */
function leveled(pcm: Pcm, target: SoundTarget, ceilingDbtp: number, measured: { loudness: number; peak: number }, file: string): Pcm {
  const most = ceilingDbtp + MAX_LIMITING_DB - measured.peak;
  let gain = Math.min(target.loudnessLufs - measured.loudness, most);
  let before: { gain: number; loudness: number } | null = null;
  for (let pass = 1; pass <= LEVEL_PASSES; pass++) {
    const limited = limitTruePeak(scaled(pcm, gain), ceilingDbtp, target.shape.kind === 'loop');
    const loudness = soundLoudness(limited, target) as number;
    const miss = target.loudnessLufs - loudness;
    if (Math.abs(miss) <= LEVEL_TOLERANCE_LU) return limited;
    if (miss > 0 && gain >= most) {
      if (miss <= WRITTEN_TOLERANCE_LU) return limited;
      throw new OgwError(
        `${file}: with ${String(MAX_LIMITING_DB)} dB of limiting, the most the limiter takes off a peak, the sound reaches ${fixed(loudness)} LUFS, more than ${String(WRITTEN_TOLERANCE_LU)} LU under the target ${fixed(target.loudnessLufs)} LUFS: its true peak is ${fixed(measured.peak - measured.loudness)} dB over its loudness`,
      );
    }
    const slope = before === null || gain === before.gain ? 1 : Math.min(1, Math.max(0.02, (loudness - before.loudness) / (gain - before.gain)));
    before = { gain, loudness };
    gain = Math.min(most, gain + miss / slope);
  }
  throw new OgwError(`${file}: the limiter does not bring the loudness to ${fixed(target.loudnessLufs)} LUFS under the true peak limit ${fixed(ceilingDbtp)} dBTP`);
}

/** The checks of the shaped sound that fail before it is encoded. */
function shapedProblems(pcm: Pcm, target: SoundTarget, file: string): string | null {
  if (!pcm.samples.some((v) => v !== 0)) return `${file}: no loudness to measure; the sound is silent`;
  const ms = lengthMs(pcm);
  if (target.minLengthMs !== null && ms < target.minLengthMs) {
    return `${file}: the sound is ${fixed(ms)} ms after the cuts, shorter than half of the ${fixed(target.minLengthMs * 2)} ms it was made for`;
  }
  const range = target.maxRangeLu === null ? null : loudnessRange(pcm);
  if (range !== null && target.maxRangeLu !== null && range > target.maxRangeLu) {
    return `${file}: the loudness range is ${fixed(range)} LU, over the ${fixed(target.maxRangeLu)} LU of a looped bgm`;
  }
  return null;
}

/**
 * Removes the DC offset and shapes (`SoundShape`), brings the loudness (`soundLoudness`) to the target through the
 * true peak limiter, encodes, and measures the written file. The encode can leave the written file over the true peak
 * limit: the sound is then limited again with the ceiling lowered by the excess, and it fails when it stays over after
 * `PEAK_PASSES` encodes, or when the written loudness is more than `WRITTEN_TOLERANCE_LU` from the target.
 */
export async function processSound(program: string, file: string, target: SoundTarget, env: NodeJS.ProcessEnv): Promise<SoundResult> {
  return withTemp(env, async (dir) => {
    const shaped = shapeSound(removeDc(await decode(program, file, dir, 'decoded.wav')), target.shape, file);
    const problem = shapedProblems(shaped, target, file);
    if (problem !== null) throw new OgwError(problem);
    const loudness = soundLoudness(shaped, target);
    const peak = truePeak(shaped);
    if (loudness === null || peak === null) throw new OgwError(`${file}: no loudness to measure; the sound is silent`);
    const source = join(dir, 'leveled.wav');
    const out = join(dir, target.ogg ? 'out.ogg' : 'out.wav');
    let ceiling = target.peakMaxDbtp - PEAK_MARGIN_DB;
    for (let pass = 1; ; pass++) {
      await writeFile(source, writeWavF32(leveled(shaped, target, ceiling, { loudness, peak }, file)));
      await ffmpeg(program, ['-f', 'wav', '-i', source, ...codecArgs(target.ogg), ...BITEXACT, out]);
      const written = await decode(program, out, dir, 'written.wav');
      const writtenPeak = truePeak(written);
      const writtenLoudness = soundLoudness(written, target);
      if (writtenPeak === null || writtenLoudness === null) throw new OgwError(`${file}: the written file is silent`);
      if (writtenPeak <= target.peakMaxDbtp) {
        if (Math.abs(writtenLoudness - target.loudnessLufs) > WRITTEN_TOLERANCE_LU) {
          throw new OgwError(`${file}: the written loudness ${fixed(writtenLoudness)} LUFS is more than ${String(WRITTEN_TOLERANCE_LU)} LU from the target ${fixed(target.loudnessLufs)} LUFS`);
        }
        return { bytes: await readFile(out), loudnessLufs: round(writtenLoudness), truePeakDbtp: round(writtenPeak) };
      }
      if (pass === PEAK_PASSES) {
        throw new OgwError(`${file}: true peak ${fixed(writtenPeak)} dBTP stays over the bus limit ${String(target.peakMaxDbtp)} dBTP after ${String(PEAK_PASSES)} encodes`);
      }
      ceiling -= writtenPeak - target.peakMaxDbtp + PEAK_MARGIN_DB;
    }
  });
}

/** A measurement to 0.01. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
