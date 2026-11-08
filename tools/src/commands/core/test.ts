import { mkdir, realpath, rm } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { flag, str, type CommandArgs, type CommandDef, type CommandResult, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists, readJsonIfExists, whenNotFound, writeIfChanged, writeJsonAtomic } from '../../lib/fsx.ts';
import { coreSettingsFile, coreSettingTypesFile } from '../generate/api.ts';
import { resolveCoreImpl } from '../../lib/game.ts';
import { commonDir, head, statusLines } from '../../lib/git.ts';
import { harnessRoot } from '../../lib/paths.ts';
import { jobsDir, updateJob } from '../../lib/jobs.ts';
import { LIMITS } from '../../lib/limits.ts';
import { requireEngine, toolProgram } from '../env/api.ts';
import { clientModuleTableOrder, moduleListOrder, type SpecModule } from '../generate/lib/core-spec.ts';
import { coreModulesGd } from '../generate/lib/godot-files.ts';
import { renderCoreProjectGodot } from '../generate/lib/godot-project.ts';
import { testAtHead, type TestStart } from './lib/main-checkout.ts';
import { writeCoreSpec } from './spec-api.ts';
import { baseProtoErrors } from './lib/base-proto-check.ts';
import { fixtureIdErrors, licenseErrors } from './lib/content-checks.ts';
import { nativeModuleTest, pageLaunchValues, resultsDirOf, setupGodot, webExport, webModuleTest, withGodotProject, type ModuleOutcome } from './lib/godot.ts';
import { type CoreSpecModule, enginesOf, moduleFolder, readCoreSpecDir, readEngineJson, unitTestProcessLimit, unitTestStartLimit } from './lib/impl.ts';
import { startPostgres } from './lib/postgres.ts';
import { runModulePool } from './lib/ready-queue.ts';
import { specDirErrors } from './lib/spec-dir-check.ts';
import { buildTestData, testGameSettings } from './lib/test-data.ts';
import { addTestRecord, type ModuleResult } from './lib/test-records.ts';
import { type ChangedPaths, inheritedRenderPass } from './lib/render-pass.ts';
import { awakeDeps } from './lib/display-awake.ts';
import { rerunHint, runOutcome, SCREEN_LOCKED } from '../../lib/outcome.ts';
import { keepResult, keptResult, moduleKeys, type KeptResult } from './lib/test-reuse.ts';
import { godotCoreStaticCheck } from './lib/core-static-check.ts';
import { serverInternalImports } from './lib/core-server-imports.ts';
import { serverCoreStaticCheck } from './lib/core-server-static-check.ts';
import { serverModuleTest } from './lib/server-tests.ts';
import { runToolTest } from './lib/tool-test.ts';
import { TOOLS } from './lib/tools.ts';
import { engineAssetRules } from './lib/undefined.ts';
import { newPrivateTempFolder } from '../../lib/secret-files.ts';
import { withShare } from '../../lib/shares.ts';
import { span } from '../../lib/spans.ts';

export type Target = { kind: 'engine'; engine: string; web: boolean } | { kind: 'server' } | { kind: 'tools' };


/** The target name a test record keeps: `server`, `<engine>`, `<engine> --web` or `tools`. */
export function recordTarget(target: Target): string {
  if (target.kind === 'engine') return target.web ? `${target.engine} --web` : target.engine;
  return target.kind;
}

async function parseTarget(implDir: string, name: string, web: boolean): Promise<Target> {
  if (name === 'server' || name === 'tools') {
    if (web) throw new OgwError(`--web is only for an engine, not ${name}`);
    return { kind: name };
  }
  if (!(await enginesOf(implDir)).includes(name)) throw new OgwError(`unknown target ${name}: not server, tools, or an engine with client/${name}/engine.json`);
  return { kind: 'engine', engine: name, web };
}

function failIf(step: string, errors: readonly string[]): void {
  if (errors.length > 0) throw new OgwError(`${step} failed; no test ran:\n${errors.join('\n')}`, 1, { step, errors });
}

async function staticCheck(ctx: Context, implDir: string, target: Target): Promise<string[]> {
  if (target.kind === 'server') return [...(await serverCoreStaticCheck(implDir)), ...(await serverInternalImports(implDir, (await ctx.workspace()).harness))];
  if (target.kind === 'tools') return [];
  if (target.engine !== 'godot') engineAssetRules(target.engine);
  return godotCoreStaticCheck(ctx, implDir);
}

/**
 * Everything `ogw core test` does before the module tests; throws when a step fails. The `core-spec/` check, the
 * base proto check, the core test data build and the fixture ID name check are of the `server` and engine targets
 * only (`data` tool.md `## processing`); the `licenses.json` check is of engine targets only (`core` command.md
 * `## license manifest`); `whole` is true for a run without modules.
 */
async function preflight(ctx: Context, implDir: string, target: Target, work: string, whole: boolean): Promise<void> {
  const spec = await writeCoreSpec(ctx);
  failIf('ogw core spec', spec.errors);
  // the core project's project.godot, module list file, core settings file and core settings type file are generated
  // files of every engine (ogw.md `### Godot core test`): the settings files made as `ogw generate` makes a game's,
  // from `settings/core-settings.json` and the core test data's game settings with the schema defaults
  for (const engine of await enginesOf(implDir)) {
    if (engine !== 'godot') continue;
    await writeIfChanged(join(implDir, 'client', engine, 'project.godot'), renderCoreProjectGodot());
    // every client module of `core-spec/` in the module list order
    const modules = (await readCoreSpecDir(implDir)).map((m) => ({ ...m, lifecycle: m.lifecycle === true })) as unknown as SpecModule[];
    await writeIfChanged(join(implDir, 'client', engine, 'generated', 'core_modules.gd'), coreModulesGd(moduleListOrder(modules, await clientModuleTableOrder(ctx.env))));
    const settings = await testGameSettings(ctx, join(implDir, 'test-data'), true);
    await writeIfChanged(join(implDir, 'client', engine, 'generated', 'core_settings.json'), await coreSettingsFile(ctx, join(implDir, 'settings'), modules, settings));
    await writeIfChanged(join(implDir, 'client', engine, 'generated', 'core_settings_types.json'), coreSettingTypesFile(modules, settings));
  }
  if (target.kind !== 'tools') {
    const side = target.kind === 'engine' ? { kind: 'engine' as const, engine: target.engine } : { kind: 'server' as const };
    failIf('core-spec/ check', await specDirErrors(implDir, side, whole));
    failIf('base proto check', await baseProtoErrors(ctx, implDir));
  }
  if (target.kind === 'engine') failIf('licenses.json check', await licenseErrors(implDir, (await ctx.workspace()).harness));
  if (target.kind !== 'tools') {
    const known = await buildTestData(ctx, implDir, target.kind === 'engine' ? target.engine : null, work);
    failIf('core test fixture ID name check', await fixtureIdErrors(implDir, known));
  }
  failIf('core code static check', await staticCheck(ctx, implDir, target));
}

/**
 * The preflight, then for a Godot target the import of the core project whether the preflight passed or not: it writes the
 * engine meta files of new generated scripts, which are generated files too and go in the same commit. The preflight's
 * error goes first.
 */
async function preflightAndImport(ctx: Context, implDir: string, target: Target, work: string, whole: boolean): Promise<void> {
  let failure: Error | null = null;
  try {
    await preflight(ctx, implDir, target, work, whole);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }
  if (target.kind === 'engine' && target.engine === 'godot') {
    try {
      await setupGodot(ctx, implDir, await readEngineJson(implDir, target.engine));
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  if (failure !== null) throw failure;
}

function targetModules(all: readonly CoreSpecModule[], target: Target, given: readonly string[]): string[] {
  const names = target.kind === 'tools'
    ? [...TOOLS]
    : all.filter((m) => m.side === (target.kind === 'server' ? 'server' : 'client')).map((m) => m.name);
  const unknown = given.filter((m) => !names.includes(m));
  if (unknown.length > 0) throw new OgwError(`not a module of ${recordTarget(target)}: ${unknown.join(', ')}`);
  return given.length > 0 ? [...new Set(given)] : names;
}


interface Runner {
  run(module: string): Promise<ModuleOutcome>;
  close(): Promise<void>;
}

async function engineRunner(ctx: Context, implDir: string, target: Extract<Target, { kind: 'engine' }>, work: string, file: string | undefined): Promise<Runner> {
  if (target.engine !== 'godot') engineAssetRules(target.engine);
  const setup = await setupGodot(ctx, implDir, await readEngineJson(implDir, target.engine));
  const timeoutMs = await unitTestProcessLimit(implDir);
  const startLimitMs = await unitTestStartLimit(implDir);
  const resultsDir = resultsDirOf(work);
  if (!target.web) {
    const fixturesDir = join(implDir, 'fixtures');
    // the passes run in the shared project as readers: a setup in another process waits for them (`withGodotProject`)
    return { run: (module) => withGodotProject(ctx, implDir, () => nativeModuleTest(ctx, { setup, module, fixturesDir, resultsDir, timeoutMs, startLimitMs, ...(file === undefined ? {} : { file }) })), close: () => Promise.resolve() };
  }
  const chromium = await toolProgram(ctx, 'chromium');
  if (chromium === null) throw new OgwError('harness settings tools.chromium is not on this host; the browser run stops');
  const exportDir = await webExport(ctx, implDir, setup, work);
  return {
    async run(module) {
      // a page launch value file that is no launch value file fails the module before its page opens
      const page = await pageLaunchValues(implDir, module);
      if ('error' in page) return { tests: 0, passed: 0, failures: [`browser run: ${page.error}`], ran: false };
      return webModuleTest(ctx, { chromium, exportDir, module, resultsDir, timeoutMs, startLimitMs, ...(page.values === null ? {} : { launchValues: page.values }) });
    },
    close: () => Promise.resolve(),
  };
}

async function serverRunner(ctx: Context, implDir: string, work: string, file: string | undefined): Promise<Runner> {
  const postgres = await startPostgres(ctx, (await ctx.settings()).tools.postgresql);
  const resultsDir = resultsDirOf(work);
  let n = 0;
  return {
    async run(module) {
      n += 1;
      const name = `ogw_${module.replace(/[^a-z0-9]/g, '_')}_${String(n)}`;
      // the SQLite run and the PostgreSQL run of a module run at once, each with a database of its own
      const postgresql = { sqlite: await postgres.createDatabase(`${name}_s`), postgresql: await postgres.createDatabase(`${name}_p`) };
      return serverModuleTest({ implDir, module, postgresql, resultsDir, timeoutMs: LIMITS.programMs, env: ctx.env, maxWorkers: SERVER_WORKERS, ...(file === undefined ? {} : { file }) });
    },
    close: () => postgres.remove(),
  };
}

async function toolsRunner(ctx: Context, implDir: string): Promise<Runner> {
  for (const engine of await enginesOf(implDir)) {
    if (engine !== 'godot') engineAssetRules(engine);
    const version = (await readEngineJson(implDir, engine)).godot;
    if (typeof version !== 'string') throw new OgwError(`engine.json of ${engine} has no ${engine} version`);
    await requireEngine(ctx, engine, version);
  }
  return { run: (module) => runToolTest(ctx, implDir, module), close: () => Promise.resolve() };
}

function makeRunner(ctx: Context, implDir: string, target: Target, work: string, file: string | undefined): Promise<Runner> {
  if (target.kind === 'engine') return engineRunner(ctx, implDir, target, work, file);
  if (target.kind === 'server') return serverRunner(ctx, implDir, work, file);
  return toolsRunner(ctx, implDir);
}

/** The modules of the `<module>` arguments, each split at whitespace (ogw.md `## core spec and core test`). */
export function moduleArgs(given: readonly string[]): string[] {
  return given.flatMap((arg) => arg.split(/\s+/).filter((name) => name !== ''));
}

/** The real path of `path`; the resolved path when it does not exist. */
async function realOf(path: string): Promise<string> {
  return realpath(path).catch(whenNotFound(resolve(path)));
}

/** The command line of a `--file` run of `argv` (the arguments after `ogw core test`) without `--web`. */
function withoutWeb(argv: readonly string[]): string {
  return ['ogw', 'core', 'test', ...argv.filter((a) => a !== '--web')].join(' ');
}

/**
 * `--file`: one test file of the one module given, in that module's `tests/` folder, given relative to the checkout, to
 * the module folder or to the `tests/` folder, or absolute (ogw.md `## core spec and core test`). A server test file is
 * a `*.test.ts`; a Godot one a `.gd` script, run as its `res://` path. Not for `tools` or a browser run.
 */
async function checkTestFile(implDir: string, target: Target, modules: readonly string[], file: string, argv: readonly string[]): Promise<string> {
  if (target.kind === 'tools') throw new OgwError('--file is for server and a native engine run, not tools');
  if (target.kind === 'engine' && target.web) {
    throw new OgwError(`--file is for server and a native engine run, not ${recordTarget(target)}: ${withoutWeb(argv)} runs that file`);
  }
  if (modules.length !== 1) throw new OgwError('--file takes exactly one module');
  const module = modules[0] as string;
  const moduleDir = target.kind === 'server' ? `server/core/${module}/` : `client/${target.engine}/core/${moduleFolder(module)}/`;
  const folder = `${moduleDir}tests/`;
  const suffix = target.kind === 'server' ? '.test.ts' : '.gd';
  const tried = isAbsolute(file)
    ? [relative(await realOf(implDir), await realOf(file))]
    : [file, `${moduleDir}${file}`, `${folder}${file}`].map((path) => normalize(path));
  const found = [...new Set(tried)].filter((path) => path.startsWith(folder) && path.endsWith(suffix) && exists(join(implDir, path)));
  if (found.length !== 1) {
    const what = found.length === 0 ? `--file must be a ${suffix} file in ${folder} of ${module}` : `--file names more than one ${suffix} file in ${folder} of ${module}`;
    throw new OgwError(`${what}: ${file} (tried ${[...new Set(tried)].join(', ')})`);
  }
  const path = found[0] as string;
  return target.kind === 'server' ? path : `res://${path.slice(`client/${target.engine}/`.length)}`;
}

/**
 * What `ogw core test` checks before it starts its job (ogw.md `## core spec and core test`): the core checkout, the
 * target and the `--file` arguments. Returns the checkout, the target, the modules given and the `--file` test file.
 */
async function checkArgs(ctx: Context, args: CommandArgs, usage: string): Promise<{ implDir: string; target: Target; given: string[]; file: string | undefined }> {
  const [name, ...rest] = args.positionals;
  if (name === undefined) throw new OgwError(`usage: ${usage}`);
  const implDir = await resolveCoreImpl(await ctx.workspace(), ctx.cwd, ctx.env);
  if (!exists(implDir)) throw new OgwError(`not found: ${implDir}`);
  const target = await parseTarget(implDir, name, flag(args, 'web'));
  const given = moduleArgs(rest);
  const fileArg = str(args, 'file');
  const file = fileArg === undefined ? undefined : await checkTestFile(implDir, target, given, fileArg, args.raw);
  return { implDir, target, given, file };
}

async function reportResult(ctx: Context, module: string, result: ModuleResult, durationMs: number | undefined): Promise<void> {
  ctx.log(`${module} ${result}`);
  if (!ctx.jobId) return;
  await updateJob(ctx.jobId, (job) => {
    const modules = (job.meta.modules ?? {}) as Record<string, ModuleResult>;
    modules[module] = result;
    job.meta.modules = modules;
    if (durationMs !== undefined) job.meta.durationsMs = { ...((job.meta.durationsMs ?? {}) as Record<string, number>), [module]: durationMs };
  }, ctx.env);
}

/**
 * The run log summary `{"tests", "passed"}`. A module with an outcome counts its tests and passes: when it failed with no
 * counted test failing (for example no result), one more test than it passed. A module with no outcome counts one test
 * that did not pass, and so does a run with no module, so such a run never reads as all passed. A module `unknown` for a
 * part not run (a render pass, a tool's left-out round trip) counts the tests that ran.
 */
export function testSummary(results: ReadonlyMap<string, ModuleResult>, outcomes: ReadonlyMap<string, ModuleOutcome>): { tests: number; passed: number } {
  if (results.size === 0) return { tests: 1, passed: 0 };
  let tests = 0;
  let passed = 0;
  for (const module of results.keys()) {
    const outcome = outcomes.get(module);
    if (outcome === undefined) {
      tests += 1;
      continue;
    }
    passed += outcome.passed;
    tests += outcome.failures.length > 0 && outcome.passed >= outcome.tests ? outcome.passed + 1 : outcome.tests;
  }
  return { tests, passed };
}

function summaryText(results: Map<string, ModuleResult>, outcomes: Map<string, ModuleOutcome>): string {
  const lines: string[] = [];
  for (const [module, result] of results) {
    const outcome = outcomes.get(module);
    const inherited = outcome?.inherited === undefined ? '' : ` (render pass of ${outcome.inherited})`;
    lines.push(`${module} ${result}${outcome?.reused === true ? ' (reused)' : ''}${inherited}`);
    for (const failure of outcome?.failures ?? []) lines.push(`  ${failure}`);
    if (result === 'unknown' && outcome?.unknown !== undefined) lines.push(`  ${outcome.unknown}${outcome.unknown === SCREEN_LOCKED ? `; ${rerunHint(SCREEN_LOCKED)}` : ''}`);
  }
  return lines.join('\n');
}

/**
 * How many modules one run runs at once. The native runs of an engine share the project, which a GUT run only reads, and
 * each has a `user://` of its own; an engine process keeps about two CPUs busy, so they take half of the CPUs. The module
 * runs of all runs of this host share its CPUs besides (`moduleShare`).
 */
export function parallelismOf(target: Target): number {
  if (target.kind === 'engine' && !target.web) return Math.max(1, Math.floor(availableParallelism() / 2));
  // a server module test is two vitest runs at once (SQLite and PostgreSQL), each with workers of its own (`SERVER_WORKERS`);
  // many server tests wait for time, a lock or another process, so twice the CPUs in workers keeps the CPUs busy
  // (measured on 18 CPUs: 3 modules at once 172 s, 6 at once 132 s)
  return target.kind === 'server' ? Math.max(1, Math.floor(availableParallelism() / SERVER_WORKERS)) : availableParallelism();
}

/** Test files one server module run runs at once; with `parallelismOf`, about one test file per CPU. */
export const SERVER_WORKERS = 3;

/**
 * The CPUs one module run of `target` holds of this host's CPU count, which the module runs of all `ogw core test` runs
 * on this host share (ogw.md `## core spec and core test`): an engine process keeps about two CPUs busy, and a server
 * module test is two vitest runs with workers of their own.
 */
export function moduleShare(target: Target): number {
  if (target.kind === 'engine') return target.web ? 1 : 2;
  return target.kind === 'server' ? 3 : 1;
}

/** The ledger of the CPU shares that the module runs of every `ogw core test` run of this host hold (`withShare`). */
export async function cpuSharesDir(env: NodeJS.ProcessEnv): Promise<string> {
  return join(await jobsDir(env), 'core-test-cpu-shares');
}

/** The file that keeps the last wall time of each module of a target (`recordTarget`), in the harness git common dir. */
async function durationsFile(ctx: Context, target: Target): Promise<string> {
  const folder = join(await commonDir(harnessRoot(ctx.env), { env: ctx.env }), 'ogw-cache', 'core-test-durations');
  await mkdir(folder, { recursive: true });
  return join(folder, `${recordTarget(target).replace(/[^a-z0-9-]+/gi, '_')}.json`);
}

/**
 * The modules in the order they start: the longest last time first, so a long module does not start last and keep the
 * run going alone; a module with no time yet goes first, since its time is not known. Ties keep the given order.
 */
export function longestFirst(modules: readonly string[], last: Readonly<Record<string, number>>): string[] {
  const time = (module: string): number => last[module] ?? Number.POSITIVE_INFINITY;
  return modules.map((module, i) => ({ module, i })).sort((a, b) => time(b.module) - time(a.module) || a.i - b.i).map((e) => e.module);
}

/**
 * Runs the modules, except those with a kept passing result (`reused`), which pass with its counts and no run; `runner`
 * is null when every module has one.
 */
async function runModules(
  ctx: Context,
  runner: Runner | null,
  target: Target,
  modules: string[],
  reused: ReadonlyMap<string, KeptResult>,
): Promise<{ results: Map<string, ModuleResult>; outcomes: Map<string, ModuleOutcome> }> {
  const outcomes = new Map<string, ModuleOutcome>();
  const file = await durationsFile(ctx, target);
  const last = (await readJsonIfExists<Record<string, number>>(file)) ?? {};
  const shares = await cpuSharesDir(ctx.env);
  try {
    for (const [module, kept] of reused) {
      outcomes.set(module, { tests: kept.tests, passed: kept.passed, failures: [], reused: true });
      await reportResult(ctx, module, 'pass', undefined);
    }
    const toRun = modules.filter((module) => !reused.has(module));
    // each module run holds its CPU share from before its first process starts until its last one ends; the wait for the
    // share comes before its time is taken and before any of its time limits starts
    const ran = runner === null ? new Map<string, ModuleResult>() : await runModulePool(longestFirst(toRun, last), parallelismOf(target), (module) => span(`module ${module}`, () => withShare(shares, availableParallelism(), moduleShare(target), async () => {
      const startedAt = Date.now();
      const outcome = await runner.run(module).catch((error: unknown): ModuleOutcome => ({ tests: 0, passed: 0, failures: [(error as Error).message], ran: false }));
      outcomes.set(module, { ...outcome, durationMs: Date.now() - startedAt });
      return runOutcome(outcome.failures.length > 0, outcome.unknown).result;
    }).catch((error: unknown): ModuleResult => {
      const message = `CPU share: ${(error as Error).message}`;
      const outcome = outcomes.get(module);
      // the ledger failed after the module ran (its share was not given back): the result of its tests stands
      if (outcome !== undefined) {
        ctx.log(`${module}: ${message}`);
        return runOutcome(outcome.failures.length > 0, outcome.unknown).result;
      }
      // the ledger could not be read or written before the module ran: none of its tests was checked
      outcomes.set(module, { tests: 0, passed: 0, failures: [], ran: false, unknown: message });
      return 'unknown';
    })), (module, result) => reportResult(ctx, module, result, outcomes.get(module)?.durationMs));
    const times = Object.fromEntries([...outcomes].flatMap(([m, o]) => (o.durationMs === undefined ? [] : [[m, o.durationMs]])));
    await writeJsonAtomic(file, { ...last, ...times });
    return { results: new Map(modules.map((m) => [m, reused.has(m) ? 'pass' : ran.get(m) ?? 'fail'])), outcomes };
  } finally {
    await runner?.close();
  }
}

/**
 * The result of a run that stopped before any module test (a preflight step failed or the runner did not start):
 * exit code 1 and a run log summary of one test that did not pass, so the run never reads as all passed.
 */
function stoppedRun(ctx: Context, target: Target, error: unknown): CommandResult {
  const message = error instanceof Error ? error.message : String(error);
  ctx.log(message);
  const summary = { tests: 1, passed: 0 };
  return { exitCode: 1, data: { target: recordTarget(target), error: message, ...summary }, summary };
}

/** The kept passing results of the modules with a key (`test-reuse.ts`). */
async function keptResults(ctx: Context, keys: ReadonlyMap<string, string> | null): Promise<Map<string, KeptResult>> {
  const reused = new Map<string, KeptResult>();
  for (const [module, key] of keys ?? []) {
    const kept = await keptResult(ctx.env, key);
    if (kept !== null) reused.set(module, kept);
  }
  return reused;
}

/** Keeps the result of each module with a key that ran and passed every test of it, not one that took a render pass. */
async function keepPassed(
  ctx: Context,
  keys: ReadonlyMap<string, string> | null,
  results: ReadonlyMap<string, ModuleResult>,
  outcomes: ReadonlyMap<string, ModuleOutcome>,
  target: string,
  commit: string,
): Promise<void> {
  for (const [module, key] of keys ?? []) {
    const outcome = outcomes.get(module);
    if (results.get(module) !== 'pass' || outcome === undefined || outcome.reused === true || outcome.inherited !== undefined || outcome.tests === 0 || outcome.passed !== outcome.tests) continue;
    await keepResult(ctx.env, key, { tests: outcome.tests, passed: outcome.passed, target, module, commit });
  }
}

/**
 * Why a run that is not a `--file` run leaves no test record: changes in the checkout at its start or end, or a HEAD
 * that moved while it ran. Null when it records, and for a `--file` run, which never records.
 */
function noRecordReason(fileRun: boolean, clean: boolean, sameHead: boolean): string | null {
  if (fileRun) return null;
  if (!clean) return 'uncommitted changes in the checkout';
  return sameHead ? null : 'HEAD moved during the run';
}

/** The reason of each `unknown` module. */
function unknownReasons(results: ReadonlyMap<string, ModuleResult>, outcomes: ReadonlyMap<string, ModuleOutcome>): Record<string, string> {
  return Object.fromEntries([...results].flatMap(([m, r]) => (r === 'unknown' ? [[m, outcomes.get(m)?.unknown ?? 'not checked']] : [])));
}

/** The commit of the render pass `pass` each module took (`takeRenderPasses`). */
function inheritedCommits(outcomes: ReadonlyMap<string, ModuleOutcome>): Record<string, string> {
  return Object.fromEntries([...outcomes].flatMap(([m, o]) => (o.inherited === undefined ? [] : [[m, o.inherited]])));
}

/**
 * Each module of a native engine run that is `unknown` only because a locked screen kept its render pass from running
 * takes its last recorded render pass `pass` (`inheritedRenderPass`, ogw.md `### Godot core test`): it is then `pass`,
 * and its job result is reported again.
 */
export async function takeRenderPasses(
  ctx: Context,
  implDir: string,
  target: Target,
  commit: string,
  all: readonly CoreSpecModule[],
  results: Map<string, ModuleResult>,
  outcomes: Map<string, ModuleOutcome>,
): Promise<void> {
  if (target.kind !== 'engine' || target.web) return;
  // one diff per render pass commit for every module of the run
  const changed: ChangedPaths = new Map();
  for (const [module, result] of results) {
    const outcome = outcomes.get(module);
    if (result !== 'unknown' || outcome?.unknown !== SCREEN_LOCKED || outcome.failures.length > 0) continue;
    const from = await inheritedRenderPass(implDir, target.engine, module, commit, all, ctx.env, changed);
    if (from === null) continue;
    outcomes.set(module, { ...outcome, unknown: undefined, inherited: from });
    results.set(module, 'pass');
    await reportResult(ctx, module, 'pass', outcome.durationMs);
  }
}

/** The result of a run: exit code 0 only when every module is `pass`; an `unknown` module ends it with 1. */
export function runResult(target: Target, results: Map<string, ModuleResult>, outcomes: Map<string, ModuleOutcome>, noRecord: string | null = null): CommandResult {
  const ok = [...results.values()].every((r) => r === 'pass');
  const summary = testSummary(results, outcomes);
  return {
    exitCode: ok ? 0 : 1,
    text: noRecord === null ? summaryText(results, outcomes) : `${summaryText(results, outcomes)}\nno test record: ${noRecord}`,
    data: {
      target: recordTarget(target),
      modules: Object.fromEntries(results),
      failures: Object.fromEntries([...outcomes].map(([m, o]) => [m, o.failures])),
      counts: Object.fromEntries([...outcomes].map(([m, o]) => [m, { tests: o.tests, passed: o.passed, ran: o.ran !== false }])),
      durationsMs: Object.fromEntries([...outcomes].map(([m, o]) => [m, o.durationMs ?? null])),
      unknown: unknownReasons(results, outcomes),
      inherited: inheritedCommits(outcomes),
      reused: [...outcomes].filter(([, o]) => o.reused === true).map(([m]) => m),
      ...(noRecord === null ? {} : { noRecord }),
      ...summary,
    },
    summary,
  };
}

/** `ogw core test <engine|server|tools> [<module>...] [--web]`. */
export const testCommand: CommandDef = {
  name: ['core', 'test'],
  usage: 'ogw core test <engine|server|tools> [<module>...] [--web] [--file <test file>]',
  options: { web: { type: 'boolean' }, file: { type: 'string' } },
  background: {
    timeLimitMs: () => LIMITS.jobMs,
    validate: async (ctx, args) => {
      await checkArgs(ctx, args, testCommand.usage);
    },
  },
  async run(ctx, args) {
    const { implDir, target, given, file } = await checkArgs(ctx, args, this.usage);
    const work = await newPrivateTempFolder('ogw-core-test-', ctx.env);
    // an idle display that turns off keeps a render pass from running (ogw.md `### Godot core test`)
    const releaseAwake = awakeDeps.hold(ctx.env);
    try {
      // The record is of the commit the preflight checked and the tests start on, read while no merge can move HEAD.
      let start: TestStart;
      try {
        // on the main checkout the generated files the preflight writes are committed (ogw.md `## core spec and core test`),
        // and merges wait for the module tests (ogw.md `## agent merge`)
        start = await span('preflight', async () => testAtHead(implDir, (await ctx.workspace()).coreImpl, ctx.env, () => preflightAndImport(ctx, implDir, target, work, given.length === 0)));
      } catch (error) {
        return stoppedRun(ctx, target, error);
      }
      const startHead = start.head;
      let noRecord: string | null = null;
      let results: Map<string, ModuleResult>;
      let outcomes: Map<string, ModuleOutcome>;
      try {
        const all = await readCoreSpecDir(implDir);
        const modules = targetModules(all, target, given);
        // a passing result of the same key is used, not run again; a dirty checkout and a --file run neither use nor keep one
        const { keys, reused } = await span('kept results', async () => {
          const found = file === undefined && start.clean ? await moduleKeys(implDir, startHead, target, recordTarget(target), modules, all, ctx.env, (await ctx.settings()).tools) : null;
          return { keys: found, reused: await keptResults(ctx, found) };
        });
        let runner: Runner | null = null;
        if (modules.some((module) => !reused.has(module))) {
          try {
            runner = await span('runner', () => makeRunner(ctx, implDir, target, work, file));
          } catch (error) {
            return stoppedRun(ctx, target, error);
          }
        }
        ({ results, outcomes } = await runModules(ctx, runner, target, modules, reused));
        // still a reader of the main checkout: no merge moves HEAD meanwhile; another run's generated commit can, and then
        // the HEAD check below records nothing
        const endClean = (await statusLines(implDir, { env: ctx.env })).length === 0;
        // a run of one test file is not a run of its module: it leaves no record
        noRecord = noRecordReason(file !== undefined, start.clean && endClean, (await head(implDir, { env: ctx.env })) === startHead);
        if (file === undefined && noRecord === null) await span('record', async () => {
          await takeRenderPasses(ctx, implDir, target, startHead, all, results, outcomes);
          const reasons = unknownReasons(results, outcomes);
          const inherited = inheritedCommits(outcomes);
          await addTestRecord(implDir, {
            commit: startHead,
            target: recordTarget(target),
            modules: Object.fromEntries(results),
            ...(Object.keys(reasons).length > 0 ? { reasons } : {}),
            ...(Object.keys(inherited).length > 0 ? { inherited } : {}),
            recordedAt: Date.now(),
          });
          await keepPassed(ctx, keys, results, outcomes, recordTarget(target), startHead);
        });
      } finally {
        await start.release();
      }
      return runResult(target, results, outcomes, noRecord);
    } finally {
      releaseAwake();
      await rm(work, { recursive: true, force: true });
    }
  },
};
