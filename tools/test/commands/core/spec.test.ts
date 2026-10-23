import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFromHarness } from '../../../src/commands/core/lib/spec-build.ts';
import { withLock } from '../../../src/lib/lock.ts';
import { ogw, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { BASIC_CLIENT, BASIC_SERVER, spec, writeSpecHarness } from './lib/spec-fixture.ts';

const workspaces: TestWorkspace[] = [];
function workspace(): TestWorkspace {
  const ws = makeWorkspace();
  workspaces.push(ws);
  writeSpecHarness(BASIC_CLIENT, BASIC_SERVER, ws.harness);
  return ws;
}
afterEach(() => {
  for (const ws of workspaces.splice(0)) rmSync(ws.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const NAMES = ['AlphaCore', 'BetaCore', 'DeltaCore', 'LogCore', 'QaCore', 'gamma', 'storage'];

describe('ogw core spec', () => {
  it('writes one JSON file per module and deletes files of other names', async () => {
    const ws = workspace();
    const dir = join(ws.coreImpl, 'core-spec');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'Old.json'), '{}\n');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const run = await ogw(ws, ['core', 'spec']);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(
      `${[...['LogCore', 'AlphaCore', 'BetaCore', 'DeltaCore', 'QaCore', 'gamma', 'storage'].map((n) => `wrote core-spec/${n}.json`), 'deleted core-spec/Old.json', 'deleted core-spec/notes.txt'].join('\n')}\n`,
    );
    expect(readdirSync(dir).sort()).toEqual([...NAMES.map((n) => `${n}.json`), 'sub'].sort());
    const built = await buildFromHarness(ws.harness);
    expect(readFileSync(join(dir, 'AlphaCore.json'), 'utf8')).toBe(`${JSON.stringify(built.modules.get('AlphaCore'), null, 2)}\n`);
  });

  it('writes only files whose bytes differ', async () => {
    const ws = workspace();
    expect((await ogw(ws, ['core', 'spec'])).code).toBe(0);
    const file = join(ws.coreImpl, 'core-spec', 'BetaCore.json');
    const before = statSync(file).mtimeMs;
    writeFileSync(join(ws.coreImpl, 'core-spec', 'LogCore.json'), '{}\n');
    const run = await ogw(ws, ['core', 'spec', '--json']);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, modules: 7, written: ['LogCore.json'], deleted: [], errors: [] });
    expect(statSync(file).mtimeMs).toBe(before);
    expect((await ogw(ws, ['core', 'spec'])).stdout).toBe('core-spec is up to date\n');
  });

  it('writes nothing and lists every violation when the form is broken', async () => {
    const ws = workspace();
    writeSpecHarness([...BASIC_CLIENT, { name: 'EpsCore', file: 'eps-core', body: spec('EpsCore', { dependency: '`Nope`', data: 'used table: `none_such`' }) }], BASIC_SERVER, ws.harness);
    const expected = [
      'skills/client-core/modules/eps-core.md:9: dependency line names `Nope`, which is not a module',
      'skills/client-core/modules/eps-core.md:37: table `none_such` has no table definition in any module',
    ];
    const run = await ogw(ws, ['core', 'spec']);
    expect(run).toMatchObject({ code: 1, stdout: `${expected.join('\n')}\n` });
    expect(existsSync(join(ws.coreImpl, 'core-spec'))).toBe(false);
    const json = await ogw(ws, ['core', 'spec', '--json']);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({ ok: false, errors: expected });
  });

  it('writes into the core worktree the command runs in', async () => {
    const ws = workspace();
    const tree = join(ws.worktrees, '_core', 'w1');
    sh(ws.coreImpl, 'git', ['worktree', 'add', '--quiet', '-b', 'agent/w1', tree]);
    const run = await ogw(ws, ['core', 'spec'], { cwd: tree });
    expect(run.code).toBe(0);
    expect(readdirSync(join(tree, 'core-spec')).sort()).toEqual(NAMES.map((n) => `${n}.json`).sort());
    expect(existsSync(join(ws.coreImpl, 'core-spec'))).toBe(false);
  });

  it('commits on main every generated file that differs from HEAD, and nothing else', async () => {
    const ws = workspace();
    const git = (...args: string[]): string => sh(ws.coreImpl, 'git', args).trim();
    writeFileSync(join(ws.coreImpl, 'scratch.txt'), 'not generated');
    writeFileSync(join(ws.coreImpl, 'README'), 'tracked\n');
    sh(ws.coreImpl, 'git', ['add', 'README']);
    sh(ws.coreImpl, 'git', ['commit', '-qm', 'readme']);
    writeFileSync(join(ws.coreImpl, 'README'), 'changed by someone else\n');
    // a generated file left untracked by an earlier run that did not commit
    mkdirSync(join(ws.coreImpl, 'server', 'generated', 'data'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'generated', 'data', 'game_data.ts'), 'left\n');
    const before = git('rev-parse', 'HEAD');
    expect((await ogw(ws, ['core', 'spec'])).code).toBe(0);
    expect(git('log', '-1', '--format=%s')).toBe('ogw: regenerate generated files');
    expect(git('diff', '--name-only', before, 'HEAD').split('\n')).toEqual([...NAMES.map((n) => `core-spec/${n}.json`), 'server/generated/data/game_data.ts'].sort());
    expect(git('status', '--porcelain')).toBe('M README\n?? scratch.txt');
    sh(ws.coreImpl, 'git', ['checkout', '-q', 'README']);
    sh(ws.coreImpl, 'git', ['checkout', '-q', '-b', 'other']);
    rmSync(join(ws.coreImpl, 'core-spec', 'gamma.json'));
    sh(ws.coreImpl, 'git', ['commit', '-qam', 'drop gamma']);
    const head = git('rev-parse', 'HEAD');
    expect((await ogw(ws, ['core', 'spec'])).code).toBe(0);
    // not on main: the file is written and left for whoever owns the branch
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('status', '--porcelain')).toBe('?? core-spec/gamma.json\n?? scratch.txt');
  });

  it('writes core-spec/ one run at a time, and reports only files it removed', async () => {
    const ws = workspace();
    const dir = join(ws.coreImpl, 'core-spec');
    const lock = join(sh(ws.coreImpl, 'git', ['rev-parse', '--absolute-git-dir']).trim(), 'ogw-core-spec.lock');
    let release: () => void = () => undefined;
    let held: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    const holder = withLock(lock, () => {
      held();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await holding;
    let done = false;
    const running = ogw(ws, ['core', 'spec']).then((run) => {
      done = true;
      return run;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(done).toBe(false);
    expect(existsSync(dir)).toBe(false);
    release();
    await holder;
    expect((await running).code).toBe(0);
    for (let round = 0; round < 10; round += 1) {
      for (const name of readdirSync(dir)) writeFileSync(join(dir, name), '{}\n');
      writeFileSync(join(dir, 'Old.json'), '{}\n');
      const runs = await Promise.all([1, 2, 3].map(() => ogw(ws, ['core', 'spec', '--json'])));
      expect(runs.map((r) => r.code)).toEqual([0, 0, 0]);
      const deleted = runs.flatMap((r) => (JSON.parse(r.stdout) as { deleted: string[] }).deleted);
      expect(deleted).toEqual(['Old.json']);
    }
  });

  it('fails without open-game-works-core-impl and on extra arguments', async () => {
    const ws = workspace();
    expect((await ogw(ws, ['core', 'spec', 'x'])).stderr).toBe('usage: ogw core spec\n');
    rmSync(ws.coreImpl, { recursive: true, force: true });
    const run = await ogw(ws, ['core', 'spec']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe(`core implementation folder not found: ${ws.coreImpl}\n`);
  });
});
