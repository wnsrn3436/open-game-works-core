import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isNotFound } from '../../../lib/fsx.ts';
import { jobsDir } from '../../../lib/jobs.ts';
import { checkInstanceId } from './records.ts';

/**
 * Release requests of one judge agent job: one empty file per instance its agent released with `ogw instance
 * release`. They are in the jobs folder, which the broker sandbox writes, and `ogw loop evaluate` stops the instances.
 */
async function releasesDir(env: NodeJS.ProcessEnv, agentJob: string): Promise<string> {
  return join(await jobsDir(env), 'instance-releases', agentJob);
}

export async function requestRelease(env: NodeJS.ProcessEnv, agentJob: string, id: string): Promise<void> {
  checkInstanceId(id);
  const dir = await releasesDir(env, agentJob);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, id), '');
}

/** The instances the agent of `agentJob` asked to release since the last call; the requests are removed. */
export async function takeReleases(env: NodeJS.ProcessEnv, agentJob: string): Promise<string[]> {
  const dir = await releasesDir(env, agentJob);
  let ids: string[];
  try {
    ids = await readdir(dir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  for (const id of ids) await rm(join(dir, id), { force: true });
  return ids;
}

export async function clearReleases(env: NodeJS.ProcessEnv, agentJob: string): Promise<void> {
  await rm(await releasesDir(env, agentJob), { recursive: true, force: true });
}
