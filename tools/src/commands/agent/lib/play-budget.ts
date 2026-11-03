import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { agentContext } from '../../../lib/agentctx.ts';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { isNotFound } from '../../../lib/fsx.ts';
import { jobsDir } from '../../../lib/jobs.ts';
import { checkInstanceId } from '../../instance/lib/records.ts';

export const playBudgetDeps = { now: (): number => Date.now() };

/** The file that holds when the play agent of `agentJob` put in its first input: in the jobs folder, which the broker sandbox writes. */
async function startFile(env: NodeJS.ProcessEnv, agentJob: string): Promise<string> {
  return join(await jobsDir(env), 'play-budget', agentJob);
}

/** The folder of a judge agent, one file per instance it put an input in. */
async function judgeFolder(env: NodeJS.ProcessEnv, agentJob: string): Promise<string> {
  return join(await jobsDir(env), 'play-budget', `judge-${agentJob}`);
}

/** The time a budget file holds; null when there is no file or no time in it. */
async function notedTime(file: string): Promise<number | null> {
  try {
    const text = await readFile(file, 'utf8');
    const time = text === '' ? Number.NaN : Number(text);
    return Number.isFinite(time) ? time : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Notes the first call on `file` and returns null, or returns the time of the first call. The file appears whole and
 * only once (a hard link fails when the name exists), so calls that overlap read one time, that of the first of them.
 */
async function firstCall(file: string, now: number): Promise<number | null> {
  const noted = await notedTime(file);
  if (noted !== null) return noted;
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(temp, String(now));
  try {
    await link(temp, file);
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return await notedTime(file);
  } finally {
    await rm(temp, { force: true });
  }
}

/** Whether an input releases what an earlier input holds: an `_up` command, or `pad_axis` back to 0. */
export function releasesHeld(input: readonly string[]): boolean {
  const [command, , value] = input;
  return command?.endsWith('_up') === true || (command === 'pad_axis' && Number(value) === 0);
}

export interface PlayBudget {
  /** Unix ms when it ends. */
  endsAt: number;
  /** The refusal of an input or step past it. */
  refusal: string;
}

/** A budget before its start is known: the file that holds the start, its length and the refusal of an input or step past it. */
export interface BudgetRule {
  file: string;
  ms: number;
  refusal: string;
}

/**
 * The budget rule of the caller: of a play agent harness settings `loop.playBudgetMs` since its first input or step, of
 * a judge agent on `instance` `loop.judgeInstanceBudgetMs` since its first one on that instance. Other callers have
 * none: null.
 */
export async function budgetRule(ctx: Context, instance?: string): Promise<BudgetRule | null> {
  const agent = await agentContext(ctx.env);
  if (agent?.meta.role === 'judge' && instance !== undefined) {
    // the instance comes from the agent, and the file of its budget is written outside the agent sandbox
    checkInstanceId(instance);
    const ms = (await ctx.settings()).loop.judgeInstanceBudgetMs;
    return { file: join(await judgeFolder(ctx.env, agent.job.id), instance), ms, refusal: `the play budget of ${String(Math.round(ms / 1000))} s of instance ${instance} has passed: put in no more input on it` };
  }
  if (agent?.meta.role !== 'play') return null;
  const ms = (await ctx.settings()).loop.playBudgetMs;
  return { file: await startFile(ctx.env, agent.job.id), ms, refusal: `the play budget of ${String(Math.round(ms / 1000))} s since the first input has passed: put in no more input and write the result` };
}

/** Notes an input or step put in at unix ms `at` and returns the budget, which counts from the first one noted. */
export async function noteBudget(rule: BudgetRule, at: number): Promise<PlayBudget> {
  const first = await firstCall(rule.file, at);
  return { endsAt: (first ?? at) + rule.ms, refusal: rule.refusal };
}

/** The budget when a first input or step is noted, without noting one; null otherwise. */
export async function notedBudget(rule: BudgetRule): Promise<PlayBudget | null> {
  const first = await notedTime(rule.file);
  return first === null ? null : { endsAt: first + rule.ms, refusal: rule.refusal };
}

/** Fails an input or step put in now past `budget`. */
export function refusePastBudget(budget: PlayBudget | null): void {
  if (budget !== null && playBudgetDeps.now() >= budget.endsAt) throw new OgwError(budget.refusal);
}

/**
 * Notes an input or step of the caller, fails it past its budget (`budgetRule`), and returns that budget. An input that
 * releases a held one passes (`releasesHeld` of `input`, the input command and its arguments), so that no input stays
 * held: it notes nothing and returns null.
 */
export async function checkPlayBudget(ctx: Context, input?: readonly string[], instance?: string): Promise<PlayBudget | null> {
  if (input !== undefined && releasesHeld(input)) return null;
  const rule = await budgetRule(ctx, instance);
  const budget = rule === null ? null : await noteBudget(rule, playBudgetDeps.now());
  refusePastBudget(budget);
  return budget;
}

export async function clearPlayBudget(env: NodeJS.ProcessEnv, agentJob: string): Promise<void> {
  await rm(await startFile(env, agentJob), { force: true });
  await rm(await judgeFolder(env, agentJob), { recursive: true, force: true });
}
