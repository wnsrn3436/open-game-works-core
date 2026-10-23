import { realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A new empty folder under the OS temp folder, as a real path: the folder a play or judge agent starts in (ogw.md `## temp folder`). */
export async function newTempFolder(prefix: string): Promise<string> {
  return realpathSync(await mkdtemp(join(realpathSync(tmpdir()), prefix)));
}

/** The OS temp folder of `env`: `TMPDIR`, else the OS default. */
export function osTempFolder(env: NodeJS.ProcessEnv): string {
  return env.TMPDIR !== undefined && env.TMPDIR !== '' ? env.TMPDIR : tmpdir();
}

/** The name start of the folders play and judge agents start in (ogw.md `## temp folder`). */
export function agentFolderPrefix(role: string): string {
  return `ogw-${role}-`;
}

/** The folder in an agent folder that the agent CLI gets as `TMPDIR`. */
export const AGENT_TEMP_FOLDER = 'tmp';

/**
 * A new empty folder `ogw-<role>-*` directly under the OS temp folder of `env`, as a real path, with the empty
 * `tmp/` the agent CLI gets as `TMPDIR`: the folder a play or judge agent starts in (ogw.md `## temp folder`).
 */
export async function newAgentFolder(role: string, env: NodeJS.ProcessEnv): Promise<string> {
  const temp = osTempFolder(env);
  await mkdir(temp, { recursive: true });
  const folder = realpathSync(await mkdtemp(join(realpathSync(temp), agentFolderPrefix(role))));
  await mkdir(join(folder, AGENT_TEMP_FOLDER));
  return folder;
}

/** Moves a file or folder, across file systems too. */
export async function move(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as { code?: string }).code !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
}
