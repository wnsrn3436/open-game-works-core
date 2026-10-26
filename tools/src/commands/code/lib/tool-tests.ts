import { mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, writeFileAtomic } from '../../../lib/fsx.ts';
import { commonDir, gitRaw, revParse, worktreeAdd, worktreeRemove } from '../../../lib/git.ts';
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
 * in a worktree of that commit. A pass is kept in `ogw-cache/tool-tests/<commit>` of the harness repo and not run
 * again, and a run of the same commit by another code check waits for it, so the code checks of the targets of one
 * round run the suite once. A commit without `tools/package.json` has no suite and passes.
 */
export async function toolTestsCheck(ctx: Context, repo: string, commit: string): Promise<string[]> {
  const sha = await revParse(repo, commit, { env: ctx.env });
  if (sha === null) throw new OgwError(`no commit ${commit} in ${repo}`);
  // a commit without the tools package has no tool test suite
  if ((await gitRaw(repo, ['cat-file', '-e', `${sha}:tools/package.json`], { env: ctx.env })).code !== 0) return [];
  const folder = join(await commonDir(repo, { env: ctx.env }), 'ogw-cache', 'tool-tests');
  await mkdir(folder, { recursive: true });
  const passed = join(folder, sha);
  return withLock(`${passed}.lock`, async () => {
    if (exists(passed)) return [];
    const failures = await runSuite(ctx, repo, sha);
    if (failures.length === 0) await writeFileAtomic(passed, '');
    return failures;
  }, LIMITS.jobMs);
}

async function runSuite(ctx: Context, repo: string, sha: string): Promise<string[]> {
  const work = await newPrivateTempFolder('ogw-tool-tests-', ctx.env);
  const worktree = join(work, 'repo');
  try {
    await worktreeAdd(repo, worktree, sha, undefined, { env: ctx.env });
    const tools = join(worktree, 'tools');
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
    await worktreeRemove(repo, worktree, { env: ctx.env }).catch(() => undefined);
    await rm(work, { recursive: true, force: true });
  }
}
