import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addTestRecord } from '../../../src/commands/core/lib/test-records.ts';
import { ogw, commitAll, makeWorkspace, sh } from '../../helpers/workspace.ts';
import { fakeAgentCli, runAgent } from './helpers.ts';
import { coreJob, coreSpec, PASSED } from './merge-core-fixture.ts';

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
  it('merges a core job only after a passing ogw core test, unless it changed only records/', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], storage: [], auth: [], chat: [], mail: [], shop: [] });
    const none = await coreJob(ws, 'routing', []);
    const failed = await coreJob(ws, 'storage', [PASSED, { ...PASSED, summary: { tests: 2, passed: 1 } }]);
    const vitest = await coreJob(ws, 'auth', [{ command: 'ogw code check core', startedAt: 1, exitCode: 0, summary: null }]);
    const records = await coreJob(ws, 'chat', [], 'records/chat.md');
    const exit1 = await coreJob(ws, 'mail', [{ ...PASSED, exitCode: 1 }]);
    const running = await coreJob(ws, 'shop', [{ ...PASSED, exitCode: null }]);
    const run = await ogw(ws, ['agent', 'merge', none, failed, vitest, records, exit1, running]);
    expect(run.stdout.split('\n')).toContain(`merged ${records}`);
    for (const id of [none, failed, vitest, exit1, running]) expect(run.stdout).toContain(`not merged ${id}: no core test:`);
  });

  it('does not take an ogw core test run of one test file (--file) as the last ogw core test', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], storage: [], auth: [] });
    const FILE = { ...PASSED, command: 'ogw core test server routing --file server/core/routing/tests/a.test.ts' };
    const failedThenFile = await coreJob(ws, 'routing', [{ ...PASSED, exitCode: 1 }, FILE]);
    const fileOnly = await coreJob(ws, 'storage', [{ ...FILE, command: 'ogw core test server storage --file=server/core/storage/tests/a.test.ts' }]);
    const passedThenFile = await coreJob(ws, 'auth', [PASSED, { ...FILE, exitCode: 1, summary: { tests: 1, passed: 0 } }]);
    const run = await ogw(ws, ['agent', 'merge', failedThenFile, fileOnly, passedThenFile]);
    expect(run.stdout).toContain(`not merged ${failedThenFile}: no core test:`);
    expect(run.stdout).toContain(`not merged ${fileOnly}: no core test:`);
    expect(run.stdout.split('\n')).toContain(`merged ${passedThenFile}`);
  });

  it('merges a client module job without a core test until an engine core test passed every client module', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
    for (const [name, side] of [['LogCore', 'client'], ['UtilCore', 'client'], ['routing', 'server']] as const) {
      writeFileSync(join(ws.coreImpl, 'core-spec', `${name}.json`), JSON.stringify({ name, side, dependencies: [] }));
    }
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    commitAll(ws.coreImpl, 'spec');
    const client = await coreJob(ws, 'LogCore', [], 'client/godot/core/log_core/log_core.gd');
    const server = await coreJob(ws, 'routing', []);
    const run = await ogw(ws, ['agent', 'merge', client, server]);
    expect(run.stdout.split('\n')).toContain(`merged ${client}`);
    expect(run.stdout).toContain(`not merged ${server}: no core test:`);
    // a record that passed only some client modules does not end it
    const head = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { LogCore: 'pass', UtilCore: 'fail' }, recordedAt: 1 });
    const second = await coreJob(ws, 'UtilCore', [], 'client/godot/core/util_core/util_core.gd');
    expect((await ogw(ws, ['agent', 'merge', second])).stdout.split('\n')).toContain(`merged ${second}`);
    // a later run of some modules counts per module: each module's latest result decides
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { UtilCore: 'pass' }, recordedAt: 2 });
    const later = await coreJob(ws, 'LogCore', [], 'client/godot/core/log_core/more.gd');
    expect((await ogw(ws, ['agent', 'merge', later])).stdout).toContain(`not merged ${later}: no core test:`);
    // a failure recorded on an agent branch main does not hold is not a core test on main
    const branchCommit = sh(ws.coreImpl, 'git', ['rev-parse', `agent/${later}`]).trim();
    await addTestRecord(ws.coreImpl, { commit: branchCommit, target: 'godot', modules: { LogCore: 'fail' }, recordedAt: 3 });
    const still = await coreJob(ws, 'UtilCore', [], 'client/godot/core/util_core/still.gd');
    expect((await ogw(ws, ['agent', 'merge', still])).stdout).toContain(`not merged ${still}: no core test:`);
    // once passed, a newer failure of one module on main does not bring the exemption back
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { LogCore: 'fail' }, recordedAt: 4 });
    const again = await coreJob(ws, 'UtilCore', [], 'client/godot/core/util_core/again.gd');
    expect((await ogw(ws, ['agent', 'merge', again])).stdout).toContain(`not merged ${again}: no core test:`);
  });

  it('merges a tool job whose core test tools left the round trip out (exit code 1, every vitest test passed) until an engine core test passed every client module', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'core-spec', 'LogCore.json'), JSON.stringify({ name: 'LogCore', side: 'client', dependencies: [] }));
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    commitAll(ws.coreImpl, 'spec');
    const skippedRun = { command: 'ogw core test tools', startedAt: 1, exitCode: 1, summary: { tests: 4, passed: 4 } };
    const failedRun = { ...skippedRun, summary: { tests: 4, passed: 3 } };
    const serverFailed = { command: 'ogw core test server', startedAt: 2, exitCode: 1, summary: { tests: 2, passed: 1 } };
    const serverPassed = { ...serverFailed, exitCode: 0, summary: { tests: 2, passed: 2 } };
    // the last `ogw core test tools` entry decides, whatever core test comes after it
    const tool = await coreJob(ws, 'contract-tool', [skippedRun, serverFailed], 'tools/contract-tool/src/a.ts');
    const failing = await coreJob(ws, 'data-tool', [failedRun, serverPassed], 'tools/data-tool/src/a.ts');
    const run = await ogw(ws, ['agent', 'merge', tool, failing]);
    expect(run.stdout.split('\n')).toContain(`merged ${tool}`);
    expect(run.stdout).toContain(`not merged ${failing}: no core test:`);
    // once a godot core test passed every client module, a tool job needs a passing core test again
    await addTestRecord(ws.coreImpl, { commit: sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim(), target: 'godot', modules: { LogCore: 'pass' }, recordedAt: 1 });
    const later = await coreJob(ws, 'contract-tool', [skippedRun], 'tools/contract-tool/src/b.ts');
    expect((await ogw(ws, ['agent', 'merge', later])).stdout).toContain(`not merged ${later}: no core test:`);
  });

  it('gives the exemptions only to jobs whose --module values are all client modules, or all tools', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
    for (const [name, side] of [['LogCore', 'client'], ['routing', 'server']] as const) {
      writeFileSync(join(ws.coreImpl, 'core-spec', `${name}.json`), JSON.stringify({ name, side, dependencies: [] }));
    }
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    commitAll(ws.coreImpl, 'spec');
    const multiJob = async (modules: string[], runs: unknown[], file: string): Promise<string> => {
      writeFileSync(join(ws.root, 'in-multi.md'), 'command: create server core\n');
      const fake = fakeAgentCli(ws, `fs.mkdirSync(${JSON.stringify(file.slice(0, file.lastIndexOf('/')))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(file)}, 'x'); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'multi', '--no-verify']); fs.writeFileSync(output, 'r'); fs.writeFileSync(output.replace(/\\.md$/, '-runs.json'), JSON.stringify({ runs: ${JSON.stringify(runs)} }));`);
      const { id, waited } = await runAgent(ws, ['core', ...modules.flatMap((m) => ['--module', m]), '--input', join(ws.root, 'in-multi.md')], fake.env);
      expect(waited.code).toBe(0);
      return id;
    };
    const skippedRun = { command: 'ogw core test tools', startedAt: 1, exitCode: 1, summary: { tests: 4, passed: 4 } };
    const clientAndServer = await multiJob(['LogCore', 'routing'], [], 'client/godot/core/log_core/a.gd');
    const toolAndModule = await multiJob(['contract-tool', 'LogCore'], [skippedRun], 'tools/contract-tool/src/a.ts');
    const run = await ogw(ws, ['agent', 'merge', clientAndServer, toolAndModule]);
    expect(run.stdout).toContain(`not merged ${clientAndServer}: no core test:`);
    expect(run.stdout).toContain(`not merged ${toolAndModule}: no core test:`);
  });
});
