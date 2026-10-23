import { describe, expect, it } from 'vitest';
import { ogw, makeWorkspace } from '../../helpers/workspace.ts';
import { commit, git, openBuildRun, runsOf, setupGame, write } from './helpers.ts';

describe('build retry', () => {
  it('fails without an open build run', async () => {
    const ws = makeWorkspace();
    setupGame(ws);
    const run = await ogw(ws, ['build', 'retry', 'g']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('no open build run for game g');
  });

  it('fails for an open loop run', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    await openBuildRun(ws, dir, { kind: 'loop', env: null, version: null });
    expect((await ogw(ws, ['build', 'retry', 'g'])).code).toBe(1);
  });

  it('counts retries up to buildRetryLimit (schema default 3) and keeps the count', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    await openBuildRun(ws, dir);
    for (const n of [1, 2, 3]) {
      const run = await ogw(ws, ['build', 'retry', 'g', '--json']);
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ retries: n, buildRetryLimit: 3 });
    }
    const over = await ogw(ws, ['build', 'retry', 'g']);
    expect(over.code).toBe(1);
    expect(over.stderr).toContain('retries 3\nbuildRetryLimit 3');
    expect((await runsOf(ws))[0]?.data.build).toEqual({ retries: 3, bundle: null, startCommit: expect.any(String) as string });
  });

  it('uses the game settings buildRetryLimit', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws, 'g', { buildRetryLimit: 0 });
    await openBuildRun(ws, dir);
    const run = await ogw(ws, ['build', 'retry', 'g']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('retries 0\nbuildRetryLimit 0');
    const text = await ogw(ws, ['build', 'retry', 'g', '--json']);
    expect(JSON.parse(text.stdout)).toEqual({ error: 'retries 0\nbuildRetryLimit 0', data: { retries: 0, buildRetryLimit: 0 } });
  });

  it('prints the new count as text', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    await openBuildRun(ws, dir);
    expect((await ogw(ws, ['build', 'retry', 'g'])).stdout).toBe('retries 1\nbuildRetryLimit 3\n');
  });
});

describe('build finish', () => {
  it('merges a DEV build branch into main and tags the merge commit', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    await openBuildRun(ws, dir, { env: 'DEV', version: '0.2.0' });
    write(dir, 'records/hardening/dev-0.2.0-server-1.md', '## changes\n');
    commit(dir, 'hardening');
    const run = await ogw(ws, ['build', 'finish', 'g', '--json']);
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout) as { tag: string; commit: string; merged: boolean };
    expect(out).toMatchObject({ tag: 'dev-0.2.0', merged: true });
    expect(git(dir, 'rev-parse', 'dev-0.2.0^{commit}')).toBe(out.commit);
    expect(git(dir, 'rev-parse', 'main')).toBe(out.commit);
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(dir, 'rev-list', '--parents', '-n', '1', 'main').split(' ')).toHaveLength(3);
    expect(git(dir, 'log', '-1', '--format=%s', 'main')).toBe('build: merge build/dev-0.2.0');
  });

  it('refuses when main moved and reports both commits', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    const run = await openBuildRun(ws, dir, { env: 'STG', version: '0.2.0' });
    git(dir, 'checkout', '--quiet', 'main');
    write(dir, 'x.txt', 'x');
    const moved = commit(dir, 'moved');
    git(dir, 'checkout', '--quiet', 'build/stg-0.2.0');
    const out = await ogw(ws, ['build', 'finish', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(`build branch made from ${run.baseCommit}, main HEAD is ${moved}`);
    expect(git(dir, 'tag', '--list')).toBe('');
    expect(git(dir, 'rev-parse', 'main')).toBe(moved);
  });

  it('tags the PROD start commit without merging', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    const run = await openBuildRun(ws, dir, { env: 'PROD', version: '0.2.0' });
    write(dir, 'y.txt', 'y');
    commit(dir, 'on branch');
    const out = await ogw(ws, ['build', 'finish', 'g']);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe(`prod-0.2.0 ${run.baseCommit}\n`);
    expect(git(dir, 'rev-parse', 'prod-0.2.0^{commit}')).toBe(run.baseCommit);
    expect(git(dir, 'rev-parse', 'main')).toBe(run.baseCommit);
  });

  it('tags the merge commit an earlier finish left on main before its tag', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    const run = await openBuildRun(ws, dir, { env: 'DEV', version: '0.2.0' });
    write(dir, 'records/hardening/dev-0.2.0-server-1.md', '## changes\n');
    const branchHead = commit(dir, 'hardening');
    git(dir, 'checkout', '--quiet', 'main');
    git(dir, 'merge', '--quiet', '--no-ff', '--no-edit', '-m', 'build: merge build/dev-0.2.0', 'build/dev-0.2.0');
    const merge = git(dir, 'rev-parse', 'main');
    git(dir, 'checkout', '--quiet', 'build/dev-0.2.0');
    const out = await ogw(ws, ['build', 'finish', 'g', '--json']);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ tag: 'dev-0.2.0', commit: merge, merged: true });
    expect(git(dir, 'rev-parse', 'dev-0.2.0^{commit}')).toBe(merge);
    expect(git(dir, 'rev-parse', 'main')).toBe(merge);
    expect(git(dir, 'rev-list', '--parents', '-n', '1', 'main').split(' ').slice(1)).toEqual([run.baseCommit, branchHead]);
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  });

  it('refuses a merge commit on main that is not this build branch merge', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    await openBuildRun(ws, dir, { env: 'DEV', version: '0.2.0' });
    write(dir, 'a.txt', 'a');
    commit(dir, 'on branch');
    git(dir, 'checkout', '--quiet', '-b', 'other', 'main');
    write(dir, 'b.txt', 'b');
    commit(dir, 'other');
    git(dir, 'checkout', '--quiet', 'main');
    git(dir, 'merge', '--quiet', '--no-ff', '--no-edit', '-m', 'build: merge build/dev-0.2.0', 'other');
    const moved = git(dir, 'rev-parse', 'main');
    git(dir, 'checkout', '--quiet', 'build/dev-0.2.0');
    const out = await ogw(ws, ['build', 'finish', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(`main HEAD is ${moved}`);
    expect(git(dir, 'tag', '--list')).toBe('');
  });

  it('refuses a merge of this build branch into a main that moved after the build branch was made', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    await openBuildRun(ws, dir, { env: 'DEV', version: '0.2.0' });
    write(dir, 'a.txt', 'a');
    commit(dir, 'on branch');
    git(dir, 'checkout', '--quiet', 'main');
    write(dir, 'z.txt', 'z');
    commit(dir, 'main moved');
    git(dir, 'merge', '--quiet', '--no-ff', '--no-edit', '-m', 'build: merge build/dev-0.2.0', 'build/dev-0.2.0');
    const merge = git(dir, 'rev-parse', 'main');
    git(dir, 'checkout', '--quiet', 'build/dev-0.2.0');
    const out = await ogw(ws, ['build', 'finish', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(`main HEAD is ${merge}`);
    expect(git(dir, 'tag', '--list')).toBe('');
    expect(git(dir, 'rev-parse', 'main')).toBe(merge);
  });

  it('refuses a merge of the start commit and this build branch with another subject', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    await openBuildRun(ws, dir, { env: 'DEV', version: '0.2.0' });
    write(dir, 'a.txt', 'a');
    commit(dir, 'on branch');
    git(dir, 'checkout', '--quiet', 'main');
    git(dir, 'merge', '--quiet', '--no-ff', '--no-edit', '-m', 'merge by hand', 'build/dev-0.2.0');
    const merge = git(dir, 'rev-parse', 'main');
    git(dir, 'checkout', '--quiet', 'build/dev-0.2.0');
    const out = await ogw(ws, ['build', 'finish', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(`main HEAD is ${merge}`);
    expect(git(dir, 'tag', '--list')).toBe('');
  });

  it('tags the PROD start commit when main moved after the build branch was made', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    const run = await openBuildRun(ws, dir, { env: 'PROD', version: '0.2.0' });
    git(dir, 'checkout', '--quiet', 'main');
    write(dir, 'z.txt', 'z');
    const moved = commit(dir, 'main moved');
    git(dir, 'checkout', '--quiet', 'build/prod-0.2.0');
    const out = await ogw(ws, ['build', 'finish', 'g']);
    expect(out.code).toBe(0);
    expect(git(dir, 'rev-parse', 'prod-0.2.0^{commit}')).toBe(run.baseCommit);
    expect(git(dir, 'rev-parse', 'main')).toBe(moved);
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('build/prod-0.2.0');
  });

  it('uses the bundle patch version in the tag', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    await openBuildRun(ws, dir, { env: 'DEV', version: '0.1.0-bundle-2', bundleFor: '0.1.0' });
    expect((await ogw(ws, ['build', 'finish', 'g'])).code).toBe(0);
    expect(git(dir, 'tag', '--list')).toBe('dev-0.1.0-bundle-2');
  });

  it('fails when the tag exists or no build run is open', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    expect((await ogw(ws, ['build', 'finish', 'g'])).stderr).toContain('no open build run');
    await openBuildRun(ws, dir, { env: 'DEV', version: '0.2.0' });
    git(dir, 'tag', 'dev-0.2.0', 'main');
    const out = await ogw(ws, ['build', 'finish', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('tag dev-0.2.0 already exists');
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('build/dev-0.2.0');
  });
});
