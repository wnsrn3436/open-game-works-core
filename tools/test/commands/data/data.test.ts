import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lineFile, parseDataLines, runData } from '../../../src/commands/data/api.ts';
import { prodTagCandidates } from '../../../src/commands/data/lib/prod-tag.ts';
import { runGenerate } from '../../../src/commands/generate/api.ts';
import { ogw, commitAll, makeGame, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { ctxOf, GAME_SETTINGS, makeRelease, toolCalls, write } from '../generate/helpers.ts';

vi.mock('../../../src/commands/core/api.ts', async () => (await import('../generate/helpers.ts')).coreApiMock);
vi.mock('../../../src/commands/generate/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/generate/api.ts')>()),
  runGenerate: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  vi.mocked(runGenerate).mockClear();
});

function worktreesOf(ws: TestWorkspace): string[] {
  try {
    return readdirSync(join(ws.worktrees, 'g'));
  } catch {
    return [];
  }
}

describe('parseDataLines', () => {
  it('reads data check lines and skips other output', () => {
    const lines = parseDataLines('data/tables/a.csv:5:2 ERROR value_type bad cell\r\nnoise\ndata/glossary.csv:1:1 WARN glossary_missing\n');
    expect(lines).toEqual([
      { where: 'data/tables/a.csv:5:2', level: 'ERROR', code: 'value_type', message: 'bad cell', text: 'data/tables/a.csv:5:2 ERROR value_type bad cell' },
      { where: 'data/glossary.csv:1:1', level: 'WARN', code: 'glossary_missing', message: '', text: 'data/glossary.csv:1:1 WARN glossary_missing' },
    ]);
    expect(lineFile(lines[0] as (typeof lines)[0])).toBe('data/tables/a.csv');
  });
});

describe('runData', () => {
  it('runs generate, then the data tool with defaults-filled game settings, core spec and used modules', async () => {
    const ws = makeWorkspace();
    const release = makeRelease(ws, '1.0.0');
    const root = makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS });
    write(join(root, 'fake-data-tool.json'), {
      stdout: 'data/tables/a.csv:5:2 ERROR value_type bad\ndata/glossary.csv:3:1 WARN glossary_missing name\n',
      stderr: 'e\n',
      exitCode: 1,
    });
    const ctx = ctxOf(ws);
    const result = await runData(ctx, await ctx.game('g'));
    expect(runGenerate).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('e\n');
    expect(result.lines.map((l) => l.code)).toEqual(['value_type', 'glossary_missing']);
    const [call] = toolCalls(release, 'data-tool.tgz');
    const tool = join(release, 'extracted', 'data-tool.tgz');
    expect(call?.args).toEqual([
      '--game', root, '--engine', 'godot', '--base-proto', join(tool, 'proto'),
      '--game-settings', expect.any(String), '--core-spec', join(release, 'core-spec.json'), '--modules', expect.any(String),
    ]);
    expect(call?.lockHeld).toBe(true);
    const settings = call?.gameSettings as Record<string, unknown>;
    expect(settings.gamepadSupported).toBe(false);
    expect(settings.loopIterationLimit).toBe(20);
    expect(settings.firstScene).toBe('scene/lobby/main');
    expect(call?.modules).toEqual([
      'BootstrapCore', 'EventCore', 'LogCore', 'NetworkCore', 'UtilCore',
      'auth', 'friend', 'migration', 'routing', 'storage', 'user-snapshot-clone',
    ]);
  });

  it('holds the generate lock for every data tool run and passes --binary and --strict', async () => {
    const ws = makeWorkspace();
    const release = makeRelease(ws, '1.0.0');
    makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS });
    const ctx = ctxOf(ws);
    const result = await runData(ctx, await ctx.game('g'), { binary: true, strict: true });
    expect(result).toEqual({ exitCode: 0, lines: [], stderr: '' });
    const [call] = toolCalls(release, 'data-tool.tgz');
    expect((call?.args as string[]).slice(-2)).toEqual(['--binary', '--strict']);
    expect(call?.lockHeld).toBe(true);
    await runData(ctx, await ctx.game('g'), { strict: true });
    expect((toolCalls(release, 'data-tool.tgz')[1]?.args as string[]).at(-1)).toBe('--strict');
    expect(toolCalls(release, 'data-tool.tgz')[1]?.lockHeld).toBe(true);
    expect(runGenerate).toHaveBeenCalledTimes(2);
    await runData(ctx, await ctx.game('g'), { binary: true, generate: false });
    expect(runGenerate).toHaveBeenCalledTimes(2);
    expect((toolCalls(release, 'data-tool.tgz')[2]?.args as string[]).at(-1)).toBe('--binary');
  });

  it('builds the binary of a folder that is not a git checkout, holding a lock that needs no git', async () => {
    const ws = makeWorkspace();
    const release = makeRelease(ws, '1.0.0');
    const root = makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS });
    rmSync(join(root, '.git'), { recursive: true, force: true });
    const ctx = ctxOf(ws);
    const result = await runData(ctx, { name: 'bench', root, mainRoot: root, commonDir: join(root, '.git'), inWorktree: false }, { binary: true, generate: false });
    expect(result.exitCode).toBe(0);
    const [call] = toolCalls(release, 'data-tool.tgz');
    expect((call?.args as string[]).includes('--previous')).toBe(false);
    expect((call?.args as string[]).slice(-2)).toEqual(['--id-registry', join(root, 'id_registry.json')]);
    expect(call?.lockHeld).toBe(true);
    expect(existsSync(join(root, '.ogw-generate.lock'))).toBe(false);
  });

  it('passes the binary-built worktree of the latest PROD data tag as --previous and removes worktrees', async () => {
    const ws = makeWorkspace();
    const v1 = makeRelease(ws, '1.0.0');
    const v2 = makeRelease(ws, '2.0.0');
    const root = makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS, 'data/version.txt': 'app1' });
    sh(root, 'git', ['tag', 'prod-1.0.0']);
    write(join(root, 'data', 'version.txt'), 'bundle-data');
    commitAll(root, 'bundle with data');
    sh(root, 'git', ['tag', 'prod-1.0.0-bundle-1']);
    commitAll(root, 'bundle without data');
    sh(root, 'git', ['tag', 'prod-1.0.0-bundle-2']);
    write(join(root, 'settings.json'), { ...GAME_SETTINGS, coreVersion: '2.0.0' });
    commitAll(root, 'upgrade');
    const ctx = ctxOf(ws);
    const result = await runData(ctx, await ctx.game('g'));
    expect(result.exitCode).toBe(0);
    const previousBuilds = toolCalls(v1, 'data-tool.tgz');
    const v1Tool = join(v1, 'extracted', 'data-tool.tgz');
    expect(previousBuilds.map((c) => c.args)).toEqual(previousBuilds.map((c): unknown[] => [
      '--game', c.cwd, '--engine', 'godot', '--base-proto', join(v1Tool, 'proto'),
      '--game-settings', expect.any(String), '--core-spec', join(v1, 'core-spec.json'), '--modules', expect.any(String), '--binary',
    ]));
    expect(previousBuilds.map((c) => c.cwd as string).every((cwd) => cwd.startsWith(join(ws.worktrees, 'g')))).toBe(true);
    expect(previousBuilds).toHaveLength(2);
    expect(previousBuilds.every((c) => c.lockHeld === true)).toBe(true);
    const [current] = toolCalls(v2, 'data-tool.tgz');
    const args = current?.args as string[];
    expect(args[args.length - 2]).toBe('--previous');
    expect(args.at(-1)).toContain(join(ws.worktrees, 'g'));
    expect(current?.previousVersion).toBe('bundle-data');
    expect(worktreesOf(ws)).toEqual([]);
    expect(sh(root, 'git', ['worktree', 'list']).trim().split('\n')).toHaveLength(1);
  });

  it('with useLocalCore, binary-builds the PROD tag with the published data tool of the tag core version', async () => {
    const ws = makeWorkspace({ useLocalCore: true });
    const published = makeRelease(ws, '1.0.0');
    const local = makeRelease(ws, 'local');
    const root = makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS, 'data/version.txt': 'app1' });
    sh(root, 'git', ['tag', 'prod-1.0.0']);
    const ctx = ctxOf(ws);
    expect((await runData(ctx, await ctx.game('g'))).exitCode).toBe(0);
    const previousBuilds = toolCalls(published, 'data-tool.tgz');
    expect(previousBuilds).toHaveLength(1);
    expect(previousBuilds[0]?.args).toContain('--binary');
    expect(previousBuilds[0]?.args).toContain(join(published, 'extracted', 'data-tool.tgz', 'proto'));
    const localCalls = toolCalls(local, 'data-tool.tgz');
    expect(localCalls).toHaveLength(1);
    expect(localCalls[0]?.args).not.toContain('--binary');
    expect(localCalls[0]?.previousVersion).toBe('app1');
  });

  it('takes the app tag when bundles carry no data, and a bundle with only server data', async () => {
    const ws = makeWorkspace();
    const release = makeRelease(ws, '1.0.0');
    const root = makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS, 'data/version.txt': 'app1' });
    sh(root, 'git', ['tag', 'prod-1.0.0']);
    commitAll(root, 'bundle');
    sh(root, 'git', ['tag', 'prod-1.0.0-bundle-1']);
    const ctx = ctxOf(ws);
    await runData(ctx, await ctx.game('g'));
    expect(toolCalls(release, 'data-tool.tgz').at(-1)?.previousVersion).toBe('app1');
    expect(toolCalls(release, 'data-tool.tgz').at(-1)?.previousServerVersion).toBe('app1');
    write(join(root, 'data', 'server.txt'), 'server-only');
    commitAll(root, 'server data');
    sh(root, 'git', ['tag', 'prod-1.0.0-bundle-2']);
    write(join(root, 'data', 'version.txt'), 'later');
    commitAll(root, 'later');
    await runData(ctx, await ctx.game('g'));
    const calls = toolCalls(release, 'data-tool.tgz');
    expect(calls.at(-1)?.previousVersion).toBe('app1');
    expect(calls.at(-1)?.previousServerVersion).toBe('server-only');
    expect(calls.at(-2)?.args).toContain('--binary');
    expect(worktreesOf(ws)).toEqual([]);
  });

  it('takes a bundle tag whose Client build target data alone differs from its app tag', async () => {
    const ws = makeWorkspace();
    const release = makeRelease(ws, '1.0.0');
    const root = makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS, 'data/version.txt': 'app1' });
    sh(root, 'git', ['tag', 'prod-1.0.0']);
    write(join(root, 'data', 'client.txt'), 'client-only');
    commitAll(root, 'client data');
    sh(root, 'git', ['tag', 'prod-1.0.0-bundle-1']);
    const ctx = ctxOf(ws);
    await runData(ctx, await ctx.game('g'));
    const last = toolCalls(release, 'data-tool.tgz').at(-1);
    expect(last?.previousVersion).toBe('client-only');
    expect(last?.previousServerVersion).toBe('app1');
  });

  it('binary-builds each tag once when bundle tags carry no data', async () => {
    const ws = makeWorkspace();
    const release = makeRelease(ws, '1.0.0');
    const root = makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS, 'data/version.txt': 'app1' });
    sh(root, 'git', ['tag', 'prod-1.0.0']);
    for (const n of [1, 2, 3]) {
      write(join(root, 'notes.txt'), String(n));
      commitAll(root, `bundle ${String(n)}`);
      sh(root, 'git', ['tag', `prod-1.0.0-bundle-${String(n)}`]);
    }
    const ctx = ctxOf(ws);
    await runData(ctx, await ctx.game('g'));
    const calls = toolCalls(release, 'data-tool.tgz');
    expect(calls.filter((c) => (c.args as string[]).includes('--binary'))).toHaveLength(4);
    expect(calls.at(-1)?.previousVersion).toBe('app1');
    expect(worktreesOf(ws)).toEqual([]);
  });

  it('fails when a bundle tag has no app tag or a previous binary build fails', async () => {
    const ws = makeWorkspace();
    makeRelease(ws, '1.0.0');
    const root = makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS });
    sh(root, 'git', ['tag', 'prod-0.9.0']);
    commitAll(root, 'b');
    sh(root, 'git', ['tag', 'prod-1.0.0-bundle-1']);
    const ctx = ctxOf(ws);
    await expect(runData(ctx, await ctx.game('g'))).rejects.toThrow('bundle patch tag prod-1.0.0-bundle-1 has no tag prod-1.0.0');
    expect(worktreesOf(ws)).toEqual([]);
    const ws2 = makeWorkspace();
    makeRelease(ws2, '1.0.0');
    const root2 = makeGame(ws2, 'g', { 'settings.json': GAME_SETTINGS, 'fake-data-tool.json': { stdout: 'x.csv:1:1 ERROR structure s\n', exitCode: 1 } });
    sh(root2, 'git', ['tag', 'prod-1.0.0']);
    const ctx2 = ctxOf(ws2);
    await expect(runData(ctx2, await ctx2.game('g'))).rejects.toThrow('binary build of prod-1.0.0 failed (1)\nx.csv:1:1 ERROR structure s');
    expect(worktreesOf(ws2)).toEqual([]);
    const root3 = makeGame(ws2, 'h', { 'settings.json': { ...GAME_SETTINGS, coreVersion: undefined } });
    sh(root3, 'git', ['tag', 'prod-1.0.0']);
    write(join(root3, 'settings.json'), GAME_SETTINGS);
    await expect(runData(ctx2, await ctx2.game('h'))).rejects.toThrow('no coreVersion in settings.json at prod-1.0.0');
  });
});

describe('prodTagCandidates', () => {
  it('orders tags on main by commit, app tag first, bundles by n from high, and ignores tags off main', async () => {
    const ws = makeWorkspace();
    const root = makeGame(ws, 'g', { a: 'a' });
    sh(root, 'git', ['tag', 'prod-1.0.0-bundle-1']);
    sh(root, 'git', ['tag', 'prod-1.0.0-bundle-2']);
    sh(root, 'git', ['tag', 'prod-1.0.0']);
    sh(root, 'git', ['tag', 'prod-1.0.0-bundle-10']);
    sh(root, 'git', ['checkout', '--quiet', '-b', 'side']);
    commitAll(root, 'side');
    sh(root, 'git', ['tag', 'prod-1.5.0']);
    sh(root, 'git', ['checkout', '--quiet', 'main']);
    commitAll(root, 'two');
    sh(root, 'git', ['tag', 'prod-1.1.0']);
    sh(root, 'git', ['tag', 'prod-1.1.0-bundle-0']);
    const tags = sh(root, 'git', ['tag']).trim().split('\n');
    expect(await prodTagCandidates(root, tags)).toEqual([
      { tag: 'prod-1.1.0', appTag: null },
      { tag: 'prod-1.0.0', appTag: null },
      { tag: 'prod-1.0.0-bundle-10', appTag: 'prod-1.0.0' },
      { tag: 'prod-1.0.0-bundle-2', appTag: 'prod-1.0.0' },
      { tag: 'prod-1.0.0-bundle-1', appTag: 'prod-1.0.0' },
    ]);
    expect(await prodTagCandidates(root, ['prod-1.0.0-bundle-1'])).toEqual([]);
    const noMain = makeGame(ws, 'n', { a: 'a' });
    sh(noMain, 'git', ['branch', '-m', 'main', 'trunk']);
    expect(await prodTagCandidates(noMain, ['prod-1.0.0'])).toEqual([]);
  });
});

describe('ogw data', () => {
  it('prints the data check lines, ends with the tool exit code and records glossary_missing lines', async () => {
    const ws = makeWorkspace();
    const release = makeRelease(ws, '1.0.0');
    const root = makeGame(ws, 'g', { 'settings.json': GAME_SETTINGS });
    write(join(root, 'fake-data-tool.json'), {
      stdout: 'data/glossary.csv:3:1 WARN glossary_missing name\ndata/a.csv:1:1 ERROR structure s\n',
      stderr: 'detail\n',
      exitCode: 1,
    });
    expect((await ogw(ws, ['data', 'g', '--binary'])).stderr).toContain('unknown option');
    expect((await ogw(ws, ['data', 'g', '--strict'])).stderr).toContain('unknown option');
    const run = await ogw(ws, ['data', 'g']);
    expect(toolCalls(release, 'data-tool.tgz').at(-1)?.args).not.toContain('--binary');
    expect(run).toEqual({
      code: 1,
      stdout: 'data/glossary.csv:3:1 WARN glossary_missing name\ndata/a.csv:1:1 ERROR structure s\n',
      stderr: 'detail\n',
    });
    const { data } = await import('../../../src/commands/data/data.ts');
    const ctx = ctxOf(ws);
    const result = await data.run(ctx, { positionals: ['g'], values: {}, raw: [] });
    expect(result.summary).toEqual({ glossaryMissing: ['data/glossary.csv:3:1 WARN glossary_missing name'] });
    write(join(root, 'fake-data-tool.json'), {});
    expect(await ogw(ws, ['data', 'g'])).toEqual({ code: 0, stdout: '', stderr: '' });
  });
});
