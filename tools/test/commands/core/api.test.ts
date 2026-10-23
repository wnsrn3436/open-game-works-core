import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  coreRelease,
  coreReleaseOfGame,
  extractedAsset,
  markProposalReleased,
  pendingProposalsPath,
  remoteReleaseVersions,
} from '../../../src/commands/core/api.ts';
import { writeTgz } from '../../../src/commands/core/lib/archive.ts';
import { createContext, type Context } from '../../../src/lib/command.ts';
import { changeRuns, changeRunsLocked, newRunState, withRunLock } from '../../../src/lib/runstate.ts';
import { ogw, commitAll, makeGame, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeGh, makeReleaseDir, writeFiles } from './helpers.ts';
import { writeImpl } from './impl-fixture.ts';

vi.mock('../../../src/commands/core/lib/undefined.ts', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
  };
});

function context(ws: TestWorkspace, env: NodeJS.ProcessEnv = {}, cwd = ws.root): Context {
  return createContext({ cwd, env: { ...ws.env, ...env }, stdin: () => Promise.resolve(''), stderr: () => undefined });
}

const PROPOSAL = 'status: proposed\n## target\n`UICore`\n';

function gameWithProposal(ws: TestWorkspace): string {
  return makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' }, 'records/core-proposals/1-x.md': PROPOSAL });
}

describe('remoteReleaseVersions', () => {
  it('reads v<version> release tags of the core release repository in version order', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, { 'v1.10.0': ws.root, 'v1.2.0': ws.root, 'v1.2.0-rc': ws.root, other: ws.root, '1.3.0': ws.root });
    expect(await remoteReleaseVersions(context(ws, gh.env))).toEqual(['1.2.0', '1.10.0']);
    expect(gh.calls()[0]).toEqual(['release', 'list', '--repo', 'wnsrn3436/open-game-works-core-impl', '--limit', '10000', '--exclude-drafts', '--json', 'tagName']);
  });

  it('fails when gh fails or prints no list', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, {});
    await expect(remoteReleaseVersions(context(ws, { ...gh.env, FAKE_GH_FAIL: 'list' }))).rejects.toThrow('gh release list');
  });
});

describe('coreRelease', () => {
  it('downloads a release once, checks its hashes and caches it', async () => {
    const ws = makeWorkspace();
    const source = makeReleaseDir(join(ws.root, 'remote-1.0.0'), '1.0.0', { 'core-spec.json': '{}', 'licenses.json': '{}' });
    const gh = fakeGh(ws, { 'v1.0.0': source });
    const ctx = context(ws, gh.env);
    const release = await coreRelease(ctx, '1.0.0');
    expect(release).toEqual({ version: '1.0.0', dir: join(ws.coreReleases, '1.0.0'), local: false });
    expect(readdirSync(release.dir).sort()).toEqual(['core-spec.json', 'licenses.json', 'manifest.json']);
    expect(await coreRelease(ctx, '1.0.0')).toEqual(release);
    expect(gh.calls().filter((c) => c[1] === 'download')).toEqual([['release', 'download', 'v1.0.0', '--repo', 'wnsrn3436/open-game-works-core-impl', '--dir', expect.stringContaining('.download-1.0.0-')]]);
    expect(readdirSync(ws.coreReleases).sort()).toEqual(['1.0.0']);
  });

  it('keeps nothing when a hash does not match', async () => {
    const ws = makeWorkspace();
    const source = makeReleaseDir(join(ws.root, 'remote'), '2.0.0', { 'licenses.json': '{}' });
    writeFileSync(join(source, 'licenses.json'), '{"changed":true}');
    const gh = fakeGh(ws, { 'v2.0.0': source });
    await expect(coreRelease(context(ws, gh.env), '2.0.0')).rejects.toThrow('core release 2.0.0 failed the hash check:\nlicenses.json does not match its SHA-256 in manifest.json');
    expect(readdirSync(ws.coreReleases)).toEqual([]);
  });

  it('rejects an invalid version and reports a failed download', async () => {
    const ws = makeWorkspace();
    const gh = fakeGh(ws, {});
    await expect(coreRelease(context(ws, gh.env), 'latest')).rejects.toThrow('invalid core version: latest');
    await expect(coreRelease(context(ws, { ...gh.env, FAKE_GH_FAIL: 'download' }), '1.0.0')).rejects.toThrow('gh release download v1.0.0');
    expect(readdirSync(ws.coreReleases)).toEqual([]);
  });

  it('builds the assets from open-game-works-core-impl/ in a temporary folder when useLocalCore is true', async () => {
    const ws = makeWorkspace({ useLocalCore: true });
    writeImpl(ws.coreImpl);
    sh(ws.coreImpl, 'rm', ['-r', 'tools']);
    writeFiles(ws.coreImpl, { 'server/core/storage/core-schema-version': '3\n' });
    const gh = fakeGh(ws, {});
    const ctx = context(ws, gh.env);
    const release = await coreRelease(ctx, '9.9.9');
    expect(release.local).toBe(true);
    expect(release.dir.startsWith(ws.coreReleases)).toBe(false);
    expect(readdirSync(release.dir)).toContain('client-godot.zip');
    expect(JSON.parse(readFileSync(join(release.dir, 'manifest.json'), 'utf8'))).toMatchObject({ version: '9.9.9', coreSchemaVersion: 3 });
    expect(await coreRelease(ctx, '9.9.9')).toBe(release);
    expect(gh.calls()).toEqual([]);
    expect(readdirSync(ws.coreReleases)).toEqual([]);
  });

  it('reads the version of a game checkout', async () => {
    const ws = makeWorkspace();
    const source = makeReleaseDir(join(ws.root, 'remote'), '1.0.0', { 'a.json': '1' });
    const gh = fakeGh(ws, { 'v1.0.0': source });
    makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' } });
    makeGame(ws, 'h', { 'settings.json': { engine: 'godot' } });
    makeGame(ws, 'k', { 'settings.json': { coreVersion: 'x' } });
    const ctx = context(ws, gh.env);
    expect((await coreReleaseOfGame(ctx, await ctx.game('g'))).dir).toBe(join(ws.coreReleases, '1.0.0'));
    await expect(coreReleaseOfGame(ctx, await ctx.game('h'))).rejects.toThrow('game settings of h have no coreVersion');
    await expect(coreReleaseOfGame(ctx, await ctx.game('k'))).rejects.toThrow('invalid coreVersion of k: x');
  });
});

describe('extractedAsset', () => {
  it('extracts an archive asset once next to it', async () => {
    const ws = makeWorkspace();
    const dir = join(ws.coreReleases, '1.0.0');
    mkdirSync(join(ws.root, 'src', 'bin'), { recursive: true });
    writeFileSync(join(ws.root, 'src', 'bin', 'contract-tool.js'), 'x');
    await writeTgz(join(dir, 'contract-tool.tgz'), join(ws.root, 'src'), ['bin/contract-tool.js']);
    const release = { version: '1.0.0', dir, local: false };
    const ctx = context(ws);
    const out = await extractedAsset(ctx, release, 'contract-tool.tgz');
    expect(out).toBe(join(dir, 'contract-tool'));
    expect(readFileSync(join(out, 'bin', 'contract-tool.js'), 'utf8')).toBe('x');
    writeFileSync(join(out, 'marker'), '');
    expect(await extractedAsset(ctx, release, 'contract-tool.tgz')).toBe(out);
    expect(existsSync(join(out, 'marker'))).toBe(true);
    await expect(extractedAsset(ctx, release, 'core-spec.json')).rejects.toThrow('not an archive asset: core-spec.json');
    await expect(extractedAsset(ctx, release, '../x.zip')).rejects.toThrow('not an archive asset');
    await expect(extractedAsset(ctx, release, '.hidden.zip')).rejects.toThrow('not an archive asset');
    await expect(extractedAsset(ctx, release, 'client-godot.zip')).rejects.toThrow('core release 1.0.0 has no asset client-godot.zip');
  });
});

describe('markProposalReleased', () => {
  it('marks the proposal on main when main is checked out', async () => {
    const ws = makeWorkspace();
    const dir = gameWithProposal(ws);
    expect(await markProposalReleased(context(ws), 'g', 'records/core-proposals/1-x.md', '1.4.0')).toBe('marked');
    expect(readFileSync(join(dir, 'records/core-proposals/1-x.md'), 'utf8')).toBe('status: released\nversion: 1.4.0\n## target\n`UICore`\n');
    expect(sh(dir, 'git', ['log', '-1', '--format=%s']).trim()).toBe('core proposal released: 1-x.md 1.4.0');
    expect(sh(dir, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('uses a temporary worktree of main when another branch is checked out, and takes absolute paths', async () => {
    const ws = makeWorkspace();
    const dir = gameWithProposal(ws);
    sh(dir, 'git', ['checkout', '--quiet', '-b', 'loop/x']);
    const result = await markProposalReleased(context(ws, {}, dir), 'g', join(dir, 'records/core-proposals/1-x.md'), '2.0.0');
    expect(result).toBe('marked');
    expect(sh(dir, 'git', ['show', 'main:records/core-proposals/1-x.md'])).toBe('status: released\nversion: 2.0.0\n## target\n`UICore`\n');
    expect(readFileSync(join(dir, 'records/core-proposals/1-x.md'), 'utf8')).toBe(PROPOSAL);
    expect(readdirSync(join(ws.worktrees))).toEqual(['g']);
    expect(readdirSync(join(ws.worktrees, 'g'))).toEqual([]);
    expect(sh(dir, 'git', ['worktree', 'list']).trim().split('\n')).toHaveLength(1);
  });

  it('uses a worktree that has main checked out', async () => {
    const ws = makeWorkspace();
    const dir = gameWithProposal(ws);
    sh(dir, 'git', ['checkout', '--quiet', '-b', 'other']);
    const wt = join(ws.worktrees, 'g', 'w1');
    sh(dir, 'git', ['worktree', 'add', '--quiet', wt, 'main']);
    expect(await markProposalReleased(context(ws), 'g', 'records/core-proposals/1-x.md', '1.0.1')).toBe('marked');
    expect(readFileSync(join(wt, 'records/core-proposals/1-x.md'), 'utf8')).toContain('version: 1.0.1');
  });

  it('holds the run lock from the open-run check through the main commit', async () => {
    const ws = makeWorkspace();
    const dir = gameWithProposal(ws);
    const marker = join(ws.root, 'lock-at-commit');
    const hook = join(dir, '.git', 'hooks', 'post-commit');
    writeFileSync(hook, `#!/bin/sh\nif [ -d '${join(dir, '.git', 'ogw-runs.lock')}' ]; then echo held; else echo free; fi >> '${marker}'\n`, { mode: 0o755 });
    const ctx = context(ws);
    const game = await ctx.game('g');
    // A run that registers while the mark waits for the run lock is seen by the open-run check.
    const marking = withRunLock(game, async () => {
      const mark = markProposalReleased(ctx, 'g', 'records/core-proposals/1-x.md', '1.4.0');
      await sleep(300);
      await changeRunsLocked(game, (runs) => {
        runs.push(newRunState({ name: 'update-1', kind: 'loop', branch: 'loop/update-1', baseCommit: 'abc' }));
      });
      return { mark };
    });
    expect(await (await marking).mark).toBe('deferred');
    await changeRuns(game, (runs) => {
      runs.splice(0, runs.length);
    });
    expect(await markProposalReleased(ctx, 'g', 'records/core-proposals/1-x.md', '1.4.0')).toBe('marked');
    expect(readFileSync(marker, 'utf8')).toBe('held\n');
  });

  it('defers while the game has an open run, once per proposal and version', async () => {
    const ws = makeWorkspace();
    const dir = gameWithProposal(ws);
    const ctx = context(ws);
    await changeRuns(await ctx.game('g'), (runs) => {
      runs.push(newRunState({ name: 'update-1', kind: 'loop', branch: 'loop/update-1', baseCommit: 'abc' }));
    });
    expect(await markProposalReleased(ctx, 'g', 'records/core-proposals/1-x.md', '1.4.0')).toBe('deferred');
    expect(await markProposalReleased(ctx, 'g', 'records/core-proposals/1-x.md', '1.4.0')).toBe('deferred');
    expect(JSON.parse(readFileSync(pendingProposalsPath(await ctx.game('g')), 'utf8'))).toEqual({
      proposals: [{ proposalFile: 'records/core-proposals/1-x.md', version: '1.4.0' }],
    });
    expect(readFileSync(join(dir, 'records/core-proposals/1-x.md'), 'utf8')).toBe(PROPOSAL);
  });

  it('checks the proposal on main before it defers, and defers one version per proposal', async () => {
    const ws = makeWorkspace();
    const dir = gameWithProposal(ws);
    writeFiles(dir, { 'records/core-proposals/2-y.md': 'status: released\nversion: 1.0.0\n' });
    commitAll(dir);
    sh(dir, 'git', ['checkout', '--quiet', '-b', 'loop/update-1']);
    writeFiles(dir, { 'records/core-proposals/4-w.md': 'status: proposed\n' });
    commitAll(dir);
    const ctx = context(ws);
    const game = await ctx.game('g');
    await changeRuns(game, (runs) => {
      runs.push(newRunState({ name: 'update-1', kind: 'loop', branch: 'loop/update-1', baseCommit: 'abc' }));
    });
    await expect(markProposalReleased(ctx, 'g', 'records/core-proposals/2-y.md', '1.1.0')).rejects.toThrow(
      'first line of records/core-proposals/2-y.md is not "status: proposed": "status: released"',
    );
    await expect(markProposalReleased(ctx, 'g', 'records/core-proposals/4-w.md', '1.1.0')).rejects.toThrow('proposal file not found on main: records/core-proposals/4-w.md');
    await expect(markProposalReleased(ctx, 'g', 'records/core-proposals', '1.1.0')).rejects.toThrow('proposal file not found on main: records/core-proposals');
    expect(existsSync(pendingProposalsPath(game))).toBe(false);
    expect(await markProposalReleased(ctx, 'g', 'records/core-proposals/1-x.md', '1.4.0')).toBe('deferred');
    await expect(markProposalReleased(ctx, 'g', 'records/core-proposals/1-x.md', '1.5.0')).rejects.toThrow(
      'records/core-proposals/1-x.md is already deferred as released in version 1.4.0',
    );
    expect(JSON.parse(readFileSync(pendingProposalsPath(game), 'utf8'))).toEqual({
      proposals: [{ proposalFile: 'records/core-proposals/1-x.md', version: '1.4.0' }],
    });
  });

  it('fails on a first line that is not proposed, a missing file, a path outside the repo and a bad version', async () => {
    const ws = makeWorkspace();
    const dir = gameWithProposal(ws);
    writeFiles(dir, { 'records/core-proposals/2-y.md': 'status: released\nversion: 1.0.0\n' });
    commitAll(dir);
    const ctx = context(ws);
    await expect(markProposalReleased(ctx, 'g', 'records/core-proposals/2-y.md', '1.1.0')).rejects.toThrow('first line of records/core-proposals/2-y.md is not "status: proposed": "status: released"');
    await expect(markProposalReleased(ctx, 'g', 'records/core-proposals/none.md', '1.1.0')).rejects.toThrow('proposal file not found on main: records/core-proposals/none.md');
    await expect(markProposalReleased(ctx, 'g', '../outside.md', '1.1.0')).rejects.toThrow('proposal file is not inside the game repo');
    await expect(markProposalReleased(ctx, 'g', 'records/core-proposals/1-x.md', 'v1')).rejects.toThrow('invalid core version: v1');
    expect(sh(dir, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('keeps CRLF line endings', async () => {
    const ws = makeWorkspace();
    const dir = makeGame(ws, 'g', { 'records/core-proposals/3.md': 'status: proposed\r\n## target\r\n' });
    await markProposalReleased(context(ws), 'g', 'records/core-proposals/3.md', '1.0.0');
    expect(readFileSync(join(dir, 'records/core-proposals/3.md'), 'utf8')).toBe('status: released\r\nversion: 1.0.0\r\n## target\r\n');
  });
});

describe('ogw core proposal released / core fetch', () => {
  it('prints what it did', async () => {
    const ws = makeWorkspace();
    const dir = gameWithProposal(ws);
    writeFiles(dir, { 'records/core-proposals/2-z.md': PROPOSAL, 'records/core-proposals/3-v.md': PROPOSAL });
    commitAll(dir);
    const marked = await ogw(ws, ['core', 'proposal', 'released', 'g', 'records/core-proposals/1-x.md', '1.4.0']);
    expect(marked).toMatchObject({ code: 0, stdout: 'marked: records/core-proposals/1-x.md released 1.4.0\n' });
    const ctx = context(ws);
    await changeRuns(await ctx.game('g'), (runs) => {
      runs.push(newRunState({ name: 'b', kind: 'build', branch: 'build/x', baseCommit: 'abc' }));
    });
    const deferred = await ogw(ws, ['core', 'proposal', 'released', 'g', 'records/core-proposals/2-z.md', '1.5.0', '--json']);
    expect(JSON.parse(deferred.stdout)).toEqual({ result: 'deferred', file: 'records/core-proposals/2-z.md', version: '1.5.0' });
    expect((await ogw(ws, ['core', 'proposal', 'released', 'g'])).code).toBe(1);
    const text = await ogw(ws, ['core', 'proposal', 'released', 'g', 'records/core-proposals/3-v.md', '1.6.0']);
    expect(text.stdout).toBe('deferred: g has an open run; records/core-proposals/3-v.md is marked released 1.6.0 when the run ends\n');
  });

  it('fetches and checks the game core version', async () => {
    const ws = makeWorkspace();
    const source = makeReleaseDir(join(ws.root, 'remote'), '1.0.0', { 'a.json': '1' });
    const gh = fakeGh(ws, { 'v1.0.0': source });
    makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' } });
    const run = await ogw(ws, ['core', 'fetch', 'g'], { env: gh.env });
    expect(run).toMatchObject({ code: 0, stdout: `core 1.0.0: ${join(ws.coreReleases, '1.0.0')}\n` });
    writeFileSync(join(ws.coreReleases, '1.0.0', 'a.json'), '2');
    const broken = await ogw(ws, ['core', 'fetch', 'g', '--json'], { env: gh.env });
    expect(broken.code).toBe(1);
    expect(JSON.parse(broken.stdout)).toMatchObject({ data: { problems: ['a.json does not match its SHA-256 in manifest.json'] } });
    expect((await ogw(ws, ['core', 'fetch'])).code).toBe(1);
  });

  it('fetches nothing with useLocalCore', async () => {
    const ws = makeWorkspace({ useLocalCore: true });
    writeImpl(ws.coreImpl);
    sh(ws.coreImpl, 'rm', ['-r', 'tools']);
    const gh = fakeGh(ws, {});
    makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' } });
    const run = await ogw(ws, ['core', 'fetch', 'g', '--json'], { env: gh.env });
    expect(JSON.parse(run.stdout)).toMatchObject({ version: '1.0.0', local: true });
    expect(gh.calls()).toEqual([]);
  });
});
