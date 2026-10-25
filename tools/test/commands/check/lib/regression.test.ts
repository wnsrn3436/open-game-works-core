import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as realSleep } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  checkedScriptErrors,
  engineErrorLines,
  gutTarget,
  regressionInputs,
  regressionTargets,
  regressionTest,
} from '../../../../src/commands/check/lib/regression.ts';
import { godotDataVariable } from '../../../../src/commands/core/lib/godot.ts';
import { startPostgres } from '../../../../src/commands/core/lib/postgres.ts';
import { LIMITS } from '../../../../src/lib/limits.ts';
import { fakeContext } from '../helpers.ts';
import { gitOnlyHarness } from '../../../helpers/workspace.ts';

vi.mock('../../../../src/commands/core/lib/postgres.ts', () => ({ startPostgres: vi.fn() }));

const ctx = { ...fakeContext(), env: { ...process.env, OGW_HARNESS_ROOT: gitOnlyHarness() } };

function gameRoot(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ogw-reg-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/**
 * A fake `godot`: `--import` appends whether the checkout's import lock was held to `imports`, writes `client/.godot/` and ends with `importCode`;
 * a test run writes its argv to `args.json` and its `user://` variable to `data.json`,
 * sends `result` to the test host (unless null) and then writes `sent`, prints `output`, and ends with `code` (or hangs).
 */
function fakeGodot(behavior: { importCode?: number; result?: unknown; output?: string; code?: number; hang?: boolean; start?: boolean }): { path: string; argsFile: string; sentFile: string; importsFile: string; dataFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ogw-godot-'));
  const argsFile = join(dir, 'args.json');
  const sentFile = join(dir, 'sent');
  const importsFile = join(dir, 'imports');
  const dataFile = join(dir, 'data.json');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--import')) {
  const lock = path.join(args[args.indexOf('--path') + 1], '..', '.ogw-import.lock');
  fs.appendFileSync(${JSON.stringify(importsFile)}, (fs.existsSync(lock) ? 'locked' : 'unlocked') + '\\n');
  fs.mkdirSync(path.join(args[args.indexOf('--path') + 1], '.godot'), { recursive: true });
  process.exit(${String(behavior.importCode ?? 0)});
}
const data = process.env[${JSON.stringify(godotDataVariable())}];
fs.writeFileSync(${JSON.stringify(dataFile)}, JSON.stringify({ data, exists: data !== undefined && fs.existsSync(data) }));
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
const config = fs.readFileSync(args.find((a) => a.startsWith('-gconfig=')).slice('-gconfig='.length), 'utf8');
fs.writeFileSync(${JSON.stringify(argsFile)} + '.config', config);
const host = JSON.parse(config).ogw_test_host;
(async () => {
  if (${String(behavior.start === true)}) await fetch(host + '/started', { method: 'PUT', body: JSON.stringify({ run_id: JSON.parse(config).ogw_run_id }) });
  const result = ${JSON.stringify(behavior.result ?? null)};
  if (result !== null) await fetch(host + '/result', { method: 'PUT', body: JSON.stringify(result) });
  fs.writeFileSync(${JSON.stringify(sentFile)}, '');
  process.stdout.write(${JSON.stringify(behavior.output ?? '')});
  if (${String(behavior.hang === true)}) setInterval(() => {}, 1000);
  else process.exit(${String(behavior.code ?? 0)});
})();
`;
  const path = join(dir, 'godot');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return { path, argsFile, sentFile, importsFile, dataFile };
}

const passing = {
  run_id: 'r',
  kind: 'regression',
  results: [{ name: 'res://tests/shop/test_buy.gd::test_buy_ok', status: 'pass', duration_ms: 1, message: '' }],
  run_failures: [],
  warn_counts: {},
};

describe('regression targets and helpers', () => {
  it('resolves the path to a client or server target', async () => {
    const root = gameRoot({ 'client/tests/shop/test_buy.gd': '', 'server/tests/shop.test.ts': '' });
    expect(await regressionTargets(root, undefined)).toEqual({ client: 'client/tests', server: 'server/tests' });
    expect(await regressionTargets(root, './client/tests/shop/')).toEqual({ client: 'client/tests/shop', server: null });
    expect(await regressionTargets(root, 'client/tests')).toEqual({ client: 'client/tests', server: null });
    expect(await regressionTargets(root, 'server/tests/shop.test.ts')).toEqual({ client: null, server: 'server/tests/shop.test.ts' });
    await expect(regressionTargets(root, 'client/testsx')).rejects.toThrow('regression test path must be under client/tests/ or server/tests/: client/testsx');
    await expect(regressionTargets(root, 'client/tests/none.gd')).rejects.toThrow('regression test path does not exist: client/tests/none.gd');
    expect(await regressionTargets(root, 'client/./tests//shop')).toEqual({ client: 'client/tests/shop', server: null });
    for (const outside of ['server/tests/../../../other/server/tests', 'client/tests/../../server/tests', 'client/tests/..', `${root}/client/tests`, '/client/tests']) {
      await expect(regressionTargets(root, outside)).rejects.toThrow(`regression test path must be under client/tests/ or server/tests/: ${outside}`);
    }
  });

  it('gutTarget gives -gtest for a file and -gdir for a folder', () => {
    expect(gutTarget('client/tests/shop/test_buy.gd')).toEqual(['-gtest=res://tests/shop/test_buy.gd']);
    expect(gutTarget('client/tests')).toEqual(['-gdir=res://tests', '-ginclude_subdirs', '-gprefix=test_', '-gsuffix=.gd']);
  });

  it('engineErrorLines finds lines that hold SCRIPT ERROR:, ERROR: or leaked at exit, as the core test rule does', () => {
    expect(engineErrorLines('ok\n  SCRIPT ERROR: x\nERROR: y\nWARNING: ObjectDB instances leaked at exit\nsome ERROR: z\r\nUSER ERROR: u\nerror: lower\n')).toEqual([
      '  SCRIPT ERROR: x',
      'ERROR: y',
      'WARNING: ObjectDB instances leaked at exit',
      'some ERROR: z',
      'USER ERROR: u',
    ]);
  });

  it('leaves out the SCRIPT ERROR: lines only when the tests checked exactly that many', () => {
    const output = 'SCRIPT ERROR: a\n   at: f (res://x.gd:1)\nSCRIPT ERROR: b\nERROR: c\n';
    expect(engineErrorLines(output, 2)).toEqual(['ERROR: c']);
    expect(engineErrorLines(output, 1)).toEqual(['SCRIPT ERROR: a', 'SCRIPT ERROR: b', '2 SCRIPT ERROR lines, checked_script_errors 1', 'ERROR: c']);
    expect(engineErrorLines(output, 0)).toEqual(['SCRIPT ERROR: a', 'SCRIPT ERROR: b', 'ERROR: c']);
    // a checked error the engine did not print is a difference too
    expect(engineErrorLines(output, 3)).toEqual(['SCRIPT ERROR: a', 'SCRIPT ERROR: b', '2 SCRIPT ERROR lines, checked_script_errors 3', 'ERROR: c']);
    expect(engineErrorLines('ok\n', 1)).toEqual(['0 SCRIPT ERROR lines, checked_script_errors 1']);
    expect(checkedScriptErrors({ results: [{ checked_script_errors: 1 }, { checked_script_errors: 1 }, { checked_script_errors: 'x' }, {}] })).toBe(2);
    expect(checkedScriptErrors(null)).toBe(0);
  });
});

describe('regressionTest', () => {
  it('runs GUT on client/tests with the test host and passes', async () => {
    const root = gameRoot({ 'client/tests/shop/test_buy.gd': 'func test_buy_ok():\n' });
    const godot = fakeGodot({ result: passing, output: 'All tests passed\n' });
    const out = mkdtempSync(join(tmpdir(), 'ogw-out-'));
    const result = await regressionTest(ctx, root, { client: 'client/tests', server: null }, {
      godot: godot.path,
      evidence: { root: out, dir: 'ev', relative: true },
      runTimeLimitMs: 30_000, startTimeLimitMs: null,
    });
    expect(result).toEqual({ name: 'regression test', platform: null, result: 'pass', failures: [], warnings: [] });
    const args = JSON.parse(readFileSync(godot.argsFile, 'utf8')) as string[];
    expect(args.slice(0, 5)).toEqual(['--headless', '--path', join(root, 'client'), '-s', 'addons/gut/gut_cmdln.gd']);
    expect(args).toContain('-gdir=res://tests');
    expect(args).toContain('-gpre_run_script=res://core/unit_test_core/dev/gut_pre_run.gd');
    expect(args).toContain('-gpost_run_script=res://core/unit_test_core/dev/gut_post_run.gd');
    // the run's values go in the test run config file that -gconfig names, not after `--`
    expect(args[args.indexOf('-gexit') + 1]).toMatch(/^-gconfig=/);
    expect(args).not.toContain('--');
    const config = JSON.parse(readFileSync(`${godot.argsFile}.config`, 'utf8')) as Record<string, string>;
    expect(config.ogw_shared_fixture_dir).toBe(join(root, 'data', 'fixtures'));
    expect(config.ogw_run_id).toMatch(/^[0-9a-z]{9,}$/);
    expect(JSON.parse(readFileSync(join(out, 'ev/regression/client-result.json'), 'utf8'))).toEqual(passing);
    expect(readFileSync(join(out, 'ev/regression/client-output.log'), 'utf8')).toBe('All tests passed\n');
    // the import holds the lock the runner's import takes
    expect(readFileSync(godot.importsFile, 'utf8')).toBe('locked\n');
    expect(existsSync(join(root, '.ogw-import.lock'))).toBe(false);
  });

  it('gives the GUT run a user:// folder of its own and removes it after the run', async () => {
    const root = gameRoot({ 'client/tests/shop/test_buy.gd': 'func test_buy_ok():\n' });
    const godot = fakeGodot({ result: passing });
    const evidence = { root: mkdtempSync(join(tmpdir(), 'ogw-out-')), dir: null, relative: true };
    const shared = mkdtempSync(join(tmpdir(), 'ogw-shared-data-'));
    const sharedCtx = { ...ctx, env: { ...ctx.env, [godotDataVariable()]: shared } };
    expect((await regressionTest(sharedCtx, root, { client: 'client/tests', server: null }, { godot: godot.path, evidence, runTimeLimitMs: 30_000, startTimeLimitMs: null })).result).toBe('pass');
    const seen = JSON.parse(readFileSync(godot.dataFile, 'utf8')) as { data: string; exists: boolean };
    expect(seen.exists).toBe(true);
    expect(seen.data).not.toBe(shared);
    expect(existsSync(seen.data)).toBe(false);
  });

  it('does not import again when the checkout was just imported', async () => {
    const root = gameRoot({ 'client/tests/shop/test_buy.gd': 'func test_buy_ok():\n' });
    const godot = fakeGodot({ result: passing });
    const evidence = { root: mkdtempSync(join(tmpdir(), 'ogw-out-')), dir: null, relative: true };
    const options = { godot: godot.path, evidence, runTimeLimitMs: 30_000, startTimeLimitMs: null, imported: true };
    expect((await regressionTest(ctx, root, { client: 'client/tests', server: null }, options)).result).toBe('pass');
    expect(existsSync(godot.importsFile)).toBe(false);
  });

  it('passes a run whose SCRIPT ERROR: lines are the ones its tests checked, and fails one with more', async () => {
    const root = gameRoot({ 'client/tests/shop/test_buy.gd': 'func test_buy_ok():\n' });
    const result = { ...passing, results: [{ name: 'res://tests/shop/test_buy.gd::test_buy_ok', status: 'pass', message: '', checked_script_errors: 1 }] };
    const run = async (output: string) => {
      const godot = fakeGodot({ result, output });
      const evidence = { root: mkdtempSync(join(tmpdir(), 'ogw-out-')), dir: null, relative: true };
      return regressionTest(ctx, root, { client: 'client/tests', server: null }, { godot: godot.path, evidence, runTimeLimitMs: 30_000, startTimeLimitMs: null });
    };
    expect((await run('SCRIPT ERROR: checked\n')).result).toBe('pass');
    const more = await run('SCRIPT ERROR: checked\nSCRIPT ERROR: other\n');
    expect(more.result).toBe('fail');
    expect(more.failures.map((f) => f.message)).toEqual(['engine output: SCRIPT ERROR: checked', 'engine output: SCRIPT ERROR: other', 'engine output: 2 SCRIPT ERROR lines, checked_script_errors 1']);
  });

  it('reports failed tests at their func line, run failures, exit code and engine errors', async () => {
    const root = gameRoot({ 'client/tests/shop/test_buy.gd': 'extends UnitTestCase\n\nfunc test_buy_ok():\n\tpass\n' });
    const result = {
      ...passing,
      results: [
        { name: 'res://tests/shop/test_buy.gd::test_buy_ok', status: 'fail', message: 'expected 3 got 2' },
        { name: 'res://tests/shop/test_buy.gd::test_gone', status: 'fail', message: 'x' },
        { name: 'res://tests/other.gd::test_skip', status: 'skip', message: '' },
      ],
      run_failures: [{ message: 'no tests' }],
    };
    const godot = fakeGodot({ result, output: 'SCRIPT ERROR: boom\n', code: 1 });
    const out = mkdtempSync(join(tmpdir(), 'ogw-out-'));
    const checked = await regressionTest(ctx, root, { client: 'client/tests/shop/test_buy.gd', server: null }, {
      godot: godot.path,
      evidence: { root: out, dir: 'ev', relative: false },
      runTimeLimitMs: null, startTimeLimitMs: null,
    });
    const evidence = [join(out, 'ev/regression/client-result.json'), join(out, 'ev/regression/client-output.log')];
    expect(checked.result).toBe('fail');
    expect(checked.failures).toEqual([
      { where: 'client/tests/shop/test_buy.gd:3', message: 'res://tests/shop/test_buy.gd::test_buy_ok expected 3 got 2', evidence },
      { where: 'client/tests/shop/test_buy.gd:1', message: 'res://tests/shop/test_buy.gd::test_gone x', evidence },
      { where: 'client/tests/shop/test_buy.gd:1', message: 'run failure: no tests', evidence },
      { where: 'client/tests/shop/test_buy.gd:1', message: 'exit code 1', evidence },
      { where: 'client/tests/shop/test_buy.gd:1', message: 'engine output: SCRIPT ERROR: boom', evidence },
    ]);
    expect(JSON.parse(readFileSync(godot.argsFile, 'utf8'))).toContain('-gtest=res://tests/shop/test_buy.gd');
  });

  it('fails when import fails, no result comes, or the run passes its time limit', async () => {
    const root = gameRoot();
    const evidence = { root: mkdtempSync(join(tmpdir(), 'ogw-out-')), dir: null, relative: true };
    const importFails = await regressionTest(ctx, root, { client: 'client/tests', server: null }, { godot: fakeGodot({ importCode: 3 }).path, evidence, runTimeLimitMs: 1, startTimeLimitMs: null });
    expect(importFails.failures).toEqual([{ where: 'client/tests:1', message: 'godot --import failed (3)', evidence: [] }]);
    const silent = await regressionTest(ctx, root, { client: 'client/tests', server: null }, { godot: fakeGodot({}).path, evidence, runTimeLimitMs: 1, startTimeLimitMs: null });
    expect(silent.failures).toEqual([{ where: 'client/tests:1', message: 'the test run sent no result', evidence: [] }]);
  });

  it('ends a run that sends no PUT /started within UnitTestCore.startTimeLimitMs and keeps one that started', async () => {
    const root = gameRoot();
    const evidence = { root: mkdtempSync(join(tmpdir(), 'ogw-out-')), dir: null, relative: true };
    const started = Date.now();
    const stalled = await regressionTest(ctx, root, { client: 'client/tests', server: null }, { godot: fakeGodot({ hang: true }).path, evidence, runTimeLimitMs: 60_000, startTimeLimitMs: 300 });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(stalled.failures.map((f) => f.message)).toContain('test run did not start within 300 ms (no PUT /started)');
    const ran = await regressionTest(ctx, root, { client: 'client/tests', server: null }, { godot: fakeGodot({ start: true, result: passing }).path, evidence, runTimeLimitMs: 60_000, startTimeLimitMs: 300 });
    expect(ran.failures).toEqual([]);
  }, 60_000);

  it('a failed import removes client/.godot/; a failure of the caller\'s import is reported without importing again', async () => {
    const root = gameRoot();
    const evidence = { root: mkdtempSync(join(tmpdir(), 'ogw-out-')), dir: null, relative: true };
    await regressionTest(ctx, root, { client: 'client/tests', server: null }, { godot: fakeGodot({ importCode: 3 }).path, evidence, runTimeLimitMs: 1, startTimeLimitMs: null });
    expect(existsSync(join(root, 'client', '.godot'))).toBe(false);
    const godot = fakeGodot({ result: passing });
    const options = { godot: godot.path, evidence, runTimeLimitMs: 1, startTimeLimitMs: null, importFailure: 'godot --import failed (timed out)' };
    const reported = await regressionTest(ctx, root, { client: 'client/tests', server: null }, options);
    expect(reported.failures).toEqual([{ where: 'client/tests:1', message: 'godot --import failed (timed out)', evidence: [] }]);
    expect(existsSync(godot.importsFile)).toBe(false);
    expect(existsSync(godot.argsFile)).toBe(false);
  });

  it('a run past UnitTestCore.runTimeLimitMs fails', { timeout: 60_000 }, async () => {
    const root = gameRoot();
    const evidence = { root: mkdtempSync(join(tmpdir(), 'ogw-out-')), dir: null, relative: true };
    const godot = fakeGodot({ result: passing, hang: true });
    const limitMs = 1000 + LIMITS.shortMs;
    // The run's time limit timer is a fake timer: it fires only when the test moves the clock, after the result came.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const checking = regressionTest(ctx, root, { client: 'client/tests', server: null }, { godot: godot.path, evidence, runTimeLimitMs: 1000, startTimeLimitMs: null }).finally(() => {
        settled = true;
      });
      while (!existsSync(godot.sentFile)) await realSleep(10);
      await vi.advanceTimersByTimeAsync(limitMs - 1);
      await realSleep(50);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const hang = await checking;
      expect(hang.failures).toEqual([{ where: 'client/tests:1', message: `test run did not end within ${String(limitMs)} ms`, evidence: [] }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs server regression tests with vitest and the testing inputs; a folder without tests is run failure no tests', async () => {
    const options = { godot: '/nonexistent', evidence: { root: '/tmp', dir: null, relative: true }, runTimeLimitMs: null, startTimeLimitMs: null };
    const empty = gameRoot({ 'server/tests/README': 'x', 'server/tests/helper.ts': '' });
    const noTests = { name: 'regression test', platform: null, result: 'fail', failures: [{ where: 'server/tests:1', message: 'run failure: no tests', evidence: [] }], warnings: [] };
    expect(await regressionTest(ctx, empty, { client: null, server: 'server/tests' }, options)).toEqual(noTests);
    expect(await regressionTest(ctx, gameRoot(), { client: null, server: 'server/tests' }, options)).toEqual(noTests);
    const root = gameRoot({
      'server/tests/shop/buy.test.ts': "it('buys', () => { expect(process.env.OGW_DEFAULT_DB).toBe('sqlite'); expect(process.env.OGW_POSTGRESQL).toBeUndefined(); });\n",
      'server/tests/shop/sell.test.ts': "describe('sell', () => { it('sells', () => { expect(1).toBe(2); }); it.skip('later', () => undefined); });\n",
    });
    const dir = mkdtempSync(join(tmpdir(), 'ogw-reg-ev-'));
    const evidence = { root: dir, dir: 'e', relative: true };
    const one = await regressionTest(ctx, root, { client: null, server: 'server/tests/shop/buy.test.ts' }, { ...options, evidence });
    expect(one.result).toBe('pass');
    const all = await regressionTest(ctx, root, { client: null, server: 'server/tests' }, { ...options, evidence });
    expect(all.result).toBe('fail');
    expect(all.failures.map((f) => [f.where, f.message.split('\n')[0]])).toEqual([
      ['server/tests/shop/sell.test.ts:1', 'server/tests/shop/sell.test.ts::sell > sells AssertionError: expected 1 to be 2 // Object.is equality'],
      ['server/tests/shop/sell.test.ts:1', 'server/tests/shop/sell.test.ts::sell > later skipped; a regression test does not skip'],
    ]);
    expect(all.failures[0]?.evidence).toEqual(['e/regression/server-result.json', 'e/regression/server-output.log']);
    const result = JSON.parse(readFileSync(join(dir, 'e', 'regression', 'server-result.json'), 'utf8')) as { kind: string; engine: string; results: unknown[] };
    expect(result).toMatchObject({ kind: 'regression', engine: 'server' });
    expect(result.results).toHaveLength(3);
  }, 60_000);

  it('gives the server regression test the testing inputs, and a throwaway PostgreSQL with --db postgresql', async () => {
    expect(regressionInputs('/g', null)).toEqual({
      serverModules: join('/g', 'server', 'generated', 'server_modules.json'),
      serverData: join('/g', 'server', 'build', 'data'),
      sharedFixtures: join('/g', 'data', 'fixtures'),
      coreFixtures: null,
      postgresql: null,
      defaultDb: 'sqlite',
    });
    expect(regressionInputs('/g', 'postgresql://x')).toMatchObject({ postgresql: 'postgresql://x', defaultDb: 'postgresql' });
    const remove = vi.fn(() => Promise.resolve());
    vi.mocked(startPostgres).mockResolvedValue({ id: 'c', createDatabase: (name) => Promise.resolve(`postgresql://p/${name}`), remove });
    const withSettings = { ...ctx, settings: () => Promise.resolve({ tools: { postgresql: { tag: '17', digest: 'sha256:x' } } }) } as unknown as typeof ctx;
    const root = gameRoot({ 'server/tests/db.test.ts': "it('db', () => { expect(process.env.OGW_POSTGRESQL).toBe('postgresql://p/ogw_regression'); expect(process.env.OGW_DEFAULT_DB).toBe('postgresql'); });\n" });
    const options = { godot: '/nonexistent', evidence: { root: '/tmp', dir: null, relative: true }, runTimeLimitMs: null, startTimeLimitMs: null, db: 'postgresql' as const };
    expect((await regressionTest(withSettings, root, { client: null, server: 'server/tests' }, options)).result).toBe('pass');
    expect(startPostgres).toHaveBeenCalledWith(withSettings, { tag: '17', digest: 'sha256:x' });
    expect(remove).toHaveBeenCalledTimes(1);
    vi.mocked(startPostgres).mockResolvedValue({ id: 'c', createDatabase: () => Promise.reject(new Error('createdb failed')), remove });
    await expect(regressionTest(withSettings, root, { client: null, server: 'server/tests' }, options)).rejects.toThrow('createdb failed');
    expect(remove).toHaveBeenCalledTimes(2);
  }, 60_000);
});
