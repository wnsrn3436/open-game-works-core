import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lastReviewResults } from '../../../src/commands/review/api.ts';
import { createContext } from '../../../src/lib/command.ts';
import { readJob } from '../../../src/lib/jobs.ts';
import { makeWorkspace, sh } from '../../helpers/workspace.ts';
import { changeDefinition, finding, mergeDefinitions, next, reviewer, reviewFile, wait } from './review-fixture.ts';

describe('ogw review: tool', () => {
  it('stops at blocked until --restart after a definition change', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([finding('R1-1', 'yes')]) });
    const r1 = await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    expect(r1.code).toBe(0);
    expect(r1.stdout).toMatch(/^round: 1\nreview job: \w+\ncode check job: \w+\n$/);
    const codeCheckJob = /code check job: (\w+)/.exec(r1.stdout)?.[1] ?? '';
    const harnessHead = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    expect((await readJob(codeCheckJob, ws.env)).argv).toEqual(['code', 'check', 'tool', '--commit', harnessHead, '--json']);
    const blocked = await wait(ws, ['tool', 'agent', 'merge']);
    expect(blocked).toMatchObject({ code: 0, stdout: 'result: blocked\nround: 1\nopen finding: R1-1 correctness high src/a.ts:3 spec change: yes\n' });
    expect((await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env)).stdout).toBe('blocked\n');
    const refused = await next(ws, ['tool', 'agent', 'merge', '--restart', ...mergeDefinitions(ws)], env);
    expect(refused.stderr).toContain('--restart of agent merge: no definition document changed since round 1 started');
    changeDefinition(ws);
    expect((await next(ws, ['tool', 'agent', 'merge', '--restart', ...mergeDefinitions(ws)], reviewer(ws, { 1: reviewFile([]) }))).stdout).toContain('round: 1');
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 1\n');
  });

  it('judges a --respec round as the first round of a new chain: a chain after --respec that does not converge is limit', async () => {
    const ws = makeWorkspace();
    const open = (round: number): string => reviewFile([finding(`R${String(round)}-1`, 'no')]);
    const env = reviewer(ws, { 1: reviewFile([finding('R1-1', 'yes')]), 2: open(2), 3: open(3), 4: open(4) });
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toMatch(/^result: blocked\n/);
    changeDefinition(ws);
    const results: string[] = [];
    for (const option of [['--respec'], [], []]) {
      expect((await next(ws, ['tool', 'agent', 'merge', ...option, ...mergeDefinitions(ws)], env)).code).toBe(0);
      results.push(/^result: (\w+)/.exec((await wait(ws, ['tool', 'agent', 'merge'])).stdout)?.[1] ?? '');
    }
    // chain 2 (rounds 2 to 4) reaches reviewRounds without done: not escalate, which only chain 1 gives
    expect(results).toEqual(['fix', 'fix', 'limit']);
    const dir = join(ws.harness, '.git', 'ogw-review', 'agent merge');
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { rounds: { chain: number }[] };
    expect(state.rounds.map((r) => r.chain)).toEqual([1, 2, 2, 2]);
    // the rounds after the --respec round judged review no definition diff
    expect(readFileSync(join(dir, 'round-3-input.md'), 'utf8')).toContain('## spec changes\n\nnone\n');
  }, 180_000);

  it('starts a --respec round after limit with no fix test proof and no --continue, and starts it again after an invalid one', async () => {
    const ws = makeWorkspace();
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, { 1: reviewFile([finding('R1-1', 'yes')]) }));
    await wait(ws, ['tool', 'agent', 'merge']);
    // round 1 as a limit round with an open correctness finding to fix
    const dir = join(ws.harness, '.git', 'ogw-review', 'agent merge');
    const statePath = join(dir, 'state.json');
    const limited = JSON.parse(readFileSync(statePath, 'utf8')) as { rounds: { result: string; open: { specChange: string }[] }[] };
    (limited.rounds[0] as { result: string }).result = 'limit';
    limited.rounds[0]?.open.push({ ...(limited.rounds[0].open[0] as { specChange: string }), specChange: 'no' });
    writeFileSync(statePath, JSON.stringify(limited));
    changeDefinition(ws);
    const started = await next(ws, ['tool', 'agent', 'merge', '--respec', ...mergeDefinitions(ws)], reviewer(ws, {}));
    expect(started.stdout).toMatch(/^round: 2\n/);
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { continueAfter?: number; respecAfter?: number; rounds: { codeCheckJob: string; startCommit: string }[] };
    expect((await readJob(state.rounds[1]?.codeCheckJob as string, ws.env)).argv).toEqual(['code', 'check', 'tool', '--commit', state.rounds[1]?.startCommit, '--json']);
    expect(state.continueAfter).toBeUndefined();
    expect(state.respecAfter).toBe(1);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: invalid\nround: 2\n');
    // the kept --respec starts the round again; no --continue round
    const again = await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, { 2: reviewFile([]) }));
    expect(again.stdout).toMatch(/^round: 2\n/);
    expect(readFileSync(join(dir, 'round-2-input.md'), 'utf8')).toContain(`## spec changes\n\n${join(dir, 'round-2-spec-changes.diff')}\n`);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 2\n');
  });

  it('runs chains: fix, escalate with an escalation input, limit, and a new chain with --continue', async () => {
    const ws = makeWorkspace();
    const open = (round: number, previous: string[] = []): string => reviewFile([finding(`R${String(round)}-1`, 'no')], previous);
    const env = reviewer(ws, { 1: open(1), 2: open(2), 3: open(3), 4: open(4), 5: open(5), 6: open(6), 7: reviewFile([], [], ['- src/b.ts:9: critical an old slow loop']) });
    const results: string[] = [];
    for (let round = 1; round <= 6; round += 1) {
      await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
      results.push(/^result: (\w+)/.exec((await wait(ws, ['tool', 'agent', 'merge'])).stdout)?.[1] ?? '');
    }
    expect(results).toEqual(['fix', 'fix', 'escalate', 'fix', 'fix', 'limit']);
    const statePath = join(ws.harness, '.git', 'ogw-review', 'agent merge', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { rounds: { chain: number; fixInput: string | null; startCommit: string; codeCheckJob: string }[] };
    // after a fix of a correctness finding the code check proves the fix's tests on the code before it
    expect((await readJob(state.rounds[1]?.codeCheckJob as string, ws.env)).argv).toEqual([
      'code', 'check', 'tool', '--commit', state.rounds[1]?.startCommit, '--fix-base', state.rounds[0]?.startCommit, '--target', 'agent merge', '--json',
    ]);
    expect(state.rounds.map((r) => r.chain)).toEqual([1, 1, 1, 2, 2, 2]);
    // the tool side writes an input only for escalate: the lead fixes `fix` rounds from the review file
    expect(state.rounds.map((r) => r.fixInput !== null)).toEqual([false, false, true, false, false, false]);
    expect(readFileSync(state.rounds[2]?.fixInput as string, 'utf8')).toContain('## chain\n\n- round 1: review file ');
    expect((await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env)).stdout).toBe('limit\n');
    expect((await next(ws, ['tool', 'agent', 'merge', '--continue', ...mergeDefinitions(ws)], env)).stdout).toContain('round: 7');
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 7\nout of scope: src/b.ts:9: critical an old slow loop\nreview must fix added: agent merge M1: src/b.ts:9: critical an old slow loop\n');
    expect((await next(ws, ['tool', 'agent', 'merge', '--continue', ...mergeDefinitions(ws)], env)).stderr).toContain('--continue needs the last round of agent merge to be limit');
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    expect(await lastReviewResults(ctx, 'tool')).toEqual(new Map([['agent merge', 'done']]));
  }, 180_000);

  it('carries a previous open finding as first written, from an earlier review file without out of scope too, and stops at blocked on it', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, {
      1: reviewFile([finding('R1-1', 'yes'), finding('R1-2', 'no')]),
      2: reviewFile([], ['| R1-1 | open | not changed |', '| R1-2 | fixed | done |']),
    });
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toContain('result: fix\n');
    // a review file judged before `## out of scope` was part of the form
    const statePath = join(ws.harness, '.git', 'ogw-review', 'agent merge', 'state.json');
    const first = (JSON.parse(readFileSync(statePath, 'utf8')) as { rounds: { reviewFile: string }[] }).rounds[0]?.reviewFile as string;
    writeFileSync(first, readFileSync(first, 'utf8').replace('## out of scope\n\nnone\n\n', ''));
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: blocked\nround: 2\nopen finding: R1-1 correctness high src/a.ts:3 spec change: yes\n');
  });

  it('carries a previous open finding from an earlier review file with a duplication low row, and stops at blocked on it', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, {
      1: reviewFile([finding('R1-1', 'yes'), finding('R1-2', 'no')]),
      2: reviewFile([], ['| R1-1 | open | not changed |', '| R1-2 | fixed | done |']),
    });
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toContain('result: fix\n');
    // a review file judged while the review agent still wrote `duplication` findings and `low` severities
    const statePath = join(ws.harness, '.git', 'ogw-review', 'agent merge', 'state.json');
    const first = (JSON.parse(readFileSync(statePath, 'utf8')) as { rounds: { reviewFile: string }[] }).rounds[0]?.reviewFile as string;
    writeFileSync(first, readFileSync(first, 'utf8').replace(finding('R1-2', 'no'), '| R1-2 | duplication | low | src/b.ts:1 | same x | share it | no | 85 |'));
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: blocked\nround: 2\nopen finding: R1-1 correctness high src/a.ts:3 spec change: yes\n');
  });

  it('takes --restart of a round written before definition hashes were kept', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([finding('R1-1', 'yes')]) });
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    await wait(ws, ['tool', 'agent', 'merge']);
    const statePath = join(ws.harness, '.git', 'ogw-review', 'agent merge', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { rounds: Record<string, unknown>[] };
    for (const round of state.rounds) delete round.definitionHashes;
    writeFileSync(statePath, JSON.stringify(state));
    expect((await next(ws, ['tool', 'agent', 'merge', '--restart', ...mergeDefinitions(ws)], env)).stdout).toContain('round: 1');
    await wait(ws, ['tool', 'agent', 'merge']);
  });
});
