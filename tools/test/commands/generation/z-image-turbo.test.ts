import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STANDARD_JOBS, standardImage, type StandardJob } from '../../../src/commands/generation/lib/standard.ts';
import { ogw, makeGame, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { installFolder, writeInstall } from './install-folder.ts';

const IMAGE_TYPES = ['image', 'icon'];
const ZIT = { name: 'z-image-turbo', kind: 'local-model', resourceTypes: IMAGE_TYPES, safetyTimeoutMs: 20_000, license: 'Apache-2.0', pins: [], measured: [{ resolution: 512, result: 'ok' }, { resolution: 1024, result: 'ok' }] };
const FLUX = { name: 'flux2-klein', kind: 'local-model', resourceTypes: IMAGE_TYPES, safetyTimeoutMs: 20_000, license: 'Apache-2.0', pins: [], measured: [{ resolution: 512, result: 'ok' }] };
const LOGOTYPE = { name: 'logotype', kind: 'procedural', resourceTypes: ['image'], safetyTimeoutMs: 1, license: 'X', measured: [{ result: 'ok' }] };
const FONTS = { name: 'font-catalog', kind: 'catalog', resourceTypes: ['font'], safetyTimeoutMs: 1, license: 'X', measured: [{ result: 'ok' }] };

const REST = ',,,,,,,,';
const RESOURCES = [
  'key,description,spec,status,method,source,license,attribution,sha256,text_key,speaker,text_hash',
  `image/hero,hero,size=900x600,placeholder${REST}`,
  `image/logo/en,logo,size=1024x512;alpha=true,placeholder${REST}`,
  '',
].join('\n');

const saved = new Map<string, StandardJob | undefined>();

afterEach(() => {
  for (const [name, job] of saved) {
    if (job === undefined) Reflect.deleteProperty(STANDARD_JOBS, name);
    else STANDARD_JOBS[name] = job;
  }
  saved.clear();
});

/** flux2-klein as a call that writes `<out>/flux.txt` with the stage resolution and the image count. */
function fakeFlux(): void {
  if (!saved.has('flux2-klein')) saved.set('flux2-klein', STANDARD_JOBS['flux2-klein']);
  STANDARD_JOBS['flux2-klein'] = {
    stages: [],
    prompt: '',
    image: false,
    call: (input) => Promise.resolve({ cmd: '/bin/sh', args: ['-c', 'printf "%s|%s" "$1" "$2" > "$3/flux.txt"', 'sh', String(input.stage?.resolution ?? ''), String(input.images.length), input.out] }),
  };
}

function workspace(methods: unknown[]): { ws: TestWorkspace; env: NodeJS.ProcessEnv } {
  const ws = makeWorkspace({ resourceGeneration: methods, imageMethod: 'z-image-turbo' });
  makeGame(ws, 'g', { 'resource/resources.csv': RESOURCES });
  return { ws, env: { ...ws.env, TMPDIR: join(ws.root, 'tmp') } };
}

function script(file: string, lines: string[]): void {
  writeFileSync(file, [...lines, ''].join('\n'));
  chmodSync(file, 0o755);
}

/**
 * Installs z-image-turbo with a fake isolated environment: `mflux-generate-z-image-turbo` writes its `--output` and
 * logs its arguments to `mflux-args.txt` next to it, and its `python` runs the rembg driver as a copy of the image to
 * `image-alpha.png` that logs `U2NET_HOME` to `u2net.txt`. Returns its install folder.
 */
async function installFakeZImage(ws: TestWorkspace): Promise<string> {
  const dir = await installFolder(ws, ZIT);
  const bin = join(dir, 'venv', 'bin');
  for (const folder of [bin, join(dir, 'hf', '0'), join(dir, 'files')]) mkdirSync(folder, { recursive: true });
  script(join(bin, 'mflux-generate-z-image-turbo'), [
    '#!/bin/sh',
    'out=',
    'prev=',
    'for a in "$@"; do if [ "$prev" = --output ]; then out="$a"; fi; prev="$a"; done',
    'echo "$@" > "$(dirname "$out")/mflux-args.txt"',
    'printf png > "$out"',
  ]);
  script(join(bin, 'python'), ['#!/bin/sh', 'echo "$U2NET_HOME" > "$(dirname "$3")/u2net.txt"', 'cp "$2" "$3"']);
  const marker = { name: 'z-image-turbo', pins: '[]', git: [], hf: [{ source: 'Tongyi-MAI/Z-Image-Turbo', dir: join(dir, 'hf', '0') }], files: join(dir, 'files'), python: join(bin, 'python'), cli: null, skill: null };
  writeFileSync(join(dir, 'installed.json'), JSON.stringify(marker));
  return dir;
}

describe.runIf(process.platform === 'darwin')('z-image-turbo', () => {
  it('measures each standard stage with the seed of the standard test task, 8-bit quantization and 9 steps', async () => {
    const { ws, env } = workspace([FLUX, ZIT]);
    const dir = await installFakeZImage(ws);
    const run = await ogw(ws, ['generation', 'measure', 'z-image-turbo', '--json'], { env });
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout) as { methods: Record<string, { steps: { resolution?: number; result: string; output: string }[]; error: string | null }> };
    const steps = result.methods['z-image-turbo']?.steps ?? [];
    expect(steps.map((s) => [s.resolution, s.result])).toEqual([[512, 'ok'], [1024, 'ok'], [2048, 'ok']]);
    for (const step of steps) {
      const out = join(dir, 'measure', String(step.resolution), 'out');
      expect(step.output).toBe(out);
      const side = String(step.resolution);
      expect(readFileSync(join(out, 'mflux-args.txt'), 'utf8')).toBe(
        `--model ${join(dir, 'hf', '0')} --quantize 8 --steps 9 --prompt-file ${join(dir, 'measure', side, 'prompt.txt')} --width ${side} --height ${side} --output ${join(out, 'image.png')} --seed 42\n`,
      );
      expect(readFileSync(join(out, 'image-alpha.png'), 'utf8')).toBe('png');
      expect(readFileSync(join(out, 'u2net.txt'), 'utf8')).toBe(`${join(dir, 'files')}\n`);
    }
    expect(readFileSync(join(dir, 'measure', '512', 'prompt.txt'), 'utf8')).toBe('A red apple game item, centered, plain background, front view.');
  });

  it('draws a key of a game whose image method it is from text, with the stage that generation methods gives and no seed', async () => {
    const { ws, env } = workspace([FLUX, ZIT]);
    const dir = await installFakeZImage(ws);
    const prompt = join(ws.root, 'prompt.txt');
    writeFileSync(prompt, 'a knight');
    const out = join(ws.root, 'out');
    const run = await ogw(ws, ['generation', 'run', 'z-image-turbo', '--game', 'g', '--key', 'image/hero', '--prompt', prompt, '--out', out, '--json'], { env });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ result: 'ok', stage: { resolution: 1024 }, output: out });
    // 900x600 scaled to the 1024 stage, each side a multiple of 16
    const args = readFileSync(join(out, 'mflux-args.txt'), 'utf8');
    expect(args).toMatch(new RegExp(`^--model ${join(dir, 'hf', '0')} --quantize 8 --steps 9 --prompt-file \\S+ --width 1024 --height 688 --output ${join(out, 'image.png')}\\n$`));
    expect(existsSync(join(out, 'image-alpha.png'))).toBe(true);
  });

  it('refuses an image to edit, alone or as one item of a batch, and makes nothing for it', async () => {
    const { ws, env } = workspace([FLUX, ZIT]);
    await installFakeZImage(ws);
    const prompt = join(ws.root, 'prompt.txt');
    writeFileSync(prompt, 'a knight');
    writeFileSync(join(ws.root, 'ref.png'), standardImage(4));
    const refusal = 'z-image-turbo takes no --image: it draws from text alone, and an image made from reference images is a flux2-klein call (production.md ## method)';
    const one = join(ws.root, 'one');
    const run = await ogw(ws, ['generation', 'run', 'z-image-turbo', '--game', 'g', '--key', 'image/hero', '--prompt', prompt, '--image', 'ref.png', '--out', one], { env });
    expect(run).toMatchObject({ code: 1, stderr: `${refusal}\n` });
    expect(existsSync(join(one, 'mflux-args.txt'))).toBe(false);
    const items = [
      { key: 'image/hero', prompt, out: join(ws.root, 'b1') },
      { key: 'image/hero', prompt, images: [join(ws.root, 'ref.png')], out: join(ws.root, 'b2') },
    ];
    writeFileSync(join(ws.root, 'batch.json'), JSON.stringify(items));
    const batch = await ogw(ws, ['generation', 'run', 'z-image-turbo', '--game', 'g', '--batch', join(ws.root, 'batch.json'), '--json'], { env });
    expect(batch.code).toBe(1);
    expect((JSON.parse(batch.stdout) as { items: unknown[] }).items).toEqual([
      { key: 'image/hero', out: join(ws.root, 'b1'), result: 'ok' },
      { key: 'image/hero', out: join(ws.root, 'b2'), result: 'failed', error: refusal },
    ]);
    expect(existsSync(join(ws.root, 'b2', 'mflux-args.txt'))).toBe(false);
  });

  it('lets flux2-klein make the reference edits of its game, a logo included, and is not called without a usable flux2-klein', async () => {
    fakeFlux();
    const { ws, env } = workspace([FLUX, ZIT, LOGOTYPE, FONTS]);
    await installFakeZImage(ws);
    await writeInstall(ws, FLUX);
    const prompt = join(ws.root, 'prompt.txt');
    writeFileSync(prompt, 'the logo');
    writeFileSync(join(ws.root, 'lettering.png'), standardImage(4));
    const edit = async (key: string, out: string): Promise<number> =>
      (await ogw(ws, ['generation', 'run', 'flux2-klein', '--game', 'g', '--key', key, '--prompt', prompt, '--image', 'lettering.png', '--out', join(ws.root, out)], { env })).code;
    // a logo key gives no temporary method: the flux2-klein stage of z-image-turbo, the highest one for 1024 px
    expect(await edit('image/logo/en', 'logo')).toBe(0);
    expect(readFileSync(join(ws.root, 'logo', 'flux.txt'), 'utf8')).toBe('512|1');
    expect(await edit('image/hero', 'hero')).toBe(0);
    expect(readFileSync(join(ws.root, 'hero', 'flux.txt'), 'utf8')).toBe('512|1');
    const unusable = workspace([{ ...FLUX, measured: [{ resolution: 512, result: 'failed' }] }, ZIT]);
    await installFakeZImage(unusable.ws);
    const refused = await ogw(unusable.ws, ['generation', 'run', 'z-image-turbo', '--game', 'g', '--key', 'image/hero', '--prompt', prompt, '--out', join(unusable.ws.root, 'o')], { env: unusable.env });
    expect(refused).toMatchObject({ code: 1, stderr: 'method z-image-turbo is not in ogw generation methods g image/hero\n' });
  });
});
