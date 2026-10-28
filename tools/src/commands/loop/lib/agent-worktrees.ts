import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { exists } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { branchExists, gitRaw } from '../../../lib/git.ts';
import type { JobRecord } from '../../../lib/jobs.ts';
import type { RunResult } from '../../../lib/proc.ts';
import type { RunState } from '../../../lib/runstate.ts';
import { roleOf } from './jobs.ts';

export interface Removal {
  removed: string[];
  /** What is still there, with why it could not be removed. */
  notRemoved: { what: string; error: string }[];
}

function gitError(result: RunResult): string {
  return (result.stderr || result.stdout).trim() || `exit ${String(result.code)}`;
}

/**
 * Removes the agent worktrees `worktrees/<game>/agent-<id>/` and branches `agent/<id>` that are left. `-f -f` also
 * removes a worktree that an interrupted `git worktree add` left locked. Only what is gone afterwards counts as removed.
 */
export async function removeAgentWorktrees(ctx: Context, game: GameRepo, ids: readonly string[]): Promise<Removal> {
  const worktrees = (await ctx.workspace()).worktrees;
  const out: Removal = { removed: [], notRemoved: [] };
  for (const id of ids) {
    const path = join(worktrees, game.name, `agent-${id}`);
    if (exists(path)) {
      const result = await gitRaw(game.mainRoot, ['worktree', 'remove', '-f', '-f', path], { env: ctx.env });
      await gitRaw(game.mainRoot, ['worktree', 'prune'], { env: ctx.env });
      if (exists(path)) out.notRemoved.push({ what: path, error: gitError(result) });
      else out.removed.push(path);
    }
    const branch = `agent/${id}`;
    if (await branchExists(game.mainRoot, branch, { env: ctx.env })) {
      const result = await gitRaw(game.mainRoot, ['branch', '-D', branch], { env: ctx.env });
      if (await branchExists(game.mainRoot, branch, { env: ctx.env })) out.notRemoved.push({ what: branch, error: gitError(result) });
      else out.removed.push(branch);
    }
  }
  return out;
}

/** The variant agent jobs of `ogw loop variants` of the run, of iteration `iteration` when given. */
export function variantJobs(jobs: readonly JobRecord[], run: RunState, iteration?: number): JobRecord[] {
  return jobs.filter(
    (job) =>
      roleOf(job) === 'content' &&
      job.meta.run === run.name &&
      typeof job.meta.variant === 'number' &&
      (iteration === undefined || job.meta.iteration === iteration),
  );
}

/** Removes what the variant agents of the run that ended and were not merged left (`game-loop` `## resume` 5). */
export async function removeVariantLeftovers(ctx: Context, game: GameRepo, run: RunState, jobs: readonly JobRecord[]): Promise<Removal> {
  const left = variantJobs(jobs, run).filter((job) => job.status !== 'running' && job.meta.merged !== true);
  return removeAgentWorktrees(ctx, game, left.map((job) => job.id));
}
