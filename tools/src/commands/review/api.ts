import { readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Context } from '../../lib/command.ts';
import { exists, whenNotFound } from '../../lib/fsx.ts';
import { branchExists, gitRaw } from '../../lib/git.ts';
import { listJobs } from '../../lib/jobs.ts';
import { privateTempDir } from '../../lib/secret-files.ts';
import type { AgentMeta } from '../agent/lib/meta.ts';
import type { LeftAgents } from './lib/left.ts';
import { changedSinceRound } from './lib/next.ts';
import { readState, removeReviewFile, removeToolReviewFiles, reviewRoot, listTargets, type ReviewResult } from './lib/state.ts';

export type { ReviewResult } from './lib/state.ts';

/**
 * Result of the last round of each review target that has review state: `running` before that round is judged, null
 * when the state has no round.
 */
export async function lastReviewResults(ctx: Context, side: 'core' | 'tool'): Promise<Map<string, ReviewResult | 'running' | null>> {
  const root = await reviewRoot(ctx, side);
  const results = new Map<string, ReviewResult | 'running' | null>();
  for (const target of await listTargets(root)) {
    const last = (await readState(join(root, target), side, target)).rounds.at(-1);
    results.set(target, last === undefined ? null : last.judged ? last.result : 'running');
  }
  return results;
}

/**
 * The review targets whose last round is `done` and whose paths changed since that round started, the change that
 * `--reopen` takes (`changedSinceRound`), with that round.
 */
export async function changedSinceDone(ctx: Context, side: 'core' | 'tool'): Promise<Map<string, number>> {
  const root = await reviewRoot(ctx, side);
  const changed = new Map<string, number>();
  for (const target of await listTargets(root)) {
    const state = await readState(join(root, target), side, target);
    const last = state.rounds.at(-1);
    if (last?.judged === true && last.result === 'done' && (await changedSinceRound(ctx, state, last, '--reopen'))) changed.set(target, last.round);
  }
  return changed;
}

/**
 * Removes what `ogw review spec` left (core command.md `## spec review`): its input folders `ogw-review-spec-*` of
 * `ogw-temp/`, and the review file of each spec review agent job, which `ogw agent` writes alone in a
 * `ogw-review-file-*` folder of `ogw-temp/` (the folder goes), or the file alone when it is elsewhere.
 */
async function removeSpecReviews(ctx: Context): Promise<void> {
  const temp = await privateTempDir(ctx.env);
  const names = await readdir(temp).catch(whenNotFound([] as string[]));
  for (const name of names.filter((n) => n.startsWith('ogw-review-spec-'))) await rm(join(temp, name), { recursive: true, force: true });
  for (const job of await listJobs(ctx.env)) {
    const meta = job.meta as Partial<AgentMeta>;
    if (job.command !== 'agent' || meta.role !== 'review' || meta.review?.side !== 'spec' || typeof meta.output !== 'string') continue;
    await removeReviewFile(meta.output);
  }
}

/**
 * `ogw review clear <core|tool>`: removes the review state of every target; for `tool` also the review files, for
 * `core` also the spec review input folders and review files (`removeSpecReviews`).
 */
/** Clears the review state of the side; returns what it left of the agent jobs (core). */
export async function clearReviews(ctx: Context, side: 'core' | 'tool'): Promise<LeftAgents> {
  const root = await reviewRoot(ctx, side);
  let left: LeftAgents = { notRemoved: [], discarded: [] };
  if (side === 'tool') {
    for (const target of await listTargets(root)) {
      await removeToolReviewFiles(ctx, (await readState(join(root, target), side, target)).rounds);
    }
  } else {
    await removeSpecReviews(ctx);
    left = await removeLeftAgentWorktrees(ctx);
  }
  await rm(root, { recursive: true, force: true });
  return left;
}

/**
 * Removes the worktrees and branches `agent/<id>` that agent jobs which do not run left in `open-game-works-core-impl/` (core
 * command.md: the command ended, and a result not merged is dropped); returns what stays. The names come from the job
 * id as `ogw agent` makes them: a job that ended during `git worktree add` has none in its meta. `-f -f` also removes
 * a worktree that an interrupted add left locked, and the prune drops one whose folder is gone, so its branch can go.
 * A removed branch with commits not in main is named with the sha that restores a result that should not have gone.
 */
async function removeLeftAgentWorktrees(ctx: Context): Promise<LeftAgents> {
  const coreImpl = resolve((await ctx.workspace()).coreImpl);
  const notRemoved: string[] = [];
  const discarded: string[] = [];
  for (const job of await listJobs(ctx.env)) {
    if (job.command !== 'agent' || job.status === 'running') continue;
    const place = (job.meta as AgentMeta).place;
    if (place.kind !== 'core-worktree' || resolve(place.coreImpl) !== coreImpl) continue;
    const worktree = join(place.worktrees, '_core', `agent-${job.id}`);
    if (exists(worktree)) await gitRaw(coreImpl, ['worktree', 'remove', '-f', '-f', worktree], { env: ctx.env });
    await gitRaw(coreImpl, ['worktree', 'unlock', worktree], { env: ctx.env });
    await gitRaw(coreImpl, ['worktree', 'prune'], { env: ctx.env });
    if (exists(worktree)) notRemoved.push(worktree);
    const branch = `agent/${job.id}`;
    if (await branchExists(coreImpl, branch, { env: ctx.env })) {
      const unmerged = await gitRaw(coreImpl, ['rev-list', '--count', `main..${branch}`], { env: ctx.env });
      const tip = await gitRaw(coreImpl, ['rev-parse', branch], { env: ctx.env });
      await gitRaw(coreImpl, ['branch', '-D', branch], { env: ctx.env });
      if (await branchExists(coreImpl, branch, { env: ctx.env })) notRemoved.push(branch);
      else if (unmerged.code === 0 && unmerged.stdout.trim() !== '0') discarded.push(`${branch}: ${unmerged.stdout.trim()} commits not in main, last ${tip.stdout.trim()}`);
    }
  }
  return { notRemoved, discarded };
}
