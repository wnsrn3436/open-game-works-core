import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { showFile } from '../../../lib/git.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { run } from '../../../lib/proc.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';

export interface ToolRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs a release tool `node <dir>/<bin> <args>` in `cwd` with the program time limit and the command's `env`. */
export async function runNodeTool(toolDir: string, bin: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<ToolRun> {
  const result = await run(process.execPath, [join(toolDir, bin), ...args], { cwd, env, timeoutMs: LIMITS.programMs });
  if (result.timedOut) throw new OgwError(`${bin} timed out after ${String(LIMITS.programMs)} ms`);
  return { exitCode: result.code ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/** Runs `fn` with a new folder in the temp folder of ogw that is removed afterwards. */
export async function withTempDir<T>(prefix: string, env: NodeJS.ProcessEnv, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await newPrivateTempFolder(prefix, env);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function copyDir(source: string, dest: string): Promise<void> {
  await cp(source, dest, { recursive: true });
}

/** A JSON file of the game settings at a revision. */
export async function settingsAt(root: string, rev: string): Promise<Record<string, unknown>> {
  const content = await showFile(root, rev, 'settings.json');
  if (content === null) throw new OgwError(`no settings.json at ${rev}`);
  try {
    return JSON.parse(content.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new OgwError(`invalid settings.json at ${rev}`);
  }
}
