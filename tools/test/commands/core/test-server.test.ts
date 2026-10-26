import { availableParallelism } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { baseProtoErrors } from '../../../src/commands/core/lib/base-proto-check.ts';
import { renderDeps } from '../../../src/commands/core/lib/godot.ts';
import { withCoreMain } from '../../../src/commands/core/lib/main-checkout.ts';
import { serverCoreStaticCheck } from '../../../src/commands/core/lib/core-server-static-check.ts';
import { readTestRecords } from '../../../src/commands/core/lib/test-records.ts';
import { serverImplementedModules } from '../../../src/commands/core/lib/server-layout.ts';
import { serverModuleTest } from '../../../src/commands/core/lib/server-tests.ts';
import { runToolTest } from '../../../src/commands/core/lib/tool-test.ts';
import { buildTool } from '../../../src/commands/core/lib/tools.ts';
import { writeCoreSpec } from '../../../src/commands/core/spec-api.ts';
import { parallelismOf, SERVER_WORKERS } from '../../../src/commands/core/test.ts';
import { requireEngine } from '../../../src/commands/env/api.ts';
import { ogw, commitAll, sh } from '../../helpers/workspace.ts';
import { writeFiles } from './helpers.ts';
import { setup } from './test-fixture.ts';

vi.mock('../../../src/commands/core/spec-api.ts', () => ({ buildCoreSpec: vi.fn(), writeCoreSpec: vi.fn() }));
vi.mock('../../../src/commands/core/lib/base-proto-check.ts', () => ({ baseProtoErrors: vi.fn() }));
vi.mock('../../../src/commands/env/api.ts', () => ({ requireEngine: vi.fn(), toolProgram: vi.fn() }));
vi.mock('../../../src/commands/core/lib/core-server-static-check.ts', () => ({ serverCoreStaticCheck: vi.fn() }));
vi.mock('../../../src/commands/core/lib/tools.ts', async (importOriginal) => {
  const buildTool = vi.fn();
  return {
    ...(await importOriginal<object>()),
    buildTool,
    withBuiltTool: async (env: unknown, impl: unknown, tool: unknown, fn: (entry: string) => Promise<unknown>) => fn((await buildTool(env, impl, tool)) as string),
  };
});
vi.mock('../../../src/commands/core/lib/tool-test.ts', () => ({ runToolTest: vi.fn() }));
vi.mock('../../../src/commands/core/lib/engine-packages.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  installPackage: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../src/commands/core/lib/undefined.ts', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
  };
});
vi.mock('../../../src/commands/core/lib/server-layout.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  serverImplementedModules: vi.fn(() => Promise.resolve(['routing'])),
  serverModuleReferences: vi.fn(() => Promise.resolve(new Map())),
}));
vi.mock('../../../src/commands/core/lib/server-tests.ts', () => ({ serverModuleTest: vi.fn() }));

beforeEach(() => {
  vi.mocked(writeCoreSpec).mockReset().mockResolvedValue({ modules: new Map(), settingTypes: new Map(), errors: [], dir: '', written: [], deleted: [], settingTypesWritten: false });
  vi.mocked(baseProtoErrors).mockReset().mockResolvedValue([]);
  vi.mocked(serverModuleTest).mockReset();
  vi.mocked(runToolTest).mockReset();
  vi.mocked(serverCoreStaticCheck).mockReset().mockResolvedValue([]);
  // the host's own screen does not decide the render passes of these tests
  renderDeps.screenLocked = () => Promise.resolve(false);
});

describe('ogw core test server and tools', () => {
  it('passes the one test file of --file to the server module run and records nothing', async () => {
    const { ws, env } = setup();
    sh(ws.coreImpl, 'rm', ['licenses.json']);
    writeFiles(ws.coreImpl, { 'server/core/routing/tests/one.test.ts': "it('t', () => undefined);\n" });
    commitAll(ws.coreImpl, 'a test file');
    vi.mocked(serverModuleTest).mockResolvedValue({ tests: 1, passed: 1, failures: [] });
    const run = await ogw(ws, ['core', 'test', 'server', 'routing', '--file', 'server/core/routing/tests/one.test.ts'], { env });
    expect(run.code).toBe(0);
    expect(vi.mocked(serverModuleTest).mock.calls[0]?.[0]).toMatchObject({ module: 'routing', file: 'server/core/routing/tests/one.test.ts' });
    expect(await readTestRecords(ws.coreImpl)).toEqual([]);
    expect((await ogw(ws, ['core', 'test', 'server', 'routing', '--file', 'server/core/routing/tests/helpers.ts'], { env })).stderr).toContain('--file must be a .test.ts file in server/core/routing/tests/ of routing');
    expect((await ogw(ws, ['core', 'test', 'tools', 'data-tool', '--file', 'tools/data-tool/tests/a.test.ts'], { env })).stderr).toContain('--file is for server and a native engine run, not tools');
  });

  it('runs server modules against a throwaway PostgreSQL container', async () => {
    const { ws, env, log } = setup();
    // the licenses.json check is of engine targets only: `create server core` runs before any licenses.json exists
    sh(ws.coreImpl, 'rm', ['licenses.json']);
    vi.mocked(serverModuleTest).mockResolvedValue({ tests: 4, passed: 4, failures: [] });
    const run = await ogw(ws, ['core', 'test', 'server', '--json'], { env });
    expect(JSON.parse(run.stdout)).toMatchObject({ target: 'server', modules: { routing: 'pass' }, durationsMs: { routing: expect.any(Number) as number }, tests: 4, passed: 4 });
    expect(vi.mocked(serverModuleTest).mock.calls[0]?.[0]).toMatchObject({
      implDir: ws.coreImpl,
      module: 'routing',
      postgresql: {
        sqlite: expect.stringMatching(/^postgresql:\/\/postgres:[^@]+@127\.0\.0\.1:5555\/ogw_routing_1_s$/) as string,
        postgresql: expect.stringMatching(/^postgresql:\/\/postgres:[^@]+@127\.0\.0\.1:5555\/ogw_routing_1_p$/) as string,
      },
      resultsDir: expect.stringMatching(/ogw-core-test-[^/]+\/results$/) as string,
      env,
      maxWorkers: SERVER_WORKERS,
    });
    expect(parallelismOf({ kind: 'server' })).toBe(Math.max(1, Math.floor(availableParallelism() / SERVER_WORKERS)));
    const docker = log().filter((c) => (c as { docker?: string[] }).docker).map((c) => (c as { docker: string[] }).docker);
    // the labeled data volumes a killed run left are removed first
    expect(docker[0]).toEqual(['volume', 'prune', '--force', '--filter', 'label=ogw.postgres=throwaway']);
    // the password reaches the container only as a file through the stdin of docker cp, never on a command line
    expect(docker[1]?.slice(0, 6)).toEqual([
      'create', '--env', 'POSTGRES_PASSWORD_FILE=/ogw-postgres-password',
      '--mount', 'type=volume,dst=/var/lib/postgresql,volume-label=ogw.postgres=throwaway', '--rm',
    ]);
    // room for the connections and locks of every module run at once
    expect(docker[1]).toEqual(expect.arrayContaining(['--shm-size', '1g']));
    const image = docker[1]?.findIndex((arg) => arg.startsWith('postgres:')) ?? -1;
    expect(docker[1]?.[image]).toMatch(/^postgres:\d+\.\d+@sha256:[0-9a-f]{64}$/);
    expect(docker[1]?.slice(image + 1)).toEqual(['-c', 'max_connections=1000', '-c', 'max_locks_per_transaction=256', '-c', 'fsync=off', '-c', 'full_page_writes=off']);
    expect(docker.slice(2, 4)).toEqual([['cp', '-', 'cid123:/'], ['start', 'cid123']]);
    const tar = readFileSync(`${env.FAKE_LOG as string}.tar`);
    const password = tar.subarray(512, 512 + parseInt(tar.subarray(124, 135).toString('ascii'), 8)).toString('ascii');
    expect(password).toMatch(/^[A-Za-z0-9_-]{24}$/);
    for (const args of docker) expect(args.join(' ')).not.toContain(password);
    expect(docker).toContainEqual(['exec', 'cid123', 'createdb', '--username', 'postgres', 'ogw_routing_1_s']);
    expect(docker).toContainEqual(['exec', 'cid123', 'createdb', '--username', 'postgres', 'ogw_routing_1_p']);
    expect(docker.at(-1)).toEqual(['rm', '--force', '--volumes', 'cid123']);
    const data = log().find((c) => (c as { tool?: string }).tool === 'data') as { args: string[] };
    expect(data.args.slice(0, 3)).toEqual(['--game', join(ws.coreImpl, 'test-data'), '--base-proto']);
  });

  it('writes each module result to the job as soon as the module ends', async () => {
    const { ws, env } = setup();
    const jobs = join(ws.root, 'jobs');
    mkdirSync(jobs);
    const record = join(jobs, 'job2.json');
    writeFileSync(record, JSON.stringify({ id: 'job2', status: 'running', meta: {} }));
    const routingSpec = readFileSync(join(ws.coreImpl, 'core-spec', 'routing.json'), 'utf8');
    writeFileSync(join(ws.coreImpl, 'core-spec', 'testing.json'), routingSpec.replace('"routing"', '"testing"'));
    vi.mocked(serverImplementedModules).mockResolvedValueOnce(['routing', 'testing']);
    let seenWhileRunning: unknown = null;
    vi.mocked(serverModuleTest).mockImplementation(async (input) => {
      if (input.module === 'routing') return { tests: 1, passed: 1, failures: [] };
      for (let i = 0; i < 100 && seenWhileRunning === null; i++) {
        const meta = (JSON.parse(readFileSync(record, 'utf8')) as { meta: { modules?: Record<string, string> } }).meta;
        if (meta.modules?.routing === 'pass') seenWhileRunning = meta.modules;
        else await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { tests: 1, passed: 1, failures: [] };
    });
    const run = await ogw(ws, ['core', 'test', 'server'], { env: { ...env, OGW_JOB_ID: 'job2', OGW_JOBS_DIR: jobs } });
    expect(run.stderr).toBe('routing pass\ntesting pass\n');
    expect(run.code).toBe(0);
    expect(seenWhileRunning).toEqual({ routing: 'pass' });
    expect(JSON.parse(readFileSync(record, 'utf8'))).toMatchObject({ meta: { modules: { routing: 'pass', testing: 'pass' } } });
  });

  it('records nothing when HEAD moves or the checkout gets clean while the run goes', async () => {
    const { ws, env } = setup();
    vi.mocked(serverModuleTest).mockImplementation(() => {
      // `ogw agent merge` on the checkout during the run: main moves on, the status stays clean.
      writeFiles(ws.coreImpl, { 'merged.txt': 'x' });
      commitAll(ws.coreImpl, 'merge');
      return Promise.resolve({ tests: 1, passed: 1, failures: [] });
    });
    expect((await ogw(ws, ['core', 'test', 'server'], { env })).code).toBe(0);
    expect(await readTestRecords(ws.coreImpl)).toEqual([]);

    writeFileSync(join(ws.coreImpl, 'untracked.txt'), '');
    vi.mocked(serverModuleTest).mockImplementation(() => {
      sh(ws.coreImpl, 'rm', ['untracked.txt']);
      return Promise.resolve({ tests: 1, passed: 1, failures: [] });
    });
    expect((await ogw(ws, ['core', 'test', 'server'], { env })).code).toBe(0);
    expect(await readTestRecords(ws.coreImpl)).toEqual([]);

    vi.mocked(serverModuleTest).mockResolvedValue({ tests: 1, passed: 1, failures: [] });
    expect((await ogw(ws, ['core', 'test', 'server'], { env })).code).toBe(0);
    expect(await readTestRecords(ws.coreImpl)).toEqual([
      { commit: sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim(), target: 'server', modules: { routing: 'pass' }, recordedAt: expect.any(Number) as number },
    ]);
  });

  it('commits on main the generated files its build wrote in the main checkout, and records the run on that commit', async () => {
    const { ws, env } = setup();
    const stale = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    vi.mocked(writeCoreSpec).mockImplementation(() => {
      const file = join(ws.coreImpl, 'core-spec', 'routing.json');
      writeFileSync(file, `${JSON.stringify({ ...(JSON.parse(readFileSync(file, 'utf8')) as object), regenerated: true })}\n`);
      return Promise.resolve({ modules: new Map(), settingTypes: new Map(), errors: [], dir: '', written: [], deleted: [], settingTypesWritten: false });
    });
    vi.mocked(serverModuleTest).mockResolvedValue({ tests: 1, passed: 1, failures: [] });
    const ran = await ogw(ws, ['core', 'test', 'server'], { env });
    expect(ran, ran.stderr + ran.stdout).toMatchObject({ code: 0 });
    const head = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    expect(sh(ws.coreImpl, 'git', ['log', '-1', '--format=%P %s']).trim()).toBe(`${stale} ogw: regenerate generated files`);
    expect(sh(ws.coreImpl, 'git', ['status', '--porcelain']).trim()).toBe('');
    expect(sh(ws.coreImpl, 'git', ['diff', '--name-only', stale, head]).trim().split('\n')).toContain('core-spec/routing.json');
    expect(await readTestRecords(ws.coreImpl)).toEqual([{ commit: head, target: 'server', modules: { routing: 'pass' }, recordedAt: expect.any(Number) as number }]);
  });

  it('holds back a core merge on the main checkout until its module tests end', async () => {
    const { ws, env } = setup();
    let finish: () => void = () => undefined;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(serverModuleTest).mockImplementation(() => {
      started();
      return new Promise((resolve) => {
        finish = () => {
          resolve({ tests: 1, passed: 1, failures: [] });
        };
      });
    });
    const test = ogw(ws, ['core', 'test', 'server'], { env });
    await running;
    let merged = false;
    const merge = withCoreMain(ws.coreImpl, ws.env, () => {
      merged = true;
      return Promise.resolve();
    }, { readers: true });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(merged).toBe(false);
    finish();
    expect((await test).code).toBe(0);
    await merge;
    expect(merged).toBe(true);
  });

  it('counts a module that failed without a counted test as one failed test', async () => {
    const { ws, env } = setup();
    vi.mocked(serverModuleTest).mockRejectedValue(new Error('runner crashed'));
    const run = await ogw(ws, ['core', 'test', 'server', '--json'], { env });
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({
      modules: { routing: 'fail' },
      failures: { routing: ['runner crashed'] },
      counts: { routing: { tests: 0, passed: 0, ran: false } },
      tests: 1,
      passed: 0,
    });
  });

  it('runs the tool tests after checking each engine is on this host', async () => {
    const { ws, env } = setup();
    vi.mocked(runToolTest).mockImplementation((_ctx, _impl, tool) => Promise.resolve({ tests: 2, passed: tool === 'data-tool' ? 1 : 2, failures: tool === 'data-tool' ? ['roundtrip godot'] : [] }));
    const run = await ogw(ws, ['core', 'test', 'tools'], { env });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('contract-tool pass\ndata-tool fail\n  roundtrip godot\n');
    expect(requireEngine).toHaveBeenCalledWith(expect.anything(), 'godot', '4.5.1.stable');
  });

  it('gives a tool whose round trip was left out as skipped, with the reason, and a summary of its vitest tests', async () => {
    const { ws, env } = setup();
    vi.mocked(runToolTest).mockResolvedValue({ tests: 2, passed: 2, failures: [], skipped: 'godot round trip left out: x' });
    const run = await ogw(ws, ['core', 'test', 'tools', '--json'], { env });
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({
      modules: { 'contract-tool': 'skipped', 'data-tool': 'skipped' },
      skipped: { 'contract-tool': 'godot round trip left out: x', 'data-tool': 'godot round trip left out: x' },
      tests: 4,
      passed: 4,
    });
    expect((await ogw(ws, ['core', 'test', 'tools'], { env })).stdout).toBe('contract-tool skipped\n  godot round trip left out: x\ndata-tool skipped\n  godot round trip left out: x\n');
  });

  it('runs the tool tests before the server core exists: no base proto, core-spec/, licenses.json, core test data or fixture ID name check', async () => {
    const { ws, env } = setup();
    vi.mocked(runToolTest).mockResolvedValue({ tests: 1, passed: 1, failures: [] });
    vi.mocked(baseProtoErrors).mockResolvedValue(['skills/server-core/modules/auth.md:30: message LoginRequest is not in core.proto']);
    writeFiles(ws.coreImpl, { 'settings/core-settings.json': {} });
    // `create contract tool` writes no `test-data/` (the first step that does is `create server core` 4), and a
    // fixture may name an ID name no core test data has yet.
    sh(ws.coreImpl, 'rm', ['-r', 'server/core/routing', 'client/godot/core/log_core', 'test-data', 'licenses.json']);
    writeFiles(ws.coreImpl, { 'fixtures/text-format.json': { cases: [{ name: 'a', input: '[not_in_any_table]', expected: 1 }] } });
    expect(await ogw(ws, ['core', 'test', 'tools'], { env })).toMatchObject({ code: 0, stdout: 'contract-tool pass\ndata-tool pass\n' });
    expect(baseProtoErrors).not.toHaveBeenCalled();
    expect(vi.mocked(buildTool).mock.calls.map((c) => c[2])).not.toContain('data-tool');
  });
});
