import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isRequestFileName, requestPendingResources } from '../../../src/commands/resource/api.ts';
import { requestFileKeys } from '../../../src/commands/resource/lib/request.ts';
import { createContext } from '../../../src/lib/command.ts';
import type { GameRepo } from '../../../src/lib/game.ts';
import { changeRuns, newRunState, type RunState } from '../../../src/lib/runstate.ts';
import { ogw, commitAll, sh } from '../../helpers/workspace.ts';
import { listCsv, makeFixture, rowOf, type Fixture, type Row } from './fixture.ts';

/** The final UI kit sheet that a request of `nine_slice` and `icon` keys needs (`resource` `## resource request`). */
const KIT: Row = { key: 'image/ui_kit', spec: 'size=1024x1024', status: 'final' };

const ROWS = listCsv([
  { key: 'icon/a', spec: 'size=8x8', status: 'placeholder' },
  { key: 'icon/b', spec: 'size=8x8', status: 'requested' },
  { key: 'icon/c', spec: 'size=8x8', status: 'final' },
  { key: 'icon/d', spec: 'size=8x8', status: 'requested' },
  { key: 'scene/x/main', status: 'final' },
  KIT,
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
    // a final row with no committed file: nothing tells the spec it was made for
    expect(rowOf(f.game, 'icon/c').status).toBe('requested');
    expect(log(f)).toBe('resource request: icon/a icon/c');
    // The commit is made with the command's env, not process.env.
    expect(sh(f.game, 'git', ['log', '-1', '--format=%an %ae'])).toBe('ogw-test ogw-test@example.com\n');
    expect(sh(f.game, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('keeps a final row asked again for the spec its files were made for, and makes it requested when its spec changed', async () => {
    const made = (key: string, spec: string): Record<string, string> => ({ key, spec, status: 'final', method: 'flux2-klein', source: 'generated', license: 'Apache-2.0' });
    const f = makeFixture({
      'resource/icon/c.png': 'MADE',
      'resource/icon/e.png': 'MADE',
      'resource/resources.csv': listCsv([made('icon/c', 'size=8x8'), made('icon/e', 'size=8x8'), KIT]),
    });
    await openRun(f, {});
    writeFileSync(join(f.game, 'resource/resources.csv'), listCsv([made('icon/c', 'size=8x8'), made('icon/e', 'size=16x16'), KIT]));
    const run = await ogw(f.ws, ['resource', 'request', 'g', 'icon/c', 'icon/e']);
    expect(run.stderr).toBe('');
    expect(rowOf(f.game, 'icon/c')).toMatchObject({ status: 'final', method: 'flux2-klein', license: 'Apache-2.0' });
    expect(rowOf(f.game, 'icon/e')).toMatchObject({ status: 'requested', spec: 'size=16x16' });
    expect(requestFileKeys(readFileSync(join(f.game, run.stdout.trim()), 'utf8'))).toEqual(['icon/c', 'icon/e']);
  });

  it('makes a final row requested when its spec changed in a commit after its files, such as an earlier request of another key', async () => {
    const made = (key: string, spec: string): Record<string, string> => ({ key, spec, status: 'final', method: 'moss-sfx', source: 'generated', license: 'Apache-2.0' });
    const f = makeFixture({
      'resource/sfx/hit.wav': 'MADE',
      'resource/resources.csv': listCsv([made('sfx/hit', 'length=200'), { key: 'icon/f', spec: 'size=8x8', status: 'placeholder' }, KIT]),
    });
    await openRun(f, {});
    writeFileSync(join(f.game, 'resource/resources.csv'), listCsv([made('sfx/hit', 'length=200;variants=3'), { key: 'icon/f', spec: 'size=8x8', status: 'placeholder' }, KIT]));
    expect((await ogw(f.ws, ['resource', 'request', 'g', 'icon/f'])).stderr).toBe('');
    // that request committed the whole list, the changed spec of sfx/hit with it
    expect(rowOf(f.game, 'sfx/hit')).toMatchObject({ status: 'final', spec: 'length=200;variants=3' });
    expect((await ogw(f.ws, ['resource', 'request', 'g', 'sfx/hit'])).stderr).toBe('');
    expect(rowOf(f.game, 'sfx/hit').status).toBe('requested');
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

  it('refuses nine_slice and icon keys without an image/ui_kit row, and with a placeholder or temporary kit outside the request and this run', async () => {
    const pieces = [{ key: 'icon/coin', spec: 'size=8x8', status: 'placeholder' }, { key: 'nine_slice/panel', spec: 'size=256x256;slice=8,8,8,8', status: 'placeholder' }, { key: 'image/hero', spec: 'size=8x8', status: 'placeholder' }];
    const none = makeFixture({ 'resource/resources.csv': listCsv(pieces) });
    await openRun(none, {});
    const refused = await ogw(none.ws, ['resource', 'request', 'g', 'icon/coin', 'nine_slice/panel', 'image/hero']);
    const reason = 'resource/resources.csv has no image/ui_kit row, which nine_slice and icon keys are made from; add it with spec size=1024x1024 and request it with its first nine_slice and icon keys';
    expect(refused).toMatchObject({ code: 1, stderr: `icon/coin: ${reason}\nnine_slice/panel: ${reason}\n` });
    expect(rowOf(none.game, 'icon/coin').status).toBe('placeholder');
    expect((await ogw(none.ws, ['resource', 'request', 'g', 'image/hero'])).code).toBe(0);
    // --pending leaves them out and requests the rest
    const pending = await ogw(none.ws, ['resource', 'request', 'g', '--pending', '--json']);
    expect(JSON.parse(pending.stdout)).toMatchObject({ path: null, keys: [], leftOut: ['icon/coin', 'nine_slice/panel'] });
    expect((await ogw(none.ws, ['resource', 'request', 'g', '--pending'])).stdout).toBe(
      'no pending resource\nleft out icon/coin: resource/resources.csv has no image/ui_kit row, which nine_slice and icon keys are made from\nleft out nine_slice/panel: resource/resources.csv has no image/ui_kit row, which nine_slice and icon keys are made from\n',
    );

    for (const status of ['placeholder', 'temporary']) {
      const f = makeFixture({ 'resource/resources.csv': listCsv([...pieces, { key: 'image/ui_kit', spec: 'size=8x8', status, ...(status === 'temporary' ? { method: 'flux2-klein' } : {}) }]) });
      await openRun(f, {});
      const alone = await ogw(f.ws, ['resource', 'request', 'g', 'icon/coin']);
      expect(alone).toMatchObject({ code: 1, stderr: `icon/coin: image/ui_kit is ${status} and in no request of this run; request it in the same request\n` });
      expect((await ogw(f.ws, ['resource', 'request', 'g', 'image/ui_kit', 'icon/coin'])).code).toBe(0);
      // the kit is in a request file of this run now: a later key goes alone
      expect((await ogw(f.ws, ['resource', 'request', 'g', 'nine_slice/panel'])).code).toBe(0);
    }
    const requested = makeFixture({ 'resource/resources.csv': listCsv([...pieces, { key: 'image/ui_kit', spec: 'size=8x8', status: 'requested' }]) });
    await openRun(requested, {});
    expect((await ogw(requested.ws, ['resource', 'request', 'g', 'icon/coin'])).code).toBe(0);
    // --pending holds a placeholder kit with its pieces in one request
    const together = makeFixture({ 'resource/resources.csv': listCsv([...pieces, { key: 'image/ui_kit', spec: 'size=8x8', status: 'placeholder' }]) });
    await openRun(together, {});
    const both = JSON.parse((await ogw(together.ws, ['resource', 'request', 'g', '--pending', '--json'])).stdout) as { keys: string[]; leftOut: string[] };
    expect(both).toMatchObject({ keys: ['icon/coin', 'nine_slice/panel', 'image/hero', 'image/ui_kit'], leftOut: [] });
  });

  it('leaves out a nine_slice whose long side is under 256 from --pending and refuses it by name', async () => {
    const f = makeFixture({
      'resource/resources.csv': listCsv([
        { key: 'nine_slice/small', spec: 'size=128x128;slice=8,8,8,8', status: 'placeholder' },
        { key: 'nine_slice/thin', spec: 'size=255x32;slice=8,8,8,8', status: 'requested' },
        { key: 'nine_slice/edge', spec: 'size=32x256;slice=8,8,8,8', status: 'placeholder' },
        { key: 'nine_slice/wide', spec: 'size=512x64;slice=8,8,8,8', status: 'placeholder' },
        KIT,
      ]),
    });
    await openRun(f, {});
    const run = await ogw(f.ws, ['resource', 'request', 'g', '--pending', '--json']);
    expect(run.stderr).toBe('');
    const data = JSON.parse(run.stdout) as { path: string; keys: string[]; leftOut: string[] };
    expect(data).toMatchObject({ keys: ['nine_slice/edge', 'nine_slice/wide'], leftOut: ['nine_slice/small', 'nine_slice/thin'] });
    expect(requestFileKeys(readFileSync(join(f.game, data.path), 'utf8'))).toEqual(['nine_slice/edge', 'nine_slice/wide']);
    expect(rowOf(f.game, 'nine_slice/small').status).toBe('placeholder');
    expect(rowOf(f.game, 'nine_slice/edge').status).toBe('requested');
    const again = await ogw(f.ws, ['resource', 'request', 'g', '--pending']);
    expect(again).toMatchObject({
      code: 0,
      stdout: 'no pending resource\nleft out nine_slice/small: the long side of a nine_slice size is under 256\nleft out nine_slice/thin: the long side of a nine_slice size is under 256\n',
    });
    const ctx = createContext({ cwd: f.ws.root, env: f.ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const small = 'the long side of a nine_slice size is under 256';
    expect(await requestPendingResources(ctx, repo(f))).toEqual({ path: null, leftOut: [{ key: 'nine_slice/small', reason: small }, { key: 'nine_slice/thin', reason: small }] });
    const named = await ogw(f.ws, ['resource', 'request', 'g', 'nine_slice/small', 'nine_slice/thin', 'nine_slice/edge']);
    expect(named).toMatchObject({
      code: 1,
      stderr: 'nine_slice/small: the long side of a nine_slice size is 256 or more\nnine_slice/thin: the long side of a nine_slice size is 256 or more\n',
    });
    expect(rowOf(f.game, 'nine_slice/small').status).toBe('placeholder');
    expect(requestFiles(f, 'records/loops/loop-1/resource-requests')).toHaveLength(1);
  });

  it('requests a temporary row once per run and keeps its status and file', async () => {
    const f = makeFixture({
      'resource/resources.csv': listCsv([
        { key: 'icon/t', spec: 'size=8x8', status: 'temporary', method: 'flux2-klein' },
        { key: 'icon/u', spec: 'size=8x8', status: 'temporary', method: 'flux2-klein' },
        KIT,
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
        KIT,
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
    const { path } = await requestPendingResources(ctx, repo(f));
    expect(path).toMatch(/^records\/hardening\/stg-1\.2\.0-resource-[0-9]+\.md$/);
    expect(requestFileKeys(readFileSync(join(f.game, path as string), 'utf8'))).toEqual(['icon/a', 'icon/d']);
    expect(await requestPendingResources(ctx, repo(f))).toEqual({ path: null, leftOut: [] });
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
