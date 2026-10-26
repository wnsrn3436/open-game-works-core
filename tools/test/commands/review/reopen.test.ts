import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJob } from '../../../src/lib/jobs.ts';
import { ogw, commitAll, makeWorkspace, sh } from '../../helpers/workspace.ts';
import { agentsByCall, commitRange, coreSpec, finding, GOOD_FIX, reviewFile, spec } from './helpers.ts';
import { commitCore, readState, toolArgs } from './reopen-fixture.ts';
import { next, reviewer, wait } from './review-fixture.ts';

describe('ogw review --reopen', () => {
  it('tool: refuses it with no round, before the round is judged, after a result other than done, and when tools/ did not change', async () => {
    const ws = makeWorkspace();
    const since = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    // one fake agent CLI per workspace: round 1 is blocked
    const env = reviewer(ws, { 1: reviewFile([finding('R1-1', 'yes')]) });
    expect((await next(ws, [...toolArgs(ws, since), '--reopen'], env)).stderr).toContain('--reopen of agent merge: there is no round to go on from');
    await next(ws, toolArgs(ws, since), env);
    const unjudged = await next(ws, [...toolArgs(ws, since), '--reopen'], env);
    expect(unjudged).toMatchObject({ code: 1 });
    expect(unjudged.stderr).toContain('round 1 of agent merge has not been judged by ogw review wait');
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toMatch(/^result: blocked\n/);
    appendFileSync(join(ws.harness, 'tools', 'ogw.md'), 'x');
    commitAll(ws.harness, 'tools change');
    expect((await next(ws, [...toolArgs(ws, since), '--reopen'], env)).stderr).toContain('--reopen needs the last round of agent merge to be done');

    const done = makeWorkspace();
    const doneSince = sh(done.harness, 'git', ['rev-parse', 'HEAD']).trim();
    await next(done, toolArgs(done, doneSince), reviewer(done, { 1: reviewFile([]) }));
    expect((await wait(done, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 1\n');
    // a change outside tools/ is not a change of the target
    writeFileSync(join(done.harness, 'skills', 'later.md'), 'x');
    commitAll(done.harness, 'later');
    const refused = await next(done, [...toolArgs(done, doneSince), '--reopen'], reviewer(done, {}));
    expect(refused).toMatchObject({ code: 1 });
    expect(refused.stderr).toContain('--reopen of agent merge: nothing of agent merge changed since round 1 started at ');
    const dir = join(done.harness, '.git', 'ogw-review', 'agent merge');
    expect(readState(dir).rounds).toHaveLength(1);
    expect(readState(dir).reopenAfter).toBeUndefined();
    // --reopen excludes the other options
    expect((await next(done, [...toolArgs(done, doneSince), '--reopen', '--continue'], reviewer(done, {}))).stderr).toContain('usage: ogw review next');
  });

  it('tool: starts a round of a new chain over the changes since the done round, with no fix base, and keeps the option after an invalid round', async () => {
    const ws = makeWorkspace();
    const since = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    await next(ws, toolArgs(ws, since), reviewer(ws, { 1: reviewFile([]) }));
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 1\n');
    // without --reopen a done target starts no round
    expect((await next(ws, toolArgs(ws, since), reviewer(ws, {}))).stdout).toBe('done\n');
    appendFileSync(join(ws.harness, 'tools', 'ogw.md'), 'x');
    const changed = commitAll(ws.harness, 'tools change');
    const dir = join(ws.harness, '.git', 'ogw-review', 'agent merge');
    // round 2 writes no review file: invalid
    const started = await next(ws, [...toolArgs(ws, since), '--reopen'], reviewer(ws, {}));
    expect(started).toMatchObject({ code: 0 });
    expect(started.stdout).toMatch(/^round: 2\n/);
    const state = readState(dir);
    const first = state.rounds[0]?.startCommit as string;
    expect(state.reopenAfter).toBe(1);
    expect(state.rounds.map((r) => r.chain)).toEqual([1, 2]);
    expect(readFileSync(state.rounds[1]?.input as string, 'utf8')).toContain(`## commit range\n\n${first}..${changed}\n`);
    // a --reopen round follows no fix: no fix test proof
    expect((await readJob(state.rounds[1]?.codeCheckJob as string, ws.env)).argv).toEqual(['code', 'check', 'tool', '--commit', changed, '--json']);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: invalid\nround: 2\n');
    expect(readState(dir).reopenAfter).toBe(1);
    // the kept --reopen starts the round again without the option
    const again = await next(ws, toolArgs(ws, since), reviewer(ws, { 2: reviewFile([]) }));
    expect(again.stdout).toMatch(/^round: 2\n/);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 2\n');
    const after = readState(dir);
    expect(after.rounds.map((r) => r.chain)).toEqual([1, 2]);
    expect(after.reopenAfter).toBeUndefined();
    expect((await next(ws, toolArgs(ws, since), reviewer(ws, {}))).stdout).toBe('done\n');
  });

  it('core: takes a change of core-spec/<module>.json or of the module folder of an engine, not of another path', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), JSON.stringify({ godot: '4.5.1.stable' }));
    coreSpec(ws, { routing: spec('routing', 'server'), LogCore: spec('LogCore', 'client') });
    for (const target of ['routing', 'LogCore']) {
      await next(ws, ['core', target], reviewer(ws, { 1: reviewFile([]) }));
      expect((await wait(ws, ['core', target])).stdout).toBe('result: done\nround: 1\n');
    }
    writeFileSync(join(ws.coreImpl, 'other.txt'), 'x');
    commitCore(ws, 'other');
    for (const target of ['routing', 'LogCore']) {
      expect((await next(ws, ['core', target, '--reopen'], reviewer(ws, {}))).stderr).toContain(`--reopen of ${target}: nothing of ${target} changed since round 1 started at `);
    }
    writeFileSync(join(ws.coreImpl, 'core-spec', 'routing.json'), spec('routing', 'server', ['logging']));
    mkdirSync(join(ws.coreImpl, 'client', 'godot', 'core', 'log_core'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'core', 'log_core', 'log_core.gd'), 'extends Node\n');
    commitCore(ws, 'change');
    for (const target of ['routing', 'LogCore']) {
      const dir = join(ws.coreImpl, '.git', 'ogw-review', target);
      const start = readState(dir).rounds[0]?.startCommit as string;
      // main also holds the review files merged since the change
      const main = sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim();
      expect((await next(ws, ['core', target, '--reopen'], reviewer(ws, { 2: reviewFile([]) }))).stdout).toMatch(/^round: 2\n/);
      expect(commitRange(ws, target, 2)).toBe(`${start}..${main}`);
      const state = readState(dir);
      expect(state.rounds.map((r) => r.chain)).toEqual([1, 2]);
      expect((await readJob(state.rounds[1]?.codeCheckJob as string, ws.env)).argv).toEqual(['code', 'check', 'core', '--commit', main, '--json']);
      // the code check of a Godot module needs the engine on the host: the round is judged either way
      expect((await wait(ws, ['core', target])).stdout).toMatch(/^result: (done|fix)\nround: 2\n/);
    }
  });

  it('core: takes a change of only the server module folder, and of only the tool folder of a core tool', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    for (const target of ['routing', 'contract-tool']) {
      await next(ws, ['core', target], reviewer(ws, { 1: reviewFile([]) }));
      expect((await wait(ws, ['core', target])).stdout).toBe('result: done\nround: 1\n');
    }
    for (const path of ['server/core/routing/server.ts', 'tools/contract-tool/src/cli.ts']) {
      mkdirSync(join(ws.coreImpl, path, '..'), { recursive: true });
      writeFileSync(join(ws.coreImpl, path), 'export {};\n');
    }
    commitCore(ws, 'change');
    for (const target of ['routing', 'contract-tool']) {
      expect((await next(ws, ['core', target, '--reopen'], reviewer(ws, { 2: reviewFile([]) }))).stdout).toMatch(/^round: 2\n/);
      expect(readState(join(ws.coreImpl, '.git', 'ogw-review', target)).rounds.map((r) => r.chain)).toEqual([1, 2]);
    }
  });

  it('review run: starts the round from done with --reopen, keeps the option after an invalid round, and refuses it when nothing changed', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    // call 2, the first --reopen round, writes no review file
    const fake = agentsByCall(ws, { 1: reviewFile([]), 3: reviewFile([]) }, GOOD_FIX);
    expect(await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env })).toMatchObject({ code: 0, stdout: 'result: done\nround: 1\n' });
    const unchanged = await ogw(ws, ['review', 'run', 'core', 'routing', '--reopen'], { env: fake.env });
    expect(unchanged).toMatchObject({ code: 1 });
    expect(unchanged.stderr).toContain('--reopen of routing: nothing of routing changed since round 1 started at ');
    writeFileSync(join(ws.coreImpl, 'core-spec', 'routing.json'), spec('routing', 'server', ['logging']));
    const main = commitCore(ws, 'change');
    const run = await ogw(ws, ['review', 'run', 'core', 'routing', '--reopen'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect(fake.calls()).toHaveLength(3);
    const dir = join(ws.coreImpl, '.git', 'ogw-review', 'routing');
    const state = readState(dir);
    expect(state.rounds.map((r) => r.chain)).toEqual([1, 2]);
    expect(state.reopenAfter).toBeUndefined();
    expect(commitRange(ws, 'routing', 2)).toBe(`${state.rounds[0]?.startCommit as string}..${main}`);
    expect((await readJob(state.rounds[1]?.codeCheckJob as string, ws.env)).argv).toEqual(['code', 'check', 'core', '--commit', main, '--json']);
  });
});

describe('ogw review clear core', () => {
  it('removes the spec review input folders and the review files of the spec review agents, not a tool review file', async () => {
    const ws = makeWorkspace();
    const started = await ogw(ws, ['review', 'spec', 'core', 'routing', '--full'], { env: reviewer(ws, { 1: reviewFile([finding('R1-1', 'yes')]) }) });
    const id = started.stdout.trim();
    expect((await ogw(ws, ['agent', 'wait', id, '--timeout', '60000'])).code).toBe(0);
    const meta = (await readJob(id, ws.env)).meta as { input: string; output: string };
    expect(basename(dirname(meta.input))).toMatch(/^ogw-review-spec-/);
    expect(basename(dirname(meta.output))).toMatch(/^ogw-review-file-/);
    expect(existsSync(meta.output)).toBe(true);
    // a tool review file is in an ogw-review-file- folder too: clear core keeps it
    const since = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    await next(ws, toolArgs(ws, since), reviewer(ws, { 1: reviewFile([]) }));
    await wait(ws, ['tool', 'agent', 'merge']);
    const toolFile = readState(join(ws.harness, '.git', 'ogw-review', 'agent merge')).rounds[0]?.reviewFile as string;
    expect(existsSync(toolFile)).toBe(true);
    expect(await ogw(ws, ['review', 'clear', 'core'])).toMatchObject({ code: 0, stdout: 'cleared core review state\n' });
    expect(existsSync(dirname(meta.input))).toBe(false);
    expect(existsSync(dirname(meta.output))).toBe(false);
    expect(existsSync(toolFile)).toBe(true);
  });
});
