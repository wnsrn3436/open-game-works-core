import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseBrowserRuns, type OgwRunner } from '../../../src/commands/core/lib/release-conditions.ts';
import { addTestRecord } from '../../../src/commands/core/lib/test-records.ts';
import { createContext } from '../../../src/lib/command.ts';
import type { RunResult } from '../../../src/lib/proc.ts';
import { commitAll, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';

/** `open-game-works-core-impl/` with the client modules LogCore and UICore of Godot and the server module routing. */
function impl(ws: TestWorkspace): string {
  mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
  mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
  const modules: [string, string][] = [['LogCore', 'client'], ['UICore', 'client'], ['routing', 'server']];
  for (const [name, side] of modules) {
    writeFileSync(join(ws.coreImpl, 'core-spec', `${name}.json`), JSON.stringify({ name, side, dependencies: [], optionalDependencies: [], devDependencies: [] }));
  }
  writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
  return commitAll(ws.coreImpl, 'core');
}

function result(stdout: string, code = 0): RunResult {
  return { code, signal: null, stdout, stderr: '', stdoutBytes: Buffer.from(stdout), timedOut: false };
}

/** A runner that records each argv and answers with `answer`. */
function runner(answer: RunResult): { run: OgwRunner; calls: { argv: readonly string[]; cwd: string }[] } {
  const calls: { argv: readonly string[]; cwd: string }[] = [];
  return { calls, run: (argv, cwd) => { calls.push({ argv, cwd }); return Promise.resolve(answer); } };
}

describe('releaseBrowserRuns', () => {
  it('runs the browser run of the modules of each engine that are not pass on main HEAD, in the main checkout', async () => {
    const ws = makeWorkspace();
    const commit = impl(ws);
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    await addTestRecord(ws.coreImpl, { commit, target: 'godot --web', modules: { LogCore: 'pass', UICore: 'fail' }, recordedAt: 1 });
    // a native record does not count for the browser run
    await addTestRecord(ws.coreImpl, { commit, target: 'godot', modules: { LogCore: 'pass', UICore: 'pass' }, recordedAt: 1 });
    const fake = runner(result(JSON.stringify({ modules: { UICore: 'pass' } })));
    expect(await releaseBrowserRuns(ctx, ws.coreImpl, fake.run)).toEqual([]);
    expect(fake.calls).toEqual([{ argv: ['core', 'test', 'godot', 'UICore', '--web', '--json'], cwd: ws.coreImpl }]);
    // every module passed there: no run
    await addTestRecord(ws.coreImpl, { commit, target: 'godot --web', modules: { UICore: 'pass' }, recordedAt: 2 });
    const none = runner(result(''));
    expect(await releaseBrowserRuns(ctx, ws.coreImpl, none.run)).toEqual([]);
    expect(none.calls).toEqual([]);
  });

  it('gives a line for a run that stopped before it reported its modules', async () => {
    const ws = makeWorkspace();
    impl(ws);
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const stopped = runner(result(JSON.stringify({ error: 'core-spec/ check failed' }), 1));
    expect(await releaseBrowserRuns(ctx, ws.coreImpl, stopped.run)).toEqual(['core test godot --web: core-spec/ check failed']);
    expect(stopped.calls[0]?.argv).toEqual(['core', 'test', 'godot', 'LogCore', 'UICore', '--web', '--json']);
    const crashed = runner({ ...result('', 2), stderr: 'boom\nmore' });
    expect(await releaseBrowserRuns(ctx, ws.coreImpl, crashed.run)).toEqual(['core test godot --web: exit code 2: boom']);
    const reported = runner(result(JSON.stringify({ modules: { LogCore: 'fail', UICore: 'unknown' } }), 1));
    expect(await releaseBrowserRuns(ctx, ws.coreImpl, reported.run)).toEqual([]);
  });
});
