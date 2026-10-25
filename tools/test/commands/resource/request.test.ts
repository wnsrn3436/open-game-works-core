import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isRequestFileName, requestPendingResources } from '../../../src/commands/resource/api.ts';
import { requestFileKeys } from '../../../src/commands/resource/lib/request.ts';
import { createContext } from '../../../src/lib/command.ts';
import type { GameRepo } from '../../../src/lib/game.ts';
import { changeRuns, newRunState, type RunState } from '../../../src/lib/runstate.ts';
import { ogw, commitAll, sh } from '../../helpers/workspace.ts';
import { listCsv, makeFixture, rowOf, type Fixture } from './fixture.ts';

const ROWS = listCsv([
  { key: 'icon/a', spec: 'size=8x8', status: 'placeholder' },
  { key: 'icon/b', spec: 'size=8x8', status: 'requested' },
  { key: 'icon/c', spec: 'size=8x8', status: 'final' },
  { key: 'icon/d', spec: 'size=8x8', status: 'requested' },
  { key: 'scene/x/main', status: 'final' },
]);

function repo(f: Fixture): GameRepo {
  return { name: 'g', root: f.game, mainRoot: f.game, commonDir: join(f.game, '.git'), inWorktree: false };
}

async function openRun(f: Fixture, fields: Partial<RunState>): Promise<void> {
  await changeRuns(repo(f), (runs) => {
    runs.push(newRunState({ name: 'loop-1', kind: 'loop', branch: 'loop/loop-1', baseCommit: 'x', ...fields }));
  });
}

function log(f: Fixture): string {
  return sh(f.game, 'git', ['log', '--format=%s', '-n', '1']).trim();
}

function requestFiles(f: Fixture, dir: string): string[] {
  return existsSync(join(f.game, dir)) ? readdirSync(join(f.game, dir)) : [];
}

describe('ogw resource request', () => {
  it('requests keys in a loop run, writes the request file and commits', async () => {
    const f = makeFixture({ 'resource/resources.csv': ROWS });
    await openRun(f, {});
    const run = await ogw(f.ws, ['resource', 'request', 'g', 'icon/a', 'icon/c', 'icon/a', '--see', 'icon/c', '--base', 'icon/c']);
    expect(run.stderr).toBe('');
    const path = run.stdout.trim();
    expect(path).toMatch(/^records\/loops\/loop-1\/resource-requests\/[0-9]+\.md$/);
    expect(readFileSync(join(f.game, path), 'utf8')).toBe('## keys\n\nicon/a\nicon/c\n\n## see\n\nicon/c\n\n## base\n\nicon/c\n');
    expect(rowOf(f.game, 'icon/a').status).toBe('requested');
    expect(rowOf(f.game, 'icon/c').status).toBe('requested');
    expect(log(f)).toBe('resource request: icon/a icon/c');
    // The commit is made with the command's env, not process.env.
    expect(sh(f.game, 'git', ['log', '-1', '--format=%an %ae'])).toBe('ogw-test ogw-test@example.com\n');
    expect(sh(f.game, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('requests pending rows: placeholder rows and requested rows not in a request file of this run', async () => {
    const f = makeFixture({
      'resource/resources.csv': ROWS,
      'records/loops/loop-1/resource-requests/100.md': '## keys\n\nicon/b\n\n## see\n\nnone\n\n## base\n\nnone\n',
      'records/loops/loop-1/resource-requests/notes.txt': '## keys\n\nicon/d\n',
      'records/loops/loop-0/resource-requests/50.md': '## keys\n\nicon/d\n',
    });
    await openRun(f, {});
    const run = await ogw(f.ws, ['resource', 'request', 'g', '--pending', '--json']);
    const data = JSON.parse(run.stdout) as { path: string; keys: string[] };
    expect(data.keys).toEqual(['icon/a', 'icon/d']);
    expect(readFileSync(join(f.game, data.path), 'utf8')).toBe('## keys\n\nicon/a\nicon/d\n\n## see\n\nnone\n\n## base\n\nnone\n');
    const again = await ogw(f.ws, ['resource', 'request', 'g', '--pending']);
    expect(again).toMatchObject({ code: 0, stdout: 'no pending resource\n' });
    expect(requestFiles(f, 'records/loops/loop-1/resource-requests')).toHaveLength(3);
  });

  it('requests a temporary row once per run and keeps its status and file', async () => {
    const f = makeFixture({
      'resource/resources.csv': listCsv([
        { key: 'icon/t', spec: 'size=8x8', status: 'temporary', method: 'flux2-klein' },
        { key: 'icon/u', spec: 'size=8x8', status: 'temporary', method: 'flux2-klein' },
      ]),
      'records/loops/loop-1/resource-requests/100.md': '## keys\n\nicon/u\n\n## see\n\nnone\n\n## base\n\nnone\n',
    });
    await openRun(f, {});
    const run = await ogw(f.ws, ['resource', 'request', 'g', '--pending', '--json']);
    expect((JSON.parse(run.stdout) as { keys: string[] }).keys).toEqual(['icon/t']);
    expect(rowOf(f.game, 'icon/t').status).toBe('temporary');
    expect(await ogw(f.ws, ['resource', 'request', 'g', '--pending'])).toMatchObject({ code: 0, stdout: 'no pending resource\n' });
  });

  it('asks again for requested rows whose request jobs all finished, up to backgroundRetryLimit request files', async () => {
    const keys = (list: string): string => `## keys\n\n${list}\n\n## see\n\nnone\n\n## base\n\nnone\n`;
    const f = makeFixture({
      'resource/resources.csv': listCsv([
        { key: 'icon/a', spec: 'size=8x8', status: 'requested' },
        { key: 'icon/b', spec: 'size=8x8', status: 'requested' },
        { key: 'icon/c', spec: 'size=8x8', status: 'requested' },
        { key: 'icon/d', spec: 'size=8x8', status: 'requested' },
      ]),
      // icon/a: one finished request. icon/b: one finished and one running request. icon/c: one running request.
      // icon/d: two finished requests, which is backgroundRetryLimit (2) in the test harness settings.
      'records/loops/loop-1/resource-requests/100.md': keys('icon/a\nicon/b\nicon/d'),
      'records/loops/loop-1/resource-requests/100-result.md': 'done\n',
      'records/loops/loop-1/resource-requests/200.md': keys('icon/b\nicon/c'),
      'records/loops/loop-1/resource-requests/300.md': keys('icon/d'),
      'records/loops/loop-1/resource-requests/300-result.md': 'done\n',
    });
    await openRun(f, {});
    const run = await ogw(f.ws, ['resource', 'request', 'g', '--pending', '--json']);
    expect(run.stderr).toBe('');
    const data = JSON.parse(run.stdout) as { path: string; keys: string[] };
    expect(data.keys).toEqual(['icon/a', 'icon/d']);
    // icon/c again: a running request named before a finished one keeps it from being asked again
    writeFileSync(join(f.game, 'records/loops/loop-1/resource-requests/400.md'), keys('icon/c'));
    writeFileSync(join(f.game, 'records/loops/loop-1/resource-requests/400-result.md'), 'done\n');
    writeFileSync(join(f.game, data.path.replace(/\.md$/, '-result.md')), 'done\n');
    commitAll(f.game);
    const third = await ogw(f.ws, ['resource', 'request', 'g', '--pending', '--json']);
    expect((JSON.parse(third.stdout) as { keys: string[] }).keys).toEqual(['icon/a']);
  });

  it('counts only <unix ms>.md files, the same names ogw loop dispatch starts jobs for', async () => {
    const f = makeFixture({
      'resource/resources.csv': ROWS,
      'records/loops/loop-1/resource-requests/extra.md': '## keys\n\nicon/d\n',
      'records/loops/loop-1/resource-requests/100-result.md': '## keys\n\nicon/b\n',
    });
    await openRun(f, {});
    const run = await ogw(f.ws, ['resource', 'request', 'g', '--pending', '--json']);
    const data = JSON.parse(run.stdout) as { path: string; keys: string[] };
    expect(data.keys).toEqual(['icon/a', 'icon/b', 'icon/d']);
    const place = { prefix: '' };
    expect(['extra.md', '100-result.md', basename(data.path)].filter((n) => isRequestFileName(place, n))).toEqual([basename(data.path)]);
  });

  it('writes the build run request file path and gives it through the API', async () => {
    const f = makeFixture({
      'resource/resources.csv': ROWS,
      'records/hardening/stg-1.2.0-resource-5.md': '## keys\n\nicon/b\n',
      'records/hardening/dev-1.2.0-resource-6.md': '## keys\n\nicon/d\n',
    });
    await openRun(f, { name: 'build-stg-1.2.0', kind: 'build', env: 'STG', version: '1.2.0' });
    const ctx = createContext({ cwd: f.ws.root, env: f.ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const path = await requestPendingResources(ctx, repo(f));
    expect(path).toMatch(/^records\/hardening\/stg-1\.2\.0-resource-[0-9]+\.md$/);
    expect(requestFileKeys(readFileSync(join(f.game, path as string), 'utf8'))).toEqual(['icon/a', 'icon/d']);
    expect(await requestPendingResources(ctx, repo(f))).toBeNull();
  });

  it('does not reuse a request file name', async () => {
    const f = makeFixture({ 'resource/resources.csv': ROWS });
    await openRun(f, {});
    const dir = join(f.game, 'records/loops/loop-1/resource-requests');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    for (let i = 0; i < 50; i++) writeFileSync(join(dir, `${String(now + i)}.md`), '## keys\n\nnone\n');
    commitAll(f.game);
    const path = (await ogw(f.ws, ['resource', 'request', 'g', 'icon/a'])).stdout.trim();
    expect(Number(/([0-9]+)\.md$/.exec(path)?.[1])).toBeGreaterThanOrEqual(now + 50);
  });

  const failures: [string, string[], string][] = [
    ['a key not in the list', ['icon/z'], 'icon/z is not in resource/resources.csv'],
    ['a scene key', ['scene/x/main'], 'scene/x/main: type scene is not requested'],
    ['a --see row that is not final', ['icon/a', '--see', 'icon/b'], 'icon/b is not final'],
    ['a --base row that is not in the list', ['icon/a', '--base', 'icon/q'], 'icon/q is not in resource/resources.csv'],
    ['keys and --pending', ['icon/a', '--pending'], 'usage: ogw resource request'],
    ['no key', [], 'usage: ogw resource request'],
  ];

  it.each(failures)('fails without changes on %s', async (_name, argv, message) => {
    const f = makeFixture({ 'resource/resources.csv': ROWS });
    await openRun(f, {});
    const run = await ogw(f.ws, ['resource', 'request', 'g', ...argv]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(message);
    expect(readFileSync(join(f.game, 'resource/resources.csv'), 'utf8')).toBe(ROWS);
    expect(requestFiles(f, 'records/loops/loop-1/resource-requests')).toEqual([]);
    expect(log(f)).toBe('init');
  });

  it('needs an open run', async () => {
    const f = makeFixture({ 'resource/resources.csv': ROWS });
    const run = await ogw(f.ws, ['resource', 'request', 'g', 'icon/a']);
    expect(run.stderr).toContain('no open run for game g');
    await openRun(f, { name: 'build-x', kind: 'build' });
    expect((await ogw(f.ws, ['resource', 'request', 'g', 'icon/a'])).stderr).toContain('build run build-x has no environment and version');
  });

  it('restores the files when the commit fails', async () => {
    const f = makeFixture({ 'resource/resources.csv': ROWS });
    await openRun(f, {});
    writeFileSync(join(f.game, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const run = await ogw(f.ws, ['resource', 'request', 'g', 'icon/a']);
    expect(run.code).toBe(1);
    expect(readFileSync(join(f.game, 'resource/resources.csv'), 'utf8')).toBe(ROWS);
    expect(requestFiles(f, 'records/loops/loop-1/resource-requests')).toEqual([]);
    expect(sh(f.game, 'git', ['status', '--porcelain'])).toBe('');
  });
});
