import { cp, mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import { newId } from '../../../lib/ids.ts';
import { checkoutLock, commonDir } from '../../../lib/git.ts';
import { withLock } from '../../../lib/lock.ts';
import { harnessRoot } from '../../../lib/paths.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { withReader, withWriter, type RwLock } from '../../../lib/rwlock.ts';
import { killTree, run, runOk, spawnTracked, type RunResult } from '../../../lib/proc.ts';
import { requireEngine } from '../../env/api.ts';
import { SCREEN_LOCKED_SKIP } from './test-records.ts';
import { hostPlatform, moduleFolder, type EngineJson } from './impl.ts';
import { startTestHost, type TestHost } from '../../check/api.ts';
import { Slots } from '../../check/lib/instances.ts';
import { gutPackage, installPackage, isCorePlugin, pluginsFor } from './engine-packages.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';
import { renderCoreProjectGodot } from '../../generate/lib/godot-project.ts';
import { pageInput } from './page-input.ts';
import { installServiceWorker, WEB_EXPORT_OPTIONS } from '../../../lib/godot-web.ts';

/** Counts and failures of one module test. */
export interface ModuleOutcome {
  tests: number;
  passed: number;
  /** Failed test names and run failures; empty when the module passed. */
  failures: string[];
  /**
   * Whether the module's test runner (vitest, GUT) was started: false only when the run stopped before it, as an
   * `npm ci` that failed or a tool without vitest (`core` command.md `fix test proof`). Absent: true.
   */
  ran?: boolean;
  /** Why part of the module's tests were left out, which makes a module with no failure `skipped`. */
  skipped?: string;
  /** Wall time of the module's run, set by `ogw core test`. */
  durationMs?: number;
  /** A passing result of the same key that `ogw core test` used instead of running the module (`test-reuse.ts`). */
  reused?: boolean;
}

interface UnitTestResult {
  results?: { name?: unknown; status?: unknown; message?: unknown; checked_script_errors?: unknown }[];
  run_failures?: { message?: unknown }[];
}

/** The script runtime errors the tests of a result checked (`unit-test-core` `check_script_errors`). */
export function checkedScriptErrors(result: unknown): number {
  const results = (result as UnitTestResult | null)?.results ?? [];
  return results.reduce((sum, test) => sum + (typeof test.checked_script_errors === 'number' && test.checked_script_errors > 0 ? test.checked_script_errors : 0), 0);
}

/**
 * Engine output lines that fail a test run (`client-core` Godot `## test`): a line that holds `ERROR:` or `leaked at exit`,
 * and the `SCRIPT ERROR:` lines when their count is not the count the tests checked (`checked`). A core test run and a
 * client regression test run judge the same way.
 */
export function engineErrorLines(output: string, checked = 0): string[] {
  const lines = output.split(/\r?\n/);
  const script = lines.filter((line) => line.includes('SCRIPT ERROR:'));
  const other = lines.filter((line) => !line.includes('SCRIPT ERROR:') && /ERROR:|leaked at exit/.test(line));
  if (script.length === checked) return other;
  // with checked errors, the count tells a checked error the engine did not print from one more than was checked
  const count = checked > 0 ? [`${String(script.length)} SCRIPT ERROR lines, checked_script_errors ${String(checked)}`] : [];
  return [...script, ...count, ...other];
}

/** Lines of the engine output a run with no result shows. */
const NO_RESULT_TAIL = 20;

/**
 * Applies the core test result rules (`godot` `## test`, `unit-test-core` `### run and result file`)
 * to a result JSON (null when none arrived), the engine output, and the exit code (null for a browser run).
 */
export function judgeRun(result: unknown, output: string, exitCode: number | null, label: string): ModuleOutcome {
  const failures: string[] = [];
  if (result === null || typeof result !== 'object') {
    failures.push(`${label}: no result`);
    // what the engine printed last tells why no result came (`godot` `## test`)
    const tail = output.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '').slice(-NO_RESULT_TAIL);
    for (const line of tail) failures.push(`${label}: output: ${line}`);
    return { tests: 0, passed: 0, failures };
  }
  const { results = [], run_failures: runFailures = [] } = result as UnitTestResult;
  if (results.length === 0) failures.push(`${label}: no tests`);
  for (const test of results) if (test.status === 'fail') failures.push(`${label}: ${String(test.name)}: ${typeof test.message === 'string' ? test.message : ''}`);
  for (const failure of runFailures) failures.push(`${label}: run failure: ${String(failure.message)}`);
  if (exitCode !== null && exitCode !== 0) failures.push(`${label}: exit code ${String(exitCode)}`);
  for (const line of engineErrorLines(output, checkedScriptErrors(result))) failures.push(`${label}: ${line.trim()}`);
  const passed = results.filter((test) => test.status === 'pass' || test.status === 'skip').length;
  return { tests: results.length, passed, failures };
}

export function addOutcomes(a: ModuleOutcome, b: ModuleOutcome): ModuleOutcome {
  const skipped = a.skipped ?? b.skipped;
  return { tests: a.tests + b.tests, passed: a.passed + b.passed, failures: [...a.failures, ...b.failures], ran: a.ran !== false || b.ran !== false, ...(skipped === undefined ? {} : { skipped }) };
}

export interface GodotSetup {
  godot: string;
  project: string;
}

/**
 * Puts GUT and the `engine.json` plugins whose `platforms` hold this host OS into the Godot project `project`
 * (`client-core` Godot `## folder` `addons/`). A `ogw-` plugin comes from its committed `plugins/<plugin>/dist/<platform>/`.
 */
export async function installHostAddons(ctx: Context, engineJson: EngineJson, project: string): Promise<void> {
  await installPackage(ctx, gutPackage(engineJson), project);
  const platform = hostPlatform();
  for (const plugin of pluginsFor(engineJson, platform)) {
    if (isCorePlugin(plugin)) {
      const dist = join(project, 'plugins', plugin.name, 'dist', platform);
      if (!exists(dist)) throw new OgwError(`plugin ${plugin.name} has no build result in plugins/${plugin.name}/dist/${platform}/`);
      await cp(dist, project, { recursive: true });
    } else {
      await installPackage(ctx, plugin, project);
    }
  }
}

/** Setups done for one command run, keyed by its `env` object, so one command sets up each project once. */
const setups = new WeakMap<NodeJS.ProcessEnv, Map<string, Promise<GodotSetup>>>();

/**
 * The lock of the Godot project of `implDir` across processes: a setup, which rewrites `addons/` and `.godot/`, is its
 * writer; a test run in the project and a copy of it are readers, which go at once, since a GUT run writes no file of
 * the project (its `user://` is a folder of its own, `gutRun`).
 */
async function projectLock(ctx: Context, implDir: string, waitMs: number): Promise<RwLock> {
  return { base: await checkoutLock(implDir, 'ogw-godot-project.lock', { env: ctx.env }), waitMs };
}

/**
 * Puts GUT and the plugins for this host OS into the project, and imports the project once per command run. Setups of
 * the same project in other processes wait for each other.
 */
export function setupGodot(ctx: Context, implDir: string, engineJson: EngineJson): Promise<GodotSetup> {
  const done = setups.get(ctx.env) ?? new Map<string, Promise<GodotSetup>>();
  setups.set(ctx.env, done);
  const project = join(implDir, 'client', 'godot');
  let setup = done.get(project);
  if (!setup) {
    setup = setupGodotNow(ctx, implDir, engineJson, project);
    done.set(project, setup);
    setup.catch(() => done.delete(project));
  }
  return setup;
}

async function setupGodotNow(ctx: Context, implDir: string, engineJson: EngineJson, project: string): Promise<GodotSetup> {
  if (typeof engineJson.godot !== 'string') throw new OgwError('engine.json of godot has no godot version');
  const godot = await requireEngine(ctx, 'godot', engineJson.godot);
  await withWriter(await projectLock(ctx, implDir, 2 * LIMITS.programMs), async () => {
    await installHostAddons(ctx, engineJson, project);
    await runOk(godot, ['--headless', '--path', project, '--import'], { cwd: project, env: ctx.env, timeoutMs: LIMITS.programMs });
  });
  return { godot, project };
}

/**
 * Runs `fn`, which reads the Godot project of `implDir` in place or copies it, as a reader: no setup of it rewrites
 * `addons/` or `.godot/` meanwhile, and other readers go at once. A setup waits for a native core test run's module.
 */
export async function withGodotProject<T>(ctx: Context, implDir: string, fn: () => Promise<T>): Promise<T> {
  return withReader(await projectLock(ctx, implDir, LIMITS.jobMs), fn);
}

/** Sets up the Godot project of `implDir` and copies it to `dest` while no setup of it runs. */
export async function copyGodotProject(ctx: Context, implDir: string, engineJson: EngineJson, dest: string): Promise<GodotSetup> {
  const setup = await setupGodot(ctx, implDir, engineJson);
  await withGodotProject(ctx, implDir, () => cp(setup.project, dest, { recursive: true }));
  return setup;
}

/** GUT command line of a pass after the project arguments, without the test run config (`godot` `## test`). */
export function gutArgs(module: string | null, prefix: string): string[] {
  return ['-s', 'addons/gut/gut_cmdln.gd', ...gutOptions(module, prefix)];
}

/** The GUT options of a run, without the GUT command line script. */
export function gutOptions(module: string | null, prefix: string): string[] {
  return [
    `-gdir=${module === null ? 'res://core' : `res://core/${moduleFolder(module)}`}`,
    '-ginclude_subdirs', `-gprefix=${prefix}`, '-gsuffix=.gd',
    '-gpre_run_script=res://core/unit_test_core/dev/gut_pre_run.gd',
    '-gpost_run_script=res://core/unit_test_core/dev/gut_post_run.gd',
    '-gexit',
  ];
}

/** The test run config (`client-core` Godot `## test`): the values of one run that the GUT hooks read. */
export interface TestRunConfig {
  ogw_run_id: string;
  ogw_test_host: string;
  ogw_core_fixture_dir?: string;
  ogw_shared_fixture_dir?: string;
}

/** Writes the test run config of a native run into `dir`; returns the `-gconfig=` argument that names it. */
export async function testRunConfigArg(dir: string, config: TestRunConfig): Promise<string> {
  const file = join(dir, 'test-run-config.json');
  await writeJsonAtomic(file, config);
  return `-gconfig=${file}`;
}

/** The query of the browser run's `/app/index.html` URL that carries the test run config. */
export function testRunConfigQuery(config: TestRunConfig): string {
  return new URLSearchParams(Object.entries(config) as [string, string][]).toString();
}

async function hasRenderTests(dir: string): Promise<boolean> {
  if (!exists(dir)) return false;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && (await hasRenderTests(join(dir, entry.name)))) return true;
    if (entry.isFile() && entry.name.startsWith('test_render_') && entry.name.endsWith('.gd')) return true;
  }
  return false;
}

export interface PassOptions {
  setup: GodotSetup;
  module: string;
  fixturesDir: string;
  resultsDir: string;
  timeoutMs: number;
  /** `UnitTestCore.startTimeLimitMs` of the core under test; null for a core without it (`godot` `## test`). */
  startLimitMs: number | null;
  /** One test script of the module (`res://` path) to run alone, in the pass its name belongs to (`test_render_`: render). */
  file?: string;
}

/**
 * The environment variable Godot reads for the OS data folder on a host: `user://` is `<that folder>/Godot/app_userdata/
 * <project name>`, chosen by project name, so runs of the same core project in different worktrees share it unless each
 * points the variable at a folder of its own. macOS takes its data folder `$HOME/Library/Application Support` from `HOME`
 * and does not read `XDG_DATA_HOME`; the installed editor is self-contained, so it keeps nothing else under `HOME`.
 */
export function godotDataVariable(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'APPDATA';
  return platform === 'darwin' ? 'HOME' : 'XDG_DATA_HOME';
}

/** A core test GUT pass: the run, its label and where its result file goes. */
export interface GutPass extends GutRun {
  label: string;
  resultsDir: string;
}

/**
 * Runs GUT once with a test host and a fresh `user://`, keeps the result file, and judges the run. The `user://` of its
 * own keeps a `release` or test setup of a concurrent run of the same project name from deleting this run's files
 * (`unit-test-core` `### run and result file`, `### test setup`).
 */
/** One GUT run: the project, the GUT command line without the test run config, and the run's test run config. */
export interface GutRun {
  godot: string;
  project: string;
  /** Working folder of the Godot process; the project when absent. */
  cwd?: string;
  /** Whether Godot runs with `--headless`. */
  headless: boolean;
  /** The GUT command line without the test run config (`gutArgs`). */
  gut: string[];
  /** The test run config for the run ID and test host URL. */
  config: (runId: string, host: string) => TestRunConfig;
  timeoutMs: number;
  /** A run that has not sent `PUT /started` within this many ms did not start and is killed (`unit-test-core`). */
  startLimitMs?: number | null;
}

/** What a GUT run gave: the result the post-run hook sent (null when none), and the engine process run. */
export interface GutRunResult {
  runId: string;
  json: unknown;
  ran: RunResult;
}

/**
 * Runs GUT once with a test host, the test run config and a fresh `user://`. The `user://` of its own keeps a `release`
 * or test setup of a concurrent run of the same project name from deleting this run's files (`unit-test-core`
 * `### run and result file`, `### test setup`).
 */
export async function gutRun(ctx: Context, gut: GutRun): Promise<GutRunResult> {
  const runId = newId();
  const host = await startTestHost();
  const dataDir = await newPrivateTempFolder('ogw-godot-data-', ctx.env);
  try {
    const config = await testRunConfigArg(dataDir, gut.config(runId, host.url));
    const args = [...(gut.headless ? ['--headless'] : []), '--path', gut.project, ...gut.gut, config];
    const env = { ...ctx.env, [godotDataVariable()]: dataDir };
    const startLimit = gut.startLimitMs ?? null;
    const opened = Date.now();
    const notStarted = (): boolean => startLimit !== null && host.started() === null && Date.now() - opened >= startLimit;
    const ran = await run(gut.godot, args, { cwd: gut.cwd ?? gut.project, env, timeoutMs: gut.timeoutMs, ...(startLimit === null ? {} : { stopWhen: notStarted }) });
    return { runId, json: host.result(), ran };
  } finally {
    await host.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** A core test GUT pass: `gutRun`, its result file kept, and the run judged (`judgeRun`). */
export async function gutPass(ctx: Context, pass: GutPass): Promise<ModuleOutcome> {
  const { runId, json, ran: result } = await gutRun(ctx, pass);
  if (json !== null) await writeJsonAtomic(join(pass.resultsDir, `${runId}.json`), json);
  const outcome = judgeRun(json, `${result.stdout}\n${result.stderr}`, result.timedOut ? 1 : result.code ?? 1, pass.label);
  if (result.timedOut) outcome.failures.push(`${pass.label}: time limit ${String(pass.timeoutMs)} ms passed`);
  if (result.stopped === true) outcome.failures.push(`${pass.label}: the run did not start within ${String(pass.startLimitMs ?? 0)} ms (no PUT /started)`);
  return outcome;
}

/**
 * A native pass. A render pass runs alone on the host (`godot` `## test`): its window takes the focus and the screen
 * mode, so two render windows at once make macOS screen mode transitions and focus waits fail.
 */
async function nativePass(ctx: Context, options: PassOptions, render: boolean): Promise<ModuleOutcome> {
  if (!render) return nativeGutPass(ctx, options, false);
  const lock = join(await commonDir(harnessRoot(ctx.env), { env: ctx.env }), 'ogw-godot-render.lock');
  return withLock(lock, () => nativeGutPass(ctx, options, true), LIMITS.jobMs);
}

function nativeGutPass(ctx: Context, options: PassOptions, render: boolean): Promise<ModuleOutcome> {
  return gutPass(ctx, {
    godot: options.setup.godot,
    project: options.setup.project,
    headless: !render,
    gut: options.file === undefined ? gutArgs(options.module, render ? 'test_render_' : 'test_') : gutFileArgs(options.file),
    config: (runId, host) => ({ ogw_run_id: runId, ogw_test_host: host, ogw_core_fixture_dir: options.fixturesDir }),
    label: `${render ? 'render' : 'headless'} pass`,
    resultsDir: options.resultsDir,
    timeoutMs: options.timeoutMs,
    startLimitMs: options.startLimitMs,
  });
}

/** GUT command line of a pass that runs one test script alone. */
export function gutFileArgs(file: string): string[] {
  return ['-s', 'addons/gut/gut_cmdln.gd', `-gtest=${file}`, ...gutOptions(null, 'test_').filter((option) => !/^-g(dir|prefix)=|^-ginclude_subdirs$/.test(option))];
}

/**
 * Whether this host is macOS with its screen locked or its main display asleep: a window there ends no screen mode
 * transition.
 */
export async function macScreenLocked(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const session = await run('ioreg', ['-n', 'Root', '-d1'], { env, timeoutMs: 10_000 });
  if (/"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(session.stdout)) return true;
  const display = await run('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("CoreGraphics"); $.CGDisplayIsAsleep($.CGMainDisplayID())'], { env, timeoutMs: 10_000 });
  return display.stdout.trim() === '1';
}

/** A render pass left out on a locked macOS screen or a sleeping display: no test ran, the module is `skipped` with `SCREEN_LOCKED_SKIP`. */
async function renderPass(ctx: Context, options: PassOptions): Promise<ModuleOutcome> {
  if (await renderDeps.screenLocked(ctx.env)) return { tests: 0, passed: 0, failures: [], skipped: SCREEN_LOCKED_SKIP };
  return nativePass(ctx, options, true);
}

export const renderDeps = { screenLocked: macScreenLocked };

/** Native run of one module: the headless pass, then the render pass when the module has render tests. */
export async function nativeModuleTest(ctx: Context, options: PassOptions): Promise<ModuleOutcome> {
  if (options.file !== undefined) {
    return /\/test_render_[^/]*$/.test(options.file) ? renderPass(ctx, options) : nativePass(ctx, options, false);
  }
  const headless = await nativePass(ctx, options, false);
  const folder = join(options.setup.project, 'core', moduleFolder(options.module));
  if (!(await hasRenderTests(folder))) return headless;
  return addOutcomes(headless, await renderPass(ctx, options));
}

const WEB_PRESET = `[preset.0]

name="Web"
platform="Web"
runnable=true
dedicated_server=false
custom_features=""
export_filter="all_resources"
include_filter="core_fixtures/*.json, generated/*, build/data/*, addons/gut/*.txt"
exclude_filter=""
export_path=""
script_export_mode=0

[preset.0.options]

${Object.entries(WEB_EXPORT_OPTIONS).map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`).join('\n')}
`;

/** The main scene of the browser run's export copy, and its script: it starts the GUT command line runner. */
export const WEB_RUNNER_SCENE = 'res://ogw_web_runner.tscn';
const WEB_RUNNER_SCRIPT = `extends Node
# ogw browser run: the official web export template ignores \`-s\`, so this main scene starts what
# addons/gut/gut_cmdln.gd starts. GUT reads its options from the command line.


func _ready() -> void:
	load("res://addons/gut/gut_loader.gd")
	var cli: Node = (load("res://addons/gut/cli/gut_cli.gd") as GDScript).new()
	get_tree().root.add_child.call_deferred(cli)
	await cli.ready
	cli.call("main")
`;
const WEB_RUNNER_TSCN = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://ogw_web_runner.gd" id="1"]

[node name="OgwWebRunner" type="Node"]
script = ExtResource("1")
`;

/**
 * DEV export of the core project with the Web preset (`WEB_EXPORT_OPTIONS`: threaded, a PWA whose service worker is
 * client core's, `installServiceWorker`), made from a copy so
 * that `core_fixtures/`, the preset and the runner main scene never land in the checkout. Returns the export folder.
 */
export async function webExport(ctx: Context, implDir: string, setup: GodotSetup, work: string): Promise<string> {
  const copy = join(work, 'project');
  await withGodotProject(ctx, implDir, () => cp(setup.project, copy, { recursive: true }));
  const fixtures = join(implDir, 'fixtures');
  await mkdir(join(copy, 'core_fixtures'), { recursive: true });
  if (exists(fixtures)) await cp(fixtures, join(copy, 'core_fixtures'), { recursive: true });
  await writeFileAtomic(join(copy, 'export_presets.cfg'), WEB_PRESET);
  // `addons/` holds GUT and the plugins of this host OS, and no plugin targets the browser runtime: a GDExtension left in
  // the export logs an error at start
  for (const entry of await readdir(join(copy, 'addons'))) if (entry !== 'gut') await rm(join(copy, 'addons', entry), { recursive: true, force: true });
  await rm(join(copy, '.godot', 'extension_list.cfg'), { force: true });
  // the official web export template is built without path overrides: it ignores `-s` and refuses a scene argument
  await writeFileAtomic(join(copy, 'ogw_web_runner.gd'), WEB_RUNNER_SCRIPT);
  await writeFileAtomic(join(copy, 'ogw_web_runner.tscn'), WEB_RUNNER_TSCN);
  await writeFileAtomic(join(copy, 'project.godot'), renderCoreProjectGodot(WEB_RUNNER_SCENE));
  const out = join(work, 'web');
  await mkdir(out, { recursive: true });
  await runOk(setup.godot, ['--headless', '--path', copy, '--export-debug', 'Web', join(out, 'index.html')], {
    cwd: copy,
    env: ctx.env,
    timeoutMs: LIMITS.programMs,
  });
  await installServiceWorker(copy, out);
  return out;
}

/** Sets `GODOT_CONFIG.args` of an exported `index.html`. */
export function withConfigArgs(html: string, args: readonly string[]): string {
  const pattern = /("args"\s*:\s*)\[[^\]]*\]/;
  if (!pattern.test(html)) throw new OgwError('exported index.html has no GODOT_CONFIG.args');
  return html.replace(pattern, (_all, head: string) => `${head}${JSON.stringify(args)}`);
}

/** The start of a Chromium log entry: `[<pid>:<tid>:<time>:<severity>:<file>(<line>)] `, whose number fields may be absent. */
const LOG_ENTRY = /^\[(?:[\d/.]+:)*(?:INFO|WARNING|ERROR|FATAL|VERBOSE\d*):[^\]\n]*\] /gm;

/**
 * Console messages in Chromium's `--enable-logging=stderr` output. A console entry is `...:CONSOLE(<n>)] "<message>", source:
 * <source> (<n>)` (later versions write `CONSOLE:<n>`). Chromium writes the message raw: it may hold `"` and line breaks, so
 * the message runs to the last `", source: ` of its entry, and an entry runs to the start of the next one.
 */
export function consoleMessages(stderr: string): string {
  const starts = [...stderr.matchAll(LOG_ENTRY)].map((match) => match.index);
  const lines: string[] = [];
  for (const [i, start] of starts.entries()) {
    const entry = stderr.slice(start, starts[i + 1] ?? stderr.length);
    const head = /^[^\]\n]*:CONSOLE(?:\(\d+\)|:\d+)\] "/.exec(entry);
    if (head === null) continue;
    const body = entry.slice(head[0].length);
    const end = body.lastIndexOf('", source: ');
    lines.push(end === -1 ? body.replace(/"?\n*$/, '') : body.slice(0, end));
  }
  return lines.join('\n');
}

export interface WebOptions {
  chromium: string;
  exportDir: string;
  module: string;
  resultsDir: string;
  timeoutMs: number;
  /** `UnitTestCore.startTimeLimitMs` of the core under test; null for a core without it. */
  startLimitMs: number | null;
}

/** How many times a browser run opens its page when the page did not load (the browser cut off an `/app/` file). */
export const WEB_LOAD_ATTEMPTS = 2;

/**
 * How many browser runs of this process may be loading their page at once: from opening the page to its `PUT /started`.
 * Loading puts the whole export (tens of MB) into the cache of the service worker, and many pages that load at once
 * failed there with `network error`; the tests of started pages run together without this limit.
 */
export const WEB_LOADING_PAGES = 4;
const webLoading = new Slots(WEB_LOADING_PAGES);

/**
 * Browser run of one module in headless Chromium against the test host's `/app/index.html`. A page whose load the
 * browser cut off sends no result, so it is ended at once and opened again, up to `WEB_LOAD_ATTEMPTS` times.
 */
export async function webModuleTest(ctx: Context, options: WebOptions): Promise<ModuleOutcome> {
  for (let attempt = 1; ; attempt++) {
    const run = await webModuleRun(ctx, options);
    if (!run.cutOff || attempt >= WEB_LOAD_ATTEMPTS) return run.outcome;
  }
}

/** One browser run; `cutOff` when the page did not load and no result came. */
async function webModuleRun(ctx: Context, options: WebOptions): Promise<{ outcome: ModuleOutcome; cutOff: boolean }> {
  const runId = newId();
  const appDir = await newPrivateTempFolder('ogw-web-app-', ctx.env);
  const host = await startTestHost(appDir);
  const args = gutOptions(options.module, 'test_');
  const query = testRunConfigQuery({ ogw_run_id: runId, ogw_test_host: host.url, ogw_core_fixture_dir: 'res://core_fixtures' });
  const profile = await newPrivateTempFolder('ogw-chromium-', ctx.env);
  let stderr = '';
  let browser: ReturnType<typeof spawnTracked> | null = null;
  let browserEnded: string | null = null;
  // a test's `POST /input` goes into the page through DevTools (`unit-test-core` `### test host`)
  const input = pageInput(profile, `${host.url}/app/index.html`, () => browserEnded);
  host.onInput(input.put);
  // only a core that sends `PUT /started` tells when its page has loaded
  let loading = options.startLimitMs !== null;
  const loaded = (): void => {
    if (!loading) return;
    loading = false;
    webLoading.release();
  };
  if (loading) await webLoading.acquire();
  try {
    await appFolder(options.exportDir, appDir, args);
    browser = spawnTracked(options.chromium, [
      // without a user gesture the audio context stays suspended, and a test that waits for audio never ends
      '--headless', '--no-first-run', '--autoplay-policy=no-user-gesture-required', '--enable-logging=stderr', '--v=0', `--user-data-dir=${profile}`,
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `${host.url}/app/index.html?${query}`,
    ], { env: ctx.env, stdio: ['ignore', 'ignore', 'pipe'] });
    browser.once('exit', (code, signal) => {
      browserEnded = `headless browser ended with ${String(code ?? signal)}`;
    });
    browser.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const opened = Date.now();
    const startLimit = options.startLimitMs;
    const notStarted = (): boolean => startLimit !== null && host.started() === null && Date.now() - opened >= startLimit;
    const json = await waitForResult(host, options.timeoutMs, () => {
      if (host.started() !== null) loaded();
      return host.appCutOff().length > 0 || notStarted();
    });
    const cutOff = json === null && (host.appCutOff().length > 0 || notStarted());
    // the post-run hook's `release` prints after the result; the run sends `PUT /released` and prints its last line when
    // it has ended (`client-core` Godot `## test`). Without that signal the run reads on at most CONSOLE_DRAIN_MS.
    if (json !== null) await releasedOrDrained(host, () => stderr, runId, CONSOLE_DRAIN_MS);
    if (json !== null) await writeJsonAtomic(join(options.resultsDir, `${runId}.json`), json);
    const outcome = judgeRun(json, consoleMessages(stderr), null, 'browser run');
    for (const failure of host.inputFailures()) outcome.failures.push(`browser run: input: ${failure}`);
    if (cutOff && host.appCutOff().length > 0) {
      outcome.failures.push(`browser run: the page did not load: the browser closed ${host.appCutOff().join(', ')} before it was sent to the end`);
    } else if (cutOff) {
      outcome.failures.push(`browser run: the page did not start within ${String(startLimit ?? 0)} ms (no PUT /started)`);
    } else if (json === null) {
      outcome.failures.push(`browser run: no result within ${String(options.timeoutMs)} ms`);
      // the browser's own output tells why the page sent nothing (`godot` `## test`)
      const tail = stderr.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '').slice(-NO_RESULT_TAIL);
      for (const line of tail) outcome.failures.push(`browser run: browser: ${line}`);
    }
    return { outcome, cutOff };
  } finally {
    loaded();
    input.close();
    if (browser) killTree(browser, 'SIGKILL');
    await host.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    await rm(appDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const RESULT_POLL_MS = 200;

/** The most the browser run reads the console after the result, when the run sends no release signal. */
export const CONSOLE_DRAIN_MS = 5000;

/** The line `UnitTestCore` prints last in a run, after `PUT /released`. */
export function releasedLine(runId: string): string {
  return `UnitTestCore released run ${runId}`;
}

/**
 * Waits until the run sent `PUT /released` with `runId` and its console output holds `releasedLine(runId)` (the
 * request and the console reach the tool on two channels with no order between them), or `maxMs` passes.
 */
export async function releasedOrDrained(host: TestHost, stderr: () => string, runId: string, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  const line = releasedLine(runId);
  while (Date.now() < deadline) {
    if (host.released() === runId && consoleMessages(stderr()).split('\n').includes(line)) return;
    await sleep(Math.min(RESULT_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

/** The result the run sent to the test host, or null when none arrived within `timeoutMs` or before `stop` gave true. */
export async function waitForResult(host: TestHost, timeoutMs: number, stop: () => boolean = () => false): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = host.result();
    if (result !== null || Date.now() >= deadline || stop()) return result;
    await sleep(Math.min(RESULT_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

/**
 * The folder one browser run serves under `/app/`: links to the export files, and its own `index.html`
 * whose `GODOT_CONFIG.args` carry this run's arguments.
 */
export async function appFolder(exportDir: string, appDir: string, args: readonly string[]): Promise<void> {
  for (const entry of await readdir(exportDir)) {
    if (entry !== 'index.html') await symlink(join(exportDir, entry), join(appDir, entry));
  }
  await writeFileAtomic(join(appDir, 'index.html'), withConfigArgs(await readFile(join(exportDir, 'index.html'), 'utf8'), args));
}

/** Folder for this run's result files in its work folder, removed with it at the end of the run (ogw.md `## temp folder`). */
export function resultsDirOf(work: string): string {
  return join(work, 'results');
}
