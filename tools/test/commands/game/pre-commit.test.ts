import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaticCheckDetail } from '../../../src/commands/check/static-api.ts';
import { blockingFailures, folderHolds, hookEnvs, pointsAt, REPO_VARS, runPreCommit, settingsChange, type PreCommitDeps } from '../../../src/commands/game/lib/pre-commit.ts';
import type { CliIo } from '../../../src/lib/cli.ts';
import type { Context } from '../../../src/lib/command.ts';
import { commitAll, makeGame, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';

let ws: TestWorkspace;
let root: string;
let logs: string[];
let io: CliIo;

beforeEach(() => {
  ws = makeWorkspace();
  root = makeGame(ws, 'mygame', { 'settings.json': {} });
  logs = [];
  io = { cwd: root, env: ws.env, stdin: () => Promise.resolve(''), stdout: (t) => logs.push(`out:${t}`), stderr: (t) => logs.push(t) };
});

function writeSettings(value: object): void {
  writeFileSync(join(root, 'settings.json'), `${JSON.stringify(value, null, 2)}\n`);
}

/** `settings.json:<line>` of the first line of the checkout's settings.json that holds `needle`. */
function settingsWhere(needle: string): string {
  return `settings.json:${String(readFileSync(join(root, 'settings.json'), 'utf8').split('\n').findIndex((l) => l.includes(needle)) + 1)}`;
}

function stage(path: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), 'x\n');
  sh(root, 'git', ['add', path]);
}

function result(wheres: string[], absentWheres: string[] = []): StaticCheckDetail {
  const failures = wheres.map((where) => ({ where, message: `bad ${where}`, evidence: [] }));
  return {
    result: { name: 'static', platform: null, result: 'fail', failures, warnings: [] },
    absent: failures.filter((f) => absentWheres.includes(f.where)),
  };
}

const deps = (detail: StaticCheckDetail): PreCommitDeps => ({ ogw: () => Promise.resolve(0), staticCheck: () => Promise.resolve(detail) });

describe('runPreCommit', () => {
  it('blocks failures that point at staged files', async () => {
    stage('client/a.gd');
    stage('server/b.ts');
    const calls: string[][] = [];
    const staticCheck = vi.fn<(ctx: Context, game: { root: string }) => Promise<StaticCheckDetail>>(() =>
      Promise.resolve(result(['client/a.gd:3', 'server/b.ts', 'data/c.csv', 'client/a.gdx'])),
    );
    const code = await runPreCommit(io, 'mygame', {
      ogw: (argv) => {
        calls.push(argv);
        return Promise.resolve(0);
      },
      staticCheck,
    });
    expect(code).toBe(1);
    expect(calls).toEqual([['meta', 'sync', 'mygame', '--staged']]);
    expect(staticCheck.mock.calls[0]?.[1].root).toBe(root);
    expect(logs).toEqual(['client/a.gd:3: bad client/a.gd:3\n', 'server/b.ts: bad server/b.ts\n']);
  });

  it('lets the commit go when no failure points at a staged file', async () => {
    stage('client/a.gd');
    expect(await runPreCommit(io, 'mygame', deps(result(['data/c.csv'])))).toBe(0);
    expect(logs).toEqual([]);
  });

  it('blocks an absence failure only when its where is a staged file or a folder holding a staged file', async () => {
    stage('client/dev/bot/steps/a.json');
    stage('settings.json');
    const wheres = ['client/dev/bot:1', 'settings.json:4', 'client/core/ui_core:1', 'data:1', 'client/dev/bo:1'];
    const detail = result(wheres, wheres);
    expect(await runPreCommit(io, 'mygame', deps(detail))).toBe(1);
    expect(logs).toEqual(['client/dev/bot:1: bad client/dev/bot:1\n', 'settings.json:4: bad settings.json:4\n']);
  });

  it('lets the first commit of a game go through absence failures in folders it does not touch', async () => {
    stage('brief.md');
    const detail = result(['client/dev/bot:1', 'client/core/ui_core:1'], ['client/dev/bot:1', 'client/core/ui_core:1']);
    expect(await runPreCommit(io, 'mygame', deps(detail))).toBe(0);
    expect(logs).toEqual([]);
  });

  it('does not block a folder where that is not an absence failure', async () => {
    stage('client/dev/bot/a.json');
    expect(await runPreCommit(io, 'mygame', deps(result(['client/dev/bot:1'])))).toBe(0);
  });

  it('runs meta sync and the staged read of the static check with the index of the commit, the rest without the repo variables', async () => {
    stage('client/a.gd');
    const hookEnv = { ...ws.env, GIT_INDEX_FILE: '.git/index', GIT_DIR: '.git', GIT_PREFIX: '', GIT_WORK_TREE: root };
    const seen: { meta?: NodeJS.ProcessEnv; check?: NodeJS.ProcessEnv; staged?: NodeJS.ProcessEnv } = {};
    const code = await runPreCommit({ ...io, env: hookEnv }, 'mygame', {
      ogw: (_argv, metaIo) => {
        seen.meta = metaIo.env;
        return Promise.resolve(0);
      },
      staticCheck: (ctx, _game, options) => {
        seen.check = ctx.env;
        seen.staged = options.stagedEnv;
        return Promise.resolve(result(['client/a.gd:1']));
      },
    });
    expect(code).toBe(1);
    for (const env of [seen.meta, seen.staged]) {
      expect(env?.GIT_INDEX_FILE).toBe(join(root, '.git', 'index'));
      for (const key of ['GIT_DIR', 'GIT_PREFIX', 'GIT_WORK_TREE']) expect(env?.[key]).toBeUndefined();
    }
    for (const key of REPO_VARS) expect(seen.check?.[key]).toBeUndefined();
    expect(seen.check?.OGW_HARNESS_ROOT).toBe(ws.env.OGW_HARNESS_ROOT);
  });

  it('blocks a failure at a line of settings.json only when the commit changes the value that starts on that line', async () => {
    const settings = { engine: 'godot', supportedLanguages: ['en'], uiCheckScreens: [{ name: 'phone' }] };
    writeSettings(settings);
    commitAll(root, 'settings');
    // the lead agent fills a value: the option entry that the languages require is not made by this commit
    writeSettings({ ...settings, supportedLanguages: ['en', 'ko'] });
    commitAll(root, 'second language, committed without the hook');
    writeSettings({ ...settings, supportedLanguages: ['en', 'ko'], uiCheckScreens: [{ name: 'phone', pixelRatio: 2 }] });
    sh(root, 'git', ['add', 'settings.json']);
    const languages = settingsWhere('"supportedLanguages"');
    const ratio = settingsWhere('"pixelRatio"');
    expect(await runPreCommit(io, 'mygame', deps(result([languages, ratio, 'settings.json:1'])))).toBe(1);
    expect(logs).toEqual([`${ratio}: bad ${ratio}\n`, 'settings.json:1: bad settings.json:1\n']);
    commitAll(root, 'ratio');
    // a commit that adds a language makes the failure at supportedLanguages, though its key line stays as it was
    logs.length = 0;
    writeSettings({ ...settings, supportedLanguages: ['en', 'ko', 'ja'], uiCheckScreens: [{ name: 'phone', pixelRatio: 2 }] });
    sh(root, 'git', ['add', 'settings.json']);
    expect(await runPreCommit(io, 'mygame', deps(result([settingsWhere('"supportedLanguages"'), settingsWhere('"pixelRatio"')])))).toBe(1);
    expect(logs).toEqual([`${settingsWhere('"supportedLanguages"')}: bad ${settingsWhere('"supportedLanguages"')}\n`]);
    // the commit is what is staged: a language added in the checkout and not staged makes nothing
    sh(root, 'git', ['reset', '--quiet', 'settings.json']);
    writeSettings({ ...settings, supportedLanguages: ['en', 'ko'], uiCheckScreens: [{ name: 'phone', pixelRatio: 3 }] });
    sh(root, 'git', ['add', 'settings.json']);
    writeSettings({ ...settings, supportedLanguages: ['en', 'ko', 'ja'], uiCheckScreens: [{ name: 'phone', pixelRatio: 3 }] });
    logs.length = 0;
    expect(await runPreCommit(io, 'mygame', deps(result([settingsWhere('"supportedLanguages"')])))).toBe(0);
    // a commit that does not stage settings.json makes no failure there
    sh(root, 'git', ['reset', '--quiet', 'settings.json']);
    stage('client/a.gd');
    expect(await runPreCommit(io, 'mygame', deps(result([settingsWhere('"supportedLanguages"'), 'settings.json:1'])))).toBe(0);
    expect(logs).toEqual([]);
  });

  it('stops when meta sync fails', async () => {
    const staticCheck = vi.fn();
    const code = await runPreCommit(io, 'mygame', { ogw: () => Promise.resolve(3), staticCheck });
    expect(code).toBe(3);
    expect(staticCheck).not.toHaveBeenCalled();
    expect(logs).toEqual(['ogw meta sync mygame --staged failed\n']);
  });
});

describe('settingsChange', () => {
  const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
  const text = (value: unknown): string => JSON.stringify(value, null, 2);
  const lineOf = (body: string, needle: string): number => body.split('\n').findIndex((l) => l.includes(needle)) + 1;
  const before = { engine: 'godot', supportedLanguages: ['en', 'ko'], uiCheckScreens: [{ name: 'phone', pixelRatio: 1 }] };

  it('says that a line changed when the outermost value that starts on it changed, line 1 being the whole file', () => {
    const after = { ...before, uiCheckScreens: [{ name: 'phone', pixelRatio: 2 }] };
    const body = text(after);
    const change = settingsChange(body, bytes(before), bytes(after));
    expect([1, lineOf(body, '"engine"'), lineOf(body, '"supportedLanguages"'), lineOf(body, '"uiCheckScreens"'), lineOf(body, '"name"'), lineOf(body, '"pixelRatio"')].map(change)).toEqual([
      true, false, false, true, false, true,
    ]);
    // a closing line starts no value: it is judged as the whole file
    expect(change(lineOf(body, ']'))).toBe(true);
    expect(settingsChange(body, bytes(after), bytes(after))(1)).toBe(false);
  });

  it('counts a value on one side only, a file absent from HEAD, and a file that does not parse as changed', () => {
    const after = { ...before, consent: { privacyChoices: true } };
    const body = text(after);
    const change = settingsChange(body, bytes(before), bytes(after));
    expect([lineOf(body, '"consent"'), lineOf(body, '"privacyChoices"'), lineOf(body, '"engine"')].map(change)).toEqual([true, true, false]);
    expect(settingsChange(text(before), bytes(after), bytes(before))(lineOf(text(before), '"engine"'))).toBe(false);
    expect(settingsChange(body, null, bytes(after))(lineOf(body, '"engine"'))).toBe(true);
    expect(settingsChange(body, Buffer.from('{'), bytes(after))(lineOf(body, '"engine"'))).toBe(true);
    expect(settingsChange('{', bytes(before), bytes(after))(2)).toBe(true);
    expect(settingsChange(null, bytes(before), bytes(after))(2)).toBe(true);
  });
});

describe('blockingFailures', () => {
  it('judges a failure at a line of settings.json by the change, and one without a line as the whole file', () => {
    const detail = result(['settings.json:4', 'settings.json:5:2', 'settings.json', 'client/a.gd:1']);
    const changed = (line: number): boolean => line === 5;
    expect(blockingFailures(detail, ['settings.json', 'client/a.gd'], changed).map((f) => f.where)).toEqual(['settings.json:5:2', 'settings.json', 'client/a.gd:1']);
    expect(blockingFailures(detail, ['client/a.gd'], () => true).map((f) => f.where)).toEqual(['client/a.gd:1']);
  });
});

describe('hookEnvs', () => {
  it('makes the index absolute for the checkout and removes every repo variable from the clean env', () => {
    const env = Object.fromEntries([...REPO_VARS.map((key) => [key, `v-${key}`]), ['PATH', '/bin']]) as NodeJS.ProcessEnv;
    const { checkout, clean } = hookEnvs('/repo', env);
    expect(clean).toEqual({ PATH: '/bin' });
    expect(checkout).toEqual({ PATH: '/bin', GIT_INDEX_FILE: '/repo/v-GIT_INDEX_FILE' });
    expect(hookEnvs('/repo', { GIT_INDEX_FILE: '/abs/index' }).checkout).toEqual({ GIT_INDEX_FILE: '/abs/index' });
    expect(hookEnvs('/repo', { GIT_INDEX_FILE: '' }).checkout).toEqual({});
    expect(hookEnvs('/repo', { PATH: '/bin' })).toEqual({ checkout: { PATH: '/bin' }, clean: { PATH: '/bin' } });
    expect(env.GIT_DIR).toBe('v-GIT_DIR');
  });
});

describe('pointsAt', () => {
  it('matches a file or a file with a position', () => {
    expect(pointsAt('a/b.ts', ['a/b.ts'])).toBe(true);
    expect(pointsAt('a/b.ts:10:2', ['a/b.ts'])).toBe(true);
    expect(pointsAt('a/b.tsx', ['a/b.ts'])).toBe(false);
    expect(pointsAt('a', ['a/b.ts'])).toBe(false);
    expect(pointsAt('a/b.ts', [])).toBe(false);
  });
});

describe('folderHolds', () => {
  it('matches `<folder>:1` holding a file in it or below it', () => {
    expect(folderHolds('a:1', ['a/b.ts'])).toBe(true);
    expect(folderHolds('a:1', ['a/c/b.ts'])).toBe(true);
    expect(folderHolds('a/c:1', ['a/b.ts'])).toBe(false);
    expect(folderHolds('a:1', ['ab/b.ts'])).toBe(false);
    expect(folderHolds('a:2', ['a/b.ts'])).toBe(false);
    expect(folderHolds('a', ['a/b.ts'])).toBe(false);
    expect(folderHolds('.:1', ['b.ts'])).toBe(true);
    expect(folderHolds('.:1', [])).toBe(false);
    expect(folderHolds('a:1', [])).toBe(false);
  });
});
