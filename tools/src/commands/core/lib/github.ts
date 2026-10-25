import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { run, runOk } from '../../../lib/proc.ts';

/** GitHub release access of the core release repository, through the `gh` CLI. */

export async function releaseTags(ctx: Context, repo: string): Promise<string[]> {
  const result = await runOk(
    'gh',
    ['release', 'list', '--repo', repo, '--limit', '10000', '--exclude-drafts', '--json', 'tagName'],
    { env: ctx.env, timeoutMs: LIMITS.httpMs },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new OgwError(`gh release list printed no JSON for ${repo}`);
  }
  if (!Array.isArray(parsed)) throw new OgwError(`gh release list printed no list for ${repo}`);
  return parsed
    .map((item: unknown) => (typeof item === 'object' && item !== null ? (item as { tagName?: unknown }).tagName : undefined))
    .filter((tag): tag is string => typeof tag === 'string');
}

export async function releaseExists(ctx: Context, repo: string, tag: string): Promise<boolean> {
  const result = await run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'tagName'], {
    env: ctx.env,
    timeoutMs: LIMITS.httpMs,
  });
  if (result.timedOut) throw new OgwError(`gh release view ${tag} timed out`);
  if (result.code === 0) return true;
  if (/not found/i.test(result.stderr)) return false;
  throw new OgwError(`gh release view ${tag} --repo ${repo} failed: ${(result.stderr || result.stdout).trim()}`);
}

/** First lines of the commit messages between two tags of a repository, oldest first (GitHub compare). */
export async function compareSubjects(ctx: Context, repo: string, from: string, to: string): Promise<string[]> {
  const result = await runOk('gh', ['api', `repos/${repo}/compare/${from}...${to}`, '--jq', '.commits[].commit.message | split("\n")[0]'], {
    env: ctx.env,
    timeoutMs: LIMITS.httpMs,
  });
  return result.stdout.split('\n').filter((line) => line.trim() !== '');
}

export async function downloadRelease(ctx: Context, repo: string, tag: string, dir: string): Promise<void> {
  await runOk('gh', ['release', 'download', tag, '--repo', repo, '--dir', dir], { env: ctx.env, timeoutMs: LIMITS.programMs });
}

export async function createRelease(ctx: Context, repo: string, tag: string, files: readonly string[]): Promise<void> {
  await runOk('gh', ['release', 'create', tag, ...files, '--repo', repo, '--verify-tag', '--title', tag, '--notes', ''], {
    env: ctx.env,
    timeoutMs: LIMITS.programMs,
  });
}

/** Browser download URL of a release asset. */
export function assetUrl(repo: string, tag: string, asset: string): string {
  return `https://github.com/${repo}/releases/download/${tag}/${asset}`;
}
