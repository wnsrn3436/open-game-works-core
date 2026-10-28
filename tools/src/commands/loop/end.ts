import { expectPositionals, positional, type CommandDef, type Context } from '../../lib/command.ts';
import type { GameRepo } from '../../lib/game.ts';
import { killJob } from '../../lib/jobs.ts';
import { changeOpenRunLocked, withRunLock, type RunState } from '../../lib/runstate.ts';
import { releasePendingProposals } from '../core/api.ts';
import { stopInstance, unfailedInstances } from '../instance/api.ts';
import { removeAgentWorktrees } from './lib/agent-worktrees.ts';
import { isAgentJob, runJobs } from './lib/jobs.ts';
import { openTarget } from './lib/run.ts';

const USAGE = 'ogw loop end <game>';

/** Instances of the game started while the run is open and not `failed`, starting ones included. */
export async function runInstances(ctx: Context, game: GameRepo, run: RunState): Promise<string[]> {
  return (await unfailedInstances(ctx, game.name)).filter((i) => i.startedAt >= run.startedAt).map((i) => i.id);
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
