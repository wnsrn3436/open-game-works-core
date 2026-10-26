import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listInstances } from '../../../src/commands/instance/api.ts';
import { listRecords, readRecord } from '../../../src/commands/instance/lib/records.ts';
import { createContext } from '../../../src/lib/command.ts';
import { ogw, commitAll, sh } from '../../helpers/workspace.ts';
import { mockState } from './mocks/state.ts';
import { MATCH_MODE_HEADER, setupRunner, startFor, stopAll, type Runner } from './runner.ts';

vi.mock('../../../src/commands/generate/api.ts', async () => (await import('./mocks/apis.ts')).generate);
vi.mock('../../../src/commands/data/api.ts', async () => (await import('./mocks/apis.ts')).data);
vi.mock('../../../src/commands/core/api.ts', async () => (await import('./mocks/apis.ts')).core);
vi.mock('../../../src/commands/env/api.ts', async () => (await import('./mocks/apis.ts')).env);
vi.mock('../../../src/commands/instance/lib/spawn.ts', () => import('./mocks/spawn.ts'));
vi.mock('../../../src/commands/instance/lib/launch.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/commands/instance/lib/launch.ts')>();
  return { ...real, ...(await import('./mocks/apis.ts')).launchOverrides(real) };
});

/** Runs around the `git worktree add` of a `commit` start; reset after each test. */
const worktreeHooks = vi.hoisted(() => ({ before: null as (() => Promise<void>) | null, after: null as (() => Promise<void>) | null }));

vi.mock('../../../src/lib/git.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/lib/git.ts')>();
  return {
    ...real,
    worktreeAdd: async (...args: Parameters<typeof real.worktreeAdd>) => {
      await worktreeHooks.before?.();
      await real.worktreeAdd(...args);
      await worktreeHooks.after?.();
    },
  };
});

let runner: Runner | null = null;

afterEach(async () => {
  worktreeHooks.before = null;
  worktreeHooks.after = null;
  if (runner) await stopAll(runner);
  runner = null;
});

function ctxOf(r: Runner) {
  return createContext({ cwd: r.ws.root, env: r.ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
}

/** A launch value by its Godot name (`server-url` for `OGW_SERVER_URL`). */
function launchValue(values: Record<string, string>, name: string): string | undefined {
  return values[`OGW_${name.toUpperCase().replaceAll('-', '_')}`];
}

describe('ogw instance start', () => {
  it('starts opponent bot clients for a realtime game and drives .opponent_step', async () => {
    runner = setupRunner({
      files: { 'data/tables/match_mode.csv': `${MATCH_MODE_HEADER}[duel],2,2,1,true,false\n[trio],3,3,1,true,false\n#[off],2,2,1,true,false\n` },
    });
    mockState.modules = { client: ['RealtimeCore'], server: [] };
    runner.config({
      clients: {
        default: {
          commands: ['battle.opponent_step'],
          sequences: { 'battle.opponent_step': [{ ok: true, result: { command: 'tap', args: ['5', '6'] } }, { ok: true, result: null }] },
        },
      },
    });
    const id = await startFor(runner);
    expect(runner.serverArgs()).toContain('--matchmaker');
    const info = (await listInstances(ctxOf(runner)))[0];
    expect(info?.clients).toEqual(['main', 'opponent_1', 'opponent_2', 'opponent_3']);
    expect(launchValue(runner.clientValues('opponent_2'), 'dev-account')).toBe('opponent_2');
    expect(runner.clientArgs('opponent_1')).toContain('--headless');
    await new Promise((r) => setTimeout(r, 600));
    const o1 = runner.requests('opponent_1');
    expect(o1.find((r) => r.command === 'battle.opponent_step')?.args).toEqual(['[duel]']);
    expect(o1.find((r) => r.command === 'tap')?.args).toEqual(['5', '6']);
    expect(runner.requests('opponent_3').find((r) => r.command === 'battle.opponent_step')?.args).toEqual(['[trio]']);
    expect(id).toBeTruthy();
  });

  it('has the opponent bot clients of the room mode join the room the client main opens', async () => {
    runner = setupRunner({
      files: { 'data/tables/match_mode.csv': `${MATCH_MODE_HEADER}[party],3,3,1,true,true\n[duel],2,2,1,true,false\n` },
    });
    mockState.modules = { client: ['RealtimeCore'], server: [] };
    const clients = (room: Record<string, unknown>) => ({
      default: { commands: ['b.opponent_step', 'b.opponent_join_room'] },
      main: { stateNow: room },
    });
    runner.config({ clients: clients({ room_code: '', room_mode: null }) });
    await startFor(runner);
    await new Promise((r) => setTimeout(r, 700));
    runner.config({ clients: clients({ room_code: 'ABCD', room_mode: '[party]' }) });
    await new Promise((r) => setTimeout(r, 1500));
    const joins = (name: string) => runner?.requests(name).filter((r) => r.command === 'b.opponent_join_room') ?? [];
    expect(joins('opponent_1').map((r) => r.args)).toEqual([['ABCD']]);
    expect(joins('opponent_2').map((r) => r.args)).toEqual([['ABCD']]);
    expect(joins('opponent_3')).toEqual([]);
    const o1 = runner.requests('opponent_1');
    const at = o1.findIndex((r) => r.command === 'b.opponent_join_room');
    expect(o1.slice(at + 1).find((r) => r.command === 'b.opponent_step')?.args).toEqual(['[party]']);
  });

  it('fails when the opponent bot client has not exactly one .opponent_step or .opponent_join_room', async () => {
    runner = setupRunner({ files: { 'data/tables/match_mode.csv': `${MATCH_MODE_HEADER}[duel],2,2,2,true,false\n` } });
    mockState.modules = { client: ['RealtimeCore'], server: [] };
    runner.config({ clients: { default: { commands: ['a.opponent_step', 'b.opponent_step'] } } });
    expect((await ogw(runner.ws, ['instance', 'start', 'g'])).stderr).toContain(
      'expected one content command ending with .opponent_step, found 2: a.opponent_step, b.opponent_step',
    );
    runner.config({ clients: { default: { commands: ['a.opponent_step'] } } });
    expect((await ogw(runner.ws, ['instance', 'start', 'g'])).stderr).toContain(
      'expected one content command ending with .opponent_join_room, found 0',
    );
  });

  it('starts a social bot client and calls .social_step with the user ID', async () => {
    runner = setupRunner();
    mockState.modules = { client: [], server: ['friend'] };
    runner.config({ clients: { main: { state: { user_id: 777 } }, social: { commands: ['friends.social_step'] } } });
    await startFor(runner);
    expect(launchValue(runner.clientValues('social'), 'dev-account')).toBe('social');
    await new Promise((r) => setTimeout(r, 400));
    expect(runner.requests('social').find((r) => r.command === 'friends.social_step')?.args).toEqual(['777']);
    runner.config({ clients: { social: { commands: [] } } });
    await stopAll(runner);
    expect((await ogw(runner.ws, ['instance', 'start', 'g'])).stderr).toContain('expected one content command ending with .social_step');
  });

  it('starts a client main played by an agent without a dev account and does not wait for its Done', async () => {
    runner = setupRunner();
    mockState.modules = { client: [], server: ['friend'] };
    // a new user: boot_login waits on the terms popup, so the client stays at Login without a user_id
    runner.config({ clients: { main: { state: { boot_stage: 'Login', user_id: 0 } }, social: { commands: ['friends.social_step'] } } });
    const { startInstance } = await import('../../../src/commands/instance/api.ts');
    const info = await startInstance(ctxOf(runner), { game: 'g', client: 'window', played: true });
    expect(launchValue(runner.clientValues('main'), 'dev-account')).toBeUndefined();
    expect(launchValue(runner.clientValues('social'), 'dev-account')).toBe('social');
    expect((await readRecord(info.id, runner.ws.env)).status).toBe('running');
    await new Promise((r) => setTimeout(r, 400));
    expect(runner.requests('social').some((r) => r.command === 'friends.social_step')).toBe(false);
    // the agent closed the terms popup and the client logged in: the social loop starts with its user_id
    runner.config({ clients: { main: { state: { boot_stage: 'Login', user_id: 0 }, stateNow: { boot_stage: 'Done', user_id: 31 } }, social: { commands: ['friends.social_step'] } } });
    await new Promise((r) => setTimeout(r, 800));
    expect(runner.requests('social').find((r) => r.command === 'friends.social_step')?.args).toEqual(['31']);
    await stopAll(runner);
    // without played, the same client must reach Done
    runner.config({ clients: { main: { bootStages: ['Login', 'Halted'] } } });
    expect((await ogw(runner.ws, ['instance', 'start', 'g'])).stderr).toContain('main: boot_stage is Halted');
    await expect(startInstance(ctxOf(runner), { game: 'g', client: 'headless', played: true })).rejects.toThrow('played goes with client window');
    await expect(startInstance(ctxOf(runner), { game: 'g', played: true, fixture: 'f.json' })).rejects.toThrow('played does not go with fixture');
  });

  it('opens the automation channel of a client it does not start; the social bot waits for that client', async () => {
    runner = setupRunner();
    mockState.modules = { client: [], server: ['friend'] };
    runner.config({ clients: { main: { state: { user_id: 555 } }, social: { commands: ['friends.social_step'] } } });
    const { startInstance } = await import('../../../src/commands/instance/api.ts');
    const { automationRequest } = await import('../../../src/commands/instance/automation.ts');
    const info = await startInstance(ctxOf(runner), { game: 'g', client: 'none', externalClient: true, platform: 'web' });
    expect(info.clients).toEqual(['social']);
    expect(runner.clientArgs('main')).toEqual([]);
    const external = info.external;
    if (external === null) throw new Error('no external client');
    expect(external.automationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(external.devAccess).toBe(runner.serverSecrets().devAccess);
    expect(external.devAccount).toBe('main');
    expect(runner.requests('social').some((r) => r.command === 'friends.social_step')).toBe(false);
    const { spawn } = await import('node:child_process');
    const fake = join(import.meta.dirname, 'fakes', 'fake-godot.mjs');
    const valueFile = join(runner.logDir, 'external.launch-values.json');
    writeFileSync(valueFile, JSON.stringify({ OGW_AUTOMATION_PORT: String(external.automationPort), OGW_AUTOMATION_TOKEN: external.automationToken }));
    const client = spawn(process.execPath, [fake, '--', `--launch-values=${valueFile}`], {
      env: runner.ws.env,
      stdio: 'ignore',
    });
    try {
      expect((await automationRequest(ctxOf(runner), info.id, 'get_state', [])).result).toMatchObject({ user_id: 555 });
      await new Promise((r) => setTimeout(r, 600));
      expect(runner.requests('social').find((r) => r.command === 'friends.social_step')?.args).toEqual(['555']);
    } finally {
      client.kill('SIGKILL');
    }
    await stopAll(runner);
    await expect(startInstance(ctxOf(runner), { game: 'g', externalClient: true })).rejects.toThrow('externalClient goes with client none');
    await expect(startInstance(ctxOf(runner), { game: 'g', client: 'none', externalClient: true, fixture: 'f.json' })).rejects.toThrow(
      'externalClient does not go with fixture',
    );
    const plain = await startInstance(ctxOf(runner), { game: 'g', client: 'none' });
    expect([plain.external, plain.clients]).toEqual([null, ['social']]);
  });

  it('stops an instance whose outside client never connected', async () => {
    runner = setupRunner();
    mockState.modules = { client: [], server: ['friend'] };
    runner.config({ clients: { social: { commands: ['friends.social_step'] } } });
    const { startInstance } = await import('../../../src/commands/instance/api.ts');
    const info = await startInstance(ctxOf(runner), { game: 'g', client: 'none', externalClient: true });
    await ogw(runner.ws, ['instance', 'stop', info.id]);
    expect(await listRecords(runner.ws.env)).toEqual([]);
  });

  it('runs the save fixture steps, restarts, and fails and stops when a step fails', async () => {
    runner = setupRunner();
    const fixture = join(runner.ws.root, 'fixture.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      fixture,
      JSON.stringify({
        steps: [
          { kind: 'setup', command: 'set_user_state', args: ['Gold', '[]', '{"amount":5}'], timeoutMs: 2000 },
          { kind: 'setup', command: 'go_to_scene', args: ['scene/x'], until: { path: 'state.boot_stage', op: 'eq', value: 'Done' }, timeoutMs: 2000 },
        ],
      }),
    );
    const id = await startFor(runner, ['--fixture', fixture]);
    expect(launchValue(runner.clientValues('main'), 'dev-account')).toBe('main');
    const commands = runner.requests('main').map((r) => r.command);
    expect(commands.indexOf('set_user_state')).toBeLessThan(commands.indexOf('go_to_scene'));
    expect(commands.indexOf('restart')).toBeGreaterThan(commands.indexOf('go_to_scene'));
    expect(commands.lastIndexOf('get_state')).toBeGreaterThan(commands.indexOf('restart'));
    expect((await readRecord(id, runner.ws.env)).status).toBe('running');
    await stopAll(runner);
    runner.config({ clients: { main: { fail: { go_to_scene: 'no such scene' } } } });
    const run = await ogw(runner.ws, ['instance', 'start', 'g', '--fixture', fixture, '--json']);
    expect(run.stderr).toContain('step 2 (go_to_scene) failed: "no such scene"');
    expect(JSON.parse(run.stdout)).toMatchObject({ data: { reason: 'fixture' } });
    expect(await listRecords(runner.ws.env)).toEqual([]);
    writeFileSync(fixture, JSON.stringify({ steps: [{ kind: 'input', command: 'tap', args: [], timeoutMs: 1 }] }));
    const bad = await ogw(runner.ws, ['instance', 'start', 'g', '--fixture', fixture, '--json']);
    expect(bad.stderr).toContain('invalid save fixture: step 1 kind is not setup');
    expect(JSON.parse(bad.stdout)).toMatchObject({ data: { reason: 'fixture' } });
    const missing = await ogw(runner.ws, ['instance', 'start', 'g', '--fixture', join(runner.ws.root, 'none.json'), '--json']);
    expect(JSON.parse(missing.stdout)).toMatchObject({ data: { reason: 'fixture' } });
  });

  it('restarts a client through the runner with restart or set_language and returns the state of the new boot', async () => {
    runner = setupRunner();
    const id = await startFor(runner);
    const { restartClient } = await import('../../../src/commands/instance/automation.ts');
    expect(await restartClient(ctxOf(runner), id, 'main', { command: 'set_language', args: ['ko'], timeoutMs: 5000 })).toMatchObject({ boot_stage: 'Done', restarts: 1 });
    expect(runner.requests('main').find((r) => r.command === 'set_language')?.args).toEqual(['ko']);
    expect(await restartClient(ctxOf(runner), id)).toMatchObject({ boot_stage: 'Done', restarts: 2 });
    runner.config({ clients: { main: { fail: { set_language: 'no language' } } } });
    await expect(restartClient(ctxOf(runner), id, 'main', { command: 'set_language', args: ['xx'] })).rejects.toThrow('set_language failed: "no language"');
    await stopAll(runner);
  });

  it('gives the process states and the server log', async () => {
    runner = setupRunner();
    const id = await startFor(runner);
    const { instanceProcesses, instanceServerLog } = await import('../../../src/commands/check/lib/instance-probe.ts');
    expect(await instanceProcesses(ctxOf(runner), id)).toEqual({ server: true, clients: [{ client: 'main', alive: true }] });
    const record = await readRecord(id, runner.ws.env);
    const { appendFileSync } = await import('node:fs');
    const { instanceFolder } = await import('../../../src/commands/instance/lib/records.ts');
    appendFileSync(join(await instanceFolder(id, runner.ws.env), 'server.log'), '{"level":"error"}\n');
    expect(await instanceServerLog(ctxOf(runner), id)).toBe('{"level":"error"}\n');
    expect(await instanceServerLog(ctxOf(runner), id, 9)).toBe('"error"}\n');
    expect(await instanceServerLog(ctxOf(runner), id, 18)).toBe('');
    // a log that cannot be read is not an empty log
    const { renameSync, mkdirSync: mkdir } = await import('node:fs');
    const logPath = join(await instanceFolder(id, runner.ws.env), 'server.log');
    renameSync(logPath, `${logPath}.kept`);
    mkdir(logPath);
    await expect(instanceServerLog(ctxOf(runner), id)).rejects.toThrow();
    await expect(instanceServerLog(ctxOf(runner), id, 4)).rejects.toThrow();
    const { rmSync } = await import('node:fs');
    rmSync(logPath, { recursive: true });
    expect(await instanceServerLog(ctxOf(runner), id)).toBe('');
    renameSync(`${logPath}.kept`, logPath);
    process.kill(record.pids.server as number, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    expect((await instanceProcesses(ctxOf(runner), id)).server).toBe(false);
  });

  it('stop of an unknown instance fails', async () => {
    runner = setupRunner();
    const run = await ogw(runner.ws, ['instance', 'stop', 'nope']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('instance not found: nope');
  });

  it('records a client that ends while the instance runs', async () => {
    runner = setupRunner();
    const id = await startFor(runner);
    const record = await readRecord(id, runner.ws.env);
    process.kill(record.pids.main as number, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    const info = (await listInstances(ctxOf(runner)))[0];
    expect(Object.keys(info?.exited ?? {})).toEqual(['main']);
    expect(readFileSync(join(record.root, 'settings.json'), 'utf8')).toContain('godot');
  });

  it('commits nothing in the game repo', async () => {
    runner = setupRunner();
    await startFor(runner);
    expect(sh(runner.root, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('runs a folder outside games/ with another core version, past the concurrency limit', async () => {
    runner = setupRunner({ harness: { maxConcurrentInstances: 2 } });
    const { startInstance } = await import('../../../src/commands/instance/api.ts');
    const { cpSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const bench = mkdtempSync(join(tmpdir(), 'ogw-bench-'));
    cpSync(join(runner.root, 'settings.json'), join(bench, 'settings.json'));
    await startFor(runner);
    await startFor(runner, ['--platform', 'ios']);
    const info = await startInstance(ctxOf(runner), { game: 'bench', root: bench, coreVersion: '2.0.0', ignoreConcurrencyLimit: true });
    expect(info).toMatchObject({ game: 'bench', root: bench, commit: '', clients: ['main'] });
    expect(JSON.parse(readFileSync(join(bench, 'settings.json'), 'utf8'))).toMatchObject({ engine: 'godot', coreVersion: '2.0.0' });
    expect(mockState.generateCalls.at(-1)).toBe(bench);
    expect(mockState.generateLocks.slice(-2)).toEqual([join(bench, '.ogw-generate.lock'), join(bench, '.ogw-generate.lock')]);
    expect(runner.clientArgs('main')[1]).toBe(join(bench, 'client'));
    await expect(startInstance(ctxOf(runner), { game: 'g', coreVersion: '2.0.0' })).rejects.toThrow('coreVersion goes with root');
    await expect(startInstance(ctxOf(runner), { game: 'g', root: bench, commit: 'x' })).rejects.toThrow('commit does not go with root');
    await stopAll(runner);
    rmSync(bench, { recursive: true, force: true });
    expect(commitAll).toBeTypeOf('function');
  });
});
