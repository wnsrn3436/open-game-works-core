import type { Context } from '../../../lib/command.ts';
import { ignoreCleanupError } from '../../../lib/errors.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { commitChangedPaths, commitPaths, git, gitRaw } from '../../../lib/git.ts';
import { staticCheckDetail, type StaticCheckDetail } from '../../check/static-api.ts';
import { gameProject, isMetaFile, sourceOf, type MetaProject } from '../../meta/lib/project.ts';
import { syncStaged } from '../../meta/sync.ts';
import { blockingFailures, settingsChangeOf } from './pre-commit.ts';

/**
 * A commit without the hook (ogw.md `## pre-commit hook`): stages `paths`, runs the hook's meta sync on the staged
 * files, and commits `paths` with the meta files that sync stages or removes for them, skipping the hook, whose static
 * check refuses content the game has not caught up with yet. The meta files of other staged sources stay out of it.
 * Returns the commit, or null when `paths` have no change (then no sync runs). When the sync or the commit fails, what
 * it staged leaves the index: `paths`, and every meta file whose index entry the sync changed, also one of another
 * staged source and also when the sync itself fails after staging it.
 */
export async function commitWithoutHook(ctx: Context, game: GameRepo, paths: readonly string[], message: string): Promise<string | null> {
  const options = { env: ctx.env };
  await git(game.root, ['add', '--all', '--', ...paths], options);
  if ((await gitRaw(game.root, ['diff', '--cached', '--quiet', '--', ...paths], options)).code === 0) return null;
  let project: MetaProject | null = null;
  let before: Map<string, string> | null = null;
  try {
    project = await gameProject(ctx, game.name);
    before = await metaIndex(project, ctx.env);
    const sources = new Set(paths);
    const meta = (await syncStaged(ctx, project, ctx.env)).staged.filter((path) => sources.has(sourceOf(path)));
    const staged = [...new Set([...paths, ...meta])].sort();
    return await commitPaths(game.root, staged, message, { ...options, noVerify: true });
  } catch (error) {
    await unstage(game.root, paths, project, before, ctx.env).catch(ignoreCleanupError);
    throw error;
  }
}

/** The index entries (`<mode> <object> <stage>` lines) of the project's meta files, by checkout-relative path. */
async function metaIndex(project: MetaProject, env: NodeJS.ProcessEnv): Promise<Map<string, string>> {
  const out = await git(project.repo, ['ls-files', '--stage', '-z', '--', ...project.areas], { env });
  const entries = new Map<string, string>();
  for (const line of out.split('\0')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const path = line.slice(tab + 1);
    if (isMetaFile(path)) entries.set(path, [entries.get(path), line.slice(0, tab)].filter((e) => e !== undefined).join('\n'));
  }
  return entries;
}

/** Puts `paths` and the meta files whose index entry changed since `before` back to HEAD in the index. */
async function unstage(
  root: string,
  paths: readonly string[],
  project: MetaProject | null,
  before: Map<string, string> | null,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const changed = new Set(paths);
  if (project !== null && before !== null) {
    const after = await metaIndex(project, env);
    for (const path of new Set([...before.keys(), ...after.keys()])) if (before.get(path) !== after.get(path)) changed.add(path);
  }
  const input = [...changed].map((path) => `${path}\0`).join('');
  await git(root, ['--literal-pathspecs', 'reset', '--quiet', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input });
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
