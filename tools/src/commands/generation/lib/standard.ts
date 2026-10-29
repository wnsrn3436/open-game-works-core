import { deflateSync } from 'node:zlib';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists } from '../../../lib/fsx.ts';
import type { GenerationMethod } from '../../../lib/settings.ts';
import { toolProgram } from '../../env/api.ts';
import type { MeasuredRun } from '../../env/lib/results.ts';
import { methodDir, methodMarker, withMethodLock, type MethodMarker } from './install.ts';
import { callError, isEmptyDir, runSandboxed } from './sandbox.ts';

export interface StageValues {
  resolution?: number;
  durationMs?: number;
}

export interface CallInput {
  ctx: Context;
  method: GenerationMethod;
  marker: MethodMarker | null;
  dir: string;
  promptFile: string;
  images: string[];
  out: string;
  stage: StageValues | null;
  /** `spec` `size` of the resource key; null in the standard test job. */
  size: [number, number] | null;
  /** `spec` `length` of the resource key in ms; null in the standard test job. */
  lengthMs: number | null;
  /** `spec` `loop` of the resource key; false in the standard test job. */
  loop: boolean;
  /** The fixed seed of the standard test job; null in `generation run`. */
  seed: number | null;
}

export interface Call {
  cmd: string;
  args: string[];
  /** Added to the environment of the call. */
  env?: Record<string, string>;
}

/** The standard test job of a method: its fixed input and stages, and the calls `generation run` shares. */
export interface StandardJob {
  /** Stages from the lowest. A single `{}` is one stage without resolution and length. */
  stages: StageValues[];
  prompt: string;
  /** The job takes the fixed input image. */
  image: boolean;
  /** Files the calls leave in `out`. Without it, `out` must not be empty. */
  outputs?: string[];
  /** The program calls, run one after another. */
  call: (input: CallInput) => Promise<Call | Call[]>;
  /** One call that makes every item with the model loaded once (`generation run --batch`); absent: `call` per item. */
  batch?: (inputs: readonly CallInput[]) => Promise<Call>;
}

/** The fixed seed of every standard test job. */
export const STANDARD_SEED = 42;
/** Song made past the `spec` length of a looped key, so that a loop of whole bars and its one-bar seam fit (`production.md` `## finalize`). */
export const LOOP_TAIL_MS = 8000;
/** Resolution of an image or model call without a stage. */
export const DEFAULT_RESOLUTION = 1024;

const BLENDER_SCRIPT = [
  'import sys',
  'import bpy',
  "out = sys.argv[sys.argv.index('--') + 1]",
  'bpy.ops.wm.read_factory_settings(use_empty=True)',
  'bpy.ops.mesh.primitive_cube_add(size=1)',
  "bpy.ops.export_scene.gltf(filepath=out + '/model.glb', export_format='GLB')",
  '',
].join('\n');

const DEVICE = 'device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"';

/** Python drivers by name, which the tool writes into `<method folder>/drivers/` (`driverFile`). */
export const DRIVERS: Record<string, string> = {
  rembg: [
    'import sys',
    'from PIL import Image',
    'from rembg import new_session, remove',
    '',
    'source, target = sys.argv[1], sys.argv[2]',
    'remove(Image.open(source), session=new_session("birefnet-general")).save(target)',
    '',
  ].join('\n'),
  'ace-step': [
    'import json',
    'import os',
    'import shutil',
    'import sys',
    'import traceback',
    'import torch',
    'from acestep.handler import AceStepHandler',
    'from acestep.inference import GenerationConfig, GenerationParams, generate_music',
    'from acestep.llm_inference import LLMHandler',
    '',
    '# one item per song: {"prompt", "duration_ms", "out", "seed"}; the models load once for all of them',
    'checkpoints, jobs_file = sys.argv[1:3]',
    'with open(jobs_file, encoding="utf-8") as f:',
    '    jobs = json.load(f)',
    'project = os.path.join(os.environ["HOME"], "ace-step-project")',
    'os.makedirs(project, exist_ok=True)',
    'link = os.path.join(project, "checkpoints")',
    'if not os.path.islink(link):',
    '    os.symlink(checkpoints, link)',
    DEVICE,
    'dit = AceStepHandler()',
    'dit.initialize_service(project_root=project, config_path="acestep-v15-turbo", device=device)',
    'lm = LLMHandler()',
    'status, ready = lm.initialize(checkpoint_dir=checkpoints, lm_model_path="acestep-5Hz-lm-1.7B", backend="mlx" if device == "mps" else "pt", device=device)',
    'if not ready:',
    '    sys.exit(status)',
    'failed = 0',
    'for job in jobs:',
    '    out = job["out"]',
    '    try:',
    '        with open(job["prompt"], encoding="utf-8") as f:',
    '            caption = f.read().strip()',
    '        s = int(job["seed"])',
    '        params = GenerationParams(caption=caption, instrumental=True, duration=int(job["duration_ms"]) / 1000, seed=s, thinking=True, use_cot_metas=True, use_cot_caption=False, use_cot_language=False)',
    '        config = GenerationConfig(batch_size=1, audio_format="wav", use_random_seed=s < 0, seeds=None if s < 0 else [s])',
    '        result = generate_music(dit, lm, params, config, save_dir=os.path.join(out, "work"))',
    '        if not result.success or not result.audios:',
    '            raise RuntimeError(str(result.error))',
    '        audio = result.audios[0]',
    '        # the tempo the LM planned the song with',
    '        used = result.extra_outputs.get("lm_metadata") or {}',
    '        bpm = used.get("bpm")',
    '        if not isinstance(bpm, (int, float)) or bpm <= 0:',
    '            raise RuntimeError("the LM chose no bpm")',
    '        beats = used.get("timesignature")',
    '        beats = int(beats) if str(beats).isdigit() and int(beats) > 0 else 4',
    '        shutil.move(audio["path"], os.path.join(out, "music.wav"))',
    '        with open(os.path.join(out, "music.json"), "w", encoding="utf-8") as f:',
    '            json.dump({"bpm": bpm, "beatsPerBar": beats}, f)',
    '    except Exception:',
    '        failed += 1',
    '        print(f"{out}: failed", file=sys.stderr)',
    '        traceback.print_exc()',
    '    finally:',
    '        shutil.rmtree(os.path.join(out, "work"), ignore_errors=True)',
    'sys.exit(1 if failed else 0)',
    '',
  ].join('\n'),
  'moss-sfx': [
    'import json',
    'import os',
    'import random',
    'import sys',
    'import traceback',
    'import torch',
    '',
    'if not torch.cuda.is_available():',
    '    # torch.compile in the pipeline targets CUDA graphs',
    '    os.environ["TORCHDYNAMO_DISABLE"] = "1"',
    'import soundfile',
    'from moss_soundeffect_v2 import MossSoundEffectPipeline',
    '',
    '# one item per sound: {"prompt", "duration_ms", "target", "seed"}; the model loads once for all of them',
    'model, jobs_file = sys.argv[1:3]',
    'with open(jobs_file, encoding="utf-8") as f:',
    '    jobs = json.load(f)',
    DEVICE,
    'pipe = MossSoundEffectPipeline.from_pretrained(model, torch_dtype=torch.float32 if device == "cpu" else torch.bfloat16, device=device)',
    'full = int(pipe.max_inference_seconds)',
    'rate = int(pipe.sample_rate)',
    'failed = 0',
    'for job in jobs:',
    '    try:',
    '        seed = int(job["seed"])',
    '        s = seed if seed >= 0 else random.SystemRandom().randrange(2**31)',
    '        duration_ms = int(job["duration_ms"])',
    '        with open(job["prompt"], encoding="utf-8") as f:',
    '            prompt = f.read().strip()',
    '        told = max(0.1, round(duration_ms / 1000, 1))',
    '        # The model is told the length; the cut is 1 s later, so that the end of the sound is not cut. The pipeline makes',
    '        # the full length whatever its seconds and cuts at whole 0.1 s, so it gives the full length and the driver cuts',
    '        samples = min((2 * (duration_ms + 1000) * rate + 1000) // 2000, rate * full)',
    '        audio = pipe(prompt=f"{prompt} duration: {told:.1f}s", seconds=full, num_inference_steps=100, cfg_scale=4.0, seed=s, append_duration_suffix=False)',
    '        wav = audio.detach().cpu().to(torch.float32)',
    '        if wav.ndim == 3:',
    '            wav = wav[0]',
    '        elif wav.ndim == 1:',
    '            wav = wav.unsqueeze(0)',
    '        wav = wav[:, :samples]',
    '        soundfile.write(job["target"], wav.T.numpy(), rate)',
    '    except Exception:',
    '        failed += 1',
    '        print(f"{job[\'target\']}: failed", file=sys.stderr)',
    '        traceback.print_exc()',
    'sys.exit(1 if failed else 0)',
    '',
  ].join('\n'),
  'qwen3-tts': [
    'import json',
    'import sys',
    'import traceback',
    'import soundfile',
    'import torch',
    'from qwen_tts import Qwen3TTSModel',
    '',
    '# one item per voice line: {"prompt", "target", "seed"}; the model loads once for all of them',
    'model, jobs_file = sys.argv[1:3]',
    'with open(jobs_file, encoding="utf-8") as f:',
    '    jobs = json.load(f)',
    DEVICE,
    'tts = Qwen3TTSModel.from_pretrained(model, device_map=device, dtype=torch.float32 if device == "cpu" else torch.bfloat16)',
    'failed = 0',
    'for job in jobs:',
    '    try:',
    '        with open(job["prompt"], encoding="utf-8") as f:',
    '            prompt = json.load(f)',
    '        if int(job["seed"]) >= 0:',
    '            torch.manual_seed(int(job["seed"]))',
    '        wavs, rate = tts.generate_custom_voice(text=prompt["text"], language=prompt.get("language", "Auto"), speaker=prompt["speaker"], instruct=prompt.get("instruct", ""))',
    '        soundfile.write(job["target"], wavs[0], rate)',
    '    except Exception:',
    '        failed += 1',
    '        print(f"{job[\'target\']}: failed", file=sys.stderr)',
    '        traceback.print_exc()',
    'sys.exit(1 if failed else 0)',
    '',
  ].join('\n'),
};

function failNoPin(input: CallInput, what: string): never {
  throw new OgwError(`method ${input.method.name} has no ${what}`);
}

function pythonOf(input: CallInput): string {
  return input.marker?.python ?? failNoPin(input, 'Python environment: its pins have no git or pip pin');
}

function hfDir(input: CallInput): string {
  return input.marker?.hf[0]?.dir ?? failNoPin(input, 'hf pin');
}

function gitDir(input: CallInput): string {
  return input.marker?.git[0]?.dir ?? failNoPin(input, 'git pin');
}

/** A console script installed next to the Python of the method's isolated environment. */
function venvProgram(python: string, name: string): string {
  return join(dirname(python), process.platform === 'win32' ? `${name}.exe` : name);
}

/**
 * The file of a driver. Python puts the folder of the script first on `sys.path`, so the `ogw_` prefix keeps a
 * driver from shadowing a module it imports (`rembg.py` would shadow `rembg`).
 */
export function driverFile(name: string): string {
  return `ogw_${name}.py`;
}

/** Writes the driver into an emptied `drivers/`, so no file left there shadows a module the driver imports. */
async function driver(input: CallInput, name: string): Promise<string> {
  const folder = join(input.dir, 'drivers');
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  const file = join(folder, driverFile(name));
  await writeFile(file, DRIVERS[name] as string);
  return file;
}

/**
 * Environment of a local-model call: `HOME` in the method folder, the Hugging Face cache there with every
 * hf pin linked as `models--<org>--<name>/snapshots/<revision>`, offline Hugging Face, and the first git
 * pin checkout on `PYTHONPATH`.
 */
export async function modelEnv(input: CallInput): Promise<Record<string, string>> {
  const home = join(input.dir, 'home');
  const hfHome = join(home, '.cache', 'huggingface');
  const pins = (input.method.pins ?? []).filter((p) => p.kind === 'hf');
  for (const [index, hf] of (input.marker?.hf ?? []).entries()) {
    const revision = pins[index]?.revision;
    if (revision === undefined) continue;
    const repo = join(hfHome, 'hub', `models--${hf.source.replaceAll('/', '--')}`);
    await mkdir(join(repo, 'snapshots'), { recursive: true });
    await mkdir(join(repo, 'refs'), { recursive: true });
    const link = join(repo, 'snapshots', revision);
    await rm(link, { force: true });
    await symlink(hf.dir, link);
    await writeFile(join(repo, 'refs', 'main'), revision);
  }
  const env: Record<string, string> = { HOME: home, HF_HOME: hfHome, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' };
  const git = input.marker?.git[0]?.dir;
  if (git !== undefined) env.PYTHONPATH = git;
  return env;
}

/** Image size: `size` scaled so its long side is the stage resolution, each side rounded to a multiple of 16 (at least 16). */
export function imageSize(resolution: number | undefined, size: [number, number] | null): [number, number] {
  const long = resolution ?? DEFAULT_RESOLUTION;
  if (size === null) return [long, long];
  const scale = long / Math.max(size[0], size[1]);
  const side = (value: number): number => Math.max(16, Math.round((value * scale) / 16) * 16);
  return [side(size[0]), side(size[1])];
}

/** Output length: the `spec` length capped at the stage length; the stage length without a `spec` length. */
export function outputLengthMs(input: CallInput): number {
  const stage = input.stage?.durationMs;
  if (input.lengthMs === null) return stage ?? failNoPin(input, 'stage length or spec length');
  return stage === undefined ? input.lengthMs : Math.min(input.lengthMs, stage);
}

/** Loop length: for a looped key, the output length plus `LOOP_TAIL_MS`; else the output length. */
export function loopLengthMs(input: CallInput): number {
  return outputLengthMs(input) + (input.loop && input.lengthMs !== null ? LOOP_TAIL_MS : 0);
}

function seedArg(input: CallInput): string {
  return String(input.seed ?? -1);
}

async function flux2Call(input: CallInput): Promise<Call[]> {
  const python = pythonOf(input);
  const files = input.marker?.files ?? failNoPin(input, 'file pin');
  const env = await modelEnv(input);
  const [width, height] = imageSize(input.stage?.resolution, input.size);
  const edit = input.images.length > 0;
  const image = join(input.out, 'image.png');
  const generate: Call = {
    cmd: venvProgram(python, edit ? 'mflux-generate-flux2-edit' : 'mflux-generate-flux2'),
    args: [
      '--model',
      hfDir(input),
      '--base-model',
      'flux2-klein-4b',
      '--prompt-file',
      input.promptFile,
      '--width',
      String(width),
      '--height',
      String(height),
      '--output',
      image,
      ...(edit ? ['--image-paths', ...input.images] : []),
      ...(input.seed === null ? [] : ['--seed', String(input.seed)]),
    ],
    env,
  };
  const background: Call = { cmd: python, args: [await driver(input, 'rembg'), image, join(input.out, 'image-alpha.png')], env: { ...env, U2NET_HOME: files } };
  return [generate, background];
}

/** Writes the item list of a driver call next to the prompt of the first item, which the call reads. */
async function jobsFile(inputs: readonly CallInput[], items: readonly Record<string, unknown>[]): Promise<string> {
  const file = `${first(inputs).promptFile}.jobs.json`;
  await writeFile(file, `${JSON.stringify(items)}\n`);
  return file;
}

function first(inputs: readonly CallInput[]): CallInput {
  const input = inputs[0];
  if (input === undefined) throw new OgwError('a driver call has no item');
  return input;
}

async function aceStepBatch(inputs: readonly CallInput[]): Promise<Call> {
  const input = first(inputs);
  gitDir(input);
  const items = inputs.map((i) => ({ prompt: i.promptFile, duration_ms: loopLengthMs(i), out: i.out, seed: Number(seedArg(i)) }));
  return { cmd: pythonOf(input), args: [await driver(input, 'ace-step'), hfDir(input), await jobsFile(inputs, items)], env: await modelEnv(input) };
}

async function mossSfxBatch(inputs: readonly CallInput[]): Promise<Call> {
  const input = first(inputs);
  gitDir(input);
  const items = inputs.map((i) => ({ prompt: i.promptFile, duration_ms: outputLengthMs(i), target: join(i.out, 'sound.wav'), seed: Number(seedArg(i)) }));
  return { cmd: pythonOf(input), args: [await driver(input, 'moss-sfx'), hfDir(input), await jobsFile(inputs, items)], env: await modelEnv(input) };
}

async function qwen3TtsBatch(inputs: readonly CallInput[]): Promise<Call> {
  const input = first(inputs);
  const items = inputs.map((i) => ({ prompt: i.promptFile, target: join(i.out, 'voice.wav'), seed: Number(seedArg(i)) }));
  return { cmd: pythonOf(input), args: [await driver(input, 'qwen3-tts'), hfDir(input), await jobsFile(inputs, items)], env: await modelEnv(input) };
}

/** Faces of the `trellis2` mesh: the triangle count `production.md` gives a rigged model. */
export const TRELLIS_FACES = 20000;

async function trellis2Call(input: CallInput): Promise<Call> {
  const image = input.images[0];
  if (image === undefined || input.images.length > 1) throw new OgwError('trellis2 takes exactly one --image');
  const resolution = String(input.stage?.resolution ?? DEFAULT_RESOLUTION);
  const seed = input.seed === null ? [] : ['--seed', String(input.seed)];
  // a game model of TRELLIS_FACES faces: the default 200000 spends most of the call unwrapping the UVs of a mesh no game draws
  const args = [join(gitDir(input), 'generate.py'), '--image', image, '--output', join(input.out, 'model.glb'), '--resolution', resolution, '--no-rembg', '--target-faces', String(TRELLIS_FACES), ...seed];
  return { cmd: pythonOf(input), args, env: await modelEnv(input) };
}

async function blenderCall(input: CallInput): Promise<Call> {
  const blender = await toolProgram(input.ctx, 'blender');
  if (blender === null) throw new OgwError('tools.blender is not installed');
  const script = join(input.dir, 'standard-test.py');
  await writeFile(script, BLENDER_SCRIPT);
  return { cmd: blender, args: ['--background', '--factory-startup', '--python', script, '--', input.out] };
}

/** The standard test prompt of `qwen3-tts`: a JSON object (`tools/ogw.md` `## generation call`). */
const QWEN3_TTS_PROMPT = `${JSON.stringify({ text: 'Welcome back, hero. The gate to the next stage is open.', speaker: 'Ryan', language: 'English' })}\n`;

/** Standard test jobs, fixed in the tool. A method missing here has no standard test job and no `generation run` call. */
export const STANDARD_JOBS: Record<string, StandardJob> = {
  'flux2-klein': {
    stages: [{ resolution: 512 }, { resolution: 1024 }, { resolution: 2048 }],
    prompt: 'A red apple game item, centered, plain background, front view.',
    image: false,
    outputs: ['image.png', 'image-alpha.png'],
    call: flux2Call,
  },
  'ace-step': {
    stages: [{ durationMs: 30000 }, { durationMs: 60000 }, { durationMs: 120000 }, { durationMs: 240000 }],
    prompt: 'Upbeat chiptune battle music, 140 BPM, loopable.',
    image: false,
    outputs: ['music.wav', 'music.json'],
    call: (input) => aceStepBatch([input]),
    batch: aceStepBatch,
  },
  'moss-sfx': {
    stages: [{ durationMs: 1000 }, { durationMs: 3000 }, { durationMs: 10000 }],
    prompt: 'A short coin pickup sound.',
    image: false,
    outputs: ['sound.wav'],
    call: (input) => mossSfxBatch([input]),
    batch: mossSfxBatch,
  },
  'qwen3-tts': { stages: [{}], prompt: QWEN3_TTS_PROMPT, image: false, outputs: ['voice.wav'], call: (input) => qwen3TtsBatch([input]), batch: qwen3TtsBatch },
  trellis2: { stages: [{ resolution: 512 }, { resolution: 1024 }], prompt: '', image: true, outputs: ['model.glb'], call: trellis2Call },
  blender: { stages: [{}], prompt: '', image: false, outputs: ['model.glb'], call: blenderCall },
};

export function standardJob(name: string): StandardJob {
  const job = STANDARD_JOBS[name];
  if (!job) throw new OgwError(`method ${name} has no standard test job: tools/ogw.md ## generation call has no call for it`);
  return job;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** The fixed input image: an RGBA PNG of `size`² with an opaque red disc on a transparent background. */
export function standardImage(size: number): Buffer {
  const rows: Buffer[] = [];
  const r = size * 0.4;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const inside = (x - size / 2) ** 2 + (y - size / 2) ** 2 <= r * r;
      row.set(inside ? [220, 40, 40, 255] : [0, 0, 0, 0], 1 + x * 4);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** The out folders of a call: a batch call writes into the out folder of each item. */
function outsOf(out: string | readonly string[]): string[] {
  return typeof out === 'string' ? [out] : [...out];
}

/** Whether every out folder holds the outputs. */
async function allPresent(outs: readonly string[], outputs: readonly string[] | undefined): Promise<boolean> {
  for (const out of outs) if (!(await outputsPresent(out, outputs))) return false;
  return true;
}

export async function outputsPresent(out: string, outputs: readonly string[] | undefined): Promise<boolean> {
  if (outputs === undefined || outputs.length === 0) return !(await isEmptyDir(out));
  return outputs.every((name) => exists(join(out, name)));
}

/**
 * Runs the calls of a method one after another in the sandbox (no network, writes only in the method
 * folder and `out`) within one time limit, and stops at the first call that fails.
 */
export async function runCall(
  ctx: Context,
  method: GenerationMethod,
  calls: Call | Call[],
  out: string | readonly string[],
  timeoutMs: number,
  outputs?: readonly string[],
): Promise<MeasuredRun> {
  const outs = outsOf(out);
  const dir = await methodDir(ctx, method.name);
  const started = Date.now();
  const blocked: string[] = [];
  let maxMemoryBytes: number | null = null;
  let result: MeasuredRun['result'] = 'ok';
  let error: string | null = null;
  for (const call of Array.isArray(calls) ? calls : [calls]) {
    const left = timeoutMs - (Date.now() - started);
    const run = left > 0 ? await runSandboxed(ctx, call.cmd, call.args, [dir, ...outs], left, call.env) : null;
    if (run !== null) {
      blocked.push(...run.blocked);
      if (run.maxMemoryBytes !== null) maxMemoryBytes = Math.max(maxMemoryBytes ?? 0, run.maxMemoryBytes);
    }
    if (run === null || run.timedOut) result = 'timeout';
    else if (run.code !== 0) result = 'failed';
    if (result !== 'ok') {
      error = run === null ? null : callError(run.stderr);
      break;
    }
  }
  if (result === 'ok' && !(await allPresent(outs, outputs))) result = 'failed';
  return { jobMs: Date.now() - started, result, maxMemoryBytes, output: outs[0] as string, blocked, ...(error === null ? {} : { error }) };
}

/** Runs one stage of the standard test job of a method under the lock of the method folder. */
export function runStandardStage(ctx: Context, method: GenerationMethod, stage: StageValues): Promise<MeasuredRun> {
  return withMethodLock(ctx, method.name, () => runStandardStageLocked(ctx, method, stage));
}

async function runStandardStageLocked(ctx: Context, method: GenerationMethod, stage: StageValues): Promise<MeasuredRun> {
  const job = standardJob(method.name);
  const dir = await methodDir(ctx, method.name);
  const label = [stage.resolution, stage.durationMs].filter((v) => v !== undefined).join('-') || 'single';
  const work = join(dir, 'measure', label);
  await rm(work, { recursive: true, force: true });
  const out = join(work, 'out');
  await mkdir(out, { recursive: true });
  const promptFile = join(work, 'prompt.txt');
  await writeFile(promptFile, job.prompt);
  const images: string[] = [];
  if (job.image) {
    const image = join(work, 'input.png');
    await writeFile(image, standardImage(stage.resolution ?? 512));
    images.push(image);
  }
  const marker = await methodMarker(ctx, method);
  const calls = await job.call({ ctx, method, marker, dir, promptFile, images, out, stage, size: null, lengthMs: null, loop: false, seed: STANDARD_SEED });
  const run = await runCall(ctx, method, calls, out, method.safetyTimeoutMs, job.outputs);
  return { ...stage, ...run };
}
