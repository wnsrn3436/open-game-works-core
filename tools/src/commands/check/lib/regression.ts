import { readdir, readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { isNotFound } from '../../../lib/fsx.ts';
import { LIMITS } from '../../../lib/limits.ts';
import type { CheckFailure, CheckResult } from '../api.ts';
import { checkedScriptErrors, engineErrorLines, gutRun } from '../../core/lib/godot.ts';
import { startPostgres } from '../../core/lib/postgres.ts';
import { runServerTests, serverRunFailures, type ServerTestInputs } from '../../core/lib/server-tests.ts';
import { importClient } from './engine.ts';
import { checkResult, failure, writeEvidence, type Evidence } from './evidence.ts';

export { checkedScriptErrors, engineErrorLines };

const CLIENT_TESTS = 'client/tests';
const SERVER_TESTS = 'server/tests';

export interface RegressionTargets {
  /** Game repo relative test file or folder under `client/tests/`, or null. */
  client: string | null;
  /** Game repo relative test file or folder under `server/tests/`, or null. */
  server: string | null;
}

function under(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/**
 * `--regression [<path>]`: `<path>` is a game repo relative test file or folder; without it, `client/tests/` and
 * `server/tests/`. The path is normalized first; an absolute path or a path with a `..` segment is refused.
 */
export async function regressionTargets(root: string, path: string | undefined): Promise<RegressionTargets> {
  if (path === undefined) return { client: CLIENT_TESTS, server: SERVER_TESTS };
  const slashed = path.replaceAll('\\', '/');
  const clean = posix.normalize(slashed).replace(/\/+$/, '');
  if (posix.isAbsolute(clean) || slashed.split('/').includes('..') || (!under(clean, CLIENT_TESTS) && !under(clean, SERVER_TESTS))) {
    throw new OgwError(`regression test path must be under ${CLIENT_TESTS}/ or ${SERVER_TESTS}/: ${path}`);
  }
  try {
    await stat(join(root, clean));
  } catch (error) {
    if (isNotFound(error)) throw new OgwError(`regression test path does not exist: ${path}`);
    throw error;
  }
  return under(clean, CLIENT_TESTS) ? { client: clean, server: null } : { client: null, server: clean };
}

async function filesUnder(path: string): Promise<string[]> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return [path];
    const entries = await readdir(path, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

/** The `testing` `### test run` inputs of a server regression test of the game checkout `root`. */
export function regressionInputs(root: string, postgresql: string | null): ServerTestInputs {
  return {
    serverModules: join(root, 'server', 'generated', 'server_modules.json'),
    serverData: join(root, 'server', 'build', 'data'),
    sharedFixtures: join(root, 'data', 'fixtures'),
    coreFixtures: null,
    postgresql,
    defaultDb: postgresql === null ? 'sqlite' : 'postgresql',
  };
}

/** A PostgreSQL database for `--db postgresql`, removed by `close`. */
export interface RegressionDb {
  url: string;
  close(): Promise<void>;
}

async function regressionDb(ctx: Context, db: 'postgresql' | undefined): Promise<RegressionDb | null> {
  if (db === undefined) return null;
  const container = await startPostgres(ctx, (await ctx.settings()).tools.postgresql);
  try {
    return { url: await container.createDatabase('ogw_regression'), close: () => container.remove() };
  } catch (error) {
    await container.remove();
    throw error;
  }
}

/**
 * `where` of a failure of the whole run of a target (`game-loop` `## loop iteration record`: a file:line): line 1 of
 * the target file or folder.
 */
export function targetWhere(path: string): string {
  return `${path}:1`;
}

/** Server regression test (`testing` `### test run`) of the `*.test.ts` files of `path`; none is run failure `no tests`. */
export async function serverRegression(ctx: Context, root: string, path: string, options: ClientRunOptions): Promise<CheckFailure[]> {
  const tests = (await filesUnder(join(root, path))).filter((file) => file.endsWith('.test.ts'));
  if (tests.length === 0) return [failure(targetWhere(path), 'run failure: no tests')];
  const db = await regressionDb(ctx, options.db);
  try {
    const timeoutMs = LIMITS.programMs;
    const inputs = regressionInputs(root, db?.url ?? null);
    const run = await runServerTests({ checkout: root, target: path, kind: 'regression', inputs, env: ctx.env, timeoutMs });
    const evidence = [
      run.result === null ? null : await writeEvidence(options.evidence, 'regression/server-result.json', `${JSON.stringify(run.result, null, 2)}\n`),
      await writeEvidence(options.evidence, 'regression/server-output.log', run.output),
    ];
    return serverRunFailures(run, 'regression', targetWhere(path), timeoutMs).map((f) => failure(f.where, f.message, evidence));
  } finally {
    await db?.close();
  }
}

export interface ClientRunOptions {
  godot: string;
  evidence: Evidence;
  /** `UnitTestCore.startTimeLimitMs`, or null when the merged core settings do not have it (`unit-test-core` `PUT /started`). */
  startTimeLimitMs?: number | null;
  /** `UnitTestCore.runTimeLimitMs`, or null when the merged core settings do not have it. */
  runTimeLimitMs: number | null;
  /** `--db postgresql`: the server regression test gets a throwaway PostgreSQL. */
  db?: 'postgresql';
  /** The checkout's `client/` was just imported under the import lock (`importClient`): the client run does not import again. */
  imported?: boolean;
  /** The caller's import of the checkout's `client/` failed with this message: the client run reports it and does not import again. */
  importFailure?: string;
}

/** GUT target arguments for a test file or folder under `client/tests/` (`client-core` godot `## test`). */
export function gutTarget(path: string): string[] {
  const res = `res://${path.slice('client/'.length)}`;
  if (path.endsWith('.gd')) return [`-gtest=${res}`];
  return [`-gdir=${res}`, '-ginclude_subdirs', '-gprefix=test_', '-gsuffix=.gd'];
}


/** `<test file path>::<function>` → `client/...:<line of func>`. */
async function testWhere(root: string, name: string): Promise<string> {
  const [file = '', fn = ''] = name.split('::');
  const path = file.startsWith('res://') ? `client/${file.slice('res://'.length)}` : file;
  const text = await readFile(join(root, path), 'utf8').catch(() => '');
  const index = text.split('\n').findIndex((line) => line.startsWith(`func ${fn}(`));
  return `${path}:${String(index + 1 || 1)}`;
}

interface RunResultFile {
  results?: { name?: unknown; status?: unknown; message?: unknown }[];
  run_failures?: { message?: unknown }[];
}

async function resultFailures(root: string, result: RunResultFile, where: string, evidence: (string | null)[]): Promise<CheckFailure[]> {
  const failures: CheckFailure[] = [];
  for (const test of result.results ?? []) {
    if (test.status !== 'fail') continue;
    const name = String(test.name);
    failures.push(failure(await testWhere(root, name), `${name} ${String(test.message)}`, evidence));
  }
  for (const runFailure of result.run_failures ?? []) failures.push(failure(where, `run failure: ${String(runFailure.message)}`, evidence));
  return failures;
}

/**
 * Client regression test: GUT headless pass of the Godot project `client/` with a `UnitTestCore` test host. The import
 * runs under the import lock; the GUT run gets a `user://` of its own (`godotDataVariable`), so the `release` and test
 * setup of this run and the instances and runs of the same project name do not delete each other's app storage files.
 */
export async function clientRegression(ctx: Context, root: string, path: string, options: ClientRunOptions): Promise<CheckFailure[]> {
  const project = join(root, 'client');
  const where = targetWhere(path);
  if (options.importFailure !== undefined) return [failure(where, options.importFailure)];
  if (options.imported !== true) {
    const importFailure = await importClient(ctx, options.godot, root);
    if (importFailure !== null) return [failure(where, importFailure)];
  }
  const timeoutMs = (options.runTimeLimitMs ?? LIMITS.programMs) + LIMITS.shortMs;
  const ran = await gutRun(ctx, {
    godot: options.godot,
    project,
    cwd: root,
    headless: true,
    gut: [
      '-s', 'addons/gut/gut_cmdln.gd', ...gutTarget(path),
      '-gpre_run_script=res://core/unit_test_core/dev/gut_pre_run.gd',
      '-gpost_run_script=res://core/unit_test_core/dev/gut_post_run.gd', '-gexit',
    ],
    config: (runId, host) => ({ ogw_run_id: runId, ogw_test_host: host, ogw_shared_fixture_dir: join(root, 'data', 'fixtures') }),
    timeoutMs,
    startLimitMs: options.startTimeLimitMs ?? null,
  });
  const result = ran.ran;
  const output = `${result.stdout}${result.stderr}`;
  const received = ran.json as RunResultFile | null;
  const evidence = [
    received === null ? null : await writeEvidence(options.evidence, 'regression/client-result.json', `${JSON.stringify(received, null, 2)}\n`),
    await writeEvidence(options.evidence, 'regression/client-output.log', output),
  ];
  const failures: CheckFailure[] = [];
  if (result.timedOut) failures.push(failure(where, `test run did not end within ${String(timeoutMs)} ms`, evidence));
  if (result.stopped === true) failures.push(failure(where, `test run did not start within ${String(options.startTimeLimitMs ?? 0)} ms (no PUT /started)`, evidence));
  if (received === null) failures.push(failure(where, 'the test run sent no result', evidence));
  else failures.push(...(await resultFailures(root, received, where, evidence)));
  if (result.code !== 0 && !result.timedOut) failures.push(failure(where, `exit code ${String(result.code ?? result.signal)}`, evidence));
  for (const line of engineErrorLines(output, checkedScriptErrors(received))) failures.push(failure(where, `engine output: ${line.trim()}`, evidence));
  return failures;
}

/** `regression test`: client regression test and server regression test of the targets. */
export async function regressionTest(ctx: Context, root: string, targets: RegressionTargets, options: ClientRunOptions): Promise<CheckResult> {
  const [server, client] = await Promise.all([
    targets.server === null ? [] : serverRegression(ctx, root, targets.server, options),
    targets.client === null ? [] : clientRegression(ctx, root, targets.client, options),
  ]);
  return checkResult('regression test', null, [...client, ...server]);
}
