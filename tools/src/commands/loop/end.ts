import { join } from 'node:path';
import { expectPositionals, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { exists } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { branchExists, gitRaw } from '../../lib/git.ts';
import { killJob } from '../../lib/jobs.ts';
import type { RunResult } from '../../lib/proc.ts';
import { changeOpenRunLocked, withRunLock, type RunState } from '../../lib/runstate.ts';
import { releasePendingProposals } from '../core/api.ts';
import { stopInstance, unfailedInstances } from '../instance/api.ts';
import { isAgentJob, runJobs } from './lib/jobs.ts';
import { openTarget } from './lib/run.ts';

const USAGE = 'ogw loop end <game>';

/** Instances of the game started while the run is open and not `failed`, starting ones included. */
export async function runInstances(ctx: Context, game: GameRepo, run: RunState): Promise<string[]> {
  return (await unfailedInstances(ctx, game.name)).filter((i) => i.startedAt >= run.startedAt).map((i) => i.id);
}

interface Removal {
  removed: string[];
  /** What is still there, with why it could not be removed. */
  notRemoved: { what: string; error: string }[];
}

function gitError(result: RunResult): string {
  return (result.stderr || result.stdout).trim() || `exit ${String(result.code)}`;
}

/**
 * Removes the agent worktrees and branches that are left. `-f -f` also removes a worktree that an interrupted
 * `git worktree add` left locked. Only what is gone afterwards counts as removed.
 */
async function removeAgentWorktrees(ctx: Context, game: GameRepo, ids: readonly string[]): Promise<Removal> {
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

export const loopEnd: CommandDef = {
  name: ['loop', 'end'],
  usage: USAGE,
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const { game, run } = await openTarget(ctx, positional(args, 0, 'game'));
    // jobs first: a job waiting for an instance slot would take the slot a stopped instance frees
    const jobs = await runJobs(ctx, game, run);
    const killed = jobs.filter((job) => job.status === 'running' && job.id !== ctx.jobId).map((job) => job.id);
    await Promise.all(killed.map((id) => killJob(id, ctx.env)));
    const instances = await runInstances(ctx, game, run);
    for (const id of instances) await stopInstance(ctx, id);
    const { removed, notRemoved: leftOver } = await removeAgentWorktrees(ctx, game, jobs.filter(isAgentJob).map((job) => job.id));
    // One run lock over closing and marking: a run that starts in between would get a moved base commit.
    const proposals = await withRunLock(game, async () => {
      await changeOpenRunLocked(game, (open) => {
        open.closedAt = Date.now();
      });
      return releasePendingProposals(ctx, game);
    });
    const released = proposals.filter((p) => p.error === null).map((p) => p.proposalFile);
    const notReleased = proposals.filter((p) => p.error !== null);
    const lines = [
      `closed run ${run.name}`,
      ...instances.map((id) => `stopped instance ${id}`),
      ...killed.map((id) => `stopped job ${id}`),
      ...removed.map((what) => `removed ${what}`),
      ...leftOver.map((l) => `not removed ${l.what}: ${l.error}`),
      ...released.map((file) => `marked released ${file}`),
      ...notReleased.map((p) => `not marked released ${p.proposalFile} ${p.version}: ${p.error ?? ''}`),
    ];
    return {
      exitCode: notReleased.length > 0 || leftOver.length > 0 ? 1 : 0,
      text: lines.join('\n'),
      data: { run: run.name, instances, jobs: killed, removed, notRemoved: leftOver, released, notReleased },
    };
  },
};
