import { availableParallelism } from 'node:os';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { baseProtoErrors } from '../../../src/commands/core/lib/base-proto-check.ts';
import { godotDataVariable, renderDeps } from '../../../src/commands/core/lib/godot.ts';
import { serverCoreStaticCheck } from '../../../src/commands/core/lib/core-server-static-check.ts';
import { readTestRecords, SCREEN_LOCKED_SKIP } from '../../../src/commands/core/lib/test-records.ts';
import { serverModuleTest } from '../../../src/commands/core/lib/server-tests.ts';
import { runToolTest } from '../../../src/commands/core/lib/tool-test.ts';
import { writeCoreSpec } from '../../../src/commands/core/spec-api.ts';
import { parallelismOf, recordTarget, testSummary } from '../../../src/commands/core/test.ts';
import type { ModuleResult } from '../../../src/commands/core/lib/test-records.ts';
import { toolProgram } from '../../../src/commands/env/api.ts';
import { ogw, commitAll, sh } from '../../helpers/workspace.ts';
import { writeFiles } from './helpers.ts';
import { specModule } from './impl-fixture.ts';
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
