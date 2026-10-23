import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requireEngine } from '../../../src/commands/env/api.ts';
import { isEngineResource, isSyncedMeta, projectPath, type MetaProject } from '../../../src/commands/meta/lib/project.ts';
import { OgwError } from '../../../src/lib/errors.ts';
import { ogw, commitAll, makeGame, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeProgram, GAME_SETTINGS, makeRelease, write } from '../generate/helpers.ts';

vi.mock('../../../src/commands/core/api.ts', async () => (await import('../generate/helpers.ts')).coreApiMock);
vi.mock('../../../src/commands/env/api.ts', () => ({
  requireEngine: vi.fn(),
  enginePath: vi.fn(),
  installEngines: vi.fn(),
  toolProgram: vi.fn(),
}));

const IMPORT = `
if [ -f "$0.fail" ]; then echo "import broke" >&2; exit 3; fi
proj="$3"
find -L "$proj" -path "$proj/addons" -prune -o -path "$proj/.godot" -prune -o -name '*.gd' -print | while read f; do [ -f "$f.uid" ] || echo uid > "$f.uid"; done
find -L "$proj" -path "$proj/addons" -prune -o -name '*.png' -print | while read f; do [ -f "$f.import" ] || echo imp > "$f.import"; done
`;

let godot = '';

beforeEach(() => {
  godot = fakeProgram(mkdtempSync(join(tmpdir(), 'ogw-godot-')), 'godot', IMPORT);
  vi.mocked(requireEngine).mockReset();
  vi.mocked(requireEngine).mockResolvedValue(godot);
});

function godotLog(): string[] {
  return existsSync(`${godot}.log`) ? readFileSync(`${godot}.log`, 'utf8').trim().split('\n') : [];
}

function gameSetup(): { ws: TestWorkspace; root: string } {
  const ws = makeWorkspace();
  makeRelease(ws, '1.0.0', { godot: '4.5.1.stable' });
  const root = makeGame(ws, 'g', {
    'settings.json': GAME_SETTINGS,
    'client/other/b.gd': 'b',
    'client/other/b.gd.uid': 'uid-b',
    'client/other/d.gd': 'd',
    'client/addons/p/orphan.gd.uid': 'x',
    'resource/icon/x.png': 'png',
    'resource/icon/x.png.import': 'imp',
    'data/a.csv': 'a',
  });
  symlinkSync('../resource', join(root, 'client', 'resource'));
  commitAll(root, 'base');
  return { ws, root };
}

function lines(out: string): string[] {
  return out.split('\n').filter((l) => l !== '');
}

function stagedList(root: string): string[] {
  return lines(sh(root, 'git', ['diff', '--cached', '--name-only', '--no-renames']));
}

describe('ogw meta sync <game>', () => {
  it('imports the project and removes meta files without a source file', async () => {
    const { ws, root } = gameSetup();
    write(join(root, 'client', 'old.gd.uid'), 'o');
    write(join(root, 'resource', 'icon', 'gone.png.import'), 'o');
    write(join(root, 'client', 'a.gd'), 'a');
    sh(root, 'git', ['add', 'client/a.gd']);
    const run = await ogw(ws, ['meta', 'sync', 'g', '--staged']);
    expect(run.code).toBe(0);
    // the import also makes d.gd.uid, which goes back to HEAD: d.gd is not in the commit
    expect(run.stdout).toBe('removed client/old.gd.uid\nremoved resource/icon/gone.png.import\nstaged client/a.gd.uid\nreverted client/other/d.gd.uid\n');
    expect(requireEngine).toHaveBeenCalledWith(expect.anything(), 'godot', '4.5.1.stable');
    expect(godotLog()).toEqual([`--headless --path ${join(root, 'client')} --import`]);
    expect(existsSync(join(root, 'client', 'a.gd.uid'))).toBe(true);
    expect(existsSync(join(root, 'client', 'addons', 'p', 'orphan.gd.uid'))).toBe(true);
    expect(existsSync(join(root, 'client', 'old.gd.uid'))).toBe(false);
    // a second sync of the same commit changes nothing new
    expect((await ogw(ws, ['meta', 'sync', 'g', '--staged'])).stdout).toBe('staged client/a.gd.uid\nreverted client/other/d.gd.uid\n');
    expect(stagedList(root)).toEqual(['client/a.gd', 'client/a.gd.uid']);
    expect((await ogw(ws, ['meta', 'sync', 'g'])).stderr).toBe('usage: ogw meta sync <game|core> --staged\n');
  });

  it('with --staged does not import without a staged engine resource, and puts a meta change without its source back', async () => {
    const { ws, root } = gameSetup();
    write(join(root, 'data', 'a.csv'), 'b');
    write(join(root, 'client', 'other', 'b.gd.uid'), 'changed');
    write(join(root, 'client', 'addons', 'p', 'x.gd'), 'x');
    sh(root, 'git', ['add', '-f', 'data/a.csv', 'client/other/b.gd.uid', 'client/addons/p/x.gd']);
    const run = await ogw(ws, ['meta', 'sync', 'g', '--staged']);
    expect(run).toEqual({ code: 0, stdout: 'reverted client/other/b.gd.uid\n', stderr: '' });
    expect(readFileSync(join(root, 'client', 'other', 'b.gd.uid'), 'utf8')).toBe('uid-b');
    expect(stagedList(root)).toEqual(['client/addons/p/x.gd', 'data/a.csv']);
    expect((await ogw(ws, ['meta', 'sync', 'g', '--staged'])).stdout).toBe('no staged engine resource\n');
    expect(godotLog()).toEqual([]);
    expect(requireEngine).not.toHaveBeenCalled();
  });

  it('with --staged leaves the resources.csv.import that ogw generate writes', async () => {
    const { ws, root } = gameSetup();
    write(join(root, 'resource', 'resources.csv'), 'key\n');
    write(join(root, 'resource', 'resources.csv.import'), '[remap]\n\nimporter="csv_translation"\n');
    commitAll(root, 'resource list imported as translation');
    // `ogw generate` writes the skip import file; the commit stages an engine resource but not resources.csv
    write(join(root, 'resource', 'resources.csv.import'), '[remap]\n\nimporter="skip"\n');
    write(join(root, 'client', 'feat', 'a.gd'), 'a');
    sh(root, 'git', ['add', 'client/feat/a.gd']);
    const run = await ogw(ws, ['meta', 'sync', 'g', '--staged']);
    expect(lines(run.stdout)).toEqual(['staged client/feat/a.gd.uid', 'reverted client/other/d.gd.uid']);
    expect(readFileSync(join(root, 'resource', 'resources.csv.import'), 'utf8')).toBe('[remap]\n\nimporter="skip"\n');
    // a new resources.csv.import is not removed or reverted either
    sh(root, 'git', ['rm', '--quiet', '-f', 'resource/resources.csv.import']);
    commitAll(root, 'drop it');
    expect(sh(root, 'git', ['ls-files', 'resource/resources.csv.import'])).toBe('');
    write(join(root, 'resource', 'resources.csv.import'), '[remap]\n\nimporter="skip"\n');
    write(join(root, 'client', 'feat', 'b.gd'), 'b');
    sh(root, 'git', ['add', 'client/feat/b.gd']);
    expect(lines((await ogw(ws, ['meta', 'sync', 'g', '--staged'])).stdout)).toEqual(['staged client/feat/b.gd.uid', 'reverted client/other/d.gd.uid']);
    expect(existsSync(join(root, 'resource', 'resources.csv.import'))).toBe(true);
  });

  it('with --staged keeps resources.csv.import when resources.csv is missing or its deletion is staged', async () => {
    const { ws, root } = gameSetup();
    write(join(root, 'resource', 'resources.csv'), 'key\n');
    write(join(root, 'resource', 'resources.csv.import'), '[remap]\n\nimporter="skip"\n');
    commitAll(root, 'resource list and its skip import file');
    // the deletion of resources.csv is staged while resources.csv.import stays in the index
    sh(root, 'git', ['rm', '--quiet', 'resource/resources.csv']);
    write(join(root, 'client', 'feat', 'a.gd'), 'a');
    sh(root, 'git', ['add', 'client/feat/a.gd']);
    await ogw(ws, ['meta', 'sync', 'g', '--staged']);
    expect(sh(root, 'git', ['ls-files', 'resource/resources.csv.import']).trim()).toBe('resource/resources.csv.import');
    // resources.csv missing on disk: its import file is not an orphan to remove
    commitAll(root, 'resource list removed');
    write(join(root, 'client', 'feat', 'b.gd'), 'b');
    sh(root, 'git', ['add', 'client/feat/b.gd']);
    await ogw(ws, ['meta', 'sync', 'g', '--staged']);
    expect(existsSync(join(root, 'resource', 'resources.csv.import'))).toBe(true);
  });

  it('with --staged stages meta changes in staged folders and puts the others back to HEAD', async () => {
    const { ws, root } = gameSetup();
    write(join(root, 'client', 'feat', 'a.gd'), 'a');
    write(join(root, 'resource', 'icon', 'y.png'), 'png');
    sh(root, 'git', ['add', 'client/feat/a.gd', 'resource/icon/y.png']);
    sh(root, 'git', ['rm', '--quiet', '--cached', 'client/other/d.gd']);
    sh(root, 'git', ['add', '-A', 'client/other/d.gd']);
    write(join(root, 'client', 'other', 'b.gd.uid'), 'changed');
    const run = await ogw(ws, ['meta', 'sync', 'g', '--staged']);
    expect(run.code).toBe(0);
    expect(run.stdout.split('\n').filter((l) => l !== '')).toEqual([
      'staged client/feat/a.gd.uid',
      'staged resource/icon/y.png.import',
      'reverted client/other/b.gd.uid',
      'reverted client/other/d.gd.uid',
    ]);
    const staged = sh(root, 'git', ['diff', '--cached', '--name-only']).trim().split('\n');
    expect(staged).toEqual(['client/feat/a.gd', 'client/feat/a.gd.uid', 'resource/icon/y.png', 'resource/icon/y.png.import']);
    expect(readFileSync(join(root, 'client', 'other', 'b.gd.uid'), 'utf8')).toBe('uid-b');
    expect(existsSync(join(root, 'client', 'other', 'd.gd.uid'))).toBe(false);
  });

  it('with --staged commits a staged folder deletion', async () => {
    const { ws, root } = gameSetup();
    sh(root, 'git', ['rm', '-r', '--quiet', 'client/other']);
    const run = await ogw(ws, ['meta', 'sync', 'g', '--staged']);
    expect(run).toEqual({ code: 0, stdout: 'no meta change\n', stderr: '' });
    expect(stagedList(root)).toEqual(['client/other/b.gd', 'client/other/b.gd.uid', 'client/other/d.gd']);
  });

  it('with --staged commits a staged folder rename', async () => {
    const { ws, root } = gameSetup();
    sh(root, 'git', ['mv', 'client/other', 'client/moved']);
    const run = await ogw(ws, ['meta', 'sync', 'g', '--staged']);
    expect(run.code).toBe(0);
    expect(lines(run.stdout)).toEqual(['staged client/moved/b.gd.uid', 'staged client/moved/d.gd.uid']);
    expect(stagedList(root)).toEqual([
      'client/moved/b.gd',
      'client/moved/b.gd.uid',
      'client/moved/d.gd',
      'client/moved/d.gd.uid',
      'client/other/b.gd',
      'client/other/b.gd.uid',
      'client/other/d.gd',
    ]);
  });

  it('with --staged stages the meta deletion of a deleted source', async () => {
    const { ws, root } = gameSetup();
    sh(root, 'git', ['rm', '--quiet', 'client/other/b.gd']);
    const run = await ogw(ws, ['meta', 'sync', 'g', '--staged']);
    expect(run.code).toBe(0);
    expect(lines(run.stdout)).toEqual(['removed client/other/b.gd.uid', 'staged client/other/b.gd.uid', 'reverted client/other/d.gd.uid']);
    expect(stagedList(root)).toEqual(['client/other/b.gd', 'client/other/b.gd.uid']);
  });

  it('with --staged moves the meta file of a renamed source', async () => {
    const { ws, root } = gameSetup();
    sh(root, 'git', ['mv', 'client/other/b.gd', 'client/other/c.gd']);
    const run = await ogw(ws, ['meta', 'sync', 'g', '--staged']);
    expect(run.code).toBe(0);
    expect(lines(run.stdout)).toEqual([
      'removed client/other/b.gd.uid',
      'staged client/other/b.gd.uid',
      'staged client/other/c.gd.uid',
      'reverted client/other/d.gd.uid',
    ]);
    expect(stagedList(root)).toEqual(['client/other/b.gd', 'client/other/b.gd.uid', 'client/other/c.gd', 'client/other/c.gd.uid']);
  });

  it('with --staged stages only the meta files whose source is staged', async () => {
    const { ws, root } = gameSetup();
    write(join(root, 'client', 'a', 'foo.gd'), 'foo');
    write(join(root, 'client', 'a', 'bar.gd'), 'bar');
    sh(root, 'git', ['add', 'client/a/foo.gd']);
    const run = await ogw(ws, ['meta', 'sync', 'g', '--staged']);
    expect(lines(run.stdout)).toEqual(['staged client/a/foo.gd.uid', 'reverted client/a/bar.gd.uid', 'reverted client/other/d.gd.uid']);
    expect(stagedList(root)).toEqual(['client/a/foo.gd', 'client/a/foo.gd.uid']);
    expect(existsSync(join(root, 'client', 'a', 'bar.gd.uid'))).toBe(false);
  });

  it('with --staged reverts a meta file deleted in the index and present on disk once', async () => {
    const { ws, root } = gameSetup();
    sh(root, 'git', ['rm', '--quiet', '--cached', 'client/other/b.gd.uid']);
    write(join(root, 'client', 'n.gd'), 'n');
    sh(root, 'git', ['add', 'client/n.gd']);
    const run = await ogw(ws, ['meta', 'sync', 'g', '--staged', '--json']);
    expect(run.code).toBe(0);
    const data = JSON.parse(run.stdout) as { staged: string[]; reverted: string[] };
    expect(data).toMatchObject({ staged: ['client/n.gd.uid'], reverted: ['client/other/b.gd.uid', 'client/other/d.gd.uid'] });
    expect(stagedList(root)).toEqual(['client/n.gd', 'client/n.gd.uid']);
    expect(readFileSync(join(root, 'client', 'other', 'b.gd.uid'), 'utf8')).toBe('uid-b');
  });

  it('with --staged reverts meta files with one checkout and one rm, without a git process per file', async () => {
    const { ws, root } = gameSetup();
    write(join(root, 'client', 'other', 'b.gd.uid'), 'changed');
    write(join(root, 'resource', 'icon', 'x.png.import'), 'changed');
    write(join(root, 'client', 'a', 'e.gd'), 'e');
    write(join(root, 'client', 'n.gd'), 'n');
    sh(root, 'git', ['add', 'client/n.gd']);
    const bin = mkdtempSync(join(tmpdir(), 'ogw-git-'));
    const real = sh(root, 'sh', ['-c', 'command -v git']).trim();
    write(join(bin, 'git'), `#!/bin/sh\necho "$*" >> "${bin}/log"\nexec "${real}" "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const run = await ogw(ws, ['meta', 'sync', 'g', '--staged'], { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } });
    expect(run.code).toBe(0);
    expect(lines(run.stdout).sort()).toEqual([
      'reverted client/a/e.gd.uid',
      'reverted client/other/b.gd.uid',
      'reverted client/other/d.gd.uid',
      'reverted resource/icon/x.png.import',
      'staged client/n.gd.uid',
    ]);
    const calls = lines(readFileSync(join(bin, 'log'), 'utf8'));
    expect(calls.filter((call) => call.includes('cat-file'))).toEqual([]);
    expect(calls.filter((call) => / checkout HEAD /.test(call))).toHaveLength(1);
    expect(calls.filter((call) => / rm --cached /.test(call))).toHaveLength(1);
    expect(stagedList(root)).toEqual(['client/n.gd', 'client/n.gd.uid']);
    expect(readFileSync(join(root, 'client', 'other', 'b.gd.uid'), 'utf8')).toBe('uid-b');
    expect(readFileSync(join(root, 'resource', 'icon', 'x.png.import'), 'utf8')).toBe('imp');
    expect(existsSync(join(root, 'client', 'a', 'e.gd.uid'))).toBe(false);
    expect(existsSync(join(root, 'client', 'other', 'd.gd.uid'))).toBe(false);
  });

  it('with --staged takes the meta file out of the index when its source leaves the index', async () => {
    const { ws, root } = gameSetup();
    sh(root, 'git', ['rm', '--quiet', '--cached', 'client/other/b.gd']);
    const run = await ogw(ws, ['meta', 'sync', 'g', '--staged']);
    expect(lines(run.stdout)).toEqual(['staged client/other/b.gd.uid', 'reverted client/other/d.gd.uid']);
    expect(stagedList(root)).toEqual(['client/other/b.gd', 'client/other/b.gd.uid']);
    expect(readFileSync(join(root, 'client', 'other', 'b.gd.uid'), 'utf8')).toBe('uid-b');
  });

  it('with --staged changes only the meta file of a name with glob characters, not the files it matches as a glob', async () => {
    const { ws, root } = gameSetup();
    write(join(root, 'client', 'a[1].gd'), 'a');
    write(join(root, 'client', 'a[1].gd.uid'), 'uid-a');
    write(join(root, 'client', 'a1.gd'), 'a1');
    write(join(root, 'client', 'a1.gd.uid'), 'uid-a1');
    write(join(root, 'client', 'other', 'd.gd.uid'), 'uid-d');
    commitAll(root, 'globs');
    sh(root, 'git', ['--literal-pathspecs', 'rm', '--quiet', '--cached', 'client/a[1].gd']);
    write(join(root, 'client', 'b[1].gd'), 'b');
    write(join(root, 'client', 'b1.gd'), 'b1');
    write(join(root, 'client', 'b1.gd.uid'), 'uid-b1');
    sh(root, 'git', ['--literal-pathspecs', 'add', 'client/b[1].gd']);
    const run = await ogw(ws, ['meta', 'sync', 'g', '--staged']);
    expect(run.code).toBe(0);
    expect(lines(run.stdout)).toEqual(['staged client/a[1].gd.uid', 'staged client/b[1].gd.uid', 'reverted client/b1.gd.uid']);
    expect(stagedList(root)).toEqual(['client/a[1].gd', 'client/a[1].gd.uid', 'client/b[1].gd', 'client/b[1].gd.uid']);
    expect(sh(root, 'git', ['ls-files', '--', 'client/a1.gd.uid']).trim()).toBe('client/a1.gd.uid');
  });

  it('with --staged leaves the meta file of a staged source the project does not see', async () => {
    const { ws, root } = gameSetup();
    write(join(root, 'client', 'addons', 'p', 'x.gd'), 'x');
    write(join(root, 'client', 'addons', 'p', 'x.gd.uid'), 'uid-x');
    commitAll(root, 'addon');
    sh(root, 'git', ['rm', '--quiet', '--cached', 'client/addons/p/x.gd']);
    write(join(root, 'client', 'n.gd'), 'n');
    sh(root, 'git', ['add', 'client/n.gd']);
    const run = await ogw(ws, ['meta', 'sync', 'g', '--staged']);
    expect(run.code).toBe(0);
    expect(lines(run.stdout)).toEqual(['staged client/n.gd.uid', 'reverted client/other/d.gd.uid']);
    expect(stagedList(root)).toEqual(['client/addons/p/x.gd', 'client/n.gd', 'client/n.gd.uid']);
  });

  it('with --staged stages the deletion of a meta file that is gone from disk while its source stays', async () => {
    const { ws, root } = gameSetup();
    write(join(root, 'client', 'scene', 's.tscn'), 's');
    write(join(root, 'client', 'scene', 's.tscn.uid'), 'uid-s');
    commitAll(root, 'scene');
    write(join(root, 'client', 'scene', 's.tscn'), 's2');
    sh(root, 'git', ['add', 'client/scene/s.tscn']);
    sh(root, 'rm', [join(root, 'client', 'scene', 's.tscn.uid')]);
    const run = await ogw(ws, ['meta', 'sync', 'g', '--staged']);
    expect(run.code).toBe(0);
    expect(lines(run.stdout)).toEqual(['staged client/scene/s.tscn.uid', 'reverted client/other/d.gd.uid']);
    expect(lines(sh(root, 'git', ['diff', '--cached', '--name-status', '--no-renames']))).toEqual(['M\tclient/scene/s.tscn', 'D\tclient/scene/s.tscn.uid']);
  });

  it('does not read the folders the project does not see', async () => {
    const { ws, root } = gameSetup();
    const cache = join(root, 'client', '.godot', 'imported');
    mkdirSync(cache, { recursive: true });
    chmodSync(cache, 0o000);
    try {
      write(join(root, 'client', 'other', 'd.gd'), 'd2');
      sh(root, 'git', ['add', 'client/other/d.gd']);
      const run = await ogw(ws, ['meta', 'sync', 'g', '--staged']);
      expect(run.code).toBe(0);
    } finally {
      chmodSync(cache, 0o755);
    }
  });

  it('fails when the import fails or the engine is missing, and on another engine', async () => {
    const { ws, root } = gameSetup();
    write(join(root, 'client', 'other', 'd.gd'), 'd2');
    sh(root, 'git', ['add', 'client/other/d.gd']);
    write(`${godot}.fail`, '');
    const failed = await ogw(ws, ['meta', 'sync', 'g', '--staged']);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('godot --import failed (3): import broke');
    vi.mocked(requireEngine).mockRejectedValue(new OgwError('godot 4.5.1.stable is not installed; run ogw env install-engines', 2));
    const missing = await ogw(ws, ['meta', 'sync', 'g', '--staged']);
    expect(missing).toMatchObject({ code: 2, stderr: 'godot 4.5.1.stable is not installed; run ogw env install-engines\n' });
    write(join(root, 'settings.json'), { ...GAME_SETTINGS, engine: 'unity' });
    expect((await ogw(ws, ['meta', 'sync', 'g', '--staged'])).stderr).toContain('not defined: engine meta files of engine unity');
    expect((await ogw(ws, ['meta', 'sync', '--staged'])).code).toBe(1);
  });

  it('fails when engine.json has no godot version', async () => {
    const { ws, root } = gameSetup();
    write(join(ws.coreReleases, '1.0.0', 'extracted', 'client-godot.zip', 'engine.json'), {});
    write(join(root, 'client', 'other', 'd.gd'), 'd2');
    sh(root, 'git', ['add', 'client/other/d.gd']);
    expect((await ogw(ws, ['meta', 'sync', 'g', '--staged'])).stderr).toContain('no godot version in');
  });
});

describe('ogw meta sync core', () => {
  it('works on open-game-works-core-impl/client/godot/, or on the core worktree the command runs in', async () => {
    const ws = makeWorkspace();
    const project = join(ws.coreImpl, 'client', 'godot');
    write(join(project, 'engine.json'), { godot: '4.6.0.stable' });
    write(join(project, 'core', 'm', 'm.gd'), 'm');
    write(join(project, 'core', 'm', 'gone.gd.uid'), 'u');
    write(join(project, 'plugins', 'ogw-x', 'y.gd.uid'), 'u');
    commitAll(ws.coreImpl, 'core');
    write(join(project, 'core', 'm', 'm.gd'), 'm2');
    sh(ws.coreImpl, 'git', ['add', 'client/godot/core/m/m.gd']);
    const run = await ogw(ws, ['meta', 'sync', 'core', '--staged']);
    expect(run.stdout).toContain('removed client/godot/core/m/gone.gd.uid\n');
    expect(requireEngine).toHaveBeenCalledWith(expect.anything(), 'godot', '4.6.0.stable');
    expect(existsSync(join(project, 'plugins', 'ogw-x', 'y.gd.uid'))).toBe(true);
    const worktree = join(ws.worktrees, '_core', 'w1');
    sh(ws.coreImpl, 'git', ['worktree', 'add', '--quiet', '--detach', worktree, 'HEAD']);
    write(join(worktree, 'client', 'godot', 'core', 'm', 'n.gd'), 'n');
    sh(worktree, 'git', ['add', 'client/godot/core/m/n.gd']);
    const staged = await ogw(ws, ['meta', 'sync', 'core', '--staged'], { cwd: worktree });
    expect(staged.stdout).toContain('staged client/godot/core/m/n.gd.uid');
    expect(godotLog().at(-1)).toBe(`--headless --path ${join(worktree, 'client', 'godot')} --import`);
  });
});

describe('project paths', () => {
  const game: MetaProject = { repo: '/r', dir: '/r/client', areas: ['client', 'resource'], godotVersion: () => Promise.resolve('') };
  const core: MetaProject = { repo: '/c', dir: '/c/client/godot', areas: ['client/godot'], godotVersion: () => Promise.resolve('') };

  it('maps checkout paths to project paths and finds engine resources', () => {
    expect(projectPath(game, 'client/a/b.gd')).toBe('a/b.gd');
    expect(projectPath(game, 'resource/icon/x.png')).toBe('resource/icon/x.png');
    expect(projectPath(game, 'data/a.csv')).toBeNull();
    expect(projectPath(game, 'clientx/a.gd')).toBeNull();
    expect(projectPath(core, 'client/godot/core/a.gd')).toBe('core/a.gd');
    expect(projectPath(core, 'resource/a.png')).toBeNull();
    expect(isEngineResource(game, 'client/a.gd')).toBe(true);
    // Godot does not read the core project's engine.json: a commit that sets the Godot version needs no import
    expect(isEngineResource(core, 'client/godot/engine.json')).toBe(false);
    expect(isEngineResource(core, 'client/godot/core/engine.json')).toBe(true);
    expect(isEngineResource(game, 'client/engine.json')).toBe(true);
    expect(isEngineResource(game, 'client/a.gd.uid')).toBe(false);
    expect(isEngineResource(game, 'client/a.png.import')).toBe(false);
    for (const prefix of ['.godot', 'addons', 'android', 'ios/plugins', 'plugins']) {
      expect(isEngineResource(game, `client/${prefix}/x.gd`)).toBe(false);
    }
    expect(isEngineResource(game, 'client/ios/x.gd')).toBe(true);
    expect(isEngineResource(core, 'client/godot/plugins/ogw-x/src.gd')).toBe(false);
    expect(isEngineResource(game, 'data/a.csv')).toBe(false);
    expect(isSyncedMeta(game, 'resource/icon/x.png.import')).toBe(true);
    expect(isSyncedMeta(game, 'resource/resources.csv.import')).toBe(false);
    expect(isSyncedMeta(game, 'resource/icon/x.png')).toBe(false);
    expect(isSyncedMeta(game, 'client/addons/p/x.gd.uid')).toBe(false);
  });
});
