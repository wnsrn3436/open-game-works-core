import type { StaticContext } from './context.ts';
import { repoPath } from './files.ts';
import { classIndex } from './gd-shared.ts';
import { nodeInstance, nodeScript, type SceneNode, type TextScene } from './tscn.ts';

/** Instance chains and scripts of scene nodes, and whether the scripts inherit from a core class. */

/** Most scenes followed along one instance chain, so a scene that instances itself ends the walk. */
const MAX_INSTANCE_DEPTH = 8;

/**
 * Scenes of a node's instance chain: the scene the node instances, then the scene that scene's root instances, and so
 * on, at most `MAX_INSTANCE_DEPTH`; empty when the node instances no scene of the repo.
 */
export async function instanceChain(sc: StaticContext, scene: TextScene, node: SceneNode): Promise<TextScene[]> {
  const out: TextScene[] = [];
  let at: { scene: TextScene; node: SceneNode } | null = { scene, node };
  while (at !== null && out.length < MAX_INSTANCE_DEPTH) {
    const inst = nodeInstance(at.scene, at.node);
    const path = inst === null ? null : repoPath(inst);
    if (path === null || !sc.has(path)) break;
    const sub = await sc.scene(path);
    out.push(sub);
    const root = sub.nodes[0];
    at = root ? { scene: sub, node: root } : null;
  }
  return out;
}

/** Script `res://` path of a node: its own `script`, else the root script of the nearest scene of its instance chain. */
export async function scriptOf(sc: StaticContext, scene: TextScene, node: SceneNode): Promise<string | null> {
  const own = nodeScript(scene, node);
  if (own !== null) return own;
  for (const sub of await instanceChain(sc, scene, node)) {
    const root = sub.nodes[0];
    const script = root ? nodeScript(sub, root) : null;
    if (script !== null) return script;
  }
  return null;
}

/** True when the script at `res` is the class `base` or inherits from it. */
export async function scriptIsA(sc: StaticContext, res: string | null, base: string): Promise<boolean> {
  if (res === null) return false;
  const path = repoPath(res);
  if (path === null) return false;
  const index = await classIndex(sc);
  const ref = await index.byPath(path);
  return ref ? index.isA(ref, base) : false;
}

/** The first of `bases` the node's script is or inherits from, or null. */
export async function nodeClass(sc: StaticContext, scene: TextScene, node: SceneNode, bases: readonly string[]): Promise<string | null> {
  const script = await scriptOf(sc, scene, node);
  for (const base of bases) if (await scriptIsA(sc, script, base)) return base;
  return null;
}

/** `.tscn` files under `resource/scene/` and `resource/prefab/`. */
export function sceneFiles(sc: StaticContext): string[] {
  return sc.filter((p) => /^resource\/(scene|prefab)\/.+\.tscn$/.test(p));
}
