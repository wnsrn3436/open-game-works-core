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
 * The commit of the render pass `pass` that `module` of the native run of `engine` at `commit` takes for its render pass
 * not run on a locked screen (ogw.md `### Godot core test`), or null: the module's last recorded render pass, when it is
 * `pass` and no file under the paths of the module's key differs between its commit and `commit`. A last recorded
 * render pass that is `fail` gives none, and so does a commit git no longer has.
 */
export async function inheritedRenderPass(
  implDir: string,
  engine: string,
  module: string,
  commit: string,
  all: readonly CoreSpecModule[],
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  // the last record in which the module's render pass ran or was taken: a `fail` there leaves nothing to take
  const last = (await readTestRecords(implDir))
    .filter((record) => record.target === engine && recordOutcome(record, module).result !== 'unknown')
    .sort((a, b) => a.recordedAt - b.recordedAt)
    .at(-1);
  if (last === undefined || recordOutcome(last, module).result !== 'pass') return null;
  const from = last.inherited?.[module] ?? last.commit;
  const diff = await gitRaw(implDir, ['diff', '--name-only', '--no-renames', '-z', from, commit, '--'], { env });
  if (diff.code !== 0) return null;
  const changed = diff.stdout.split('\0').filter((path) => path !== '');
  return changed.some((path) => inKeyPaths(path, engine, module, all)) ? null : from;
}
