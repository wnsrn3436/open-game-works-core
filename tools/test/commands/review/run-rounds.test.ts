import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listJobs, readJob } from '../../../src/lib/jobs.ts';
import { ogw, commitAll, makeWorkspace } from '../../helpers/workspace.ts';
import { agents, agentsByCall, changeDefinition, commitRange, coreSpec, finding, GOOD_FIX, implementServer, reviewFile, spec, toolsChange } from './helpers.ts';

describe('ogw review run', () => {
  it('runs no core test after a fix that changed only records/', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    mkdirSync(join(ws.coreImpl, 'server', 'core', 'routing'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), '');
    commitAll(ws.coreImpl, 'routing');
    const recordsFix = "fs.mkdirSync('records/notes', { recursive: true }); fs.writeFileSync('records/notes/fix.md', 'nothing to fix'); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'fix', '--no-verify']); fs.writeFileSync(output, 'report');";
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([], ['| R1-1 | fixed | ok |']) }, recordsFix);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect((await listJobs(ws.env)).filter((job) => job.command === 'core test')).toEqual([]);
  });

  it('runs the core test of an implemented dependent after the fix, and stops at test fail; a rerun with --since goes on at the core test', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    mkdirSync(join(ws.coreImpl, 'server', 'core', 'routing'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), '');
    // the module is there at `--since`: round 1 reviews the changes since it, not the whole module
    const since = commitAll(ws.coreImpl, 'routing');
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), 'export {};\n');
    const main = commitAll(ws.coreImpl, 'routing change');
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([]) }, GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing', '--since', since], { env: fake.env });
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/^result: test fail\nround: 1\nopen finding: R1-1 correctness high src\/a.ts:3 spec change: no\nogw core test server routing: /);
    // `--since` gives round 1 the changes from that commit
    expect(commitRange(ws, 'routing', 1)).toBe(`${since}..${main}`);
    const tests = (await listJobs(ws.env)).filter((job) => job.command === 'core test');
    expect(tests.map((job) => job.argv)).toEqual([['core', 'test', 'server', 'routing', '--json']]);
    // the run starts again at the core test: the fix is merged
    const again = await ogw(ws, ['review', 'run', 'core', 'routing', '--since', since], { env: fake.env });
    expect(again.stdout).toMatch(/^result: test fail\n/);
    expect((await listJobs(ws.env)).filter((job) => job.command === 'core test')).toHaveLength(2);
    expect(fake.calls().filter((call) => call.prompt.includes('round-1-fix.md'))).toHaveLength(1);
  });

  it('keeps --since for a round 1 started again after an invalid one', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    mkdirSync(join(ws.coreImpl, 'tools', 'routing'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'tools', 'routing', 'a.txt'), 'x');
    const since = commitAll(ws.coreImpl, 'routing');
    writeFileSync(join(ws.coreImpl, 'changed.txt'), 'x');
    const main = commitAll(ws.coreImpl, 'change');
    const fake = agentsByCall(ws, { 2: reviewFile([], [], ['- src/old.ts:4: high an old bug']) }, GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing', '--since', since], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 1\nout of scope: round 1: src/old.ts:4: high an old bug\nround 1: review must fix added: routing M1: src/old.ts:4: high an old bug\n' });
    expect(commitRange(ws, 'routing', 1)).toBe(`${since}..${main}`);
  });

  it('hands the count of invalid rounds in a row to the process of the changed harness code', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    // call 1 writes no review file and changes the harness tools; call 2 writes none either: the second invalid in a row
    const fake = agentsByCall(ws, { 3: reviewFile([]) }, GOOD_FIX, { 1: toolsChange(ws) });
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run.stderr).toContain('the harness tools changed: ogw review run core routing goes on with the new code');
    const reviewPath = join(ws.coreImpl, 'records', 'review', 'routing-1.md');
    expect(run).toMatchObject({ code: 1, stdout: `result: invalid\nround: 0\nreview file missing or not in the review file format: ${reviewPath}\n` });
    expect(fake.calls()).toHaveLength(2);
  });

  it('goes on after a blocked round with --respec, and starts the --respec round again after it was judged invalid', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    // call 2, the first --respec round, writes no review file
    const fake = agentsByCall(ws, { 1: reviewFile([finding('R1-1', 'yes')]), 3: reviewFile([], ['| R1-1 | fixed | spec changed |']) }, GOOD_FIX);
    expect((await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env })).stdout).toMatch(/^result: blocked\nround: 1\n/);
    changeDefinition(ws);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing', '--respec'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect(fake.calls()).toHaveLength(3);
    const dir = join(ws.coreImpl, '.git', 'ogw-review', 'routing');
    expect(readFileSync(join(dir, 'round-2-input.md'), 'utf8')).toContain(`## spec changes\n\n${join(dir, 'round-2-spec-changes.diff')}\n`);
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { respecAfter?: number; rounds: { chain?: number }[] };
    expect(state.rounds.map((r) => r.chain)).toEqual([1, 2]);
    expect(state.respecAfter).toBeUndefined();
  });

  it('with --respec judges a round left unjudged first, then starts the --respec round after it', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agentsByCall(ws, { 1: reviewFile([finding('R1-1', 'yes')]), 2: reviewFile([], ['| R1-1 | fixed | spec changed |']) }, GOOD_FIX);
    // a run that was ended left round 1 unjudged
    expect((await ogw(ws, ['review', 'next', 'core', 'routing'], { env: fake.env })).stdout).toMatch(/^round: 1\n/);
    changeDefinition(ws);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing', '--respec'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    const dir = join(ws.coreImpl, '.git', 'ogw-review', 'routing');
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { respecAfter?: number; rounds: { chain?: number; result: string }[] };
    expect(state.rounds.map((r) => [r.chain, r.result])).toEqual([[1, 'blocked'], [2, 'done']]);
    expect(state.respecAfter).toBeUndefined();
    expect(readFileSync(join(dir, 'round-2-input.md'), 'utf8')).toContain(`## spec changes\n\n${join(dir, 'round-2-spec-changes.diff')}\n`);
  });

  it('with --respec follows a kept --respec round left unjudged with another round when a definition changed after it started', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agentsByCall(ws, { 1: reviewFile([finding('R1-1', 'yes')]), 2: reviewFile([], ['| R1-1 | fixed | spec changed |']), 3: reviewFile([]) }, GOOD_FIX);
    await ogw(ws, ['review', 'next', 'core', 'routing'], { env: fake.env });
    expect((await ogw(ws, ['review', 'wait', 'core', 'routing', '--timeout', '120000'])).stdout).toMatch(/^result: blocked\n/);
    changeDefinition(ws);
    // a --respec run that was ended left its round 2 unjudged, and the spec changed again
    expect((await ogw(ws, ['review', 'next', 'core', 'routing', '--respec'], { env: fake.env })).stdout).toMatch(/^round: 2\n/);
    appendFileSync(join(ws.harness, 'skills', 'core', 'command.md'), '\n- changed again\n');
    const run = await ogw(ws, ['review', 'run', 'core', 'routing', '--respec'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 3\n' });
    const dir = join(ws.coreImpl, '.git', 'ogw-review', 'routing');
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { rounds: { chain?: number; result: string }[] };
    expect(state.rounds.map((r) => [r.chain, r.result])).toEqual([[1, 'blocked'], [2, 'done'], [3, 'done']]);
    expect(readFileSync(join(dir, 'round-3-spec-changes.diff'), 'utf8')).toContain('changed again');
  });

  it('with --respec goes on with round 1 when the round 1 left unjudged is judged invalid and dropped', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    // call 1 writes no review file: its round 1 is invalid
    const fake = agentsByCall(ws, { 2: reviewFile([]) }, GOOD_FIX);
    expect((await ogw(ws, ['review', 'next', 'core', 'routing'], { env: fake.env })).stdout).toMatch(/^round: 1\n/);
    changeDefinition(ws);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing', '--respec'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 1\n' });
    const state = JSON.parse(readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'state.json'), 'utf8')) as { respecAfter?: number; rounds: { result: string }[] };
    expect(state.rounds.map((r) => r.result)).toEqual(['done']);
    expect(state.respecAfter).toBeUndefined();
  });

  it('merges the fix of the last round before a --respec round', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const files = { 1: reviewFile([finding('R1-1', 'no'), finding('R1-2', 'yes')]), 2: reviewFile([], ['| R1-1 | fixed | ok |', '| R1-2 | fixed | spec changed |']) };
    const fake = agents(ws, files, GOOD_FIX);
    await ogw(ws, ['review', 'next', 'core', 'routing'], { env: fake.env });
    expect((await ogw(ws, ['review', 'wait', 'core', 'routing', '--timeout', '120000'])).stdout).toMatch(/^result: fix\n/);
    // the lead's core agent of the fix input ended and was not merged yet
    const dir = join(ws.coreImpl, '.git', 'ogw-review', 'routing');
    const job = (await ogw(ws, ['agent', 'core', '--module', 'routing', '--input', join(dir, 'round-1-fix.md'), '--background'], { env: fake.env })).stdout.trim();
    await ogw(ws, ['agent', 'wait', job, '--timeout', '60000']);
    changeDefinition(ws);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing', '--respec'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect(((await readJob(job, ws.env)).meta as { merged: boolean }).merged).toBe(true);
    const input = readFileSync(join(dir, 'round-2-input.md'), 'utf8');
    expect(input).toContain(`## core agent reports\n\n- ${join(ws.coreImpl, (await readJob(job, ws.env)).meta.outputRel as string)}\n`);
    expect(input).toContain(`## spec changes\n\n${join(dir, 'round-2-spec-changes.diff')}\n`);
  });

  it('judges a round that the review next of an earlier run left, and counts its invalid result', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agents(ws, {}, GOOD_FIX);
    await ogw(ws, ['review', 'next', 'core', 'routing'], { env: fake.env });
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run.stdout).toMatch(/^result: invalid\nround: 0\n/);
    expect(fake.calls()).toHaveLength(2);
    const judged = agents(ws, { 1: reviewFile([]) }, GOOD_FIX);
    await ogw(ws, ['review', 'next', 'core', 'routing'], { env: judged.env });
    expect(await ogw(ws, ['review', 'run', 'core', 'routing'], { env: judged.env })).toMatchObject({ code: 0, stdout: 'result: done\nround: 1\n' });
    expect(judged.calls()).toHaveLength(1);
  });

  it('waits for a running fix job of the last round, and starts at the next round when the fix is merged', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const slow = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([]) }, `execFileSync('sleep', ['2']); ${GOOD_FIX}`);
    await ogw(ws, ['review', 'next', 'core', 'routing'], { env: slow.env });
    await ogw(ws, ['review', 'wait', 'core', 'routing', '--timeout', '120000']);
    const fixInput = join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'round-1-fix.md');
    const job = (await ogw(ws, ['agent', 'core', '--module', 'routing', '--input', fixInput, '--background'], { env: slow.env })).stdout.trim();
    expect(await ogw(ws, ['review', 'run', 'core', 'routing'], { env: slow.env })).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect(slow.calls().filter((call) => call.prompt.includes('round-1-fix.md'))).toHaveLength(1);
    expect(((await readJob(job, ws.env)).meta as { merged: boolean }).merged).toBe(true);

    const merged = makeWorkspace();
    coreSpec(merged, { routing: spec('routing', 'server') });
    const fake = agents(merged, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([]) }, GOOD_FIX);
    await ogw(merged, ['review', 'next', 'core', 'routing'], { env: fake.env });
    await ogw(merged, ['review', 'wait', 'core', 'routing', '--timeout', '120000']);
    const input = join(merged.coreImpl, '.git', 'ogw-review', 'routing', 'round-1-fix.md');
    const fixed = (await ogw(merged, ['agent', 'core', '--module', 'routing', '--input', input, '--background'], { env: fake.env })).stdout.trim();
    await ogw(merged, ['agent', 'wait', fixed, '--timeout', '60000']);
    await ogw(merged, ['agent', 'merge', fixed]);
    expect(await ogw(merged, ['review', 'run', 'core', 'routing'], { env: fake.env })).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect(fake.calls().filter((call) => call.prompt.includes('round-1-fix.md'))).toHaveLength(1);
  });

  it('runs at most reviewRunConcurrency review agent, core agent and core test jobs at once across the runs of the host', async () => {
    const ws = makeWorkspace({ reviewRunConcurrency: 1 });
    coreSpec(ws, { routing: spec('routing', 'server'), storage: spec('storage', 'server') });
    implementServer(ws, ['routing', 'storage']);
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]) }, GOOD_FIX);
    const both = await Promise.all(['routing', 'storage'].map((target) => ogw(ws, ['review', 'run', 'core', target], { env: fake.env })));
    expect(both.map((run) => /^result: (.+)$/m.exec(run.stdout)?.[1])).toEqual(['test fail', 'test fail']);
    // every review agent, core agent and core test job of the two runs, as the job records time them
    const jobs = (await listJobs(ws.env)).filter((job) => job.command === 'agent' || job.command === 'core test');
    expect(jobs.map((job) => job.command).sort()).toEqual(['agent', 'agent', 'agent', 'agent', 'core test', 'core test']);
    const spans = jobs.map((job) => [job.startedAt, job.endedAt as number] as const).sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < spans.length; i += 1) expect(spans[i]?.[0]).toBeGreaterThanOrEqual(spans[i - 1]?.[1] as number);
  });

  it('shows running before a round is judged, the spec change findings of the last judged round, a running job, and tool targets', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const blocked = agents(ws, { 1: reviewFile([finding('R1-1', 'yes')]) }, GOOD_FIX);
    await ogw(ws, ['review', 'run', 'core', 'routing'], { env: blocked.env });
    const slow = agents(ws, { 1: reviewFile([]) }, GOOD_FIX);
    const slowEnv = { ...slow.env };
    writeFileSync(join(ws.root, 'fake-bin', 'fake.mjs'), readFileSync(join(ws.root, 'fake-bin', 'fake.mjs'), 'utf8').replace("const prompt =", "execFileSync('sleep', ['3']); const prompt ="));
    expect((await ogw(ws, ['review', 'status', 'core'])).stdout).toBe('routing round 1 blocked spec change: R1-1 job: none\n');
    // a blocked target starts no round until the human changed the spec
    expect((await ogw(ws, ['review', 'next', 'core', 'routing'], { env: slowEnv })).stdout).toBe('blocked\n');
    changeDefinition(ws);
    await ogw(ws, ['review', 'next', 'core', 'routing', '--restart'], { env: slowEnv });
    expect((await ogw(ws, ['review', 'status', 'core'])).stdout).toBe('routing round 1 running spec change: none job: none\n');
    await ogw(ws, ['review', 'wait', 'core', 'routing', '--timeout', '120000']);
    changeDefinition(ws);
    const job = (await ogw(ws, ['review', 'run', '--restart', 'core', 'routing', '--background'], { env: slowEnv })).stdout.trim();
    let shown = '';
    for (let i = 0; i < 50 && !shown.includes(`job: ${job}`); i += 1) {
      shown = (await ogw(ws, ['review', 'status', 'core'])).stdout;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(shown).toContain(`job: ${job}`);
    await ogw(ws, ['job', 'wait', job, '--timeout', '120000']);
    const tool = agents(ws, { 1: reviewFile([]) }, GOOD_FIX);
    await ogw(ws, ['review', 'next', 'tool', 'agent', 'merge', '--since', 'HEAD', '--definition', join(ws.harness, 'tools', 'ogw.md')], { env: tool.env });
    await ogw(ws, ['review', 'wait', 'tool', 'agent', 'merge', '--timeout', '120000']);
    expect((await ogw(ws, ['review', 'status', 'tool'])).stdout).toBe('agent merge round 1 done spec change: none job: none\n');
  });

  it('fails at once while a run of the same target holds its lock, and checks the arguments', async () => {
    const ws = makeWorkspace();
    const lock = join(ws.coreImpl, '.git', 'ogw-review', 'routing.run.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), `${String(process.pid)}\n`);
    const refused = await ogw(ws, ['review', 'run', 'core', 'routing']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('an ogw review run job of routing is running');
    expect((await ogw(ws, ['review', 'run', 'tool', 'agent', 'merge'])).stderr).toContain('usage: ogw review run core <target> [--since <commit>|--full|--debt] [--restart|--respec|--continue|--reopen]');
    expect((await ogw(ws, ['review', 'status', 'x'])).stderr).toContain('usage: ogw review status <core|tool>');
    rmSync(lock, { recursive: true, force: true });
    coreSpec(ws, { routing: spec('routing', 'server') });
    expect((await ogw(ws, ['review', 'run', 'core', 'routing'], { env: agents(ws, { 1: reviewFile([]) }, GOOD_FIX).env })).stdout).toBe('result: done\nround: 1\n');
    const notLimit = await ogw(ws, ['review', 'run', 'core', 'routing', '--continue']);
    expect(notLimit).toMatchObject({ code: 1 });
    expect(notLimit.stderr).toContain('--continue needs the last round of routing to be limit');
  });
});
