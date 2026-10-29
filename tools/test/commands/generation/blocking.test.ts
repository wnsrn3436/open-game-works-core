import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blockingMethods, installMethodJob } from '../../../src/commands/generation/api.ts';
import { createContext, type Context } from '../../../src/lib/command.ts';
import type { GameRepo } from '../../../src/lib/game.ts';
import { makeGame, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { addJob } from '../loop/helpers.ts';

const mocks = vi.hoisted(() => ({ startBackground: vi.fn() }));
vi.mock('../../../src/lib/cli.ts', async (orig) => ({ ...(await orig<object>()), startBackground: mocks.startBackground }));

const RESOURCES = [
  'key,description,spec,status,method,source,license,attribution,sha256,text_key,speaker,text_hash',
  'image/hero,hero,size=256x256;alpha=true,placeholder,,,,,,,,',
  'sfx/coin,coin,length=500,placeholder,,,,,,,,',
  'sfx/hit,hit,length=500,placeholder,,,,,,,,',
  'image/bad,bad,size=10,placeholder,,,,,,,,',
  'bgm/song,song,length=1000,placeholder,,,,,,,,',
  '',
].join('\n');

const PINS = [{ kind: 'git', source: 'x', revision: 'a' }];
const IMAGE = { name: 'flux2-klein', kind: 'local-model', resourceTypes: ['image'], safetyTimeoutMs: 1, license: 'X', pins: PINS, measured: [{ resolution: 512, result: 'ok' }] };
const SPRITE = { name: 'sprite', kind: 'external-service', provider: 'codex', resourceTypes: ['image'], safetyTimeoutMs: 1, license: 'X', pins: PINS, measured: [{ result: 'ok' }] };
const AUDIO = { name: 'audio', kind: 'local-model', resourceTypes: ['sfx', 'bgm'], safetyTimeoutMs: 1, license: 'X', pins: PINS, measured: [{ durationMs: 3000, result: 'ok' }] };
const TONE = { name: 'tone', kind: 'procedural', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', measured: [{ result: 'ok' }] };

async function open(): Promise<{ ws: TestWorkspace; ctx: Context; game: GameRepo }> {
  const ws = makeWorkspace({ resourceGeneration: [IMAGE, SPRITE, AUDIO, TONE], imageMethod: 'sprite' });
  makeGame(ws, 'g', { 'resource/resources.csv': RESOURCES });
  const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
  return { ws, ctx, game: await ctx.game('g') };
}

/** Writes the install marker of `method` as `generation install` does, with no cli so that tools.ffmpeg is not compared. */
function install(ws: TestWorkspace, method: string): void {
  const dir = join(ws.root, '.ogw', 'generation', method);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'installed.json'), JSON.stringify({ name: method, pins: JSON.stringify(PINS), git: [], hf: [], files: null, python: null, cli: null, skill: null }));
}

beforeEach(() => {
  mocks.startBackground.mockReset();
  mocks.startBackground.mockResolvedValue({ text: 'new1', data: { job: 'new1' } });
});

describe('blockingMethods', () => {
  it('gives the methods of a key when none of them is installed, leaving out the temporary method', async () => {
    const { ws, ctx, game } = await open();
    install(ws, 'flux2-klein');
    expect(await blockingMethods(ctx, game, 'image/hero')).toEqual(['sprite']);
    expect(await blockingMethods(ctx, game, 'sfx/coin')).toEqual(['audio']);
    install(ws, 'sprite');
    install(ws, 'audio');
    expect(await blockingMethods(ctx, game, 'image/hero')).toEqual([]);
    expect(await blockingMethods(ctx, game, 'sfx/coin')).toEqual([]);
  });

  it('gives none for a key with another installed method, a method without pins, or a key the list rejects', async () => {
    const { ctx, game } = await open();
    // tone is procedural: nothing to install
    expect(await blockingMethods(ctx, game, 'bgm/song')).toEqual([]);
    expect(await blockingMethods(ctx, game, 'image/bad')).toEqual([]);
    expect(await blockingMethods(ctx, game, 'image/missing')).toEqual([]);
  });

  it('treats a marker installed from other pins as not installed', async () => {
    const { ws, ctx, game } = await open();
    const dir = join(ws.root, '.ogw', 'generation', 'audio');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'installed.json'), JSON.stringify({ name: 'audio', pins: '[]', git: [], hf: [], files: null, python: null, cli: null, skill: null }));
    expect(await blockingMethods(ctx, game, 'sfx/hit')).toEqual(['audio']);
  });
});

describe('installMethodJob', () => {
  it('starts ogw generation install <method> in the background', async () => {
    const { ctx } = await open();
    expect(await installMethodJob(ctx, 'sprite')).toBe('new1');
    expect(mocks.startBackground).toHaveBeenCalledWith(ctx, expect.objectContaining({ name: ['generation', 'install'] }), { positionals: ['sprite'], values: {}, raw: ['sprite'] }, null);
  });

  it('gives the running install job of that method or of every method instead of starting one', async () => {
    const { ws, ctx } = await open();
    await addJob(ws, { command: 'generation install', argv: ['generation', 'install', 'audio'] });
    await addJob(ws, { command: 'generation install', argv: ['generation', 'install', 'sprite'], status: 'done' });
    const audio = await installMethodJob(ctx, 'audio');
    expect(audio).toMatch(/^job\d+x$/);
    expect(await installMethodJob(ctx, 'sprite')).toBe('new1');
    const all = await addJob(ws, { command: 'generation install', argv: ['generation', 'install'] });
    mocks.startBackground.mockClear();
    expect(await installMethodJob(ctx, 'sprite')).toBe(all.id);
    expect(mocks.startBackground).not.toHaveBeenCalled();
  });
});
