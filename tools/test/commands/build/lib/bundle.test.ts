import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataResourceKeys } from '../../../../src/commands/build/lib/bundle-data.ts';
import { godotBundle } from '../../../../src/commands/build/lib/godot-bundle.ts';
import { compatibilityCheck } from '../../../../src/commands/build/lib/runchecks.ts';
import { saveSchemaCheck } from '../../../../src/commands/build/lib/saveschema.ts';
import { runContract } from '../../../../src/commands/contract/api.ts';
import { coreReleaseOfGame, extractedAsset } from '../../../../src/commands/core/api.ts';
import { runData } from '../../../../src/commands/data/api.ts';
import { requireEngine } from '../../../../src/commands/env/api.ts';
import { mergedCoreSettings } from '../../../../src/commands/generate/api.ts';
import { createContext } from '../../../../src/lib/command.ts';
import type { GameRepo } from '../../../../src/lib/game.ts';
import { makeWorkspace, type TestWorkspace } from '../../../helpers/workspace.ts';
import { commit, fakeBin, gameRepo, gameSettings, git, setupGame, write } from '../helpers.ts';

vi.mock('../../../../src/commands/core/api.ts', async (orig) => ({ ...(await orig<object>()), coreReleaseOfGame: vi.fn(), extractedAsset: vi.fn() }));
vi.mock('../../../../src/commands/env/api.ts', async (orig) => ({ ...(await orig<object>()), requireEngine: vi.fn() }));
vi.mock('../../../../src/commands/data/api.ts', async (orig) => ({ ...(await orig<object>()), runData: vi.fn() }));
vi.mock('../../../../src/commands/generate/api.ts', async (orig) => ({ ...(await orig<object>()), mergedCoreSettings: vi.fn() }));
vi.mock('../../../../src/commands/build/lib/saveschema.ts', () => ({ saveSchemaCheck: vi.fn() }));
vi.mock('../../../../src/commands/contract/api.ts', async (orig) => ({ ...(await orig<object>()), runContract: vi.fn() }));

const ctxOf = (ws: TestWorkspace, env: NodeJS.ProcessEnv = {}) => createContext({ cwd: ws.root, env: { ...ws.env, ...env }, stdin: () => Promise.resolve(''), stderr: () => undefined });

const GODOT = `case "$*" in
  *--script*) for last; do :; done; cp "$last" "$FAKE_DIR/spec.json"; node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); for (const p of s.pcks) { require("fs").writeFileSync(p.path, "PCK" + p.files.length); require("fs").copyFileSync(p.files.at(-1).source, process.env.FAKE_DIR + "/keys.json") }' "$last";;
esac`;

beforeEach(() => {
  vi.mocked(runData).mockImplementation((_c, repo: GameRepo) => {
    const v = readFileSync(join(repo.root, 'data', 'v.txt'), 'utf8').trim();
    write(repo.root, 'client/build/data/data_version', v);
    write(repo.root, 'client/build/data/items.bin', v);
    write(repo.root, 'server/build/data/data_version', v);
    return Promise.resolve({ exitCode: 0, lines: [], stderr: '' });
  });
  vi.mocked(mergedCoreSettings).mockResolvedValue({ 'game-update': { maxFileBytes: 1_000_000 }, GameUpdateCore: { fileMaxBytes: 2_000_000 } });
});

describe('godotBundle', () => {
  function setup(ws: TestWorkspace) {
    const release = join(ws.root, 'release');
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, 'engine.json'), JSON.stringify({ godot: '4.5.1.stable' }));
    vi.mocked(coreReleaseOfGame).mockResolvedValue({ version: '1.0.0', dir: release, local: false });
    vi.mocked(extractedAsset).mockResolvedValue(release);
    const bin = fakeBin(ws, { godot: GODOT });
    vi.mocked(requireEngine).mockResolvedValue(join(bin.bin, 'godot'));
    const dir = setupGame(ws, 'g', {}, {
      'data/v.txt': 'p1-d1',
      'resource/resources.csv': 'key,sha256\nbg/a,1\nbg/old,9\nscene/s,5\n',
      'client/features/x.gd': 'extends Node\n',
    });
    git(dir, 'tag', 'dev-1.0.0');
    write(dir, 'resource/resources.csv', 'key,sha256\nbg/a,2\nbg/b,3\nscene/s,6\nbg/old,9\n');
    write(dir, 'client/generated/resource_keys.json', {
      'bg/a': { path: 'res://resource/bg/a.png', variants: 1 },
      'bg/b': { path: 'res://resource/bg/b.ogg', variants: 2 },
      'scene/s': { path: 'res://resource/scene/s.tscn', variants: 1 },
    });
    write(dir, 'client/resource/bg/a.png', 'png');
    write(dir, 'client/resource/bg/a.png.import', '[remap]\n\n[deps]\n\nsource_file="res://resource/bg/a.png"\ndest_files=["res://.godot/imported/a.png-1.ctex"]\n');
    write(dir, 'client/.godot/imported/a.png-1.ctex', 'ctex');
    write(dir, 'client/resource/bg/b.1.ogg', 'ogg1');
    write(dir, 'client/resource/bg/b.2.ogg', 'ogg2');
    write(dir, 'client/resource/scene/s.tscn', '[gd_scene]\n[ext_resource type="Script" path="res://features/x.gd" id="1"]\n');
    write(dir, 'client/features/x.gd', 'extends Node2D\n');
    commit(dir, 'changes');
    return { dir, bin };
  }

  it('packs the changed keys without scenes that use changed code, and writes patch.json', async () => {
    const ws = makeWorkspace();
    const { dir, bin } = setup(ws);
    const game = await gameRepo(ws);
    const outDir = join(dir, 'builds', 'dev-1.0.0-bundle-1');
    const failures = await godotBundle(ctxOf(ws, { ...bin.env, FAKE_DIR: bin.bin }), { game, env: 'DEV', version: '1.0.0-bundle-1', appVersion: '1.0.0', settings: gameSettings(), outDir, withData: false });
    expect(failures).toEqual([]);
    const spec = JSON.parse(readFileSync(join(bin.bin, 'spec.json'), 'utf8')) as { pcks: { path: string; files: { target: string }[] }[] };
    expect(spec.pcks.map((p) => p.files.map((f) => f.target))).toEqual([
      ['res://resource/bg/a.png.import', 'res://.godot/imported/a.png-1.ctex', 'res://resource/bg/b.1.ogg', 'res://resource/bg/b.2.ogg', 'res://bundle_keys/patch_1.json'],
    ]);
    expect(JSON.parse(readFileSync(join(bin.bin, 'keys.json'), 'utf8'))).toEqual({
      'bg/a': { path: 'res://resource/bg/a.png', variants: 1 },
      'bg/b': { path: 'res://resource/bg/b.ogg', variants: 2 },
    });
    const patch = JSON.parse(readFileSync(join(outDir, 'patch', 'patch.json'), 'utf8')) as Record<string, unknown>;
    expect(patch).toEqual({
      data_version: 'p1-d1', data_files: [], translation_files: [],
      bundle_files: [{ bundle: 'patch_1', name: 'patch_1.pck', size: 4, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as string }],
    });
    expect(readFileSync(join(outDir, 'patch', 'patch_1.pck'), 'utf8')).toBe('PCK5');
  });

  it('carries data and reports removed keys', async () => {
    const ws = makeWorkspace();
    const { dir, bin } = setup(ws);
    write(dir, 'data/v.txt', 'p1-d2');
    commit(dir, 'data');
    const game = await gameRepo(ws);
    const outDir = join(dir, 'builds', 'dev-1.0.0-bundle-1');
    const ctx = ctxOf(ws, { ...bin.env, FAKE_DIR: bin.bin });
    await godotBundle(ctx, { game, env: 'DEV', version: '1.0.0-bundle-1', appVersion: '1.0.0', settings: gameSettings(), outDir, withData: true });
    const patch = JSON.parse(readFileSync(join(outDir, 'patch', 'patch.json'), 'utf8')) as { data_version: string; data_files: { name: string }[] };
    expect(patch.data_version).toBe('p1-d2');
    expect(patch.data_files.map((f) => f.name)).toEqual(['items.bin']);
    expect(readFileSync(join(outDir, 'patch', 'items.bin'), 'utf8')).toBe('p1-d2');
    write(dir, 'resource/resources.csv', 'key,sha256\nbg/a,2\n');
    commit(dir, 'remove');
    expect(await godotBundle(ctx, { game, env: 'DEV', version: '1.0.0-bundle-1', appVersion: '1.0.0', settings: gameSettings(), outDir, withData: false })).toEqual([
      'resource key bg/old of app version 1.0.0 was removed',
      'resource key scene/s of app version 1.0.0 was removed',
    ]);
  });
});

describe('dataResourceKeys', () => {
  it('reads reskey columns and game_setting values of data_type reskey or array<reskey> with target Client or All', async () => {
    const ws = makeWorkspace();
    const root = join(ws.root, 'checkout');
    write(root, 'data/tables/item.csv', ',,\nAll,Client\nid(key),array<reskey>\nid,icons\n[sword],"bg/a\nbg/b"\n#[old],bg/x\n');
    write(root, 'data/system/game_setting.csv', [
      ',,,',
      'All,None,None,All',
      'id(key),string,string,string',
      'id,target,data_type,value',
      '[home_banner],Client,reskey,ui/banner_new',
      '[menu_icons],All,array<reskey>,"ui/i1\nui/i2"',
      '[server_art],Server,reskey,ui/server_only',
      '[title],Client,string,ui/not_a_key',
      '#[off],Client,reskey,ui/commented',
      '',
    ].join('\n'));
    expect(await dataResourceKeys(root)).toEqual(['bg/a', 'bg/b', 'ui/banner_new', 'ui/i1', 'ui/i2']);
  });

  it('skips the null cell of a nullable reskey? column', async () => {
    const ws = makeWorkspace();
    const root = join(ws.root, 'checkout');
    write(root, 'data/tables/stage.csv', ',,\nAll,Client\nid(key),reskey?\nid,bg\n[s1],null\n[s2],bg/forest\n');
    expect(await dataResourceKeys(root)).toEqual(['bg/forest']);
  });
});

describe('godotBundle data', () => {
  it('fails the bundle check on data of another protocol hash or naming a key the app lacks with this bundle', async () => {
    const ws = makeWorkspace();
    const release = join(ws.root, 'release');
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, 'engine.json'), JSON.stringify({ godot: '4.5.1.stable' }));
    vi.mocked(coreReleaseOfGame).mockResolvedValue({ version: '1.0.0', dir: release, local: false });
    vi.mocked(extractedAsset).mockResolvedValue(release);
    const bin = fakeBin(ws, { godot: GODOT });
    vi.mocked(requireEngine).mockResolvedValue(join(bin.bin, 'godot'));
    const dir = setupGame(ws, 'g', {}, { 'data/v.txt': 'p1-d1', 'resource/resources.csv': 'key,sha256\nbg/a,1\n' });
    git(dir, 'tag', 'dev-1.0.0');
    write(dir, 'resource/resources.csv', 'key,sha256\nbg/a,1\nbg/b,2\nbg/c,3\n');
    write(dir, 'client/generated/resource_keys.json', { 'bg/b': { path: 'res://resource/bg/b.png', variants: 1 } });
    write(dir, 'client/resource/bg/b.png', 'png');
    write(dir, 'data/tables/item.csv', ',,\nAll,Client\nid,array<reskey>\nid,icons\n[sword],"bg/a\nbg/b"\n[shield],bg/c\n');
    write(dir, 'data/v.txt', 'p2-d2');
    commit(dir, 'new protocol');
    const game = await gameRepo(ws);
    const ctx = ctxOf(ws, { ...bin.env, FAKE_DIR: bin.bin });
    const outDir = join(dir, 'builds', 'dev-1.0.0-bundle-1');
    expect(await godotBundle(ctx, { game, env: 'DEV', version: '1.0.0-bundle-1', appVersion: '1.0.0', settings: gameSettings(), outDir, withData: true })).toEqual([
      'data protocol hash p2 differs from app version 1.0.0 (p1)',
      'data names resource key bg/c, which app version 1.0.0 with its bundle lacks',
    ]);
    // the build workspace: strict, no second comparison with the PROD data tag; the app tag commit: binaryBuildAt
    expect(vi.mocked(runData).mock.calls.map((c) => c[2])).toEqual([{ binary: true, strict: true, prodCompare: false }, { binary: true, generate: false, prodCompare: false, published: true }]);
    write(dir, 'data/v.txt', 'p1-d2');
    write(dir, 'client/generated/resource_keys.json', { 'bg/b': { path: 'res://resource/bg/b.png', variants: 1 }, 'bg/c': { path: 'res://resource/bg/c.png', variants: 1 } });
    write(dir, 'client/resource/bg/c.png', 'png');
    commit(dir, 'same protocol');
    expect(await godotBundle(ctx, { game, env: 'DEV', version: '1.0.0-bundle-1', appVersion: '1.0.0', settings: gameSettings(), outDir, withData: true })).toEqual([]);
    expect((JSON.parse(readFileSync(join(outDir, 'patch', 'patch.json'), 'utf8')) as { data_version: string }).data_version).toBe('p1-d2');
  });
});

describe('compatibilityCheck', () => {
  it('compares game settings with the last PROD build and runs the save schema check on a contract version change', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws, 'g', { dailyResetOffsetMs: 0, nicknameUnique: true }, { 'server/generated/contract/c.ts': 'export const CONTRACT_VERSION = 3;\n' });
    git(dir, 'tag', 'prod-1.0.0');
    const game = await gameRepo(ws);
    vi.mocked(runContract).mockResolvedValue({ exitCode: 2, violations: [], stderr: 'bad input\n' });
    const settings = { ...gameSettings(), dailyResetOffsetMs: -32_400_000, nicknameUnique: true, environments: { PROD: { updatePublicKeys: [] } } };
    const data = { exitCode: 1, stderr: '', lines: [
      { level: 'ERROR' as const, code: 'prod_change', where: 'x', message: 'm', text: 'ERROR prod_change x' },
      { level: 'WARN' as const, code: 'protocol_change', where: 'x', message: 'm', text: 'WARN' },
      { level: 'ERROR' as const, code: 'value_type', where: 'x', message: 'm', text: 'ERROR value_type' },
    ] };
    const lastProd = { tag: 'prod-1.0.0', env: 'PROD' as const, version: '1.0.0', bundle: null };
    const result = await compatibilityCheck({ ctx: ctxOf(ws), game, env: 'STG', settings, lastProd, data, stgImage: null, compat: '' });
    expect(result.check).toEqual({ name: 'backward compatibility', result: 'fail', details: [
      'contract: contract tool failed: bad input',
      'data: ERROR prod_change x',
      'game settings dailyResetOffsetMs differs from prod-1.0.0',
      'game settings environments.PROD.updatePublicKeys lost AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= of prod-1.0.0',
    ] });
    write(dir, 'server/generated/contract/c.ts', 'export const CONTRACT_VERSION = 4;\n');
    commit(dir, 'v4');
    vi.mocked(runContract).mockResolvedValue({ exitCode: 0, violations: [], stderr: '' });
    const input = { ctx: ctxOf(ws), game, env: 'STG' as const, settings: { ...gameSettings(), dailyResetOffsetMs: 0, nicknameUnique: true }, lastProd, data: { exitCode: 0, lines: [], stderr: '' }, stgImage: null, compat: '' };
    vi.mocked(saveSchemaCheck).mockResolvedValue({ failures: ['save schema: user 1: user_state k/1 from_version 3: boom'], unknownKinds: ['QuestUserState'] });
    expect((await compatibilityCheck(input)).check).toEqual({ name: 'backward compatibility', result: 'fail', details: ['save schema: user 1: user_state k/1 from_version 3: boom'] });
    expect(vi.mocked(saveSchemaCheck).mock.calls[0]?.[0]).toMatchObject({ prodCommit: git(dir, 'rev-parse', 'prod-1.0.0').trim(), currentVersion: 4 });
    vi.mocked(saveSchemaCheck).mockResolvedValue({ failures: [], unknownKinds: ['QuestUserState'] });
    expect(await compatibilityCheck(input)).toEqual({ check: { name: 'backward compatibility', result: 'unknown', details: [
      'save schema: unknown: no sampled QuestUserState record has a contract version below 4',
    ] }, human: null });
    vi.mocked(saveSchemaCheck).mockResolvedValue({ failures: [], unknownKinds: [] });
    expect((await compatibilityCheck(input)).check.result).toBe('pass');
  });
});
