import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ogw, commitAll, makeWorkspace } from '../../helpers/workspace.ts';
import { agentsByCall, coreSpec, finding, GOOD_FIX, reviewFile, spec } from './helpers.ts';
import { commitCore, readState } from './reopen-fixture.ts';

describe('ogw review run --reopen after a round left unjudged', () => {
  it('judges that round first, then starts the --reopen round after it when it is done', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agentsByCall(ws, { 1: reviewFile([]), 2: reviewFile([]) }, GOOD_FIX);
    // a run that was ended left round 1 unjudged; the target changed after it started
    expect((await ogw(ws, ['review', 'next', 'core', 'routing'], { env: fake.env })).stdout).toMatch(/^round: 1\n/);
    writeFileSync(join(ws.coreImpl, 'core-spec', 'routing.json'), spec('routing', 'server', ['logging']));
    commitAll(ws.coreImpl, 'change');
    const run = await ogw(ws, ['review', 'run', 'core', 'routing', '--reopen'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    const state = readState(join(ws.coreImpl, '.git', 'ogw-review', 'routing'));
    expect(state.rounds.map((r) => r.chain)).toEqual([1, 2]);
    expect(state.reopenAfter).toBeUndefined();
    expect(fake.calls()).toHaveLength(2);
  });

  it('goes on with the fix of that round when it is judged fix, and drops the --reopen', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    // review agent calls 1 (fix) and 2, and the core agent of the fix
    const fake = agentsByCall(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([], ['| R1-1 | fixed | ok |']) }, GOOD_FIX);
    expect((await ogw(ws, ['review', 'next', 'core', 'routing'], { env: fake.env })).stdout).toMatch(/^round: 1\n/);
    writeFileSync(join(ws.coreImpl, 'core-spec', 'routing.json'), spec('routing', 'server', ['logging']));
    commitAll(ws.coreImpl, 'change');
    const run = await ogw(ws, ['review', 'run', 'core', 'routing', '--reopen'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    const state = readState(join(ws.coreImpl, '.git', 'ogw-review', 'routing'));
    expect(state.rounds.map((r) => r.chain)).toEqual([1, 1]);
    expect(state.reopenAfter).toBeUndefined();
    expect(fake.calls()).toHaveLength(3);
  });
});

describe('ogw review run --reopen after a kept --reopen round left unjudged', () => {
  /**
   * Round 1 is done, the target changes, and a `review run --reopen` that was ended leaves its round 2 unjudged; with
   * `again` the target changes once more before `review run core routing --reopen` runs.
   */
  async function reopenAgain(again: boolean, files: Record<number, string> = { 1: reviewFile([]), 2: reviewFile([]), 3: reviewFile([]) }): Promise<{ stdout: string; chains: (number | undefined)[]; calls: number }> {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agentsByCall(ws, files, GOOD_FIX);
    expect(await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env })).toMatchObject({ code: 0, stdout: 'result: done\nround: 1\n' });
    writeFileSync(join(ws.coreImpl, 'core-spec', 'routing.json'), spec('routing', 'server', ['logging']));
    commitCore(ws, 'change');
    expect((await ogw(ws, ['review', 'next', 'core', 'routing', '--reopen'], { env: fake.env })).stdout).toMatch(/^round: 2\n/);
    if (again) {
      writeFileSync(join(ws.coreImpl, 'core-spec', 'routing.json'), spec('routing', 'server', ['logging', 'clock']));
      commitCore(ws, 'change again');
    }
    const run = await ogw(ws, ['review', 'run', 'core', 'routing', '--reopen'], { env: fake.env });
    expect(run.code).toBe(0);
    const state = readState(join(ws.coreImpl, '.git', 'ogw-review', 'routing'));
    expect(state.reopenAfter).toBeUndefined();
    return { stdout: run.stdout, chains: state.rounds.map((r) => r.chain), calls: fake.calls().length };
  }

  it('judges that round, then starts a round of a new chain when the target changed after that round started', async () => {
    expect(await reopenAgain(true)).toEqual({ stdout: 'result: done\nround: 3\n', chains: [1, 2, 3], calls: 3 });
  });

  it('goes on with the fix of that round when it is judged fix, and drops the --reopen', async () => {
    // review agent calls 1, 2 (fix) and 3, and the core agent of the fix
    const files = { 1: reviewFile([]), 2: reviewFile([finding('R2-1', 'no')]), 3: reviewFile([], ['| R2-1 | fixed | ok |']) };
    expect(await reopenAgain(true, files)).toEqual({ stdout: 'result: done\nround: 3\n', chains: [1, 2, 2], calls: 4 });
  });

  it('judges that round and starts no other round when the target did not change after that round started', async () => {
    expect(await reopenAgain(false)).toEqual({ stdout: 'result: done\nround: 2\n', chains: [1, 2], calls: 2 });
  });
});
