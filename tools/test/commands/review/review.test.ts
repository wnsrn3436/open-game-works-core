import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testAtHead } from '../../../src/commands/core/lib/main-checkout.ts';
import { clearReviews, lastReviewResults } from '../../../src/commands/review/api.ts';
import { checkContinue, fixBase } from '../../../src/commands/review/lib/next.ts';
import { decide, failureFile, outsideTargetFailures, targetFolders } from '../../../src/commands/review/lib/wait.ts';
import type { RoundState } from '../../../src/commands/review/lib/state.ts';
import { createContext } from '../../../src/lib/command.ts';
import { readJob } from '../../../src/lib/jobs.ts';
import { ogw, commitAll, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { CORE_TEST_PASSED, fakeAgentCli } from '../agent/helpers.ts';
import { changeDefinition, finding, mergeDefinitions, next, reviewer, reviewFile, wait } from './review-fixture.ts';

describe('code check failures outside the target', () => {
  it('takes the type check and lint lines whose file is outside every target folder, and keeps lines of no file, of a folder holding a target folder and of other checks', () => {
    const folders = ['server/core/routing/', 'client/godot/core/log_core/', 'tools/routing/'].map((path) => ({ path, present: true }));
    const items = [
      { name: 'type check', result: 'fail' as const, failures: ['server/core/routing/tests/support.ts:107:211 TS2554 Expected 1', 'server/core/storage/a.ts:1:2 TS2322 x', 'client/godot/core/ui_core/a.gd:3 Parse Error', 'client/godot/core/log_core/b.gd:4 Parse Error', 'tsc: crashed', 'client/godot:1 godot --import failed (1): ERROR: x', 'client/godot/core:1 x', 'client/godo:1 x'] },
      { name: 'lint', result: 'fail' as const, failures: ['test-data/x.ts:1:1 no-unused-vars y'] },
      { name: 'secret', result: 'fail' as const, failures: ['server/core/storage/a.ts:1:2 secret'] },
    ];
    // a line of a folder that holds a target folder (the project-wide import failure) covers the target: it counts
    expect(outsideTargetFailures(items, folders)).toEqual(['server/core/storage/a.ts:1:2 TS2322 x', 'client/godot/core/ui_core/a.gd:3 Parse Error', 'client/godo:1 x', 'test-data/x.ts:1:1 no-unused-vars y']);
    // a harness tool target has no outside
    expect(outsideTargetFailures(items, null)).toEqual([]);
    expect(failureFile('server/core/routing/tests/support.ts:107:211 TS2554 Expected 1')).toBe('server/core/routing/tests/support.ts');
    expect(failureFile('tsc: crashed')).toBeNull();
  });

  it('counts a folder-level line only for a target with files under that folder: a client module, not a server module or a tool', async () => {
    const ws = makeWorkspace();
    for (const dir of ['client/godot/core/log_core', 'server/core/routing', 'tools/contract-tool']) {
      mkdirSync(join(ws.coreImpl, dir), { recursive: true });
      writeFileSync(join(ws.coreImpl, dir, 'a.txt'), 'x');
    }
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    const commit = commitAll(ws.coreImpl, 'targets');
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const importFailed = 'client/godot:1 godot --import failed (1): ERROR: x';
    const items = [{ name: 'type check', result: 'fail' as const, failures: [importFailed] }];
    const outside = async (target: string): Promise<string[]> => outsideTargetFailures(items, await targetFolders(ctx, 'core', target, commit));
    expect(await outside('LogCore')).toEqual([]);
    expect(await outside('routing')).toEqual([importFailed]);
    expect(await outside('contract-tool')).toEqual([importFailed]);
    // a server module's folder line still covers it
    expect(outsideTargetFailures([{ name: 'lint', result: 'fail', failures: ['server/core:1 x'] }], await targetFolders(ctx, 'core', 'routing', commit))).toEqual([]);
  });
});

describe('decide', () => {
  const open = (id: string, specChange = 'no') => ({ id, aspect: 'correctness', severity: 'medium', location: 'a.ts:1', specChange });
  const at = (round: number, chain: number, chainBase: number, chainRounds: number, ids: string[]) =>
    decide({ open: ids.map((id) => open(id)), codeCheckPass: true, round, chain, chainBase, chainRounds, rounds: 3 });

  it('counts the fixes of a finding in its chain only', () => {
    // chain 1: R1-1 open in round 3 was fixed after rounds 1 and 2
    expect(at(2, 1, 0, 2, ['R1-1'])).toBe('fix');
    expect(at(3, 1, 0, 2, ['R1-1'])).toBe('escalate');
    // chain 2 begins after round 3: R1-1 open in round 4 was fixed once in it (the escalation fix)
    expect(at(4, 2, 3, 1, ['R1-1'])).toBe('fix');
    expect(at(5, 2, 3, 2, ['R1-1'])).toBe('limit');
    // a chain after --continue counts from its limit round
    expect(at(7, 3, 6, 1, ['R1-1'])).toBe('fix');
    expect(at(8, 3, 6, 2, ['R1-1'])).toBe('limit');
  });

  it('is blocked when only spec change findings are open, and done with none', () => {
    expect(decide({ open: [open('R1-1', 'yes')], codeCheckPass: true, round: 3, chain: 1, chainBase: 0, chainRounds: 3, rounds: 3 })).toBe('blocked');
    expect(decide({ open: [], codeCheckPass: true, round: 1, chain: 1, chainBase: 0, chainRounds: 1, rounds: 3 })).toBe('done');
    expect(decide({ open: [], codeCheckPass: false, round: 1, chain: 1, chainBase: 0, chainRounds: 1, rounds: 3 })).toBe('fix');
  });
});

describe('checkContinue', () => {
  const last = (judged: boolean, result: RoundState['result']): RoundState => ({ judged, result }) as unknown as RoundState;

  it('takes --continue after limit and while the round it started is not judged (a run started again), and refuses it otherwise', () => {
    expect(() => { checkContinue('t', last(true, 'limit'), true); }).not.toThrow();
    expect(() => { checkContinue('t', last(false, null), true); }).not.toThrow();
    expect(() => { checkContinue('t', last(true, 'done'), true); }).toThrow('--continue needs the last round of t to be limit');
    expect(() => { checkContinue('t', undefined, true); }).toThrow('--continue needs the last round of t to be limit');
    expect(() => { checkContinue('t', last(true, 'done'), false); }).not.toThrow();
  });
});

describe('fixBase', () => {
  const round = (result: RoundState['result'], aspects: string[], proof: { result: string; base: string } | null = null): RoundState =>
    ({
      result,
      startCommit: 'c1',
      open: aspects.map((aspect, i) => ({ id: `R1-${String(i + 1)}`, aspect, severity: 'medium', location: 'a.ts:1', specChange: 'no' })),
      codeCheck: proof === null ? [] : [{ name: 'fix test proof', result: proof.result, failures: [] }],
      fixBase: proof?.base ?? null,
    }) as unknown as RoundState;

  it('proves the fix of a behavior finding, not of a finding that keeps the behavior', () => {
    expect(fixBase(round('fix', ['efficiency', 'correctness']))).toBe('c1');
    expect(fixBase(round('escalate', ['spec']))).toBe('c1');
    // a test evidence fix adds tests to code that already behaves: no proof
    expect(fixBase(round('fix', ['test evidence']))).toBeNull();
    // after `limit` a `--continue` round follows the fix the human chose; a `--respec` round follows no fix
    expect(fixBase(round('limit', ['security']), [], true)).toBe('c1');
    expect(fixBase(round('limit', ['security']))).toBeNull();
    expect(fixBase(round('fix', ['efficiency', 'structure']))).toBeNull();
    // a spec change finding is not fixed
    const specOnly = round('fix', ['correctness']);
    (specOnly.open[0] as { specChange: string }).specChange = 'yes';
    expect(fixBase(specOnly)).toBeNull();
    expect(fixBase(round('done', []))).toBeNull();
    expect(fixBase(undefined)).toBeNull();
  });

  it('proves again on the same base after a failed proof, until the fix\'s tests fail there', () => {
    expect(fixBase(round('fix', [], { result: 'fail', base: 'c0' }))).toBe('c0');
    expect(fixBase(round('fix', ['correctness'], { result: 'fail', base: 'c0' }))).toBe('c0');
    expect(fixBase(round('fix', [], { result: 'pass', base: 'c0' }))).toBeNull();
    expect(fixBase(round('fix', [], { result: 'unknown', base: 'c0' }))).toBeNull();
    // the round the failed proof proves: again only when it had a behavior finding
    const proved = (aspects: string[]): RoundState => ({ ...round('fix', aspects), startCommit: 'c0' });
    expect(fixBase(round('fix', [], { result: 'fail', base: 'c0' }), [proved(['test evidence', 'structure'])])).toBeNull();
    expect(fixBase(round('fix', [], { result: 'fail', base: 'c0' }), [proved(['correctness'])])).toBe('c0');
    // two rounds failed on that base: it is not asked again, since no test fails on code that already behaved
    const failed = { ...round('fix', [], { result: 'fail', base: 'c0' }), startCommit: 'c2' };
    const last = { ...round('fix', [], { result: 'fail', base: 'c0' }), startCommit: 'c3' };
    expect(fixBase(last, [proved(['correctness']), failed, last])).toBeNull();
    expect(fixBase({ ...last, open: proved(['correctness']).open }, [proved(['correctness']), failed, last])).toBe('c3');
  });
});

describe('ogw review: core', () => {
  it('merges the review file into main, writes the core agent fix input, and needs that agent merged', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([], ['| R1-1 | fixed | ok |']) });
    const started = await next(ws, ['core', 'routing'], env);
    expect(started.code).toBe(0);
    const fix = await wait(ws, ['core', 'routing']);
    const dir = join(ws.coreImpl, '.git', 'ogw-review', 'routing');
    const fixInput = join(dir, 'round-1-fix.md');
    expect(fix.stdout).toBe(`result: fix\nround: 1\nopen finding: R1-1 correctness high src/a.ts:3 spec change: no\nfix input: ${fixInput}\n`);
    const reviewPath = join(ws.coreImpl, 'records/review/routing-1.md');
    expect(readFileSync(reviewPath, 'utf8')).toContain('R1-1');
    expect(readFileSync(fixInput, 'utf8')).toBe(
      `command: review fix\n- target: routing\n- review file: ${reviewPath}\n- code check result: ${join(dir, 'round-1-code-check.json')}\n- open finding: R1-1 correctness high src/a.ts:3 spec change: no\n`,
    );
    const input = readFileSync(join(dir, 'round-1-input.md'), 'utf8');
    expect(input).toContain(`- ${join(ws.harness, 'skills/server-core/modules/routing.md')}\n- ${join(ws.harness, 'skills/core/SKILL.md')}\n- ${join(ws.harness, 'skills/core/command.md')}\n- ${join(ws.harness, 'skills/server-core/SKILL.md')}\n`);

    const blocked = await next(ws, ['core', 'routing'], env);
    expect(blocked.stderr).toContain(`the core agent job of fix input ${fixInput} has not been merged with ogw agent merge`);
    const coreAgent = fakeAgentCli(ws, "fs.writeFileSync('fixed.txt', 'y'); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'fix', '--no-verify']); fs.writeFileSync(output, 'report'); " + CORE_TEST_PASSED);
    const job = (await ogw(ws, ['agent', 'core', '--input', fixInput, '--background'], { env: coreAgent.env })).stdout.trim();
    await ogw(ws, ['agent', 'wait', job, '--timeout', '60000']);
    expect((await ogw(ws, ['agent', 'merge', job])).code).toBe(0);
    const meta = (await readJob(job, ws.env)).meta as { output: string; outputRel: string };
    expect(existsSync(meta.output)).toBe(false);
    const report = join(ws.coreImpl, meta.outputRel);
    expect(readFileSync(report, 'utf8')).toBe('report');
    const mainAfterFix = sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim();
    const round1Start = (JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { rounds: { startCommit: string }[] }).rounds[0]?.startCommit as string;
    expect(mainAfterFix).not.toBe(round1Start);
    const round2 = await next(ws, ['core', 'routing'], reviewer(ws, { 2: reviewFile([], ['| R1-1 | fixed | ok |']) }));
    expect(round2.stdout).toContain('round: 2');
    const input2 = readFileSync(join(dir, 'round-2-input.md'), 'utf8');
    expect(input2).toContain(`## commit range\n\n${round1Start}..${mainAfterFix}\n`);
    expect(input2).toContain(`## core agent reports\n\n- ${report}\n`);
    expect((JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { rounds: { fixJobs?: string[] }[] }).rounds[0]?.fixJobs).toEqual([job]);
    expect((await wait(ws, ['core', 'routing'])).stdout).toBe('result: done\nround: 2\n');
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    expect(await lastReviewResults(ctx, 'core')).toEqual(new Map([['routing', 'done']]));
    await clearReviews(ctx, 'core');
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(reviewPath)).toBe(true);
  });

  it('merges the review file without waiting for core test runs on the main checkout', async () => {
    const ws = makeWorkspace();
    await next(ws, ['core', 'routing'], reviewer(ws, { 1: reviewFile([]) }));
    const reader = await testAtHead(ws.coreImpl, ws.coreImpl, ws.env, () => Promise.resolve());
    try {
      expect((await wait(ws, ['core', 'routing'])).stdout).toBe('result: done\nround: 1\n');
    } finally {
      await reader.release();
    }
  });

  it('takes a merged retry of the fix job as the fix and records the merged job ids in the round state', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([], ['| R1-1 | fixed | ok |']) });
    await next(ws, ['core', 'routing'], env);
    await wait(ws, ['core', 'routing']);
    const dir = join(ws.coreImpl, '.git', 'ogw-review', 'routing');
    const fixInput = join(dir, 'round-1-fix.md');
    const coreAgent = fakeAgentCli(
      ws,
      "if (input.includes('-retry-')) { fs.writeFileSync('fixed.txt', 'y'); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'fix', '--no-verify']); fs.writeFileSync(output, 'retry report'); " + CORE_TEST_PASSED + ' }',
    );
    const first = (await ogw(ws, ['agent', 'core', '--input', fixInput, '--background'], { env: coreAgent.env })).stdout.trim();
    await ogw(ws, ['agent', 'wait', first, '--timeout', '60000']);
    const retried = await ogw(ws, ['agent', 'retry', first, '--background'], { env: coreAgent.env });
    expect(retried.code).toBe(0);
    const retry = retried.stdout.trim();
    await ogw(ws, ['agent', 'wait', retry, '--timeout', '60000']);
    expect((await ogw(ws, ['agent', 'merge', retry])).code).toBe(0);
    const report = join(ws.coreImpl, ((await readJob(retry, ws.env)).meta as { outputRel: string }).outputRel);
    const round2 = await next(ws, ['core', 'routing'], env);
    expect(round2.code).toBe(0);
    expect(round2.stdout).toContain('round: 2');
    expect(readFileSync(join(dir, 'round-2-input.md'), 'utf8')).toContain(`## core agent reports\n\n- ${report}\n`);
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { rounds: { fixInput: string | null; fixJobs?: string[] }[] };
    expect(state.rounds[0]).toMatchObject({ fixInput, fixJobs: [retry] });
    expect(state.rounds[1]?.fixJobs).toBeUndefined();
    await wait(ws, ['core', 'routing']);
  });

  it('does not count type check and lint failures in files outside the target, and gives each as a code check fail outside target line', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'server', 'core', 'storage'), { recursive: true });
    mkdirSync(join(ws.coreImpl, 'server', 'core', 'routing'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'package.json'), '{"type": "module"}\n');
    writeFileSync(join(ws.coreImpl, 'server', 'package-lock.json'), '{"lockfileVersion": 3, "requires": true, "packages": {"": {}}}\n');
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'storage', 'index.ts'), "export const s: number = 'text';\n");
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), 'export const r = 1;\n');
    commitAll(ws.coreImpl, 'a type check failure of storage');
    const line = "server/core/storage/index.ts:1:14 TS2322 Type 'string' is not assignable to type 'number'.";
    await next(ws, ['core', 'routing'], reviewer(ws, { 1: reviewFile([]) }));
    const routing = await wait(ws, ['core', 'routing']);
    expect(routing.stdout).toMatch(/^result: done\nround: 1\n/);
    expect(routing.stdout).toContain(`code check fail outside target: ${line}\n`);
    expect(routing.stdout).not.toContain('code check fail: type check');
    // the same failure in the target's own folder is a code check fail
    await next(ws, ['core', 'storage'], reviewer(ws, { 1: reviewFile([]) }));
    const storage = await wait(ws, ['core', 'storage']);
    expect(storage.stdout).toMatch(/^result: fix\nround: 1\n/);
    expect(storage.stdout).toContain(`code check fail: type check\n  ${line}\n`);
    expect(storage.stdout).not.toContain('code check fail outside target:');
  });

  /** Server code on main of `open-game-works-core-impl/` where storage, outside the target routing, fails the type check; `routing` is routing's index.ts. */
  function storageFails(ws: TestWorkspace, routing: string): void {
    mkdirSync(join(ws.coreImpl, 'server', 'core', 'storage'), { recursive: true });
    mkdirSync(join(ws.coreImpl, 'server', 'core', 'routing'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'package.json'), '{"type": "module"}\n');
    writeFileSync(join(ws.coreImpl, 'server', 'package-lock.json'), '{"lockfileVersion": 3, "requires": true, "packages": {"": {}}}\n');
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'storage', 'index.ts'), "export const s: number = 'text';\n");
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), routing);
    commitAll(ws.coreImpl, 'server code');
  }

  /** The type check item of the code check result file that the fix input of the round's `ogw review wait` output gives. */
  function fixInputTypeCheck(waited: string): { result: string; failures: string[] } | undefined {
    const fixInput = /^fix input: (.+)$/m.exec(waited)?.[1] as string;
    const resultFile = /^- code check result: (.+)$/m.exec(readFileSync(fixInput, 'utf8'))?.[1] as string;
    const checks = (JSON.parse(readFileSync(resultFile, 'utf8')) as { checks: { name: string; result: string; failures: string[] }[] }).checks;
    return checks.find((c) => c.name === 'type check');
  }

  it('gives the core agent a code check result with only the failures that count', async () => {
    const ws = makeWorkspace();
    storageFails(ws, "export const r: number = 'text';\n");
    await next(ws, ['core', 'routing'], reviewer(ws, { 1: reviewFile([finding('R1-1', 'no')]) }));
    const waited = (await wait(ws, ['core', 'routing'])).stdout;
    expect(waited).toMatch(/^result: fix\n/);
    expect(waited).toContain('code check fail outside target: server/core/storage/index.ts:1:14 TS2322 ');
    expect(fixInputTypeCheck(waited)).toEqual({ name: 'type check', result: 'fail', failures: ["server/core/routing/index.ts:1:14 TS2322 Type 'string' is not assignable to type 'number'."], durationMs: expect.any(Number) as number });
  });

  it('gives a check whose only failures are outside the target as a pass in the code check result of the fix input', async () => {
    const ws = makeWorkspace();
    storageFails(ws, 'export const r = 1;\n');
    await next(ws, ['core', 'routing'], reviewer(ws, { 1: reviewFile([finding('R1-1', 'no')]) }));
    const waited = (await wait(ws, ['core', 'routing'])).stdout;
    expect(waited).toMatch(/^result: fix\n/);
    expect(fixInputTypeCheck(waited)).toMatchObject({ result: 'pass', failures: [] });
  });

  it('starts a core round at main whatever the checkout holds, and runs the code check on that commit', async () => {
    const ws = makeWorkspace();
    const older = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(ws.coreImpl, 'newer.txt'), 'x');
    const main = commitAll(ws.coreImpl, 'newer');
    sh(ws.coreImpl, 'git', ['checkout', '-q', '--detach', older]);
    writeFileSync(join(ws.coreImpl, 'untracked.ts'), "export const x: number = 'text';\n");
    const env = reviewer(ws, { 1: reviewFile([]) });
    const started = await next(ws, ['core', 'routing'], env);
    expect(started.code).toBe(0);
    const state = JSON.parse(readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'state.json'), 'utf8')) as {
      rounds: { startCommit: string; reviewJob: string; codeCheckJob: string }[];
    };
    const round = state.rounds[0];
    expect(round?.startCommit).toBe(main);
    expect(((await readJob(round?.reviewJob as string, ws.env)).meta as { place: { baseCommit: string } }).place.baseCommit).toBe(main);
    expect((await readJob(round?.codeCheckJob as string, ws.env)).argv).toEqual(['code', 'check', 'core', '--commit', main, '--json']);
    // another target's fix merged into main while this round's code check runs
    rmSync(join(ws.coreImpl, 'untracked.ts'));
    sh(ws.coreImpl, 'git', ['checkout', '-q', 'main']);
    writeFileSync(join(ws.coreImpl, 'merged.ts'), "export const y: number = 'text';\n");
    commitAll(ws.coreImpl, 'merged fix of another target');
    expect((await wait(ws, ['core', 'routing'])).stdout).toBe('result: done\nround: 1\n');
  });

  it('does not take an earlier review file of the same name on main as the new round\'s result', async () => {
    const ws = makeWorkspace();
    await next(ws, ['core', 'routing'], reviewer(ws, { 1: reviewFile([]) }));
    expect((await wait(ws, ['core', 'routing'])).stdout).toBe('result: done\nround: 1\n');
    expect(existsSync(join(ws.coreImpl, 'records/review/routing-1.md'))).toBe(true);
    changeDefinition(ws);
    await next(ws, ['core', 'routing', '--restart'], reviewer(ws, {}));
    expect(await wait(ws, ['core', 'routing'])).toMatchObject({ code: 1, stdout: 'result: invalid\nround: 1\n' });
  });

  it('goes on after a definition change with --respec: a round of a new chain whose input has the definition diff', async () => {
    const ws = makeWorkspace();
    await next(ws, ['core', 'routing'], reviewer(ws, { 1: reviewFile([finding('R1-1', 'yes')]) }));
    expect((await wait(ws, ['core', 'routing'])).stdout).toContain('result: blocked\nround: 1\n');
    // no definition changed yet: refused
    expect((await next(ws, ['core', 'routing', '--respec'], reviewer(ws, {}))).stderr).toContain('--respec of routing: no definition document changed');
    changeDefinition(ws);
    const started = await next(ws, ['core', 'routing', '--respec'], reviewer(ws, { 2: reviewFile([], ['| R1-1 | fixed | spec changed |']) }));
    expect(started.stdout).toMatch(/^round: 2\n/);
    const dir = join(ws.coreImpl, '.git', 'ogw-review', 'routing');
    const input = readFileSync(join(dir, 'round-2-input.md'), 'utf8');
    expect(input).toContain(`## spec changes\n\n${join(dir, 'round-2-spec-changes.diff')}\n`);
    expect(readFileSync(join(dir, 'round-2-spec-changes.diff'), 'utf8')).toMatch(/^diff --git /);
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { rounds: { chain?: number; harnessCommit?: string; startCommit: string }[] };
    expect(state.rounds.map((r) => r.chain)).toEqual([1, 2]);
    expect(typeof state.rounds[1]?.harnessCommit).toBe('string');
    // the range: the code changes since the last round started
    expect(input).toContain(`## commit range\n\n${state.rounds[0]?.startCommit as string}..${state.rounds[1]?.startCommit as string}\n`);
    expect((await wait(ws, ['core', 'routing'])).stdout).toBe('result: done\nround: 2\n');
  });

  it('fixes a spec change finding still open after a --respec round as a code finding', async () => {
    const ws = makeWorkspace();
    await next(ws, ['core', 'routing'], reviewer(ws, { 1: reviewFile([finding('R1-1', 'yes')]) }));
    expect((await wait(ws, ['core', 'routing'])).stdout).toContain('result: blocked\nround: 1\n');
    changeDefinition(ws);
    await next(ws, ['core', 'routing', '--respec'], reviewer(ws, { 2: reviewFile([], ['| R1-1 | open | the code still differs from the changed spec |']) }));
    // the core agent gets it: a fix input, not blocked, whose line tells the core agent it is spec change no
    expect((await wait(ws, ['core', 'routing'])).stdout).toMatch(/^result: fix\nround: 2\nopen finding: R1-1 correctness high src\/a\.ts:3 spec change: no\nfix input: .*round-2-fix\.md\n$/);
    const fixInput = join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'round-2-fix.md');
    expect(readFileSync(fixInput, 'utf8')).toContain('\n- open finding: R1-1 correctness high src/a.ts:3 spec change: no\n');
  });

  it('counts the fixes of a finding converted by --respec from the --respec round: fix, then limit only after a second fix', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([finding('R1-1', 'yes')]) });
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toContain('result: blocked\nround: 1\n');
    changeDefinition(ws);
    const still = reviewFile([], ['| R1-1 | open | the code still differs |']);
    const results: string[] = [];
    for (const [round, option] of [[2, ['--respec']], [3, []], [4, []]] as const) {
      await next(ws, ['tool', 'agent', 'merge', ...option, ...mergeDefinitions(ws)], reviewer(ws, { [round]: still }));
      results.push(/^result: (\w+)/.exec((await wait(ws, ['tool', 'agent', 'merge'])).stdout)?.[1] ?? '');
    }
    expect(results).toEqual(['fix', 'fix', 'limit']);
  });

  it('counts no fix before a --respec round that follows a limit round', async () => {
    const ws = makeWorkspace();
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, { 1: reviewFile([finding('R1-1', 'no'), finding('R1-2', 'yes')]) }));
    await wait(ws, ['tool', 'agent', 'merge']);
    const statePath = join(ws.harness, '.git', 'ogw-review', 'agent merge', 'state.json');
    const limited = JSON.parse(readFileSync(statePath, 'utf8')) as { rounds: { result: string }[] };
    (limited.rounds[0] as { result: string }).result = 'limit';
    writeFileSync(statePath, JSON.stringify(limited));
    changeDefinition(ws);
    const still = reviewFile([], ['| R1-1 | open | not fixed |', '| R1-2 | open | not fixed |']);
    const results: string[] = [];
    for (const [round, option] of [[2, ['--respec']], [3, []], [4, []]] as const) {
      await next(ws, ['tool', 'agent', 'merge', ...option, ...mergeDefinitions(ws)], reviewer(ws, { [round]: still }));
      results.push(/^result: (\w+)/.exec((await wait(ws, ['tool', 'agent', 'merge'])).stdout)?.[1] ?? '');
    }
    expect(results).toEqual(['fix', 'fix', 'limit']);
  });

  it('counts the fix before a --respec round that follows a fix round', async () => {
    const ws = makeWorkspace();
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, { 1: reviewFile([finding('R1-1', 'no'), finding('R1-2', 'yes')]) }));
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toContain('result: fix\nround: 1\n');
    changeDefinition(ws);
    const still = reviewFile([], ['| R1-1 | open | not fixed |', '| R1-2 | fixed | spec changed |']);
    const results: string[] = [];
    for (const [round, option] of [[2, ['--respec']], [3, []]] as const) {
      await next(ws, ['tool', 'agent', 'merge', ...option, ...mergeDefinitions(ws)], reviewer(ws, { [round]: still }));
      results.push(/^result: (\w+)/.exec((await wait(ws, ['tool', 'agent', 'merge'])).stdout)?.[1] ?? '');
    }
    // R1-1 is still open after the fixes after rounds 1 and 2
    expect(results).toEqual(['fix', 'limit']);
  });

  it('starts a --respec round again after it was judged invalid, without the option given again', async () => {
    const ws = makeWorkspace();
    await next(ws, ['core', 'routing'], reviewer(ws, { 1: reviewFile([finding('R1-1', 'yes')]) }));
    expect((await wait(ws, ['core', 'routing'])).stdout).toContain('result: blocked\nround: 1\n');
    changeDefinition(ws);
    await next(ws, ['core', 'routing', '--respec'], reviewer(ws, {}));
    expect((await wait(ws, ['core', 'routing'])).stdout).toBe('result: invalid\nround: 2\n');
    const dir = join(ws.coreImpl, '.git', 'ogw-review', 'routing');
    const statePath = join(dir, 'state.json');
    expect((JSON.parse(readFileSync(statePath, 'utf8')) as { respecAfter?: number }).respecAfter).toBe(1);
    const again = await next(ws, ['core', 'routing'], reviewer(ws, { 2: reviewFile([], ['| R1-1 | fixed | spec changed |']) }));
    expect(again.stdout).toMatch(/^round: 2\n/);
    expect(readFileSync(join(dir, 'round-2-input.md'), 'utf8')).toContain(`## spec changes\n\n${join(dir, 'round-2-spec-changes.diff')}\n`);
    expect((await wait(ws, ['core', 'routing'])).stdout).toBe('result: done\nround: 2\n');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { respecAfter?: number; rounds: { chain?: number }[] };
    expect(state.rounds.map((r) => r.chain)).toEqual([1, 2]);
    expect(state.respecAfter).toBeUndefined();
  });

  it('refuses --respec after a round that kept no harness commit, naming --restart', async () => {
    const ws = makeWorkspace();
    await next(ws, ['core', 'routing'], reviewer(ws, { 1: reviewFile([finding('R1-1', 'yes')]) }));
    await wait(ws, ['core', 'routing']);
    const statePath = join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { rounds: Record<string, unknown>[] };
    delete state.rounds[0]?.harnessCommit;
    writeFileSync(statePath, JSON.stringify(state));
    changeDefinition(ws);
    const refused = await next(ws, ['core', 'routing', '--respec'], reviewer(ws, {}));
    expect(refused).toMatchObject({ code: 1 });
    expect(refused.stderr).toContain('--respec of routing: round 1 kept no harness commit; use --restart');
    expect((JSON.parse(readFileSync(statePath, 'utf8')) as { rounds: unknown[] }).rounds).toHaveLength(1);
  });

  it('names why the review job was not merged when it drops the round', async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws.coreImpl, 'tracked.txt'), 'committed\n');
    commitAll(ws.coreImpl, 'tracked');
    // an earlier series left a review file of the same name on main
    await next(ws, ['core', 'routing'], reviewer(ws, { 1: reviewFile([]) }));
    expect((await wait(ws, ['core', 'routing'])).stdout).toBe('result: done\nround: 1\n');
    changeDefinition(ws);
    await next(ws, ['core', 'routing', '--restart'], reviewer(ws, { 1: reviewFile([]) }));
    writeFileSync(join(ws.coreImpl, 'tracked.txt'), 'changed\n');
    const invalid = await wait(ws, ['core', 'routing']);
    expect(invalid.code).toBe(1);
    expect(invalid.stdout).toMatch(/^result: invalid\nround: 1\nreview job not merged: uncommitted changes: /);
  });

  it('lists dependency specs from core-spec/, client definitions per engine, and the tool definitions', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'core-spec'));
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'core-spec', 'LogCore.json'), JSON.stringify({ name: 'LogCore', dependencies: ['UtilCore', 'EventCore'] }));
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), JSON.stringify({ godot: '4.5.1.stable' }));
    commitAll(ws.coreImpl, 'spec');
    const env = reviewer(ws, { 1: reviewFile([]) });
    const skill = (path: string): string => join(ws.harness, 'skills', path);
    const inputOf = (target: string): string => readFileSync(join(ws.coreImpl, '.git', 'ogw-review', target, 'round-1-input.md'), 'utf8');
    const cases: [string, string[]][] = [
      ['LogCore', ['client-core/modules/log-core.md', 'client-core/modules/util-core.md', 'client-core/modules/event-core.md', 'core/SKILL.md', 'core/command.md', 'client-core/SKILL.md', 'client-core/engines/godot.md']],
      ['contract-tool', ['contract/SKILL.md', 'contract/tool.md']],
      ['data-tool', ['data/SKILL.md', 'data/tool.md']],
    ];
    for (const [target, paths] of cases) {
      expect((await next(ws, ['core', target], env)).code).toBe(0);
      expect(inputOf(target)).toContain(`## definition\n\n${paths.map((path) => `- ${skill(path)}`).join('\n')}\n\n`);
      expect((await wait(ws, ['core', target])).stdout).toMatch(/^result: (done|fix)\nround: 1\n/);
    }
  });
});

describe('ogw review spec', () => {
  it('starts one review agent with the module\'s definition documents in a spec input, and wait gives its result file', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([finding('R1-1', 'yes')]) });
    const started = await ogw(ws, ['review', 'spec', 'core', 'routing', '--full'], { env });
    expect(started.code).toBe(0);
    const id = started.stdout.trim();
    const job = await readJob(id, ws.env);
    const input = readFileSync((job.meta as { input: string }).input, 'utf8');
    expect(input).toMatch(/^# review input\n\n- side: spec\n- target: routing\n- round: 1\n\n## definition\n\n- /);
    expect(input).toContain(join(ws.harness, 'skills', 'server-core', 'modules', 'routing.md'));
    expect(input).toContain(join(ws.harness, 'skills', 'core', 'command.md'));
    const waited = await ogw(ws, ['agent', 'wait', id, '--timeout', '60000']);
    expect(waited.code).toBe(0);
    const result = waited.stdout.trim();
    expect(result.endsWith('/spec-routing.md')).toBe(true);
    expect(readFileSync(result, 'utf8')).toContain('| R1-1 |');
  });

  it('lists the dependency specs the harness spec names, which core-spec/ on main does not have, and writes the input in an owner-only ogw-temp folder', async () => {
    const ws = makeWorkspace();
    expect(existsSync(join(ws.coreImpl, 'core-spec'))).toBe(false);
    const started = await ogw(ws, ['review', 'spec', 'core', 'mailbox', '--full'], { env: reviewer(ws, { 1: reviewFile([]) }) });
    expect(started.code).toBe(0);
    const id = started.stdout.trim();
    const inputPath = ((await readJob(id, ws.env)).meta as { input: string }).input;
    const input = readFileSync(inputPath, 'utf8');
    // `## dependency` of the mailbox spec
    for (const dep of ['item-ledger', 'storage', 'server-time', 'logging']) expect(input).toContain(`- ${join(ws.harness, 'skills', 'server-core', 'modules', `${dep}.md`)}\n`);
    expect(dirname(dirname(inputPath))).toBe(join(ws.harness, '.git', 'ogw-temp'));
    expect(basename(dirname(inputPath))).toMatch(/^ogw-review-spec-/);
    expect(statSync(dirname(inputPath)).mode & 0o777).toBe(0o700);
    await ogw(ws, ['agent', 'wait', id, '--timeout', '60000']);
  });

  it('takes one core module', async () => {
    const ws = makeWorkspace();
    expect((await ogw(ws, ['review', 'spec', 'tool', 'routing', '--full'])).stderr).toContain('usage: ogw review spec core <module>');
    expect((await ogw(ws, ['review', 'spec', 'core', 'data-tool', '--full'])).stderr).toContain('usage: ogw review spec core <module>');
    expect((await ogw(ws, ['review', 'spec', 'core', 'nope', '--full'])).stderr).toContain('unknown core review target: nope');
  });
});
