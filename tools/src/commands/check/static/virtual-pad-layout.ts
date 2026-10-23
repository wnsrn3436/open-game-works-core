import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { repoPath } from './lib/files.ts';
import type { Expr } from './lib/gd-ast.ts';
import { numberValue } from './lib/gd-lexer.ts';
import { classIndex } from './lib/gd-shared.ts';
import { chainText, innerClasses } from './lib/gd-walk.ts';
import { instanceChain, nodeClass, scriptOf } from './lib/scene-classes.ts';
import { strOf, type Prop, type SceneNode, type TextScene } from './lib/tscn.ts';

/**
 * virtual pad layout (`virtual-pad-core` `### layout prefab`): `resource/prefab/` layout prefabs (root script
 * `VirtualPadLayout` or a subclass) use more than one `joystick_mode` (a value not written in the `.tscn` is the value of the
 * scene its root instances, else the script
 * default), or one layout has the same action twice among its root's direct `VirtualButton` `action` and
 * `VirtualJoystick` direction actions, the children of the scenes its root instances included.
 */
export const NAME = 'virtual pad layout';

const JOYSTICK_PROPS = ['action_negative_x', 'action_positive_x', 'action_negative_y', 'action_positive_y'];

/** Value of an enum member or number expression; null when it cannot be read. */
async function constantValue(sc: StaticContext, e: Expr | null): Promise<number | null> {
  if (e === null) return 0;
  if (e.k === 'num') return numberValue(e.text);
  if (e.k === 'unary' && e.op === '-' && e.expr.k === 'num') return -numberValue(e.expr.text);
  return e.k === 'member' ? enumValue(sc, e) : null;
}

/** Value of `Owner.Enum.MEMBER` or `Enum.MEMBER` (owner `VirtualPadCore`). */
async function enumValue(sc: StaticContext, e: Extract<Expr, { k: 'member' }>): Promise<number | null> {
  const chain = chainText(e)?.split('.') ?? [];
  if (chain.length < 2) return null;
  const enumName = chain[chain.length - 2] as string;
  const owner = chain.length >= 3 ? (chain[chain.length - 3] as string) : 'VirtualPadCore';
  const ref = await (await classIndex(sc)).byName(owner);
  const decl = ref ? [ref.cls, ...innerClasses(ref.cls)].flatMap((c) => c.body).find((s) => s.k === 'enum' && s.name === enumName) : undefined;
  if (decl?.k !== 'enum') return null;
  let next = 0;
  for (const m of decl.members) {
    const v = m.value ? await constantValue(sc, m.value) : next;
    if (v === null) return null;
    if (m.name === e.name) return v;
    next = v + 1;
  }
  return null;
}

/** Base scenes of a scene: the scene its root instances, then that scene's base, and so on. */
async function baseScenes(sc: StaticContext, scene: TextScene): Promise<TextScene[]> {
  const root = scene.nodes[0];
  return root ? instanceChain(sc, scene, root) : [];
}

/** `joystick_mode` of a layout root: the `.tscn` value, else the value of the base scene chain, else the script default. */
async function joystickMode(sc: StaticContext, scene: TextScene, root: SceneNode): Promise<number | null> {
  for (const s of [scene, ...(await baseScenes(sc, scene))]) {
    const written = s.nodes[0]?.props.get('joystick_mode')?.value;
    if (written?.t === 'num') return written.v;
  }
  const script = await scriptOf(sc, scene, root);
  const path = script === null ? null : repoPath(script);
  const index = await classIndex(sc);
  const ref = path === null ? null : await index.byPath(path);
  const member = ref ? await index.member(ref, 'joystick_mode') : null;
  return member?.decl.k === 'var' ? constantValue(sc, member.decl.value) : null;
}

/** A direct child of a layout root, with its properties merged over the base scene chain and where each was written. */
interface RootChild {
  scene: TextScene;
  node: SceneNode;
  props: Map<string, { prop: Prop; file: string }>;
}

/** Direct children of the root, base scene children first; a derived node of the same name without a type overrides its properties. */
async function rootChildren(sc: StaticContext, scene: TextScene): Promise<Map<string, RootChild>> {
  const out = new Map<string, RootChild>();
  for (const s of [scene, ...(await baseScenes(sc, scene))].reverse()) {
    for (const node of s.nodes.filter((n) => n.parent === '.')) {
      const own = new Map([...node.props].map(([k, prop]) => [k, { prop, file: s.path }]));
      const inherited = out.get(node.name);
      if (inherited && node.type === null && node.instance === null && !node.props.has('script')) {
        out.set(node.name, { ...inherited, props: new Map([...inherited.props, ...own]) });
      } else {
        out.set(node.name, { scene: s, node, props: own });
      }
    }
  }
  return out;
}

async function duplicateActions(sc: StaticContext, path: string, scene: TextScene): Promise<Finding[]> {
  const seen = new Map<string, string>();
  const out: Finding[] = [];
  for (const child of (await rootChildren(sc, scene)).values()) {
    const cls = await nodeClass(sc, child.scene, child.node, ['VirtualButton', 'VirtualJoystick']);
    const props = cls === 'VirtualButton' ? ['action'] : cls === 'VirtualJoystick' ? JOYSTICK_PROPS : [];
    for (const prop of props) {
      const written = child.props.get(prop);
      const value = strOf(written?.prop.value);
      if (value === null || value === '') continue;
      const first = seen.get(value);
      // A value written in a base scene is reported at the root of this layout.
      const where = written?.file === path ? at(path, written.prop.line) : at(path, scene.nodes[0]?.line ?? 1);
      if (first !== undefined) out.push(finding(NAME, where, `action \`${value}\` of \`${child.node.path}\` is also used by \`${first}\``));
      else seen.set(value, child.node.path);
    }
  }
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const out: Finding[] = [];
  const modes: { path: string; line: number; mode: number | null }[] = [];
  for (const path of sc.filter((p) => p.startsWith('resource/prefab/') && p.endsWith('.tscn'))) {
    const scene = await sc.scene(path);
    const root = scene.nodes[0];
    if (!root || (await nodeClass(sc, scene, root, ['VirtualPadLayout'])) === null) continue;
    modes.push({ path, line: root.line, mode: await joystickMode(sc, scene, root) });
    out.push(...(await duplicateActions(sc, path, scene)));
  }
  const distinct = new Set(modes.map((m) => m.mode));
  if (distinct.size > 1) {
    const values = [...distinct].map((v) => (v === null ? 'unknown' : String(v))).join(', ');
    for (const m of modes) out.push(finding(NAME, at(m.path, m.line), `layout prefabs use more than one \`joystick_mode\` (${values}); this one uses ${m.mode === null ? 'unknown' : String(m.mode)}`));
  }
  return out;
}
