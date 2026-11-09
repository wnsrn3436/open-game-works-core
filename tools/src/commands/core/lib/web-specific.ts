import { basename } from 'node:path';
import { git } from '../../../lib/git.ts';
import { engineAssetRules } from './undefined.ts';

/** What a `.gd` file holds when it is browser runtime code (Godot `## test` of the engine-specific implementation rules). */
const WEB_MARKERS = ['JavaScriptBridge', '"Web"', '"web"'];

/**
 * Whether a path of `client/godot/` is a web-specific file by its path alone: `engine.json`, a file under `core/web/`,
 * or a file with `web` as a word of its name (the name split at `_`, `-` and `.`).
 */
export function webSpecificPath(path: string): boolean {
  return path === 'engine.json' || path.startsWith('core/web/') || basename(path).split(/[_.-]/).includes('web');
}

/** The content of `file` at `commit`. */
async function contentAt(repo: string, commit: string, file: string, env: NodeJS.ProcessEnv): Promise<string> {
  return git(repo, ['show', `${commit}:${file}`], { env });
}

/**
 * Whether the change from `from` to `to` of `open-game-works-core-impl/` (`repo`) changes a web-specific file of
 * `engine` (Godot `## test` of the engine-specific implementation rules): a file whose path is one (`webSpecificPath`),
 * or a `.gd` file whose content before or after the change holds `JavaScriptBridge`, `"Web"` or `"web"`. A rename is a
 * deletion and an addition, so both paths count.
 */
export async function webSpecificChange(repo: string, engine: string, from: string, to: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (engine !== 'godot') engineAssetRules(engine);
  const root = `client/${engine}/`;
  const changes = (await git(repo, ['diff', '--name-status', '--no-renames', from, to, '--', root], { env })).split('\n').filter((line) => line !== '');
  for (const line of changes) {
    const [status, file] = line.split('\t') as [string, string];
    if (webSpecificPath(file.slice(root.length))) return true;
    if (!file.endsWith('.gd')) continue;
    // an added file has no content before the change, a deleted one none after it
    const commits = [...(status === 'A' ? [] : [from]), ...(status === 'D' ? [] : [to])];
    for (const commit of commits) {
      const text = await contentAt(repo, commit, file, env);
      if (WEB_MARKERS.some((marker) => text.includes(marker))) return true;
    }
  }
  return false;
}
