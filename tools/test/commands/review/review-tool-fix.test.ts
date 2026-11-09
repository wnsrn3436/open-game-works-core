import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lastReviewResults } from '../../../src/commands/review/api.ts';
import { createContext } from '../../../src/lib/command.ts';
import { jobLogPaths, readJob, waitJob } from '../../../src/lib/jobs.ts';
import { commitAll, makeWorkspace, ogw, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { changeDefinition, finding, mergeDefinitions, next, reviewer, reviewFile, wait } from './review-fixture.ts';

interface State {
  respecAfter?: number;
  rounds: {
    second?: boolean;
    startCommit: string;
    codeCheckJob: string;
    result: string | null;
    fixBase?: string | null;
    fixChecks?: { job: string; commit: string; fixBase: string | null; result: string | null }[];
  }[];
}

const statePath = (ws: TestWorkspace): string => join(ws.harness, '.git', 'ogw-review', 'agent merge', 'state.json');
const readState = (ws: TestWorkspace): State => JSON.parse(readFileSync(statePath(ws), 'utf8')) as State;
const medium = (id: string): string => `| ${id} | \`correctness\` | medium | src/a.ts:3 | run x | check y | no | 90 |`;
const resultOf = (stdout: string): string => /^result: ([\w ]+)\n/.exec(stdout)?.[1] ?? stdout;

/**
 * Waits for the code check job `job` and makes its `fix test proof` a `fail` on `base`, as the proof gives when the fix's
 * tests pass on the code before the fix: the harness of the test workspace has no test runner for a real proof.
 * Returns the proof's failure line.
 */
async function proofFails(ws: TestWorkspace, job: string, base: string): Promise<string> {
  const waited = await waitJob(job, 120_000, ws.env);
  const output = JSON.parse(waited.stdout) as { checks: { name: string; result: string; failures: string[] }[] };
  const line = `the changed tests pass on ${base.slice(0, 12)}, the code before the fix, so they do not test the fixed behavior: test/a.test.ts`;
  output.checks = [...output.checks.filter((c) => c.name !== 'fix test proof'), { name: 'fix test proof', result: 'fail', failures: [line] }];
  writeFileSync((await jobLogPaths(waited.job, ws.env)).stdout, JSON.stringify(output));
  return line;
}

/** The `ogw review status tool` output. */
async function status(ws: TestWorkspace): Promise<string> {
  return (await ogw(ws, ['review', 'status', 'tool'])).stdout;
}

/** The lead agent's fix of a tool target: a committed change of the harness. */
function leadFix(ws: TestWorkspace, name: string): string {
  writeFileSync(join(ws.harness, `${name}.txt`), name);
  return commitAll(ws.harness, name);
}

describe('ogw review: tool', () => {
  it('stops at blocked, and goes on with --respec after a definition change', async () => {
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
    const refused = await next(ws, ['tool', 'agent', 'merge', '--respec', ...mergeDefinitions(ws)], env);
    expect(refused.stderr).toContain('--respec of agent merge: no definition document changed since round 1 started');
    changeDefinition(ws);
    expect((await next(ws, ['tool', 'agent', 'merge', '--respec', ...mergeDefinitions(ws)], reviewer(ws, { 2: reviewFile([], ['| R1-1 | fixed | spec changed |']) }))).stdout).toContain('round: 2');
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 2\n');
  });

  it('checks the fix of a round with the fix check alone: its code check with the fix test proof of a behavior finding, and no review round', async () => {
    const ws = makeWorkspace();
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, { 1: reviewFile([medium('R1-1')]) }));
    expect(resultOf((await wait(ws, ['tool', 'agent', 'merge'])).stdout)).toBe('fix');
    const fixed = leadFix(ws, 'fixed');
    // a review agent called now would write a round 2 file: the fix check starts none
    const started = await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, { 2: reviewFile([]) }));
    expect(started.stdout).toMatch(/^round: 1\nfix check job: \w+\n$/);
    const state = readState(ws);
    expect(state.rounds).toHaveLength(1);
    const check = state.rounds[0]?.fixChecks?.[0];
    expect(check).toMatchObject({ commit: fixed, fixBase: state.rounds[0]?.startCommit, result: null });
    expect((await readJob(check?.job as string, ws.env)).argv).toEqual(['code', 'check', 'tool', '--commit', fixed, '--fix-base', state.rounds[0]?.startCommit, '--target', 'agent merge', '--json']);
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    expect(await lastReviewResults(ctx, 'tool')).toEqual(new Map([['agent merge', 'running']]));
    // the round is judged; its fix check is not
    expect(await status(ws)).toBe('agent merge round 1 running spec change: none job: none\n');
    expect(await wait(ws, ['tool', 'agent', 'merge'])).toMatchObject({ code: 0, stdout: 'result: fixed\nround: 1\n' });
    expect(await status(ws)).toBe('agent merge round 1 fixed spec change: none job: none\n');
    expect(readState(ws).rounds[0]?.result).toBe('fixed');
    expect(await lastReviewResults(ctx, 'tool')).toEqual(new Map([['agent merge', 'fixed']]));
    // the review ended: no round, no fix check
    expect((await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, {}))).stdout).toBe('fixed\n');
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: fixed\nround: 1\n');
  });

  it('gives a fix check no fix test proof after the fix of a finding that keeps the behavior', async () => {
    const ws = makeWorkspace();
    const structure = '| R1-1 | `structure` | medium | src/a.ts:3 | reaches into x | use y | no | 90 |';
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, { 1: reviewFile([structure]) }));
    await wait(ws, ['tool', 'agent', 'merge']);
    const fixed = leadFix(ws, 'fixed');
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, {}));
    const check = readState(ws).rounds[0]?.fixChecks?.[0];
    expect((await readJob(check?.job as string, ws.env)).argv).toEqual(['code', 'check', 'tool', '--commit', fixed, '--json']);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: fixed\nround: 1\n');
  });

  it('starts the second round after the fix of a high finding, and only the fix check after the fix of the second round', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([finding('R2-1', 'no')], ['| R1-1 | fixed | ok |']), 3: reviewFile([]) });
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    expect(resultOf((await wait(ws, ['tool', 'agent', 'merge'])).stdout)).toBe('fix');
    leadFix(ws, 'first');
    expect((await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env)).stdout).toMatch(/^round: 2\nreview job: /);
    const round1 = readState(ws).rounds[0];
    // the second round's code check proves the fix of round 1
    expect((await readJob(readState(ws).rounds[1]?.codeCheckJob as string, ws.env)).argv).toContain(round1?.startCommit);
    expect(readState(ws).rounds[1]?.second).toBe(true);
    // round 2 finds a high finding again: its fix gets the fix check, not a third round
    expect(resultOf((await wait(ws, ['tool', 'agent', 'merge'])).stdout)).toBe('fix');
    const fixed = leadFix(ws, 'second');
    expect((await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env)).stdout).toMatch(/^round: 2\nfix check job: /);
    expect(readState(ws).rounds).toHaveLength(2);
    expect(readState(ws).rounds[1]?.fixChecks?.[0]).toMatchObject({ commit: fixed, fixBase: readState(ws).rounds[1]?.startCommit });
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: fixed\nround: 2\n');
  }, 120_000);

  it('stops a fix check with a fail as check fail, and starts another fix check on the same fix base after the fix', async () => {
    const ws = makeWorkspace();
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, { 1: reviewFile([medium('R1-1')]) }));
    await wait(ws, ['tool', 'agent', 'merge']);
    const base = readState(ws).rounds[0]?.startCommit;
    // the fix breaks the type check of the harness tools
    writeFileSync(join(ws.harness, 'tools', 'broken.ts'), "export const n: number = 'text';\n");
    commitAll(ws.harness, 'a fix that breaks the type check');
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, {}));
    const failed = await wait(ws, ['tool', 'agent', 'merge']);
    expect(failed.code).toBe(0);
    expect(failed.stdout).toMatch(/^result: check fail\nround: 1\ncode check fail: type check\n/);
    expect(failed.stdout).toContain("  broken.ts:1:14 TS2322 Type 'string' is not assignable to type 'number'.\n");
    expect(readState(ws).rounds[0]?.result).toBe('fix');
    expect(await status(ws)).toBe('agent merge round 1 check fail spec change: none job: none\n');
    rmSync(join(ws.harness, 'tools', 'broken.ts'));
    const fixed = commitAll(ws.harness, 'the fix of the check');
    expect((await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, {}))).stdout).toMatch(/^round: 1\nfix check job: /);
    expect(readState(ws).rounds[0]?.fixChecks?.map((c) => [c.fixBase, c.result])).toEqual([[base, 'fail'], [base, null]]);
    expect(readState(ws).rounds[0]?.fixChecks?.[1]?.commit).toBe(fixed);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: fixed\nround: 1\n');
  }, 120_000);

  it('does not count a fix test proof fail of a fix check when an earlier fix check failed the proof on the same fix base', async () => {
    const ws = makeWorkspace();
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, { 1: reviewFile([medium('R1-1')]) }));
    expect(resultOf((await wait(ws, ['tool', 'agent', 'merge'])).stdout)).toBe('fix');
    const base = readState(ws).rounds[0]?.startCommit as string;
    leadFix(ws, 'first');
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, {}));
    const line = await proofFails(ws, readState(ws).rounds[0]?.fixChecks?.[0]?.job as string, base);
    expect(await wait(ws, ['tool', 'agent', 'merge'])).toMatchObject({ code: 0, stdout: `result: check fail\nround: 1\ncode check fail: fix test proof\n  ${line}\n` });
    // the code before the fix already behaved: no test of the fix fails on that base
    leadFix(ws, 'second');
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, {}));
    expect(readState(ws).rounds[0]?.fixChecks?.map((c) => c.fixBase)).toEqual([base, base]);
    await proofFails(ws, readState(ws).rounds[0]?.fixChecks?.[1]?.job as string, base);
    expect(await wait(ws, ['tool', 'agent', 'merge'])).toMatchObject({
      code: 0,
      stdout: `result: fixed\nround: 1\nfix test proof fail not counted: the proof on --fix-base ${base} failed in an earlier code check\n  ${line}\n`,
    });
  }, 120_000);

  it('does not count a fix test proof fail of a --respec round when the fix check before it failed the proof on the same fix base', async () => {
    const ws = makeWorkspace();
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, { 1: reviewFile([medium('R1-1'), finding('R1-2', 'yes')]) }));
    expect(resultOf((await wait(ws, ['tool', 'agent', 'merge'])).stdout)).toBe('fix');
    const base = readState(ws).rounds[0]?.startCommit as string;
    leadFix(ws, 'fixed');
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, {}));
    const line = await proofFails(ws, readState(ws).rounds[0]?.fixChecks?.[0]?.job as string, base);
    expect(resultOf((await wait(ws, ['tool', 'agent', 'merge'])).stdout)).toBe('check fail');
    changeDefinition(ws);
    await next(ws, ['tool', 'agent', 'merge', '--respec', ...mergeDefinitions(ws)], reviewer(ws, { 2: reviewFile([], ['| R1-1 | fixed | ok |', '| R1-2 | fixed | spec changed |']) }));
    expect(readState(ws).rounds[1]?.fixBase).toBe(base);
    await proofFails(ws, readState(ws).rounds[1]?.codeCheckJob as string, base);
    expect(await wait(ws, ['tool', 'agent', 'merge'])).toMatchObject({
      code: 0,
      stdout: `result: done\nround: 2\nfix test proof fail not counted: the proof on --fix-base ${base} failed in an earlier code check\n  ${line}\n`,
    });
  }, 120_000);

  it('refuses a round or a fix check option while a fix check is not judged', async () => {
    const ws = makeWorkspace();
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, { 1: reviewFile([medium('R1-1')]) }));
    await wait(ws, ['tool', 'agent', 'merge']);
    leadFix(ws, 'fixed');
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, {}));
    const refused = await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, {}));
    expect(refused).toMatchObject({ code: 1 });
    expect(refused.stderr).toContain('the fix check of round 1 of agent merge has not been judged by ogw review wait');
    await wait(ws, ['tool', 'agent', 'merge']);
  });

  it('starts a --respec round after a fix round, which proves that fix, and starts it again after an invalid one', async () => {
    const ws = makeWorkspace();
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, { 1: reviewFile([medium('R1-1'), finding('R1-2', 'yes')]) }));
    expect(resultOf((await wait(ws, ['tool', 'agent', 'merge'])).stdout)).toBe('fix');
    leadFix(ws, 'fixed');
    changeDefinition(ws);
    const started = await next(ws, ['tool', 'agent', 'merge', '--respec', ...mergeDefinitions(ws)], reviewer(ws, {}));
    expect(started.stdout).toMatch(/^round: 2\n/);
    const state = readState(ws);
    expect((await readJob(state.rounds[1]?.codeCheckJob as string, ws.env)).argv).toEqual(['code', 'check', 'tool', '--commit', state.rounds[1]?.startCommit, '--fix-base', state.rounds[0]?.startCommit, '--target', 'agent merge', '--json']);
    expect(state.respecAfter).toBe(1);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: invalid\nround: 2\n');
    // the kept --respec starts the round again
    const again = await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, { 2: reviewFile([], ['| R1-1 | fixed | ok |', '| R1-2 | fixed | spec changed |']) }));
    expect(again.stdout).toMatch(/^round: 2\n/);
    const dir = join(ws.harness, '.git', 'ogw-review', 'agent merge');
    expect(readFileSync(join(dir, 'round-2-input.md'), 'utf8')).toContain(`## spec changes\n\n${join(dir, 'round-2-spec-changes.diff')}\n`);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 2\n');
  });

  it('carries a previous open finding as first written, from an earlier review file without out of scope too, and stops at blocked on it', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, {
      1: reviewFile([finding('R1-1', 'yes'), finding('R1-2', 'no')]),
      2: reviewFile([], ['| R1-1 | open | not changed |', '| R1-2 | fixed | done |']),
    });
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toContain('result: fix\n');
    // a review file judged before `## out of scope` was part of the form
    const first = (JSON.parse(readFileSync(statePath(ws), 'utf8')) as { rounds: { reviewFile: string }[] }).rounds[0]?.reviewFile as string;
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
    const first = (JSON.parse(readFileSync(statePath(ws), 'utf8')) as { rounds: { reviewFile: string }[] }).rounds[0]?.reviewFile as string;
    writeFileSync(first, readFileSync(first, 'utf8').replace(finding('R1-2', 'no'), '| R1-2 | duplication | low | src/b.ts:1 | same x | share it | no | 85 |'));
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: blocked\nround: 2\nopen finding: R1-1 correctness high src/a.ts:3 spec change: yes\n');
  });
});
