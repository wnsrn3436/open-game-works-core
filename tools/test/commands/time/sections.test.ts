// The `## time` section of a record (ogw.md `## time`): the wall time, the spans of depth 1 of the critical path, and one
// line per flag.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jobReport, runTimeSection, timeSection } from '../../../src/commands/time/api.ts';
import { createContext } from '../../../src/lib/command.ts';
import type { RunState } from '../../../src/lib/runstate.ts';
import { makeGame } from '../../helpers/workspace.ts';
import { jobWorkspace, writeJob } from '../job/helpers.ts';

const T = 1_800_000_000_000;
const S = 1000;

describe('the ## time section', () => {
  it('holds the wall time, the top of the critical path and each flag', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'r1', startedAt: T, endedAt: T + 100 * S, status: 'done', exitCode: 0 });
    writeFileSync(
      join(ws.jobs, 'r1.spans.jsonl'),
      [
        { id: 'a', name: 'bot playtest', parent: null, start: T, end: T + 60 * S },
        { id: 'b', name: 'instance start', parent: 'a', start: T, end: T + 50 * S },
        { id: 'w', wait: 'instance slots', parent: 'b', start: T, end: T + 40 * S },
        { id: 'c', name: 'record', parent: null, start: T + 60 * S, end: T + 100 * S },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    expect(timeSection(await jobReport(ctx, 'r1'))).toBe([
      '- wall time: 1m 40s',
      '- critical path: bot playtest (r1/a) 1m 00s 60.0%; record (r1/c) 40.0s 40.0%',
      '- flag: wait: ogw check (r1) waited 40.0s on instance slots, 40.0% of its wall time 1m 40s (time.waitShare 0.25)',
    ].join('\n'));
  });

  it('of a run iteration, with no flag', async () => {
    const ws = jobWorkspace();
    const root = makeGame(ws, 'g');
    const run: RunState = { name: 'create-1', kind: 'loop', command: 'create', env: null, version: null, platforms: [], bundleFor: null, branch: 'loop/create-1', baseCommit: 'x', referenceCommit: null, startedAt: T, closedAt: T + 1000 * S, iteration: 1, data: {} };
    writeJob(ws.jobs, { id: 'a1', game: 'g', command: 'agent', meta: { role: 'content', run: 'create-1', iteration: 1 }, startedAt: T + 10 * S, endedAt: T + 90 * S, status: 'done', exitCode: 0 });
    const game = { name: 'g', root, mainRoot: root, commonDir: join(root, '.git'), inWorktree: false };
    expect(await runTimeSection(ws.env, game, run, 1)).toBe(['- wall time: 16m 30s', '- critical path: ogw agent content (a1) 1m 20s 8.1%', '- flags: none'].join('\n'));
    expect(await runTimeSection(ws.env, game, run, 2)).toBe('none: iteration 2 of run create-1 has no ogw agent job');
    // a spans file of a job of the run that names a parent span it does not hold: the section says why
    writeFileSync(join(ws.jobs, 'a1.spans.jsonl'), `${JSON.stringify({ id: 'x', name: 'x', parent: 'gone', start: T + 20 * S, end: T + 30 * S })}\n`);
    expect(await runTimeSection(ws.env, game, run, 1)).toBe('unknown: job a1: span x is in span gone, which its spans file does not hold');
  });
});
