import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJob } from '../../../src/lib/jobs.ts';
import { ogw, commitAll, makeWorkspace, sh } from '../../helpers/workspace.ts';
import { agentsByCall, commitRange, coreSpec, finding, GOOD_FIX, reviewFile, spec } from './helpers.ts';
import { inputSection, seedList } from './debt-fixture.ts';
import { commitCore, readState, toolArgs } from './round-fixture.ts';
import { next, reviewer, wait } from './review-fixture.ts';

const M1 = { id: 'M1', severity: 'high' as const, location: 'src/c.ts:2', problem: 'an old crash', foundBy: 'x round 1' };
const M1_FIXED = '| M1 | fixed | none | gone |';

describe('ogw review: the must-fix round', () => {
  it('tool: starts no round after a review that ended unless the must-fix list has items, then one over the changes since the review ended, with no fix base and no previous review', async () => {
    const ws = makeWorkspace();
    const since = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    await next(ws, toolArgs(ws, since), reviewer(ws, { 1: reviewFile([]) }));
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 1\n');
    // a change of the target after the review ended starts no round
    appendFileSync(join(ws.harness, 'tools', 'ogw.md'), 'x');
    commitAll(ws.harness, 'tools change');
    expect((await next(ws, toolArgs(ws, since), reviewer(ws, {}))).stdout).toBe('done\n');
    seedList(ws.harness, 'must fix', 'agent-merge.json', { target: 'agent merge', nextId: 2, items: [M1] });
    const changed = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    const dir = join(ws.harness, '.git', 'ogw-review', 'agent merge');
    // round 2 writes no review file: invalid
    const started = await next(ws, toolArgs(ws, since), reviewer(ws, {}));
    expect(started.stdout).toMatch(/^round: 2\n/);
    const state = readState(dir);
    const first = state.rounds[0]?.startCommit as string;
    expect(inputSection(ws.harness, 'agent merge', 2, 'commit range')).toBe(`${first}..${changed}`);
    expect(inputSection(ws.harness, 'agent merge', 2, 'must fix')).toBe('- M1: src/c.ts:2: high an old crash');
    expect(inputSection(ws.harness, 'agent merge', 2, 'previous review')).toBe('none');
    expect((await readJob(state.rounds[1]?.codeCheckJob as string, ws.env)).argv).toEqual(['code', 'check', 'tool', '--commit', changed, '--json']);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: invalid\nround: 2\n');
    // the item is still there: the round starts again
    expect((await next(ws, toolArgs(ws, since), reviewer(ws, { 2: reviewFile([], [], [], [], [M1_FIXED]) }))).stdout).toMatch(/^round: 2\n/);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 2\nreview must fix removed: agent merge M1\n');
    expect((await next(ws, toolArgs(ws, since), reviewer(ws, {}))).stdout).toBe('done\n');
  });

  it('core: reviews the changes since the passing fix check of a fixed review', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const medium = '| R1-1 | `structure` | medium | src/a.ts:3 | reaches into x | use y | no | 90 |';
    const fake = agentsByCall(ws, { 1: reviewFile([medium]), 2: reviewFile([], [], [], [], [M1_FIXED]) }, GOOD_FIX);
    expect(await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env })).toMatchObject({ code: 0, stdout: 'result: fixed\nround: 1\n' });
    const ended = readState(join(ws.coreImpl, '.git', 'ogw-review', 'routing')) as unknown as { rounds: { fixChecks: { commit: string }[] }[] };
    const checked = ended.rounds[0]?.fixChecks[0]?.commit as string;
    mkdirSync(join(ws.coreImpl, 'records', 'review-must-fix'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'records', 'review-must-fix', 'routing.json'), JSON.stringify({ target: 'routing', nextId: 2, items: [M1] }));
    const main = commitCore(ws, 'must-fix item and its fix');
    expect(await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env })).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\nround 2: review must fix removed: routing M1\n' });
    expect(commitRange(ws, 'routing', 2)).toBe(`${checked}..${main}`);
  });

  it('review run: starts the must-fix round only in its first step, so a review that ends in the run stops it', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agentsByCall(ws, { 1: reviewFile([], [], ['- server/core/routing/a.ts:4: high an old crash']), 2: reviewFile([], [], [], [], [M1_FIXED]) }, GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 1\nout of scope: round 1: server/core/routing/a.ts:4: high an old crash\nround 1: review must fix added: routing M1: server/core/routing/a.ts:4: high an old crash\n' });
    expect(fake.calls()).toHaveLength(1);
    // the lead fixed the item: the next run checks the fix
    expect((await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env })).stdout).toMatch(/^result: done\nround: 2\n/);
    expect(fake.calls()).toHaveLength(2);
    expect(await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env })).toMatchObject({ code: 0 });
    expect(fake.calls()).toHaveLength(2);
  });

  it('takes no option that is not one of --respec, --full, --debt', async () => {
    const ws = makeWorkspace();
    const since = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    for (const option of ['--reopen', '--continue', '--restart']) {
      expect((await next(ws, [...toolArgs(ws, since), option], reviewer(ws, {}))).stderr).toContain(`unknown option ${option}`);
    }
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
