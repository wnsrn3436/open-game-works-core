import { readFile, rm } from 'node:fs/promises';
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

export interface SoundTarget {
  /** Cut the leading and trailing parts where every channel's sample is below -60 dBFS. */
  trim: boolean;
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
 * Trims, matches integrated loudness, limits true peak, and measures the result. A sound with integrated loudness goes
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
    let source = file;
    if (target.trim) {
      source = join(dir, 'trimmed.wav');
      await ffmpeg(program, [...input(file), '-af', `${TRIM},areverse,${TRIM},areverse`, '-c:a', 'pcm_f32le', '-f', 'wav', ...BITEXACT, source]);
    }
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
