/**
 * Server core test and server regression test runs (`testing` `### test run`): vitest pinned by ogw, inputs as
 * environment variables, and a result in the `unit-test-core` result file format.
 */
import { mkdir, rm, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { readJsonIfExists, removeModulesLink, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import { newId } from '../../../lib/ids.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { run } from '../../../lib/proc.ts';
import { OgwError } from '../../../lib/errors.ts';
import { checkoutLock } from '../../../lib/git.ts';
import { withLock } from '../../../lib/lock.ts';
import { ogwTools } from '../../code/lib/target.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';

export type ServerTestKind = 'core' | 'regression';
export type ServerDb = 'sqlite' | 'postgresql';

/** Inputs of a server test run. Absolute paths; null when the run does not give it. */
export interface ServerTestInputs {
  serverModules: string | null;
  serverData: string;
  sharedFixtures: string | null;
  coreFixtures: string | null;
  postgresql: string | null;
  defaultDb: ServerDb;
}

export const SERVER_TEST_ENV = [
  'OGW_SERVER_MODULES',
  'OGW_SERVER_DATA',
  'OGW_SHARED_FIXTURES',
  'OGW_CORE_FIXTURES',
  'OGW_POSTGRESQL',
  'OGW_DEFAULT_DB',
] as const;

/** The environment variables of a run. */
export function serverTestEnv(inputs: ServerTestInputs): Record<string, string> {
  const values: Record<(typeof SERVER_TEST_ENV)[number], string | null> = {
    OGW_SERVER_MODULES: inputs.serverModules,
    OGW_SERVER_DATA: inputs.serverData,
    OGW_SHARED_FIXTURES: inputs.sharedFixtures,
    OGW_CORE_FIXTURES: inputs.coreFixtures,
    OGW_POSTGRESQL: inputs.postgresql,
    OGW_DEFAULT_DB: inputs.defaultDb,
  };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) if (value !== null) out[key] = value;
  return out;
}

/** The process environment of a run: `base` without inherited test inputs, plus the inputs. */
export function runEnv(base: NodeJS.ProcessEnv, inputs: ServerTestInputs): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of SERVER_TEST_ENV) Reflect.deleteProperty(env, key);
  return { ...env, ...serverTestEnv(inputs) };
}

/** Time limit of one test and one hook. */
export const TEST_TIMEOUT_MS = LIMITS.shortMs;

/** The vitest `test` options of every server test run (globals, `*.test.ts`); `maxWorkers` caps the test files run at once. */
export function vitestTestOptions(maxWorkers?: number): Record<string, unknown> {
  return {
    ...(maxWorkers === undefined ? {} : { maxWorkers }),
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    globals: true,
    pool: 'forks',
    includeTaskLocation: true,
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
    watch: false,
  };
}

/** One test of a `unit-test-core` result. */
export interface UnitTestEntry {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  duration_ms: number;
  message: string;
  /** Checkout relative `file:line` of the test (not in the result format; kept for failure locations). */
  where: string;
}

/** A `unit-test-core` result file. */
export interface UnitTestResult {
  run_id: string;
  kind: ServerTestKind;
  engine: 'server';
  started_at: number;
  finished_at: number;
  results: UnitTestEntry[];
  run_failures: { message: string }[];
  warn_counts: Record<string, number>;
}

interface VitestAssertion {
  ancestorTitles?: string[];
  title?: string;
  status?: string;
  duration?: number;
  failureMessages?: string[];
  location?: { line?: number };
}

interface VitestFile {
  name?: string;
  status?: string;
  message?: string;
  assertionResults?: VitestAssertion[];
}

/** vitest's json reporter output. */
export interface VitestJson {
  testResults?: VitestFile[];
}

function status(value: string | undefined): UnitTestEntry['status'] {
  if (value === 'passed') return 'pass';
  if (value === 'failed') return 'fail';
  return 'skip';
}

function slash(path: string): string {
  return path.split(sep).join('/');
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}

function entry(path: string, test: VitestAssertion): UnitTestEntry {
  const testStatus = status(test.status);
  return {
    name: `${path}::${[...(test.ancestorTitles ?? []), test.title ?? ''].join(' > ')}`,
    status: testStatus,
    duration_ms: Math.round(test.duration ?? 0),
    message: testStatus === 'fail' ? firstLine((test.failureMessages ?? []).join('\n')) : '',
    where: `${path}:${String(test.location?.line ?? 1)}`,
  };
}

/** Converts vitest's json report to a `unit-test-core` result. Test files are named relative to `checkout`. */
export function unitTestResult(
  report: VitestJson,
  meta: { runId: string; kind: ServerTestKind; checkout: string; startedAt: number; finishedAt: number },
): UnitTestResult {
  const results: UnitTestEntry[] = [];
  const runFailures: { message: string }[] = [];
  for (const file of report.testResults ?? []) {
    const path = slash(relative(meta.checkout, file.name ?? ''));
    const tests = (file.assertionResults ?? []).map((test) => entry(path, test));
    // A failed file without a failed test: it did not load, or a `beforeAll` or `afterAll` hook threw. vitest's
    // report has no message for a hook error.
    if (file.status === 'failed' && !tests.some((test) => test.status === 'fail')) {
      runFailures.push({ message: `${path}: ${firstLine(file.message ?? '') || 'the file failed outside its tests'}` });
    }
    results.push(...tests);
  }
  if (results.length === 0) runFailures.push({ message: 'no tests' });
  return {
    run_id: meta.runId,
    kind: meta.kind,
    engine: 'server',
    started_at: meta.startedAt,
    finished_at: meta.finishedAt,
    results,
    run_failures: runFailures,
    warn_counts: {},
  };
}

export interface ServerTestRunOptions {
  /** Checkout root: the game repo root or `open-game-works-core-impl/`. vitest's root is its `server/`. */
  checkout: string;
  /** Checkout relative test folder or test file. */
  target: string;
  kind: ServerTestKind;
  inputs: ServerTestInputs;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Test files run at once; vitest's default when absent. */
  maxWorkers?: number;
}

export interface ServerTestRun {
  /** null when vitest wrote no report. */
  result: UnitTestResult | null;
  output: string;
  timedOut: boolean;
  exitCode: number | null;
}

/** The vitest command line of a run. */
export function vitestArgs(options: ServerTestRunOptions, config: string, report: string, isFile: boolean): string[] {
  const root = join(options.checkout, 'server');
  const target = join(options.checkout, options.target);
  const dir = isFile ? join(target, '..') : target;
  const args = [
    join(ogwTools(), 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', config, '--root', root, '--dir', dir,
    '--reporter=json', `--outputFile=${report}`,
  ];
  if (isFile) args.push(target);
  return args;
}

async function mtime(path: string): Promise<number | null> {
  return stat(path).then((s) => s.mtimeMs, () => null);
}

/**
 * `npm ci` in `<checkout>/server/` when it has a `package-lock.json` that `node_modules/` was not installed from yet
 * (`testing` `### test run`): server code imports its npm dependencies from there.
 */
export async function installServerDependencies(checkout: string, env: NodeJS.ProcessEnv): Promise<void> {
  const dir = join(checkout, 'server');
  const lock = await mtime(join(dir, 'package-lock.json'));
  if (lock === null) return;
  // one `npm ci` per checkout at a time: runs started together would replace each other's node_modules/
  await withLock(await checkoutLock(checkout, 'ogw-server-npm.lock', { env }), async () => {
    // a linked node_modules/ is another checkout's install: it is neither this checkout's nor written through
    await removeModulesLink(dir);
    const installed = await mtime(join(dir, 'node_modules', '.package-lock.json'));
    if (installed !== null && installed >= lock) return;
    const result = await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, env, timeoutMs: LIMITS.programMs });
    if (result.timedOut) throw new OgwError('server: npm ci timed out');
    if (result.code !== 0) throw new OgwError(`server: npm ci failed (${String(result.code)})\n${(result.stderr || result.stdout).trim()}`);
  }, LIMITS.programMs);
}

/** Runs the server tests of `target` with vitest and returns the `unit-test-core` result. */
export async function runServerTests(options: ServerTestRunOptions): Promise<ServerTestRun> {
  await installServerDependencies(options.checkout, options.env);
  const work = await newPrivateTempFolder('ogw-server-test-', options.env);
  try {
    const config = join(work, 'vitest.config.mjs');
    const report = join(work, 'report.json');
    await writeFileAtomic(config, `export default ${JSON.stringify({ cacheDir: join(work, 'cache'), test: vitestTestOptions(options.maxWorkers) })};\n`);
    // a temp folder of its own: runs that go at once (the SQLite and PostgreSQL runs of a module) do not see each other's files
    const tmp = join(work, 'tmp');
    await mkdir(tmp);
    const startedAt = Date.now();
    const result = await run(process.execPath, vitestArgs(options, config, report, options.target.endsWith('.ts')), {
      cwd: options.checkout,
      env: { ...runEnv(options.env, options.inputs), TMPDIR: tmp, TMP: tmp, TEMP: tmp },
      timeoutMs: options.timeoutMs,
    });
    const json = await readJsonIfExists<VitestJson>(report);
    const meta = { runId: newId(), kind: options.kind, checkout: options.checkout, startedAt, finishedAt: Date.now() };
    return {
      result: json === null ? null : unitTestResult(json, meta),
      output: `${result.stdout}${result.stderr}`,
      timedOut: result.timedOut,
      exitCode: result.code,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** One failed test or run failure of a run, with its checkout relative location. */
export interface ServerTestFailure {
  where: string;
  message: string;
}

/**
 * Which tests a run judges: server core tests, server regression tests, or the vitest tests of a tool of
 * `ogw core test tools` (`core` command.md `### create contract tool`), which fail on `skip` as regression tests do.
 */
export type RunJudgement = ServerTestKind | 'tool';

/** Why `skip` fails a run of that judgement; a judgement without one passes `skip`. */
const SKIP_FAILURE: Partial<Record<RunJudgement, string>> = {
  regression: 'a regression test does not skip',
  tool: 'a tool test does not skip',
};

/**
 * The judgement of a run (`testing` `### test run`): every test `pass` or `skip`, no run failure (a non-zero vitest exit
 * code with no other failure is one), one test or more. A server regression test and a tool test fail on `skip` too. `fallbackWhere` locates failures that are not one test.
 */
export function serverRunFailures(run: ServerTestRun, kind: RunJudgement, fallbackWhere: string, timeoutMs: number): ServerTestFailure[] {
  const failures: ServerTestFailure[] = [];
  if (run.timedOut) failures.push({ where: fallbackWhere, message: `test run did not end within ${String(timeoutMs)} ms` });
  if (run.result === null) {
    if (!run.timedOut) failures.push({ where: fallbackWhere, message: `the test run wrote no result: ${firstLine(run.output.trim())}` });
    return failures;
  }
  const skipFailure = SKIP_FAILURE[kind];
  for (const test of run.result.results) {
    if (test.status === 'fail') failures.push({ where: test.where, message: `${test.name} ${test.message}`.trimEnd() });
    if (test.status === 'skip' && skipFailure !== undefined) failures.push({ where: test.where, message: `${test.name} skipped; ${skipFailure}` });
  }
  for (const failure of run.result.run_failures) failures.push({ where: fallbackWhere, message: `run failure: ${failure.message}` });
  // an error outside every test (an unhandled rejection) fails vitest with a report of passed tests
  const failed = failures.length > 0 || run.result.results.some((test) => test.status === 'fail');
  if (!failed && run.exitCode !== 0) failures.push({ where: fallbackWhere, message: `run failure: vitest ended with exit code ${String(run.exitCode)}: ${firstLine(run.output.trim())}` });
  return failures;
}

/** Counts and failures of one module test (`ogw core test`). */
export interface ServerModuleOutcome {
  tests: number;
  passed: number;
  failures: string[];
  /** Whether vitest was started (`ModuleOutcome.ran`): a run that stops before it (an `npm ci` that failed) throws. Absent: true. */
  ran?: boolean;
}

export interface ServerModuleRun {
  implDir: string;
  module: string;
  /** PostgreSQL connection strings of the new databases of this module test: one for each run, since the runs go at once. */
  postgresql: { readonly sqlite: string; readonly postgresql: string };
  /** Folder that keeps the result file of each run. */
  resultsDir: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  /** Test files of the module run at once. */
  maxWorkers?: number;
  /** One test file of the module (checkout relative) to run alone. */
  file?: string;
}

/** The core tests of one server module: a run with `OGW_DEFAULT_DB` `sqlite` and one with `postgresql`, at once. */
export async function serverModuleTest(options: ServerModuleRun): Promise<ServerModuleOutcome> {
  const outcome: ServerModuleOutcome = { tests: 0, passed: 0, failures: [] };
  const target = options.file ?? `server/core/${options.module}/tests`;
  const runOne = async (defaultDb: 'sqlite' | 'postgresql'): Promise<{ defaultDb: 'sqlite' | 'postgresql'; run: Awaited<ReturnType<typeof runServerTests>> }> => {
    const inputs: ServerTestInputs = {
      serverModules: null,
      serverData: join(options.implDir, 'server', 'build', 'data'),
      sharedFixtures: null,
      coreFixtures: join(options.implDir, 'fixtures'),
      postgresql: options.postgresql[defaultDb],
      defaultDb,
    };
    return { defaultDb, run: await runServerTests({ checkout: options.implDir, target, kind: 'core', inputs, env: options.env, timeoutMs: options.timeoutMs, ...(options.maxWorkers === undefined ? {} : { maxWorkers: options.maxWorkers }) }) };
  };
  for (const { defaultDb, run } of await Promise.all([runOne('sqlite'), runOne('postgresql')])) {
    if (run.result !== null) await writeJsonAtomic(join(options.resultsDir, `${run.result.run_id}.json`), run.result);
    const results = run.result?.results ?? [];
    outcome.tests += results.length;
    outcome.passed += results.filter((test) => test.status !== 'fail').length;
    for (const failure of serverRunFailures(run, 'core', target, options.timeoutMs)) outcome.failures.push(`${defaultDb} run: ${failure.message}`);
  }
  return outcome;
}
