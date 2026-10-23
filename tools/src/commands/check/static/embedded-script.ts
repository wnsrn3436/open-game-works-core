import { at, finding, type Finding, type StaticContext } from './lib/context.ts';

/** embedded script: `type="GDScript"` inside a `.tscn` or `.tres` (Godot `## scene and prefab`). */
export const NAME = 'embedded script';

const SKIP = ['client/core/', 'client/addons/', 'client/.godot/', 'client/build/', 'client/android/', 'client/ios/', 'client/resource/'];

function isSceneOrResource(path: string): boolean {
  return (path.startsWith('client/') || path.startsWith('resource/')) && /\.(tscn|tres)$/.test(path) && !SKIP.some((p) => path.startsWith(p));
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const results = await Promise.all(
    sc.filter(isSceneOrResource).map(async (path) => {
      const out: Finding[] = [];
      (await sc.text(path)).split('\n').forEach((line, i) => {
        if (line.includes('type="GDScript"')) out.push(finding(NAME, at(path, i + 1), 'script embedded in the file; put it in a `.gd` file'));
      });
      return out;
    }),
  );
  return results.flat();
}
