import { mkdir, rm } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { flag, str, type CommandDef, type CommandResult, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists, readJsonIfExists, writeIfChanged, writeJsonAtomic } from '../../lib/fsx.ts';
import { coreSettingsFile, coreSettingTypesFile } from '../generate/api.ts';
import { resolveCoreImpl } from '../../lib/game.ts';
import { commonDir, head, statusLines } from '../../lib/git.ts';
import { harnessRoot } from '../../lib/paths.ts';
import { updateJob } from '../../lib/jobs.ts';
import { LIMITS } from '../../lib/limits.ts';
import { requireEngine, toolProgram } from '../env/api.ts';
import { clientModuleTableOrder, moduleListOrder, type SpecModule } from '../generate/lib/core-spec.ts';
import { coreModulesGd } from '../generate/lib/godot-files.ts';
import { renderCoreProjectGodot } from '../generate/lib/godot-project.ts';
import { testAtHead, type TestStart } from './lib/main-checkout.ts';
import { writeCoreSpec } from './spec-api.ts';
import { baseProtoErrors } from './lib/base-proto-check.ts';
import { fixtureIdErrors, licenseErrors } from './lib/content-checks.ts';
import { nativeModuleTest, resultsDirOf, setupGodot, webExport, webModuleTest, withGodotProject, type ModuleOutcome } from './lib/godot.ts';
import { type CoreSpecModule, enginesOf, moduleFolder, readCoreSpecDir, readEngineJson, unitTestProcessLimit } from './lib/impl.ts';
import { startPostgres } from './lib/postgres.ts';
import { runModulePool } from './lib/ready-queue.ts';
import { specDirErrors } from './lib/spec-dir-check.ts';
import { buildTestData, testGameSettings } from './lib/test-data.ts';
import { addTestRecord, type ModuleResult } from './lib/test-records.ts';
import { keepResult, keptResult, moduleKeys, type KeptResult } from './lib/test-reuse.ts';
import { godotCoreStaticCheck } from './lib/core-static-check.ts';
import { serverInternalImports } from './lib/core-server-imports.ts';
import { serverCoreStaticCheck } from './lib/core-server-static-check.ts';
import { serverModuleTest } from './lib/server-tests.ts';
import { runToolTest } from './lib/tool-test.ts';
import { TOOLS } from './lib/tools.ts';
import { engineAssetRules } from './lib/undefined.ts';
import { newPrivateTempFolder } from '../../lib/secret-files.ts';

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
  // files of every engine (`client-core` Godot `## folder`): the settings files made as `ogw generate` makes a game's,
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
  const resultsDir = resultsDirOf(work);
  if (!target.web) {
    const fixturesDir = join(implDir, 'fixtures');
    // the passes run in the shared project as readers: a setup in another process waits for them (`withGodotProject`)
    return { run: (module) => withGodotProject(ctx, implDir, () => nativeModuleTest(ctx, { setup, module, fixturesDir, resultsDir, timeoutMs, ...(file === undefined ? {} : { file }) })), close: () => Promise.resolve() };
  }
  const chromium = await toolProgram(ctx, 'chromium');
  if (chromium === null) throw new OgwError('harness settings tools.chromium is not on this host; the browser run stops');
  const exportDir = await webExport(ctx, implDir, setup, work);
  return { run: (module) => webModuleTest(ctx, { chromium, exportDir, module, resultsDir, timeoutMs }), close: () => Promise.resolve() };
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

/**
 * `--file`: one test file of the one module given, checkout relative, in that module's `tests/` folder. A server test
 * file is a `*.test.ts`; a Godot one a `.gd` script, run as its `res://` path. Not for `tools` or a browser run.
 */
function checkTestFile(implDir: string, target: Target, modules: readonly string[], file: string): string {
  if (target.kind === 'tools' || (target.kind === 'engine' && target.web)) throw new OgwError(`--file is for server and a native engine run, not ${recordTarget(target)}`);
  if (modules.length !== 1) throw new OgwError('--file takes exactly one module');
  const module = modules[0] as string;
  const folder = target.kind === 'server' ? `server/core/${module}/tests/` : `client/${target.engine}/core/${moduleFolder(module)}/tests/`;
  const suffix = target.kind === 'server' ? '.test.ts' : '.gd';
  if (!file.startsWith(folder) || !file.endsWith(suffix) || file.includes('..') || !exists(join(implDir, file))) {
    throw new OgwError(`--file must be a ${suffix} file in ${folder} of ${module}: ${file}`);
  }
  return target.kind === 'server' ? file : `res://${file.slice(`client/${target.engine}/`.length)}`;
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
 * counted test failing (for example no result), one more test than it passed. A module with no outcome (`skipped` because
 * a dependency did not pass) counts one test that did not pass, and so does a run with no module, so such a run never
 * reads as all passed. A tool `skipped` for its left-out round trip has an outcome: it counts its passed vitest tests.
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
    lines.push(`${module} ${result}${outcomes.get(module)?.reused === true ? ' (reused)' : ''}`);
    for (const failure of outcomes.get(module)?.failures ?? []) lines.push(`  ${failure}`);
    const skipped = outcomes.get(module)?.skipped;
    if (skipped !== undefined) lines.push(`  ${skipped}`);
  }
  return lines.join('\n');
}

/**
 * How many modules run at once. The native runs of an engine share the project, which a GUT run only reads, and each
 * has a `user://` of its own; an engine process keeps about two CPUs busy, so they take half of the CPUs.
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
  try {
    for (const [module, kept] of reused) {
      outcomes.set(module, { tests: kept.tests, passed: kept.passed, failures: [], reused: true });
      await reportResult(ctx, module, 'pass', undefined);
    }
    const toRun = modules.filter((module) => !reused.has(module));
    const ran = runner === null ? new Map<string, ModuleResult>() : await runModulePool(longestFirst(toRun, last), parallelismOf(target), async (module) => {
      const startedAt = Date.now();
      const outcome = await runner.run(module).catch((error: unknown): ModuleOutcome => ({ tests: 0, passed: 0, failures: [(error as Error).message], ran: false }));
      outcomes.set(module, { ...outcome, durationMs: Date.now() - startedAt });
      if (outcome.failures.length > 0) return 'fail';
      return outcome.skipped === undefined ? 'pass' : 'skipped';
    }, (module, result) => reportResult(ctx, module, result, outcomes.get(module)?.durationMs));
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

/** Keeps the result of each module with a key that ran and passed every test of it. */
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
    if (results.get(module) !== 'pass' || outcome === undefined || outcome.reused === true || outcome.tests === 0 || outcome.passed !== outcome.tests) continue;
    await keepResult(ctx.env, key, { tests: outcome.tests, passed: outcome.passed, target, module, commit });
  }
}

/** `ogw core test <engine|server|tools> [<module>...] [--web]`. */
export const testCommand: CommandDef = {
  name: ['core', 'test'],
  usage: 'ogw core test <engine|server|tools> [<module>...] [--web] [--file <test file>]',
  options: { web: { type: 'boolean' }, file: { type: 'string' } },
  background: { timeLimitMs: () => LIMITS.jobMs },
  async run(ctx, args) {
    const [name, ...given] = args.positionals;
    if (name === undefined) throw new OgwError(`usage: ${this.usage}`);
    const implDir = await resolveCoreImpl(await ctx.workspace(), ctx.cwd, ctx.env);
    if (!exists(implDir)) throw new OgwError(`not found: ${implDir}`);
    const target = await parseTarget(implDir, name, flag(args, 'web'));
    const work = await newPrivateTempFolder('ogw-core-test-', ctx.env);
    try {
      // The record is of the commit the preflight checked and the tests start on, read while no merge can move HEAD.
      let start: TestStart;
      try {
        // on the main checkout the generated files the preflight writes are committed (`core` command.md `## core spec file`),
        // and merges wait for the module tests (ogw.md `## agent merge`)
        start = await testAtHead(implDir, (await ctx.workspace()).coreImpl, ctx.env, () => preflightAndImport(ctx, implDir, target, work, given.length === 0));
      } catch (error) {
        return stoppedRun(ctx, target, error);
      }
      const startHead = start.head;
      let results: Map<string, ModuleResult>;
      let outcomes: Map<string, ModuleOutcome>;
      try {
        const all = await readCoreSpecDir(implDir);
        const modules = targetModules(all, target, given);
        const fileArg = str(args, 'file');
        const file = fileArg === undefined ? undefined : checkTestFile(implDir, target, given, fileArg);
        // a passing result of the same key is used, not run again; a dirty checkout and a --file run neither use nor keep one
        const keys = file === undefined && start.clean ? await moduleKeys(implDir, startHead, target, recordTarget(target), modules, all, ctx.env, (await ctx.settings()).tools) : null;
        const reused = await keptResults(ctx, keys);
        let runner: Runner | null = null;
        if (modules.some((module) => !reused.has(module))) {
          try {
            runner = await makeRunner(ctx, implDir, target, work, file);
          } catch (error) {
            return stoppedRun(ctx, target, error);
          }
        }
        ({ results, outcomes } = await runModules(ctx, runner, target, modules, reused));
        // still a reader of the main checkout: no merge moves HEAD meanwhile; another run's generated commit can, and then
        // the HEAD check below records nothing
        const endClean = (await statusLines(implDir, { env: ctx.env })).length === 0;
        // a run of one test file is not a run of its module: it leaves no record
        if (file === undefined && start.clean && endClean && (await head(implDir, { env: ctx.env })) === startHead) {
          const skips = Object.fromEntries([...outcomes].flatMap(([m, o]) => (o.skipped === undefined || results.get(m) !== 'skipped' ? [] : [[m, o.skipped]])));
          await addTestRecord(implDir, { commit: startHead, target: recordTarget(target), modules: Object.fromEntries(results), ...(Object.keys(skips).length > 0 ? { skips } : {}), recordedAt: Date.now() });
          await keepPassed(ctx, keys, results, outcomes, recordTarget(target), startHead);
        }
      } finally {
        await start.release();
      }
      const summary = testSummary(results, outcomes);
      const ok = [...results.values()].every((r) => r === 'pass');
      return {
        exitCode: ok ? 0 : 1,
        text: summaryText(results, outcomes),
        data: {
          target: recordTarget(target),
          modules: Object.fromEntries(results),
          failures: Object.fromEntries([...outcomes].map(([m, o]) => [m, o.failures])),
          counts: Object.fromEntries([...outcomes].map(([m, o]) => [m, { tests: o.tests, passed: o.passed, ran: o.ran !== false }])),
          durationsMs: Object.fromEntries([...outcomes].map(([m, o]) => [m, o.durationMs ?? null])),
          skipped: Object.fromEntries([...outcomes].flatMap(([m, o]) => (o.skipped === undefined ? [] : [[m, o.skipped]]))),
          reused: [...outcomes].filter(([, o]) => o.reused === true).map(([m]) => m),
          ...summary,
        },
        summary,
      };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
};
