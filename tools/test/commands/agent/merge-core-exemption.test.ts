import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addTestRecord } from '../../../src/commands/core/lib/test-records.ts';
import { ogw, commitAll, makeWorkspace, sh } from '../../helpers/workspace.ts';
import { fakeAgentCli, runAgent } from './helpers.ts';
import { coreJob, coreSpec, PASSED, scriptJob, writeScript } from './merge-core-fixture.ts';

const data = vi.hoisted(() => ({ exitCode: 0, calls: [] as string[], write: null as ((root: string) => void) | null }));
vi.mock('../../../src/commands/data/api.ts', () => ({
  runData: (_ctx: unknown, game: { root: string }) => {
    data.calls.push(game.root);
    data.write?.(game.root);
    return Promise.resolve({ exitCode: data.exitCode, lines: data.exitCode === 0 ? [] : [{ level: 'ERROR', code: 'x', where: 'w', message: 'm', text: 'ERROR x bad row' }], stderr: '' });
  },
}));

/**
 * The `ogw code check core` type check of `ogw agent merge`: `fake` gives the failure lines of a commit (`agent/<id>`
 * for a branch, a commit id for main); with `real` the check runs. `calls` lists the commits checked.
 */
type FakeTypeCheck = (commit: string) => { failures: string[]; complete: boolean; stops?: { part: 'TypeScript' | 'engine'; reason: string }[] };
const typeCheck = vi.hoisted(() => {
  const pass: FakeTypeCheck = () => ({ failures: [], complete: true });
  return { real: false, fake: pass, calls: [] as string[] };
});
vi.mock('../../../src/commands/code/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/commands/code/api.ts')>();
  return {
    ...actual,
    runCoreTypeCheck: (ctx: Parameters<typeof actual.runCoreTypeCheck>[0], commit: string, root: string) => {
      typeCheck.calls.push(commit);
      return typeCheck.real ? actual.runCoreTypeCheck(ctx, commit, root) : Promise.resolve({ stops: [], ...typeCheck.fake(commit) });
    },
  };
});

beforeEach(() => {
  typeCheck.real = false;
  typeCheck.fake = () => ({ failures: [], complete: true });
  typeCheck.calls = [];
  data.exitCode = 0;
  data.calls = [];
  data.write = null;
});

describe('ogw agent merge: core worktrees', () => {
  it('merges a job of no module without a core test when it changes only files of an engine whose client core never passed', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'core-spec', 'LogCore.json'), JSON.stringify({ name: 'LogCore', side: 'client', dependencies: [] }));
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    const head = commitAll(ws.coreImpl, 'godot');
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { LogCore: 'pass' }, recordedAt: 1 });
    const noModuleJob = async (files: string[]): Promise<string> => {
      writeFileSync(join(ws.root, 'in-engine.md'), 'command: create client core\n');
      const writes = files.map((file) => `fs.mkdirSync(${JSON.stringify(file.slice(0, file.lastIndexOf('/')))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(file)}, '{"changed":true}');`).join(' ');
      const fake = fakeAgentCli(ws, `${writes} execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'engine', '--no-verify']); fs.writeFileSync(output, 'r'); fs.writeFileSync(output.replace(/\\.md$/, '-runs.json'), JSON.stringify({ runs: [] }));`);
      const { id, waited } = await runAgent(ws, ['core', '--input', join(ws.root, 'in-engine.md')], fake.env);
      expect(waited.code).toBe(0);
      return id;
    };
    // a new engine: its engine.json comes before any of its client modules
    const engine = await noModuleJob(['client/threejs/engine.json']);
    expect((await ogw(ws, ['agent', 'merge', engine])).stdout.split('\n')).toContain(`merged ${engine}`);
    const passedEngine = await noModuleJob(['client/godot/engine.json']);
    const withServer = await noModuleJob(['client/threejs/a.json', 'server/core/x.ts']);
    // a folder under client/ without an engine.json is not an engine
    const notEngine = await noModuleJob(['client/tmp/notes.json']);
    const run = await ogw(ws, ['agent', 'merge', passedEngine, withServer, notEngine]);
    expect(run.stdout).toContain(`not merged ${passedEngine}: no core test:`);
    expect(run.stdout).toContain(`not merged ${withServer}: no core test:`);
    expect(run.stdout).toContain(`not merged ${notEngine}: no core test:`);
  });

  it('decides the exemptions per engine: a second engine whose client core never passed keeps them for its files', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'core-spec', 'LogCore.json'), JSON.stringify({ name: 'LogCore', side: 'client', dependencies: [] }));
    for (const engine of ['godot', 'threejs']) {
      mkdirSync(join(ws.coreImpl, 'client', engine), { recursive: true });
      writeFileSync(join(ws.coreImpl, 'client', engine, 'engine.json'), '{}');
    }
    const head = commitAll(ws.coreImpl, 'two engines');
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { LogCore: 'pass' }, recordedAt: 1 });
    const threejs = await coreJob(ws, 'LogCore', [], 'client/threejs/core/log_core.js');
    const godot = await coreJob(ws, 'LogCore', [], 'client/godot/core/log_core/a.gd');
    const toolRun = { command: 'ogw core test tools', startedAt: 1, exitCode: 1, summary: { tests: 4, passed: 4 } };
    const noTests = { ...toolRun, summary: { tests: 0, passed: 0 } };
    const tool = await coreJob(ws, 'contract-tool', [toolRun], 'tools/contract-tool/src/a.ts');
    const empty = await coreJob(ws, 'data-tool', [noTests], 'tools/data-tool/src/a.ts');
    const run = await ogw(ws, ['agent', 'merge', threejs, godot, tool, empty]);
    expect(run.stdout.split('\n')).toContain(`merged ${threejs}`);
    expect(run.stdout).toContain(`not merged ${godot}: no core test:`);
    // the threejs round trip is left out, so a tool job merges on its vitest tests; a run of no test is not a pass
    expect(run.stdout.split('\n')).toContain(`merged ${tool}`);
    expect(run.stdout).toContain(`not merged ${empty}: no core test:`);
  });

  it('keeps the client core passed when a client module is added to core-spec/ later', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'core-spec', 'LogCore.json'), JSON.stringify({ name: 'LogCore', side: 'client', dependencies: [] }));
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    const passedAt = commitAll(ws.coreImpl, 'spec');
    await addTestRecord(ws.coreImpl, { commit: passedAt, target: 'godot', modules: { LogCore: 'pass' }, recordedAt: 1 });
    writeFileSync(join(ws.coreImpl, 'core-spec', 'NewCore.json'), JSON.stringify({ name: 'NewCore', side: 'client', dependencies: [] }));
    commitAll(ws.coreImpl, 'a new client module');
    const job = await coreJob(ws, 'NewCore', [], 'client/godot/core/new_core/new_core.gd');
    expect((await ogw(ws, ['agent', 'merge', job])).stdout).toContain(`not merged ${job}: no core test:`);
  });

  it('reads the side of a module from main when the branch has no core-spec file of it', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'core-spec', 'LogCore.json'), JSON.stringify({ name: 'LogCore', side: 'client', dependencies: [] }));
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    commitAll(ws.coreImpl, 'spec');
    const job = await coreJob(ws, 'InputCore', [], 'client/godot/core/input_core/input_core.gd');
    // ogw core spec commits the spec of InputCore on main after the worktree was made
    writeFileSync(join(ws.coreImpl, 'core-spec', 'InputCore.json'), JSON.stringify({ name: 'InputCore', side: 'client', dependencies: [] }));
    commitAll(ws.coreImpl, 'spec of InputCore');
    expect(sh(ws.coreImpl, 'git', ['ls-tree', '--name-only', `agent/${job}`, 'core-spec/'])).not.toContain('InputCore.json');
    expect((await ogw(ws, ['agent', 'merge', job])).stdout.split('\n')).toContain(`merged ${job}`);
  });

  it('does not merge a core job whose type check has a failure line that the one of main HEAD lacks', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], storage: [], auth: [], chat: [] });
    mkdirSync(join(ws.coreImpl, 'server', 'core'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'package.json'), '{"type": "module"}\n');
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'old.ts'), "export const old: number = 'text';\n");
    commitAll(ws.coreImpl, 'a type check failure on main');
    typeCheck.real = true;
    const added = await scriptJob(ws, 'routing', writeScript('server/core/routing/index.ts', "export const n: number = 'text';\n"));
    const kept = await scriptJob(ws, 'storage', writeScript('server/core/storage/index.ts', 'export const s = 1;\n'));
    const records = await scriptJob(ws, 'chat', writeScript('records/chat.md', 'r'));
    const run = await ogw(ws, ['agent', 'merge', added, kept, records]);
    expect(run.stdout).toContain(`not merged ${added}: type check: server/core/routing/index.ts:1:14 TS2322 `);
    // main's own failure is not the branch's
    expect(run.stdout).not.toContain('server/core/old.ts');
    expect(run.stdout.split('\n')).toContain(`merged ${kept}`);
    expect(run.stdout.split('\n')).toContain(`merged ${records}`);
    expect(existsSync(join(ws.coreImpl, 'server', 'core', 'routing'))).toBe(false);
    // a job that changed only records/ is not type-checked
    expect(typeCheck.calls).not.toContain(`agent/${records}`);
  });

  it('type-checks the branch with the packages its worktree installed, not with the main checkout ones of another package-lock.json', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [] });
    writeFileSync(join(ws.coreImpl, '.gitignore'), 'node_modules/\n');
    mkdirSync(join(ws.coreImpl, 'server'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'package.json'), '{"type": "module"}\n');
    writeFileSync(join(ws.coreImpl, 'server', 'package-lock.json'), '{"lockfileVersion": 3, "packages": {}}\n');
    commitAll(ws.coreImpl, 'server package');
    // main's installed packages lack the branch's new dependency
    mkdirSync(join(ws.coreImpl, 'server', 'node_modules'), { recursive: true });
    typeCheck.real = true;
    const change = [
      writeScript('server/package.json', '{"type": "module", "dependencies": {"foo": "1.0.0"}}\n'),
      writeScript('server/package-lock.json', '{"lockfileVersion": 3, "packages": {"node_modules/foo": {"version": "1.0.0"}}}\n'),
      writeScript('server/core/routing/index.ts', "import { foo } from 'foo';\nexport const n: number = foo;\n"),
    ].join(' ');
    // what `ogw core test server` installs in the worktree from the branch's package-lock.json
    const install = [
      writeScript('server/node_modules/foo/package.json', '{"name": "foo", "version": "1.0.0", "type": "module", "exports": {".": {"types": "./index.d.ts"}}}\n'),
      writeScript('server/node_modules/foo/index.d.ts', 'export declare const foo: number;\n'),
    ].join(' ');
    const id = await scriptJob(ws, 'routing', change, install);
    const run = await ogw(ws, ['agent', 'merge', id]);
    expect(run).toMatchObject({ code: 0, stdout: `merged ${id}\n` });
  });

  it('keeps the TypeScript failure lines of a type check whose engine part stopped, and refuses a branch that adds one', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [] });
    // the engine part stops before any engine runs: engine.json names no Godot version
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'a.gd'), 'extends Node\n');
    mkdirSync(join(ws.coreImpl, 'server', 'core', 'routing'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'package.json'), '{"type": "module"}\n');
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), 'export const n: number = 1;\n');
    commitAll(ws.coreImpl, 'an engine without a version');
    typeCheck.real = true;
    const id = await scriptJob(ws, 'routing', writeScript('server/core/routing/index.ts', "export const n: number = 'text';\n"));
    const run = await ogw(ws, ['agent', 'merge', id]);
    expect(run.stdout).toContain(`not merged ${id}: type check: server/core/routing/index.ts:1:14 TS2322 `);
    expect(run.stdout).not.toContain('client/godot/engine.json has no godot version');
    // main's check stopped: it is not kept
    expect(existsSync(join(ws.harness, '.git', 'ogw-cache', 'core-type-check'))).toBe(false);
  });

  it('refuses a branch that changed a file of the engine part that stopped, and merges one that changed only files of the other part', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], LogCore: [] });
    // the engine part stops before any engine runs: engine.json names no Godot version
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'a.gd'), 'extends Node\n');
    mkdirSync(join(ws.coreImpl, 'server', 'core', 'routing'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'package.json'), '{"type": "module"}\n');
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), 'export const n: number = 1;\n');
    commitAll(ws.coreImpl, 'an engine without a version');
    // the engine's client core passed: a client module job is type-checked
    await addTestRecord(ws.coreImpl, { commit: sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim(), target: 'godot', modules: { LogCore: 'pass' }, recordedAt: 1 });
    typeCheck.real = true;
    const server = await scriptJob(ws, 'routing', writeScript('server/core/routing/index.ts', 'export const n: number = 2;\n'));
    const client = await scriptJob(ws, 'LogCore', writeScript('client/godot/core/log_core/log_core.gd', 'class_name LogCore\n'));
    const run = await ogw(ws, ['agent', 'merge', server, client]);
    expect(run.stdout.split('\n')).toContain(`merged ${server}`);
    expect(run.stdout).toContain(`not merged ${client}: type check: engine part stopped: client/godot/engine.json has no godot version`);
  });

  it('merges a branch that changed only a TypeScript file of another engine project while the Godot part stopped', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [] });
    // the engine part stops before any engine runs: engine.json names no Godot version
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'a.gd'), 'extends Node\n');
    mkdirSync(join(ws.coreImpl, 'client', 'threejs'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'threejs', 'engine.json'), '{}');
    writeFileSync(join(ws.coreImpl, 'client', 'threejs', 'package.json'), '{"type": "module"}\n');
    mkdirSync(join(ws.coreImpl, 'server', 'core', 'routing'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'package.json'), '{"type": "module"}\n');
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), 'export const n: number = 1;\n');
    commitAll(ws.coreImpl, 'an engine without a version and a TypeScript engine');
    typeCheck.real = true;
    // the TypeScript part checks the threejs file; the Godot part that stopped does not
    const id = await scriptJob(ws, 'routing', writeScript('client/threejs/core/a.ts', 'export const a: number = 1;\n'));
    const run = await ogw(ws, ['agent', 'merge', id]);
    expect(run).toMatchObject({ code: 0, stdout: `merged ${id}\n` });
  });

  it('merges a branch whose Godot part stopped and changed none of its files when main\'s complete result is kept', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [] });
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'a.gd'), 'extends Node\n');
    mkdirSync(join(ws.coreImpl, 'client', 'threejs'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'threejs', 'engine.json'), '{}');
    writeFileSync(join(ws.coreImpl, 'client', 'threejs', 'package.json'), '{"type": "module"}\n');
    commitAll(ws.coreImpl, 'an engine without a version and a TypeScript engine');
    typeCheck.real = true;
    // main's check ended while Godot worked: its kept result has no stop message
    const main = sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim();
    const folder = join(ws.harness, '.git', 'ogw-cache', 'core-type-check');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${main}-${sh(ws.harness, 'git', ['rev-parse', 'HEAD:tools']).trim()}.json`), '{"failures": []}');
    const id = await scriptJob(ws, 'routing', writeScript('client/threejs/core/a.ts', 'export const a: number = 1;\n'));
    const run = await ogw(ws, ['agent', 'merge', id]);
    expect(run).toMatchObject({ code: 0, stdout: `merged ${id}\n` });
  });

  it('merges a branch that changed only a benchmark game TypeScript file while the TypeScript part stopped', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { storage: [] });
    const stop = 'tsc could not start';
    typeCheck.fake = () => ({ failures: [stop], complete: false, stops: [{ part: 'TypeScript', reason: stop }] });
    // the TypeScript part does not read benchmark/, so its stop checked none of the branch's files
    const storage = await coreJob(ws, 'storage', [PASSED], 'benchmark/godot/server/main.ts');
    const run = await ogw(ws, ['agent', 'merge', storage]);
    expect(run.stdout.split('\n')).toContain(`merged ${storage}`);
  });

  it('refuses a branch that changed a TypeScript file when the TypeScript part stopped', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], storage: [] });
    const stop = 'tsc could not start';
    typeCheck.fake = () => ({ failures: [stop], complete: false, stops: [{ part: 'TypeScript', reason: stop }] });
    const routing = await coreJob(ws, 'routing', [PASSED], 'server/core/routing/index.ts');
    const storage = await coreJob(ws, 'storage', [PASSED], 'core-spec/storage.json');
    const run = await ogw(ws, ['agent', 'merge', routing, storage]);
    expect(run.stdout).toContain(`not merged ${routing}: type check: TypeScript part stopped: ${stop}`);
    // a branch that changed no file of the part that stopped is compared by its failure lines, which main has
    expect(run.stdout.split('\n')).toContain(`merged ${storage}`);
  });

  it('checks the branch again under the main checkout lock when main changed outside records/ since the check', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], storage: [] });
    const first = sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim();
    // the branch's failure line is main's at the commit checked first; a commit made while the branch is checked drops it
    const commitOnMain = (file: string): void => {
      mkdirSync(dirname(join(ws.coreImpl, file)), { recursive: true });
      writeFileSync(join(ws.coreImpl, file), `${file}\n`);
      sh(ws.coreImpl, 'git', ['add', '--all']);
      sh(ws.coreImpl, 'git', ['commit', '--quiet', '--no-verify', '-m', file]);
    };
    let movedTo: string | null = null;
    typeCheck.fake = (commit) => {
      if (commit.startsWith('agent/') && movedTo !== null) {
        commitOnMain(movedTo);
        movedTo = null;
      }
      return { failures: commit === first || commit.startsWith('agent/') ? ['server/x.ts:1:1 TS1 old'] : [], complete: true };
    };
    const routing = await coreJob(ws, 'routing');
    movedTo = 'server/other.ts';
    const run = await ogw(ws, ['agent', 'merge', routing]);
    expect(run.stdout).toContain(`not merged ${routing}: type check: server/x.ts:1:1 TS1 old`);
    expect(typeCheck.calls.filter((commit) => commit === `agent/${routing}`)).toHaveLength(2);
    // a change only under records/ makes no second check; main's commit here has the branch's line
    commitOnMain('server/second.ts');
    const main = sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim();
    typeCheck.fake = (commit) => {
      if (commit.startsWith('agent/') && movedTo !== null) {
        commitOnMain(movedTo);
        movedTo = null;
      }
      return { failures: commit === main || commit.startsWith('agent/') ? ['server/x.ts:1:1 TS1 old'] : [], complete: true };
    };
    typeCheck.calls = [];
    const storage = await coreJob(ws, 'storage');
    movedTo = 'records/note.md';
    const merged = await ogw(ws, ['agent', 'merge', storage]);
    expect(merged.stdout).toBe(`merged ${storage}\n`);
    expect(typeCheck.calls.filter((commit) => commit === `agent/${storage}`)).toHaveLength(1);
  });

  it('makes the type check of a main commit once and keeps it in the harness git common dir, unless it stopped with an error', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], storage: [], auth: [] });
    const main = sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim();
    typeCheck.fake = (commit) => (commit === main ? { failures: ['engine godot is not on this host'], complete: false } : { failures: ['server/x.ts:1:1 TS1 new'], complete: true });
    const first = await coreJob(ws, 'routing');
    const second = await coreJob(ws, 'storage');
    const run = await ogw(ws, ['agent', 'merge', first, second]);
    expect(run.stdout).toContain(`not merged ${first}: type check: server/x.ts:1:1 TS1 new`);
    expect(run.stdout).toContain(`not merged ${second}: type check: server/x.ts:1:1 TS1 new`);
    const cached = join(ws.harness, '.git', 'ogw-cache', 'core-type-check', `${main}-${sh(ws.harness, 'git', ['rev-parse', 'HEAD:tools']).trim()}.json`);
    // a check that stopped with an error is made again for each job and not kept
    expect(typeCheck.calls.filter((commit) => commit === main)).toHaveLength(2);
    expect(existsSync(cached)).toBe(false);
    typeCheck.fake = (commit) => ({ failures: commit === main ? ['server/x.ts:1:1 TS1 new'] : ['server/x.ts:1:1 TS1 new'], complete: true });
    typeCheck.calls = [];
    const third = await coreJob(ws, 'auth');
    const again = await ogw(ws, ['agent', 'merge', first, third]);
    // main has the branch's failure line: both merge, and main's check of that commit was made once
    expect(again.stdout.split('\n')).toContain(`merged ${first}`);
    expect(again.stdout.split('\n')).toContain(`merged ${third}`);
    expect(typeCheck.calls.filter((commit) => commit === main)).toHaveLength(1);
    expect(JSON.parse(readFileSync(cached, 'utf8'))).toEqual({ failures: ['server/x.ts:1:1 TS1 new'] });
  });

  it('does not type-check a job the core test exemption of an engine whose client core never passed covers', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
    for (const [name, side] of [['LogCore', 'client'], ['UtilCore', 'client'], ['routing', 'server']] as const) {
      writeFileSync(join(ws.coreImpl, 'core-spec', `${name}.json`), JSON.stringify({ name, side, dependencies: [] }));
    }
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    commitAll(ws.coreImpl, 'spec');
    typeCheck.fake = (commit) => ({ failures: commit.startsWith('agent/') ? ['client/godot/core/log_core/log_core.gd:1 Could not find type "UtilCore"'] : [], complete: true });
    const client = await coreJob(ws, 'LogCore', [PASSED], 'client/godot/core/log_core/log_core.gd');
    const server = await coreJob(ws, 'routing');
    const run = await ogw(ws, ['agent', 'merge', client, server]);
    expect(run.stdout.split('\n')).toContain(`merged ${client}`);
    expect(typeCheck.calls).not.toContain(`agent/${client}`);
    expect(run.stdout).toContain(`not merged ${server}: type check: client/godot/core/log_core/log_core.gd:1 Could not find type "UtilCore"`);
    // once the engine's client core passed, a client module job is type-checked
    const head = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { LogCore: 'pass', UtilCore: 'pass' }, recordedAt: 1 });
    const later = await coreJob(ws, 'UtilCore', [PASSED], 'client/godot/core/util_core/util_core.gd');
    expect((await ogw(ws, ['agent', 'merge', later])).stdout).toContain(`not merged ${later}: type check:`);
  });

  it('compares type check failure lines by file, code and message, not by line and column', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], storage: [] });
    const main = sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim();
    typeCheck.fake = (commit) => ({
      failures: commit === main ? ['server/a.ts:3:5 TS2322 x', 'client/godot/core/a.gd:7 Parse Error'] : ['server/a.ts:9:1 TS2322 x', 'client/godot/core/a.gd:12 Parse Error', ...(commit === `agent/${storage}` ? ['server/a.ts:9:1 TS2554 y'] : [])],
      complete: true,
    });
    const routing = await coreJob(ws, 'routing');
    const storage = await coreJob(ws, 'storage');
    const run = await ogw(ws, ['agent', 'merge', routing, storage]);
    expect(run.stdout.split('\n')).toContain(`merged ${routing}`);
    expect(run.stdout).toContain(`not merged ${storage}: type check: server/a.ts:9:1 TS2554 y\n`);
  });

  it('keys the type check of main by the commit and the harness tools/ tree, and keeps none while tools/ has changes not committed', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], storage: [], auth: [] });
    const main = sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim();
    // every job is refused, so main stays at one commit
    typeCheck.fake = (commit) => ({ failures: commit.startsWith('agent/') ? ['server/x.ts:1:1 TS1 new'] : [], complete: true });
    const cached = (): string[] => {
      const folder = join(ws.harness, '.git', 'ogw-cache', 'core-type-check');
      return existsSync(folder) ? readdirSync(folder) : [];
    };
    const mainChecks = (): number => typeCheck.calls.filter((commit) => commit === main).length;
    await ogw(ws, ['agent', 'merge', await coreJob(ws, 'routing')]);
    await ogw(ws, ['agent', 'merge', await coreJob(ws, 'routing')]);
    expect(mainChecks()).toBe(1);
    const tree = sh(ws.harness, 'git', ['rev-parse', 'HEAD:tools']).trim();
    expect(cached()).toEqual([`${main}-${tree}.json`]);
    // a changed harness tools/ tree makes main's check again
    appendFileSync(join(ws.harness, 'tools', 'ogw.md'), 'x\n');
    await ogw(ws, ['agent', 'merge', await coreJob(ws, 'storage')]);
    expect(mainChecks()).toBe(2);
    expect(cached()).toHaveLength(1);
    commitAll(ws.harness, 'tools changed');
    await ogw(ws, ['agent', 'merge', await coreJob(ws, 'auth')]);
    expect(mainChecks()).toBe(3);
    expect(cached()).toHaveLength(2);
  });
});
