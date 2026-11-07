import type { Context } from '../../../lib/command.ts';
import { ignoreCleanupError } from '../../../lib/errors.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { commitChangedPaths, commitPaths, git, gitRaw } from '../../../lib/git.ts';
import { staticCheckDetail, type StaticCheckDetail } from '../../check/static-api.ts';
import { gameProject, sourceOf } from '../../meta/lib/project.ts';
import { syncStaged } from '../../meta/sync.ts';
import { blockingFailures, settingsChangeOf } from './pre-commit.ts';

/**
 * A commit without the hook (ogw.md `## pre-commit hook`): stages `paths`, runs the hook's meta sync on the staged
 * files, and commits `paths` with the meta files that sync stages or removes for them, skipping the hook, whose static
 * check refuses content the game has not caught up with yet. The meta files of other staged sources stay out of it.
 * Returns the commit, or null when `paths` have no change (then no sync runs). When the sync or the commit fails, what
 * it staged leaves the index.
 */
export async function commitWithoutHook(ctx: Context, game: GameRepo, paths: readonly string[], message: string): Promise<string | null> {
  const options = { env: ctx.env };
  await git(game.root, ['add', '--all', '--', ...paths], options);
  if ((await gitRaw(game.root, ['diff', '--cached', '--quiet', '--', ...paths], options)).code === 0) return null;
  let staged = [...paths];
  try {
    const sources = new Set(paths);
    const meta = (await syncStaged(ctx, await gameProject(ctx, game.name), ctx.env)).staged.filter((path) => sources.has(sourceOf(path)));
    staged = [...new Set([...paths, ...meta])].sort();
    return await commitPaths(game.root, staged, message, { ...options, noVerify: true });
  } catch (error) {
    await git(game.root, ['reset', '--quiet', '--', ...staged], options).catch(ignoreCleanupError);
    throw error;
  }
}

/**
 * Prints, as the hook prints them, the failures of the static check of the checkout for which the pre-commit hook would
 * refuse `commit`, a commit without the hook, and returns those lines. A static check that cannot run prints its reason
 * and gives no line; the commit stays.
 */
export async function printHookFailures(ctx: Context, game: GameRepo, commit: string): Promise<string[]> {
  const files = await commitChangedPaths(game.root, commit, { env: ctx.env });
  let detail: StaticCheckDetail;
  try {
    detail = await staticCheckDetail(ctx, game, { stagedEnv: ctx.env });
  } catch (error) {
    ctx.log(`static check after the commit could not run: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  const settings = await settingsChangeOf(game.root, `${commit}^`, commit, ctx.env);
  const lines = blockingFailures(detail, files, settings).map((failure) => `${failure.where}: ${failure.message}`);
  for (const line of lines) ctx.log(line);
  return lines;
}
