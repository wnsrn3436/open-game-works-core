import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { gitEnv, makeGame, makeWorkspace, realHarness, type TestWorkspace } from '../../helpers/workspace.ts';
import { hasLibvorbis, installedToolProgram } from '../../../src/commands/env/lib/tools.ts';
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
 * A fake ffmpeg: logs its arguments, prints loudnorm and ebur128 reports, writes the output file. An input file that
 * contains `SHORT` (shorter than 400 ms: no integrated loudness unless repeated with `aloop`), `HUSHED` (like
 * `SHORT`, with a true peak of -30 dBTP when repeated), `SILENT` (no sample) or `PEAKY` (a true peak of -0.5 dBTP
 * after encoding) passes that mark on to the output file. An encode writes its `volume=<gain>dB` beside the output
 * (`<output>.vol`); the ebur128 report of that output is the gain plus -16 LUFS and a true peak of -9 dBTP (`PEAKY`:
 * -16 and -0.5, `SHORT`: -30 and -10, `HUSHED`: -30 and -30). A `pcm_f32le` output is a real 32-bit float WAV of
 * 10 s of silence that carries the mark in a chunk of its own.
 */
export function fakeFfmpeg(dir: string): { path: string; log: string } {
  const log = join(dir, 'ffmpeg.log');
  const path = join(dir, 'ffmpeg');
  writeFileSync(
    path,
    `#!/bin/sh
echo "$*" >> "${log}"
out=""
in=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-i" ]; then in="$a"; fi
  prev="$a"
  out="$a"
done
mark=""
if [ -f "$in" ] && grep -q SILENT "$in"; then mark="SILENT"; fi
if [ -f "$in" ] && grep -q SHORT "$in"; then mark="SHORT"; fi
if [ -f "$in" ] && grep -q HUSHED "$in"; then mark="HUSHED"; fi
if [ -f "$in" ] && grep -q PEAKY "$in"; then mark="PEAKY"; fi
json() { printf '{\\n "input_i" : "%s",\\n "input_tp" : "%s",\\n "input_lra" : "2.00",\\n "input_thresh" : "-40.00",\\n "target_offset" : "%s"\\n}\\n' "$1" "$2" "$3" >&2; }
case "$*" in
  *print_format=json*)
    case "$mark:$*" in
      SILENT:*) json -inf -inf inf;;
      SHORT:*aloop=*) json -30.00 -10.00 0.10;;
      SHORT:*) json -inf -12.00 inf;;
      HUSHED:*aloop=*) json -30.00 -30.00 0.10;;
      HUSHED:*) json -inf -32.00 inf;;
      *) json -30.00 -10.00 0.10;;
    esac
    exit 0;;
  *ebur128*)
    vol=0
    if [ -f "$in.vol" ]; then vol=$(cat "$in.vol"); fi
    case "$mark" in
      PEAKY) li=-16; base=-0.5;;
      SHORT) li=-30; base=-10;;
      HUSHED) li=-30; base=-30;;
      *) li=-16; base=-9;;
    esac
    i=$(awk -v l="$li" -v v="$vol" 'BEGIN{printf "%.1f", l + v}')
    peak=$(awk -v b="$base" -v v="$vol" 'BEGIN{printf "%.1f", b + v}')
    printf '  Integrated loudness:\\n    I:         %s LUFS\\n  True peak:\\n    Peak:       %s dBFS\\n' "$i" "$peak" >&2
    exit 0;;
  *pipe:0*) cat > /dev/null;;
esac
vol=$(echo "$*" | sed -n 's/.*volume=\\(-\\{0,1\\}[0-9.]*\\)dB.*/\\1/p')
if [ -z "$vol" ]; then vol=0; fi
echo "$vol" > "$out.vol"
case "$out:$*" in
  *.ogg:*) printf 'OggS-fake%s' "$mark" > "$out";;
  *pcm_f32le*)
    # A 32-bit float mono WAV of 10 s of silence at 48 kHz, with an ogwm chunk of the mark (8 bytes, space padded)
    { printf 'RIFF\\064\\114\\035\\000WAVEfmt \\020\\000\\000\\000\\003\\000\\001\\000\\200\\273\\000\\000\\000\\356\\002\\000\\004\\000\\040\\000data\\000\\114\\035\\000'
      head -c 1920000 /dev/zero
      printf 'ogwm\\010\\000\\000\\000%-8s' "$mark"; } > "$out";;
  *) printf 'RIFF-fake%s' "$mark" > "$out";;
esac
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
