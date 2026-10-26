import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listInstances, startInstance } from '../../../src/commands/instance/api.ts';
import { instanceFolder, listRecords, readRecord } from '../../../src/commands/instance/lib/records.ts';
import { createContext } from '../../../src/lib/command.ts';
import { jobsDir } from '../../../src/lib/jobs.ts';
import { ogw, sh } from '../../helpers/workspace.ts';
import { fakeAgentJob } from './agents.ts';
import { mockState } from './mocks/state.ts';
import { setupRunner, startFor, stopAll, type Runner } from './runner.ts';

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
  it('starts the server and the client with launch values, and prints only id and address', async () => {
    runner = setupRunner();
    const run = await ogw(runner.ws, ['instance', 'start', 'g']);
    expect(run.code).toBe(0);
    const lines = run.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    const [idLine, addressLine] = lines;
    const id = (idLine ?? '').replace('id: ', '');
    const record = await readRecord(id, runner.ws.env);
    expect(record.status).toBe('running');
    expect(addressLine).toBe(`address: ${record.serverUrl}`);
    expect(record.serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/);
    // the admin secret stays in the instance record: job stdout is readable by play and judge agents
    expect(run.stdout).not.toContain(record.adminSecret);
    expect(record.adminSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(record.platform).toBe('android');
    expect(record.commit).toBe(sh(runner.root, 'git', ['rev-parse', 'HEAD']).trim());

    const server = runner.serverArgs();
    expect(server.slice(0, 4)).toEqual(['--env', 'LOCAL', '--port', record.serverUrl.split(':')[2]]);
    expect(server[server.indexOf('--db') + 1]).toBe(join(await import('../../../src/commands/instance/lib/records.ts').then((m) => m.instanceFolder(id, runner?.ws.env)), 'db.sqlite'));
    expect(server).not.toContain('--matchmaker');
    // the secret values go in a file only the owner can read, inside the instance folder, not on the command line
    const folder = await import('../../../src/commands/instance/lib/records.ts').then((m) => m.instanceFolder(id, runner?.ws.env));
    expect(server.slice(-2)).toEqual(['--secret-file', join(folder, 'server-secrets.json')]);
    expect(statSync(join(folder, 'server-secrets.json')).mode & 0o777).toBe(0o600);
    const secrets = runner.serverSecrets();
    expect(Object.keys(secrets)).toEqual(['accessTokenKey', 'updateSigningKey', 'iapAccountToken', 'devAccess', 'adminSecret.ogw']);
    expect(secrets['adminSecret.ogw']).toBe(record.adminSecret);
    const devAccess = secrets.devAccess;
    expect(Buffer.from(secrets.accessTokenKey ?? '', 'base64')).toHaveLength(32);

    const client = runner.clientArgs('main');
    expect(client).toEqual(['--path', join(runner.root, 'client'), '--rendering-method', 'mobile', '--', `--launch-values=${join(folder, 'main.launch-values.json')}`]);
    expect(statSync(join(folder, 'main.launch-values.json')).mode & 0o777).toBe(0o600);
    for (const value of Object.values(secrets)) expect([...server, ...client].join(' ')).not.toContain(value);
    const values = runner.clientValues('main');
    expect(launchValue(values, 'automation-token')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect([...server, ...client].join(' ')).not.toContain(launchValue(values, 'automation-token'));
    expect(launchValue(values, 'server-url')).toBe(record.serverUrl);
    expect(launchValue(values, 'instance-id')).toBe(id);
    expect(launchValue(values, 'dev-access')).toBe(devAccess);
    expect(launchValue(values, 'platform')).toBe('android');
    // no play or judge agent plays this client: it logs in with dev account main and skips the terms popup
    expect(launchValue(values, 'dev-account')).toBe('main');
    expect(runner.requests('main')[0]?.command).toBe('get_state');

    expect(mockState.engineRequests).toEqual([['godot', '4.5.1.stable']]);
    expect(mockState.generateCalls).toEqual([runner.root]);
    expect(mockState.dataCalls).toEqual([{ root: runner.root, binary: true, generate: false }]);
    expect((await listInstances(ctxOf(runner))).map((i) => [i.id, i.clients])).toEqual([[id, ['main']]]);
  });

  it('skips generate when the last run was at the same clean HEAD, and runs it again after a change', async () => {
    runner = setupRunner();
    const first = await startFor(runner);
    await ogw(runner.ws, ['instance', 'stop', first]);
    await startFor(runner, ['--platform', 'ios']);
    expect(mockState.generateCalls).toHaveLength(1);
    // the engine import runs once per checkout, before the first dev run
    expect(readFileSync(join(runner.logDir, 'import.log'), 'utf8')).toBe(`--headless --path ${join(runner.root, 'client')} --import\n`);
    expect(existsSync(join(runner.root, 'client', '.godot'))).toBe(true);
    expect(launchValue(runner.clientValues('main'), 'platform')).toBe('ios');
    expect(runner.clientArgs('main')).toContain('mobile');
    await stopAll(runner);
    sh(runner.root, 'git', ['commit', '--allow-empty', '-q', '-m', 'next']);
    await startFor(runner, ['--platform', 'web']);
    expect(mockState.generateCalls).toHaveLength(2);
    expect(runner.clientArgs('main')).toContain('gl_compatibility');
    await stopAll(runner);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(runner.root, 'note.txt'), 'x');
    await startFor(runner, ['--platform', 'macos']);
    expect(mockState.generateCalls).toHaveLength(3);
    expect(runner.clientArgs('main')).toContain('forward_plus');
    await stopAll(runner);
    // the last run was on a change that is now discarded: HEAD is the same and clean, but it runs again
    rmSync(join(runner.root, 'note.txt'));
    await startFor(runner);
    expect(mockState.generateCalls).toHaveLength(4);
    await stopAll(runner);
    await startFor(runner);
    expect(mockState.generateCalls).toHaveLength(4);
  });

  it('runs from a worktree of --commit and removes it on stop', async () => {
    runner = setupRunner();
    const first = sh(runner.root, 'git', ['rev-parse', 'HEAD']).trim();
    sh(runner.root, 'git', ['commit', '--allow-empty', '-q', '-m', 'later']);
    const id = await startFor(runner, ['--commit', first]);
    const record = await readRecord(id, runner.ws.env);
    const worktree = join(runner.ws.worktrees, 'g', `instance-${id}`);
    expect(record.root).toBe(worktree);
    expect(record.commit).toBe(first);
    expect(runner.clientArgs('main')[1]).toBe(join(worktree, 'client'));
    expect(mockState.generateCalls).toEqual([worktree]);
    expect(readFileSync(join(runner.logDir, 'import.log'), 'utf8')).toBe(`--headless --path ${join(worktree, 'client')} --import\n`);
    const stop = await ogw(runner.ws, ['instance', 'stop', id]);
    expect(stop).toMatchObject({ code: 0, stdout: `stopped ${id}\n` });
    expect(existsSync(worktree)).toBe(false);
    expect(await listRecords(runner.ws.env)).toEqual([]);
  });

  it('fails and stops when the engine import fails, and imports again next time', async () => {
    runner = setupRunner();
    runner.ws.env.FAKE_IMPORT_FAIL = '1';
    const run = await ogw(runner.ws, ['instance', 'start', 'g']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(`godot --import failed (3): ${join(runner.root, 'client')}`);
    expect(await listRecords(runner.ws.env)).toEqual([]);
    delete runner.ws.env.FAKE_IMPORT_FAIL;
    await startFor(runner);
    expect(readFileSync(join(runner.logDir, 'import.log'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('imports a checkout once when two jobs find no .godot/ at the same time', async () => {
    runner = setupRunner();
    const { importIfNeeded } = await import('../../../src/commands/instance/lib/prepare.ts');
    const plan = { engine: 'godot', enginePath: mockState.enginePath };
    const ran = await Promise.all([importIfNeeded(ctxOf(runner), plan, runner.root), importIfNeeded(ctxOf(runner), plan, runner.root)]);
    expect(ran.sort()).toEqual([false, true]);
    expect(readFileSync(join(runner.logDir, 'import.log'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('records the agent that started it, and refuses a start for an agent job that ended', async () => {
    runner = setupRunner();
    const remove = await fakeAgentJob(runner.ws.env, 'agentcont1', { role: 'content', cliPid: process.ppid });
    try {
      const run = await ogw(runner.ws, ['instance', 'start', 'g']);
      expect(run.code).toBe(0);
      const id = (run.stdout.split('\n')[0] ?? '').replace('id: ', '');
      expect((await readRecord(id, runner.ws.env)).agentJob).toBe('agentcont1');
    } finally {
      remove();
    }
  });

  it('does not run an instance whose agent ended while the start waited for a slot', async () => {
    runner = setupRunner({ harness: { maxConcurrentInstances: 2, instanceWaitTimeoutMs: 20_000 } });
    const first = await startFor(runner);
    await startFor(runner);
    const remove = await fakeAgentJob(runner.ws.env, 'agentcont2', { role: 'content', cliPid: process.ppid });
    try {
      // the start finds the agent, then waits: both slots are taken
      const late = ogw(runner.ws, ['instance', 'start', 'g']);
      await new Promise((r) => setTimeout(r, 1500));
      const jobFile = join(await jobsDir(runner.ws.env), 'agentcont2.json');
      writeFileSync(jobFile, JSON.stringify({ ...(JSON.parse(readFileSync(jobFile, 'utf8')) as object), status: 'done', endedAt: Date.now() }));
      await ogw(runner.ws, ['instance', 'stop', first]);
      const run = await late;
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain('the ogw agent job agentcont2 that started this instance has ended');
      expect((await listRecords(runner.ws.env)).filter((r) => r.agentJob === 'agentcont2')).toEqual([]);
    } finally {
      remove();
    }
  });

  it('does not run an instance whose agent CLI ended while the start waited, though the job is still running', async () => {
    runner = setupRunner({ harness: { maxConcurrentInstances: 2, instanceWaitTimeoutMs: 20_000 } });
    const first = await startFor(runner);
    await startFor(runner);
    const remove = await fakeAgentJob(runner.ws.env, 'agentcont3', { role: 'content', cliPid: process.ppid });
    try {
      // the start finds the agent, then waits: both slots are taken
      const late = ogw(runner.ws, ['instance', 'start', 'g']);
      await new Promise((r) => setTimeout(r, 1500));
      const jobFile = join(await jobsDir(runner.ws.env), 'agentcont3.json');
      writeFileSync(jobFile, JSON.stringify((() => { const job = JSON.parse(readFileSync(jobFile, 'utf8')) as { meta: Record<string, unknown> }; job.meta.cliEnded = true; return job; })()));
      await ogw(runner.ws, ['instance', 'stop', first]);
      const run = await late;
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain('the ogw agent job agentcont3 that started this instance has ended');
      expect((await listRecords(runner.ws.env)).filter((r) => r.agentJob === 'agentcont3')).toEqual([]);
    } finally {
      remove();
    }
  });

  it('refuses a --background start whose agent ended before the start ran', async () => {
    runner = setupRunner();
    const dir = await jobsDir(runner.ws.env);
    mkdirSync(dir, { recursive: true });
    // the agent job ended; its background `instance start` job still runs and names it
    writeFileSync(join(dir, 'agentdone1.json'), JSON.stringify({ id: 'agentdone1', argv: ['agent', 'content'], cwd: '/', command: 'agent', game: 'g', startedAt: 1, endedAt: 2, status: 'done', exitCode: 0, supervisorPid: null, pid: null, timeLimitMs: 60_000, agentJob: null, summary: null, meta: { role: 'content', cliEnded: true } }));
    writeFileSync(join(dir, 'bgstart1.json'), JSON.stringify({ id: 'bgstart1', argv: ['instance', 'start', 'g'], cwd: '/', command: 'instance start', game: 'g', startedAt: 3, endedAt: null, status: 'running', exitCode: null, supervisorPid: null, pid: null, timeLimitMs: 60_000, agentJob: 'agentdone1', summary: null, meta: {} }));
    const run = await ogw(runner.ws, ['instance', 'start', 'g'], { env: { ...runner.ws.env, OGW_JOB_ID: 'bgstart1' } });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('the ogw agent job agentdone1 that started this instance has ended');
    expect(await listRecords(runner.ws.env)).toEqual([]);
  });

  it('fails on an unknown commit and leaves no record', async () => {
    runner = setupRunner();
    const run = await ogw(runner.ws, ['instance', 'start', 'g', '--commit', 'deadbeef']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('commit not found in g: deadbeef');
    expect(await listRecords(runner.ws.env)).toEqual([]);
  });

  it('checks maxConcurrentInstances and playInstances', async () => {
    runner = setupRunner({ harness: { maxConcurrentInstances: null } });
    expect((await ogw(runner.ws, ['instance', 'start', 'g'])).stderr).toContain('maxConcurrentInstances is null: run update env first');
    runner = setupRunner({ harness: { maxConcurrentInstances: 1, playInstances: 1 } });
    expect((await ogw(runner.ws, ['instance', 'start', 'g'])).stderr).toContain('maxConcurrentInstances must be 2 or more: 1');
    runner = setupRunner({ harness: { maxConcurrentInstances: 2, playInstances: 3 } });
    expect((await ogw(runner.ws, ['instance', 'start', 'g'])).stderr).toContain(
      'playInstances (3) is more than maxConcurrentInstances (2)',
    );
  });

  it('waits for a slot and fails after instanceWaitTimeoutMs', async () => {
    runner = setupRunner({ harness: { maxConcurrentInstances: 2, instanceWaitTimeoutMs: 1200 } });
    const a = await startFor(runner);
    await startFor(runner, ['--platform', 'ios']);
    const started = Date.now();
    const third = await ogw(runner.ws, ['instance', 'start', 'g', '--json']);
    expect(third.code).not.toBe(0);
    expect(third.stderr).toContain('no instance slot within instanceWaitTimeoutMs (1200 ms): 2 instances are running');
    expect(JSON.parse(third.stdout)).toMatchObject({ data: { reason: 'wait-timeout' } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1100);
    const waiting = ogw(runner.ws, ['instance', 'start', 'g', '--json']);
    setTimeout(() => {
      void ogw(runner?.ws as never, ['instance', 'stop', a]);
    }, 300);
    const waited = await waiting;
    expect(waited.code).toBe(0);
    const data = JSON.parse(waited.stdout) as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['address', 'commit', 'id', 'platform']);
  });

  it('fails when the data binary build fails, and stops the instance', async () => {
    runner = setupRunner();
    mockState.dataExit = 1;
    const run = await ogw(runner.ws, ['instance', 'start', 'g', '--json']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('data tool binary build failed\nERROR bad x.csv:5 bad');
    expect(JSON.parse(run.stdout)).toMatchObject({ data: { reason: 'start' } });
    expect(await listRecords(runner.ws.env)).toEqual([]);
  });

  it('fails without a platform, with an unknown platform, an unknown engine and a missing QACore setting', async () => {
    runner = setupRunner({ settings: { buildPlatforms: [] } });
    expect((await ogw(runner.ws, ['instance', 'start', 'g'])).stderr).toContain('game settings buildPlatforms is empty: give --platform');
    expect((await ogw(runner.ws, ['instance', 'start', 'g', '--platform', 'switch'])).stderr).toContain('unknown platform: switch');
    runner = setupRunner({ settings: { engine: 'unity' } });
    expect((await ogw(runner.ws, ['instance', 'start', 'g'])).stderr).toContain('not defined: the dev run of engine unity');
    runner = setupRunner();
    mockState.core = {};
    expect((await ogw(runner.ws, ['instance', 'start', 'g'])).stderr).toContain('core settings has no QACore.commandTimeoutMs');
    runner = setupRunner();
    expect((await ogw(runner.ws, ['instance', 'start', 'g', '--db', 'mysql'])).stderr).toContain('invalid --db: mysql');
    expect(await listRecords(runner.ws.env)).toEqual([]);
  });

  it('fails when a client ends, boots to Halted, or the server process ends', async () => {
    runner = setupRunner();
    runner.config({ clients: { main: { exitOnStart: 3 } } });
    expect((await ogw(runner.ws, ['instance', 'start', 'g'])).stderr).toContain('main: the client process ended');
    runner.config({ clients: { main: { bootStages: ['Login', 'Halted'] } } });
    expect((await ogw(runner.ws, ['instance', 'start', 'g'])).stderr).toContain('main: boot_stage is Halted');
    runner.config({});
    runner.ws.env.FAKE_SERVER_EXIT = '4';
    expect((await ogw(runner.ws, ['instance', 'start', 'g'])).stderr).toContain('the server process ended before it took requests');
    expect(await listRecords(runner.ws.env)).toEqual([]);
  });

  it('calls beforeFailedStop before it stops a failed start, with the folder and record still there, and throws the start error', async () => {
    runner = setupRunner();
    runner.config({ clients: { main: { exitOnStart: 3 } } });
    const env = runner.ws.env;
    const ctx = createContext({ cwd: runner.ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const seen: { folder: boolean; runnerLog: boolean; mainPid: boolean }[] = [];
    const beforeFailedStop = async (id: string): Promise<void> => {
      const folder = await instanceFolder(id, env);
      seen.push({ folder: existsSync(folder), runnerLog: existsSync(join(folder, 'runner.log')), mainPid: typeof (await readRecord(id, env)).pids.main === 'number' });
      throw new Error('the hook broke');
    };
    await expect(startInstance(ctx, { game: 'g' }, { beforeFailedStop })).rejects.toThrow('main: the client process ended');
    expect(seen).toEqual([{ folder: true, runnerLog: true, mainPid: true }]);
    expect(await listRecords(env)).toEqual([]);
  });

  /** A `docker` on PATH that logs its arguments, keeps what `docker cp -` reads, and waits in `create` while `hold` exists. */

  function fakeDocker(r: Runner): { docker: () => string[][]; hold: string } {
    const bin = join(r.logDir, 'docker-bin');
    mkdirSync(bin);
    const hold = join(r.logDir, 'docker-hold');
    writeFileSync(join(bin, 'docker'), [
      '#!/bin/sh',
      'echo "$@" >> "$FAKE_LOG_DIR/docker.log"',
      'if [ "$1" = cp ]; then cat > "$FAKE_LOG_DIR/docker-cp.tar"; fi',
      `if [ "$1" = create ]; then while [ -e "${hold}" ]; do sleep 0.05; done; fi`,
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(join(bin, 'docker'), 0o755);
    r.ws.env.PATH = `${bin}:${r.ws.env.PATH ?? ''}`;
    const docker = (): string[][] =>
      (existsSync(join(r.logDir, 'docker.log')) ? readFileSync(join(r.logDir, 'docker.log'), 'utf8') : '')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => l.split(' '));
    return { docker, hold };
  }

  it('runs --db postgresql on a disposable container and removes it on stop and on a failed start', async () => {
    runner = setupRunner();
    const { docker } = fakeDocker(runner);
    const pg = (JSON.parse(readFileSync(join(runner.ws.harness, 'settings.json'), 'utf8')) as { tools: { postgresql: { tag: string; digest: string } } })
      .tools.postgresql;

    const id = await startFor(runner, ['--db', 'postgresql']);
    const name = `ogw-instance-${id}-db`;
    const create = docker().find((args) => args[0] === 'create') ?? [];
    expect(docker()[0]).toEqual(['volume', 'prune', '--force', '--filter', 'label=ogw.postgres=throwaway']);
    expect(create.slice(0, 7)).toEqual([
      'create', '--name', name, '--env', 'POSTGRES_PASSWORD_FILE=/ogw-postgres-password',
      '--mount', 'type=volume,dst=/var/lib/postgresql,volume-label=ogw.postgres=throwaway',
    ]);
    expect(create.at(-1)).toBe(`postgres:${pg.tag}@${pg.digest}`);
    const port = /^127\.0\.0\.1:([0-9]+):5432$/.exec(create[create.indexOf('--publish') + 1] ?? '')?.[1];
    expect(port).toBeDefined();
    expect(docker().slice(2, 4)).toEqual([['cp', '-', `${name}:/`], ['start', name]]);
    // the password reaches the container only as a file through the stdin of docker cp
    const tar = readFileSync(join(runner.logDir, 'docker-cp.tar'));
    expect(tar.subarray(0, 21).toString('ascii')).toBe('ogw-postgres-password');
    expect(tar.subarray(100, 107).toString('ascii')).toBe('0000444');
    const size = parseInt(tar.subarray(124, 135).toString('ascii'), 8);
    const password = tar.subarray(512, 512 + size).toString('ascii');
    expect(password).toMatch(/^[0-9a-f]{48}$/);
    expect(tar.length % 512).toBe(0);
    for (const args of docker()) expect(args.join(' ')).not.toContain(password);
    expect(docker().some((args) => args[0] === 'exec' && args[1] === name && args[2] === 'pg_isready')).toBe(true);
    // the connection string holds the password: it goes only in the 0600 server secret file, never on the command line
    const server = runner.serverArgs();
    expect(server[server.indexOf('--db') + 1]).toBe('postgresql');
    for (const arg of server) expect(arg).not.toContain(password);
    expect(runner.serverSecrets().db).toBe(`postgresql://postgres:${password}@127.0.0.1:${String(port)}/postgres`);
    expect((await readRecord(id, runner.ws.env)).container).toBe(name);
    await ogw(runner.ws, ['instance', 'stop', id]);
    expect(docker().at(-1)).toEqual(['rm', '--force', '--volumes', name]);

    runner.ws.env.FAKE_SERVER_EXIT = '4';
    const failed = await ogw(runner.ws, ['instance', 'start', 'g', '--db', 'postgresql']);
    expect(failed.code).not.toBe(0);
    const failedName = docker().filter((args) => args[0] === 'create').at(-1)?.[2] ?? '';
    expect(failedName).not.toBe(name);
    expect(docker()).toContainEqual(['rm', '--force', '--volumes', failedName]);
    expect(await listRecords(runner.ws.env)).toEqual([]);
  });

  it('removes the PostgreSQL container that finishes starting after the instance was stopped', async () => {
    runner = setupRunner();
    const { docker, hold } = fakeDocker(runner);
    writeFileSync(hold, '');
    const starting = ogw(runner.ws, ['instance', 'start', 'g', '--db', 'postgresql']);
    for (let i = 0; i < 400 && !docker().some((args) => args[0] === 'create'); i++) await new Promise((r) => setTimeout(r, 50));
    const [record] = await listRecords(runner.ws.env);
    expect(record).toBeDefined();
    const name = `ogw-instance-${record?.id ?? ''}-db`;
    expect((await ogw(runner.ws, ['instance', 'stop', record?.id ?? ''])).code).toBe(0);
    const removedBefore = docker().filter((args) => args[0] === 'rm').length;
    rmSync(hold);
    await starting;
    for (let i = 0; i < 400 && docker().filter((args) => args[0] === 'rm').length === removedBefore; i++) await new Promise((r) => setTimeout(r, 50));
    const calls = docker();
    const created = calls.findIndex((args) => args[0] === 'create');
    expect(calls.slice(created + 1)).toContainEqual(['rm', '--force', '--volumes', name]);
    expect(calls.filter((args) => args[0] === 'rm').length).toBeGreaterThan(removedBefore);
    expect(calls.some((args) => args[0] === 'start')).toBe(false);
    expect(await listRecords(runner.ws.env)).toEqual([]);
  });

  it('runs populate when server/dev/populate.ts exists and fails when it throws', async () => {
    runner = setupRunner({ files: { 'server/dev/populate.ts': 'export async function populate() {}\n' } });
    const id = await startFor(runner);
    const record = await readRecord(id, runner.ws.env);
    const secretFile = runner.serverArgs().at(-1);
    expect(mockState.populateCalls).toEqual([{ root: runner.root, serverUrl: record.serverUrl, secretFile }]);
    expect(JSON.parse(readFileSync(secretFile ?? '', 'utf8'))).toMatchObject({ devAccess: runner.serverSecrets().devAccess });
    await stopAll(runner);
    mockState.populateFails = true;
    const run = await ogw(runner.ws, ['instance', 'start', 'g']);
    expect(run.stderr).toContain('populate failed: populate broke');
  });

  it('reports the reserved id before the boot; a stop of that id fails the start and leaves no record', async () => {
    runner = setupRunner();
    const { startInstance, stopInstance } = await import('../../../src/commands/instance/api.ts');
    const ctx = ctxOf(runner);
    const reserved: string[] = [];
    let stopping: Promise<void> = Promise.resolve();
    const env = runner.ws.env;
    const started = startInstance(ctx, { game: 'g' }, {
      onReserved: (id) => {
        reserved.push(id);
        stopping = readRecord(id, env).then((record) => {
          expect(record.status).toBe('starting');
          return stopInstance(ctx, id);
        });
      },
    });
    const error = await started.then(() => null, (e: unknown) => e);
    await stopping;
    expect(reserved).toHaveLength(1);
    expect(String(error)).toContain(`instance not found: ${reserved[0] ?? '-'}`);
    expect(await listRecords(runner.ws.env)).toEqual([]);
  });

  it('leaves no worktree when the reserved id of a commit start is stopped while git worktree add runs', async () => {
    runner = setupRunner();
    const { startInstance, stopInstance } = await import('../../../src/commands/instance/api.ts');
    const ctx = ctxOf(runner);
    const first = sh(runner.root, 'git', ['rev-parse', 'HEAD']).trim();
    sh(runner.root, 'git', ['commit', '--allow-empty', '-q', '-m', 'later']);
    for (const when of ['before', 'after'] as const) {
      let id = '';
      worktreeHooks.before = null;
      worktreeHooks.after = null;
      worktreeHooks[when] = () => stopInstance(ctx, id);
      const error = await startInstance(ctx, { game: 'g', commit: first }, { onReserved: (reserved) => (id = reserved) }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(String(error)).toContain(`instance not found: ${id}`);
      expect(existsSync(join(runner.ws.worktrees, 'g', `instance-${id}`))).toBe(false);
      expect(sh(runner.root, 'git', ['worktree', 'list'])).not.toContain(`instance-${id}`);
      expect(await listRecords(runner.ws.env)).toEqual([]);
    }
  });

  it('stops waiting for a slot without one, and stops a reserved start, once its signal is aborted', async () => {
    runner = setupRunner({ harness: { maxConcurrentInstances: 2, instanceWaitTimeoutMs: 5000 } });
    const { startInstance } = await import('../../../src/commands/instance/api.ts');
    const ctx = ctxOf(runner);
    const a = await startFor(runner);
    const b = await startFor(runner, ['--platform', 'ios']);
    const controller = new AbortController();
    const reserved: string[] = [];
    const outcome = startInstance(ctx, { game: 'g' }, { signal: controller.signal, onReserved: (id) => reserved.push(id) }).then(
      () => null,
      (e: unknown) => e,
    );
    const started = Date.now();
    setTimeout(() => {
      controller.abort();
    }, 200);
    expect(String(await outcome)).toContain('instance start was stopped');
    expect(Date.now() - started).toBeLessThan(2000);
    // a slot that frees after the abort is not taken
    await ogw(runner.ws, ['instance', 'stop', a]);
    expect(reserved).toEqual([]);
    expect((await listRecords(runner.ws.env)).map((r) => r.id)).toEqual([b]);

    const late = new AbortController();
    const stopped = await startInstance(ctx, { game: 'g' }, {
      signal: late.signal,
      onReserved: (id) => {
        reserved.push(id);
        late.abort();
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(stopped)).toContain('instance start was stopped');
    expect(reserved).toHaveLength(1);
    expect((await listRecords(runner.ws.env)).map((r) => r.id)).toEqual([b]);
  });
});
