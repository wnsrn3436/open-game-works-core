import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextOrder } from '../../../../src/commands/agent/lib/prepare.ts';
import { createContext } from '../../../../src/lib/command.ts';
import { listRuns, requireOpenRun } from '../../../../src/lib/runstate.ts';
import { jobWorkspace, writeJob } from '../../job/helpers.ts';
import { gameWithRun } from '../helpers.ts';

describe('play and judge order', () => {
  it('counts k per role and iteration in the run state, taking the counts of a run without them from its agent jobs once', async () => {
    const ws = jobWorkspace();
    const { game } = await gameWithRun(ws, {}, { iteration: 2 });
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    writeJob(ws.jobs, { id: 'p1', command: 'agent', status: 'done', meta: { role: 'play', game: 'g', run: 'r1', iteration: 2, k: 3 } });
    writeJob(ws.jobs, { id: 'p2', command: 'agent', status: 'done', meta: { role: 'play', game: 'other', run: 'r1', iteration: 2, k: 7 } });
    const run = await requireOpenRun(game);
    expect(await nextOrder(ctx, game, 'play', run)).toBe(4);
    expect(await nextOrder(ctx, game, 'judge', run)).toBe(1);
    // the job records are not read again
    writeFileSync(join(ws.jobs, 'p3.json'), 'not JSON');
    writeJob(ws.jobs, { id: 'p4', command: 'agent', status: 'done', meta: { role: 'play', game: 'g', run: 'r1', iteration: 2, k: 9 } });
    expect(await nextOrder(ctx, game, 'play', run)).toBe(5);
    expect((await listRuns(game))[0]?.data.agent).toEqual({ order: { 'play-2': 5, 'judge-2': 1 } });
  });
});
