import { LIMITS } from '../../../lib/limits.ts';
import { run } from '../../../lib/proc.ts';
import type { EnvCheckResult, ProgramCheck } from './results.ts';

/** First non-empty line of a program's output, trimmed. */
export function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.trim() ?? '';
}

/** Runs a version command; `found` is true when it ends with code 0. */
export async function probeProgram(env: NodeJS.ProcessEnv, cmd: string, args: string[]): Promise<ProgramCheck> {
  const result = await run(cmd, args, { env, timeoutMs: LIMITS.shortMs }).catch(() => null);
  if (!result || result.code !== 0) return { found: false, version: null };
  return { found: true, version: firstLine(result.stdout) || firstLine(result.stderr) };
}

/** `docker buildx version`. */
export function dockerBuildx(env: NodeJS.ProcessEnv): Promise<ProgramCheck> {
  return probeProgram(env, 'docker', ['buildx', 'version']);
}

/** The GitHub host that holds the core release and the server image. */
const GITHUB_HOST = 'github.com';

/**
 * `gh auth status` of the active account on `github.com` only: login and its token scopes. Other hosts and accounts in
 * the gh config do not count.
 */
export async function ghStatus(env: NodeJS.ProcessEnv): Promise<EnvCheckResult['gh']> {
  const result = await run('gh', ['auth', 'status', '--hostname', GITHUB_HOST, '--active'], { env, timeoutMs: LIMITS.shortMs }).catch(() => null);
  if (!result || result.code !== 0) return { loggedIn: false, scopes: [] };
  const match = /Token scopes:\s*(.*)/.exec(`${result.stdout}\n${result.stderr}`);
  const scopes = (match?.[1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s !== '');
  return { loggedIn: true, scopes };
}
