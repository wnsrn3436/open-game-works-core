import { gitRaw } from '../../../lib/git.ts';
import type { CoreSpecModule } from './impl.ts';
import { readTestRecords, recordOutcome } from './test-records.ts';
import { keyPaths } from './test-reuse.ts';

/** Whether `path` is `folder` or under it. */
function under(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/**
 * Whether `path` is under the paths of the key of `module` in the native run of `engine` (ogw.md `## temp folder`): a
 * folder of the key, or a file of the engine package outside the module folders.
 */
export function inKeyPaths(path: string, engine: string, module: string, all: readonly CoreSpecModule[]): boolean {
  const { folders, packages, moduleFolders } = keyPaths({ kind: 'engine', engine, web: false }, module, all);
  return folders.some((folder) => under(path, folder)) || packages.some((p) => under(path, p) && !moduleFolders.some((folder) => under(path, folder)));
}

/**
 * The files that differ from the run commit, by render pass commit, or null for a commit git cannot diff. The diff does
 * not depend on the module, so the modules of one run share one map and git diffs each render pass commit once.
 */
export type ChangedPaths = Map<string, Promise<readonly string[] | null>>;

/** The files that differ between `from` and `commit`, diffed once per `from` through `changed`. */
function changedPaths(implDir: string, from: string, commit: string, changed: ChangedPaths, env: NodeJS.ProcessEnv): Promise<readonly string[] | null> {
  let paths = changed.get(from);
  if (paths === undefined) {
    paths = gitRaw(implDir, ['diff', '--name-only', '--no-renames', '-z', from, commit, '--'], { env }).then((diff) =>
      diff.code === 0 ? diff.stdout.split('\0').filter((path) => path !== '') : null,
    );
    changed.set(from, paths);
  }
  return paths;
}

/**
 * The commit of the render pass `pass` that `module` of the native run of `engine` at `commit` takes for its render pass
 * not run on a locked screen (ogw.md `### Godot core test`), or null. The last recorded render pass is the last record
 * in which the module is `pass` or `fail` and whose render pass commit differs from `commit` in no file under the paths
 * of the module's key; it gives its commit when it is `pass`, and null when it is `fail`. A record of other code is
 * passed over, and a commit git no longer has counts as other code. `changed` holds the diffs against `commit` that
 * the modules of one run share.
 */
export async function inheritedRenderPass(
  implDir: string,
  engine: string,
  module: string,
  commit: string,
  all: readonly CoreSpecModule[],
  env: NodeJS.ProcessEnv,
  changed: ChangedPaths = new Map(),
): Promise<string | null> {
  const ran = (await readTestRecords(implDir))
    .filter((record) => record.target === engine && recordOutcome(record, module).result !== 'unknown')
    .sort((a, b) => b.recordedAt - a.recordedAt);
  for (const record of ran) {
    const from = record.inherited?.[module] ?? record.commit;
    const paths = await changedPaths(implDir, from, commit, changed, env);
    if (paths === null || paths.some((path) => inKeyPaths(path, engine, module, all))) continue;
    return recordOutcome(record, module).result === 'pass' ? from : null;
  }
  return null;
}
