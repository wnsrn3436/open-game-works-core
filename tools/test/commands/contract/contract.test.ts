import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runContract } from '../../../src/commands/contract/api.ts';
import { runGenerate } from '../../../src/commands/generate/api.ts';
import { ogw, commitAll, makeGame, makeWorkspace, sh } from '../../helpers/workspace.ts';
import { ctxOf, GAME_SETTINGS, makeRelease, toolCalls, write } from '../generate/helpers.ts';

vi.mock('../../../src/commands/core/api.ts', async () => (await import('../generate/helpers.ts')).coreApiMock);
vi.mock('../../../src/commands/generate/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/generate/api.ts')>()),
  runGenerate: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  vi.mocked(runGenerate).mockClear();
});

describe('runContract', () => {
  it('runs generate, then the contract tool of the core version with merged core settings and the used modules', async () => {
    const ws = makeWorkspace();
    const release = makeRelease(ws, '1.0.0');
    const root = makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS });
    write(join(root, 'fake-contract-tool.json'), { stdout: 'contract/service.proto:3:5 ERROR bad name\n\n', stderr: 'warn\n', exitCode: 1 });
    const ctx = ctxOf(ws);
    const result = await runContract(ctx, await ctx.game('g'));
    expect(runGenerate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ exitCode: 1, violations: ['contract/service.proto:3:5 ERROR bad name'], stderr: 'warn\n' });
    const [call] = toolCalls(release, 'contract-tool.tgz');
    const tool = join(release, 'extracted', 'contract-tool.tgz');
    expect(call?.args).toEqual([
      '--game', root, '--engine', 'godot', '--base-proto', join(tool, 'proto'),
      '--core-settings', expect.any(String), '--modules', expect.any(String),
    ]);
    expect(call?.cwd).toBe(root);
    expect(call?.coreSettings).toEqual({ 'NetworkCore.retryCount': 5, 'NetworkCore.timeouts': { connectMs: 1000, readMs: 9000 } });
    expect(call?.modules).toEqual([
      'BootstrapCore', 'EventCore', 'LogCore', 'NetworkCore', 'UtilCore',
      'auth', 'friend', 'migration', 'routing', 'storage', 'user-snapshot-clone',
    ]);
    expect(call?.previous).toBeNull();
  });

  it('leaves out --engine when game settings have no engine', async () => {
    const ws = makeWorkspace();
    const release = makeRelease(ws, '1.0.0');
    makeGame(ws, 'g', { 'settings.json': { ...GAME_SETTINGS, engine: undefined } });
    const ctx = ctxOf(ws);
    expect((await runContract(ctx, await ctx.game('g'))).exitCode).toBe(0);
    expect(toolCalls(release, 'contract-tool.tgz')[0]?.args).not.toContain('--engine');
  });

  it('passes --previous built from the last prod-<version> tag', async () => {
    const ws = makeWorkspace();
    const v1 = makeRelease(ws, '1.0.0', { protoName: 'old.proto' });
    const v2 = makeRelease(ws, '2.0.0');
    const root = makeGame(ws, 'g', {
      'settings.json': { ...GAME_SETTINGS, core: { 'NetworkCore.retryCount': 7 } },
      'contract/service.proto': 'v1',
      'contract/sub/user_state.proto': 'u1',
      'server/generated/contract/contract_version': '3\n',
    });
    sh(root, 'git', ['tag', 'prod-1.2.0']);
    sh(root, 'git', ['tag', 'prod-1.10.0-bundle-1']);
    write(join(root, 'contract', 'service.proto'), 'v9');
    write(join(root, 'server', 'generated', 'contract', 'contract_version'), '4\n');
    commitAll(root, 'later');
    sh(root, 'git', ['tag', '-a', 'prod-1.10.0', '-m', 'p']);
    sh(root, 'git', ['tag', 'stg-2.0.0']);
    write(join(root, 'settings.json'), { ...GAME_SETTINGS, coreVersion: '2.0.0' });
    commitAll(root, 'upgrade');
    const ctx = ctxOf(ws);
    const result = await runContract(ctx, await ctx.game('g'));
    expect(result.exitCode).toBe(0);
    expect(toolCalls(v1, 'contract-tool.tgz')).toEqual([]);
    const [call] = toolCalls(v2, 'contract-tool.tgz');
    const args = call?.args as string[];
    expect(args[args.length - 2]).toBe('--previous');
    expect(call?.previous).toEqual({
      contract: ['service.proto', 'sub/user_state.proto'],
      proto: ['ogw/old.proto'],
      contractVersion: '4\n',
      coreSettings: { 'NetworkCore.retryCount': 7, 'NetworkCore.timeouts': { connectMs: 1000, readMs: 2000 } },
    });
  });

  it('with useLocalCore, takes --previous proto and core settings from the published release of the tag', async () => {
    const ws = makeWorkspace({ useLocalCore: true });
    makeRelease(ws, '1.0.0', { protoName: 'published.proto', coreSettings: { 'NetworkCore.retryCount': 1 } });
    const local = makeRelease(ws, 'local', { protoName: 'local.proto', coreSettings: { 'NetworkCore.retryCount': 9 } });
    const root = makeGame(ws, 'g', { 'settings.json': { ...GAME_SETTINGS, core: {} }, 'server/generated/contract/contract_version': '1\n' });
    sh(root, 'git', ['tag', 'prod-1.0.0']);
    const ctx = ctxOf(ws);
    expect((await runContract(ctx, await ctx.game('g'))).exitCode).toBe(0);
    expect(toolCalls(join(ws.coreReleases, '1.0.0'), 'contract-tool.tgz')).toEqual([]);
    const [call] = toolCalls(local, 'contract-tool.tgz');
    expect(call?.coreSettings).toEqual({ 'NetworkCore.retryCount': 9 });
    expect(call?.previous).toMatchObject({ proto: ['ogw/published.proto'], coreSettings: { 'NetworkCore.retryCount': 1 } });
  });

  it('fails when the prod tag lacks contract_version or coreVersion', async () => {
    const ws = makeWorkspace();
    makeRelease(ws, '1.0.0');
    const root = makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS });
    sh(root, 'git', ['tag', 'prod-1.0.0']);
    const ctx = ctxOf(ws);
    await expect(runContract(ctx, await ctx.game('g'))).rejects.toThrow('no server/generated/contract/contract_version at prod-1.0.0');
    const other = makeGame(ws, 'h', {
      'settings.json': { ...GAME_SETTINGS, coreVersion: undefined },
      'server/generated/contract/contract_version': '1\n',
    });
    sh(other, 'git', ['tag', 'prod-1.0.0']);
    write(join(other, 'settings.json'), GAME_SETTINGS);
    await expect(runContract(ctx, await ctx.game('h'))).rejects.toThrow('no coreVersion in settings.json at prod-1.0.0');
    const third = makeGame(ws, 'k', { 'server/generated/contract/contract_version': '1\n' });
    sh(third, 'git', ['tag', 'prod-1.0.0']);
    write(join(third, 'settings.json'), GAME_SETTINGS);
    await expect(runContract(ctx, await ctx.game('k'))).rejects.toThrow('no settings.json at refs/tags/prod-1.0.0');
  });
});

describe('ogw contract', () => {
  it('prints violations and ends with the tool exit code', async () => {
    const ws = makeWorkspace();
    makeRelease(ws, '1.0.0');
    const root = makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS });
    write(join(root, 'fake-contract-tool.json'), { stdout: 'a.proto:1:1 ERROR x\n', stderr: 'bad arg\n', exitCode: 2 });
    const run = await ogw(ws, ['contract', 'g']);
    expect(run).toEqual({ code: 2, stdout: 'a.proto:1:1 ERROR x\n', stderr: 'bad arg\n' });
    write(join(root, 'fake-contract-tool.json'), {});
    expect(await ogw(ws, ['contract', 'g'])).toEqual({ code: 0, stdout: '', stderr: '' });
    expect((await ogw(ws, ['contract'])).code).toBe(1);
  });
});
