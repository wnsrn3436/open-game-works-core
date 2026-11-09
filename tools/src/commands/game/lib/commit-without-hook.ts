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
 * it staged leaves the index, and what was staged before stays: `paths` get back the index entries they had before they
 * were staged, and every meta file whose index entry the sync changed, also one of another staged source and also when
 * the sync itself fails after staging it, gets back the entry it had before the sync.
 */
export async function commitWithoutHook(ctx: Context, game: GameRepo, paths: readonly string[], message: string): Promise<string | null> {
  const options = { env: ctx.env };
  const before = await indexEntries(game.root, paths, ctx.env);
  await git(game.root, ['add', '--all', '--', ...paths], options);
  if ((await gitRaw(game.root, ['diff', '--cached', '--quiet', '--', ...paths], options)).code === 0) return null;
  let project: MetaProject | null = null;
  let metaBefore: Map<string, string> | null = null;
  try {
    project = await gameProject(ctx, game.name);
    metaBefore = await metaIndex(project, ctx.env);
    const sources = new Set(paths);
    const meta = (await syncStaged(ctx, project, ctx.env)).staged.filter((path) => sources.has(sourceOf(path)));
    const staged = [...new Set([...paths, ...meta])].sort();
    // `paths` and the meta files of the sync are staged; staging again fails for a deleted file already out of the index
    return await commitPaths(game.root, staged, message, { ...options, noVerify: true, staged: true });
  } catch (error) {
    await unstage(game.root, paths, before, project, metaBefore, ctx.env).catch(ignoreCleanupError);
    throw error;
  }
}

/**
 * The index entries of the files that `pathspecs`, taken literally, name and `keep` keeps, by checkout-relative path:
 * the `<mode> <object> <stage>` lines of the stages of a path, joined by `\n`.
 */
async function indexEntries(
  root: string,
  pathspecs: readonly string[],
  env: NodeJS.ProcessEnv,
  keep: (path: string) => boolean = () => true,
): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  if (pathspecs.length === 0) return entries;
  const out = await git(root, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...pathspecs], { env });
  for (const line of out.split('\0')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const path = line.slice(tab + 1);
    if (keep(path)) entries.set(path, [entries.get(path), line.slice(0, tab)].filter((e) => e !== undefined).join('\n'));
  }
  return entries;
}

/** The index entries of the project's meta files. */
function metaIndex(project: MetaProject, env: NodeJS.ProcessEnv): Promise<Map<string, string>> {
  return indexEntries(project.repo, project.areas, env, isMetaFile);
}

/**
 * Puts back in the index the entries `before` of `paths` and the entries `metaBefore` of the other meta files whose
 * index entry changed since then. A path that had no entry leaves the index.
 */
async function unstage(
  root: string,
  paths: readonly string[],
  before: Map<string, string>,
  project: MetaProject | null,
  metaBefore: Map<string, string> | null,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const target = new Map(paths.map((path) => [path, before.get(path)]));
  const now = await indexEntries(root, paths, env);
  if (project !== null && metaBefore !== null) {
    const meta = await metaIndex(project, env);
    for (const [path, entry] of meta) now.set(path, entry);
    for (const path of new Set([...metaBefore.keys(), ...meta.keys()])) if (!target.has(path)) target.set(path, metaBefore.get(path));
  }
  const changed = [...target].filter(([path, entry]) => entry !== now.get(path));
  if (changed.length === 0) return;
  // every stage of a changed path leaves the index, then the entries it had go back
  await git(root, ['update-index', '-z', '--force-remove', '--stdin'], { env, input: changed.map(([path]) => `${path}\0`).join('') });
  const lines = changed.flatMap(([path, entry]) => (entry === undefined ? [] : entry.split('\n').map((line) => `${line}\t${path}\0`)));
  if (lines.length > 0) await git(root, ['update-index', '-z', '--index-info'], { env, input: lines.join('') });
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
