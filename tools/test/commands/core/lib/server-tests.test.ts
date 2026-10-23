import { mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runEnv,
  runServerTests,
  serverModuleTest,
  serverRunFailures,
  serverTestEnv,
  unitTestResult,
  vitestArgs,
  vitestTestOptions,
  type ServerTestInputs,
  type ServerTestRun,
} from '../../../../src/commands/core/lib/server-tests.ts';
import { writeFiles } from '../helpers.ts';
import { useGitOnlyHarness } from '../../../helpers/workspace.ts';

function temp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'ogw-server-tests-')));
}

const INPUTS: ServerTestInputs = {
  serverModules: '/g/server/generated/server_modules.json',
  serverData: '/g/server/build/data',
  sharedFixtures: '/g/data/fixtures',
  coreFixtures: null,
  postgresql: null,
  defaultDb: 'sqlite',
};

useGitOnlyHarness();

describe('server test inputs', () => {
  it('gives only the inputs of the run as environment variables', () => {
    expect(serverTestEnv(INPUTS)).toEqual({
      OGW_SERVER_MODULES: '/g/server/generated/server_modules.json',
      OGW_SERVER_DATA: '/g/server/build/data',
      OGW_SHARED_FIXTURES: '/g/data/fixtures',
      OGW_DEFAULT_DB: 'sqlite',
    });
    expect(serverTestEnv({ ...INPUTS, serverModules: null, sharedFixtures: null, coreFixtures: '/i/fixtures', postgresql: 'postgresql://p', defaultDb: 'postgresql' })).toEqual({
      OGW_SERVER_DATA: '/g/server/build/data',
      OGW_CORE_FIXTURES: '/i/fixtures',
      OGW_POSTGRESQL: 'postgresql://p',
      OGW_DEFAULT_DB: 'postgresql',
    });
  });

  it('drops inherited inputs and keeps the rest of the environment', () => {
    const env = runEnv({ PATH: '/bin', OGW_POSTGRESQL: 'old', OGW_CORE_FIXTURES: 'old', OGW_HARNESS_ROOT: '/h' }, INPUTS);
    expect(env.PATH).toBe('/bin');
    expect(env.OGW_HARNESS_ROOT).toBe('/h');
    expect(env.OGW_POSTGRESQL).toBeUndefined();
    expect(env.OGW_CORE_FIXTURES).toBeUndefined();
    expect(env.OGW_DEFAULT_DB).toBe('sqlite');
  });

  it('runs vitest with globals on *.test.ts and the json reporter', () => {
    expect(vitestTestOptions()).toMatchObject({ include: ['**/*.test.ts'], globals: true, includeTaskLocation: true, watch: false });
    const options = { checkout: '/g', target: 'server/tests', kind: 'regression' as const, inputs: INPUTS, env: {}, timeoutMs: 1 };
    const args = vitestArgs(options, '/w/c.mjs', '/w/r.json', false);
    expect(args[0]).toMatch(/node_modules[/\\]vitest[/\\]vitest\.mjs$/);
    expect(args.slice(1)).toEqual(['run', '--config', '/w/c.mjs', '--root', join('/g', 'server'), '--dir', join('/g', 'server', 'tests'), '--reporter=json', '--outputFile=/w/r.json']);
    const file = vitestArgs({ ...options, target: 'server/tests/a/b.test.ts' }, '/w/c.mjs', '/w/r.json', true);
    expect(file.slice(6)).toEqual(['--dir', join('/g', 'server', 'tests', 'a'), '--reporter=json', '--outputFile=/w/r.json', join('/g', 'server', 'tests', 'a', 'b.test.ts')]);
  });
});

describe('unit-test-core result', () => {
  it('names tests by checkout path and titles, maps statuses and reports load failures and no tests', () => {
    const meta = { runId: 'r1', kind: 'regression' as const, checkout: '/g', startedAt: 5, finishedAt: 9 };
    const result = unitTestResult({
      testResults: [
        {
          name: '/g/server/tests/a.test.ts',
          status: 'failed',
          assertionResults: [
            { ancestorTitles: ['shop', 'buy'], title: 'works', status: 'passed', duration: 1.6, location: { line: 3 } },
            { ancestorTitles: [], title: 'breaks', status: 'failed', failureMessages: ['AssertionError: no\n  at x'], location: { line: 9 } },
            { title: 'later', status: 'todo' },
            { title: 'off', status: 'skipped' },
          ],
        },
        { name: '/g/server/tests/b.test.ts', status: 'failed', message: 'Cannot find module x\nmore', assertionResults: [] },
        { name: '/g/server/tests/c.test.ts', status: 'passed', assertionResults: [] },
      ],
    }, meta);
    expect(result).toEqual({
      run_id: 'r1', kind: 'regression', engine: 'server', started_at: 5, finished_at: 9, warn_counts: {},
      results: [
        { name: 'server/tests/a.test.ts::shop > buy > works', status: 'pass', duration_ms: 2, message: '', where: 'server/tests/a.test.ts:3' },
        { name: 'server/tests/a.test.ts::breaks', status: 'fail', duration_ms: 0, message: 'AssertionError: no', where: 'server/tests/a.test.ts:9' },
        { name: 'server/tests/a.test.ts::later', status: 'skip', duration_ms: 0, message: '', where: 'server/tests/a.test.ts:1' },
        { name: 'server/tests/a.test.ts::off', status: 'skip', duration_ms: 0, message: '', where: 'server/tests/a.test.ts:1' },
      ],
      run_failures: [{ message: 'server/tests/b.test.ts: Cannot find module x' }],
    });
    expect(unitTestResult({}, meta).run_failures).toEqual([{ message: 'no tests' }]);
  });

  it('reports a failed file whose tests did not fail, as after a throwing beforeAll or afterAll', () => {
    const meta = { runId: 'r2', kind: 'core' as const, checkout: '/g', startedAt: 0, finishedAt: 1 };
    const result = unitTestResult({
      testResults: [
        { name: '/g/server/core/x/tests/before.test.ts', status: 'failed', message: 'Error: boom\n  at x', assertionResults: [{ title: 't1', status: 'skipped' }] },
        { name: '/g/server/core/x/tests/after.test.ts', status: 'failed', message: 'Error: late', assertionResults: [{ title: 't2', status: 'passed' }] },
      ],
    }, meta);
    expect(result.results.map((r) => [r.name, r.status])).toEqual([
      ['server/core/x/tests/before.test.ts::t1', 'skip'],
      ['server/core/x/tests/after.test.ts::t2', 'pass'],
    ]);
    expect(result.run_failures).toEqual([
      { message: 'server/core/x/tests/before.test.ts: Error: boom' },
      { message: 'server/core/x/tests/after.test.ts: Error: late' },
    ]);
  });
});

describe('judgement', () => {
  const base = (results: ServerTestRun['result']): ServerTestRun => ({ result: results, output: 'out line\nmore', timedOut: false, exitCode: 1 });
  const result = {
    run_id: 'r', kind: 'core' as const, engine: 'server' as const, started_at: 0, finished_at: 0, warn_counts: {},
    results: [
      { name: 'f::a', status: 'pass' as const, duration_ms: 0, message: '', where: 'f:1' },
      { name: 'f::b', status: 'fail' as const, duration_ms: 0, message: 'bad', where: 'f:2' },
      { name: 'f::c', status: 'skip' as const, duration_ms: 0, message: '', where: 'f:3' },
    ],
    run_failures: [{ message: 'no tests' }],
  };

  it('fails on failed tests and run failures, and on skips only in a regression test', () => {
    expect(serverRunFailures(base(result), 'core', 'server/tests', 7)).toEqual([
      { where: 'f:2', message: 'f::b bad' },
      { where: 'server/tests', message: 'run failure: no tests' },
    ]);
    expect(serverRunFailures(base(result), 'regression', 'server/tests', 7)).toContainEqual({ where: 'f:3', message: 'f::c skipped; a regression test does not skip' });
  });

  it('fails a run whose vitest exit code is not 0 when no test or run failure explains it', () => {
    const passed = { ...result, results: [result.results[0] as (typeof result.results)[number]], run_failures: [] };
    expect(serverRunFailures(base(passed), 'core', 'server/tests', 7)).toEqual([{ where: 'server/tests', message: 'run failure: vitest ended with exit code 1: out line' }]);
    expect(serverRunFailures({ ...base(passed), exitCode: 0 }, 'core', 'server/tests', 7)).toEqual([]);
    expect(serverRunFailures(base(result), 'core', 'server/tests', 7)).toHaveLength(2);
  });

  it('fails a run without a result and a run past its time limit', () => {
    expect(serverRunFailures(base(null), 'core', 'w', 7)).toEqual([{ where: 'w', message: 'the test run wrote no result: out line' }]);
    expect(serverRunFailures({ ...base(null), timedOut: true }, 'core', 'w', 7)).toEqual([{ where: 'w', message: 'test run did not end within 7 ms' }]);
  });
});

const SERVER_TEST = `
describe('env', () => {
  it('reads the inputs', () => {
    expect(process.env.OGW_DEFAULT_DB === 'sqlite' || process.env.OGW_DEFAULT_DB === 'postgresql').toBe(true);
    expect(process.env.OGW_CORE_FIXTURES?.endsWith('fixtures')).toBe(true);
  });
  it('fails on postgresql', () => {
    expect(process.env.OGW_DEFAULT_DB).toBe('sqlite');
  });
});
`;

describe('vitest runs', () => {
  it('runs a game regression test folder and one test file with the vitest of ogw', async () => {
    const game = temp();
    writeFiles(game, {
      'server/tests/a.test.ts': "it('a', () => { expect(process.env.OGW_SHARED_FIXTURES).toBe('/g/data/fixtures'); });\n",
      'server/tests/sub/b.test.ts': "it('b', () => { expect(1).toBe(2); });\n",
      'server/core/x/tests/c.test.ts': "it('c', () => undefined);\n",
    });
    const options = { checkout: game, target: 'server/tests', kind: 'regression' as const, inputs: INPUTS, env: process.env, timeoutMs: 60_000 };
    const all = await runServerTests(options);
    expect(all.result?.results.map((r) => [r.name, r.status])).toEqual([
      ['server/tests/a.test.ts::a', 'pass'],
      ['server/tests/sub/b.test.ts::b', 'fail'],
    ]);
    expect(all.exitCode).toBe(1);
    const one = await runServerTests({ ...options, target: 'server/tests/a.test.ts' });
    expect(one.result?.results.map((r) => r.name)).toEqual(['server/tests/a.test.ts::a']);
    expect(serverRunFailures(one, 'regression', 'server/tests', 1)).toEqual([]);
  }, 60_000);

  it('runs a module core test once with sqlite and once with postgresql and keeps each result file', async () => {
    const impl = temp();
    const results = temp();
    writeFiles(impl, { 'server/core/storage/tests/env.test.ts': SERVER_TEST, 'server/core/storage/index.ts': 'export {};\n' });
    const outcome = await serverModuleTest({ implDir: impl, module: 'storage', postgresql: { sqlite: 'postgresql://s', postgresql: 'postgresql://p' }, resultsDir: results, timeoutMs: 60_000, env: process.env });
    expect(outcome.tests).toBe(4);
    expect(outcome.passed).toBe(3);
    expect(outcome.failures).toEqual([expect.stringMatching(/^postgresql run: server\/core\/storage\/tests\/env\.test\.ts::env > fails on postgresql AssertionError/) as string]);
    const files = readdirSync(results);
    expect(files).toHaveLength(2);
    const kinds = files.map((f) => (JSON.parse(readFileSync(join(results, f), 'utf8')) as { kind: string; engine: string }));
    expect(kinds.every((k) => k.kind === 'core' && k.engine === 'server')).toBe(true);
  }, 60_000);

  it('runs only the --file test file of a module, in both runs', async () => {
    const impl = temp();
    const results = temp();
    writeFiles(impl, {
      'server/core/storage/tests/a.test.ts': "it('a', () => undefined);\n",
      'server/core/storage/tests/b.test.ts': "it('b', () => undefined);\n",
      'server/core/storage/index.ts': 'export {};\n',
    });
    const outcome = await serverModuleTest({ implDir: impl, module: 'storage', postgresql: { sqlite: 'postgresql://s', postgresql: 'postgresql://p' }, resultsDir: results, timeoutMs: 60_000, env: process.env, file: 'server/core/storage/tests/b.test.ts' });
    expect(outcome).toMatchObject({ tests: 2, passed: 2, failures: [] });
    const runs = readdirSync(results).map((f) => JSON.parse(readFileSync(join(results, f), 'utf8')) as { results: { name: string }[] });
    expect(runs.map((r) => r.results.map((t) => t.name))).toEqual([['server/core/storage/tests/b.test.ts::b'], ['server/core/storage/tests/b.test.ts::b']]);
  }, 60_000);

  it('gives each run its own temp folder in its work folder and the connection string of its database', async () => {
    const impl = temp();
    const seen = temp();
    const test = `import { writeFileSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nit('env', () => { writeFileSync(${JSON.stringify(seen)} + '/' + process.env.OGW_DEFAULT_DB + '.json', JSON.stringify({ tmp: tmpdir(), postgresql: process.env.OGW_POSTGRESQL })); });\n`;
    writeFiles(impl, { 'server/core/storage/tests/env.test.ts': test, 'server/core/storage/index.ts': 'export {};\n' });
    const outcome = await serverModuleTest({ implDir: impl, module: 'storage', postgresql: { sqlite: 'postgresql://s', postgresql: 'postgresql://p' }, resultsDir: temp(), timeoutMs: 60_000, env: process.env });
    expect(outcome.failures).toEqual([]);
    const read = (db: string): { tmp: string; postgresql: string } => JSON.parse(readFileSync(join(seen, `${db}.json`), 'utf8')) as { tmp: string; postgresql: string };
    const sqlite = read('sqlite');
    const postgresql = read('postgresql');
    expect([sqlite.postgresql, postgresql.postgresql]).toEqual(['postgresql://s', 'postgresql://p']);
    expect(sqlite.tmp).not.toBe(postgresql.tmp);
    for (const { tmp } of [sqlite, postgresql]) {
      expect(basename(tmp)).toBe('tmp');
      expect(basename(dirname(tmp))).toMatch(/^ogw-server-test-/);
    }
  }, 60_000);

  it('fails a module core test whose beforeAll throws', async () => {
    const impl = temp();
    writeFiles(impl, {
      'server/core/storage/tests/hook.test.ts': "describe('s', () => {\n  beforeAll(() => { throw new Error('boom'); });\n  it('t1', () => undefined);\n  it('t2', () => undefined);\n});\n",
      'server/core/storage/index.ts': 'export {};\n',
    });
    const outcome = await serverModuleTest({ implDir: impl, module: 'storage', postgresql: { sqlite: 'postgresql://s', postgresql: 'postgresql://p' }, resultsDir: temp(), timeoutMs: 60_000, env: process.env });
    expect(outcome.failures).toEqual([
      expect.stringMatching(/^sqlite run: run failure: server\/core\/storage\/tests\/hook\.test\.ts: the file failed outside its tests$/) as string,
      expect.stringMatching(/^postgresql run: run failure: server\/core\/storage\/tests\/hook\.test\.ts: the file failed outside its tests$/) as string,
    ]);
  }, 60_000);

  it('counts a module whose vitest was started as run, whatever its result: a test file that does not load, a run at its time limit', async () => {
    const impl = temp();
    writeFiles(impl, {
      'server/core/storage/tests/load.test.ts': "import { missing } from '../nothing.ts';\nit('t', () => { missing(); });\n",
      'server/core/storage/index.ts': 'export {};\n',
    });
    const loaded = await serverModuleTest({ implDir: impl, module: 'storage', postgresql: { sqlite: 'postgresql://s', postgresql: 'postgresql://p' }, resultsDir: temp(), timeoutMs: 60_000, env: process.env });
    expect(loaded.failures.length).toBeGreaterThan(0);
    expect(loaded.ran).not.toBe(false);
    // stopped by its time limit with no report: vitest was started
    const stopped = await serverModuleTest({ implDir: impl, module: 'storage', postgresql: { sqlite: 'postgresql://s', postgresql: 'postgresql://p' }, resultsDir: temp(), timeoutMs: 1, env: process.env });
    expect(stopped.failures.length).toBeGreaterThan(0);
    expect(stopped.ran).not.toBe(false);
  }, 60_000);
});
