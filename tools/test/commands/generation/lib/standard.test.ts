import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, readlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MethodMarker } from '../../../../src/commands/generation/lib/install.ts';
import {
  DEFAULT_RESOLUTION,
  DRIVERS,
  driverFile,
  imageSize,
  loopLengthMs,
  modelEnv,
  outputLengthMs,
  STANDARD_JOBS,
  STANDARD_SEED,
  standardJob,
  type Call,
  type CallInput,
} from '../../../../src/commands/generation/lib/standard.ts';
import type { Context } from '../../../../src/lib/command.ts';
import type { GenerationMethod } from '../../../../src/lib/settings.ts';

const REV = 'a'.repeat(40);

function method(name: string, kind: GenerationMethod['kind'] = 'local-model'): GenerationMethod {
  return {
    name,
    kind,
    resourceTypes: ['image'],
    safetyTimeoutMs: 1,
    pins: [
      { kind: 'git', source: 'https://example.com/r.git', revision: REV },
      { kind: 'hf', source: 'org/model', revision: REV, files: '*' },
      { kind: 'hf', source: 'org/other', revision: 'b'.repeat(40), files: '*' },
    ],
  };
}

function marker(dir: string, patch: Partial<MethodMarker> = {}): MethodMarker {
  return {
    name: 'm',
    pins: '[]',
    git: [{ source: 'https://example.com/r.git', dir: join(dir, 'git', '0'), revision: REV }],
    hf: [
      { source: 'org/model', dir: join(dir, 'hf', '1') },
      { source: 'org/other', dir: join(dir, 'hf', '2') },
    ],
    files: join(dir, 'files'),
    python: join(dir, 'venv', 'bin', 'python'),
    cli: null,
    skill: null,
    ...patch,
  };
}

function input(name: string, patch: Partial<CallInput> = {}): CallInput {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-standard-')));
  return {
    ctx: {} as Context,
    method: method(name),
    marker: marker(dir),
    dir,
    promptFile: join(dir, 'prompt.txt'),
    images: [],
    out: join(dir, 'out'),
    stage: null,
    size: null,
    lengthMs: null,
    loop: false,
    seed: null,
    ...patch,
  };
}

async function calls(name: string, patch: Partial<CallInput> = {}): Promise<{ list: Call[]; input: CallInput }> {
  const i = input(name, patch);
  const result = await standardJob(name).call(i);
  return { list: Array.isArray(result) ? result : [result], input: i };
}

describe('standard test jobs', () => {
  it('fixes stages, prompts, inputs and outputs per method', () => {
    expect(STANDARD_SEED).toBe(42);
    expect(DEFAULT_RESOLUTION).toBe(1024);
    expect(STANDARD_JOBS['flux2-klein']).toMatchObject({ stages: [{ resolution: 512 }, { resolution: 1024 }, { resolution: 2048 }], image: false, outputs: ['image.png', 'image-alpha.png'] });
    expect(STANDARD_JOBS['ace-step']).toMatchObject({ stages: [{ durationMs: 30000 }, { durationMs: 60000 }, { durationMs: 120000 }, { durationMs: 240000 }], image: false });
    expect(STANDARD_JOBS['ace-step']?.outputs).toEqual(['music.wav', 'music.json']);
    expect(STANDARD_JOBS['moss-sfx']).toMatchObject({ stages: [{ durationMs: 1000 }, { durationMs: 3000 }, { durationMs: 10000 }], outputs: ['sound.wav'] });
    expect(STANDARD_JOBS['qwen3-tts']).toMatchObject({ stages: [{}], outputs: ['voice.wav'] });
    expect(JSON.parse(STANDARD_JOBS['qwen3-tts']?.prompt ?? '')).toEqual({ text: 'Welcome back, hero. The gate to the next stage is open.', speaker: 'Ryan', language: 'English' });
    expect(STANDARD_JOBS.trellis2).toMatchObject({ stages: [{ resolution: 512 }, { resolution: 1024 }], image: true, outputs: ['model.glb'] });
    expect(STANDARD_JOBS.blender).toMatchObject({ stages: [{}], outputs: ['model.glb'] });
    expect(() => standardJob('nothing')).toThrow('method nothing has no standard test job: tools/ogw.md ## generation call has no call for it');
  });

  it('sizes images from the stage resolution and the spec size', () => {
    expect(imageSize(512, null)).toEqual([512, 512]);
    expect(imageSize(undefined, null)).toEqual([1024, 1024]);
    expect(imageSize(1024, [900, 300])).toEqual([1024, 336]);
    expect(imageSize(512, [100, 1])).toEqual([512, 16]);
    expect(imageSize(undefined, [64, 128])).toEqual([512, 1024]);
  });

  it('takes the spec length capped at the stage length', () => {
    expect(outputLengthMs(input('ace-step', { stage: { durationMs: 30000 } }))).toBe(30000);
    expect(outputLengthMs(input('ace-step', { stage: { durationMs: 30000 }, lengthMs: 12000 }))).toBe(12000);
    expect(outputLengthMs(input('ace-step', { stage: { durationMs: 30000 }, lengthMs: 90000 }))).toBe(30000);
    expect(outputLengthMs(input('ace-step', { stage: null, lengthMs: 5000 }))).toBe(5000);
    expect(() => outputLengthMs(input('ace-step'))).toThrow('method ace-step has no stage length or spec length');
  });

  it('adds the loop tail to the output length of a looped key', () => {
    expect(loopLengthMs(input('ace-step', { stage: { durationMs: 120000 }, lengthMs: 90000, loop: true }))).toBe(98000);
    expect(loopLengthMs(input('ace-step', { stage: { durationMs: 120000 }, lengthMs: 120000, loop: true }))).toBe(128000);
    expect(loopLengthMs(input('ace-step', { stage: { durationMs: 60000 }, lengthMs: 90000, loop: true }))).toBe(68000);
    expect(loopLengthMs(input('ace-step', { stage: null, lengthMs: 5000, loop: true }))).toBe(13000);
    expect(loopLengthMs(input('ace-step', { stage: { durationMs: 120000 }, lengthMs: 90000 }))).toBe(90000);
    expect(loopLengthMs(input('ace-step', { stage: { durationMs: 30000 } }))).toBe(30000);
  });

  it('links hf pins into the Hugging Face cache of the method home', async () => {
    const i = input('qwen3-tts');
    const env = await modelEnv(i);
    const hub = join(i.dir, 'home', '.cache', 'huggingface');
    expect(env).toEqual({ HOME: join(i.dir, 'home'), HF_HOME: hub, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONPATH: join(i.dir, 'git', '0') });
    expect(readlinkSync(join(hub, 'hub', 'models--org--model', 'snapshots', REV))).toBe(join(i.dir, 'hf', '1'));
    expect(readFileSync(join(hub, 'hub', 'models--org--model', 'refs', 'main'), 'utf8')).toBe(REV);
    expect(readlinkSync(join(hub, 'hub', 'models--org--other', 'snapshots', 'b'.repeat(40)))).toBe(join(i.dir, 'hf', '2'));
    await modelEnv(i);
    expect(readlinkSync(join(hub, 'hub', 'models--org--model', 'snapshots', REV))).toBe(join(i.dir, 'hf', '1'));
    const bare = input('qwen3-tts', { marker: marker(i.dir, { git: [], hf: [] }) });
    expect(await modelEnv(bare)).not.toHaveProperty('PYTHONPATH');
    const noRevision = input('qwen3-tts', { method: { ...method('x'), pins: [{ kind: 'hf', source: 'org/model' }] } });
    await modelEnv(noRevision);
    expect(() => readlinkSync(join(noRevision.dir, 'home', '.cache', 'huggingface', 'hub', 'models--org--model', 'snapshots', REV))).toThrow();
  });

  it('calls mflux and then rembg for flux2-klein', async () => {
    const { list, input: i } = await calls('flux2-klein', { stage: { resolution: 512 }, size: [256, 128], seed: 42 });
    const bin = join(i.dir, 'venv', 'bin');
    expect(list[0]).toMatchObject({
      cmd: join(bin, 'mflux-generate-flux2'),
      args: ['--model', join(i.dir, 'hf', '1'), '--base-model', 'flux2-klein-4b', '--prompt-file', i.promptFile, '--width', '512', '--height', '256', '--output', join(i.out, 'image.png'), '--seed', '42'],
    });
    expect(list[0]?.env).toMatchObject({ HF_HUB_OFFLINE: '1' });
    expect(list[1]).toMatchObject({ cmd: join(bin, 'python'), args: [join(i.dir, 'drivers', 'ogw_rembg.py'), join(i.out, 'image.png'), join(i.out, 'image-alpha.png')] });
    expect(list[1]?.env).toMatchObject({ U2NET_HOME: join(i.dir, 'files'), HF_HUB_OFFLINE: '1' });
    expect(readFileSync(join(i.dir, 'drivers', 'ogw_rembg.py'), 'utf8')).toBe(DRIVERS.rembg);
    const edit = await calls('flux2-klein', { images: ['/a.png', '/b.png'] });
    expect(edit.list[0]?.cmd).toBe(join(edit.input.dir, 'venv', 'bin', 'mflux-generate-flux2-edit'));
    expect(edit.list[0]?.args.slice(6)).toEqual(['--width', '1024', '--height', '1024', '--output', join(edit.input.out, 'image.png'), '--image-paths', '/a.png', '/b.png']);
    await expect(calls('flux2-klein', { marker: marker('/m', { files: null }) })).rejects.toThrow('method flux2-klein has no file pin');
    await expect(calls('flux2-klein', { marker: marker('/m', { python: null }) })).rejects.toThrow('method flux2-klein has no Python environment: its pins have no git or pip pin');
    await expect(calls('flux2-klein', { marker: null })).rejects.toThrow('method flux2-klein has no Python environment');
  });

  it('names no driver file after a module the driver imports, and leaves no other file in drivers/', async () => {
    for (const [name, script] of Object.entries(DRIVERS)) {
      const imported = [...script.matchAll(/^(?:from|import)\s+([A-Za-z_][\w.]*)/gm)].map((m) => (m[1] as string).split('.')[0]);
      expect(imported.length).toBeGreaterThan(0);
      expect(imported).not.toContain(driverFile(name).replace(/\.py$/, ''));
    }
    const i = input('flux2-klein');
    mkdirSync(join(i.dir, 'drivers'), { recursive: true });
    writeFileSync(join(i.dir, 'drivers', 'rembg.py'), 'stale');
    await standardJob('flux2-klein').call(i);
    expect(readdirSync(join(i.dir, 'drivers'))).toEqual(['ogw_rembg.py']);
    expect(existsSync(join(i.dir, 'drivers', 'rembg.py'))).toBe(false);
  });

  it('calls the ace-step, moss-sfx and qwen3-tts drivers', async () => {
    const looped = await calls('ace-step', { stage: { durationMs: 120000 }, lengthMs: 60000, loop: true });
    expect(JSON.parse(readFileSync(looped.list[0]?.args[2] ?? '', 'utf8'))).toEqual([{ prompt: looped.input.promptFile, duration_ms: 68000, out: looped.input.out, seed: -1 }]);
    const ace = await calls('ace-step', { stage: { durationMs: 30000 }, seed: 42 });
    expect(ace.list).toHaveLength(1);
    expect(ace.list[0]).toMatchObject({ cmd: join(ace.input.dir, 'venv', 'bin', 'python'), args: [join(ace.input.dir, 'drivers', 'ogw_ace-step.py'), join(ace.input.dir, 'hf', '1'), `${ace.input.promptFile}.jobs.json`] });
    expect(JSON.parse(readFileSync(`${ace.input.promptFile}.jobs.json`, 'utf8'))).toEqual([{ prompt: ace.input.promptFile, duration_ms: 30000, out: ace.input.out, seed: 42 }]);
    expect(ace.list[0]?.env?.PYTHONPATH).toBe(join(ace.input.dir, 'git', '0'));
    expect(readFileSync(join(ace.input.dir, 'drivers', 'ogw_ace-step.py'), 'utf8')).toBe(DRIVERS['ace-step']);
    const moss = await calls('moss-sfx', { stage: { durationMs: 3000 }, lengthMs: 800 });
    expect(moss.list[0]?.args).toEqual([join(moss.input.dir, 'drivers', 'ogw_moss-sfx.py'), join(moss.input.dir, 'hf', '1'), `${moss.input.promptFile}.jobs.json`]);
    expect(JSON.parse(readFileSync(`${moss.input.promptFile}.jobs.json`, 'utf8'))).toEqual([{ prompt: moss.input.promptFile, duration_ms: 800, target: join(moss.input.out, 'sound.wav'), seed: -1 }]);
    const qwen = await calls('qwen3-tts');
    expect(qwen.list[0]?.args).toEqual([join(qwen.input.dir, 'drivers', 'ogw_qwen3-tts.py'), join(qwen.input.dir, 'hf', '1'), `${qwen.input.promptFile}.jobs.json`]);
    expect(JSON.parse(readFileSync(`${qwen.input.promptFile}.jobs.json`, 'utf8'))).toEqual([{ prompt: qwen.input.promptFile, target: join(qwen.input.out, 'voice.wav'), seed: -1 }]);
    await expect(calls('ace-step', { stage: { durationMs: 1 }, marker: marker('/m', { git: [] }) })).rejects.toThrow('method ace-step has no git pin');
    await expect(calls('moss-sfx', { stage: { durationMs: 1 }, marker: marker('/m', { git: [] }) })).rejects.toThrow('method moss-sfx has no git pin');
    await expect(calls('qwen3-tts', { marker: marker('/m', { hf: [] }) })).rejects.toThrow('method qwen3-tts has no hf pin');
  });

  it('calls generate.py of the trellis2 checkout with one image', async () => {
    const t = await calls('trellis2', { images: ['/in.png'], stage: { resolution: 512 }, seed: 42 });
    expect(t.list[0]).toMatchObject({
      cmd: join(t.input.dir, 'venv', 'bin', 'python'),
      args: [join(t.input.dir, 'git', '0', 'generate.py'), '--image', '/in.png', '--output', join(t.input.out, 'model.glb'), '--resolution', '512', '--no-rembg', '--target-faces', '20000', '--seed', '42'],
    });
    const run = await calls('trellis2', { images: ['/in.png'] });
    expect(run.list[0]?.args.slice(5)).toEqual(['--resolution', '1024', '--no-rembg', '--target-faces', '20000']);
    await expect(calls('trellis2')).rejects.toThrow('trellis2 takes exactly one --image');
    await expect(calls('trellis2', { images: ['/a', '/b'] })).rejects.toThrow('trellis2 takes exactly one --image');
  });
});

/** `python3` on PATH, or null: the driver runs below need it. */
const python = ((): string | null => {
  const found = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : null;
})();

/**
 * Stub modules of the libraries the drivers import. Each records the arguments it gets into the JSON file
 * `STUB_RECORD`; `STUB_DEVICE` is the available device (`mps`, `cuda`, or none), `STUB_LM_METADATA` the
 * `lm_metadata` that `generate_music` returns, and `STUB_LM_FAIL` makes the LM fail to start.
 */
const STUBS: Record<string, string> = {
  'stub_record.py': [
    'import json, os',
    'def record(name, value):',
    '    path = os.environ["STUB_RECORD"]',
    '    data = json.load(open(path)) if os.path.exists(path) else {}',
    '    data[name] = value',
    '    json.dump(data, open(path, "w"))',
  ].join('\n'),
  'torch/__init__.py': [
    'import os',
    'float32 = "float32"',
    'bfloat16 = "bfloat16"',
    'class _Device:',
    '    def __init__(self, name):',
    '        self.name = name',
    '    def is_available(self):',
    '        return os.environ.get("STUB_DEVICE") == self.name',
    'cuda = _Device("cuda")',
    'class backends:',
    '    mps = _Device("mps")',
    'def manual_seed(seed):',
    '    from stub_record import record',
    '    record("seed", seed)',
    'class Tensor:',
    '    def __init__(self, shape):',
    '        self.shape = tuple(shape)',
    '    ndim = property(lambda self: len(self.shape))',
    '    T = property(lambda self: Tensor(reversed(self.shape)))',
    '    def detach(self):',
    '        return self',
    '    def cpu(self):',
    '        return self',
    '    def to(self, dtype):',
    '        return self',
    '    def numpy(self):',
    '        return self',
    '    def unsqueeze(self, dim):',
    '        return Tensor((1,) + self.shape)',
    '    def __getitem__(self, index):',
    '        if isinstance(index, int):',
    '            return Tensor(self.shape[1:])',
    '        shape = list(self.shape)',
    '        for i, part in enumerate(index):',
    '            shape[i] = len(range(*part.indices(shape[i])))',
    '        return Tensor(shape)',
  ].join('\n'),
  'soundfile/__init__.py': [
    'from stub_record import record',
    'def write(target, data, rate):',
    '    record("write", {"shape": list(data.shape), "rate": rate})',
    '    open(target, "w").write("wav")',
  ].join('\n'),
  'moss_soundeffect_v2/__init__.py': [
    'import os',
    'import torch',
    'from stub_record import record',
    'class MossSoundEffectPipeline:',
    '    sample_rate = 48000',
    '    max_inference_seconds = 30',
    '    @classmethod',
    '    def from_pretrained(cls, model, torch_dtype, device):',
    '        record("from_pretrained", {"model": model, "dtype": torch_dtype, "device": device, "dynamo": os.environ.get("TORCHDYNAMO_DISABLE")})',
    '        open(os.environ["STUB_RECORD"] + ".loads", "a").write("load\\n")',
    '        return cls()',
    '    def __call__(self, **kwargs):',
    '        record("call", kwargs)',
    '        # as the pipeline: the full length, cut at whole 0.1 s',
    '        seconds = round(float(kwargs["seconds"]), 1)',
    '        if seconds > self.max_inference_seconds:',
    '            raise ValueError("seconds exceeds max_inference_seconds")',
    '        return torch.Tensor((1, 1, int(self.sample_rate * seconds)))',
  ].join('\n'),
  'acestep/__init__.py': '',
  'acestep/handler.py': [
    'import os',
    'from stub_record import record',
    'class AceStepHandler:',
    '    def initialize_service(self, **kwargs):',
    '        record("initialize_service", kwargs)',
    '        open(os.environ["STUB_RECORD"] + ".loads", "a").write("load\\n")',
  ].join('\n'),
  'qwen_tts/__init__.py': [
    'import torch',
    'from stub_record import record',
    'class Qwen3TTSModel:',
    '    @classmethod',
    '    def from_pretrained(cls, model, device_map, dtype):',
    '        record("from_pretrained", {"model": model, "device": device_map, "dtype": dtype})',
    '        return cls()',
    '    def generate_custom_voice(self, text, language, speaker, instruct):',
    '        record("voice", {"text": text, "language": language, "speaker": speaker, "instruct": instruct})',
    '        return [torch.Tensor((24000,))], 24000',
  ].join('\n'),
  'acestep/llm_inference.py': [
    'import os',
    'from stub_record import record',
    'class LLMHandler:',
    '    def initialize(self, **kwargs):',
    '        record("lm_initialize", kwargs)',
    '        return ("lm failed", False) if os.environ.get("STUB_LM_FAIL") else ("ok", True)',
  ].join('\n'),
  'acestep/inference.py': [
    'import json, os',
    'from types import SimpleNamespace',
    'from stub_record import record',
    'class GenerationParams:',
    '    def __init__(self, **kwargs):',
    '        record("params", kwargs)',
    'class GenerationConfig:',
    '    def __init__(self, **kwargs):',
    '        record("config", kwargs)',
    'def generate_music(dit, lm, params, config, save_dir):',
    '    record("save_dir", save_dir)',
    '    os.makedirs(save_dir, exist_ok=True)',
    '    path = os.path.join(save_dir, "song.wav")',
    '    open(path, "w").write("song")',
    '    return SimpleNamespace(success=True, error=None, audios=[{"path": path}], extra_outputs={"lm_metadata": json.loads(os.environ["STUB_LM_METADATA"])})',
  ].join('\n'),
};

interface DriverRun {
  code: number | null;
  stderr: string;
  record: Record<string, unknown>;
  dir: string;
}

/**
 * Runs a driver with `python3` and the stub modules on `PYTHONPATH`; `args` and the strings of the items of `jobs`
 * (written to `<dir>/jobs.json`) get `<dir>` replaced by the run folder.
 */
function runDriver(name: string, args: string[], env: Record<string, string> = {}, jobs: Record<string, unknown>[] = []): DriverRun {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-driver-')));
  const stubs = join(dir, 'stubs');
  for (const [file, text] of Object.entries(STUBS)) {
    mkdirSync(join(stubs, file, '..'), { recursive: true });
    writeFileSync(join(stubs, file), `${text}\n`);
  }
  mkdirSync(join(dir, 'drivers'));
  mkdirSync(join(dir, 'home'));
  mkdirSync(join(dir, 'out'));
  writeFileSync(join(dir, 'prompt.txt'), 'A coin pickup.\n');
  writeFileSync(join(dir, 'home', 'line.json'), JSON.stringify({ text: 'Hi.', speaker: 'Ryan', language: 'English' }));
  const items = jobs.map((job) => Object.fromEntries(Object.entries(job).map(([k, v]) => [k, typeof v === 'string' ? v.replaceAll('<dir>', dir) : v])));
  writeFileSync(join(dir, 'jobs.json'), JSON.stringify(items));
  const script = join(dir, 'drivers', driverFile(name));
  writeFileSync(script, DRIVERS[name] as string);
  const record = join(dir, 'record.json');
  const run = spawnSync(python as string, [script, ...args.map((a) => a.replaceAll('<dir>', dir))], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: join(dir, 'home'), PYTHONPATH: stubs, STUB_RECORD: record, ...env },
  });
  return { code: run.status, stderr: run.stderr, record: existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as Record<string, unknown>) : {}, dir };
}

describe.runIf(python !== null)('drivers against stub libraries', () => {
  const ace = (seed: string, metadata: unknown, env: Record<string, string> = {}): DriverRun =>
    runDriver('ace-step', ['<dir>/checkpoints', '<dir>/jobs.json'], { STUB_LM_METADATA: JSON.stringify(metadata), ...env }, [{ prompt: '<dir>/prompt.txt', duration_ms: 68000, out: '<dir>/out', seed: Number(seed) }]);

  it('ace-step makes the song with the LM, moves the WAV to music.wav and writes the tempo the LM chose', () => {
    const run = ace('42', { bpm: 120 }, { STUB_DEVICE: 'mps' });
    expect(run).toMatchObject({ code: 0, stderr: '' });
    const project = join(run.dir, 'home', 'ace-step-project');
    expect(readlinkSync(join(project, 'checkpoints'))).toBe(join(run.dir, 'checkpoints'));
    expect(run.record).toEqual({
      initialize_service: { project_root: project, config_path: 'acestep-v15-turbo', device: 'mps' },
      lm_initialize: { checkpoint_dir: join(run.dir, 'checkpoints'), lm_model_path: 'acestep-5Hz-lm-1.7B', backend: 'mlx', device: 'mps' },
      params: { caption: 'A coin pickup.', instrumental: true, duration: 68, seed: 42, thinking: true, use_cot_metas: true, use_cot_caption: false, use_cot_language: false },
      config: { batch_size: 1, audio_format: 'wav', use_random_seed: false, seeds: [42] },
      save_dir: join(run.dir, 'out', 'work'),
    });
    expect(readdirSync(join(run.dir, 'out')).sort()).toEqual(['music.json', 'music.wav']);
    expect(readFileSync(join(run.dir, 'out', 'music.wav'), 'utf8')).toBe('song');
    // no timesignature: 4 beats per bar
    expect(JSON.parse(readFileSync(join(run.dir, 'out', 'music.json'), 'utf8'))).toEqual({ bpm: 120, beatsPerBar: 4 });
  });

  it('ace-step uses a random seed for -1, the pt LM without MPS, and the timesignature the LM chose', () => {
    const run = ace('-1', { bpm: 90, timesignature: '3' });
    expect(run.code).toBe(0);
    expect(run.record).toMatchObject({ lm_initialize: { backend: 'pt', device: 'cpu' }, params: { seed: -1 }, config: { use_random_seed: true, seeds: null } });
    expect(JSON.parse(readFileSync(join(run.dir, 'out', 'music.json'), 'utf8'))).toEqual({ bpm: 90, beatsPerBar: 3 });
    expect(ace('7', { bpm: 100, timesignature: '0' }, { STUB_DEVICE: 'cuda' }).record).toMatchObject({ lm_initialize: { backend: 'pt', device: 'cuda' } });
  });

  it('ace-step fails when the LM chose no bpm or does not start', () => {
    const none = ace('42', { timesignature: '4' });
    expect(none.code).not.toBe(0);
    expect(none.stderr).toContain('the LM chose no bpm');
    expect(readdirSync(join(none.dir, 'out'))).toEqual(['ogw-error.txt']);
    expect(readFileSync(join(none.dir, 'out', 'ogw-error.txt'), 'utf8')).toBe('RuntimeError: the LM chose no bpm\n');
    const lm = ace('42', { bpm: 120 }, { STUB_LM_FAIL: '1' });
    expect(lm.code).not.toBe(0);
    expect(lm.stderr).toContain('lm failed');
    expect(lm.record).not.toHaveProperty('params');
  });

  it('ace-step loads the models once for every song and goes on past a song it cannot make', () => {
    const run = runDriver('ace-step', ['<dir>/checkpoints', '<dir>/jobs.json'], { STUB_LM_METADATA: JSON.stringify({ bpm: 120 }) }, [
      { prompt: '<dir>/missing.txt', duration_ms: 30000, out: '<dir>/out', seed: 1 },
      { prompt: '<dir>/prompt.txt', duration_ms: 30000, out: '<dir>/home', seed: 2 },
    ]);
    expect(run.code).toBe(1);
    expect(readFileSync(join(run.dir, 'out', 'ogw-error.txt'), 'utf8')).toMatch(/^FileNotFoundError: /);
    expect(readdirSync(join(run.dir, 'home')).filter((f) => f.startsWith('music')).sort()).toEqual(['music.json', 'music.wav']);
    expect(readFileSync(join(run.dir, 'record.json.loads'), 'utf8')).toBe('load\n');
  });

  it('qwen3-tts loads the model once, makes each voice line with its seed and writes why one failed', () => {
    const run = runDriver('qwen3-tts', ['<dir>/model', '<dir>/jobs.json'], { STUB_LINE: '1' }, [
      { prompt: '<dir>/prompt.txt', target: '<dir>/out/voice.wav', seed: 7 },
      { prompt: '<dir>/home/line.json', target: '<dir>/home/voice.wav', seed: 9 },
    ]);
    // prompt.txt is not JSON: the first line fails; the second is made
    expect(run.code).toBe(1);
    expect(readFileSync(join(run.dir, 'out', 'ogw-error.txt'), 'utf8')).toMatch(/^JSONDecodeError: /);
    expect(readdirSync(join(run.dir, 'home')).filter((f) => f.endsWith('.wav'))).toEqual(['voice.wav']);
    expect(run.record).toMatchObject({
      from_pretrained: { model: join(run.dir, 'model'), device: 'cpu', dtype: 'float32' },
      voice: { text: 'Hi.', language: 'English', speaker: 'Ryan', instruct: '' },
      seed: 9,
    });
  });

  const moss = (durationMs: number, seed: string, env: Record<string, string> = {}): DriverRun =>
    runDriver('moss-sfx', ['<dir>/model', '<dir>/jobs.json'], env, [{ prompt: '<dir>/prompt.txt', duration_ms: durationMs, target: '<dir>/out/sound.wav', seed: Number(seed) }]);

  it('moss-sfx tells the model the length and cuts the sound at the output length + 1000 ms', () => {
    const run = moss(1234, '42');
    expect(run).toMatchObject({ code: 0, stderr: '' });
    expect(run.record).toEqual({
      from_pretrained: { model: join(run.dir, 'model'), dtype: 'float32', device: 'cpu', dynamo: '1' },
      call: { prompt: 'A coin pickup. duration: 1.2s', seconds: 30, num_inference_steps: 100, cfg_scale: 4.0, seed: 42, append_duration_suffix: false },
      // 2234 ms at 48000 Hz, mono
      write: { shape: [107232, 1], rate: 48000 },
    });
    expect(readFileSync(join(run.dir, 'out', 'sound.wav'), 'utf8')).toBe('wav');
    expect(moss(1260, '42').record).toMatchObject({ write: { shape: [108480, 1] } });
    expect(moss(800, '42').record).toMatchObject({ call: { prompt: 'A coin pickup. duration: 0.8s' }, write: { shape: [86400, 1] } });
    // at most the pipeline maximum
    expect(moss(29500, '42').record).toMatchObject({ call: { prompt: 'A coin pickup. duration: 29.5s' }, write: { shape: [1440000, 1] } });
  });

  it('moss-sfx loads the model once for every item, and makes the other items when one fails', () => {
    const run = runDriver('moss-sfx', ['<dir>/model', '<dir>/jobs.json'], {}, [
      { prompt: '<dir>/missing.txt', duration_ms: 500, target: '<dir>/out/a.wav', seed: 1 },
      { prompt: '<dir>/prompt.txt', duration_ms: 500, target: '<dir>/out/b.wav', seed: 2 },
    ]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`${join(run.dir, 'out', 'a.wav')}: failed`);
    expect(readdirSync(join(run.dir, 'out')).sort()).toEqual(['b.wav', 'ogw-error.txt']);
    expect(readFileSync(join(run.dir, 'out', 'ogw-error.txt'), 'utf8')).toMatch(/^FileNotFoundError: /);
    expect(readFileSync(join(run.dir, 'record.json.loads'), 'utf8')).toBe('load\n');
    expect(run.record).toMatchObject({ call: { seed: 2 } });
  });

  it('moss-sfx tells at least 0.1 s, uses a random seed for -1, and keeps torch.compile on CUDA', () => {
    const short = moss(30, '-1', { STUB_DEVICE: 'mps' });
    expect(short.code).toBe(0);
    const call = short.record.call as { prompt: string; seed: number };
    expect(call.prompt).toBe('A coin pickup. duration: 0.1s');
    expect(Number.isInteger(call.seed) && call.seed >= 0).toBe(true);
    expect(short.record).toMatchObject({ from_pretrained: { dtype: 'bfloat16', device: 'mps', dynamo: '1' }, write: { shape: [49440, 1] } });
    expect(moss(1000, '42', { STUB_DEVICE: 'cuda' }).record).toMatchObject({ from_pretrained: { device: 'cuda', dynamo: null } });
  });
});
