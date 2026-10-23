import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listRuns, withRunLock } from '../../../src/lib/runstate.ts';
import { ogw } from '../../helpers/workspace.ts';
import { addJob, commit, currentRun, git, openBuildRun, openLoopRun, read, setupGame, write } from './helpers.ts';

const mocks = vi.hoisted(() => ({
  gameCheckErrors: vi.fn(),
  listInstances: vi.fn(),
}));

vi.mock('../../../src/commands/settings/api.ts', () => ({ gameCheckErrors: mocks.gameCheckErrors, callerRole: vi.fn() }));
vi.mock('../../../src/commands/instance/api.ts', () => ({
  listInstances: mocks.listInstances,
  startInstance: vi.fn(),
  stopInstance: vi.fn(),
}));

beforeEach(() => {
  mocks.gameCheckErrors.mockReset().mockResolvedValue([]);
  mocks.listInstances.mockReset().mockResolvedValue([]);
});

describe('ogw loop start', () => {
  it('does not start while play or judge uses Claude Code and the agent login token is not stored', async () => {
    const g = setupGame();
    const settingsFile = join(g.ws.harness, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { agents: Record<string, { cli?: string }> };
    for (const stored of [{}, { 'ogw/harness/claude-code-oauth-token': '' }]) {
      writeFileSync(g.ws.env.OGW_TEST_SECRET_FILE as string, JSON.stringify(stored));
      const out = await ogw(g.ws, ['loop', 'start', 'g', '--command', 'update'], { stdin: 'add a boss\n' });
      expect(out.code).toBe(1);
      expect(out.stderr).toBe(
        "harness settings agents play and judge use Claude Code and harness secret claude-code-oauth-token is not in this host's secret store: make a long-lived token with `claude setup-token` and store it on one line, for example on macOS: pbpaste | tr -d '[:space:]' | tools/bin/ogw secret set --harness claude-code-oauth-token\n",
      );
      expect(git(g.root, 'branch', '--list')).toBe('id-registry\n* main');
      expect(await listRuns(g.repo)).toEqual([]);
    }
    // one Claude Code role is enough; none needs no token
    settings.agents.play = { ...settings.agents.play, cli: 'codex' };
    writeFileSync(settingsFile, JSON.stringify(settings));
    expect((await ogw(g.ws, ['loop', 'start', 'g', '--command', 'update'])).stderr).toContain('harness settings agents judge use Claude Code and harness secret');
    settings.agents.judge = { ...settings.agents.judge, cli: 'codex' };
    writeFileSync(settingsFile, JSON.stringify(settings));
    expect((await ogw(g.ws, ['loop', 'start', 'g', '--command', 'update'])).code).toBe(0);
  });

  it('starts an update run: work branch, request.md, run state', async () => {
    const g = setupGame();
    const base = git(g.root, 'rev-parse', 'HEAD');
    const out = await ogw(g.ws, ['loop', 'start', 'g', '--command', 'update', '--json'], { stdin: 'add a boss\n' });
    expect(out.code).toBe(0);
    const data = JSON.parse(out.stdout) as { run: string; branch: string; baseCommit: string };
    expect(data.run).toMatch(/^update-\d+$/);
    expect(data.baseCommit).toBe(base);
    expect(git(g.root, 'branch', '--show-current')).toBe(`loop/${data.run}`);
    expect(read(g.root, `records/loops/${data.run}/request.md`)).toBe('add a boss\n');
    expect(existsSync(join(g.root, 'brief.md'))).toBe(false);
    expect(git(g.root, 'status', '--porcelain')).toBe('');
    expect(git(g.root, 'log', '-1', '--name-only', '--format=')).toBe(`records/loops/${data.run}/request.md`);
    const run = await currentRun(g);
    expect(run).toMatchObject({ name: data.run, kind: 'loop', command: 'update', branch: `loop/${data.run}`, baseCommit: base, iteration: 0, closedAt: null });
    const text = await ogw(g.ws, ['loop', 'status', 'g']);
    expect(text.stdout).toContain(`run: ${data.run}`);
  });

  it('reads the base commit under the run lock, after a main commit that holds the lock', async () => {
    const g = setupGame();
    const started = await withRunLock(g.repo, async () => {
      const start = ogw(g.ws, ['loop', 'start', 'g', '--command', 'update', '--json']);
      await sleep(1000);
      write(g.root, 'records/core-proposals/1-a.md', 'status: released\nversion: 1.2.0\n');
      commit(g.root);
      return { start };
    });
    const moved = git(g.root, 'rev-parse', 'main');
    const out = await started.start;
    expect(out.code).toBe(0);
    expect((JSON.parse(out.stdout) as { baseCommit: string }).baseCommit).toBe(moved);
    expect((await currentRun(g)).baseCommit).toBe(moved);
    expect(git(g.root, 'rev-parse', 'HEAD~1')).toBe(moved);
  });

  it('prints the run name and base commit', async () => {
    const g = setupGame();
    const base = git(g.root, 'rev-parse', 'HEAD');
    const out = await ogw(g.ws, ['loop', 'start', 'g', '--command', 'update']);
    expect(out.stdout).toMatch(new RegExp(`^run: update-\\d+\\nbase commit: ${base}\\n$`));
  });

  it('starts a create run with the setup request and a brief draft', async () => {
    const g = setupGame();
    const out = await ogw(g.ws, ['loop', 'start', 'g', '--command', 'create', '--json'], { stdin: 'make it fast' });
    expect(out.code).toBe(0);
    const { run } = JSON.parse(out.stdout) as { run: string };
    expect(run).toMatch(/^create-/);
    expect(read(g.root, `records/loops/${run}/request.md`)).toBe('make a runner\n\nmake it fast');
    expect(read(g.root, 'brief.md')).toBe(
      [
        '## player fantasy', '', '## emotion', '', '## memorable moment', '', '## genre conventions', '', '## prohibitions', '',
        '## failure penalty', '', '## prediction', '', '## reference game', '', 'Hollow Run', '', 'records/setup/reference/reference.md', '',
        '## request', '', 'make a runner', '', 'make it fast', '',
      ].join('\n'),
    );
    expect(git(g.root, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['brief.md', `records/loops/${run}/request.md`]);
  });

  it('keeps an existing brief.md and adds no line when the setup request lacks a newline', async () => {
    const g = setupGame({}, { 'brief.md': 'mine\n', 'records/setup/request.md': 'no newline' });
    const out = await ogw(g.ws, ['loop', 'start', 'g', '--command', 'create', '--json'], { stdin: 'x' });
    const { run } = JSON.parse(out.stdout) as { run: string };
    expect(read(g.root, 'brief.md')).toBe('mine\n');
    expect(read(g.root, `records/loops/${run}/request.md`)).toBe('no newline\n\nx');
  });

  it('refuses create when setup game is not done', async () => {
    const g = setupGame();
    mocks.gameCheckErrors.mockResolvedValue(['/appId missing']);
    git(g.root, 'branch', '-D', 'id-registry');
    git(g.root, 'rm', '-q', 'records/setup/request.md');
    commit(g.root);
    const out = await ogw(g.ws, ['loop', 'start', 'g', '--command', 'create']);
    expect(out.code).toBe(1);
    expect(out.stderr).toBe('setup game is not done: game settings do not pass ogw game check: /appId missing; branch id-registry; records/setup/request.md\n');
    expect(git(g.root, 'branch', '--show-current')).toBe('main');
    expect(await listRuns(g.repo)).toEqual([]);
    git(g.root, 'rm', '-q', 'records/setup/reference/reference.md');
    commit(g.root);
    expect((await ogw(g.ws, ['loop', 'start', 'g', '--command', 'create'])).stderr).toContain('records/setup/reference/reference.md');
  });

  it('refuses create and update while a gameplay video of reference.md is not on this host', async () => {
    const g = setupGame();
    write(g.root, '.gitignore', '/records/setup/reference/*\n!/records/setup/reference/reference.md\n');
    git(g.root, 'rm', '-q', '--cached', 'records/setup/reference/hollow.mp4');
    commit(g.root);
    rmSync(join(g.root, 'records/setup/reference/hollow.mp4'));
    for (const command of ['create', 'update']) {
      const out = await ogw(g.ws, ['loop', 'start', 'g', '--command', command, '--json'], { stdin: 'x' });
      expect(out.code).toBe(1);
      expect(out.stderr).toBe(
        'records/setup/reference/ lacks the gameplay videos that records/setup/reference/reference.md `## video` names: hollow.mp4. Gameplay videos are not committed: put each file in records/setup/reference/, or fetch it with ogw game reference g <YouTube URL>, which saves <YouTube video id>.mp4\n',
      );
      expect(git(g.root, 'branch', '--list')).toBe('id-registry\n* main');
      expect(await listRuns(g.repo)).toEqual([]);
    }
    // the video on this host is enough, though git does not hold it, and a rolled back start leaves it in place
    write(g.root, 'records/setup/reference/hollow.mp4', 'video');
    write(g.root, '.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n');
    chmodSync(join(g.root, '.git/hooks/pre-commit'), 0o755);
    expect((await ogw(g.ws, ['loop', 'start', 'g', '--command', 'update'], { stdin: 'x' })).code).not.toBe(0);
    expect(read(g.root, 'records/setup/reference/hollow.mp4')).toBe('video');
    rmSync(join(g.root, '.git/hooks/pre-commit'));
    expect((await ogw(g.ws, ['loop', 'start', 'g', '--command', 'update'], { stdin: 'x' })).code).toBe(0);
  });

  it('refuses update without reference.md', async () => {
    const g = setupGame();
    git(g.root, 'rm', '-q', 'records/setup/reference/reference.md');
    commit(g.root);
    const out = await ogw(g.ws, ['loop', 'start', 'g', '--command', 'update']);
    expect(out.code).toBe(1);
    expect(out.stderr).toBe('records/setup/reference/reference.md is missing\n');
    expect(await listRuns(g.repo)).toEqual([]);
  });

  it('refuses create without a game name for every supported language', async () => {
    const g = setupGame({}, { 'settings.json': { coreVersion: '1.0.0', buildPlatforms: ['android', 'web'], loopIterationLimit: 3, supportedLanguages: ['ko', 'en'] } });
    expect((await ogw(g.ws, ['loop', 'start', 'g', '--command', 'create'])).stderr).toContain('setup game is not done: game name of en in records/setup/name.md');
    git(g.root, 'rm', '-q', 'records/setup/name.md');
    commit(g.root);
    expect((await ogw(g.ws, ['loop', 'start', 'g', '--command', 'create'])).stderr).toContain('setup game is not done: records/setup/name.md');
  });

  it('refuses create without the art direction, or with an empty heading in it', async () => {
    const g = setupGame({}, { 'records/setup/art-direction.md': '## style\n\npainted\n\n## palette\n\n## mood\n\nwarm\n' });
    expect((await ogw(g.ws, ['loop', 'start', 'g', '--command', 'create'])).stderr).toContain('setup game is not done: ## palette in records/setup/art-direction.md');
    git(g.root, 'rm', '-q', 'records/setup/art-direction.md');
    commit(g.root);
    expect((await ogw(g.ws, ['loop', 'start', 'g', '--command', 'create'])).stderr).toContain('setup game is not done: records/setup/art-direction.md');
  });

  it('refuses a dirty checkout, an open run, and a bad --command', async () => {
    const g = setupGame();
    write(g.root, 'stray.txt', 'x');
    const dirty = await ogw(g.ws, ['loop', 'start', 'g', '--command', 'update']);
    expect(dirty.code).toBe(1);
    expect(dirty.stderr).toContain('?? stray.txt');
    expect(git(g.root, 'branch', '--list', 'loop/*')).toBe('');
    git(g.root, 'clean', '-fq');
    await openBuildRun(g);
    git(g.root, 'checkout', '-q', 'main');
    const open = await ogw(g.ws, ['loop', 'start', 'g', '--command', 'update']);
    expect(open.stderr).toContain('open run: build-stg-0.2.0');
    expect((await ogw(g.ws, ['loop', 'start', 'g', '--command', 'merge'])).stderr).toContain('usage:');
    expect((await ogw(g.ws, ['loop', 'start', 'g'])).code).toBe(1);
  });

  it('names the open run even when the checkout has changes', async () => {
    const g = setupGame();
    await openLoopRun(g, { name: 'update-7' });
    write(g.root, 'client/edit.gd', 'x');
    const out = await ogw(g.ws, ['loop', 'start', 'g', '--command', 'update', '--json']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('open run: update-7');
    expect(out.stderr).not.toContain('checkout has changes');
    expect(git(g.root, 'status', '--porcelain')).toBe('?? client/');
  });

  it('checks the setup state of main, not of the branch the checkout is on', async () => {
    const g = setupGame();
    git(g.root, 'checkout', '-q', '-b', 'loop/old');
    git(g.root, 'rm', '-q', 'records/setup/request.md');
    commit(g.root);
    const branches: string[] = [];
    mocks.gameCheckErrors.mockImplementation(() => {
      branches.push(git(g.root, 'branch', '--show-current'));
      return Promise.resolve([]);
    });
    const ok = await ogw(g.ws, ['loop', 'start', 'g', '--command', 'create', '--json'], { stdin: 'x' });
    expect(ok.code).toBe(0);
    const { run, branch } = JSON.parse(ok.stdout) as { run: string; branch: string };
    expect(branches).toEqual([branch]);
    expect(read(g.root, `records/loops/${run}/request.md`)).toBe('make a runner\n\nx');

    const h = setupGame();
    git(h.root, 'rm', '-q', 'records/setup/request.md');
    commit(h.root);
    git(h.root, 'checkout', '-q', '-b', 'loop/old', 'main~1');
    const refused = await ogw(h.ws, ['loop', 'start', 'g', '--command', 'create']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('setup game is not done: records/setup/request.md');
    expect(git(h.root, 'branch', '--show-current')).toBe('loop/old');
    expect(git(h.root, 'branch', '--list', 'loop/create-*')).toBe('');
    expect(git(h.root, 'status', '--porcelain')).toBe('');
    expect(await listRuns(h.repo)).toEqual([]);
  });

  it('lets only one of two concurrent starts open a run, and keeps its branch and commit', async () => {
    const g = setupGame();
    const outs = await Promise.all([
      ogw(g.ws, ['loop', 'start', 'g', '--command', 'update', '--json'], { stdin: 'a' }),
      ogw(g.ws, ['loop', 'start', 'g', '--command', 'update', '--json'], { stdin: 'b' }),
    ]);
    const ok = outs.filter((o) => o.code === 0);
    expect(ok).toHaveLength(1);
    // The second start fails at the open-run check, or at the clean-checkout check when the first already wrote its files.
    expect(outs.find((o) => o.code !== 0)?.stderr).toMatch(/has an open run: update-\d+|game repo checkout has changes/);
    const { run, branch } = JSON.parse(ok[0]?.stdout ?? '') as { run: string; branch: string };
    expect((await listRuns(g.repo)).map((r) => r.name)).toEqual([run]);
    expect(git(g.root, 'branch', '--show-current')).toBe(branch);
    expect(git(g.root, 'branch', '--list', 'loop/*')).toBe(`* ${branch}`);
    expect(git(g.root, 'log', '-1', '--name-only', '--format=', branch)).toBe(`records/loops/${run}/request.md`);
    expect(git(g.root, 'status', '--porcelain')).toBe('');
  });

  it('drops the run when the work branch cannot be made', async () => {
    const g = setupGame();
    git(g.root, 'branch', 'loop/update-1000');
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const out = await ogw(g.ws, ['loop', 'start', 'g', '--command', 'update']);
      expect(out.code).not.toBe(0);
      expect(out.stderr).toContain('loop/update-1000');
    } finally {
      now.mockRestore();
    }
    expect(git(g.root, 'branch', '--show-current')).toBe('main');
    expect(git(g.root, 'branch', '--list', 'loop/*')).toBe('loop/update-1000');
    expect(await listRuns(g.repo)).toEqual([]);
  });

  it('rolls back the branch, files and run state when the commit fails', async () => {
    const g = setupGame();
    write(g.root, '.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n');
    chmodSync(join(g.root, '.git/hooks/pre-commit'), 0o755);
    const out = await ogw(g.ws, ['loop', 'start', 'g', '--command', 'create'], { stdin: 'x' });
    expect(out.code).not.toBe(0);
    expect(git(g.root, 'branch', '--show-current')).toBe('main');
    expect(git(g.root, 'branch', '--list', 'loop/*')).toBe('');
    expect(git(g.root, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(g.root, 'brief.md'))).toBe(false);
    expect(existsSync(join(g.root, 'records/loops'))).toBe(false);
    expect(await listRuns(g.repo)).toEqual([]);
  });

  it('rolls back the branch when the run state cannot be written', async () => {
    const g = setupGame();
    write(g.root, '.git/ogw-runs.json', 'not json');
    const out = await ogw(g.ws, ['loop', 'start', 'g', '--command', 'update']);
    expect(out.code).not.toBe(0);
    expect(git(g.root, 'branch', '--show-current')).toBe('main');
    expect(git(g.root, 'branch', '--list', 'loop/*')).toBe('');
    expect(git(g.root, 'status', '--porcelain')).toBe('');
  });
});

describe('ogw loop next', () => {
  it('starts iterations and sets the reference commit at iteration 1', async () => {
    const g = setupGame();
    await openLoopRun(g);
    write(g.root, 'x.txt', 'x');
    const head = commit(g.root);
    const out = await ogw(g.ws, ['loop', 'next', 'g']);
    expect(out).toMatchObject({ code: 0, stdout: 'iteration 1\n' });
    expect(await currentRun(g)).toMatchObject({ iteration: 1, referenceCommit: head });
    write(g.root, 'y.txt', 'y');
    commit(g.root);
    expect((await ogw(g.ws, ['loop', 'next', 'g'])).stdout).toBe('iteration 2\n');
    expect(await currentRun(g)).toMatchObject({ iteration: 2, referenceCommit: head });
  });

  it('stops at loopIterationLimit for a loop run only', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 3 });
    const out = await ogw(g.ws, ['loop', 'next', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('iteration 3 reached game settings loopIterationLimit 3');
    expect((await currentRun(g)).iteration).toBe(3);
    const b = setupGame();
    await openBuildRun(b, { iteration: 7, referenceCommit: 'ref' });
    expect((await ogw(b.ws, ['loop', 'next', 'g'])).stdout).toBe('iteration 8\n');
    expect(await currentRun(b)).toMatchObject({ iteration: 8, referenceCommit: 'ref' });
  });

  it('never goes above loopIterationLimit when two run at once', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 2 });
    const outs = await Promise.all([ogw(g.ws, ['loop', 'next', 'g']), ogw(g.ws, ['loop', 'next', 'g'])]);
    expect(outs.map((o) => o.code).sort()).toEqual([0, 1]);
    expect(outs.find((o) => o.code === 1)?.stderr).toContain('iteration 3 reached game settings loopIterationLimit 3');
    expect((await currentRun(g)).iteration).toBe(3);
  });

  it('sets the reference commit once when two start iteration 1 at once', async () => {
    const g = setupGame();
    await openLoopRun(g);
    const head = git(g.root, 'rev-parse', 'HEAD');
    const outs = await Promise.all([ogw(g.ws, ['loop', 'next', 'g']), ogw(g.ws, ['loop', 'next', 'g'])]);
    expect(outs.map((o) => o.stdout).sort()).toEqual(['iteration 1\n', 'iteration 2\n']);
    expect(await currentRun(g)).toMatchObject({ iteration: 2, referenceCommit: head });
  });

  it('uses the schema default limit and refuses with useLocalCore', async () => {
    const g = setupGame({}, { 'settings.json': { coreVersion: '1.0.0', buildPlatforms: ['android'] } });
    await openLoopRun(g, { iteration: 19 });
    expect((await ogw(g.ws, ['loop', 'next', 'g'])).stdout).toBe('iteration 20\n');
    expect((await ogw(g.ws, ['loop', 'next', 'g'])).code).toBe(1);
    const local = setupGame({ useLocalCore: true });
    await openLoopRun(local);
    const out = await ogw(local.ws, ['loop', 'next', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('useLocalCore is true');
    expect((await currentRun(local)).iteration).toBe(0);
  });
});

describe('ogw loop status', () => {
  it('prints none without an open run', async () => {
    const g = setupGame();
    expect(await ogw(g.ws, ['loop', 'status', 'g'])).toMatchObject({ code: 0, stdout: 'none\n' });
  });

  it('lists the run, its jobs, instances, tasks and given-up work', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 2, startedAt: 5 });
    // String order and number order differ for 2 and 10.
    write(g.root, 'records/loops/update-1/iteration-2.md', '## commit\n');
    write(g.root, 'records/loops/update-1/iteration-10.md', '## commit\n');
    write(g.root, 'records/loops/update-1/iteration-11.md', '## commit\n');
    git(g.root, 'add', 'records/loops/update-1/iteration-2.md', 'records/loops/update-1/iteration-10.md');
    git(g.root, 'commit', '-q', '-m', 'records');
    // The records are read from the run branch, whatever the checkout is on; an uncommitted record does not count.
    git(g.root, 'checkout', '-q', 'main');
    await addJob(g.ws, { id: 'old0', startedAt: 1, meta: { role: 'content' } });
    const content = await addJob(g.ws, { meta: { role: 'content' }, status: 'done' });
    const res = await addJob(g.ws, { meta: { role: 'resource', merged: true }, status: 'done' });
    const tr = await addJob(g.ws, { meta: { role: 'translation' }, status: 'failed' });
    const check = await addJob(g.ws, { command: 'check' });
    await addJob(g.ws, { game: 'other', meta: { role: 'content' } });
    const { setRun } = await import('./helpers.ts');
    await setRun(g, (run) => {
      run.data.loop = {
        tasks: [{ role: 'translation', input: '/in/t.md', jobs: [tr.id], retries: 2, gaveUp: true, lastFailure: 'boom' }],
        handled: [],
        merges: [{ job: tr.id, role: 'translation', before: 'a', after: 'b' }],
        verdict: null,
        prepareMerge: null,
      };
    });
    mocks.listInstances.mockResolvedValue([
      { id: 'i-old', startedAt: 1 },
      { id: 'i-new', startedAt: 6 },
    ]);
    const out = await ogw(g.ws, ['loop', 'status', 'g']);
    expect(out.stdout).toBe(
      [
        'run: update-1',
        'kind: loop',
        'iteration: 2',
        `base commit: ${(await currentRun(g)).baseCommit}`,
        'last iteration record: records/loops/update-1/iteration-10.md',
        `job ${content.id} content done not merged`,
        `job ${res.id} resource done merged`,
        `job ${tr.id} translation failed merged`,
        `job ${check.id} check running`,
        'instance i-new',
        'task translation /in/t.md given again 2',
        'not given again /in/t.md: boom',
        '',
      ].join('\n'),
    );
    expect(mocks.listInstances).toHaveBeenCalledWith(expect.anything(), { game: 'g' });
    const json = JSON.parse((await ogw(g.ws, ['loop', 'status', 'g', '--json'])).stdout) as { jobs: { merged: boolean | null }[]; lastRecord: string };
    expect(json.jobs.map((j) => j.merged)).toEqual([false, true, true, null]);
  });

  it('shows none for the last record before any', async () => {
    const g = setupGame();
    await openLoopRun(g);
    expect((await ogw(g.ws, ['loop', 'status', 'g'])).stdout).toContain('last iteration record: none\n');
  });
});

describe('loop commands without an open run', () => {
  it('fail and change nothing', async () => {
    const g = setupGame();
    for (const argv of [
      ['next', 'g'], ['input', 'g', 'content'], ['dispatch', 'g'], ['sync', 'g'], ['evaluate', 'g'], ['findings', 'g'], ['record', 'g'],
      ['baseline', 'g'], ['verdict', 'g'], ['end-record', 'g'], ['merge', 'g'], ['resume', 'g'], ['end', 'g'], ['prepare-merge', 'g'],
    ]) {
      const out = await ogw(g.ws, ['loop', ...argv]);
      expect(out.code, argv.join(' ')).toBe(1);
      expect(out.stderr, argv.join(' ')).toContain('no open run for game g');
    }
    expect(await listRuns(g.repo)).toEqual([]);
  });

  it('loop-only commands refuse a build run', async () => {
    const g = setupGame();
    await openBuildRun(g);
    for (const argv of [['verdict', 'g'], ['end-record', 'g'], ['merge', 'g'], ['prepare-merge', 'g']]) {
      const out = await ogw(g.ws, ['loop', ...argv]);
      expect(out.code).toBe(1);
      expect(out.stderr).toContain('runs only in a loop run');
    }
  });
});
