import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jobsDir, listJobs } from '../../../src/lib/jobs.ts';
import type * as Jobs from '../../../src/lib/jobs.ts';
import type { StepLine } from '../../../src/lib/spans.ts';
import { ogw, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { writeJob } from '../job/helpers.ts';
import { agents, coreSpec, finding, GOOD_FIX, implementServer, reviewFile, spec, toolsChange } from './helpers.ts';

/**
 * The `ogw core test` jobs of `ogw review run`, faked in this process: after the fix (in the core main checkout)
 * `routing` passes and `mailbox` fails, or the next of `mainOutputs` is the output; before the fix (in another checkout)
 * `mailbox` fails when `failsBeforeFix`, or when that checkout has the file `brokenBy`. Each run records its argv, its
 * checkout, that checkout's HEAD, the number of rounds in the review state of `routing` when it started and the step
 * span it started in.
 */
const fake = vi.hoisted(() => ({
  coreImpl: '',
  failsBeforeFix: true,
  brokenBy: null as string | null,
  /** A file committed to the core main checkout just before the first core test there: a merge after the fix merge. */
  landsBeforeTest: null as string | null,
  /** The index of a run that stops before its tests (`{ error }`). */
  errorAtRun: null as number | null,
  /** The outputs of the next core test runs in the core main checkout, in order; exit code 1 unless every module passes. */
  mainOutputs: [] as { modules: Record<string, string>; failures: Record<string, string[]>; unknown?: Record<string, string> }[],
  runs: [] as { argv: string[]; cwd: string; head: string; rounds: number; span: string | null }[],
  results: new Map<string, Jobs.WaitResult>(),
}));

vi.mock('../../../src/lib/jobs.ts', async (importOriginal) => {
  const original = await importOriginal<typeof Jobs>();
  const { spanContext } = await import('../../../src/lib/spans.ts');
  /** The number of rounds in the review state of `routing`. */
  const rounds = (): number => {
    const state = join(fake.coreImpl, '.git', 'ogw-review', 'routing', 'state.json');
    return existsSync(state) ? (JSON.parse(readFileSync(state, 'utf8')) as { rounds: unknown[] }).rounds.length : 0;
  };
  /** The output and exit code of the run at `index` in the checkout `cwd`. */
  const output = (cwd: string, index: number): { stdout: string; exitCode: number } => {
    const queued = cwd === fake.coreImpl ? fake.mainOutputs.shift() : undefined;
    if (queued !== undefined) return { stdout: JSON.stringify(queued), exitCode: Object.values(queued.modules).every((result) => result === 'pass') ? 0 : 1 };
    const modules = cwd === fake.coreImpl ? { routing: 'pass', mailbox: 'fail' } : { mailbox: fake.failsBeforeFix || (fake.brokenBy !== null && existsSync(join(cwd, fake.brokenBy))) ? 'fail' : 'pass' };
    const stopped = index === fake.errorAtRun;
    const failed = modules.mailbox === 'fail' || stopped;
    const stdout = stopped
      ? JSON.stringify({ error: 'godot not found', tests: 1, passed: 0 })
      : JSON.stringify({ modules, failures: failed ? { mailbox: ['sqlite run: mail.test.ts broke'] } : {} });
    return { stdout, exitCode: failed ? 1 : 0 };
  };
  return {
    ...original,
    startJob: (options: Jobs.StartJobOptions): Promise<string> => {
      if (options.command !== 'core test') return original.startJob(options);
      const id = `fakecoretest${String(fake.runs.length)}`;
      if (options.cwd === fake.coreImpl && fake.landsBeforeTest !== null) {
        writeFileSync(join(fake.coreImpl, fake.landsBeforeTest), 'x');
        execFileSync('git', ['-C', fake.coreImpl, 'add', fake.landsBeforeTest]);
        execFileSync('git', ['-C', fake.coreImpl, 'commit', '-qm', 'another merge', '--no-verify']);
        fake.landsBeforeTest = null;
      }
      const head = execFileSync('git', ['-C', options.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      fake.runs.push({ argv: options.argv, cwd: options.cwd, head, rounds: rounds(), span: spanContext()?.span ?? null });
      const { stdout, exitCode } = output(options.cwd, fake.runs.length - 1);
      fake.results.set(id, { job: { id, status: 'done', exitCode } as Jobs.JobRecord, finished: true, stdout, stderr: '' });
      return Promise.resolve(id);
    },
    waitJob: (id: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<Jobs.WaitResult> => {
      const result = fake.results.get(id);
      return result === undefined ? original.waitJob(id, timeoutMs, env) : Promise.resolve(result);
    },
  };
});

/** A target `routing` whose implemented dependent `mailbox` fails its core test after the fix of round 1. */
function workspace(failsBeforeFix: boolean): TestWorkspace {
  const ws = makeWorkspace();
  fake.coreImpl = ws.coreImpl;
  fake.failsBeforeFix = failsBeforeFix;
  fake.brokenBy = null;
  fake.landsBeforeTest = null;
  fake.errorAtRun = null;
  fake.mainOutputs = [];
  coreSpec(ws, { routing: spec('routing', 'server'), mailbox: spec('mailbox', 'server', ['routing']) });
  implementServer(ws, ['routing', 'mailbox']);
  return ws;
}

const FILES = { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([], ['| R1-1 | fixed | ok |']) };
const AFTER = ['core', 'test', 'server', 'mailbox', 'routing', '--json'];
const MAILBOX_LINES = ['ogw core test server mailbox routing: mailbox fail', '  sqlite run: mail.test.ts broke'];

/** The merge commit of the fix of `routing` on main: the first-parent commit that brought `fixed.txt`. */
function fixMergeOf(ws: TestWorkspace): string {
  return execFileSync('git', ['-C', ws.coreImpl, 'log', 'main', '--first-parent', '-1', '--format=%H', '--', 'fixed.txt'], { encoding: 'utf8' }).trim();
}

/** main just before the fix of `routing` was merged: the first parent of its merge commit. */
function beforeMerge(ws: TestWorkspace): string {
  return execFileSync('git', ['-C', ws.coreImpl, 'rev-parse', `${fixMergeOf(ws)}^1`], { encoding: 'utf8' }).trim();
}

function roundStart(ws: TestWorkspace, round: number): string {
  const state = JSON.parse(readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'state.json'), 'utf8')) as { rounds: { startCommit: string }[] };
  return state.rounds[round - 1]?.startCommit as string;
}

describe('ogw review run: core tests of the dependents after a fix', () => {
  beforeEach(() => {
    fake.runs.length = 0;
    fake.results.clear();
  });

  it('runs a failing dependent again at main before the fix merge, and reports it as pre-existing when it fails there too', async () => {
    const ws = workspace(true);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: agents(ws, FILES, GOOD_FIX).env });
    expect(run).toMatchObject({ code: 0, stdout: ['result: done', 'round: 2', ...MAILBOX_LINES.map((line) => `pre-existing test fail: ${line}`), ''].join('\n') });
    expect(fake.runs.map((r) => r.argv)).toEqual([AFTER, ['core', 'test', 'server', 'mailbox', '--json']]);
    // the run before the fix: a worktree of main before the fix merge under `worktrees/_core/`, removed after the run
    const before = fake.runs[1];
    expect(before?.head).toBe(beforeMerge(ws));
    expect(before?.cwd.startsWith(join(ws.worktrees, '_core', 'before-'))).toBe(true);
    expect(existsSync(before?.cwd as string)).toBe(false);
  });

  it('starts the jobs of a step in the step span that waits for them, through a fix round to the next round', async () => {
    const ws = workspace(false);
    fake.mainOutputs = [{ modules: { routing: 'pass', mailbox: 'pass' }, failures: {} }];
    const jobs = await jobsDir(ws.env);
    mkdirSync(jobs, { recursive: true });
    writeJob(jobs, { id: 'rs1', command: 'review run', argv: ['review', 'run', 'core', 'routing'] });
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: { ...agents(ws, FILES, GOOD_FIX).env, OGW_JOB_ID: 'rs1' } });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    const steps = readFileSync(join(jobs, 'rs1.spans.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as StepLine).filter((line) => line.end !== null);
    const ids = (name: string): string[] => steps.filter((line) => line.name === name).sort((a, b) => a.start - b.start).map((line) => line.id);
    const children = (await listJobs(ws.env)).filter((job) => job.parentJob === 'rs1').sort((a, b) => a.startedAt - b.startedAt);
    const spansOf = (pick: (job: Jobs.JobRecord) => boolean): (string | null | undefined)[] => children.filter(pick).map((job) => job.parentSpan);
    // each round's review agent and code check in its `review round`, the core agent in `fix`, the core tests in `fix core tests`
    expect(ids('review round')).toHaveLength(2);
    expect(spansOf((job) => job.command === 'agent' && job.meta.role === 'review')).toEqual(ids('review round'));
    expect(spansOf((job) => job.command === 'code check')).toEqual(ids('review round'));
    expect(spansOf((job) => job.command === 'agent' && job.meta.role === 'core')).toEqual(ids('fix'));
    expect(fake.runs.map((r) => [r.argv, r.span])).toEqual([[AFTER, ids('fix core tests')[0]]]);
  });

  it('stops at test fail when the failing dependent passes at main before the fix merge', async () => {
    const ws = workspace(false);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: agents(ws, FILES, GOOD_FIX).env });
    expect(run).toMatchObject({ code: 1, stdout: ['result: test fail', 'round: 1', 'open finding: R1-1 correctness high src/a.ts:3 spec change: no', ...MAILBOX_LINES, ''].join('\n') });
    expect(fake.runs[1]?.head).toBe(beforeMerge(ws));
  });

  it('does not stop for a dependent that another merge broke after the round started', async () => {
    const ws = workspace(false);
    fake.brokenBy = 'other.txt';
    // while the core agent works, another module's fix lands on main and breaks mailbox
    const other = `fs.writeFileSync(${JSON.stringify(join(ws.coreImpl, 'other.txt'))}, 'x'); execFileSync('git', ['-C', ${JSON.stringify(ws.coreImpl)}, 'add', 'other.txt']); execFileSync('git', ['-C', ${JSON.stringify(ws.coreImpl)}, 'commit', '-qm', 'other module fix', '--no-verify']); `;
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: agents(ws, FILES, other + GOOD_FIX).env });
    expect(run).toMatchObject({ code: 0, stdout: ['result: done', 'round: 2', ...MAILBOX_LINES.map((line) => `pre-existing test fail: ${line}`), ''].join('\n') });
    expect(fake.runs[1]?.head).toBe(beforeMerge(ws));
    expect(fake.runs[1]?.head).not.toBe(roundStart(ws, 1));
  });

  it('does not stop for a dependent that a merge after the fix merge broke before the core tests read main', async () => {
    const ws = workspace(false);
    fake.brokenBy = 'other.txt';
    fake.landsBeforeTest = 'other.txt';
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: agents(ws, FILES, GOOD_FIX).env });
    expect(run).toMatchObject({ code: 0, stdout: ['result: done', 'round: 2', ...MAILBOX_LINES.map((line) => `pre-existing test fail: ${line}`), ''].join('\n') });
    // passes before the fix merge and at the fix merge itself: the later merge broke it
    expect(fake.runs.slice(1).map((r) => r.head)).toEqual([beforeMerge(ws), fixMergeOf(ws)]);
  });

  it('stops at test fail for a dependent that fails at the fix merge when main moved past it', async () => {
    const ws = workspace(false);
    // the fix itself breaks mailbox; an unrelated merge lands after it
    fake.brokenBy = 'fixed.txt';
    fake.landsBeforeTest = 'unrelated.txt';
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: agents(ws, FILES, GOOD_FIX).env });
    expect(run).toMatchObject({ code: 1, stdout: ['result: test fail', 'round: 1', 'open finding: R1-1 correctness high src/a.ts:3 spec change: no', ...MAILBOX_LINES, ''].join('\n') });
    expect(fake.runs.slice(1).map((r) => r.head)).toEqual([beforeMerge(ws), fixMergeOf(ws)]);
  });

  it('stops at test fail when the run before the fix merge stops before its tests', async () => {
    const ws = workspace(false);
    fake.landsBeforeTest = 'unrelated.txt';
    fake.errorAtRun = 1;
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: agents(ws, FILES, GOOD_FIX).env });
    expect(run).toMatchObject({ code: 1, stdout: ['result: test fail', 'round: 1', 'open finding: R1-1 correctness high src/a.ts:3 spec change: no', ...MAILBOX_LINES, ''].join('\n') });
    expect(fake.runs.slice(1).map((r) => r.head)).toEqual([beforeMerge(ws)]);
  });

  it('stops at test fail when the run at the fix merge stops before its tests', async () => {
    const ws = workspace(false);
    fake.landsBeforeTest = 'unrelated.txt';
    fake.errorAtRun = 2;
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: agents(ws, FILES, GOOD_FIX).env });
    expect(run).toMatchObject({ code: 1, stdout: ['result: test fail', 'round: 1', 'open finding: R1-1 correctness high src/a.ts:3 spec change: no', ...MAILBOX_LINES, ''].join('\n') });
    expect(fake.runs.slice(1).map((r) => r.head)).toEqual([beforeMerge(ws), fixMergeOf(ws)]);
  });

  it('stops at test unknown when a dependent is unknown with no fail, and a rerun goes on at the core test of the same fix', async () => {
    const ws = workspace(false);
    fake.mainOutputs = [
      { modules: { routing: 'pass', mailbox: 'unknown' }, failures: { routing: [], mailbox: [] }, unknown: { mailbox: 'screen locked' } },
      { modules: { routing: 'pass', mailbox: 'pass' }, failures: { routing: [], mailbox: [] } },
    ];
    const fakeAgents = agents(ws, FILES, GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fakeAgents.env });
    expect(run).toMatchObject({
      code: 1,
      stdout: ['result: test unknown', 'round: 1', 'open finding: R1-1 correctness high src/a.ts:3 spec change: no', 'ogw core test server mailbox routing: mailbox unknown: screen locked; rerun with the screen unlocked', ''].join('\n'),
    });
    // an unknown module is no failure: it does not run again before the fix merge
    expect(fake.runs.map((r) => r.argv)).toEqual([AFTER]);
    // the rerun tests the merged fix again before round 2 starts, and does not fix again
    const rerun = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fakeAgents.env });
    expect(rerun).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect(fake.runs.map((r) => [r.argv, r.rounds])).toEqual([[AFTER, 1], [AFTER, 1]]);
    expect(fakeAgents.calls().filter((call) => call.prompt.includes('round-1-fix.md'))).toHaveLength(1);
  });

  it('stops at test fail when a fail that stops and an unknown come in the core tests after the fix', async () => {
    const ws = workspace(false);
    fake.mainOutputs = [{ modules: { routing: 'fail', mailbox: 'unknown' }, failures: { routing: ['sqlite run: route.test.ts broke'], mailbox: [] }, unknown: { mailbox: 'screen locked' } }];
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: agents(ws, FILES, GOOD_FIX).env });
    expect(run).toMatchObject({
      code: 1,
      stdout: ['result: test fail', 'round: 1', 'open finding: R1-1 correctness high src/a.ts:3 spec change: no', 'ogw core test server mailbox routing: routing fail', '  sqlite run: route.test.ts broke', ''].join('\n'),
    });
    expect(fake.runs.map((r) => r.argv)).toEqual([AFTER]);
  });

  it('hands the pre-existing lines to the process of the changed harness code', async () => {
    const ws = workspace(true);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: agents(ws, FILES, toolsChange(ws) + GOOD_FIX).env });
    expect(run.stderr).toContain('the harness tools changed: ogw review run core routing goes on with the new code');
    expect(run).toMatchObject({ code: 0, stdout: ['result: done', 'round: 2', ...MAILBOX_LINES.map((line) => `pre-existing test fail: ${line}`), ''].join('\n') });
  });
});
