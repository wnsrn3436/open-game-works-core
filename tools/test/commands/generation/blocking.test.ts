import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blockingMethods, generationMethods, installMethodJob } from '../../../src/commands/generation/api.ts';
import { createContext, type Context } from '../../../src/lib/command.ts';
import type { GameRepo } from '../../../src/lib/game.ts';
import { makeGame, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { addJob } from '../loop/helpers.ts';
import { installFolder, writeInstall } from './install-folder.ts';

const mocks = vi.hoisted(() => ({ startBackground: vi.fn() }));
vi.mock('../../../src/lib/cli.ts', async (orig) => ({ ...(await orig<object>()), startBackground: mocks.startBackground }));

const RESOURCES = [
  'key,description,spec,status,method,source,license,attribution,sha256,text_key,speaker,text_hash',
  'image/hero,hero,size=256x256;alpha=true,placeholder,,,,,,,,',
  'sfx/coin,coin,length=500,placeholder,,,,,,,,',
  'sfx/hit,hit,length=500,placeholder,,,,,,,,',
  'image/bad,bad,size=10,placeholder,,,,,,,,',
  'bgm/song,song,length=1000,placeholder,,,,,,,,',
  'model/rock,rock,bounds=1x0.5x2,placeholder,,,,,,,,',
  '',
].join('\n');

const PINS = [{ kind: 'git', source: 'x', revision: 'a' }];
const IMAGE = { name: 'flux2-klein', kind: 'local-model', resourceTypes: ['image'], safetyTimeoutMs: 1, license: 'X', pins: PINS, measured: [{ resolution: 512, result: 'ok' }] };
const SPRITE = { name: 'sprite', kind: 'external-service', provider: 'codex', resourceTypes: ['image'], safetyTimeoutMs: 1, license: 'X', pins: PINS, measured: [{ result: 'ok' }] };
const AUDIO = { name: 'audio', kind: 'local-model', resourceTypes: ['sfx', 'bgm'], safetyTimeoutMs: 1, license: 'X', pins: PINS, measured: [{ durationMs: 3000, result: 'ok' }] };
const TONE = { name: 'tone', kind: 'procedural', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', measured: [{ result: 'ok' }] };
const MESH = { name: 'trellis2', kind: 'local-model', resourceTypes: ['model'], safetyTimeoutMs: 1, license: 'X', pins: PINS, measured: [{ resolution: 512, result: 'ok' }] };

async function open(): Promise<{ ws: TestWorkspace; ctx: Context; game: GameRepo }> {
  const ws = makeWorkspace({ resourceGeneration: [IMAGE, SPRITE, AUDIO, TONE, MESH], imageMethod: 'sprite' });
  makeGame(ws, 'g', { 'resource/resources.csv': RESOURCES });
  const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
  return { ws, ctx, game: await ctx.game('g') };
}

const METHODS: Record<string, { name: string }> = Object.fromEntries([IMAGE, SPRITE, AUDIO, TONE, MESH].map((m) => [m.name, m]));
const FONTS = { name: 'font-catalog', kind: 'catalog', resourceTypes: ['font'], safetyTimeoutMs: 1, license: 'X', pins: PINS, measured: [{ result: 'ok' }] };

/** Writes the install marker of `method` into its install folder on the checkout of `ws`, as `generation install` does. */
async function install(ws: TestWorkspace, method: string): Promise<void> {
  await writeInstall(ws, { ...(METHODS[method] ?? FONTS), name: method });
}

beforeEach(() => {
  mocks.startBackground.mockReset();
  mocks.startBackground.mockResolvedValue({ text: 'new1', data: { job: 'new1' } });
});

describe('blockingMethods', () => {
  it('gives the methods of a key when none of them is installed, leaving out the temporary method', async () => {
    const { ws, ctx, game } = await open();
    await install(ws, 'flux2-klein');
    expect(await blockingMethods(ctx, game, 'image/hero')).toEqual(['sprite']);
    expect(await blockingMethods(ctx, game, 'sfx/coin')).toEqual(['audio']);
    await install(ws, 'sprite');
    await install(ws, 'audio');
    expect(await blockingMethods(ctx, game, 'image/hero')).toEqual([]);
    expect(await blockingMethods(ctx, game, 'sfx/coin')).toEqual([]);
  });

  it('adds the temporary method when it is not installed either, as the key is then made with nothing', async () => {
    const { ctx, game } = await open();
    expect(await blockingMethods(ctx, game, 'image/hero')).toEqual(['sprite', 'flux2-klein']);
  });

  it('gives none for a key with another installed method, a method without pins, or a key the list rejects', async () => {
    const { ctx, game } = await open();
    // tone is procedural: nothing to install
    expect(await blockingMethods(ctx, game, 'bgm/song')).toEqual([]);
    expect(await blockingMethods(ctx, game, 'image/bad')).toEqual([]);
    expect(await blockingMethods(ctx, game, 'image/missing')).toEqual([]);
  });

  it('needs flux2-klein installed for trellis2, which calls it', async () => {
    const { ws, ctx, game } = await open();
    expect(await blockingMethods(ctx, game, 'model/rock')).toEqual(['trellis2', 'flux2-klein']);
    await install(ws, 'trellis2');
    expect(await blockingMethods(ctx, game, 'model/rock')).toEqual(['flux2-klein']);
    await install(ws, 'flux2-klein');
    expect(await blockingMethods(ctx, game, 'model/rock')).toEqual([]);
  });

  it('needs flux2-klein installed for z-image-turbo, which calls it, and font-catalog too for a logo it draws', async () => {
    const ZIT = { name: 'z-image-turbo', kind: 'local-model', resourceTypes: ['image'], safetyTimeoutMs: 1, license: 'X', pins: PINS, measured: [{ resolution: 512, result: 'ok' }] };
    const LOGOTYPE = { name: 'logotype', kind: 'procedural', resourceTypes: ['image'], safetyTimeoutMs: 1, license: 'X', measured: [{ result: 'ok' }] };
    const ws = makeWorkspace({ resourceGeneration: [IMAGE, ZIT, LOGOTYPE, FONTS], imageMethod: 'z-image-turbo' });
    makeGame(ws, 'g', { 'resource/resources.csv': `${RESOURCES}image/logo/ko,logo,size=1024x512;alpha=true,placeholder,,,,,,,,\n` });
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const game = await ctx.game('g');
    expect(await blockingMethods(ctx, game, 'image/hero')).toEqual(['z-image-turbo', 'flux2-klein']);
    expect(await blockingMethods(ctx, game, 'image/logo/ko')).toEqual(['z-image-turbo', 'flux2-klein', 'font-catalog']);
    await writeInstall(ws, ZIT);
    expect(await blockingMethods(ctx, game, 'image/hero')).toEqual(['flux2-klein']);
    expect(await blockingMethods(ctx, game, 'image/logo/ko')).toEqual(['flux2-klein', 'font-catalog']);
    await install(ws, 'flux2-klein');
    expect(await blockingMethods(ctx, game, 'image/hero')).toEqual([]);
    expect(await blockingMethods(ctx, game, 'image/logo/ko')).toEqual(['font-catalog']);
    const names = async (key: string): Promise<string[]> => (await generationMethods(ctx, game, key)).map((c) => `${c.name}${c.notInstalled === true ? ' not installed' : ''}`);
    expect(await names('image/hero')).toEqual(['z-image-turbo', 'flux2-klein']);
    await install(ws, 'font-catalog');
    expect(await blockingMethods(ctx, game, 'image/logo/ko')).toEqual([]);
  });

  it('treats a provider method installed for another ffmpeg as another install, which leaves it not installed here', async () => {
    const { ws, ctx, game } = await open();
    // the install of a checkout whose cli puts its own ffmpeg on PATH, while this one has none installed: another key
    const other = join(dirname(await installFolder(ws, SPRITE)), 'f'.repeat(16));
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'installed.json'), JSON.stringify({ name: 'sprite', pins: JSON.stringify(PINS), git: [], hf: [], files: null, python: null, cli: '/other/bin/sprite-gen', skill: '/other/SKILL.md', ffmpeg: '/other/ffmpeg' }));
    await install(ws, 'flux2-klein');
    expect(await blockingMethods(ctx, game, 'image/hero')).toEqual(['sprite']);
  });

  it('needs the image method and font-catalog for a logo, and font-catalog alone only where no image method draws it', async () => {
    const LOGOTYPE = { name: 'logotype', kind: 'procedural', resourceTypes: ['image'], safetyTimeoutMs: 1, license: 'X', measured: [{ result: 'ok' }] };
    const logoGame = async (methods: Record<string, unknown>[]): Promise<{ ws: TestWorkspace; ctx: Context; game: GameRepo }> => {
      const ws = makeWorkspace({ resourceGeneration: methods, imageMethod: 'sprite' });
      makeGame(ws, 'g', { 'resource/resources.csv': `${RESOURCES}image/logo/ko,logo,size=1024x512;alpha=true,placeholder,,,,,,,,\n` });
      const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
      return { ws, ctx, game: await ctx.game('g') };
    };
    const drawn = await logoGame([IMAGE, SPRITE, LOGOTYPE, FONTS]);
    expect(await blockingMethods(drawn.ctx, drawn.game, 'image/logo/ko')).toEqual(['sprite', 'font-catalog']);
    // the fonts alone letter it, but the image method draws the logo
    await install(drawn.ws, 'font-catalog');
    expect(await blockingMethods(drawn.ctx, drawn.game, 'image/logo/ko')).toEqual(['sprite']);
    await install(drawn.ws, 'sprite');
    expect(await blockingMethods(drawn.ctx, drawn.game, 'image/logo/ko')).toEqual([]);
    // the image method alone has no lettering to draw
    const unlettered = await logoGame([IMAGE, SPRITE, LOGOTYPE, FONTS]);
    await install(unlettered.ws, 'sprite');
    expect(await blockingMethods(unlettered.ctx, unlettered.game, 'image/logo/ko')).toEqual(['font-catalog']);
    // a host whose image method cannot be used letters the logo with the fonts
    const lettered = await logoGame([IMAGE, { ...SPRITE, measured: [{ result: 'failed' }] }, LOGOTYPE, FONTS]);
    expect(await blockingMethods(lettered.ctx, lettered.game, 'image/logo/ko')).toEqual(['font-catalog']);
    await install(lettered.ws, 'font-catalog');
    expect(await blockingMethods(lettered.ctx, lettered.game, 'image/logo/ko')).toEqual([]);
  });

  it('treats a marker installed from other pins as not installed', async () => {
    const { ws, ctx, game } = await open();
    await writeInstall(ws, AUDIO, { pins: '[]' });
    expect(await blockingMethods(ctx, game, 'sfx/hit')).toEqual(['audio']);
  });
});

describe('generationMethods install state', () => {
  it('marks a method, or the flux2-klein that trellis2 calls, not installed until its install marker is there', async () => {
    const { ws, ctx, game } = await open();
    const names = async (key: string): Promise<string[]> => (await generationMethods(ctx, game, key)).map((c) => `${c.name}${c.temporary === true ? ' temporary' : ''}${c.notInstalled === true ? ' not installed' : ''}`);
    expect(await names('image/hero')).toEqual(['sprite not installed', 'flux2-klein temporary not installed']);
    expect(await names('bgm/song')).toEqual(['audio not installed', 'tone']);
    await install(ws, 'trellis2');
    expect(await names('model/rock')).toEqual(['trellis2 not installed']);
    await install(ws, 'flux2-klein');
    expect(await names('image/hero')).toEqual(['sprite not installed', 'flux2-klein temporary']);
    expect(await names('model/rock')).toEqual(['trellis2']);
  });
});

describe('installMethodJob', () => {
  it('starts ogw generation install <method> in the background', async () => {
    const { ctx } = await open();
    expect(await installMethodJob(ctx, 'audio')).toEqual({ job: 'new1', argv: ['generation', 'install', 'audio'] });
    expect(mocks.startBackground).toHaveBeenCalledWith(ctx, expect.objectContaining({ name: ['generation', 'install'] }), { positionals: ['audio'], values: {}, raw: ['audio'] }, null);
  });

  it('does not start the install of a provider method while tools.ffmpeg is not installed', async () => {
    const { ctx } = await open();
    await expect(installMethodJob(ctx, 'sprite')).rejects.toThrow('tools.ffmpeg is not installed: ogw generation install installs it');
    expect(mocks.startBackground).not.toHaveBeenCalled();
  });

  it('gives the running install job whose record names the install folder of that method on this checkout instead of starting one', async () => {
    const { ws, ctx } = await open();
    const folder = (name: string): Promise<string> => installFolder(ws, METHODS[name] as { name: string });
    const audio = await addJob(ws, { command: 'generation install', argv: ['generation', 'install', 'audio'], meta: { installs: { audio: await folder('audio') } } });
    await addJob(ws, { command: 'generation install', argv: ['generation', 'install', 'flux2-klein'], status: 'done', meta: { installs: { 'flux2-klein': await folder('flux2-klein') } } });
    expect(await installMethodJob(ctx, 'audio')).toEqual({ job: audio.id, argv: ['generation', 'install', 'audio'] });
    expect((await installMethodJob(ctx, 'flux2-klein')).job).toBe('new1');
    const all = await addJob(ws, { command: 'generation install', argv: ['generation', 'install'], meta: { installs: { trellis2: await folder('trellis2') } } });
    mocks.startBackground.mockClear();
    expect(await installMethodJob(ctx, 'trellis2')).toEqual({ job: all.id, argv: ['generation', 'install'] });
    expect(mocks.startBackground).not.toHaveBeenCalled();
  });

  it('starts its own install while a running install job of that method installs into another install folder', async () => {
    const { ws, ctx } = await open();
    // the job of another checkout of the harness on this host, which shares the jobs folder: other pins, another folder
    await addJob(ws, { command: 'generation install', argv: ['generation', 'install', 'audio'], meta: { installs: { audio: `${await installFolder(ws, AUDIO)}-other` } } });
    // a job that has not reached the method yet names no folder of it
    await addJob(ws, { command: 'generation install', argv: ['generation', 'install'], meta: {} });
    expect(await installMethodJob(ctx, 'audio')).toEqual({ job: 'new1', argv: ['generation', 'install', 'audio'] });
  });
});
