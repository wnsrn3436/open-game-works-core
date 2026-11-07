import { OgwError } from '../../../lib/errors.ts';
import { isNotFound } from '../../../lib/fsx.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { run, type RunOptions, type RunResult } from '../../../lib/proc.ts';
import type { EnvCheckResult, ProgramCheck } from './results.ts';

/**
 * Whether a `run` failed because its program is not on this host: the spawn failed with `ENOENT`, which `run` gives as
 * the `OgwError` `cannot run <cmd>: spawn <cmd> ENOENT`.
 */
export function programMissing(error: unknown): boolean {
  return isNotFound(error) || (error instanceof OgwError && /: spawn .+ ENOENT$/.test(error.message));
}

/** `run`, or null when the program is not on this host (`programMissing`); every other failure to start it is thrown. */
export function runIfPresent(cmd: string, args: readonly string[], options: RunOptions): Promise<RunResult | null> {
  return run(cmd, args, options).catch((error: unknown) => {
    if (programMissing(error)) return null;
    throw error;
  });
}

/** First non-empty line of a program's output, trimmed. */
export function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.trim() ?? '';
}

/** Runs a version command; `found` is true when it ends with code 0, false when it does not or the program is not on this host. */
export async function probeProgram(env: NodeJS.ProcessEnv, cmd: string, args: string[]): Promise<ProgramCheck> {
  const result = await runIfPresent(cmd, args, { env, timeoutMs: LIMITS.shortMs });
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
  const result = await runIfPresent('gh', ['auth', 'status', '--hostname', GITHUB_HOST, '--active'], { env, timeoutMs: LIMITS.shortMs });
  if (!result || result.code !== 0) return { loggedIn: false, scopes: [] };
  const match = /Token scopes:\s*(.*)/.exec(`${result.stdout}\n${result.stderr}`);
  const scopes = (match?.[1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s !== '');
  return { loggedIn: true, scopes };
}
