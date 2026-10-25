import { readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { run } from '../../../lib/proc.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';

export const SAMPLE_RATE = 48000;

/** 16-bit PCM mono WAV of a sine tone. */
export function toneWav(lengthMs: number, frequency: number): Buffer {
  const samples = Math.max(1, Math.round((lengthMs * SAMPLE_RATE) / 1000));
  const fade = Math.min(Math.floor(samples / 2), Math.round(SAMPLE_RATE * 0.005));
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const edge = Math.min(i, samples - 1 - i);
    const gain = fade > 0 && edge < fade ? edge / fade : 1;
    const value = Math.round(Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE) * 0.3 * gain * 32767);
    data.writeInt16LE(value, i * 2);
  }
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

/** Tone frequency of variant `n` (1-based); variant files differ in pitch. */
export function variantFrequency(n: number): number {
  return 440 + 110 * (n - 1);
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
  loudnessLufs: number;
  peakMaxDbtp: number;
  ogg: boolean;
}

export interface SoundResult {
  bytes: Buffer;
  integratedLufs: number | null;
  truePeakDbtp: number | null;
}

const TRIM = 'silenceremove=start_periods=1:start_threshold=-60dB:detection=peak';
/** Fade in of a sound played once. */
const FADE_IN_MS = 2;
/** Longest fade out of a sound played once; a shorter sound fades out over its last quarter. */
const FADE_OUT_MS = 50;
/** Fewest bars of a looped `bgm`. */
const MIN_LOOP_BARS = 4;

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

/** Cuts to `maxMs`, then fades in over `FADE_IN_MS` and out over `FADE_OUT_MS` or the last quarter, whichever is shorter. */
function shapeOnce(pcm: Pcm, maxMs: number | null): Pcm {
  const { channels } = pcm;
  let count = pcm.samples.length / channels;
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
 * The loop: the first L frames, with the first X frames the equal-power crossfade of themselves (fading in) and the X
 * frames after L (fading out), so that the last frame runs on into the first. For `barMs`, X is one bar and L whole
 * bars; otherwise X is `seamMs` and L is `lengthMs` or what the file leaves after X.
 */
function shapeLoop(pcm: Pcm, shape: { lengthMs: number; seamMs: number; barMs: number | null }, file: string): Pcm {
  const { channels } = pcm;
  const count = pcm.samples.length / channels;
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

export function shapeSound(pcm: Pcm, shape: SoundShape, file: string): Pcm {
  return shape.kind === 'once' ? shapeOnce(pcm, shape.maxMs) : shapeLoop(pcm, shape, file);
}

function lastJson(text: string): Record<string, string> {
  const start = text.lastIndexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) throw new OgwError('ffmpeg loudnorm printed no measurement');
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, string>;
  } catch {
    throw new OgwError('ffmpeg loudnorm printed no measurement');
  }
}

function lastNumber(text: string, pattern: RegExp): number | null {
  let value: number | null = null;
  for (const match of text.matchAll(pattern)) {
    const parsed = Number(match[1]);
    value = Number.isFinite(parsed) ? parsed : null;
  }
  return value;
}

/**
 * A sound shorter than one BS.1770-4 gating block (400 ms) has no integrated loudness. Such a sound is measured as the
 * sound repeated for this long (`production.md` `## finalize` step 2).
 */
export const SHORT_SOUND_LOOP_MS = 1000;

/**
 * Input arguments of a sound file with its container format named, so that ffmpeg does not probe it: tonal PCM data
 * can out-score the WAV probe and be read as another container. The format is `ogg` for `.ogg`, else `wav`.
 */
function input(file: string): string[] {
  return ['-f', extname(file).toLowerCase() === '.ogg' ? 'ogg' : 'wav', '-i', file];
}

/**
 * Filters that repeat the input for `SHORT_SOUND_LOOP_MS`, with a filter after them. The `aloop` size is the largest it
 * accepts, so that it repeats the whole file. Not the `-stream_loop` input option: with `-t`, ffmpeg 6.0 then stops
 * reading without ending when the file length divides the length (100 ms of 1000 ms).
 */
const LOOPED = `aloop=loop=-1:size=2147483647,atrim=duration=${String(SHORT_SOUND_LOOP_MS / 1000)},`;

function finite(value: string | undefined): number | null {
  const parsed = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(parsed) ? parsed : null;
}

/**
 * The loudnorm first pass of a file, repeated for `SHORT_SOUND_LOOP_MS` when `looped`: integrated loudness and true
 * peak, or null when the input has no integrated loudness.
 */
async function measure(program: string, file: string, looped: boolean, norm: string): Promise<{ json: Record<string, string>; i: number | null; tp: number | null }> {
  const json = lastJson(await ffmpeg(program, [...input(file), '-af', `${looped ? LOOPED : ''}${norm}:print_format=json`, '-f', 'null', '-']));
  return { json, i: finite(json.input_i), tp: finite(json.input_tp) };
}

/** Ranges loudnorm accepts for `I` and `TP`; outside them ffmpeg refuses the filter. */
const LOUDNORM_I: readonly [number, number] = [-70, -5];
const LOUDNORM_TP: readonly [number, number] = [-9, 0];
/** Encodes of one sound at most: each one after the first lowers the gain by the true peak excess of the one before. */
const PEAK_PASSES = 4;
/** Extra gain cut of a pass after a true peak excess, so that the next encode stays under the limit. */
const PEAK_MARGIN_DB = 0.1;

/**
 * Resamples to `SAMPLE_RATE` and keeps the channel layout. `aformat` and not `aresample`: after loudnorm, ffmpeg 6.0
 * finds no channel layout for the output of an `aresample` filter and fails; it gives the resampler it inserts for
 * `aformat` the input layout.
 */
const RESAMPLE = `aformat=sample_rates=${String(SAMPLE_RATE)}`;

function clamp(value: number, [low, high]: readonly [number, number]): number {
  return Math.min(high, Math.max(low, value));
}

/** Integrated loudness and true peak of a written file from the ebur128 report, repeated as in `measure`. */
async function loudness(program: string, file: string, looped: boolean): Promise<{ i: number | null; tp: number | null }> {
  const report = await ffmpeg(program, [...input(file), '-af', `${looped ? LOOPED : ''}ebur128=peak=true`, '-f', 'null', '-']);
  return { i: lastNumber(report, /I:\s+(-?[0-9.]+|-inf) LUFS/g), tp: lastNumber(report, /Peak:\s+(-?[0-9.]+|-inf) dBFS/g) };
}

/**
 * Shapes (`SoundShape`), matches integrated loudness, limits true peak, and measures the result. A sound with integrated loudness goes
 * through loudnorm's second pass, with the bus values moved into the ranges loudnorm accepts and a gain for the rest of
 * the loudness. A sound with no integrated loudness (shorter than 400 ms) gets one gain from the measurement of the
 * sound repeated for `SHORT_SOUND_LOOP_MS`: the smaller of the gain to the loudness target and the gain to the true peak
 * limit. loudnorm's limiter and the encode can leave the written file over the true peak limit: the encode is then made
 * again with the gain lowered by the excess, and the sound fails when it stays over after `PEAK_PASSES` encodes.
 */
export async function processSound(program: string, file: string, target: SoundTarget, env: NodeJS.ProcessEnv): Promise<SoundResult> {
  const normI = clamp(target.loudnessLufs, LOUDNORM_I);
  const norm = `loudnorm=I=${String(normI)}:TP=${String(clamp(target.peakMaxDbtp, LOUDNORM_TP))}:LRA=20`;
  return withTemp(env, async (dir) => {
    const decoded = join(dir, 'decoded.wav');
    // A loop keeps its start, where its first bar starts, and loses only the silence at its end.
    const trim = target.shape.kind === 'loop' ? `areverse,${TRIM},areverse,` : target.shape.trim ? `${TRIM},areverse,${TRIM},areverse,` : '';
    await ffmpeg(program, [...input(file), '-af', `${trim}${RESAMPLE}`, '-c:a', 'pcm_f32le', '-f', 'wav', ...BITEXACT, decoded]);
    const source = join(dir, 'shaped.wav');
    await writeFile(source, writeWavF32(shapeSound(readWavF32(await readFile(decoded)), target.shape, file)));
    const out = join(dir, target.ogg ? 'out.ogg' : 'out.wav');
    const first = await measure(program, source, false, norm);
    // No true peak: no sample is left (or every sample is 0). Repeating such a file would not end.
    if (first.tp === null) throw new OgwError(`${file}: no loudness to measure; the sound is silent`);
    let short = false;
    let leveling = '';
    let gain: number;
    if (first.i !== null && finite(first.json.target_offset) !== null) {
      const measured = [
        `measured_I=${String(first.json.input_i)}`,
        `measured_TP=${String(first.json.input_tp)}`,
        `measured_LRA=${String(first.json.input_lra)}`,
        `measured_thresh=${String(first.json.input_thresh)}`,
        `offset=${String(first.json.target_offset)}`,
      ].join(':');
      leveling = `${norm}:${measured}:linear=true:print_format=summary,`;
      gain = target.loudnessLufs - normI;
    } else {
      short = true;
      const loop = await measure(program, source, true, norm);
      if (loop.i === null || loop.tp === null) throw new OgwError(`${file}: no loudness to measure; the sound is silent`);
      gain = Math.min(target.loudnessLufs - loop.i, target.peakMaxDbtp - loop.tp);
    }
    for (let pass = 1; ; pass++) {
      const volume = leveling !== '' && Math.abs(gain) < 0.005 ? '' : `volume=${gain.toFixed(2)}dB,`;
      await ffmpeg(program, [...input(source), '-af', `${leveling}${volume}${RESAMPLE}`, ...codecArgs(target.ogg), ...BITEXACT, out]);
      const result = await loudness(program, out, short);
      if (result.tp === null || result.tp <= target.peakMaxDbtp) return { bytes: await readFile(out), integratedLufs: result.i, truePeakDbtp: result.tp };
      if (pass === PEAK_PASSES) {
        throw new OgwError(`${file}: true peak ${String(result.tp)} dBTP stays over the bus limit ${String(target.peakMaxDbtp)} dBTP after ${String(PEAK_PASSES)} encodes`);
      }
      gain -= result.tp - target.peakMaxDbtp + PEAK_MARGIN_DB;
    }
  });
}
