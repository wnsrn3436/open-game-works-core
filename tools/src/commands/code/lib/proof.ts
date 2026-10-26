/**
 * `fix test proof` (core command.md `## review and code check`, ogw.md `## update harness tool`): the target's test
 * files changed from the fix base to the round's commit, laid over the code at the fix base, must fail there. A test
 * that passes on the code before the fix does not test the fixed behavior.
 */
import { readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { exists } from '../../../lib/fsx.ts';
import { OgwError } from '../../../lib/errors.ts';
import { git, gitRaw, revParse, worktreeAdd, worktreeRemove } from '../../../lib/git.ts';
import { newId } from '../../../lib/ids.ts';
import { AGENT_KEY_ENV } from '../../../lib/jobs.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { cliEntry } from '../../../lib/paths.ts';
import { run } from '../../../lib/proc.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';
import { moduleFolder } from '../../core/lib/impl.ts';
import { coreEngines, type Side } from './target.ts';

export interface ProofResult {
  result: 'pass' | 'fail' | 'unknown';
  failures: string[];
}

interface Changed {
  path: string;
  deleted: boolean;
}

/** Files under `dirs` that differ between the two commits, repo-relative. */
async function changedFiles(repo: string, from: string, to: string, dirs: readonly string[], env: NodeJS.ProcessEnv): Promise<Changed[]> {
  const out = await git(repo, ['diff', '--name-status', '-z', '--no-renames', from, to, '--', ...dirs], { env });
  const parts = out.split('\0').filter((part) => part !== '');
  const changed: Changed[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) changed.push({ path: parts[i + 1] as string, deleted: parts[i] === 'D' });
  return changed;
}

/** Lays the changed files of `commit` over the worktree: added and changed files get their content there, deleted ones go. */
async function overlay(worktree: string, commit: string, changed: readonly Changed[], env: NodeJS.ProcessEnv): Promise<void> {
  const kept = changed.filter((c) => !c.deleted).map((c) => c.path);
  if (kept.length > 0) await git(worktree, ['checkout', commit, '--', ...kept], { env });
  for (const c of changed.filter((d) => d.deleted)) await rm(join(worktree, c.path), { force: true });
}

/**
 * The environment of the proof's test runs: without the code check job's id and agent key, so that a test run (and a
 * `ogw` command a test runs) does not record into the code check job.
 */
export function testEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'OGW_JOB_ID' && key !== AGENT_KEY_ENV));
}

const NOT_PROVED = (base: string, files: readonly string[]): string =>
  `the changed tests pass on ${base.slice(0, 12)}, the code before the fix, so they do not test the fixed behavior: ${files.join(', ')}`;

interface VitestFile {
  status?: string;
  assertionResults?: { status?: string }[];
}

interface VitestReport {
  testResults?: VitestFile[];
}

/** The tests of a file that ran (`passed` or `failed`); a skipped or todo test did not run. */
function ranTests(file: VitestFile): { status?: string }[] {
  return (file.assertionResults ?? []).filter((test) => test.status === 'passed' || test.status === 'failed');
}


/** Whether `tools/package.json` and `tools/package-lock.json` of `base` are those of the repo's working tree. */
export async function sameDependencies(repo: string, base: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const diff = await gitRaw(repo, ['diff', '--quiet', base, '--', 'tools/package.json', 'tools/package-lock.json'], { env });
  if (diff.code !== 0 && diff.code !== 1) throw new OgwError(`git diff of the tools dependencies failed: ${diff.stderr.trim()}`);
  return diff.code === 0;
}

/** `tool`: the changed `tools/test/` files over the harness repo at the fix base; the changed `*.test.ts` run with vitest. */
async function toolProof(ctx: Context, repo: string, base: string, commit: string, changed: readonly Changed[]): Promise<ProofResult> {
  const tests = changed.filter((c) => !c.deleted && c.path.endsWith('.test.ts')).map((c) => c.path.slice('tools/'.length));
  if (tests.length === 0) return { result: 'unknown', failures: ['no test file of tools/test/ changed in the fix'] };
  const folder = await newPrivateTempFolder('ogw-fix-proof-', ctx.env);
  const worktree = join(folder, 'repo');
  try {
    await worktreeAdd(repo, worktree, base, undefined, { env: ctx.env });
    await overlay(worktree, commit, changed, ctx.env);
    // the code before the fix runs with its own dependencies: the repo's node_modules only when they are the same
    if (await sameDependencies(repo, base, ctx.env)) await symlink(join(repo, 'tools', 'node_modules'), join(worktree, 'tools', 'node_modules'), 'dir');
    else {
      const installed = await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: join(worktree, 'tools'), env: testEnv(ctx.env), timeoutMs: LIMITS.programMs });
      if (installed.code !== 0) return { result: 'unknown', failures: [`npm ci of the fix base failed: ${(installed.stderr || installed.stdout).trim().split('\n').at(-1) ?? ''}`] };
    }
    const report = join(folder, 'vitest.json');
    const vitest = join(worktree, 'tools', 'node_modules', 'vitest', 'vitest.mjs');
    const ran = await run(process.execPath, [vitest, 'run', '--passWithNoTests', '--reporter=json', `--outputFile=${report}`, ...tests], {
      cwd: join(worktree, 'tools'),
      env: testEnv(ctx.env),
      timeoutMs: LIMITS.jobMs,
    });
    if (!exists(report)) return { result: 'unknown', failures: [`vitest did not report: ${(ran.stderr || ran.stdout).trim().split('\n')[0] ?? ''}`] };
    const data = JSON.parse(await readFile(report, 'utf8')) as VitestReport;
    const files = data.testResults ?? [];
    // a failing test, or a test file that failed otherwise (it did not load, or a hook failed); with `--passWithNoTests`
    // a file or a `describe` that holds no test passes
    const failedTests = files.flatMap(ranTests).filter((test) => test.status === 'failed').length;
    const failedFiles = files.filter((file) => file.status === 'failed').length;
    if (failedTests + failedFiles > 0) return { result: 'pass', failures: [] };
    // vitest ran but loaded no test file (for example a global setup that does not load on the code before the fix)
    if (files.length === 0 && ran.code !== 0) return { result: 'pass', failures: [] };
    if (files.flatMap(ranTests).length === 0) return { result: 'unknown', failures: [`no test ran: ${tests.join(', ')}`] };
    return { result: 'fail', failures: [NOT_PROVED(base, tests)] };
  } finally {
    await worktreeRemove(repo, worktree, { env: ctx.env }).catch(() => undefined);
    await rm(folder, { recursive: true, force: true });
  }
}

/** The `ogw core test` target of a changed core test file: `server`, `tools` or the engine. */
function testTarget(path: string): string {
  const [top, second] = path.split('/');
  return top === 'client' ? (second as string) : (top as string);
}

/** The `ogw core test --json` output the proof reads. */
interface CoreTestJson {
  modules?: Record<string, string>;
  counts?: Record<string, { tests: number; passed: number; ran: boolean }>;
  failures?: Record<string, string[]>;
  error?: string;
}

/** The target's result in a core test output: true when its tests failed, false when they passed, else why neither. */
function targetProof(data: CoreTestJson, command: string, target: string): boolean | string {
  if (typeof data.error === 'string') return `${command} stopped before the tests: ${data.error}`;
  const result = data.modules?.[target];
  const ran = data.counts?.[target]?.ran === true;
  const failures = data.failures?.[target] ?? [];
  // every test that ran passed: a tool whose engine round trip was left out is `skipped` with no failure
  if (result === 'pass' || (result === 'skipped' && ran && failures.length === 0)) return false;
  // a `fail` once the test runner was started proves the fix's tests, a crash and a time limit included; a run that
  // stopped before it (an `npm ci` that failed, no vitest) proves nothing
  if (result === 'fail' && ran) return true;
  return `${command}: ${target} is ${String(result)} and its test runner was not started: ${failures.join('; ')}`;
}

/** Result of one `ogw core test <target> <module> --json` on the proof worktree (`targetProof`). */
async function coreRun(ctx: Context, worktree: string, args: readonly string[], target: string): Promise<boolean | string> {
  const ran = await run(process.execPath, [...process.execArgv, cliEntry(), 'core', 'test', ...args, '--json'], {
    cwd: worktree,
    env: testEnv(ctx.env),
    timeoutMs: LIMITS.jobMs,
  });
  const command = `ogw core test ${args.join(' ')}`;
  try {
    return targetProof(JSON.parse(ran.stdout) as CoreTestJson, command, target);
  } catch {
    return `${command}: exit code ${String(ran.code)}: ${(ran.stderr || ran.stdout).trim().split('\n')[0] ?? ''}`;
  }
}

/** `core`: the changed test files of the target over `open-game-works-core-impl/` at the fix base; `ogw core test` of the target. */
async function coreProof(ctx: Context, repo: string, base: string, commit: string, target: string, changed: readonly Changed[]): Promise<ProofResult> {
  if (changed.length === 0) return { result: 'unknown', failures: [`no test file of ${target} changed in the fix`] };
  // a worktree under `worktrees/_core/`: `ogw core test` run in it takes it as the core checkout
  const worktree = join((await ctx.workspace()).worktrees, '_core', `proof-${newId()}`);
  try {
    await worktreeAdd(repo, worktree, base, undefined, { env: ctx.env });
    await overlay(worktree, commit, changed, ctx.env);
    const targets = [...new Set(changed.map((c) => testTarget(c.path)))].sort();
    const results = [];
    for (const name of targets) results.push(await coreRun(ctx, worktree, [name, target], target));
    if (results.includes(true)) return { result: 'pass', failures: [] };
    const unknown = results.filter((r): r is string => typeof r === 'string');
    if (unknown.length > 0) return { result: 'unknown', failures: unknown };
    return { result: 'fail', failures: [NOT_PROVED(base, changed.map((c) => c.path))] };
  } finally {
    await worktreeRemove(repo, worktree, { env: ctx.env }).catch(() => undefined);
  }
}

/**
 * The folders of the target: its code folders and its test folders (`core` command `## review and code check`). The
 * harness `tools/` has its code in `tools/src/` and its tests in `tools/test/`; a core target has its tests in `tests/`
 * of each of its folders.
 */
async function targetFolders(side: Side, repo: string, target: string | undefined): Promise<{ code: string[]; tests: string[] }> {
  if (side === 'tool') return { code: ['tools/src'], tests: ['tools/test'] };
  const name = target as string;
  const roots = [`server/core/${name}`, `tools/${name}`, ...(await coreEngines(repo)).map((e) => `client/${e}/core/${moduleFolder(name)}`)];
  return { code: roots, tests: roots.map((root) => `${root}/tests`) };
}

/** What the fix from `from` to `to` changed of the target: whether code outside its tests changed, and its changed test files. */
async function targetChanges(ctx: Context, side: Side, repo: string, from: string, to: string, target: string | undefined): Promise<{ code: boolean; tests: Changed[] }> {
  const folders = await targetFolders(side, repo, target);
  const inTests = (path: string): boolean => folders.tests.some((dir) => path.startsWith(`${dir}/`));
  const changed = await changedFiles(repo, from, to, [...new Set([...folders.code, ...folders.tests])], ctx.env);
  return { code: changed.some((c) => !inTests(c.path)), tests: changed.filter((c) => inTests(c.path)) };
}

/** The `fix test proof` of a round at `commit` after a fix from `base`; `target` names the core target. */
export async function fixTestProof(ctx: Context, side: Side, repo: string, base: string, commit: string, target: string | undefined): Promise<ProofResult> {
  // both read in the repo: inside the proof worktree `HEAD` is the base
  const [from, to] = [await revParse(repo, base, { env: ctx.env }), await revParse(repo, commit, { env: ctx.env })];
  if (from === null || to === null) return { result: 'fail', failures: [`commit not found in ${repo}: ${from === null ? base : commit}`] };
  if (side === 'core' && target === undefined) return { result: 'fail', failures: ['--fix-base of a core code check needs --target'] };
  // a fix of tests only (a test evidence finding): the code before the fix is the code after it, so no test can fail
  // on it and the proof cannot tell (`core` command `## review and code check`)
  const changes = await targetChanges(ctx, side, repo, from, to, target);
  if (!changes.code && changes.tests.length > 0) {
    return { result: 'unknown', failures: [`the fix changed only test files of ${side === 'tool' ? 'tools/' : String(target)}: the code before it is the code after it`] };
  }
  if (side === 'tool') return toolProof(ctx, repo, from, to, changes.tests);
  return coreProof(ctx, repo, from, to, target as string, changes.tests);
}
