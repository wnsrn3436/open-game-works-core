import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { baseProtoErrors } from '../../../src/commands/core/lib/base-proto-check.ts';
import { renderDeps } from '../../../src/commands/core/lib/godot.ts';
import { serverCoreStaticCheck } from '../../../src/commands/core/lib/core-server-static-check.ts';
import { readTestRecords } from '../../../src/commands/core/lib/test-records.ts';
import { serverModuleTest } from '../../../src/commands/core/lib/server-tests.ts';
import { runToolTest } from '../../../src/commands/core/lib/tool-test.ts';
import { writeCoreSpec } from '../../../src/commands/core/spec-api.ts';
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
