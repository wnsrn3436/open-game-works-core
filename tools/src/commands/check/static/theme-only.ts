import { at, finding, type Finding, type StaticContext } from './lib/context.ts';

/**
 * theme only: a scene or prefab `.tscn` takes its look from the theme of the game through `theme_type_variation`, so it
 * holds no `theme_override_*` property, no `theme` property and no `StyleBoxFlat` (`client-content` Godot `## scene and prefab`).
 */
export const NAME = 'theme only';

function isSceneOrPrefab(path: string): boolean {
  return (path.startsWith('resource/scene/') || path.startsWith('resource/prefab/')) && path.endsWith('.tscn');
}

function problem(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.startsWith('theme_override_')) return `${trimmed.split(' ')[0] ?? trimmed} sets a style of its own; give the node a theme_type_variation of the theme`;
  if (/^theme\s*=/.test(trimmed)) return 'theme property; the theme of the game applies to every node';
  if (/^\[sub_resource type="StyleBoxFlat"/.test(trimmed)) return 'StyleBoxFlat; panel and button styles are StyleBoxTexture of the theme';
  return null;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const results = await Promise.all(
    sc.filter(isSceneOrPrefab).map(async (path) => {
      const out: Finding[] = [];
      (await sc.text(path)).split('\n').forEach((line, i) => {
        const message = problem(line);
        if (message !== null) out.push(finding(NAME, at(path, i + 1), message));
      });
      return out;
    }),
  );
  return results.flat();
}
