import { availableParallelism } from 'node:os';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { baseProtoErrors } from '../../../src/commands/core/lib/base-proto-check.ts';
import { godotDataVariable, renderDeps } from '../../../src/commands/core/lib/godot.ts';
import { withCoreMain } from '../../../src/commands/core/lib/main-checkout.ts';
import { serverCoreStaticCheck } from '../../../src/commands/core/lib/core-server-static-check.ts';
import { readTestRecords, SCREEN_LOCKED_SKIP } from '../../../src/commands/core/lib/test-records.ts';
import { serverImplementedModules } from '../../../src/commands/core/lib/server-layout.ts';
import { serverModuleTest } from '../../../src/commands/core/lib/server-tests.ts';
import { runToolTest } from '../../../src/commands/core/lib/tool-test.ts';
import { buildTool } from '../../../src/commands/core/lib/tools.ts';
import { writeCoreSpec } from '../../../src/commands/core/spec-api.ts';
import { parallelismOf, recordTarget, SERVER_WORKERS, testSummary } from '../../../src/commands/core/test.ts';
import type { ModuleResult } from '../../../src/commands/core/lib/test-records.ts';
import { requireEngine, toolProgram } from '../../../src/commands/env/api.ts';
import { ogw, commitAll, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeBin, pathEnv, writeFiles } from './helpers.ts';
import { specModule, writeImpl } from './impl-fixture.ts';

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

/** Fake Godot: imports, exports, and runs GUT by sending a result to the test host. `FAKE_FAIL` names a failing module folder. */
const GODOT = `
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n');
if (args.includes('--import')) {
  // like Godot 4.4 and later, the import gives a script without a .uid one (the fixture's own scripts have none: only
  // the generated folder is walked)
  const project = args[args.indexOf('--path') + 1];
  const walk = (dir) => { if (!fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'addons' && e.name !== '.godot') walk(p); } else if (p.endsWith('.gd') && !fs.existsSync(p + '.uid')) fs.writeFileSync(p + '.uid', 'uid://x\\n'); } };
  if (process.env.FAKE_UIDS) walk(path.join(project, 'generated'));
  process.exit(0);
}
const exp = args.indexOf('--export-debug');
if (exp >= 0) {
  const out = args[exp + 2]; fs.writeFileSync(out, '<script>const GODOT_CONFIG = {"args":[],"executable":"index"};</script>');
  fs.writeFileSync(path.join(path.dirname(out), 'index.wasm'), 'w');
  fs.writeFileSync(path.join(path.dirname(out), 'index.service.worker.js'), 'const CACHE_VERSION = "v1";\\n');
  const project = args[args.indexOf('--path') + 1];
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ fixtures: fs.readdirSync(path.join(project, 'core_fixtures')), preset: fs.readFileSync(path.join(project, 'export_presets.cfg'), 'utf8').includes('variant/thread_support=true') && fs.readFileSync(path.join(project, 'export_presets.cfg'), 'utf8').includes('script_export_mode=0'), filter: (/include_filter="([^"]*)"/.exec(fs.readFileSync(path.join(project, 'export_presets.cfg'), 'utf8')) || [])[1], addons: fs.readdirSync(path.join(project, 'addons')), extensionList: fs.existsSync(path.join(project, '.godot', 'extension_list.cfg')), mainScene: (/run\\/main_scene="([^"]*)"/.exec(fs.readFileSync(path.join(project, 'project.godot'), 'utf8')) || [])[1], runner: fs.readFileSync(path.join(project, 'ogw_web_runner.tscn'), 'utf8').includes('res://ogw_web_runner.gd') && fs.readFileSync(path.join(project, 'ogw_web_runner.gd'), 'utf8').includes('res://addons/gut/cli/gut_cli.gd') }) + '\\n');
  process.exit(0);
}
const get = (p) => (args.find((a) => a.startsWith(p)) || '').slice(p.length);
const cfgPath = (args.find((a) => a.startsWith('-gconfig=')) || '').slice('-gconfig='.length);
const cfg = cfgPath ? JSON.parse(require('node:fs').readFileSync(cfgPath, 'utf8')) : {};
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ config: cfg }) + '\\n');
const folder = get('-gdir=res://core/');
const failing = folder === process.env.FAKE_FAIL;
// a GUT run that ends at its start, with no result
if (folder === process.env.FAKE_NO_RESULT) process.exit(2);
const render = get('-gprefix=') === 'test_render_';
const dataDir = process.env[process.env.FAKE_DATA_VAR] || null;
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ dataDir, dataDirExists: dataDir !== null && fs.existsSync(dataDir) }) + '\\n');
if (process.env.FAKE_PROJECT_LOCK) { const readers = process.env.FAKE_PROJECT_LOCK + '-readers'; fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ projectLocked: fs.existsSync(readers) && fs.readdirSync(readers).length > 0 }) + '\\n'); }
const body = { run_id: cfg.ogw_run_id, kind: 'core', engine: 'godot', results: [{ name: folder + '::' + (render ? 'render' : 'test'), status: failing ? 'fail' : 'pass', duration_ms: 1, message: failing ? 'expected 1' : '' }], run_failures: [] };
const startedAt = Date.now();
setTimeout(() => fetch(cfg.ogw_test_host + '/result', { method: 'PUT', body: JSON.stringify(body) }).then(() => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ span: [startedAt, Date.now()], folder, render }) + '\\n');
  process.exit(failing ? 1 : 0);
}), Number(process.env.FAKE_DELAY || 0));
`;

/** Fake Chromium: reads GODOT_CONFIG.args from index.html and sends a result; logs a console line. */
const CHROMIUM = `
const url = process.argv[process.argv.length - 1];
(async () => {
  const html = await (await fetch(url)).text();
  const args = JSON.parse(/"args":(\\[[^\\]]*\\])/.exec(html)[1]);
  const get = (p) => (args.find((a) => a.startsWith(p)) || '').slice(p.length);
  // the test run config comes in the page URL query
  const query = new URL(url).searchParams;
  process.stderr.write('[1:INFO:CONSOLE(1)] "' + (query.get('ogw_core_fixture_dir') === 'res://core_fixtures' && !args.some((a) => a.startsWith('-gconfig=') || a === '-s') && process.argv.includes('--autoplay-policy=no-user-gesture-required') ? 'ok' : 'ERROR: fixtures') + '", source: x\\n');
  const folder = get('-gdir=res://core/');
  await fetch(query.get('ogw_test_host') + '/result', { method: 'PUT', body: JSON.stringify({ run_id: query.get('ogw_run_id'), results: [{ name: folder + '::web', status: 'pass' }], run_failures: [] }) });
  // a release that prints a second after the result, then the release signal and the last line of the run
  if (process.env.FAKE_RELEASE_ERROR) await new Promise((r) => setTimeout(r, 1000));
  if (process.env.FAKE_RELEASE_ERROR) process.stderr.write('[1:INFO:CONSOLE(2)] "ERROR: release", source: x\\n');
  await fetch(query.get('ogw_test_host') + '/released', { method: 'PUT', body: JSON.stringify({ run_id: query.get('ogw_run_id') }) });
  process.stderr.write('[1:INFO:CONSOLE(3)] "UnitTestCore released run ' + query.get('ogw_run_id') + '", source: x\\n');
  setInterval(() => undefined, 1000);
})();
`;

const DATA_TOOL = `
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: 'data', args }) + '\\n');
const read = (flag) => JSON.parse(fs.readFileSync(args[args.indexOf(flag) + 1], 'utf8'));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ dataInputs: { coreSpec: read('--core-spec'), modules: read('--modules'), gameSettings: read('--game-settings'), registry: read('--id-registry') } }) + '\\n');
fs.writeFileSync(args[args.indexOf('--id-registry') + 1], JSON.stringify({ '[known]': 1 }));
if (process.env.FAKE_DATA_FAIL) { process.stdout.write('data/tables/x.csv:2 ERROR structure'); process.exit(1); }
if (process.env.FAKE_MATCH && !args.includes('--binary')) {
  const file = require('node:path').join(args[args.indexOf('--game') + 1], 'data', 'translations', 'en.csv');
  fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
  fs.writeFileSync(file, 'key,source,source_hash,current_hash,text\\nmatched,M,h,h,M\\n');
}
if (process.env.FAKE_GENERATED_SCRIPT) {
  const dir = require('node:path').join(process.cwd(), 'client', 'godot', 'generated', 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(require('node:path').join(dir, 'new_table.gd'), 'class_name NewTable\\n');
}
`;

const CONTRACT_TOOL = `
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: 'contract', args: process.argv.slice(2) }) + '\\n');
`;

const DOCKER = `
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ docker: args }) + '\\n');
if (args[0] === 'create') { process.stdout.write('cid123\\n'); process.exit(0); }
if (args[0] === 'cp') { fs.writeFileSync(process.env.FAKE_LOG + '.tar', fs.readFileSync(0)); process.exit(0); }
if (args[0] === 'port') { process.stdout.write('127.0.0.1:5555\\n'); process.exit(0); }
process.exit(0);
`;

interface Setup {
  ws: TestWorkspace;
  env: NodeJS.ProcessEnv;
  log: () => unknown[];
}

function setup(): Setup {
  const ws = makeWorkspace();
  writeImpl(ws.coreImpl);
  writeFiles(ws.coreImpl, { 'client/godot/core/ui_core/tests/test_render_ui.gd': 'extends UnitTestCase\n' });
  commitAll(ws.coreImpl, 'render test');
  const logFile = join(ws.root, 'fake.log');
  writeFileSync(logFile, '');
  fakeBin(ws, 'godot', GODOT);
  fakeBin(ws, 'chromium', CHROMIUM);
  fakeBin(ws, 'docker', DOCKER);
  const tools = join(ws.root, 'tools');
  mkdirSync(tools);
  writeFileSync(join(tools, 'data-tool.js'), DATA_TOOL);
  writeFileSync(join(tools, 'contract-tool.js'), CONTRACT_TOOL);
  vi.mocked(buildTool).mockImplementation((_env, _impl, tool) => Promise.resolve(join(tools, `${tool}.js`)));
  vi.mocked(requireEngine).mockResolvedValue(join(ws.root, 'bin', 'godot'));
  vi.mocked(toolProgram).mockResolvedValue(join(ws.root, 'bin', 'chromium'));
  return {
    ws,
    env: pathEnv(ws, { FAKE_LOG: logFile }),
    log: () => readFileSync(logFile, 'utf8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as unknown),
  };
}

beforeEach(() => {
  vi.mocked(writeCoreSpec).mockReset().mockResolvedValue({ modules: new Map(), settingTypes: new Map(), errors: [], dir: '', written: [], deleted: [], settingTypesWritten: false });
  vi.mocked(baseProtoErrors).mockReset().mockResolvedValue([]);
  vi.mocked(serverModuleTest).mockReset();
  vi.mocked(runToolTest).mockReset();
  vi.mocked(serverCoreStaticCheck).mockReset().mockResolvedValue([]);
  // the host's own screen does not decide the render passes of these tests
  renderDeps.screenLocked = () => Promise.resolve(false);
});

describe('ogw core test godot', () => {
  it('runs each module headless and with its render tests, then records the clean checkout', async () => {
    const { ws, env, log } = setup();
    const jobs = join(ws.root, 'jobs');
    mkdirSync(jobs);
    writeFileSync(join(jobs, 'job1.json'), JSON.stringify({ id: 'job1', status: 'running', meta: {} }));
    const run = await ogw(ws, ['core', 'test', 'godot', '--json'], { env: { ...env, OGW_JOB_ID: 'job1', OGW_JOBS_DIR: jobs } });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ target: 'godot', modules: { LogCore: 'pass', UICore: 'pass' }, failures: { LogCore: [], UICore: [] },
      counts: { LogCore: { tests: 1, passed: 1, ran: true }, UICore: { tests: 2, passed: 2, ran: true } },
      durationsMs: { LogCore: expect.any(Number) as number, UICore: expect.any(Number) as number },
      skipped: {},
      reused: [],
      tests: 3,
      passed: 3,
    });
    expect(JSON.parse(readFileSync(join(jobs, 'job1.json'), 'utf8'))).toMatchObject({ meta: { modules: { LogCore: 'pass', UICore: 'pass' } } });
    const calls = log();
    const runs = calls.filter((c): c is string[] => Array.isArray(c) && !c.includes('--import'));
    // modules run at once, so their passes are in no fixed order; a module's render pass follows its headless pass
    const passes = runs.map((a) => [a[0], a.find((x) => x.startsWith('-gdir=')), a.find((x) => x.startsWith('-gprefix='))]);
    expect([...passes].sort()).toEqual([
      ['--headless', '-gdir=res://core/log_core', '-gprefix=test_'],
      ['--headless', '-gdir=res://core/ui_core', '-gprefix=test_'],
      ['--path', '-gdir=res://core/ui_core', '-gprefix=test_render_'],
    ]);
    expect(passes.findIndex((p) => p[1] === '-gdir=res://core/ui_core' && p[0] === '--headless')).toBeLessThan(passes.findIndex((p) => p[0] === '--path'));
    // the run's values go in the test run config file that -gconfig names, not after `--`
    expect(runs[0]?.some((a) => a.startsWith('-gconfig='))).toBe(true);
    expect(runs[0]).not.toContain('--');
    expect(calls).toContainEqual({ config: expect.objectContaining({ ogw_core_fixture_dir: join(ws.coreImpl, 'fixtures'), ogw_run_id: expect.any(String) as string }) as unknown });
    expect(calls.filter((c) => Array.isArray(c) && c.includes('--import'))).toHaveLength(1);
    // the core test data is matched first (no --binary), then built (--binary)
    const dataRuns = calls.filter((c) => (c as { tool?: string }).tool === 'data') as { args: string[] }[];
    expect(dataRuns.map((r) => r.args.includes('--binary'))).toEqual([false, true]);
    const data = dataRuns[1] as { args: string[] };
    expect(data.args.slice(0, 4)).toEqual(['--game', join(ws.coreImpl, 'test-data'), '--engine', 'godot']);
    const contract = calls.find((c) => (c as { tool?: string }).tool === 'contract') as { args: string[] };
    expect(contract.args).toEqual(['--game', join(ws.coreImpl, 'test-data'), '--engine', 'godot', '--base-proto', join(ws.coreImpl, 'proto'), '--core-settings', join(ws.coreImpl, 'settings', 'core-settings.json')]);
    expect(existsSync(join(ws.coreImpl, 'client/godot/addons/ogw-secure-storage/a.gdextension'))).toBe(true);
    const records = await readTestRecords(ws.coreImpl);
    expect(records).toEqual([{ commit: sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim(), target: 'godot', modules: { LogCore: 'pass', UICore: 'pass' }, recordedAt: expect.any(Number) as number }]);
    // the result files live in the run's work folder, removed with it: nothing is left in the git common dir
    expect(existsSync(join(ws.coreImpl, '.git', 'ogw-core-test-results'))).toBe(false);
  });

  it('leaves out the render pass on a locked screen as skipped, records why, and passes the headless pass', async () => {
    const { ws, env } = setup();
    renderDeps.screenLocked = () => Promise.resolve(true);
    const run = await ogw(ws, ['core', 'test', 'godot'], { env });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe(`LogCore pass\nUICore skipped\n  ${SCREEN_LOCKED_SKIP}\n`);
    expect(await readTestRecords(ws.coreImpl)).toEqual([{
      commit: sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim(), target: 'godot', modules: { LogCore: 'pass', UICore: 'skipped' },
      skips: { UICore: SCREEN_LOCKED_SKIP }, recordedAt: expect.any(Number) as number,
    }]);
  });

  it('runs the dependents of a failed module with their own result, fails, and records each result of the clean checkout', async () => {
    const { ws, env } = setup();
    const run = await ogw(ws, ['core', 'test', 'godot'], { env: { ...env, FAKE_FAIL: 'log_core' } });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('LogCore fail\n  headless pass: log_core::test: expected 1\n  headless pass: exit code 1\nUICore pass\n');
    expect(await readTestRecords(ws.coreImpl)).toEqual([
      { commit: sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim(), target: 'godot', modules: { LogCore: 'fail', UICore: 'pass' }, recordedAt: expect.any(Number) as number },
    ]);
    const json = await ogw(ws, ['core', 'test', 'godot', '--json'], { env: { ...env, FAKE_FAIL: 'log_core' } });
    const summary = JSON.parse(json.stdout) as { tests: number; passed: number; counts: Record<string, { tests: number; passed: number; ran: boolean }> };
    expect(summary.passed).toBeLessThan(summary.tests);
    // the failed module's tests ran: `fix test proof` counts its failure
    expect(summary.counts.LogCore?.ran).toBe(true);
    expect(summary.counts.LogCore?.passed).toBeLessThan(summary.counts.LogCore?.tests ?? 0);
    // a GUT run that ended with no result was started: a crash fails the module, it does not make it not run
    const ended = JSON.parse((await ogw(ws, ['core', 'test', 'godot', 'LogCore', '--json'], { env: { ...env, FAKE_NO_RESULT: 'log_core' } })).stdout) as typeof summary;
    expect(ended.counts.LogCore).toEqual({ tests: 0, passed: 0, ran: true });
  });

  it('runs one test file of one module with --file in its pass, and records nothing', async () => {
    const { ws, env, log } = setup();
    writeFiles(ws.coreImpl, { 'client/godot/core/ui_core/tests/test_render_one.gd': 'extends GutTest\n' });
    commitAll(ws.coreImpl, 'a test file');
    const run = await ogw(ws, ['core', 'test', 'godot', 'UICore', '--file', 'client/godot/core/ui_core/tests/test_render_one.gd'], { env });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('UICore pass\n');
    const runs = log().filter((c): c is string[] => Array.isArray(c) && !c.includes('--import'));
    expect(runs).toHaveLength(1);
    // a test_render_ script runs in the render pass, without --headless
    expect(runs[0]?.[0]).toBe('--path');
    expect(runs[0]).toContain('-gtest=res://core/ui_core/tests/test_render_one.gd');
    expect(runs[0]?.some((a) => a.startsWith('-gdir='))).toBe(false);
    expect(await readTestRecords(ws.coreImpl)).toEqual([]);
  });

  it('takes --file only as one test file of the one module given, of server or a native engine run', async () => {
    const { ws, env } = setup();
    const cases: [string[], string][] = [
      [['godot', '--file', 'client/godot/core/ui_core/tests/a.gd'], '--file takes exactly one module'],
      [['godot', 'UICore', 'LogCore', '--file', 'client/godot/core/ui_core/tests/a.gd'], '--file takes exactly one module'],
      [['godot', 'UICore', '--file', 'client/godot/core/log_core/tests/a.gd'], '--file must be a .gd file in client/godot/core/ui_core/tests/ of UICore'],
      [['godot', 'UICore', '--file', 'client/godot/core/ui_core/tests/missing.gd'], '--file must be a .gd file in client/godot/core/ui_core/tests/ of UICore'],
      [['godot', 'UICore', '--web', '--file', 'client/godot/core/ui_core/tests/a.gd'], '--file is for server and a native engine run, not godot --web'],
    ];
    for (const [argv, message] of cases) {
      const run = await ogw(ws, ['core', 'test', ...argv], { env });
      expect(run.code, argv.join(' ')).toBe(1);
      expect(`${run.stdout}${run.stderr}`).toContain(message);
    }
  });

  it('records nothing for a checkout with changes, even when every module passes', async () => {
    const { ws, env } = setup();
    writeFileSync(join(ws.coreImpl, 'untracked.txt'), '');
    const run = await ogw(ws, ['core', 'test', 'godot'], { env });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('LogCore pass\nUICore pass\n');
    expect(await readTestRecords(ws.coreImpl)).toEqual([]);
  });

  it('runs each native pass as a reader of the Godot project lock, which setups in other processes wait for', async () => {
    const { ws, env, log } = setup();
    const lock = join(sh(ws.coreImpl, 'git', ['rev-parse', '--absolute-git-dir']).trim(), 'ogw-godot-project.lock');
    expect((await ogw(ws, ['core', 'test', 'godot'], { env: { ...env, FAKE_PROJECT_LOCK: lock } })).code).toBe(0);
    const passes = log().filter((c) => (c as { projectLocked?: boolean }).projectLocked !== undefined);
    expect(passes.length).toBeGreaterThan(0);
    expect(passes).toEqual(passes.map(() => ({ projectLocked: true })));
  });

  it('builds the core test data from core-spec/ in byte order of module names, a new empty ID registry and game settings with defaults', async () => {
    const { ws, env, log } = setup();
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).code).toBe(0);
    const data = log().find((c) => (c as { tool?: string }).tool === 'data') as { args: string[] };
    const inputs = (log().find((c) => (c as { dataInputs?: unknown }).dataInputs !== undefined) as { dataInputs: { coreSpec: { version: string; modules: { name: string }[] }; modules: string[]; gameSettings: Record<string, unknown>; registry: unknown } }).dataInputs;
    expect(inputs.coreSpec.modules.map((m) => m.name)).toEqual(['LogCore', 'UICore', 'routing']);
    expect(typeof inputs.coreSpec.version).toBe('string');
    expect(inputs.modules).toEqual(['LogCore', 'UICore', 'routing']);
    expect(inputs.gameSettings).toMatchObject({ engine: 'godot', targetFps: expect.any(Number) as number });
    expect(inputs.registry).toEqual({});
    // the registry file lives in the run's work folder, which the run removes
    expect(existsSync(data.args[data.args.indexOf('--id-registry') + 1] as string)).toBe(false);
  });

  it('writes the core project.godot, module list file, core settings file and core settings type file as generated files at the start of the run', async () => {
    const { ws, env } = setup();
    sh(ws.coreImpl, 'git', ['rm', '-q', '--ignore-unmatch', 'client/godot/project.godot', 'client/godot/generated/core_modules.gd', 'client/godot/generated/core_settings.json', 'client/godot/generated/core_settings_types.json']);
    // module list entries: client modules with a lifecycle, in dependency order
    for (const [name, dependencies] of [['LogCore', []], ['UICore', ['LogCore']]] as const) {
      const path = join(ws.coreImpl, 'core-spec', `${name}.json`);
      writeFileSync(path, JSON.stringify({ ...(JSON.parse(readFileSync(path, 'utf8')) as object), lifecycle: true, dependencies }));
    }
    // core-read game settings: a given value, a schema default, a value per environment, and a core settings override
    const uiPath = join(ws.coreImpl, 'core-spec', 'UICore.json');
    const ui = JSON.parse(readFileSync(uiPath, 'utf8')) as { settings: object[] };
    ui.settings.push(
      { key: 'appId', type: 'string', source: 'game', owner: 'content' },
      { key: 'targetFps', type: 'integer', source: 'game', owner: 'content' },
      { key: 'environments.<ENV>.serverUrl', type: 'string', source: 'game', owner: 'content' },
      { key: 'UICore.keyboardGap', type: 'number', source: 'core', owner: 'content' },
    );
    writeFileSync(uiPath, JSON.stringify(ui));
    writeFiles(ws.coreImpl, {
      'test-data/settings.json': { engine: 'godot', appId: 'com.example.core', environments: { DEV: { serverUrl: 'https://dev' } }, core: { 'LogCore.maxLines': 7 } },
      'settings/core-settings.json': { $schema: './core-settings.schema.json', 'UICore.fadeMs': 100, 'UICore.keyboardGap': 16, 'LogCore.maxLines': 300 },
    });
    commitAll(ws.coreImpl, 'no project.godot');
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).code).toBe(0);
    const text = readFileSync(join(ws.coreImpl, 'client', 'godot', 'project.godot'), 'utf8');
    expect(text).toContain('config/name="ogw-core"');
    expect(text).toContain('gdscript/warnings/untyped_declaration=2');
    expect(text).toContain('[physics]\n\ncommon/enable_object_picking=false');
    expect(text).not.toContain('main_scene');
    // committed with the other generated files, so the run is recorded on a clean checkout
    // the module list of the core project: the client modules of core-spec/ in the module list order
    const list = readFileSync(join(ws.coreImpl, 'client', 'godot', 'generated', 'core_modules.gd'), 'utf8');
    expect(list).toContain('class_name CoreModules');
    expect(list).toContain('\t\t_entry("LogCore", LogCore.init, LogCore.release, LogCore.is_initialized),\n\t\t_entry("UICore", UICore.init, UICore.release, UICore.is_initialized),\n\t]');
    // the core settings of the core project: settings/core-settings.json without $schema
    const settings = JSON.parse(readFileSync(join(ws.coreImpl, 'client', 'godot', 'generated', 'core_settings.json'), 'utf8')) as Record<string, unknown>;
    const defaults = JSON.parse(readFileSync(join(ws.coreImpl, 'settings', 'core-settings.json'), 'utf8')) as Record<string, unknown>;
    expect(settings).not.toHaveProperty('$schema');
    expect(settings['UICore.fadeMs']).toBe(defaults['UICore.fadeMs']);
    expect(settings['LogCore.maxLines']).toBe(7);
    expect(settings.appId).toBe('com.example.core');
    expect(settings.targetFps).toBe(60);
    expect(settings['environments.DEV.serverUrl']).toBe('https://dev');
    // the core settings type file: the spec type of each settings row, not the type of the file value
    expect(settings['UICore.keyboardGap']).toBe(16);
    const types = JSON.parse(readFileSync(join(ws.coreImpl, 'client', 'godot', 'generated', 'core_settings_types.json'), 'utf8')) as Record<string, unknown>;
    expect(types).toMatchObject({ appId: 'string', targetFps: 'integer', 'environments.DEV.serverUrl': 'string', 'UICore.keyboardGap': 'number' });
    expect(types).not.toHaveProperty(['environments.STG.serverUrl']);
    expect(sh(ws.coreImpl, 'git', ['log', '-1', '--name-only', '--format=%s']).trim().split('\n').filter((l) => l !== '')).toEqual([
      'ogw: regenerate generated files',
      'client/godot/generated/core_modules.gd',
      'client/godot/generated/core_settings.json',
      'client/godot/generated/core_settings_types.json',
      'client/godot/project.godot',
    ]);
    expect((await readTestRecords(ws.coreImpl)).at(-1)?.commit).toBe(sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim());
  });

  it('commits a new generated script with the .uid the import gives it, and records the run on that commit', async () => {
    const { ws, env } = setup();
    expect((await ogw(ws, ['core', 'test', 'godot'], { env: { ...env, FAKE_UIDS: '1', FAKE_GENERATED_SCRIPT: '1' } })).code).toBe(0);
    const committed = sh(ws.coreImpl, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n');
    expect(committed).toEqual(expect.arrayContaining(['client/godot/generated/data/new_table.gd', 'client/godot/generated/data/new_table.gd.uid']));
    expect(sh(ws.coreImpl, 'git', ['status', '--porcelain']).trim()).toBe('');
    expect((await readTestRecords(ws.coreImpl)).at(-1)?.commit).toBe(sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim());
  });

  it('imports and commits the .uid of a new generated script also when the preflight fails after the data build', async () => {
    const { ws, env } = setup();
    // a fixture ID name the data build does not issue: the fixture check after the build fails
    writeFiles(ws.coreImpl, { 'fixtures/unknown-name.json': { cases: [{ name: 'a', input: '[not_issued]', expected: 1 }] } });
    commitAll(ws.coreImpl, 'unknown fixture name');
    const run = await ogw(ws, ['core', 'test', 'godot'], { env: { ...env, FAKE_UIDS: '1', FAKE_GENERATED_SCRIPT: '1' } });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('not_issued');
    const committed = sh(ws.coreImpl, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n');
    expect(committed).toEqual(expect.arrayContaining(['client/godot/generated/data/new_table.gd', 'client/godot/generated/data/new_table.gd.uid']));
  });

  it('matches the core test data before the build and commits what the match changed as generated files', async () => {
    const { ws, env } = setup();
    expect((await ogw(ws, ['core', 'test', 'godot'], { env: { ...env, FAKE_MATCH: '1' } })).code).toBe(0);
    expect(sh(ws.coreImpl, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n')).toContain('test-data/data/translations/en.csv');
    expect(sh(ws.coreImpl, 'git', ['status', '--porcelain']).trim()).toBe('');
    expect((await readTestRecords(ws.coreImpl)).at(-1)?.commit).toBe(sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim());
  });

  it('leaves out of the generated commit a core test data file that had a change before the run', async () => {
    const { ws, env } = setup();
    writeFiles(ws.coreImpl, { 'test-data/data/tables/hand.csv': 'id\n[a]\n' });
    commitAll(ws.coreImpl, 'hand table');
    writeFiles(ws.coreImpl, { 'test-data/data/tables/hand.csv': 'id\n[a]\n[b]\n' });
    await ogw(ws, ['core', 'test', 'godot'], { env: { ...env, FAKE_MATCH: '1' } });
    const committed = sh(ws.coreImpl, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n');
    expect(committed).toContain('test-data/data/translations/en.csv');
    expect(committed).not.toContain('test-data/data/tables/hand.csv');
    expect(sh(ws.coreImpl, 'git', ['status', '--porcelain']).trim()).toBe('M test-data/data/tables/hand.csv');
  });

  it('runs only the given modules', async () => {
    const { ws, env } = setup();
    const run = await ogw(ws, ['core', 'test', 'godot', 'UICore'], { env });
    expect(run.stdout).toBe('UICore pass\n');
    expect((await ogw(ws, ['core', 'test', 'godot', 'routing'], { env })).stderr).toContain('not a module of godot: routing');
    // A core agent's worktree has only some modules: a run with modules does not need the others.
    sh(ws.coreImpl, 'rm', ['-r', 'client/godot/core/log_core']);
    expect(await ogw(ws, ['core', 'test', 'godot', 'UICore'], { env })).toMatchObject({ code: 0, stdout: 'UICore pass\n' });
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stderr).toContain('core-spec/ check failed; no test ran:\nLogCore has no implementation');
  });

  it('runs the native runs of modules at once', async () => {
    const { ws, env, log } = setup();
    writeFiles(ws.coreImpl, {
      'client/godot/core/ui_core/ui_core.gd': 'class_name UICore\n',
      'core-spec/UICore.json': specModule('UICore', 'client', { settings: [{ key: 'UICore.fadeMs', type: 'integer', source: 'core', owner: 'content' }] }),
    });
    const run = await ogw(ws, ['core', 'test', 'godot'], { env: { ...env, FAKE_DELAY: '300' } });
    expect(run.code).toBe(0);
    expect(parallelismOf({ kind: 'engine', engine: 'godot', web: false })).toBe(Math.max(1, Math.floor(availableParallelism() / 2)));
    // two passes of different modules ran in time spans that overlap
    const spans = log().filter((c): c is { span: [number, number]; folder: string } => (c as { span?: unknown }).span !== undefined);
    const overlap = spans.some((a) => spans.some((b) => a.folder !== b.folder && a.span[0] < b.span[1] && b.span[0] < a.span[1]));
    if (availableParallelism() >= 4) expect(overlap).toBe(true);
  });

  it('runs one render pass at a time on the host while headless passes run at once', async () => {
    const { ws, env, log } = setup();
    writeFiles(ws.coreImpl, {
      'client/godot/core/ui_core/ui_core.gd': 'class_name UICore\n',
      'client/godot/core/ui_core/tests/test_render_ui.gd': 'extends UnitTestCase\n',
      'client/godot/core/log_core/tests/test_render_log.gd': 'extends UnitTestCase\n',
      'core-spec/UICore.json': specModule('UICore', 'client', { settings: [{ key: 'UICore.fadeMs', type: 'integer', source: 'core', owner: 'content' }] }),
    });
    const run = await ogw(ws, ['core', 'test', 'godot'], { env: { ...env, FAKE_DELAY: '300' } });
    expect(run.code).toBe(0);
    const spans = log().filter((c): c is { span: [number, number]; folder: string; render: boolean } => (c as { span?: unknown }).span !== undefined);
    const renders = spans.filter((s) => s.render);
    // both modules have a render pass, and no two of them ran at the same time
    expect(new Set(renders.map((s) => s.folder)).size).toBe(2);
    const overlaps = (list: typeof spans): boolean => list.some((a) => list.some((b) => a !== b && a.span[0] < b.span[1] && b.span[0] < a.span[1]));
    expect(overlaps(renders)).toBe(false);
    if (availableParallelism() >= 4) expect(overlaps(spans.filter((s) => !s.render))).toBe(true);
  });

  it('gives each native pass its own user:// folder, so runs in other worktrees never share it', async () => {
    const { ws, env, log } = setup();
    const shared = join(ws.root, 'shared-data');
    const variable = godotDataVariable();
    const run = await ogw(ws, ['core', 'test', 'godot'], { env: { ...env, [variable]: shared, FAKE_DATA_VAR: variable } });
    expect(run.code).toBe(0);
    const passes = log().filter((c): c is { dataDir: string | null; dataDirExists: boolean } => (c as { dataDir?: unknown }).dataDir !== undefined);
    expect(passes).toHaveLength(3);
    const dirs = passes.map((p) => p.dataDir);
    expect(new Set(dirs).size).toBe(3);
    expect(dirs).not.toContain(shared);
    expect(dirs).not.toContain(null);
    expect(passes.every((p) => p.dataDirExists)).toBe(true);
    expect(dirs.filter((d) => d !== null && existsSync(d))).toEqual([]);
    expect(godotDataVariable('darwin')).toBe('HOME');
    expect(godotDataVariable('linux')).toBe('XDG_DATA_HOME');
    expect(godotDataVariable('win32')).toBe('APPDATA');
  });

  it('gives a native run more than UnitTestCore.runTimeLimitMs, which the engine timer counts from after boot', async () => {
    const { ws, env } = setup();
    writeFiles(ws.coreImpl, { 'settings/core-settings.json': { 'UICore.fadeMs': 100, 'LogCore.maxLines': 300, 'UnitTestCore.runTimeLimitMs': 100 } });
    const run = await ogw(ws, ['core', 'test', 'godot', 'LogCore'], { env: { ...env, FAKE_DELAY: '500' } });
    expect(run).toMatchObject({ code: 0, stdout: 'LogCore pass\n' });
  });

  it('runs the browser run from a web export', async () => {
    const { ws, env, log } = setup();
    // GUT goes into the web export; a host plugin and the extension list the import wrote do not
    mkdirSync(join(ws.coreImpl, 'client/godot/addons/gut'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client/godot/addons/gut/plugin.cfg'), '[plugin]\n');
    mkdirSync(join(ws.coreImpl, 'client/godot/addons/webrtc_native'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client/godot/addons/webrtc_native/webrtc_native.gdextension'), '[configuration]\n');
    mkdirSync(join(ws.coreImpl, 'client/godot/.godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client/godot/.godot/extension_list.cfg'), 'res://addons/webrtc_native/webrtc_native.gdextension\n');
    const run = await ogw(ws, ['core', 'test', 'godot', '--web', '--json'], { env });
    expect(run.stderr).not.toContain('Error');
    expect(JSON.parse(run.stdout)).toMatchObject({ target: 'godot --web', modules: { LogCore: 'pass', UICore: 'pass' }, tests: 2, passed: 2 });
    // the export carries the fixtures and the generated files the core project reads (core settings, data build), and its
    // main scene starts GUT: the web template takes no \`-s\`
    expect(log()).toContainEqual({ fixtures: ['text-format.json'], preset: true, filter: 'core_fixtures/*.json, generated/*, build/data/*, addons/gut/*.txt', addons: ['gut'], extensionList: false, mainScene: 'res://ogw_web_runner.tscn', runner: true });
    expect(existsSync(join(ws.coreImpl, 'client/godot/core_fixtures'))).toBe(false);
    expect(existsSync(join(ws.coreImpl, 'client/godot/ogw_web_runner.tscn'))).toBe(false);
    expect(readFileSync(join(ws.coreImpl, 'client/godot/project.godot'), 'utf8')).not.toContain('main_scene');
    expect((await readTestRecords(ws.coreImpl))[0]?.target).toBe('godot --web');
    // what the post-run hook's release prints after the result is engine output too; the passing results kept by the
    // run above would be used instead of a run
    rmSync(join(ws.harness, '.git', 'ogw-cache', 'core-test-results'), { recursive: true, force: true });
    const late = await ogw(ws, ['core', 'test', 'godot', '--web'], { env: { ...env, FAKE_RELEASE_ERROR: '1' } });
    expect(late.code).toBe(1);
    expect(late.stdout).toContain('ERROR: release');
    vi.mocked(toolProgram).mockResolvedValue(null);
    expect((await ogw(ws, ['core', 'test', 'godot', '--web'], { env })).stderr).toContain('tools.chromium is not on this host');
  });
});

describe('ogw core test passing results of the same key', () => {
  /** GUT runs of the fake Godot so far. */
  function gutRuns(log: () => unknown[]): number {
    return log().filter((c) => Array.isArray(c) && !c.includes('--import')).length;
  }

  it('keeps each passing module result with its key and uses it in a run of the same key, counted as passed and shown as reused', async () => {
    const { ws, env, log } = setup();
    expect((await ogw(ws, ['core', 'test', 'godot'], { env: { ...env, FAKE_FAIL: 'log_core' } })).code).toBe(1);
    const first = gutRuns(log);
    // the failed module runs again; the passing one is used with its counts and leaves a record of passing modules
    const again = await ogw(ws, ['core', 'test', 'godot', '--json'], { env });
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ modules: { LogCore: 'pass', UICore: 'pass' }, reused: ['UICore'], counts: { UICore: { tests: 2, passed: 2, ran: true } }, tests: 3, passed: 3 });
    expect(gutRuns(log)).toBe(first + 1);
    expect((await readTestRecords(ws.coreImpl)).at(-1)?.modules).toEqual({ LogCore: 'pass', UICore: 'pass' });
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stdout).toBe('LogCore pass (reused)\nUICore pass (reused)\n');
    expect(gutRuns(log)).toBe(first + 1);
    // a change in the folder of a module runs it and the modules that depend on it
    writeFiles(ws.coreImpl, { 'client/godot/core/log_core/log_core.gd': 'class_name LogCore\n# changed\n' });
    commitAll(ws.coreImpl, 'LogCore changed');
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stdout).toBe('LogCore pass\nUICore pass\n');
    writeFiles(ws.coreImpl, { 'client/godot/core/ui_core/ui_core.gd': 'class_name UICore\nLogCore.x()\n# changed\n' });
    commitAll(ws.coreImpl, 'UICore changed');
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stdout).toBe('LogCore pass (reused)\nUICore pass\n');
    // the files of core/ in no module folder are in the key of every module
    for (const path of ['client/godot/core/core_settings.gd', 'client/godot/core/web/ogw-shell.html']) {
      writeFiles(ws.coreImpl, { [path]: `# ${path}\n` });
      commitAll(ws.coreImpl, path);
      expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stdout, path).toBe('LogCore pass\nUICore pass\n');
    }
    // the engine files outside core/, the browser run and the harness tools/ are in the key
    writeFiles(ws.coreImpl, { 'client/godot/plugins/readme.txt': 'x\n' });
    commitAll(ws.coreImpl, 'engine file changed');
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stdout).toBe('LogCore pass\nUICore pass\n');
    expect(JSON.parse((await ogw(ws, ['core', 'test', 'godot', '--web', '--json'], { env })).stdout)).toMatchObject({ reused: [] });
    appendFileSync(join(ws.harness, 'tools', 'ogw.md'), 'x\n');
    // a harness tools/ with changes not committed is not the tree of the code that runs: no result is used
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stdout).toBe('LogCore pass\nUICore pass\n');
    commitAll(ws.harness, 'tools changed');
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stdout).toBe('LogCore pass\nUICore pass\n');
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stdout).toBe('LogCore pass (reused)\nUICore pass (reused)\n');
  });

  it('keys the results by the harness settings tools, the pinned programs and images a run uses', async () => {
    const { ws, env } = setup();
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stdout).toBe('LogCore pass\nUICore pass\n');
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stdout).toBe('LogCore pass (reused)\nUICore pass (reused)\n');
    const file = join(ws.harness, 'settings.json');
    const settings = JSON.parse(readFileSync(file, 'utf8')) as { tools: { postgresql: { tag: string } } };
    settings.tools.postgresql.tag = `${settings.tools.postgresql.tag}.1`;
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stdout).toBe('LogCore pass\nUICore pass\n');
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stdout).toBe('LogCore pass (reused)\nUICore pass (reused)\n');
  });

  it('neither keeps nor uses a result in a checkout with changes or in a --file run', async () => {
    const { ws, env } = setup();
    writeFileSync(join(ws.coreImpl, 'untracked.txt'), '');
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stdout).toBe('LogCore pass\nUICore pass\n');
    rmSync(join(ws.coreImpl, 'untracked.txt'));
    expect((await ogw(ws, ['core', 'test', 'godot', 'UICore', '--file', 'client/godot/core/ui_core/tests/test_ui.gd'], { env })).stdout).toBe('UICore pass\n');
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stdout).toBe('LogCore pass\nUICore pass\n');
    expect((await ogw(ws, ['core', 'test', 'godot', 'UICore', '--file', 'client/godot/core/ui_core/tests/test_ui.gd'], { env })).stdout).toBe('UICore pass\n');
    writeFileSync(join(ws.coreImpl, 'untracked.txt'), '');
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stdout).toBe('LogCore pass\nUICore pass\n');
  });

  it('keys a server module by the folders of its dependencies and of testing, the server package files outside server/core/ and the server/core/ entries in no module folder', async () => {
    const { ws, env } = setup();
    sh(ws.coreImpl, 'git', ['rm', '--quiet', 'licenses.json']);
    writeFiles(ws.coreImpl, {
      'core-spec/routing.json': specModule('routing', 'server', { devDependencies: ['logging'] }),
      'core-spec/logging.json': specModule('logging', 'server'),
      'core-spec/testing.json': specModule('testing', 'server', { dependencies: ['clock'] }),
      'core-spec/clock.json': specModule('clock', 'server'),
      'core-spec/storage.json': specModule('storage', 'server'),
      'server/package.json': { name: 'server' },
    });
    commitAll(ws.coreImpl, 'server modules');
    vi.mocked(serverModuleTest).mockResolvedValue({ tests: 4, passed: 4, failures: [] });
    const routing = async (): Promise<string> => (await ogw(ws, ['core', 'test', 'server', 'routing'], { env })).stdout;
    expect(await routing()).toBe('routing pass\n');
    expect(await routing()).toBe('routing pass (reused)\n');
    for (const [path, runs] of [['server/core/storage/a.ts', false], ['client/godot/core/log_core/a.gd', false], ['server/core/logging/a.ts', true], ['server/core/clock/a.ts', true], ['server/package.json', true], ['server/core/start.ts', true], ['test-data/notes.txt', true], ['fixtures/notes.txt', true]] as const) {
      writeFiles(ws.coreImpl, { [path]: `// ${path}\n` });
      commitAll(ws.coreImpl, path);
      expect(await routing(), path).toBe(runs ? 'routing pass\n' : 'routing pass (reused)\n');
    }
  });
});

describe('ogw core test preflight', () => {
  it('stops before the tests when a step fails', async () => {
    const { ws, env, log } = setup();
    vi.mocked(writeCoreSpec).mockResolvedValue({ modules: new Map(), settingTypes: new Map(), errors: ['skills/a.md:1: bad'], dir: '', written: [], deleted: [], settingTypesWritten: false });
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stderr).toContain('ogw core spec failed; no test ran:\nskills/a.md:1: bad');
    vi.mocked(writeCoreSpec).mockResolvedValue({ modules: new Map(), settingTypes: new Map(), errors: [], dir: '', written: [], deleted: [], settingTypesWritten: false });
    vi.mocked(baseProtoErrors).mockResolvedValue(['x.md:3: CoreError Y differs']);
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stderr).toContain('base proto check failed; no test ran:\nx.md:3: CoreError Y differs');
    vi.mocked(baseProtoErrors).mockResolvedValue([]);
    const run = await ogw(ws, ['core', 'test', 'godot', '--json'], { env: { ...env, FAKE_DATA_FAIL: '1' } });
    expect(JSON.parse(run.stdout)).toMatchObject({ error: expect.stringContaining('data-tool failed (1) on the core test data:\ndata/tables/x.csv:2 ERROR structure') as string });
    writeFiles(ws.coreImpl, { 'fixtures/more.json': { cases: [{ name: 'a', input: '[ghost]', expected: 0 }] } });
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stderr).toContain('core test fixture ID name check failed; no test ran:\nfixture more: [ghost] is not in the core test data');
    sh(ws.coreImpl, 'rm', ['fixtures/more.json', 'licenses.json']);
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stderr).toContain('licenses.json check failed; no test ran:\nlicenses.json is missing or invalid');
    sh(ws.coreImpl, 'git', ['checkout', 'licenses.json']);
    writeFiles(ws.coreImpl, { 'client/godot/core/ui_core/bad.gd': 'extends RefCounted\nfunc f() -> void:\n\tassert(true)\n' });
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stderr).toContain('core code static check failed; no test ran:\nclient/godot/core/ui_core/bad.gd:3: GDScript: `assert`');
    sh(ws.coreImpl, 'rm', ['client/godot/core/ui_core/bad.gd']);
    vi.mocked(serverCoreStaticCheck).mockResolvedValue(['server/core/x.ts:4: system clock: `Date.now()` outside the clock adapter']);
    expect((await ogw(ws, ['core', 'test', 'server'], { env })).stderr).toContain('core code static check failed; no test ran:\nserver/core/x.ts:4: system clock: `Date.now()` outside the clock adapter');
    expect(serverCoreStaticCheck).toHaveBeenCalledWith(ws.coreImpl);
    vi.mocked(serverCoreStaticCheck).mockResolvedValue([]);
    writeFiles(ws.coreImpl, { 'server/core/chat/bad.ts': "import { x } from '../storage/tx.ts';\nexport const y = x;\n" });
    expect((await ogw(ws, ['core', 'test', 'server'], { env })).stderr).toContain('core code static check failed; no test ran:\nserver/core/chat/bad.ts: internal import: `storage/tx.ts` is an internal file of `storage`');
    sh(ws.coreImpl, 'rm', ['server/core/chat/bad.ts']);
    sh(ws.coreImpl, 'rm', ['-r', 'client/godot/core/log_core']);
    expect((await ogw(ws, ['core', 'test', 'godot'], { env })).stderr).toContain('core-spec/ check failed; no test ran:\nLogCore has no implementation');
    expect(log().filter((c) => Array.isArray(c) && !c.includes('--import'))).toEqual([]);
  });

  it('records a run log summary of one test that did not pass when the run stops before the tests', async () => {
    const { ws, env } = setup();
    const jobs = join(ws.root, 'jobs');
    mkdirSync(jobs);
    const job = (id: string): { summary: unknown } => JSON.parse(readFileSync(join(jobs, `${id}.json`), 'utf8')) as { summary: unknown };
    const runJob = (id: string, args: string[]): ReturnType<typeof ogw> => {
      writeFileSync(join(jobs, `${id}.json`), JSON.stringify({ id, status: 'running', meta: {} }));
      return ogw(ws, args, { env: { ...env, OGW_JOB_ID: id, OGW_JOBS_DIR: jobs } });
    };
    writeFiles(ws.coreImpl, { 'fixtures/more.json': { cases: [{ name: 'a', input: '[ghost]', expected: 0 }] } });
    const preflight = await runJob('p1', ['core', 'test', 'godot', '--json']);
    expect(preflight.code).toBe(1);
    expect(JSON.parse(preflight.stdout)).toMatchObject({ target: 'godot', error: expect.stringContaining('[ghost] is not in the core test data') as string, tests: 1, passed: 0 });
    expect(job('p1').summary).toEqual({ tests: 1, passed: 0 });
    sh(ws.coreImpl, 'rm', ['fixtures/more.json']);
    vi.mocked(toolProgram).mockResolvedValue(null);
    const runner = await runJob('p2', ['core', 'test', 'godot', '--web']);
    expect(runner.code).toBe(1);
    expect(runner.stderr).toContain('tools.chromium is not on this host');
    expect(job('p2').summary).toEqual({ tests: 1, passed: 0 });
  });

  it('rejects unknown targets and --web outside an engine', async () => {
    const { ws, env } = setup();
    expect((await ogw(ws, ['core', 'test'], { env })).stderr).toContain('usage: ogw core test');
    expect((await ogw(ws, ['core', 'test', 'unity'], { env })).stderr).toContain('unknown target unity');
    expect((await ogw(ws, ['core', 'test', 'server', '--web'], { env })).stderr).toContain('--web is only for an engine, not server');
  });
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

describe('core test helpers', () => {
  it('names record targets and sums the run log summary', () => {
    expect(recordTarget({ kind: 'engine', engine: 'godot', web: true })).toBe('godot --web');
    expect(recordTarget({ kind: 'engine', engine: 'godot', web: false })).toBe('godot');
    expect(recordTarget({ kind: 'tools' })).toBe('tools');
    const outcomes = new Map([
      ['a', { tests: 3, passed: 3, failures: [] }],
      ['b', { tests: 2, passed: 1, failures: ['x'] }],
      ['c', { tests: 0, passed: 0, failures: ['y'] }],
    ]);
    const results = new Map<string, ModuleResult>([['a', 'pass'], ['b', 'fail'], ['c', 'fail']]);
    expect(testSummary(results, outcomes)).toEqual({ tests: 6, passed: 4 });
    // A skipped module never ran; it counts as one test that did not pass.
    expect(testSummary(new Map([...results, ['d', 'skipped']]), outcomes)).toEqual({ tests: 7, passed: 4 });
    expect(testSummary(new Map([['d', 'skipped'], ['e', 'skipped']]), new Map())).toEqual({ tests: 2, passed: 0 });
    expect(testSummary(new Map(), new Map())).toEqual({ tests: 1, passed: 0 });
  });

});
