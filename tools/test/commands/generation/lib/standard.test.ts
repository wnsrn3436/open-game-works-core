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
    expect(looped.list[0]?.args[3]).toBe('68000');
    const ace = await calls('ace-step', { stage: { durationMs: 30000 }, seed: 42 });
    expect(ace.list).toHaveLength(1);
    expect(ace.list[0]).toMatchObject({ cmd: join(ace.input.dir, 'venv', 'bin', 'python'), args: [join(ace.input.dir, 'drivers', 'ogw_ace-step.py'), join(ace.input.dir, 'hf', '1'), ace.input.promptFile, '30000', ace.input.out, '42'] });
    expect(ace.list[0]?.env?.PYTHONPATH).toBe(join(ace.input.dir, 'git', '0'));
    expect(readFileSync(join(ace.input.dir, 'drivers', 'ogw_ace-step.py'), 'utf8')).toBe(DRIVERS['ace-step']);
    const moss = await calls('moss-sfx', { stage: { durationMs: 3000 }, lengthMs: 800 });
    expect(moss.list[0]?.args).toEqual([join(moss.input.dir, 'drivers', 'ogw_moss-sfx.py'), join(moss.input.dir, 'hf', '1'), moss.input.promptFile, '800', join(moss.input.out, 'sound.wav'), '-1']);
    // moss-sfx: the seed reaches the pipeline, the model is told the length and the cut is 1 s later
    expect(DRIVERS['moss-sfx']).toContain('seed=s, append_duration_suffix=False');
    expect(DRIVERS['moss-sfx']).toContain('seconds = min(int(duration_ms) / 1000 + 1, pipe.max_inference_seconds)');
    // ace-step: the LM plans the song and its tempo goes to music.json
    expect(DRIVERS['ace-step']).toContain('thinking=True, use_cot_metas=True');
    expect(DRIVERS['ace-step']).toContain('json.dump({"bpm": bpm, "beatsPerBar": beats}, f)');
    const qwen = await calls('qwen3-tts');
    expect(qwen.list[0]?.args).toEqual([join(qwen.input.dir, 'drivers', 'ogw_qwen3-tts.py'), join(qwen.input.dir, 'hf', '1'), qwen.input.promptFile, join(qwen.input.out, 'voice.wav'), '-1']);
    await expect(calls('ace-step', { stage: { durationMs: 1 }, marker: marker('/m', { git: [] }) })).rejects.toThrow('method ace-step has no git pin');
    await expect(calls('moss-sfx', { stage: { durationMs: 1 }, marker: marker('/m', { git: [] }) })).rejects.toThrow('method moss-sfx has no git pin');
    await expect(calls('qwen3-tts', { marker: marker('/m', { hf: [] }) })).rejects.toThrow('method qwen3-tts has no hf pin');
  });

  it('calls generate.py of the trellis2 checkout with one image', async () => {
    const t = await calls('trellis2', { images: ['/in.png'], stage: { resolution: 512 }, seed: 42 });
    expect(t.list[0]).toMatchObject({
      cmd: join(t.input.dir, 'venv', 'bin', 'python'),
      args: [join(t.input.dir, 'git', '0', 'generate.py'), '--image', '/in.png', '--output', join(t.input.out, 'model.glb'), '--resolution', '512', '--no-rembg', '--seed', '42'],
    });
    const run = await calls('trellis2', { images: ['/in.png'] });
    expect(run.list[0]?.args.slice(5)).toEqual(['--resolution', '1024', '--no-rembg']);
    await expect(calls('trellis2')).rejects.toThrow('trellis2 takes exactly one --image');
    await expect(calls('trellis2', { images: ['/a', '/b'] })).rejects.toThrow('trellis2 takes exactly one --image');
  });
});
