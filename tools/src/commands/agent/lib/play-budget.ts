import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentContext } from '../../../lib/agentctx.ts';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { isNotFound } from '../../../lib/fsx.ts';
import { jobsDir } from '../../../lib/jobs.ts';

export const playBudgetDeps = { now: (): number => Date.now() };

/** The file that holds when the play agent of `agentJob` put in its first input: in the jobs folder, which the broker sandbox writes. */
async function startFile(env: NodeJS.ProcessEnv, agentJob: string): Promise<string> {
  return join(await jobsDir(env), 'play-budget', agentJob);
}

/**
 * Fails an input or step of a play agent once harness settings `loop.playBudgetMs` has passed since its first input or
 * step; notes the time of the first one. Other callers pass.
 */
export async function checkPlayBudget(ctx: Context): Promise<void> {
  const agent = await agentContext(ctx.env);
  if (agent?.meta.role !== 'play') return;
  const budget = (await ctx.settings()).loop.playBudgetMs;
  const file = await startFile(ctx.env, agent.job.id);
  const now = playBudgetDeps.now();
  let first: number;
  try {
    first = Number(await readFile(file, 'utf8'));
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, String(now));
    return;
  }
  if (Number.isFinite(first) && now - first >= budget) {
    throw new OgwError(`the play budget of ${String(Math.round(budget / 1000))} s since the first input has passed: put in no more input and write the result`);
  }
}

export async function clearPlayBudget(env: NodeJS.ProcessEnv, agentJob: string): Promise<void> {
  await rm(await startFile(env, agentJob), { force: true });
}
