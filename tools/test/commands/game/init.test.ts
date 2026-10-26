import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coreRelease, remoteReleaseVersions } from '../../../src/commands/core/api.ts';
import { hookScript, PRE_COMMIT_MAIN } from '../../../src/commands/game/lib/pre-commit.ts';
import { ogw, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { writeRelease } from '../settings/fixtures.ts';

vi.mock('../../../src/commands/core/api.ts', () => ({
  coreRelease: vi.fn(),
  coreReleaseOfGame: vi.fn(),
  extractedAsset: vi.fn(),
  remoteReleaseVersions: vi.fn(),
  markProposalReleased: vi.fn(),
}));

let ws: TestWorkspace;
let root: string;

beforeEach(() => {
  ws = makeWorkspace();
  root = join(ws.games, 'mygame');
  vi.mocked(remoteReleaseVersions).mockResolvedValue(['1.2.0', '1.9.3', '1.10.0']);
});

const draft = (coreVersion: string, postgresqlMajor: number) => ({
  $schema: '../../open-game-works-core/schemas/game-settings.schema.json',
  coreVersion,
  postgresqlMajor,
  environments: {
    DEV: { corsAllowedOrigins: [], adminOperators: [{ name: 'ogw', roles: ['read', 'ops', 'release'], secret: 'admin-ogw-dev' }] },
    STG: { corsAllowedOrigins: [], adminOperators: [{ name: 'ogw', roles: ['read', 'ops', 'release'], secret: 'admin-ogw-stg' }] },
    PROD: { corsAllowedOrigins: [], adminOperators: [{ name: 'ogw', roles: ['read'], secret: 'admin-ogw-prod' }], adapters: { cdn: 'cdn-r2' } },
  },
});

describe('ogw game init', () => {
  it('creates the game repo, settings draft, id-registry branch and hook', async () => {
    const run = await ogw(ws, ['game', 'init', 'mygame']);
    expect(run).toEqual({ code: 0, stdout: `created ${root}\ncoreVersion 1.10.0\npostgresqlMajor 18\n`, stderr: '' });
    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe(`${JSON.stringify(draft('1.10.0', 18), null, 2)}\n`);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(
      '/builds/\n/client/build/\n/server/build/\n/captures/\n/records/loops/*/evidence/\n/records/setup/reference/*\n!/records/setup/reference/reference.md\n',
    );
    for (const folder of ['contract', 'data', 'resource', 'client/dev', 'server/dev', 'records']) expect(existsSync(join(root, folder))).toBe(true);
    expect(sh(root, 'git', ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/main');
    expect(sh(root, 'git', ['show', 'id-registry:id_registry.json'])).toBe('{}\n');
    expect(sh(root, 'git', ['ls-tree', '--name-only', 'id-registry']).trim()).toBe('id_registry.json');
    expect(sh(root, 'git', ['rev-list', '--count', 'id-registry']).trim()).toBe('1');
    const hook = join(root, '.git', 'hooks', 'pre-commit');
    expect(readFileSync(hook, 'utf8')).toBe(hookScript('mygame'));
    expect(statSync(hook).mode & 0o777).toBe(0o755);
    expect(sh(root, 'git', ['config', '--local', 'core.hooksPath']).trim()).toBe(join(root, '.git', 'hooks'));
    expect(hookScript('my game')).toContain(`'${PRE_COMMIT_MAIN}' 'my game'`);
    expect(hookScript("it's")).toContain(`'it'\\''s'`);
  });

  it('starts the game on the core of the harness when the harness has a core-v tag', async () => {
    sh(ws.harness, 'git', ['tag', 'core-v1.9.0']);
    const run = await ogw(ws, ['game', 'init', 'mygame']);
    expect(run.stdout).toContain('coreVersion 1.9.0\n');
  });

  it('keeps every gameplay video out of git and lets reference.md in', async () => {
    await ogw(ws, ['game', 'init', 'mygame']);
    const dir = join(root, 'records/setup/reference');
    mkdirSync(join(dir, 'clips'), { recursive: true });
    for (const file of ['reference.md', 'a.mp4', 'b.webm', 'c.MKV', 'd.mp4.part', 'clips/e.mov']) writeFileSync(join(dir, file), 'x');
    sh(root, 'git', ['add', '--all']);
    expect(sh(root, 'git', ['ls-files', '--cached', 'records/setup/reference'])).toBe('records/setup/reference/reference.md\n');
    expect(sh(root, 'git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', 'records/setup/reference']).split('\n').filter(Boolean).sort()).toEqual(
      ['a.mp4', 'b.webm', 'c.MKV', 'clips/', 'd.mp4.part'].map((file) => `records/setup/reference/${file}`),
    );
  });

  it('gives JSON and reads the PostgreSQL major from harness settings', async () => {
    const settings = JSON.parse(readFileSync(join(ws.harness, 'settings.json'), 'utf8')) as { tools: { postgresql: { tag: string } } };
    settings.tools.postgresql.tag = '17.2';
    writeFileSync(join(ws.harness, 'settings.json'), JSON.stringify(settings));
    const run = await ogw(ws, ['game', 'init', 'mygame', '--json']);
    expect(JSON.parse(run.stdout)).toEqual({ root, coreVersion: '1.10.0', postgresqlMajor: 17, hook: join(root, '.git', 'hooks', 'pre-commit') });
  });

  it('leaves the values for the human in the missing list', async () => {
    await ogw(ws, ['game', 'init', 'mygame']);
    const missing = (await ogw(ws, ['settings', 'list', 'game', 'mygame', '--missing'])).stdout.trim().split('\n').map((l) => l.split(':')[0]);
    expect(missing).toContain('engine');
    expect(missing).not.toContain('environments.DEV.adminOperators.0.secret');
    // a build stage value is not in the setup stage missing list (game check --build reports it)
    expect(missing).not.toContain('environments.PROD.cdnR2');
    expect(missing).not.toContain('coreVersion');
    expect(missing).not.toContain('postgresqlMajor');
  });

  it('takes settings set on the draft and keeps DEV access out of STG and PROD', async () => {
    vi.mocked(coreRelease).mockResolvedValue(writeRelease(join(ws.root, 'release'), '1.10.0'));
    await ogw(ws, ['game', 'init', 'mygame']);
    expect(await ogw(ws, ['settings', 'set', 'game', 'mygame', 'engine', '"godot"'])).toEqual({ code: 0, stdout: 'set engine\n', stderr: '' });
    for (const env of ['STG', 'PROD']) {
      for (const [path, value] of [
        [`environments.${env}.devAllowedCidrs`, '["10.0.0.0/8"]'],
        [`environments.${env}.secrets`, '{"devAccess":"dev-access"}'],
      ] as const) {
        const run = await ogw(ws, ['settings', 'set', 'game', 'mygame', path, value]);
        expect(run.code).toBe(1);
        expect(run.stderr).toContain(`environments.${env}: must NOT be valid`);
      }
    }
    expect(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'))).toEqual({ ...draft('1.10.0', 18), engine: 'godot' });
  });

  it('blocks a commit when the hook fails', async () => {
    await ogw(ws, ['game', 'init', 'mygame']);
    writeFileSync(join(root, 'brief.md'), '# brief\n');
    execFileSync('git', ['add', 'brief.md'], { cwd: root, env: ws.env });
    let stderr = '';
    try {
      execFileSync('git', ['commit', '-m', 'x'], { cwd: root, env: ws.env, encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      stderr = (error as { stderr: string }).stderr;
    }
    expect(stderr).toContain('ogw meta sync mygame --staged failed');
    expect(() => sh(root, 'git', ['rev-parse', '--verify', 'main'])).toThrow();
  });

  it('installs the hook in the repo even when the host has a global core.hooksPath', async () => {
    const shared = join(ws.root, 'shared-hooks');
    mkdirSync(shared);
    writeFileSync(join(shared, 'pre-commit'), '#!/bin/sh\nexit 0\n');
    const globalConfig = join(ws.root, 'global.gitconfig');
    writeFileSync(globalConfig, `[core]\n\thooksPath = ${shared}\n`);
    const env = { GIT_CONFIG_GLOBAL: globalConfig };
    expect((await ogw(ws, ['game', 'init', 'mygame'], { env })).code).toBe(0);
    expect((await ogw(ws, ['game', 'init', 'other'], { env })).code).toBe(0);
    expect(readFileSync(join(shared, 'pre-commit'), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    expect(readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf8')).toBe(hookScript('mygame'));
    const hooksOf = (repo: string) =>
      execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: repo, env: { ...ws.env, ...env }, encoding: 'utf8' }).trim();
    expect(hooksOf(root)).toBe(join(root, '.git', 'hooks'));
    expect(hooksOf(join(ws.games, 'other'))).toBe(join(ws.games, 'other', '.git', 'hooks'));
  });

  it('refuses a bad name, an existing repo, and no release', async () => {
    expect(await ogw(ws, ['game', 'init', 'MyGame'])).toEqual({ code: 1, stdout: '', stderr: 'game name is not kebab-case: MyGame\n' });
    expect((await ogw(ws, ['game', 'init'])).stderr).toBe('usage: ogw game init <game>\n');
    await ogw(ws, ['game', 'init', 'mygame']);
    expect((await ogw(ws, ['game', 'init', 'mygame'])).stderr).toBe(`game repo already exists: ${root}\n`);
    vi.mocked(remoteReleaseVersions).mockResolvedValue([]);
    expect((await ogw(ws, ['game', 'init', 'other'])).stderr).toBe('no core release in wnsrn3436/open-game-works-core-impl\n');
    expect(existsSync(join(ws.games, 'other'))).toBe(false);
  });

  describe('the hook in a real git commit', () => {
    const entry = join(dirname(fileURLToPath(import.meta.url)), 'hook-entry.ts');

    /** Runs `git commit` in `cwd`; returns the exit code and stderr. */
    function commit(cwd: string, message: string): { code: number; stderr: string } {
      const run = spawnSync('git', ['commit', '--quiet', '-m', message], { cwd, env: ws.env, encoding: 'utf8' });
      return { code: run.status ?? -1, stderr: run.stderr };
    }

    function stage(cwd: string, file: string, text: string): void {
      writeFileSync(join(cwd, file), text);
      execFileSync('git', ['add', file], { cwd, env: ws.env });
    }

    const tempWorktrees = () => (existsSync(join(ws.worktrees, 'mygame')) ? readdirSync(join(ws.worktrees, 'mygame')).filter((n) => n.startsWith('check-')) : []);
    const worktreeList = (cwd: string) =>
      sh(cwd, 'git', ['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length));

    beforeEach(async () => {
      await ogw(ws, ['game', 'init', 'mygame']);
      writeFileSync(join(root, 'settings.json'), `${JSON.stringify({ engine: 'godot' })}\n`);
      const hook = join(root, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, `#!/bin/sh\nexec node --disable-warning=ExperimentalWarning '${entry}' 'mygame'\n`);
    });

    const passed = { code: 0, stderr: 'no staged engine resource\n' };

    it('lets commits through in the main checkout and in a worktree, and removes the temporary worktree', { timeout: 180_000 }, () => {
      execFileSync('git', ['add', 'settings.json', '.gitignore'], { cwd: root, env: ws.env });
      stage(root, 'note.txt', 'first\n');
      expect(commit(root, 'first')).toEqual(passed);
      expect(sh(root, 'git', ['log', '--format=%s', 'main']).trim()).toBe('first');
      expect(tempWorktrees()).toEqual([]);

      const wt = join(ws.worktrees, 'mygame', 'w1');
      sh(root, 'git', ['worktree', 'add', '--quiet', '-b', 'feature', wt]);
      stage(wt, 'note.txt', 'second\n');
      expect(commit(wt, 'second')).toEqual(passed);
      expect(sh(root, 'git', ['log', '--format=%s', 'feature']).trim().split('\n')).toEqual(['second', 'first']);
      expect(sh(root, 'git', ['show', 'feature:note.txt'])).toBe('second\n');
      expect(sh(wt, 'git', ['status', '--porcelain'])).toBe('');
      expect(tempWorktrees()).toEqual([]);
      expect(worktreeList(root)).toEqual([root, wt]);
    });

    it('blocks a commit for a static check failure on a staged file', { timeout: 120_000 }, () => {
      execFileSync('git', ['add', 'settings.json', '.gitignore'], { cwd: root, env: ws.env });
      stage(root, 'note.txt', 'first\n');
      stage(root, 'blocked.txt', 'block\n');
      expect(commit(root, 'blocked')).toEqual({ code: 1, stderr: 'no staged engine resource\nblocked.txt:1: blocked\n' });
      expect(() => sh(root, 'git', ['rev-parse', '--verify', '--quiet', 'main'])).toThrow();
      expect(tempWorktrees()).toEqual([]);
      expect(worktreeList(root)).toEqual([root]);
    });

    it('checks a staged deletion: the temporary worktree no longer has the deleted file', { timeout: 180_000 }, () => {
      execFileSync('git', ['add', 'settings.json', '.gitignore'], { cwd: root, env: ws.env });
      stage(root, 'blocked.txt', 'block\n');
      execFileSync('git', ['commit', '--quiet', '--no-verify', '-m', 'first'], { cwd: root, env: ws.env });
      execFileSync('git', ['rm', '--quiet', 'blocked.txt'], { cwd: root, env: ws.env });
      expect(commit(root, 'remove')).toEqual(passed);
      expect(sh(root, 'git', ['log', '--format=%s', 'main']).trim().split('\n')).toEqual(['remove', 'first']);
      expect(tempWorktrees()).toEqual([]);
    });

    it('checks the content of the commit for git commit -a and git commit -- <path>', { timeout: 180_000 }, () => {
      execFileSync('git', ['add', 'settings.json', '.gitignore'], { cwd: root, env: ws.env });
      stage(root, 'note.txt', 'first\n');
      stage(root, 'blocked.txt', 'ok\n');
      expect(commit(root, 'first')).toEqual(passed);

      writeFileSync(join(root, 'blocked.txt'), 'block\n');
      writeFileSync(join(root, 'note.txt'), 'second\n');
      const all = spawnSync('git', ['commit', '--quiet', '-a', '-m', 'all'], { cwd: root, env: ws.env, encoding: 'utf8' });
      expect({ code: all.status, stderr: all.stderr }).toEqual({ code: 1, stderr: 'no staged engine resource\nblocked.txt:1: blocked\n' });
      const only = spawnSync('git', ['commit', '--quiet', '-m', 'only', '--', 'blocked.txt'], { cwd: root, env: ws.env, encoding: 'utf8' });
      expect({ code: only.status, stderr: only.stderr }).toEqual({ code: 1, stderr: 'no staged engine resource\nblocked.txt:1: blocked\n' });
      expect(sh(root, 'git', ['log', '--format=%s', 'main']).trim()).toBe('first');

      const note = spawnSync('git', ['commit', '--quiet', '-m', 'note', '--', 'note.txt'], { cwd: root, env: ws.env, encoding: 'utf8' });
      expect({ code: note.status, stderr: note.stderr }).toEqual(passed);
      expect(sh(root, 'git', ['show', 'main:note.txt'])).toBe('second\n');
      expect(sh(root, 'git', ['show', 'main:blocked.txt'])).toBe('ok\n');
      expect(tempWorktrees()).toEqual([]);
    });

    /** An installed fake Godot of the game's core release: prints its version, and its import writes missing `.uid` files. */
    function fakeGodot(): void {
      const version = '4.5.1.stable';
      const release = join(ws.coreReleases, '1.0.0');
      mkdirSync(join(release, 'client-godot'), { recursive: true });
      writeFileSync(join(release, 'manifest.json'), '{}\n');
      writeFileSync(join(release, 'client-godot.zip'), 'zip');
      writeFileSync(join(release, 'client-godot', 'engine.json'), `${JSON.stringify({ godot: version })}\n`);
      const dir = join(ws.root, '.ogw', 'engines', 'godot', version);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'installed.json'), `${JSON.stringify({ name: 'godot', version, sha256: [], program: 'godot' })}\n`);
      writeFileSync(
        join(dir, 'godot'),
        [
          '#!/bin/sh',
          `if [ "$2" = "--version" ]; then echo "${version}.official"; exit 0; fi`,
          `find "$3" -path "$3/.godot" -prune -o -name '*.gd' -print | while read f; do [ -f "$f.uid" ] || echo "uid $f" > "$f.uid"; done`,
          '',
        ].join('\n'),
      );
      chmodSync(join(dir, 'godot'), 0o755);
      writeFileSync(join(root, 'settings.json'), `${JSON.stringify({ engine: 'godot', coreVersion: '1.0.0' })}\n`);
    }

    const run = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, env: ws.env, encoding: 'utf8' });
      return { code: result.status, stderr: result.stderr };
    };
    const headFiles = () => sh(root, 'git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'client']).trim().split('\n');

    it('commits the meta file of a staged source and keeps the index in line, with git commit, -a and -- <path>', { timeout: 180_000 }, () => {
      fakeGodot();
      execFileSync('git', ['add', 'settings.json', '.gitignore'], { cwd: root, env: ws.env });
      stage(root, 'note.txt', 'first\n');
      expect(commit(root, 'first')).toEqual(passed);

      // Index mode: the hook gets the checkout's index.
      mkdirSync(join(root, 'client'), { recursive: true });
      stage(root, 'client/a.gd', 'a\n');
      expect(run(['commit', '--quiet', '-m', 'a'])).toEqual({ code: 0, stderr: 'staged client/a.gd.uid\n' });
      expect(headFiles()).toEqual(['client/a.gd', 'client/a.gd.uid']);
      expect(sh(root, 'git', ['status', '--porcelain', '--untracked-files=all'])).toBe('');

      // -a: the hook gets the lock of the checkout's index.
      writeFileSync(join(root, 'client', 'a.gd'), 'a2\n');
      rmSync(join(root, 'client', 'a.gd.uid'));
      expect(run(['commit', '--quiet', '-a', '-m', 'all'])).toEqual({ code: 0, stderr: 'staged client/a.gd.uid\n' });
      expect(headFiles()).toEqual(['client/a.gd', 'client/a.gd.uid']);
      expect(sh(root, 'git', ['show', 'HEAD:client/a.gd'])).toBe('a2\n');
      expect(sh(root, 'git', ['status', '--porcelain', '--untracked-files=all'])).toBe('');

      // -- <path>: the hook gets a temporary index; the checkout's index gets the meta file too.
      stage(root, 'client/c.gd', 'c\n');
      stage(root, 'note.txt', 'second\n');
      expect(run(['commit', '--quiet', '-m', 'only', '--', 'client/c.gd'])).toEqual({ code: 0, stderr: 'staged client/c.gd.uid\n' });
      expect(headFiles()).toEqual(['client/a.gd', 'client/a.gd.uid', 'client/c.gd', 'client/c.gd.uid']);
      expect(sh(root, 'git', ['status', '--porcelain', '--untracked-files=all'])).toBe('M  note.txt\n');

      // The next commit without an engine resource keeps the meta file.
      expect(commit(root, 'note')).toEqual(passed);
      expect(headFiles()).toEqual(['client/a.gd', 'client/a.gd.uid', 'client/c.gd', 'client/c.gd.uid']);
      expect(sh(root, 'git', ['status', '--porcelain', '--untracked-files=all'])).toBe('');
      expect(tempWorktrees()).toEqual([]);
    });
  });

  it('removes the repo when a step fails', async () => {
    const run = await ogw(ws, ['game', 'init', 'mygame'], { env: { GIT_AUTHOR_NAME: '', GIT_COMMITTER_NAME: '' } });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('git commit-tree');
    expect(existsSync(root)).toBe(false);
  });
});
