import { basename, dirname, join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { readText, writeFileAtomic } from '../../../lib/fsx.ts';
import { jobsDir, listJobs } from '../../../lib/jobs.ts';
import { withLock } from '../../../lib/lock.ts';
import { isInside, withoutExtension } from '../../../lib/paths.ts';
import { commitInCheckout } from './launch.ts';
import { readAgentJob, type AgentMeta } from './meta.ts';
import { agentWait, outcomeOf } from './outcome.ts';
import { startAgent } from './prepare.ts';

/** Commits a retry input in the game repo checkout it was written to, as `ogw loop dispatch` does for its inputs. */
async function commitInput(ctx: Context, meta: AgentMeta, id: string, input: string): Promise<void> {
  if (meta.game === null) return;
  const game = await ctx.game(meta.game);
  if (!isInside(game.root, input)) return;
  await commitInCheckout(game.root, [input], `ogw agent retry ${id}: input`, { env: ctx.env, noVerify: false });
}

/** `ogw agent retry <id>`: a new agent of the same role and game with the input and the previous attempt. */
export async function retryAgent(ctx: Context, id: string): Promise<string> {
  const { job, meta } = await readAgentJob(id, ctx.env);
  const outcome = await outcomeOf(id, ctx.env);
  if (outcome.status === 'running') throw new OgwError(`job ${id} is running`);
  if (outcome.status === 'done') throw new OgwError(`job ${id} ended with a result file: ${String(outcome.output)}`);
  if (meta.role === 'play' || meta.role === 'judge') throw new OgwError(`job ${id} has a JSON input (${meta.role}); it is not retried`);
  if ((meta.variant ?? null) !== null) throw new OgwError(`job ${id} is a variant agent of ogw loop variants; it is not retried`);
  const root = meta.retryRoot === '' ? job.id : meta.retryRoot;
  const original = root === job.id ? meta.input : (await readAgentJob(root, ctx.env)).meta.input;
  const text = await readText(original);
  const waited = await agentWait(id, 0, ctx.env);
  const previous = [
    text.endsWith('\n') ? text : `${text}\n`,
    '## previous attempt',
    '',
    outcome.output ?? 'none',
    '',
    `${waited.text ?? ''}\n`,
  ].join('\n');
  // counting the retries and starting the next one is one step, so two retries of the same work never both start
  return withLock(join(await jobsDir(ctx.env), `${root}.retry.lock`), async () => {
    const retries = (await listJobs(ctx.env)).filter((j) => j.command === 'agent' && j.meta.retryRoot === root).length;
    const limit = (await ctx.settings()).backgroundRetryLimit;
    if (meta.role === 'content' && retries >= limit) {
      throw new OgwError(`job ${id}: the work was retried ${String(retries)} times (backgroundRetryLimit ${String(limit)})`, 1, { retries, limit });
    }
    const n = retries + 1;
    const input = join(dirname(original), `${basename(withoutExtension(original))}-retry-${String(n)}.md`);
    await writeFileAtomic(input, previous);
    await commitInput(ctx, meta, id, input);
    return startAgent(ctx, {
      role: meta.role,
      ...(meta.game !== null ? { game: meta.game } : {}),
      modules: meta.modules,
      input,
      taskInput: original,
      retryRoot: root,
      retryNumber: n,
      ...(meta.agent === undefined || meta.agent === null ? {} : { agent: meta.agent }),
    });
  });
}
