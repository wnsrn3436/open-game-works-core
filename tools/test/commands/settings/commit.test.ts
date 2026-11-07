import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { staticCheckDetail, type StaticCheckDetail } from '../../../src/commands/check/static-api.ts';
import { agentContext, type AgentContext } from '../../../src/lib/agentctx.ts';
import { createContext } from '../../../src/lib/command.ts';
import { changeRuns, listRuns, newRunState, type RunState } from '../../../src/lib/runstate.ts';
import { gitInit, ogw, makeGame, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';

vi.mock('../../../src/commands/check/static-api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/check/static-api.ts')>()),
  staticCheckDetail: vi.fn(),
}));

vi.mock('../../../src/lib/agentctx.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/agentctx.ts')>()),
  agentContext: vi.fn(),
}));

/** A static check result with `failures` at `where`, of which the `absent` ones are absence failures. */
function staticResult(failures: { where: string; message: string; absent?: true }[]): StaticCheckDetail {
  const all = failures.map(({ where, message }) => ({ where, message, evidence: [] }));
  return {
    result: { name: 'static check', platform: null, result: all.length > 0 ? 'fail' : 'pass', failures: all, warnings: [] },
    absent: all.filter((_f, i) => failures[i]?.absent === true),
  };
}

let ws: TestWorkspace;
let root: string;

beforeEach(() => {
  ws = makeWorkspace();
  vi.mocked(agentContext).mockReset().mockResolvedValue(null);
  vi.mocked(staticCheckDetail).mockReset().mockResolvedValue(staticResult([]));
  root = makeGame(ws, 'g', {
    'settings.json': { engine: 'godot', coreVersion: '1.0.0', supportedLanguages: ['en'], gamepadSupported: false },
    'records/loops/update-1/request.md': 'add Korean\n',
    'client/features/play/play.gd': 'class_name Play\n',
    'client/features/play/play.gd.uid': 'uid://play',
  });
  // the hook of the game: its static check refuses the option entry that the new language needs
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, `#!/bin/sh\necho "settings.json:4: option entry: refused" >&2\nexit 1\n`);
  chmodSync(hook, 0o755);
});

function writeSettings(value: object): void {
  writeFileSync(join(root, 'settings.json'), `${JSON.stringify(value, null, 2)}\n`);
}

/** `settings.json:<line>` of the first line of the checkout's settings.json that holds `needle`. */
function settingsWhere(needle: string): string {
  return `settings.json:${String(readFileSync(join(root, 'settings.json'), 'utf8').split('\n').findIndex((l) => l.includes(needle)) + 1)}`;
}

async function openRun(fields: Partial<RunState> = {}): Promise<void> {
  const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
  await changeRuns(await ctx.game('g'), (runs) => {
    runs.push(newRunState({ name: 'update-1', kind: 'loop', command: 'update', branch: 'main', baseCommit: 'x', ...fields }));
  });
}

async function runData(): Promise<Record<string, unknown>> {
  const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
  return (await listRuns(await ctx.game('g')))[0]?.data ?? {};
}

const head = (): string => sh(root, 'git', ['rev-parse', 'HEAD']).trim();

describe('ogw settings commit', () => {
  it('commits only settings.json without the hook, prints the failures the hook would refuse it for, and keeps them for iteration 1', async () => {
    await openRun();
    writeSettings({ engine: 'godot', coreVersion: '1.0.0', supportedLanguages: ['en', 'ko'], gamepadSupported: false });
    writeFileSync(join(root, 'records/loops/update-1/request.md'), 'add Korean\n\n## judge moments\n');
    const languages = settingsWhere('"supportedLanguages"');
    let checked = '';
    vi.mocked(staticCheckDetail).mockImplementationOnce((_c, game) => {
      checked = sh(game.root, 'git', ['log', '-1', '--format=%s']).trim();
      return Promise.resolve(staticResult([
        { where: languages, message: 'option entry: no `UICore.open_language_select` call in client content code' },
        { where: settingsWhere('"gamepadSupported"'), message: 'a failure at a value the commit does not change' },
        { where: 'client/features/play/play.gd:1', message: 'a failure at a file the commit does not change' },
        { where: 'client/features:1', message: 'an absence failure in a folder the commit does not change', absent: true },
      ]));
    });
    const run = await ogw(ws, ['settings', 'commit', 'game', 'g']);
    expect(run).toMatchObject({ code: 0, stdout: `commit: ${head()}\n` });
    expect(sh(root, 'git', ['show', '--name-only', '--format=%s', 'HEAD']).trim().split('\n')).toEqual(['game settings', '', 'settings.json']);
    // the request the lead agent wrote stays for its own commit
    expect(sh(root, 'git', ['status', '--porcelain']).trimEnd().split('\n')).toEqual([' M records/loops/update-1/request.md']);
    // the static check ran after the commit, and only the failure at the value the commit changed is printed
    expect(checked).toBe('game settings');
    const line = `${languages}: option entry: no \`UICore.open_language_select\` call in client content code`;
    expect(run.stderr.split('\n').filter((l) => /^(settings\.json|client\/)/.test(l))).toEqual([line]);
    expect((await runData())['settings commit']).toEqual([line]);
    // a second commit adds its lines; one with no change commits nothing and runs no static check
    writeSettings({ engine: 'godot', coreVersion: '1.0.0', supportedLanguages: ['en', 'ko', 'ja'], gamepadSupported: false });
    vi.mocked(staticCheckDetail).mockResolvedValueOnce(staticResult([{ where: languages, message: 'option entry: again' }]));
    expect((await ogw(ws, ['settings', 'commit', 'game', 'g'])).code).toBe(0);
    expect((await runData())['settings commit']).toEqual([line, `${languages}: option entry: again`]);
    const made = head();
    vi.mocked(staticCheckDetail).mockClear();
    expect(await ogw(ws, ['settings', 'commit', 'game', 'g'])).toMatchObject({ code: 0, stdout: 'settings.json has no change\n' });
    expect(head()).toBe(made);
    expect(staticCheckDetail).not.toHaveBeenCalled();
  });

  it('keeps no line without an open loop run or after iteration 1 started, and stays committed when the static check cannot run', async () => {
    const failure = staticResult([{ where: 'settings.json:1', message: 'game settings owner: ogw game check: titleScene: missing' }]);
    writeSettings({ engine: 'godot', coreVersion: '1.0.0', supportedLanguages: ['en', 'ko'], gamepadSupported: false });
    vi.mocked(staticCheckDetail).mockResolvedValueOnce(failure);
    const onMain = await ogw(ws, ['settings', 'commit', 'game', 'g']);
    expect(onMain.code).toBe(0);
    expect(onMain.stderr).toContain('settings.json:1: game settings owner: ogw game check: titleScene: missing\n');
    expect(await runData()).toEqual({});
    await openRun({ iteration: 1 });
    writeSettings({ engine: 'godot', coreVersion: '1.0.0', supportedLanguages: ['en'], gamepadSupported: false });
    vi.mocked(staticCheckDetail).mockResolvedValueOnce(failure);
    expect((await ogw(ws, ['settings', 'commit', 'game', 'g'])).stderr).toContain('settings.json:1: game settings owner');
    expect(await runData()).toEqual({});
    writeSettings({ engine: 'godot', coreVersion: '1.0.0', supportedLanguages: ['ko'], gamepadSupported: false });
    vi.mocked(staticCheckDetail).mockRejectedValueOnce(new Error('godot 4.5.1.stable is not installed'));
    const unchecked = await ogw(ws, ['settings', 'commit', 'game', 'g']);
    expect(unchecked).toMatchObject({ code: 0, stdout: `commit: ${head()}\n` });
    expect(unchecked.stderr).toContain('static check after the commit could not run: godot 4.5.1.stable is not installed\n');
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('makes the first commit of a game repo that setup game filled, in which every value of settings.json is changed', async () => {
    const dir = join(ws.games, 'fresh');
    gitInit(dir);
    writeFileSync(join(dir, '.gitignore'), '/builds/\n');
    writeFileSync(join(dir, 'settings.json'), `${JSON.stringify({ engine: 'godot', coreVersion: '1.0.0', supportedLanguages: ['en', 'ko'] }, null, 2)}\n`);
    mkdirSync(join(dir, 'records/setup'), { recursive: true });
    writeFileSync(join(dir, 'records/setup/request.md'), 'make a runner\n');
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(dir, '.git', 'hooks', 'pre-commit'), 0o755);
    vi.mocked(staticCheckDetail).mockResolvedValueOnce(staticResult([
      { where: 'settings.json:4', message: 'option entry: no `UICore.open_language_select` call in client content code' },
      { where: 'brief.md:1', message: 'document format: brief.md is missing', absent: true },
    ]));
    const run = await ogw(ws, ['settings', 'commit', 'game', 'fresh']);
    expect(run).toMatchObject({ code: 0, stdout: `commit: ${sh(dir, 'git', ['rev-parse', 'HEAD']).trim()}\n` });
    expect(sh(dir, 'git', ['show', '--name-only', '--format=%s', 'HEAD']).trim().split('\n')).toEqual(['game settings', '', 'settings.json']);
    expect(sh(dir, 'git', ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
    expect(run.stderr.split('\n').filter((l) => /^(settings\.json|brief\.md)/.test(l))).toEqual(['settings.json:4: option entry: no `UICore.open_language_select` call in client content code']);
    expect(sh(dir, 'git', ['status', '--porcelain']).trimEnd().split('\n')).toEqual(['?? .gitignore', '?? records/']);
  });

  it('refuses a role that ogw agent started, and a scope other than game', async () => {
    writeSettings({ engine: 'godot', coreVersion: '1.0.0', supportedLanguages: ['en', 'ko'], gamepadSupported: false });
    const before = head();
    const agent = { job: { id: 'job1' }, meta: { role: 'content', cliPid: null, output: join(ws.root, 'out.md'), runLog: join(ws.root, 'out-runs.json') } };
    vi.mocked(agentContext).mockResolvedValue(agent as unknown as AgentContext);
    expect(await ogw(ws, ['settings', 'commit', 'game', 'g'])).toEqual({
      code: 1,
      stdout: '',
      stderr: 'role content cannot run ogw settings commit, which skips the pre-commit hook; commit settings.json with git\n',
    });
    vi.mocked(agentContext).mockResolvedValue(null);
    expect((await ogw(ws, ['settings', 'commit', 'harness'])).stderr).toBe('usage: ogw settings commit game <game>\n');
    expect((await ogw(ws, ['settings', 'commit', 'core', 'g'])).stderr).toBe('usage: ogw settings commit game <game>\n');
    expect(head()).toBe(before);
    expect(sh(root, 'git', ['status', '--porcelain']).trim()).toBe('M settings.json');
    expect(staticCheckDetail).not.toHaveBeenCalled();
  });
});
