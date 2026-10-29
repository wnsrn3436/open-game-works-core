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

/** Whether an input releases what an earlier input holds: an `_up` command, or `pad_axis` back to 0. */
export function releasesHeld(input: readonly string[]): boolean {
  const [command, , value] = input;
  return command?.endsWith('_up') === true || (command === 'pad_axis' && Number(value) === 0);
}

/**
 * Fails an input or step of a play agent once harness settings `loop.playBudgetMs` has passed since its first input or
 * step; notes the time of the first one. Other callers pass, and so does an input that releases a held one
 * (`releasesHeld` of `input`, the input command and its arguments), so that no input stays held.
 */
export async function checkPlayBudget(ctx: Context, input?: readonly string[]): Promise<void> {
  if (input !== undefined && releasesHeld(input)) return;
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

/**
 * The refusal the broker gives a forwarded `ogw step` or `ogw input` (`checkPlayBudget`) before it starts the command,
 * so that a refused call costs no command start; null to run it.
 */
export async function brokerBudgetRefusal(ctx: Context, argv: readonly string[]): Promise<string | null> {
  if (argv[0] !== 'step' && argv[0] !== 'input') return null;
  if (argv.includes('--help')) return null;
  const input = argv[0] === 'input' && !argv.some((a) => a === '--script' || a.startsWith('--script=')) ? argv.filter((a) => !a.startsWith('--')).slice(2) : undefined;
  try {
    await checkPlayBudget(ctx, input);
    return null;
  } catch (error) {
    if (error instanceof OgwError) return error.message;
    throw error;
  }
}
