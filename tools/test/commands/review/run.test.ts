import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failedLines, sortFixRuns, testRuns } from '../../../src/commands/review/lib/run.ts';
import { readJob, type JobRecord, type WaitResult } from '../../../src/lib/jobs.ts';
import { ogw, commitAll, makeWorkspace } from '../../helpers/workspace.ts';
import { agents, coreSpec, finding, GOOD_FIX, reviewFile, spec, UNTESTED_FIX } from './helpers.ts';

describe('ogw review run', () => {
  it('goes through a fix round, merges the fix, and stops at done', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([], ['| R1-1 | fixed | ok |']) }, GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect(fake.calls().filter((call) => call.prompt.includes('round-1-fix.md'))).toHaveLength(1);
    const status = await ogw(ws, ['review', 'status', 'core']);
    expect(status.stdout).toBe('routing round 2 done spec change: none job: none\n');
    // a done target starts no round
    expect(await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env })).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
  });

  it('gives the code check failures outside the target in its stop output', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    mkdirSync(join(ws.coreImpl, 'server', 'core', 'storage'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'package.json'), '{"type": "module"}\n');
    writeFileSync(join(ws.coreImpl, 'server', 'package-lock.json'), '{"lockfileVersion": 3, "requires": true, "packages": {"": {}}}\n');
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'storage', 'index.ts'), "export const s: number = 'text';\n");
    commitAll(ws.coreImpl, 'a type check failure of storage');
    const fake = agents(ws, { 1: reviewFile([]) }, GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: "result: done\nround: 1\ncode check fail outside target: server/core/storage/index.ts:1:14 TS2322 Type 'string' is not assignable to type 'number'.\n" });
  });

  it('calls the core agent once more when its fix is not merged, then stops with not merged', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]) }, UNTESTED_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/^result: not merged\nround: 1\nopen finding: R1-1 correctness high src\/a.ts:3 spec change: no\nnot merged: \w+: no core test: /);
    expect(fake.calls().filter((call) => call.prompt.includes('round-1-fix.md'))).toHaveLength(2);
  });

  it('merges a finished fix job of the last round first, and passes --module with the target', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([], ['| R1-1 | fixed | ok |']) }, GOOD_FIX);
    await ogw(ws, ['review', 'next', 'core', 'routing'], { env: fake.env });
    await ogw(ws, ['review', 'wait', 'core', 'routing', '--timeout', '120000']);
    const fixInput = join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'round-1-fix.md');
    const job = (await ogw(ws, ['agent', 'core', '--module', 'routing', '--input', fixInput, '--background'], { env: fake.env })).stdout.trim();
    await ogw(ws, ['agent', 'wait', job, '--timeout', '60000']);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect(fake.calls().filter((call) => call.prompt.includes('round-1-fix.md'))).toHaveLength(1);
    expect(((await readJob(job, ws.env)).meta as { merged: boolean }).merged).toBe(true);
  });

  it('calls the core agent again instead of merging a fix job that failed, also when that job was merged', async () => {
    for (const mergeFailed of [false, true]) {
      const ws = makeWorkspace();
      coreSpec(ws, { routing: spec('routing', 'server') });
      // the first core agent ends without its report; the next one fixes
      const marker = join(ws.root, 'failed-once');
      const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([], ['| R1-1 | fixed | ok |']) },
        `if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); process.exit(1); } ${GOOD_FIX}`);
      await ogw(ws, ['review', 'next', 'core', 'routing'], { env: fake.env });
      await ogw(ws, ['review', 'wait', 'core', 'routing', '--timeout', '120000']);
      const fixInput = join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'round-1-fix.md');
      const failed = (await ogw(ws, ['agent', 'core', '--module', 'routing', '--input', fixInput, '--background'], { env: fake.env })).stdout.trim();
      await ogw(ws, ['agent', 'wait', failed, '--timeout', '60000']);
      expect((await readJob(failed, ws.env)).status).not.toBe('done');
      if (mergeFailed) await ogw(ws, ['agent', 'merge', failed]);
      expect(await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env })).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
      expect(fake.calls().filter((call) => call.prompt.includes('round-1-fix.md'))).toHaveLength(2);
      expect(((await readJob(failed, ws.env)).meta as { merged: boolean }).merged).toBe(mergeFailed);
    }
  });
});

describe('testRuns', () => {
  it('runs the tool tests for a tool, and the implemented dependents per server and engine for a module', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, {
      storage: spec('storage', 'server'),
      routing: spec('routing', 'server', ['storage']),
      mailbox: spec('mailbox', 'server', ['routing']),
      ranking: spec('ranking', 'server'),
      UICore: spec('UICore', 'client', ['storage']),
      LogCore: spec('LogCore', 'client', ['storage']),
    });
    for (const module of ['storage', 'routing']) {
      mkdirSync(join(ws.coreImpl, 'server', 'core', module), { recursive: true });
      writeFileSync(join(ws.coreImpl, 'server', 'core', module, 'index.ts'), '');
    }
    mkdirSync(join(ws.coreImpl, 'client', 'godot', 'core', 'ui_core'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'core', 'ui_core', 'ui_core.gd'), '');
    expect(await testRuns(ws.coreImpl, 'storage')).toEqual([['server', 'routing', 'storage'], ['godot', 'UICore'], ['godot', 'UICore', '--web']]);
    expect(await testRuns(ws.coreImpl, 'ranking')).toEqual([]);
    expect(await testRuns(ws.coreImpl, 'data-tool')).toEqual([['tools']]);
    await expect(testRuns(ws.coreImpl, 'nothing')).rejects.toThrow('not in core-spec: nothing');
  });
});

describe('failedLines', () => {
  const waited = (stdout: string, exitCode: number, stderr = ''): WaitResult => ({ job: { exitCode } as JobRecord, finished: true, stdout, stderr });

  it('names each failed module with its failures, and a run that stopped before its tests', () => {
    // a module skipped for its failed dependency is not a failed test: the dependency's lines say why
    const json = JSON.stringify({ modules: { routing: 'pass', storage: 'fail', chat: 'skipped' }, failures: { storage: ['sqlite run: a.test.ts x'], chat: [] } });
    expect(failedLines(['server', 'routing', 'storage', 'chat'], waited(json, 1))).toEqual([
      'ogw core test server routing storage chat: storage fail',
      '  sqlite run: a.test.ts x',
    ]);
    expect(failedLines(['server'], waited(JSON.stringify({ modules: { routing: 'pass' } }), 0))).toEqual([]);
    // a tool whose engine round trip was left out has no failing test, though the run ends with exit code 1
    const leftOut = JSON.stringify({ modules: { 'data-tool': 'skipped' }, failures: { 'data-tool': [] }, skipped: { 'data-tool': 'godot round trip left out: x' } });
    expect(failedLines(['tools'], waited(leftOut, 1))).toEqual([]);
    expect(failedLines(['tools'], waited(JSON.stringify({ error: 'core-spec/ check failed' }), 1))).toEqual(['ogw core test tools: core-spec/ check failed']);
    expect(failedLines(['godot', '--web'], waited('', 1, 'boom\nmore'))).toEqual(['ogw core test godot --web: exit code 1: boom']);
  });
});

describe('core test failures after a fix', () => {
  it('stops for the target, a run that failed otherwise, or another module that passed before the fix, and keeps one that failed before', async () => {
    const run = (failed: string[] | null, line: string) => ({ args: ['server', 'routing', 'auth', 'mailbox'], lines: [line], failed });
    const before = new Set(['mailbox']);
    const failedBefore = (_args: readonly string[], module: string): Promise<boolean> => Promise.resolve(before.has(module));
    expect(await sortFixRuns([run(['mailbox'], 'm')], 'routing', failedBefore)).toEqual({ stopping: [], preexisting: ['m'] });
    expect(await sortFixRuns([run(['auth'], 'a')], 'routing', failedBefore)).toEqual({ stopping: ['a'], preexisting: [] });
    expect(await sortFixRuns([run(['auth', 'mailbox'], 'am')], 'routing', failedBefore)).toEqual({ stopping: ['am'], preexisting: [] });
    expect(await sortFixRuns([run(['routing', 'mailbox'], 'rm')], 'routing', failedBefore)).toEqual({ stopping: ['rm'], preexisting: [] });
    expect(await sortFixRuns([run(null, 'x')], 'routing', failedBefore)).toEqual({ stopping: ['x'], preexisting: [] });
  });
});
