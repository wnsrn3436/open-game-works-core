import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isNotFound } from '../../../lib/fsx.ts';
import { jobsDir } from '../../../lib/jobs.ts';
import { checkInstanceId } from './records.ts';

/**
 * Instances of the input of one judge agent job that do not run: those `ogw loop evaluate` could not start after the
 * agent started, and those the judge gave back. One file per instance, holding why. They are in the jobs folder, which `ogw instance wait` reads in the broker sandbox.
 */
async function unstartedDir(env: NodeJS.ProcessEnv, agentJob: string): Promise<string> {
  return join(await jobsDir(env), 'instance-unstarted', agentJob);
}

export async function noteUnstarted(env: NodeJS.ProcessEnv, agentJob: string, id: string, reason: string): Promise<void> {
  checkInstanceId(id);
  const dir = await unstartedDir(env, agentJob);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, id), reason);
}

/** Why the instance was not started for the agent of `agentJob`, or null when it was not noted. */
export async function unstartedReason(env: NodeJS.ProcessEnv, agentJob: string, id: string): Promise<string | null> {
  checkInstanceId(id);
  try {
    return await readFile(join(await unstartedDir(env, agentJob), id), 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function clearUnstarted(env: NodeJS.ProcessEnv, agentJob: string): Promise<void> {
  await rm(await unstartedDir(env, agentJob), { recursive: true, force: true });
}
