import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseStage } from '../../../src/commands/generation/lib/select.ts';
import { typeRow } from '../../../src/commands/generation/check.ts';
import { ogw, makeGame, makeWorkspace } from '../../helpers/workspace.ts';

const RESOURCES = [
  'key,description,spec,status,method,source,license,attribution,sha256,text_key,speaker,text_hash',
  'image/hero,"Hero, standing",size=800x600;alpha=true,placeholder,,,,,,,,',
  'image/big,big,size=4096x10,placeholder,,,,,,,,',
  'image/small,small,size=100x100,placeholder,,,,,,,,',
  'rig_animation_2d/hero,rig,size=512x512;animations=idle:800:loop,placeholder,,,,,,,,',
  'model/rock,rock,bounds=1x0.5x2,placeholder,,,,,,,,',
  'sfx/coin,coin,length=2000;variants=3,placeholder,,,,,,,,',
  'sprite_animation/fx,fx,size=64x64;animations=play:300:once,placeholder,,,,,,,,',
  'bgm/none,none,length=1000,placeholder,,,,,,,,',
  'image/bad,bad,size=10,placeholder,,,,,,,,',
  '',
].join('\n');

const IMAGE = {
  name: 'flux2-klein',
  kind: 'local-model',
  resourceTypes: ['image'],
  safetyTimeoutMs: 1,
  license: 'X',
  measured: [
    { resolution: 512, jobMs: 10, result: 'ok' },
    { resolution: 1024, jobMs: 20, result: 'ok' },
    { resolution: 2048, jobMs: 30, result: 'failed' },
  ],
};

function methods(imageMeasured: unknown = IMAGE.measured): unknown[] {
  return [
    { ...IMAGE, measured: imageMeasured },
    { name: 'rig-2d', kind: 'procedural', resourceTypes: ['rig_animation_2d'], safetyTimeoutMs: 1, license: 'X', measured: [{ result: 'ok' }] },
    { name: 'trellis2', kind: 'local-model', resourceTypes: ['model'], safetyTimeoutMs: 1, license: 'X', measured: [{ resolution: 512, result: 'ok' }] },
    { name: 'blender', kind: 'procedural', resourceTypes: ['model'], safetyTimeoutMs: 1, license: 'X', measured: [{ result: 'failed' }] },
    { name: 'sprite', kind: 'external-service', provider: 'codex', resourceTypes: ['sprite_animation'], safetyTimeoutMs: 1, license: 'X', pins: [{ kind: 'git', source: 'x', revision: 'a' }], measured: [{ result: 'ok' }] },
    { name: 'audio', kind: 'local-model', resourceTypes: ['sfx', 'bgm'], safetyTimeoutMs: 1, license: 'X', measured: [{ durationMs: 1000, jobMs: 5, result: 'ok' }, { durationMs: 3000, jobMs: 7, result: 'ok' }] },
    { name: 'later', kind: 'local-model', resourceTypes: ['image', 'bgm'], safetyTimeoutMs: 1, license: 'X' },
  ];
}

async function methodsOf(key: string, imageMeasured?: unknown): Promise<unknown> {
  const ws = makeWorkspace({ resourceGeneration: methods(imageMeasured) });
  makeGame(ws, 'g', { 'resource/resources.csv': RESOURCES });
  const run = await ogw(ws, ['generation', 'methods', 'g', key, '--json']);
  if (run.code !== 0) throw new Error(run.stderr);
  return (JSON.parse(run.stdout) as { methods: unknown }).methods;
}

describe('ogw generation methods', () => {
  it('gives each usable method and the lowest stage that covers the spec', async () => {
    expect(await methodsOf('image/hero')).toEqual([{ name: 'flux2-klein', kind: 'local-model', stage: { resolution: 1024, jobMs: 20, fallback: false } }]);
    expect(await methodsOf('image/small')).toEqual([{ name: 'flux2-klein', kind: 'local-model', stage: { resolution: 512, jobMs: 10, fallback: false } }]);
    expect(await methodsOf('image/big')).toEqual([{ name: 'flux2-klein', kind: 'local-model', stage: { resolution: 1024, jobMs: 20, fallback: true } }]);
    expect(await methodsOf('sfx/coin')).toEqual([{ name: 'audio', kind: 'local-model', stage: { durationMs: 3000, jobMs: 7, fallback: false } }]);
  });

  it('adds the flux2-klein stage to rig-2d and trellis2 and needs flux2-klein to be usable', async () => {
    expect(await methodsOf('rig_animation_2d/hero')).toEqual([
      { name: 'rig-2d', kind: 'procedural', stage: null, flux2Klein: { resolution: 512, jobMs: 10, fallback: false } },
    ]);
    expect(await methodsOf('model/rock')).toEqual([
      { name: 'trellis2', kind: 'local-model', stage: { resolution: 512, fallback: false }, flux2Klein: { resolution: 512, jobMs: 10, fallback: false } },
    ]);
    expect(await methodsOf('model/rock', [{ resolution: 512, result: 'failed' }])).toEqual([]);
  });

  it('gives skill and cli of a pinned external-service', async () => {
    expect(await methodsOf('sprite_animation/fx')).toEqual([{ name: 'sprite', kind: 'external-service', stage: null, skill: null, cli: null }, { name: 'flux2-klein', kind: 'local-model', stage: { resolution: 512, jobMs: 10, fallback: false }, temporary: true }]);
    const ws = makeWorkspace({ resourceGeneration: methods() });
    makeGame(ws, 'g', { 'resource/resources.csv': RESOURCES });
    const sprite = methods().find((m) => (m as { name: string }).name === 'sprite') as { pins: unknown[] };
    const dir = join(ws.root, '.ogw', 'generation', 'sprite');
    mkdirSync(dir, { recursive: true });
    const skill = join(dir, 'git', '0', 'SKILL.md');
    const cli = join(dir, 'bin', 'sprite-gen');
    // `ffmpeg: null` matches a workspace without tools.ffmpeg installed.
    const marker = { name: 'sprite', pins: JSON.stringify(sprite.pins), git: [], hf: [], files: null, python: null, cli, skill, ffmpeg: null };
    writeFileSync(join(dir, 'installed.json'), JSON.stringify(marker));
    const run = await ogw(ws, ['generation', 'methods', 'g', 'sprite_animation/fx', '--json']);
    expect((JSON.parse(run.stdout) as { methods: unknown }).methods).toEqual([{ name: 'sprite', kind: 'external-service', stage: null, skill, cli }, { name: 'flux2-klein', kind: 'local-model', stage: { resolution: 512, jobMs: 10, fallback: false }, temporary: true }]);
    expect((await ogw(ws, ['generation', 'methods', 'g', 'sprite_animation/fx'])).stdout).toBe(`sprite external-service no stage\n  skill ${skill}\n  cli ${cli}\nflux2-klein local-model resolution 512px temporary\n`);
  });

  it('prints one block per method, or none', async () => {
    const ws = makeWorkspace({ resourceGeneration: methods() });
    makeGame(ws, 'g', { 'resource/resources.csv': RESOURCES });
    expect((await ogw(ws, ['generation', 'methods', 'g', 'model/rock'])).stdout).toBe('trellis2 local-model resolution 512px\n  flux2-klein resolution 512px\n');
    expect((await ogw(ws, ['generation', 'methods', 'g', 'image/big'])).stdout).toBe('flux2-klein local-model resolution 1024px fallback\n');
    expect((await ogw(ws, ['generation', 'methods', 'g', 'sfx/coin'])).stdout).toBe('audio local-model duration 3000ms\n');
    expect((await ogw(ws, ['generation', 'methods', 'g', 'sprite_animation/fx'])).stdout).toBe(
      'sprite external-service no stage\n  skill not installed\n  cli not installed\nflux2-klein local-model resolution 512px temporary\n',
    );
    expect((await ogw(ws, ['generation', 'methods', 'g', 'bgm/none'])).stdout).toBe('audio local-model duration 1000ms\n');
  });

  it('gives an image type only the image method of the game, and flux2-klein as its temporary method', async () => {
    const sub = { name: 'sub', kind: 'external-service', provider: 'codex', resourceTypes: ['image', 'sprite_animation'], safetyTimeoutMs: 1, license: 'X', measured: [{ result: 'ok' }] };
    const host = (imageMethod: string): Record<string, unknown> => ({ resourceGeneration: [...methods(), sub], imageMethod });
    const run = async (imageMethod: string, list: string, key: string): Promise<unknown> => {
      const ws = makeWorkspace(host(imageMethod));
      makeGame(ws, 'g', { 'resource/resources.csv': list });
      const out = await ogw(ws, ['generation', 'methods', 'g', key, '--json']);
      if (out.code !== 0) throw new Error(out.stderr);
      return (JSON.parse(out.stdout) as { methods: { name: string; temporary?: boolean }[] }).methods.map((m) => `${m.name}${m.temporary ? ' temporary' : ''}`);
    };
    // no image made yet: the host imageMethod
    expect(await run('sub', RESOURCES, 'image/hero')).toEqual(['sub', 'flux2-klein temporary']);
    expect(await run('flux2-klein', RESOURCES, 'image/hero')).toEqual(['flux2-klein']);
    // the first final image fixes the method of the game, whatever this host chose
    const madeLocal = RESOURCES.replace('image/small,small,size=100x100,placeholder,,', 'image/small,small,size=100x100,final,flux2-klein,');
    expect(await run('sub', madeLocal, 'image/hero')).toEqual(['flux2-klein']);
    const madeSub = RESOURCES.replace('image/small,small,size=100x100,placeholder,,', 'image/small,small,size=100x100,final,sub,');
    expect(await run('flux2-klein', madeSub, 'image/hero')).toEqual(['sub', 'flux2-klein temporary']);
    // a temporary image does not fix it
    const temp = RESOURCES.replace('image/small,small,size=100x100,placeholder,,', 'image/small,small,size=100x100,temporary,flux2-klein,');
    expect(await run('sub', temp, 'image/hero')).toEqual(['sub', 'flux2-klein temporary']);
  });

  it('fails for a key not in resources.csv or a spec that breaks the rules', async () => {
    const ws = makeWorkspace({ resourceGeneration: methods() });
    makeGame(ws, 'g', { 'resource/resources.csv': RESOURCES });
    expect(await ogw(ws, ['generation', 'methods', 'g', 'image/nope'])).toMatchObject({ code: 1, stderr: 'resource key image/nope is not in resource/resources.csv\n' });
    expect(await ogw(ws, ['generation', 'methods', 'g', 'image/bad'])).toMatchObject({ code: 1, stderr: 'image/bad: spec size=10: invalid size value 10\n' });
    // A row whose cell count differs from the header is refused, as `ogw resource sync` refuses it.
    makeGame(ws, 'h', { 'resource/resources.csv': `${RESOURCES}image/short,short,size=1x1,placeholder\n` });
    const short = await ogw(ws, ['generation', 'methods', 'h', 'image/short']);
    expect(short.code).toBe(1);
    expect(short.stderr).toContain('resource/resources.csv');
    expect((await ogw(ws, ['generation', 'methods', 'g'])).code).toBe(1);
  });
});

describe('stage choice', () => {
  it('chooses no stage for a method measured without stages', () => {
    const none = { size: null, lengthMs: null };
    expect(chooseStage(undefined, none)).toBeNull();
    expect(chooseStage([{ result: 'ok' }], { size: [1, 1], lengthMs: null })).toBeNull();
    expect(chooseStage([{ resolution: 5, result: 'failed' }], none)).toBeNull();
  });
});

describe('ogw generation check', () => {
  const settingsMethods = [
    { name: 'a', kind: 'local-model', resourceTypes: ['image', 'icon'], safetyTimeoutMs: 1, license: 'X', measured: [{ resolution: 512, jobMs: 100, result: 'ok' }, { resolution: 1024, jobMs: 400, result: 'ok' }, { resolution: 2048, result: 'timeout' }] },
    { name: 'b', kind: 'local-model', resourceTypes: ['image'], safetyTimeoutMs: 1, license: 'X', measured: [{ durationMs: 10, result: 'ok' }] },
    { name: 'c', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X' },
    { name: 'd', kind: 'local-model', resourceTypes: ['sfx'], safetyTimeoutMs: 1, license: 'X', measured: [{ result: 'failed' }] },
  ];

  it('writes host-check.md with status, methods, counts and the total time', async () => {
    const ws = makeWorkspace({ resourceGeneration: settingsMethods, imageMethod: 'a' });
    const root = makeGame(ws, 'g');
    const run = await ogw(ws, ['generation', 'check', 'g', '--types', 'image,bgm,sfx,icon,model', '--counts', 'image=3,bgm=2,icon=1']);
    expect(run.code).toBe(0);
    const expected = [
      '| type | status | methods | to use | count | time ms |',
      '|---|---|---|---|---|---|',
      '| image | ok | a 1024px 400ms, b 10ms | a (none) | 3 | 0 |',
      '| bgm | unmeasured | - | - | - | - |',
      '| sfx | missing | - | - | - | - |',
      '| icon | ok | a 1024px 400ms | a (none) | 1 | 400 |',
      '| model | missing | - | - | - | - |',
      '',
      'total time ms: 400',
      '',
    ].join('\n');
    expect(readFileSync(join(root, 'records', 'setup', 'host-check.md'), 'utf8')).toBe(expected);
    expect(run.stdout).toBe(expected);
  });

  it('writes a dash total when no ok type has a count', async () => {
    const ws = makeWorkspace({ resourceGeneration: settingsMethods });
    const root = makeGame(ws, 'g');
    await ogw(ws, ['generation', 'check', 'g', '--types', 'bgm']);
    expect(readFileSync(join(root, 'records', 'setup', 'host-check.md'), 'utf8')).toContain('total time ms: -\n');
  });

  it('refuses unknown types and bad counts without writing', async () => {
    const ws = makeWorkspace({ resourceGeneration: settingsMethods });
    makeGame(ws, 'g');
    const cases: [string[], string][] = [
      [['--types', 'image,tween'], 'not a resource type of harness settings schema resourceTypes: tween\n'],
      [['--types', 'image', '--counts', 'bgm=1'], '--counts type bgm is not in --types\n'],
      [['--types', 'image', '--counts', 'image=0'], '--counts image must be an integer of 1 or more: 0\n'],
      [['--types', 'image', '--counts', 'image=1.5'], '--counts image must be an integer of 1 or more: 1.5\n'],
      [['--types', 'image', '--counts', 'image'], '--counts item must be <type>=<n>: image\n'],
      [['--types', 'image', '--counts', 'image=1=2'], '--counts item must be <type>=<n>: image=1=2\n'],
      [['--types', 'image,image', '--counts', 'image=3'], '--types has a type twice: image\n'],
      [['--types', 'image', '--counts', 'image=1,image=3'], '--counts has type image twice\n'],
      [[], 'usage: ogw generation check <game> --types <type,...> [--counts <type>=<n>,...]\n'],
    ];
    for (const [args, stderr] of cases) {
      expect(await ogw(ws, ['generation', 'check', 'g', ...args])).toMatchObject({ code: 1, stderr });
    }
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(ws.games, 'g', 'records', 'setup', 'host-check.md'))).toBe(false);
  });

  it('computes the time with the smallest count × jobMs', () => {
    const row = typeRow('image', [
      { name: 'x', kind: 'local-model', resourceTypes: ['image'], safetyTimeoutMs: 1, measured: [{ jobMs: 50, result: 'ok' }] },
      { name: 'y', kind: 'local-model', resourceTypes: ['image'], safetyTimeoutMs: 1, measured: [{ jobMs: 20, result: 'ok' }] },
    ], 4);
    expect(row).toMatchObject({ status: 'ok', count: 4, timeMs: 80 });
  });
});
