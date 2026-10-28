import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { commitPaths, currentBranch, git, head, statusLines } from '../../../lib/git.ts';
import { listJobs, type JobRecord } from '../../../lib/jobs.ts';
import { openRun, withRunLock } from '../../../lib/runstate.ts';

/** The job command of `ogw judge calibrate --background`. */
export const CALIBRATE_COMMAND = 'judge calibrate';

/** A running `ogw judge calibrate` job of the game other than the calling job; null when there is none. */
export async function calibrationJob(ctx: Context, game: string): Promise<JobRecord | null> {
  const jobs = await listJobs(ctx.env);
  return jobs.find((job) => job.command === CALIBRATE_COMMAND && job.game === game && job.status === 'running' && job.id !== ctx.jobId) ?? null;
}

/** Fails while an `ogw judge calibrate` job of the game runs (`ogw loop start`, `ogw build start`, `ogw judge label`). */
export async function refuseWhileCalibrating(ctx: Context, game: string): Promise<void> {
  const job = await calibrationJob(ctx, game);
  if (job !== null) throw new OgwError(`ogw judge calibrate job ${job.id} of game ${game} is running; wait for it with ogw job wait ${job.id}`, 1, { job: job.id });
}

/**
 * The start of `ogw judge calibrate` and `ogw judge label` (`game-loop` `## judge calibration`): no open run, no other
 * `ogw judge calibrate` job of the game, no change in the game repo checkout; then main checked out. Returns main HEAD.
 */
export async function prepareMain(ctx: Context, game: GameRepo): Promise<string> {
  const run = await openRun(game);
  if (run) throw new OgwError(`game ${game.name} has an open run: ${run.name}`, 1, { run: run.name });
  await refuseWhileCalibrating(ctx, game.name);
  const changes = await statusLines(game.root, { env: ctx.env });
  if (changes.length > 0) throw new OgwError(`game repo checkout has changes:\n${changes.join('\n')}`, 1, { changes });
  if ((await currentBranch(game.root, { env: ctx.env })) !== 'main') await git(game.root, ['checkout', '--quiet', 'main'], { env: ctx.env });
  return head(game.root, { env: ctx.env });
}

/**
 * Commits the paths on main under the run lock, so that no run starts from a main that moves under it. Fails when a run
 * opened or the checkout left main meanwhile.
 */
export async function commitOnMain(ctx: Context, game: GameRepo, paths: readonly string[], message: string): Promise<string | null> {
  return withRunLock(game, async () => {
    const run = await openRun(game);
    if (run) throw new OgwError(`game ${game.name} has an open run ${run.name}; nothing committed on main`, 1, { run: run.name });
    if ((await currentBranch(game.root, { env: ctx.env })) !== 'main') throw new OgwError('the game repo checkout is not on main; nothing committed');
    return commitPaths(game.root, paths, message, { env: ctx.env });
  });
}
