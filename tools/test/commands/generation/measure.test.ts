import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readList } from '../../../src/commands/resource/lib/list.ts';
import { rigFixtureProblem } from '../../../src/commands/generation/lib/rig-fixture.ts';
import { blockedLines, callError, gpuDevices, hiddenSockets, maxMemory, seatbeltProfile, wrapped } from '../../../src/commands/generation/lib/sandbox.ts';
import { runCall, STANDARD_JOBS, standardImage, type CallInput, type StandardJob } from '../../../src/commands/generation/lib/standard.ts';
import { PROVIDER_PROMPT } from '../../../src/commands/generation/measure.ts';
import { createContext, type Context } from '../../../src/lib/command.ts';
import { withMethodLock } from '../../../src/commands/generation/lib/install.ts';
import type { GenerationMethod, HarnessSettings } from '../../../src/lib/settings.ts';
import { LIMITS } from '../../../src/lib/limits.ts';
import { ogw, makeGame, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';

// readList as it is, counted: `generation run` reads the resource list once
vi.mock('../../../src/commands/resource/lib/list.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/commands/resource/lib/list.ts')>();
  return { ...original, readList: vi.fn(original.readList) };
});

const saved = new Map<string, StandardJob | undefined>();

function setJob(name: string, job: StandardJob): void {
  if (!saved.has(name)) saved.set(name, STANDARD_JOBS[name]);
  STANDARD_JOBS[name] = job;
}

beforeEach(() => {
  saved.clear();
});
afterEach(() => {
  for (const [name, job] of saved) {
    if (job === undefined) Reflect.deleteProperty(STANDARD_JOBS, name);
    else STANDARD_JOBS[name] = job;
  }
});

/** A call that writes `<out>/result.txt` with the stage, the prompt and the image count, and fails above 1024 px. */
const writingJob: StandardJob = {
  stages: [{ resolution: 512 }, { resolution: 1024 }, { resolution: 2048 }],
  prompt: 'fixed prompt',
  image: true,
  call: (input) =>
    Promise.resolve({
      cmd: '/bin/sh',
      args: [
        '-c',
        'if [ "${1:-0}" -gt 1024 ]; then echo too big >&2; exit 1; fi; printf "%s|%s|%s" "$1" "$(cat "$2")" "$3" > "$4/result.txt"',
        'sh',
        String(input.stage?.resolution ?? ''),
        input.promptFile,
        String(input.images.length),
        input.out,
      ],
    }),
};

function workspace(methods: unknown[]): { ws: TestWorkspace; env: NodeJS.ProcessEnv } {
  const ws = makeWorkspace({ resourceGeneration: methods });
  return { ws, env: { ...ws.env, TMPDIR: join(ws.root, 'tmp') } };
}

describe.runIf(process.platform === 'darwin')('ogw generation measure', () => {
  it('runs each method stage from the lowest, stops at failed or timeout, and records the result', async () => {
    setJob('flux2-klein', writingJob);
    setJob('moss-sfx', { stages: [{ durationMs: 1000 }, { durationMs: 2000 }], prompt: '', image: false, call: () => Promise.resolve({ cmd: '/bin/sleep', args: ['5'] }) });
    setJob('qwen3-tts', writingJob);
    const { ws, env } = workspace([
      { name: 'flux2-klein', kind: 'local-model', resourceTypes: ['image'], safetyTimeoutMs: 20_000, license: 'X', pins: [] },
      { name: 'moss-sfx', kind: 'local-model', resourceTypes: ['sfx'], safetyTimeoutMs: 300, license: 'X', pins: [] },
      { name: 'qwen3-tts', kind: 'local-model', resourceTypes: ['voice'], safetyTimeoutMs: 300, license: 'X', pins: [] },
      { name: 'ace-step', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 300, license: 'X', pins: [] },
      { name: 'cat', kind: 'catalog', resourceTypes: ['font'], safetyTimeoutMs: 1, pins: [] },
      { name: 'cat2', kind: 'catalog', resourceTypes: ['font'], safetyTimeoutMs: 1, pins: [{ kind: 'git', source: 'x' }] },
      { name: 'ext', kind: 'external-service', resourceTypes: ['image'], safetyTimeoutMs: 1, license: 'X', model: 'm', secret: 's' },
      { name: 'procedural', kind: 'procedural', resourceTypes: ['shader'], safetyTimeoutMs: 1, license: 'X' },
      { name: 'blender', kind: 'procedural', resourceTypes: ['model'], safetyTimeoutMs: 1, license: 'X' },
    ]);
    for (const name of ['flux2-klein', 'moss-sfx', 'cat']) expect((await ogw(ws, ['generation', 'install', name], { env })).code).toBe(0);
    const run = await ogw(ws, ['generation', 'measure', '--json'], { env });
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout) as { methods: Record<string, { steps: { resolution?: number; durationMs?: number; result: string; jobMs?: number; maxMemoryBytes: number | null; output: string | null }[]; error: string | null }> };
    const flux = result.methods['flux2-klein'];
    expect(flux?.error).toBeNull();
    expect(flux?.steps.map((s) => [s.resolution, s.result])).toEqual([[512, 'ok'], [1024, 'ok'], [2048, 'failed']]);
    expect(flux?.steps.map((s) => (s as { error?: string }).error)).toEqual([undefined, undefined, 'too big']);
    expect(flux?.steps[0]?.maxMemoryBytes).toBeGreaterThan(0);
    expect(flux?.steps[0]?.jobMs).toBeGreaterThanOrEqual(0);
    const out = flux?.steps[1]?.output as string;
    expect(out).toBe(join(ws.root, '.ogw', 'generation', 'flux2-klein', 'measure', '1024', 'out'));
    expect(readFileSync(join(out, 'result.txt'), 'utf8')).toBe('1024|fixed prompt|1');
    expect(readFileSync(join(out, '..', 'input.png')).subarray(1, 4).toString()).toBe('PNG');
    expect(result.methods['moss-sfx']?.steps.map((s) => [s.durationMs, s.result])).toEqual([[1000, 'timeout']]);
    expect(result.methods['qwen3-tts']).toMatchObject({ steps: [], error: 'not installed as pinned: run ogw generation install' });
    expect(result.methods['ace-step']).toMatchObject({ steps: [], error: 'not installed as pinned: run ogw generation install' });
    expect(result.methods.cat).toMatchObject({ steps: [{ result: 'ok', maxMemoryBytes: null, output: null, blocked: [] }], error: null });
    expect(result.methods.cat2?.error).toBe('not installed as pinned: run ogw generation install');
    expect(result.methods.ext?.error).toBe('not called: the human did not allow it (ogw generation measure --allow ext)');
    expect(result.methods.procedural).toEqual({ kind: 'procedural', steps: [{ result: 'ok', maxMemoryBytes: null, output: null, blocked: [] }], error: null });
    expect(result.methods.blender?.error).toBe('tools.blender is not installed');
    const file = JSON.parse(readFileSync(join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'generation-measure.json'), 'utf8')) as { methods: unknown };
    expect(file.methods).toEqual(result.methods);
    const text = await ogw(ws, ['generation', 'measure'], { env });
    expect(text.stdout).toContain('flux2-klein: 3 step(s)\n  512px: ok ');
    expect(text.stdout).toMatch(/\n {2}2048px: failed [^\n]*\n {4}stderr:\n {6}too big\n/);
    expect(text.stdout).toContain('moss-sfx: 1 step(s)\n  1000ms: timeout ');
    expect(text.stdout).toContain('cat: 1 step(s)\n  single: ok\n');
  });

  it('measures rig-2d after flux2-klein whatever order the settings list', async () => {
    setJob('flux2-klein', writingJob);
    const { ws, env } = workspace([
      { name: 'rig-2d', kind: 'procedural', resourceTypes: ['rig_animation_2d'], safetyTimeoutMs: 1, license: 'X' },
      { name: 'flux2-klein', kind: 'local-model', resourceTypes: ['image'], safetyTimeoutMs: 20_000, license: 'X', pins: [], measured: [] },
    ]);
    expect((await ogw(ws, ['generation', 'install', 'flux2-klein'], { env })).code).toBe(0);
    const result = JSON.parse((await ogw(ws, ['generation', 'measure', '--json'], { env })).stdout) as Measured;
    expect(Object.keys(result.methods)).toEqual(['rig-2d', 'flux2-klein']);
    expect(result.methods['flux2-klein']?.steps[0]).toMatchObject({ resolution: 512, result: 'ok' });
    expect(result.methods['rig-2d']?.steps).toMatchObject([{ result: 'ok' }]);
  });
});

describe.runIf(process.platform === 'darwin')('ogw generation run', () => {
  const rest = ',,,,,,,,';
  const resources = [
    'key,description,spec,status,method,source,license,attribution,sha256,text_key,speaker,text_hash',
    `image/hero,hero,size=900x900,placeholder${rest}`,
    `rig_animation_2d/hero,rig,size=600x600;animations=idle:100:loop,placeholder${rest}`,
    `sfx/a,a,length=10,placeholder${rest}`,
    `sfx/b,b,length=20;loop=true,placeholder${rest}`,
    '',
  ].join('\n');
  const methods = [
    { name: 'flux2-klein', kind: 'local-model', resourceTypes: ['image'], safetyTimeoutMs: 1, license: 'X', pins: [], measured: [{ resolution: 512, result: 'ok' }, { resolution: 1024, result: 'ok' }] },
    { name: 'rig-2d', kind: 'procedural', resourceTypes: ['rig_animation_2d'], safetyTimeoutMs: 1, license: 'X', measured: [{ result: 'ok' }] },
    { name: 'audio', kind: 'local-model', resourceTypes: ['sfx'], safetyTimeoutMs: 1, license: 'X', pins: [], measured: [{ result: 'ok' }] },
    { name: 'proc', kind: 'procedural', resourceTypes: ['sfx'], safetyTimeoutMs: 1, license: 'X', measured: [{ result: 'ok' }] },
  ];

  it('runs the method call with the stage generation methods gives, in the sandbox', async () => {
    // a TCP server the sandboxed call tries to reach, and a file the test user can write that the sandbox must block
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = String((server.address() as { port: number }).port);
    let outside = '';
    setJob('flux2-klein', writingJob);
    setJob('audio', {
      stages: [],
      prompt: '',
      image: false,
      call: (input) =>
        Promise.resolve({
          cmd: '/bin/sh',
          args: [
            '-c',
            `echo "[${String(input.stage === null)}]" > "$1/r.txt"; echo x > "$2"; if /usr/bin/nc -z -G 2 127.0.0.1 "$3"; then echo connected > "$1/net.txt"; else echo failed > "$1/net.txt"; fi`,
            'sh',
            input.out,
            outside,
            port,
          ],
        }),
    });
    const { ws, env } = workspace(methods);
    outside = join(ws.root, 'outside.txt');
    writeFileSync(outside, 'before');
    makeGame(ws, 'g', { 'resource/resources.csv': resources });
    for (const name of ['flux2-klein', 'audio']) expect((await ogw(ws, ['generation', 'install', name], { env })).code).toBe(0);
    const prompt = join(ws.root, 'prompt.txt');
    writeFileSync(prompt, 'a knight');
    writeFileSync(join(ws.root, 'ref.png'), standardImage(4));
    const out = join(ws.root, 'out');
    const run = await ogw(ws, ['generation', 'run', 'flux2-klein', '--game', 'g', '--key', 'image/hero', '--prompt', prompt, '--image', 'ref.png', '--out', out, '--json'], { env });
    expect(run.code).toBe(0);
    expect(readFileSync(join(out, 'result.txt'), 'utf8')).toBe('1024|a knight|1');
    expect(JSON.parse(run.stdout)).toMatchObject({ result: 'ok', stage: { resolution: 1024 }, output: out });
    const viaRig = await ogw(ws, ['generation', 'run', 'flux2-klein', '--game', 'g', '--key', 'rig_animation_2d/hero', '--prompt', prompt, '--out', join(ws.root, 'out2')], { env });
    expect(viaRig.code).toBe(0);
    expect(readFileSync(join(ws.root, 'out2', 'result.txt'), 'utf8')).toBe('1024|a knight|0');
    expect(viaRig.stdout).toMatch(/^flux2-klein: ok in \d+ms, output /);
    const noStage = await ogw(ws, ['generation', 'run', 'audio', '--game', 'g', '--key', 'sfx/a', '--prompt', prompt, '--out', join(ws.root, 'out3')], { env });
    expect(readFileSync(join(ws.root, 'out3', 'r.txt'), 'utf8')).toBe('[true]\n');
    expect(noStage.stdout).toContain('blocked: ');
    // writes outside the method folder and --out, and the network, are blocked
    expect(readFileSync(outside, 'utf8')).toBe('before');
    expect(readFileSync(join(ws.root, 'out3', 'net.txt'), 'utf8')).toBe('failed\n');
    expect(connections).toBe(0);
    await new Promise((resolve) => server.close(resolve));
  });

  it('refuses methods that are not local-model, not in the methods output, not installed, or without a call', async () => {
    setJob('flux2-klein', writingJob);
    const { ws, env } = workspace(methods);
    makeGame(ws, 'g', { 'resource/resources.csv': resources });
    const prompt = join(ws.root, 'prompt.txt');
    writeFileSync(prompt, 'p');
    const base = ['--game', 'g', '--prompt', prompt, '--out', join(ws.root, 'o')];
    expect(await ogw(ws, ['generation', 'run', 'proc', '--key', 'sfx/a', ...base], { env })).toMatchObject({ code: 1, stderr: 'proc is not a local-model method of harness settings resourceGeneration\n' });
    expect(await ogw(ws, ['generation', 'run', 'flux2-klein', '--key', 'sfx/a', ...base], { env })).toMatchObject({ code: 1, stderr: 'method flux2-klein is not in ogw generation methods g sfx/a\n' });
    expect(await ogw(ws, ['generation', 'run', 'flux2-klein', '--key', 'image/hero', ...base], { env })).toMatchObject({
      code: 1,
      stderr: 'method flux2-klein is not installed as pinned on this host: the update env command installs it\n',
    });
    expect(await ogw(ws, ['generation', 'run', 'audio', '--key', 'sfx/a', ...base], { env })).toMatchObject({
      code: 1,
      stderr: 'method audio has no standard test job: tools/ogw.md ## generation call has no call for it\n',
    });
    expect(await ogw(ws, ['generation', 'run', 'audio', '--key', 'sfx/a', '--game', 'g', '--prompt', join(ws.root, 'none.txt'), '--out', 'o'], { env })).toMatchObject({
      code: 1,
      stderr: `file not found: ${join(ws.root, 'none.txt')}\n`,
    });
    expect((await ogw(ws, ['generation', 'run', 'audio', '--key', 'sfx/a'], { env })).stderr).toContain('usage: ogw generation run');
    mkdirSync(join(ws.root, 'o'), { recursive: true });
  });

  it('refuses an --out inside the game repo or holding it, also through a symlink', async () => {
    setJob('flux2-klein', writingJob);
    const { ws, env } = workspace(methods);
    const root = makeGame(ws, 'g', { 'resource/resources.csv': resources });
    expect((await ogw(ws, ['generation', 'install', 'flux2-klein'], { env })).code).toBe(0);
    const prompt = join(ws.root, 'prompt.txt');
    writeFileSync(prompt, 'p');
    symlinkSync(join(root, 'resource'), join(ws.root, 'link'));
    const inside = [join(root, 'resource', 'tmp'), root, ws.root, join(ws.root, 'link', 'new')];
    for (const out of inside) {
      expect(await ogw(ws, ['generation', 'run', 'flux2-klein', '--game', 'g', '--key', 'image/hero', '--prompt', prompt, '--out', out], { env })).toMatchObject({
        code: 1,
        stderr: `--out must be a folder outside game repo g: ${out}\n`,
      });
    }
    expect(existsSync(join(root, 'resource', 'tmp'))).toBe(false);
  });

  it('gives the call the spec size, length and loop and no seed', async () => {
    const seen: unknown[] = [];
    const recording: StandardJob = {
      stages: [],
      prompt: '',
      image: false,
      call: (input) => {
        seen.push({ size: input.size, lengthMs: input.lengthMs, loop: input.loop, seed: input.seed });
        return Promise.resolve({ cmd: '/bin/sh', args: ['-c', 'touch "$1/x"', 'sh', input.out] });
      },
    };
    setJob('flux2-klein', recording);
    setJob('audio', recording);
    const { ws, env } = workspace(methods);
    makeGame(ws, 'g', { 'resource/resources.csv': resources });
    for (const name of ['flux2-klein', 'audio']) expect((await ogw(ws, ['generation', 'install', name], { env })).code).toBe(0);
    const prompt = join(ws.root, 'prompt.txt');
    writeFileSync(prompt, 'p');
    vi.mocked(readList).mockClear();
    expect((await ogw(ws, ['generation', 'run', 'flux2-klein', '--game', 'g', '--key', 'image/hero', '--prompt', prompt, '--out', join(ws.root, 'o1')], { env })).code).toBe(0);
    expect(vi.mocked(readList)).toHaveBeenCalledTimes(1);
    expect((await ogw(ws, ['generation', 'run', 'audio', '--game', 'g', '--key', 'sfx/a', '--prompt', prompt, '--out', join(ws.root, 'o2')], { env })).code).toBe(0);
    expect((await ogw(ws, ['generation', 'run', 'audio', '--game', 'g', '--key', 'sfx/b', '--prompt', prompt, '--out', join(ws.root, 'o3')], { env })).code).toBe(0);
    expect(seen).toEqual([
      { size: [900, 900], lengthMs: null, loop: false, seed: null },
      { size: null, lengthMs: 10, loop: false, seed: null },
      { size: null, lengthMs: 20, loop: true, seed: null },
    ]);
  });

  it('makes the items of --batch in one call that loads the model once, reports each item, and runs a method without a batch call item by item', async () => {
    const batches: string[][] = [];
    const singles: string[] = [];
    const copy = (input: CallInput): string => `cp "${input.promptFile}" "${input.out}/sound.wav"`;
    setJob('audio', {
      stages: [],
      prompt: '',
      image: false,
      outputs: ['sound.wav'],
      call: (input) => Promise.resolve({ cmd: '/bin/sh', args: ['-c', copy(input)] }),
      // every item but the second, and a failing exit as a driver gives when an item failed
      batch: (inputs) => {
        batches.push(inputs.map((i) => i.out));
        return Promise.resolve({ cmd: '/bin/sh', args: ['-c', `${inputs.filter((_, n) => n !== 1).map(copy).join('; ')}; exit 1`] });
      },
    });
    setJob('flux2-klein', {
      stages: [],
      prompt: '',
      image: false,
      call: (input) => {
        singles.push(input.out);
        return Promise.resolve({ cmd: '/bin/sh', args: ['-c', 'touch "$1/x"', 'sh', input.out] });
      },
    });
    const { ws, env } = workspace(methods);
    makeGame(ws, 'g', { 'resource/resources.csv': resources });
    for (const name of ['flux2-klein', 'audio']) expect((await ogw(ws, ['generation', 'install', name], { env })).code).toBe(0);
    const file = (name: string, text: string): string => {
      writeFileSync(join(ws.root, name), text);
      return join(ws.root, name);
    };
    const o = (n: number): string => join(ws.root, `b${String(n)}`);
    // what an out folder already holds is not taken for what the call made
    mkdirSync(o(2), { recursive: true });
    writeFileSync(join(o(2), 'sound.wav'), 'old');
    const items = [
      { key: 'sfx/a', prompt: file('a.txt', 'A'), out: o(1) },
      { key: 'sfx/b', prompt: file('b.txt', 'B'), out: o(2) },
      { key: 'sfx/a', prompt: file('c.txt', 'C'), out: o(3) },
    ];
    const run = await ogw(ws, ['generation', 'run', 'audio', '--game', 'g', '--batch', file('batch.json', JSON.stringify(items))], { env });
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(new RegExp(`^audio: 2 of 3 ok in \\d+ms\nsfx/a: ok, output ${o(1)}\nsfx/b: failed, output ${o(2)}\nsfx/a: ok, output ${o(3)}\n`));
    expect(batches).toEqual([[o(1), o(2), o(3)]]);
    expect([readFileSync(join(o(1), 'sound.wav'), 'utf8'), existsSync(join(o(2), 'sound.wav')), readFileSync(join(o(3), 'sound.wav'), 'utf8')]).toEqual(['A', false, 'C']);
    const images = [
      { key: 'image/hero', prompt: file('d.txt', 'D'), out: o(4) },
      { key: 'image/hero', prompt: file('e.txt', 'E'), out: o(5) },
    ];
    const each = await ogw(ws, ['generation', 'run', 'flux2-klein', '--game', 'g', '--batch', file('images.json', JSON.stringify(images)), '--json'], { env });
    expect(each.code).toBe(0);
    expect(singles).toEqual([o(4), o(5)]);
    expect(JSON.parse(each.stdout)).toMatchObject({ items: [{ key: 'image/hero', out: o(4), result: 'ok' }, { key: 'image/hero', out: o(5), result: 'ok' }], batched: false });
    const refused = async (argv: string[]): Promise<string> => (await ogw(ws, ['generation', 'run', 'audio', '--game', 'g', ...argv], { env })).stderr;
    expect(await refused(['--batch', file('x.json', '[]')])).toContain('is not a non-empty JSON array');
    expect(await refused(['--batch', file('y.json', '{')])).toContain('--batch');
    expect(await refused(['--batch', file('z.json', JSON.stringify([{ key: 'sfx/a', prompt: items[0]?.prompt, out: o(6) }, { key: 'sfx/a', prompt: items[0]?.prompt, out: o(6) }]))])).toContain('gives one out folder to two items');
    expect(await refused(['--batch', file('w.json', JSON.stringify([{ key: 'sfx/a' }]))])).toContain('item 1 is not {"key", "prompt", "images", "out"}');
    expect(await refused(['--batch', join(ws.root, 'batch.json'), '--key', 'sfx/a'])).toContain('--batch goes without --key, --prompt, --image and --out');
  });

  it('removes the prompt copy, a temp folder of ogw, and empties the call TMPDIR after the call', async () => {
    const prompts: string[] = [];
    const job = (exit: number): StandardJob => ({
      stages: [],
      prompt: '',
      image: false,
      call: (input) => {
        prompts.push(input.promptFile);
        return Promise.resolve({ cmd: '/bin/sh', args: ['-c', 'cat "$2" > "$1/seen.txt"; echo x > "$TMPDIR/left.txt"; exit "$3"', 'sh', input.out, input.promptFile, String(exit)] });
      },
    });
    setJob('audio', job(0));
    const { ws, env } = workspace(methods);
    makeGame(ws, 'g', { 'resource/resources.csv': resources });
    expect((await ogw(ws, ['generation', 'install', 'audio'], { env })).code).toBe(0);
    const prompt = join(ws.root, 'prompt.txt');
    writeFileSync(prompt, 'a knight');
    const args = ['generation', 'run', 'audio', '--game', 'g', '--key', 'sfx/a', '--prompt', prompt];
    expect((await ogw(ws, [...args, '--out', join(ws.root, 'o1')], { env })).code).toBe(0);
    setJob('audio', job(3));
    expect((await ogw(ws, [...args, '--out', join(ws.root, 'o2')], { env })).code).toBe(1);
    const temp = realpathSync(join(ws.harness, '.git', 'ogw-temp'));
    const dir = join(ws.root, '.ogw', 'generation', 'audio');
    for (const [i, file] of prompts.entries()) {
      expect(readFileSync(join(ws.root, `o${String(i + 1)}`, 'seen.txt'), 'utf8')).toBe('a knight');
      expect(dirname(dirname(file))).toBe(temp);
      expect(existsSync(dirname(file))).toBe(false);
    }
    expect(prompts).toHaveLength(2);
    expect(existsSync(join(dir, 'runs'))).toBe(false);
    expect(existsSync(join(dir, 'tmp'))).toBe(false);
  });

  it('exits 1 and gives the last 20 stderr lines of a call that fails or passes the time limit', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${String(i + 1)}`);
    setJob('audio', {
      stages: [],
      prompt: '',
      image: false,
      call: () => Promise.resolve({ cmd: '/bin/sh', args: ['-c', 'i=1; while [ $i -le 25 ]; do echo "line $i" >&2; i=$((i+1)); done; if [ -n "$SLOW" ]; then sleep 5; fi; exit 2'] }),
    });
    const { ws, env } = workspace(methods);
    makeGame(ws, 'g', { 'resource/resources.csv': resources });
    expect((await ogw(ws, ['generation', 'install', 'audio'], { env })).code).toBe(0);
    const prompt = join(ws.root, 'prompt.txt');
    writeFileSync(prompt, 'p');
    const args = ['generation', 'run', 'audio', '--game', 'g', '--key', 'sfx/a', '--prompt', prompt, '--out', join(ws.root, 'o')];
    const tail = lines.slice(5).join('\n');
    const failed = await ogw(ws, [...args, '--json'], { env });
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({ result: 'failed', error: tail });
    const text = await ogw(ws, args, { env });
    expect(text.code).toBe(1);
    expect(text.stdout).toMatch(new RegExp(`^audio: failed in \\d+ms, output ${join(ws.root, 'o')}(\\nblocked: [^\\n]*)?\\nstderr:\\n${tail}\\n$`));
    const limits = LIMITS as { programMs: number };
    const programMs = limits.programMs;
    limits.programMs = 1000;
    try {
      const slow = await ogw(ws, [...args, '--json'], { env: { ...env, SLOW: '1' } });
      expect(slow.code).toBe(1);
      expect(JSON.parse(slow.stdout)).toMatchObject({ result: 'timeout', error: tail });
      const slowText = await ogw(ws, args, { env: { ...env, SLOW: '1' } });
      expect(slowText.stdout).toMatch(/^audio: timeout in \d+ms, output [^\n]*(\nblocked: [^\n]*)?\nstderr:\nline 6\n/);
    } finally {
      limits.programMs = programMs;
    }
  });

  it('runs one local-model job at a time: a second run waits until the first ends', async () => {
    const { ws, env } = workspace(methods);
    makeGame(ws, 'g', { 'resource/resources.csv': resources });
    const out1 = join(ws.root, 'o1');
    setJob('flux2-klein', { stages: [], prompt: '', image: false, call: (input) => Promise.resolve({ cmd: '/bin/sh', args: ['-c', 'touch "$1/started"; sleep 1; touch "$1/ended"', 'sh', input.out] }) });
    setJob('audio', {
      stages: [],
      prompt: '',
      image: false,
      call: (input) => Promise.resolve({ cmd: '/bin/sh', args: ['-c', 'if [ -e "$2/ended" ]; then echo after; else echo overlap; fi > "$1/r.txt"', 'sh', input.out, out1] }),
    });
    for (const name of ['flux2-klein', 'audio']) expect((await ogw(ws, ['generation', 'install', name], { env })).code).toBe(0);
    const prompt = join(ws.root, 'prompt.txt');
    writeFileSync(prompt, 'p');
    const first = ogw(ws, ['generation', 'run', 'flux2-klein', '--game', 'g', '--key', 'image/hero', '--prompt', prompt, '--out', out1], { env });
    while (!existsSync(join(out1, 'started'))) await new Promise((resolve) => setTimeout(resolve, 20));
    const second = ogw(ws, ['generation', 'run', 'audio', '--game', 'g', '--key', 'sfx/a', '--prompt', prompt, '--out', join(ws.root, 'o2')], { env });
    expect((await Promise.all([first, second])).map((r) => r.code)).toEqual([0, 0]);
    expect(readFileSync(join(ws.root, 'o2', 'r.txt'), 'utf8')).toBe('after\n');
  });
});

/** Writes the install marker of a method so it counts as installed from its pins. */
function installed(ws: TestWorkspace, method: Record<string, unknown>, patch: Record<string, unknown> = {}): void {
  const dir = join(ws.root, '.ogw', 'generation', method.name as string);
  mkdirSync(dir, { recursive: true });
  // `ffmpeg: null` matches a workspace without tools.ffmpeg installed.
  const marker = { name: method.name, pins: JSON.stringify(method.pins ?? []), git: [], hf: [], files: null, python: null, cli: null, skill: null, ffmpeg: null, ...patch };
  writeFileSync(join(dir, 'installed.json'), JSON.stringify(marker));
}

/** A provider CLI that logs its arguments; `FAKE_MODE` fail exits 3, sleep sleeps, else it writes the `--out` image. */
function providerCli(ws: TestWorkspace): string {
  const file = join(ws.root, 'sprite-gen');
  const lines = [
    '#!/bin/sh',
    `echo "$@" > "${join(ws.root, 'cli-args.txt')}"`,
    'case "$FAKE_MODE" in',
    '  fail) i=1; while [ $i -le 25 ]; do echo "line $i" >&2; i=$((i+1)); done; echo "provider said no" >&2; exit 3 ;;',
    '  sleep) echo "waiting for the provider" >&2; sleep 5 ;;',
    '  noimage) exit 0 ;;',
    '  silent) exit 4 ;;',
    'esac',
    'printf png > "$7"',
    '',
  ];
  writeFileSync(file, lines.join('\n'));
  chmodSync(file, 0o755);
  return file;
}

function external(name: string, provider?: string): Record<string, unknown> {
  return {
    name,
    kind: 'external-service',
    resourceTypes: ['sprite_animation'],
    safetyTimeoutMs: 1500,
    license: 'X',
    ...(provider === undefined ? { model: 'm', secret: 's' } : { provider, pins: [{ kind: 'git', source: 'x', revision: 'a'.repeat(40) }] }),
  };
}

type Measured = { methods: Record<string, { kind: string; steps: Record<string, unknown>[]; error: string | null }> };

function measurePath(ws: TestWorkspace): string {
  return join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'generation-measure.json');
}

/** Writes an earlier `generation measure` result file with these method entries. */
function writeMeasure(ws: TestWorkspace, methods: unknown): void {
  mkdirSync(join(ws.harness, '.git', 'ogw-temp', 'ogw-env'), { recursive: true, mode: 0o700 });
  writeFileSync(measurePath(ws), JSON.stringify({ measuredAt: 1, methods }));
}

function readMeasure(ws: TestWorkspace): Measured {
  return JSON.parse(readFileSync(measurePath(ws), 'utf8')) as Measured;
}

describe('ogw generation measure: procedural, rig-2d and external-service', () => {
  it('calls only the allowed external-service methods, with the provider CLI and no cost', async () => {
    const { ws, env } = workspace([external('codex-gen', 'codex'), external('grok-gen', 'grok'), external('keyed'), external('missing', 'codex')]);
    const cli = providerCli(ws);
    installed(ws, external('codex-gen', 'codex'), { cli });
    installed(ws, external('grok-gen', 'grok'), { cli });
    const run = await ogw(ws, ['generation', 'measure', '--allow', 'codex-gen,keyed,missing', '--json'], { env });
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout) as Measured;
    const out = join(ws.root, '.ogw', 'generation', 'codex-gen', 'measure', 'single', 'out');
    expect(result.methods['codex-gen']).toEqual({
      kind: 'external-service',
      steps: [{ result: 'ok', maxMemoryBytes: null, output: out, blocked: [], jobMs: expect.any(Number) as number, costUsd: 0 }],
      error: null,
    });
    const prompt = join(ws.root, '.ogw', 'generation', 'codex-gen', 'measure', 'single', 'prompt.txt');
    expect(readFileSync(join(ws.root, 'cli-args.txt'), 'utf8')).toBe(`gen --provider codex --prompt-file ${prompt} --out ${join(out, 'image.png')} --transparent\n`);
    expect(readFileSync(prompt, 'utf8')).toBe(PROVIDER_PROMPT);
    expect(PROVIDER_PROMPT).toBe('A small red apple game item, centered, front view.');
    expect(result.methods['grok-gen']).toEqual({ kind: 'external-service', steps: [], error: 'not called: the human did not allow it (ogw generation measure --allow grok-gen)' });
    expect(result.methods.keyed?.error).toBe('an external-service method without provider has no standard test call');
    expect(result.methods.missing?.error).toBe('not installed as pinned: run ogw generation install');
    const text = await ogw(ws, ['generation', 'measure', '--allow', 'codex-gen'], { env });
    expect(text.stdout).toMatch(/codex-gen: 1 step\(s\)\n {2}single: ok \d+ms cost 0 USD output /);
  });

  it('records a failed or timed out provider call', async () => {
    const { ws, env } = workspace([external('codex-gen', 'codex')]);
    installed(ws, external('codex-gen', 'codex'), { cli: providerCli(ws) });
    const measure = async (mode: string): Promise<Record<string, unknown> | undefined> =>
      (JSON.parse((await ogw(ws, ['generation', 'measure', '--allow', 'codex-gen', '--json'], { env: { ...env, FAKE_MODE: mode } })).stdout) as Measured).methods['codex-gen']?.steps[0];
    // the last 20 lines of the call's stderr go to `error`, on failed and on timeout
    const lastLines = [...Array.from({ length: 19 }, (_, i) => `line ${String(i + 7)}`), 'provider said no'].join('\n');
    const fail = await measure('fail');
    expect(fail).toMatchObject({ result: 'failed', error: lastLines, costUsd: 0 });
    expect(fail).not.toHaveProperty('detail');
    const slow = await measure('sleep');
    expect(slow).toMatchObject({ result: 'timeout', error: 'waiting for the provider' });
    expect(slow).not.toHaveProperty('detail');
    // a failure without program output says why in `detail`
    const out = join(ws.root, '.ogw', 'generation', 'codex-gen', 'measure', 'single', 'out');
    expect(await measure('noimage')).toMatchObject({ result: 'failed', detail: `${join(out, 'image.png')} was not written` });
    expect(await measure('silent')).toMatchObject({ result: 'failed', detail: 'exited with code 4' });
    const text = await ogw(ws, ['generation', 'measure', '--allow', 'codex-gen'], { env: { ...env, FAKE_MODE: 'fail' } });
    expect(text.stdout).toContain(`    stderr:\n${lastLines.split('\n').map((l) => `      ${l}`).join('\n')}\n`);
  });

  it('refuses --allow names that are not external-service methods', async () => {
    const { ws, env } = workspace([external('codex-gen', 'codex'), { name: 'procedural', kind: 'procedural', resourceTypes: ['shader'], safetyTimeoutMs: 1, license: 'X' }]);
    expect(await ogw(ws, ['generation', 'measure', '--allow', 'procedural, nothing'], { env })).toMatchObject({
      code: 1,
      stderr: '--allow takes external-service methods of harness settings resourceGeneration: procedural, nothing\n',
    });
  });

  it('measures rig-2d with the flux2-klein result and the rig tool fixture', async () => {
    const rig = { name: 'rig-2d', kind: 'procedural', resourceTypes: ['rig_animation_2d'], safetyTimeoutMs: 1, license: 'X' };
    const flux = (measured: unknown[]): Record<string, unknown> => ({ name: 'flux2-klein', kind: 'local-model', resourceTypes: ['image'], safetyTimeoutMs: 1, license: 'X', pins: [], measured });
    const okRun = workspace([flux([{ resolution: 512, result: 'ok' }]), rig]);
    const result = JSON.parse((await ogw(okRun.ws, ['generation', 'measure', '--json'], { env: okRun.env })).stdout) as Measured;
    const work = join(okRun.ws.root, '.ogw', 'generation', 'rig-2d', 'measure', 'single');
    expect(result.methods['rig-2d']).toEqual({ kind: 'procedural', steps: [{ result: 'ok', maxMemoryBytes: null, output: work, blocked: [], jobMs: expect.any(Number) as number }], error: null });
    expect(existsSync(join(work, 'mesh', 'arm.mesh.json'))).toBe(true);
    expect(existsSync(join(work, 'split', 'rig-split.json'))).toBe(true);
    const noImage = workspace([flux([{ resolution: 512, result: 'failed' }]), rig]);
    const failed = JSON.parse((await ogw(noImage.ws, ['generation', 'measure', '--json'], { env: noImage.env })).stdout) as Measured;
    expect(failed.methods['rig-2d']?.steps).toEqual([{ result: 'failed', maxMemoryBytes: null, output: null, blocked: [], detail: 'flux2-klein has no ok stage' }]);
    expect((await ogw(noImage.ws, ['generation', 'measure'], { env: noImage.env })).stdout).toContain('rig-2d: 1 step(s)\n  single: failed\n    flux2-klein has no ok stage\n');
    const none = workspace([rig]);
    const alone = JSON.parse((await ogw(none.ws, ['generation', 'measure', '--json'], { env: none.env })).stdout) as Measured;
    expect(alone.methods['rig-2d']?.steps).toMatchObject([{ result: 'failed', detail: 'flux2-klein has no ok stage' }]);
  });

  it('measures only the named methods and keeps the other entries of the result file', async () => {
    const procedural = (name: string): Record<string, unknown> => ({ name, kind: 'procedural', resourceTypes: ['shader'], safetyTimeoutMs: 1, license: 'X' });
    const { ws, env } = workspace([procedural('p1'), procedural('p2'), procedural('p3')]);
    writeMeasure(ws, { p1: { kind: 'procedural', steps: [], error: 'old' }, p2: { kind: 'procedural', steps: [], error: 'kept' }, gone: { kind: 'procedural', steps: [], error: 'kept too' } });
    const run = await ogw(ws, ['generation', 'measure', 'p1', 'p3'], { env });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(`p1: 1 step(s)\n  single: ok\np3: 1 step(s)\n  single: ok\nresult: ${measurePath(ws)}\n`);
    const ok = { kind: 'procedural', steps: [{ result: 'ok', maxMemoryBytes: null, output: null, blocked: [] }], error: null };
    expect(readMeasure(ws).methods).toEqual({ p1: ok, p2: { kind: 'procedural', steps: [], error: 'kept' }, gone: { kind: 'procedural', steps: [], error: 'kept too' }, p3: ok });
  });

  it('refuses a method name that is not in harness settings and measures nothing', async () => {
    const { ws, env } = workspace([{ name: 'p1', kind: 'procedural', resourceTypes: ['shader'], safetyTimeoutMs: 1, license: 'X' }]);
    expect(await ogw(ws, ['generation', 'measure', 'p1', 'nothing', 'other'], { env })).toMatchObject({ code: 1, stderr: 'no method nothing, other in harness settings resourceGeneration\n' });
    expect(existsSync(measurePath(ws))).toBe(false);
  });

  it('measures every method without names and drops entries of the earlier result file', async () => {
    const procedural = (name: string): Record<string, unknown> => ({ name, kind: 'procedural', resourceTypes: ['shader'], safetyTimeoutMs: 1, license: 'X' });
    const { ws, env } = workspace([procedural('p1'), procedural('p2')]);
    writeMeasure(ws, { p1: { kind: 'procedural', steps: [], error: 'old' }, gone: { kind: 'procedural', steps: [], error: 'old' } });
    expect((await ogw(ws, ['generation', 'measure'], { env })).code).toBe(0);
    const methods = readMeasure(ws).methods;
    expect(Object.keys(methods)).toEqual(['p1', 'p2']);
    expect(methods.p1?.error).toBeNull();
  });

  it('measures rig-2d alone with the flux2-klein result kept in the result file', async () => {
    const rig = { name: 'rig-2d', kind: 'procedural', resourceTypes: ['rig_animation_2d'], safetyTimeoutMs: 1, license: 'X' };
    const flux = (measured: unknown[]): Record<string, unknown> => ({ name: 'flux2-klein', kind: 'local-model', resourceTypes: ['image'], safetyTimeoutMs: 1, license: 'X', pins: [], measured });
    const keptStep = (result: string): unknown => ({ 'flux2-klein': { kind: 'local-model', steps: [{ resolution: 512, result, maxMemoryBytes: 1, output: null, blocked: [] }], error: null } });
    const keptOk = workspace([flux([{ resolution: 512, result: 'failed' }]), rig]);
    writeMeasure(keptOk.ws, keptStep('ok'));
    const ok = JSON.parse((await ogw(keptOk.ws, ['generation', 'measure', 'rig-2d', '--json'], { env: keptOk.env })).stdout) as Measured;
    expect(ok.methods['rig-2d']?.steps).toMatchObject([{ result: 'ok' }]);
    expect(ok.methods['flux2-klein']?.steps).toMatchObject([{ result: 'ok', maxMemoryBytes: 1 }]);
    const keptFailed = workspace([flux([{ resolution: 512, result: 'ok' }]), rig]);
    writeMeasure(keptFailed.ws, keptStep('failed'));
    const failed = JSON.parse((await ogw(keptFailed.ws, ['generation', 'measure', 'rig-2d', '--json'], { env: keptFailed.env })).stdout) as Measured;
    expect(failed.methods['rig-2d']?.steps).toMatchObject([{ result: 'failed', detail: 'flux2-klein has no ok stage' }]);
    const noFile = workspace([flux([{ resolution: 512, result: 'ok' }]), rig]);
    const settings = JSON.parse((await ogw(noFile.ws, ['generation', 'measure', 'rig-2d', '--json'], { env: noFile.env })).stdout) as Measured;
    expect(settings.methods['rig-2d']?.steps).toMatchObject([{ result: 'ok' }]);
    expect(Object.keys(settings.methods)).toEqual(['rig-2d']);
  });

  it('makes the rig-2d fixture under the lock of the rig-2d method folder', async () => {
    const rig = { name: 'rig-2d', kind: 'procedural', resourceTypes: ['rig_animation_2d'], safetyTimeoutMs: 1, license: 'X' };
    const flux = { name: 'flux2-klein', kind: 'local-model', resourceTypes: ['image'], safetyTimeoutMs: 1, license: 'X', pins: [], measured: [{ resolution: 512, result: 'ok' }] };
    const { ws, env } = workspace([flux, rig]);
    const ctx = createContext({ cwd: ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const work = join(ws.root, '.ogw', 'generation', 'rig-2d', 'measure', 'single');
    let release = (): void => undefined;
    let acquired = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holding = withMethodLock(ctx, 'rig-2d', () => {
      acquired();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await held;
    const measuring = ogw(ws, ['generation', 'measure', 'rig-2d', '--json'], { env });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(existsSync(work)).toBe(false);
    release();
    await holding;
    const result = JSON.parse((await measuring).stdout) as Measured;
    expect(result.methods['rig-2d']?.steps).toMatchObject([{ result: 'ok', output: work }]);
  });

  it('fails the rig fixture when recompose does not pass', async () => {
    const { ws } = workspace([]);
    expect(await rigFixtureProblem(join(ws.root, 'fixture'), { rigCheck: { iouMin: 1.5, colorDiffMax: 0 } } as HarnessSettings)).toBe('rig-split recompose is fail (alphaIou 1)');
    expect(await rigFixtureProblem(join(ws.root, 'fixture'), { rigCheck: { iouMin: 0.9, colorDiffMax: 8 } } as HarnessSettings)).toBeNull();
  });
});

describe.runIf(process.platform === 'darwin')('runCall', () => {
  it('runs calls in order, stops at the first failure, and checks the outputs', async () => {
    const { ws, env } = workspace([]);
    const ctx = { env, workspace: () => Promise.resolve({ root: ws.root, harness: ws.harness }) } as unknown as Context;
    const method: GenerationMethod = { name: 'm', kind: 'local-model', resourceTypes: ['image'], safetyTimeoutMs: 1 };
    const out = join(ws.root, 'o');
    mkdirSync(out, { recursive: true });
    const write = (name: string): { cmd: string; args: string[]; env: Record<string, string> } => ({ cmd: '/bin/sh', args: ['-c', `printf "$X" > "$1/${name}"`, 'sh', out], env: { X: name } });
    const ok = await runCall(ctx, method, [write('a'), write('b')], out, 20_000, ['a', 'b']);
    expect(ok).toMatchObject({ result: 'ok', output: out, blocked: [] });
    expect(readFileSync(join(out, 'b'), 'utf8')).toBe('b');
    expect(ok.maxMemoryBytes).toBeGreaterThan(0);
    expect((await runCall(ctx, method, [write('c')], out, 20_000, ['c', 'd'])).result).toBe('failed');
    const stop = await runCall(ctx, method, [write('d'), { cmd: '/bin/sh', args: ['-c', 'i=1; while [ $i -le 30 ]; do echo "line $i" >&2; i=$((i+1)); done; exit 2'] }, write('e')], out, 20_000);
    expect(stop.result).toBe('failed');
    // the last 20 lines of the failing call's stderr, without the /usr/bin/time report
    expect(stop.error).toBe(Array.from({ length: 20 }, (_, i) => `line ${String(i + 11)}`).join('\n'));
    expect(ok).not.toHaveProperty('error');
    expect(existsSync(join(out, 'e'))).toBe(false);
    const slow = await runCall(ctx, method, [{ cmd: '/bin/sleep', args: ['5'] }, write('f')], out, 300);
    expect(slow.result).toBe('timeout');
    expect(existsSync(join(out, 'f'))).toBe(false);
    expect(await runCall(ctx, method, write('g'), out, 0)).toMatchObject({ result: 'timeout', maxMemoryBytes: null });
    const empty = join(ws.root, 'empty');
    mkdirSync(empty);
    expect((await runCall(ctx, method, { cmd: '/bin/sh', args: ['-c', 'true'] }, empty, 20_000)).result).toBe('failed');
  });
});

/** A node script: serves and connects to `inside`, then connects to `outside`, and writes what happened to `file`. */
const SOCKET_SCRIPT = `
const net = require('net');
const fs = require('fs');
const [outside, inside, file] = process.argv.slice(1);
const own = net.createServer((s) => s.end('own')).listen(inside, () => {
  const c = net.connect(inside, () => {
    fs.writeFileSync(file, 'inside ok\\n');
    c.destroy();
    own.close();
    const o = net.connect(outside, () => { fs.appendFileSync(file, 'outside connected\\n'); process.exit(0); });
    o.on('error', (e) => { fs.appendFileSync(file, 'outside ' + e.code + '\\n'); process.exit(0); });
  });
});
`;

describe.runIf(process.platform === 'darwin')('sandbox unix sockets', () => {
  it('lets a call use a unix socket inside its writable folders and not connect to one outside them', async () => {
    const { ws, env } = workspace([]);
    const ctx = { env, workspace: () => Promise.resolve({ root: ws.root, harness: ws.harness }) } as unknown as Context;
    const method: GenerationMethod = { name: 'm', kind: 'local-model', resourceTypes: ['image'], safetyTimeoutMs: 1 };
    // a service of this host outside the sandbox, such as the Docker daemon socket
    const outside = join(ws.root, 'd.sock');
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.end('hi');
    });
    await new Promise<void>((resolve) => server.listen(outside, resolve));
    const out = join(ws.root, 'o');
    mkdirSync(out, { recursive: true });
    const call = { cmd: process.execPath, args: ['-e', SOCKET_SCRIPT, outside, join(out, 'i.sock'), join(out, 'r.txt')] };
    const result = await runCall(ctx, method, call, out, 20_000);
    await new Promise((resolve) => server.close(resolve));
    expect(result.result).toBe('ok');
    expect(readFileSync(join(out, 'r.txt'), 'utf8')).toBe('inside ok\noutside EPERM\n');
    expect(connections).toBe(0);
  });
});

describe('sandbox helpers', () => {
  it('builds the seatbelt profile and reads time and blocked lines', () => {
    const profile = seatbeltProfile(['/a', '/b c']);
    expect(profile).toContain('(deny network*)');
    expect(profile).not.toContain('(local unix)');
    expect(profile).toContain(
      '(allow network* (local unix-socket (subpath "/a")) (remote unix-socket (subpath "/a")) (local unix-socket (subpath "/b c")) (remote unix-socket (subpath "/b c")))',
    );
    expect(profile).toContain('(allow file-write* (subpath "/a") (subpath "/b c")');
    expect(maxMemory('  123456  maximum resident set size\n')).toBe(123456);
    expect(maxMemory('\tMaximum resident set size (kbytes): 10\n')).toBe(10240);
    expect(maxMemory('nothing')).toBeNull();
    expect(blockedLines('ok\nsh: /x: Operation not permitted\n  99  maximum resident set size\ncurl: Could not resolve: nodename nor servname provided\n')).toEqual([
      'sh: /x: Operation not permitted',
      'curl: Could not resolve: nodename nor servname provided',
    ]);
  });

  it('keeps the last 20 stderr lines of a call without the /usr/bin/time report', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `l${String(i + 1)}`);
    const tail = lines.slice(5).join('\n');
    const mac = `${lines.join('\n')}\n\n        0.52 real         0.30 user         0.10 sys\n  123456  maximum resident set size\n         0  page reclaims\n`;
    expect(callError(mac)).toBe(tail);
    const linux = `${lines.join('\n')}\nCommand exited with non-zero status 1\n\tCommand being timed: "bwrap x"\n\tMaximum resident set size (kbytes): 10\n`;
    expect(callError(linux)).toBe(tail);
    expect(callError('Traceback (most recent call last):\nImportError: x\n')).toBe('Traceback (most recent call last):\nImportError: x');
    expect(callError('        0.00 real         0.00 user         0.00 sys\n')).toBeNull();
    expect(callError('')).toBeNull();
  });

  it('wraps the program for macOS and Linux only', () => {
    expect(wrapped('p', ['a'], ['/w'], 'darwin')).toEqual({ cmd: '/usr/bin/time', args: ['-l', 'sandbox-exec', '-p', seatbeltProfile(['/w']), 'p', 'a'] });
    expect(wrapped('p', ['a'], ['/w'], 'linux')).toEqual({
      cmd: '/usr/bin/time',
      args: ['-v', 'bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--bind', '/w', '/w', '--unshare-net', '--die-with-parent', '--', 'p', 'a'],
    });
    expect(wrapped('p', ['a'], ['/w'], 'linux', ['/dev/dri', '/dev/nvidia0', '/dev/nvidiactl'])).toEqual({
      cmd: '/usr/bin/time',
      args: [
        '-v',
        'bwrap',
        '--ro-bind',
        '/',
        '/',
        '--dev',
        '/dev',
        '--dev-bind',
        '/dev/dri',
        '/dev/dri',
        '--dev-bind',
        '/dev/nvidia0',
        '/dev/nvidia0',
        '--dev-bind',
        '/dev/nvidiactl',
        '/dev/nvidiactl',
        '--proc',
        '/proc',
        '--bind',
        '/w',
        '/w',
        '--unshare-net',
        '--die-with-parent',
        '--',
        'p',
        'a',
      ],
    });
    expect(() => wrapped('p', [], [], 'win32')).toThrow('the sandbox runs only on macOS and Linux, not on win32');
    // Linux hides the host's unix sockets before it binds the writable folders
    expect(wrapped('p', [], ['/w'], 'linux', [], { folders: ['/h/run'], files: ['/h/docker.sock'] }).args.slice(7, 15)).toEqual([
      '--proc',
      '/proc',
      '--tmpfs',
      '/h/run',
      '--ro-bind',
      '/dev/null',
      '/h/docker.sock',
      '--bind',
    ]);
  });

  it('finds the existing unix sockets and socket folders the Linux sandbox hides', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-sock-')));
    const home = join(dir, 'home');
    mkdirSync(join(home, '.docker', 'run'), { recursive: true });
    mkdirSync(join(dir, 'runtime'));
    writeFileSync(join(dir, 'agent.sock'), '');
    symlinkSync(join(dir, 'agent.sock'), join(dir, 'link.sock'));
    const env = { HOME: home, SSH_AUTH_SOCK: join(dir, 'link.sock'), XDG_RUNTIME_DIR: join(dir, 'runtime'), DOCKER_HOST: `unix://${join(dir, 'none.sock')}` };
    const hidden = hiddenSockets(env, 'linux');
    expect(hidden.folders).toEqual(expect.arrayContaining([join(home, '.docker', 'run'), join(dir, 'runtime')]));
    expect(hidden.files).toContain(join(dir, 'agent.sock'));
    expect([...hidden.folders, ...hidden.files].filter((p) => p.startsWith(dir))).toHaveLength(3);
    expect(hiddenSockets(env, 'darwin')).toEqual({ folders: [], files: [] });
  });

  it('finds the GPU device nodes the Linux sandbox binds', async () => {
    const dev = mkdtempSync(join(tmpdir(), 'ogw-dev-'));
    for (const name of ['null', 'nvidia0', 'nvidiactl', 'nvidia-uvm', 'tty', 'shm']) writeFileSync(join(dev, name), '');
    mkdirSync(join(dev, 'dri'));
    expect(await gpuDevices(dev)).toEqual(['dri', 'nvidia-uvm', 'nvidia0', 'nvidiactl'].map((n) => `${dev}/${n}`));
    expect(await gpuDevices(join(dev, 'none'))).toEqual([]);
  });

  it('makes a PNG of the requested size', () => {
    const png = standardImage(8);
    expect(png.readUInt32BE(16)).toBe(8);
    expect(png.readUInt32BE(20)).toBe(8);
    expect(png.subarray(12, 16).toString()).toBe('IHDR');
  });
});
