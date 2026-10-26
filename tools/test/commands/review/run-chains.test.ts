import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listJobs, readJob } from '../../../src/lib/jobs.ts';
import { ogw, makeWorkspace } from '../../helpers/workspace.ts';
import { agents, changeDefinition, commitRange, coreSpec, finding, GOOD_FIX, reviewFile, spec, toolsChange } from './helpers.ts';

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
    // --restart starts round 1 again once a definition document changed
    const refused = await ogw(ws, ['review', 'run', 'core', 'routing', '--restart'], { env: agents(ws, { 1: reviewFile([]) }, GOOD_FIX).env });
    expect(refused).toMatchObject({ code: 1 });
    expect(refused.stderr).toContain('--restart of routing: no definition document changed since round 1 started');
    changeDefinition(ws);
    const restarted = await ogw(ws, ['review', 'run', 'core', 'routing', '--restart'], { env: agents(ws, { 1: reviewFile([]) }, GOOD_FIX).env });
    expect(restarted).toMatchObject({ code: 0, stdout: 'result: done\nround: 1\n' });
  });

  it('escalates when the first chain reaches the limit, stops at limit when the escalation chain does, and goes on with --continue', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const open = (round: number): string => reviewFile([finding(`R${String(round)}-1`, 'no')]);
    const fake = agents(ws, { 1: open(1), 2: open(2), 3: open(3), 4: open(4), 5: open(5), 6: open(6), 7: reviewFile([]) }, GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run).toMatchObject({ code: 1, stdout: 'result: limit\nround: 6\nopen finding: R6-1 correctness high src/a.ts:3 spec change: no\n' });
    const fixes = fake.calls().map((call) => /round-(\d)-(fix|escalation)\.md/.exec(call.prompt)?.slice(1).join(' ')).filter((x) => x !== undefined);
    expect(fixes).toEqual(['1 fix', '2 fix', '3 escalation', '4 fix', '5 fix']);
    const escalation = readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'round-3-escalation.md'), 'utf8');
    expect(escalation).toMatch(/^command: review fix\n- target: routing\n/);
    expect(escalation).toMatch(/## chain\n\n- round 1: review file \S+routing-1\.md, fix \w+\.\.\w+\n- round 2: review file \S+routing-2\.md, fix \w+\.\.\w+\n- round 3: review file \S+routing-3\.md\n$/);
    // limit starts no round until --continue, after the fix the human chose
    expect((await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env })).stdout).toBe('result: limit\nround: 6\nopen finding: R6-1 correctness high src/a.ts:3 spec change: no\n');
    // the fake core agent fixes on a `review fix` input; the lead's input for the human's fix names the same command here
    writeFileSync(join(ws.root, 'human-fix.md'), 'command: review fix\n- target: routing\n- the fix the human chose\n');
    const humanJob = (await ogw(ws, ['agent', 'core', '--module', 'routing', '--input', join(ws.root, 'human-fix.md'), '--background'], { env: fake.env })).stdout.trim();
    await ogw(ws, ['agent', 'wait', humanJob, '--timeout', '120000']);
    expect((await ogw(ws, ['agent', 'merge', humanJob])).stdout.split('\n')).toContain(`merged ${humanJob}`);
    // a --continue run whose round is dropped twice as invalid stops; a run started again goes on with the kept --continue
    const dropped = agents(ws, {}, GOOD_FIX);
    expect((await ogw(ws, ['review', 'run', 'core', 'routing', '--continue'], { env: dropped.env })).stdout).toMatch(/^result: invalid\n/);
    // one fake agent CLI per workspace: this one writes the round 7 review file again
    const again = agents(ws, { 7: reviewFile([]) }, GOOD_FIX);
    expect((await ogw(ws, ['review', 'run', 'core', 'routing'], { env: again.env })).stdout).toBe('result: done\nround: 7\n');
    // the new chain's review sees the report of the human's fix
    const report = join(ws.coreImpl, (await readJob(humanJob, ws.env)).meta.outputRel as string);
    // the reports section of the input lists that report alone
    expect(readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'round-7-input.md'), 'utf8')).toContain(`## core agent reports\n\n- ${report}\n\n## spec changes\n\nnone\n`);
    const rounds = (JSON.parse(readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'state.json'), 'utf8')) as { rounds: { fixJobs?: string[] }[] }).rounds;
    expect(rounds[5]?.fixJobs).toEqual([humanJob]);
    const state = JSON.parse(readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'state.json'), 'utf8')) as { rounds: { round: number; chain: number; startCommit: string }[] };
    expect(state.rounds.map((r) => r.chain)).toEqual([1, 1, 1, 2, 2, 2, 3]);
    // the new chain reviews the changes from the start of the limit round
    expect(commitRange(ws, 'routing', 7)).toBe(`${state.rounds[5]?.startCommit as string}..${state.rounds[6]?.startCommit as string}`);
  }, 180_000);

  it('escalates when a finding is still open after two fixes, before the round limit', async () => {
    const ws = makeWorkspace({ reviewRounds: 5 });
    coreSpec(ws, { routing: spec('routing', 'server') });
    const files = {
      1: reviewFile([finding('R1-1', 'no')]),
      2: reviewFile([], ['| R1-1 | open | not fixed |']),
      3: reviewFile([], ['| R1-1 | open | not fixed |']),
      4: reviewFile([], ['| R1-1 | fixed | done |']),
    };
    const fake = agents(ws, files, GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 4\n' });
    const fixes = fake.calls().map((call) => /round-(\d)-(fix|escalation)\.md/.exec(call.prompt)?.slice(1).join(' ')).filter((x) => x !== undefined);
    expect(fixes).toEqual(['1 fix', '2 fix', '3 escalation']);
  });
});
