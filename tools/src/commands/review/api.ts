import { readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Context } from '../../lib/command.ts';
import { exists } from '../../lib/fsx.ts';
import { branchExists, gitRaw } from '../../lib/git.ts';
import { listJobs } from '../../lib/jobs.ts';
import { privateTempDir } from '../../lib/secret-files.ts';
import type { AgentMeta } from '../agent/lib/meta.ts';
import { readState, removeReviewFile, removeToolReviewFiles, reviewRoot, listTargets, type ReviewResult } from './lib/state.ts';

export type { ReviewResult } from './lib/state.ts';

/** Result of the last judged round of each review target that has review state. */
export async function lastReviewResults(ctx: Context, side: 'core' | 'tool'): Promise<Map<string, ReviewResult | null>> {
  const root = await reviewRoot(ctx, side);
  const results = new Map<string, ReviewResult | null>();
  for (const target of await listTargets(root)) {
    const state = await readState(join(root, target), side, target);
    const judged = state.rounds.filter((round) => round.judged);
    results.set(target, judged.at(-1)?.result ?? null);
  }
  return results;
}

/**
 * Removes what `ogw review spec` left (core command.md `## spec review`): its input folders `ogw-review-spec-*` of
 * `ogw-temp/`, and the review file of each spec review agent job, which `ogw agent` writes alone in a
 * `ogw-review-file-*` folder of `ogw-temp/` with its run log (the folder goes), or the file alone when it is elsewhere.
 */
async function removeSpecReviews(ctx: Context): Promise<void> {
  const temp = await privateTempDir(ctx.env);
  const names = await readdir(temp).catch(() => []);
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
/** Clears the review state of the side; returns the agent worktrees and branches that could not be removed (core). */
export async function clearReviews(ctx: Context, side: 'core' | 'tool'): Promise<string[]> {
  const root = await reviewRoot(ctx, side);
  let left: string[] = [];
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
 */
async function removeLeftAgentWorktrees(ctx: Context): Promise<string[]> {
  const coreImpl = resolve((await ctx.workspace()).coreImpl);
  const left: string[] = [];
  for (const job of await listJobs(ctx.env)) {
    if (job.command !== 'agent' || job.status === 'running') continue;
    const place = (job.meta as AgentMeta).place;
    if (place.kind !== 'core-worktree' || resolve(place.coreImpl) !== coreImpl) continue;
    const worktree = join(place.worktrees, '_core', `agent-${job.id}`);
    if (exists(worktree)) await gitRaw(coreImpl, ['worktree', 'remove', '-f', '-f', worktree], { env: ctx.env });
    await gitRaw(coreImpl, ['worktree', 'unlock', worktree], { env: ctx.env });
    await gitRaw(coreImpl, ['worktree', 'prune'], { env: ctx.env });
    if (exists(worktree)) left.push(worktree);
    const branch = `agent/${job.id}`;
    if (await branchExists(coreImpl, branch, { env: ctx.env })) {
      await gitRaw(coreImpl, ['branch', '-D', branch], { env: ctx.env });
      if (await branchExists(coreImpl, branch, { env: ctx.env })) left.push(branch);
    }
  }
  return left;
}
