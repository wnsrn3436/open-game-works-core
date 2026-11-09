import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listJobs } from '../../../src/lib/jobs.ts';
import { ogw, commitAll, makeWorkspace } from '../../helpers/workspace.ts';
import { agents, coreSpec, finding, GOOD_FIX, reviewFile, spec, toolsChange } from './helpers.ts';
import { commitCore } from './round-fixture.ts';

/** The fix inputs the fake core agent was called with, as `<round> fix`. */
function fixCalls(calls: { prompt: string }[]): string[] {
  return calls.map((call) => /round-(\d)-fix\.md/.exec(call.prompt)?.[1]).filter((x) => x !== undefined).map((round) => `${round} fix`);
}

describe('ogw review run', () => {
  it('goes on in a process of the changed harness code when the harness tools change during the run', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([], ['| R1-1 | fixed | ok |']) }, toolsChange(ws) + GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect(run.stderr).toContain('the harness tools changed: ogw review run core routing goes on with the new code');
  });

  it('calls a fix agent with --module of the target', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([]) }, GOOD_FIX);
    await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    const cores = (await listJobs(ws.env)).filter((job) => job.command === 'agent' && job.meta.role === 'core');
    expect(cores.map((job) => job.meta.modules)).toEqual([['routing']]);
    expect(cores.map((job) => (job.meta as { outputRel: string }).outputRel)).toEqual([expect.stringMatching(new RegExp(`^records/\\d+-review-fix-${cores[0]?.id ?? ''}\\.md$`))]);
  });

  it('stops at blocked and at a second invalid round in a row', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server'), storage: spec('storage', 'server') });
    const blocked = agents(ws, { 1: reviewFile([finding('R1-1', 'yes')]) }, GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: blocked.env });
    expect(run).toMatchObject({ code: 1, stdout: 'result: blocked\nround: 1\nopen finding: R1-1 correctness high src/a.ts:3 spec change: yes\n' });
    expect((await ogw(ws, ['review', 'status', 'core'])).stdout).toBe('routing round 1 blocked spec change: R1-1 job: none\n');
    const invalid = agents(ws, {}, GOOD_FIX);
    const twice = await ogw(ws, ['review', 'run', 'core', 'storage'], { env: invalid.env });
    const reviewPath = join(ws.coreImpl, 'records', 'review', 'storage-1.md');
    expect(twice).toMatchObject({ code: 1, stdout: `result: invalid\nround: 0\nreview file missing or not in the review file format: ${reviewPath}\n` });
    expect(invalid.calls()).toHaveLength(2);
  });

  it('ends with the fix check after the fix of the second round, whatever the second round finds', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([finding('R2-1', 'no')], ['| R1-1 | open | not fixed |']), 3: reviewFile([]) }, GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: fixed\nround: 2\n' });
    expect(fixCalls(fake.calls())).toEqual(['1 fix', '2 fix']);
    const state = JSON.parse(readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'state.json'), 'utf8')) as { rounds: { second?: boolean; result: string; fixChecks?: unknown[] }[] };
    expect(state.rounds.map((r) => [r.second ?? false, r.result, r.fixChecks?.length ?? 0])).toEqual([[false, 'fix', 0], [true, 'fixed', 1]]);
  });

  it('stops at check fail when the fix check fails, and a run after the fix of that failure checks the fix again', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    mkdirSync(join(ws.coreImpl, 'server', 'core', 'routing'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'package.json'), '{"type": "module"}\n');
    writeFileSync(join(ws.coreImpl, 'server', 'package-lock.json'), '{"lockfileVersion": 3, "requires": true, "packages": {"": {}}}\n');
    // a type check failure of the target that the fix leaves: `ogw agent merge` takes a failure main has too, and
    // routing has no entry file, so no core test runs after the fix
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'helper.ts'), "export const r: number = 'text';\n");
    commitAll(ws.coreImpl, 'server code');
    const medium = '| R1-1 | `structure` | medium | server/core/routing/helper.ts:1 | reaches into x | use y | no | 90 |';
    const fake = agents(ws, { 1: reviewFile([medium]) }, GOOD_FIX);
    const failed = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(failed.code).toBe(1);
    expect(failed.stdout).toMatch(/^result: check fail\nround: 1\ncode check fail: type check\n {2}server\/core\/routing\/helper\.ts:1:14 TS2322 /);
    expect((await ogw(ws, ['review', 'status', 'core'])).stdout).toBe('routing round 1 fix spec change: none job: none\n');
    // the lead's fix of the failure; the next run calls no core agent and no review agent
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'helper.ts'), 'export const r = 2;\n');
    commitCore(ws, 'the fix of the type check');
    const again = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(again).toMatchObject({ code: 0, stdout: 'result: fixed\nround: 1\n' });
    expect(fixCalls(fake.calls())).toEqual(['1 fix']);
    const state = JSON.parse(readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'state.json'), 'utf8')) as { rounds: { fixChecks: { result: string }[] }[] };
    expect(state.rounds[0]?.fixChecks.map((c) => c.result)).toEqual(['fail', 'pass']);
  });
});
