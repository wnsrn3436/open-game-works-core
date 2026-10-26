import { mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, writeFileAtomic } from '../../../lib/fsx.ts';
import { commonDir, git, gitRaw, revParse } from '../../../lib/git.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { withLock } from '../../../lib/lock.ts';
import { run } from '../../../lib/proc.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';
import { sameDependencies, testEnv } from './proof.ts';

interface VitestReport {
  testResults?: { name?: string; status?: string; message?: string; assertionResults?: { fullName?: string; status?: string }[] }[];
}

/** The most failure lines the check gives; the rest are counted in one line. */
const MAX_LINES = 20;

/** The failure lines of a vitest JSON report: each failed test and each test file that failed otherwise. */
export function reportFailures(report: VitestReport, root: string): string[] {
  const lines: string[] = [];
  for (const file of report.testResults ?? []) {
    const name = (file.name ?? '').startsWith(`${root}/`) ? (file.name ?? '').slice(root.length + 1) : (file.name ?? '');
    const failed = (file.assertionResults ?? []).filter((test) => test.status === 'failed');
    for (const test of failed) lines.push(`${name}: ${test.fullName ?? ''}`);
    if (failed.length === 0 && file.status === 'failed') lines.push(`${name}: ${(file.message ?? 'failed').split('\n')[0] ?? ''}`);
  }
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `${String(lines.length - MAX_LINES)} more`] : lines;
}

/**
 * `tool tests` of `ogw code check tool` at `commit` (ogw.md `## update harness tool`): the whole test suite of `tools/`
 * in a clone of that commit. Its result is kept in `ogw-cache/tool-tests/<commit>.json` of the harness repo (a pass for
 * good, a failure for `FAILURE_KEPT_MS`), and a run of the same commit by another code check waits for it, so the code
 * checks of the targets of one round run the suite once. A commit without `tools/package.json` has no suite and passes.
 */
export async function toolTestsCheck(ctx: Context, repo: string, commit: string): Promise<string[]> {
  const sha = await revParse(repo, commit, { env: ctx.env });
  if (sha === null) throw new OgwError(`no commit ${commit} in ${repo}`);
  // a commit without the tools package has no tool test suite
  if ((await gitRaw(repo, ['cat-file', '-e', `${sha}:tools/package.json`], { env: ctx.env })).code !== 0) return [];
  const folder = join(await commonDir(repo, { env: ctx.env }), 'ogw-cache', 'tool-tests');
  await mkdir(folder, { recursive: true });
  const recordPath = join(folder, `${sha}.json`);
  return withLock(`${recordPath}.lock`, async () => {
    const kept = await readRecord(recordPath);
    if (kept !== null && (kept.failures.length === 0 || Date.now() - kept.at < FAILURE_KEPT_MS)) return kept.failures;
    const failures = await runSuite(ctx, repo, sha);
    await writeFileAtomic(recordPath, `${JSON.stringify({ at: Date.now(), failures } satisfies SuiteRecord)}\n`);
    return failures;
  }, LIMITS.jobMs);
}

/** The result of a run of a commit's suite: kept for good when it passed, for `FAILURE_KEPT_MS` when it failed. */
interface SuiteRecord {
  at: number;
  failures: string[];
}

/** How long a failed run of a commit is given to the other code checks instead of running the suite again: one round. */
export const FAILURE_KEPT_MS = 60 * 60_000;

async function readRecord(path: string): Promise<SuiteRecord | null> {
  if (!exists(path)) return null;
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<SuiteRecord>;
    return typeof value.at === 'number' && Array.isArray(value.failures) ? { at: value.at, failures: value.failures.map(String) } : null;
  } catch {
    return null;
  }
}

/**
 * The suite of `sha` in a clone of its own (its own `.git`): the guard of the suite watches the git dir of the checkout
 * it runs in, and other jobs write the git dir of the harness repo meanwhile.
 */
async function runSuite(ctx: Context, repo: string, sha: string): Promise<string[]> {
  const work = await newPrivateTempFolder('ogw-tool-tests-', ctx.env);
  const clone = join(work, 'repo');
  try {
    await git(work, ['clone', '--quiet', '--no-checkout', '--shared', repo, clone], { env: ctx.env });
    await git(clone, ['checkout', '--quiet', sha], { env: ctx.env });
    const tools = join(clone, 'tools');
    if (await sameDependencies(repo, sha, ctx.env)) await symlink(join(repo, 'tools', 'node_modules'), join(tools, 'node_modules'), 'dir');
    else {
      const installed = await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: tools, env: testEnv(ctx.env), timeoutMs: LIMITS.programMs });
      if (installed.code !== 0) return [`npm ci failed: ${(installed.stderr || installed.stdout).trim().split('\n').at(-1) ?? ''}`];
    }
    const report = join(work, 'vitest.json');
    const ran = await run(process.execPath, [join(tools, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--reporter=json', `--outputFile=${report}`], {
      cwd: tools,
      env: testEnv(ctx.env),
      timeoutMs: LIMITS.jobMs,
    });
    if (!exists(report)) return [`vitest did not report: ${(ran.stderr || ran.stdout).trim().split('\n')[0] ?? ''}`];
    const failures = reportFailures(JSON.parse(await readFile(report, 'utf8')) as VitestReport, tools);
    if (failures.length === 0 && ran.code !== 0) return [`vitest ended with ${String(ran.code ?? ran.signal)}`];
    return failures;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
