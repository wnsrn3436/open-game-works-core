import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Jobs from '../../../src/lib/jobs.ts';
import { ogw, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { agents, coreSpec, finding, GOOD_FIX, implementServer, reviewFile, spec, toolsChange } from './helpers.ts';

/**
 * The `ogw core test` jobs of `ogw review run`, faked in this process: after the fix (in the core main checkout)
 * `routing` passes and `mailbox` fails; before the fix (in another checkout) `mailbox` fails when `failsBeforeFix`,
 * or when that checkout has the file `brokenBy`. Each run records its argv, its checkout and that checkout's HEAD.
 */
const fake = vi.hoisted(() => ({
  coreImpl: '',
  failsBeforeFix: true,
  brokenBy: null as string | null,
  /** A file committed to the core main checkout just before the first core test there: a merge after the fix merge. */
  landsBeforeTest: null as string | null,
  /** The index of a run that stops before its tests (`{ error }`). */
  errorAtRun: null as number | null,
  runs: [] as { argv: string[]; cwd: string; head: string }[],
  results: new Map<string, Jobs.WaitResult>(),
}));

vi.mock('../../../src/lib/jobs.ts', async (importOriginal) => {
  const original = await importOriginal<typeof Jobs>();
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
      fake.runs.push({ argv: options.argv, cwd: options.cwd, head });
      const modules = options.cwd === fake.coreImpl ? { routing: 'pass', mailbox: 'fail' } : { mailbox: fake.failsBeforeFix || (fake.brokenBy !== null && existsSync(join(options.cwd, fake.brokenBy))) ? 'fail' : 'pass' };
      const stopped = fake.runs.length - 1 === fake.errorAtRun;
      const failed = modules.mailbox === 'fail' || stopped;
      const stdout = stopped
        ? JSON.stringify({ error: 'godot not found', tests: 1, passed: 0 })
        : JSON.stringify({ modules, failures: failed ? { mailbox: ['sqlite run: mail.test.ts broke'] } : {} });
      fake.results.set(id, { job: { id, status: 'done', exitCode: failed ? 1 : 0 } as Jobs.JobRecord, finished: true, stdout, stderr: '' });
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

  it('hands the pre-existing lines to the process of the changed harness code', async () => {
    const ws = workspace(true);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: agents(ws, FILES, toolsChange(ws) + GOOD_FIX).env });
    expect(run.stderr).toContain('the harness tools changed: ogw review run core routing goes on with the new code');
    expect(run).toMatchObject({ code: 0, stdout: ['result: done', 'round: 2', ...MAILBOX_LINES.map((line) => `pre-existing test fail: ${line}`), ''].join('\n') });
  });
});
