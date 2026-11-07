import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { gitEnv, makeGame, makeWorkspace, realHarness, type TestWorkspace } from '../../helpers/workspace.ts';
import { hasLibvorbis, installedToolProgram } from '../../../src/commands/env/lib/tools.ts';
import type { Pcm } from '../../../src/commands/resource/lib/audio.ts';
import { COLUMNS, parseList } from '../../../src/commands/resource/lib/list.ts';
import { createContext } from '../../../src/lib/command.ts';
import { which } from '../../../src/lib/proc.ts';

/** Git commits made by ogw in-process read process.env. */
export function useGitEnv(): void {
  Object.assign(process.env, gitEnv);
}

/** Every method of the harness settings with one `ok` measured step. */
export function measuredMethods(except: readonly string[] = []): unknown[] {
  const settings = JSON.parse(readFileSync(join(realHarness, 'settings.json'), 'utf8')) as { resourceGeneration: Record<string, unknown>[] };
  return settings.resourceGeneration.map((m) => (except.includes(m.name as string) ? m : { ...m, measured: [{ result: 'ok' }] }));
}

export const GAME_SETTINGS = { engine: 'godot', baseResolution: [1280, 720], sourceLanguage: 'en', coreVersion: '1.0.0' };

export type Row = Partial<Record<(typeof COLUMNS)[number], string>>;

export function listCsv(rows: readonly Row[]): string {
  const cell = (v: string): string => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  return [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => cell(r[c] ?? '')).join(','))].join('\n') + '\n';
}

export function translationCsv(rows: readonly [string, string, string][]): string {
  return ['key,source,source_hash,current_hash,text', ...rows.map(([key, source, hash]) => `${key},${source},${hash},${hash},${source}`)].join('\n') + '\n';
}

export interface Fixture {
  ws: TestWorkspace;
  game: string;
  bin: string;
  ffmpegLog: string;
  ffmpeg: string;
  font: string;
}

/**
 * A fake ffmpeg (a Node script): logs its arguments and converts PCM, so that finalize does its own sound processing on
 * real samples. A decode (`-c:a pcm_f32le`) of a WAV writes its samples as a 32-bit float WAV (no resampling: tests use
 * 48 kHz); of a fake Ogg, the WAV inside it; of any other file, 10 s of a 440 Hz tone at 0.1 (`SILENT`: of silence).
 * An encode to WAV writes 16-bit PCM, and one to Ogg writes `OggS-fake` and the 32-bit float WAV of the samples. When
 * the file `encode-gain-db` beside the program holds a number, every encode changes the level by that many dB; when
 * `encode-overshoot-db` does, every encode raises the largest sample of each channel by that many dB, as a lossy encode
 * can. Ogg of `pipe:0` input (placeholders) is `OggS-fake`.
 */
export function fakeFfmpeg(dir: string): { path: string; log: string } {
  const log = join(dir, 'ffmpeg.log');
  const path = join(dir, 'ffmpeg');
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');
const out = args[args.length - 1];
const input = args[args.indexOf('-i') + 1];
function readWav(bytes) {
  let channels = 1, rate = 48000, format = 1, bits = 16, samples = null;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ') { format = bytes.readUInt16LE(at + 8); channels = bytes.readUInt16LE(at + 10); rate = bytes.readUInt32LE(at + 12); bits = bytes.readUInt16LE(at + 22); }
    if (id === 'data') {
      const data = bytes.subarray(at + 8, Math.min(at + 8 + size, bytes.length));
      const width = bits / 8;
      samples = new Float32Array(Math.floor(data.length / width));
      for (let i = 0; i < samples.length; i++) samples[i] = format === 3 ? data.readFloatLE(i * 4) : data.readInt16LE(i * 2) / 32768;
    }
    at += 8 + size + (size % 2);
  }
  return { channels, rate, samples };
}
function header(pcm, format, width) {
  const h = Buffer.alloc(44);
  const size = pcm.samples.length * width;
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + size, 4); h.write('WAVEfmt ', 8, 'ascii'); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(format, 20); h.writeUInt16LE(pcm.channels, 22); h.writeUInt32LE(pcm.rate, 24); h.writeUInt32LE(pcm.rate * pcm.channels * width, 28);
  h.writeUInt16LE(pcm.channels * width, 32); h.writeUInt16LE(width * 8, 34); h.write('data', 36, 'ascii'); h.writeUInt32LE(size, 40);
  return h;
}
function f32(pcm) {
  const data = Buffer.alloc(pcm.samples.length * 4);
  pcm.samples.forEach((v, i) => data.writeFloatLE(v, i * 4));
  return Buffer.concat([header(pcm, 3, 4), data]);
}
function s16(pcm) {
  const data = Buffer.alloc(pcm.samples.length * 2);
  pcm.samples.forEach((v, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2));
  return Buffer.concat([header(pcm, 1, 2), data]);
}
function decoded(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.toString('ascii', 0, 4) === 'RIFF') return readWav(bytes);
  if (bytes.toString('ascii', 0, 9) === 'OggS-fake' && bytes.length > 9) return readWav(bytes.subarray(9));
  const silent = bytes.toString().includes('SILENT');
  return { channels: 1, rate: 48000, samples: Float32Array.from({ length: 480000 }, (_, i) => (silent ? 0 : 0.1 * Math.sin((2 * Math.PI * 440 * i) / 48000))) };
}
function encoded(pcm) {
  const gainFile = path.join(${JSON.stringify(dir)}, 'encode-gain-db');
  if (fs.existsSync(gainFile)) {
    const all = 10 ** (Number(fs.readFileSync(gainFile, 'utf8')) / 20);
    pcm = { ...pcm, samples: pcm.samples.map((v) => v * all) };
  }
  const overshootFile = path.join(${JSON.stringify(dir)}, 'encode-overshoot-db');
  if (!fs.existsSync(overshootFile)) return pcm;
  const gain = 10 ** (Number(fs.readFileSync(overshootFile, 'utf8')) / 20);
  const samples = Float32Array.from(pcm.samples);
  for (let c = 0; c < pcm.channels; c++) {
    let at = c;
    for (let i = c; i < samples.length; i += pcm.channels) if (Math.abs(samples[i]) > Math.abs(samples[at])) at = i;
    samples[at] = samples[at] * gain;
  }
  return { ...pcm, samples };
}
const text = args.join(' ');
if (input === 'pipe:0') {
  fs.writeFileSync(${JSON.stringify(log)} + '.pipe', fs.readFileSync(0));
  fs.writeFileSync(out, 'OggS-fake');
} else if (text.includes('pcm_f32le')) {
  fs.writeFileSync(out, f32(decoded(input)));
} else if (text.includes('libvorbis')) {
  fs.writeFileSync(out, Buffer.concat([Buffer.from('OggS-fake'), f32(encoded(decoded(input)))]));
} else if (text.includes('pcm_s16le')) {
  fs.writeFileSync(out, s16(encoded(decoded(input))));
} else {
  process.stderr.write('fake ffmpeg: no rule for ' + text + '\\n');
  process.exit(1);
}
`,
  );
  chmodSync(path, 0o755);
  return { path, log };
}

export function makeFixture(files: Record<string, string | object>, settingsPatch: Record<string, unknown> = {}): Fixture {
  useGitEnv();
  const ws = makeWorkspace({ resourceGeneration: measuredMethods(), ...settingsPatch });
  const bin = join(ws.root, 'bin');
  mkdirSync(bin);
  const ff = fakeFfmpeg(bin);
  const font = join(bin, 'placeholder.ttf');
  writeFileSync(font, 'FAKE-TTF');
  makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS, ...files });
  return { ws, game: join(ws.games, 'g'), bin, ffmpegLog: ff.log, ffmpeg: ff.path, font };
}

export function readList(game: string): Record<string, string>[] {
  return parseList(readFileSync(join(game, 'resource/resources.csv'), 'utf8'), 'resources.csv');
}

export function rowOf(game: string, key: string): Record<string, string> {
  const row = readList(game).find((r) => r.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
}

/** A PNG of solid RGBA pixels with an optional transparent border. */
export async function png(path: string, width: number, height: number, color: [number, number, number, number], border = 0): Promise<void> {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < border || y < border || x >= width - border || y >= height - border) continue;
      data.set(color, (y * width + x) * 4);
    }
  }
  mkdirSync(join(path, '..'), { recursive: true });
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(path);
}

export async function pixels(path: string): Promise<{ width: number; height: number; data: Buffer }> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/** 16-bit PCM WAV at 48 kHz; `channels[c][i]` is sample `i` of channel `c` in [-1, 1]. */
export function pcmWav(channels: readonly (readonly number[])[]): Buffer {
  const frames = channels[0]?.length ?? 0;
  const data = Buffer.alloc(frames * channels.length * 2);
  for (let i = 0; i < frames; i++) {
    for (const [c, samples] of channels.entries()) data.writeInt16LE(Math.round((samples[i] ?? 0) * 32767), (i * channels.length + c) * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels.length, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(48000 * channels.length * 2, 28);
  header.writeUInt16LE(channels.length * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Length in ms of a PCM WAV file, from its `fmt ` and `data` chunks. */
export function wavLengthMs(path: string): number {
  const bytes = readFileSync(path);
  let blockAlign = 0;
  let rate = 0;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      rate = bytes.readUInt32LE(at + 12);
      blockAlign = bytes.readUInt16LE(at + 20);
    }
    if (id === 'data') return (size / blockAlign / rate) * 1000;
    at += 8 + size + (size % 2);
  }
  throw new Error(`${path} has no data chunk`);
}

/** A sine of `ms` ms, rounded to whole 48 kHz samples. */
export function sine(ms: number, frequency: number, amplitude: number): number[] {
  return Array.from({ length: Math.round((ms * 48000) / 1000) }, (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * (i + 0.5)) / 48000));
}

/** A 440 Hz tone of `tone` amplitude with a one-sample peak of `spike` every 100 ms, `ms` long. */
export function spiky(ms: number, tone: number, spike: number): number[] {
  return sine(ms, 440, tone).map((v, i) => (i % 4800 === 2400 ? spike : v));
}

/** The samples of a written sound file: a 16-bit or 32-bit float WAV, or the fake Ogg of `fakeFfmpeg`. */
export function readPcm(path: string): Pcm {
  let bytes = readFileSync(path);
  if (bytes.toString('ascii', 0, 9) === 'OggS-fake') bytes = bytes.subarray(9);
  let channels = 1;
  let sampleRate = 48000;
  let bits = 16;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      channels = bytes.readUInt16LE(at + 10);
      sampleRate = bytes.readUInt32LE(at + 12);
      bits = bytes.readUInt16LE(at + 22);
    }
    if (id === 'data') {
      const width = bits / 8;
      const samples = Float32Array.from({ length: Math.floor(size / width) }, (_, i) => (bits === 32 ? bytes.readFloatLE(at + 8 + i * 4) : bytes.readInt16LE(at + 8 + i * 2) / 32768));
      return { channels, sampleRate, samples, chunks: Buffer.alloc(0) };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${path} has no data chunk`);
}

export function silence(ms: number): number[] {
  return new Array<number>((ms * 48000) / 1000).fill(0);
}

/**
 * Real ffmpeg programs of this host for tests that run them: the installed harness settings `tools.ffmpeg` pin, then
 * the one on PATH when it is another file. `ogg`: it has the `libvorbis` encoder.
 */
export async function realFfmpegs(): Promise<{ name: string; program: string; ogg: boolean }[]> {
  const ctx = createContext({ cwd: realHarness, env: process.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
  const pinned = await installedToolProgram(ctx, 'ffmpeg', (await ctx.settings()).tools.ffmpeg);
  const path = await which('ffmpeg');
  const found = [
    ...(pinned === null ? [] : [{ name: 'pinned', program: pinned }]),
    ...(path === null || (pinned !== null && realpathSync(path) === realpathSync(pinned)) ? [] : [{ name: 'PATH', program: path }]),
  ];
  return Promise.all(found.map(async (f) => ({ ...f, ogg: await hasLibvorbis(ctx, f.program) })));
}
