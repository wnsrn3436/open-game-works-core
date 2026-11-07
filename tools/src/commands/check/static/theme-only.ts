import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isClientContentGd, isClientDev, isClientTest, repoPath } from './lib/files.ts';
import type { Expr, GdFile } from './lib/gd-ast.ts';
import { classIndex, resolverFor } from './lib/gd-shared.ts';
import type { TypeResolver } from './lib/gd-types.ts';
import { visitClass } from './lib/gd-walk.ts';
import { instanceChain } from './lib/scene-classes.ts';
import { codeColor, colorText, isTint, scriptConsts, variantColor } from './lib/tint.ts';
import { extIdOf, nodeScript, strOf, type Prop, type SceneNode, type Section, type TextScene, type Variant } from './lib/tscn.ts';

/**
 * theme only: a scene or prefab `.tscn` takes its look from the theme of the game through `theme_type_variation`, so it
 * holds no `theme_override_*` property, no `theme` property and no `StyleBoxFlat`; and no `NinePatchRect`, `TextureRect` or
 * `TextureButton` whose texture is a `nine_slice` or `image` resource, and no `StyleBoxTexture` whose `texture` is one, has
 * a tint (`client-content` Godot `## scene and prefab`): written in a `.tscn` or `.tres` of `resource/` or of client
 * content outside `client/dev/` and `client/tests/`, or assigned from a `Color` value written in code by the script of a
 * node of a scene or prefab to that node or to a node of the same scene that an `@onready var` node path or an
 * `@export var` node of that script names.
 */
export const NAME = 'theme only';

function isSceneOrPrefab(path: string): boolean {
  return (path.startsWith('resource/scene/') || path.startsWith('resource/prefab/')) && path.endsWith('.tscn');
}

/** `.tscn` and `.tres` files whose tints the check reads. */
function isTintFile(path: string): boolean {
  if (!path.endsWith('.tscn') && !path.endsWith('.tres')) return false;
  if (path.startsWith('resource/')) return true;
  return isClientContentGd(path.replace(/\.(tscn|tres)$/, '.gd')) && !isClientDev(path) && !isClientTest(path);
}

function problem(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.startsWith('theme_override_')) return `${trimmed.split(' ')[0] ?? trimmed} sets a style of its own; give the node a theme_type_variation of the theme`;
  if (/^theme\s*=/.test(trimmed)) return 'theme property; the theme of the game applies to every node';
  if (/^\[sub_resource type="StyleBoxFlat"/.test(trimmed)) return 'StyleBoxFlat; panel and button styles are StyleBoxTexture or StyleBoxEmpty of the theme';
  return null;
}

/** The node classes that show a texture, and their texture properties. */
const TEXTURE_PROPS: Record<string, readonly string[]> = {
  NinePatchRect: ['texture'],
  TextureRect: ['texture'],
  TextureButton: ['texture_normal', 'texture_pressed', 'texture_hover', 'texture_disabled', 'texture_focused'],
};
const NODE_TINTS = ['modulate', 'self_modulate'];
const ART_TYPES = new Set(['nine_slice', 'image']);

/** The `nine_slice` or `image` resource key that a texture value of `scene` names, or null. */
function artKey(scene: TextScene, value: Variant | undefined): string | null {
  const id = extIdOf(value);
  const path = id === null ? null : scene.ext.get(id)?.path;
  const m = path ? /^res:\/\/resource\/(([a-z_0-9]+)\/.+)\.[A-Za-z0-9]+$/.exec(path) : null;
  return m && ART_TYPES.has(m[2] as string) ? (m[1] as string) : null;
}

interface ShownArt {
  cls: string;
  key: string;
}

/** The class of a node and the `nine_slice` or `image` it shows: its own type and texture, else those of its instance chain. */
async function shownArt(sc: StaticContext, scene: TextScene, node: SceneNode): Promise<ShownArt | null> {
  const chain: { scene: TextScene; node: SceneNode }[] = [{ scene, node }];
  for (const sub of await instanceChain(sc, scene, node)) {
    const root = sub.nodes[0];
    if (root) chain.push({ scene: sub, node: root });
  }
  const cls = chain.map((c) => c.node.type).find((t) => t !== null) ?? null;
  const props = cls === null ? undefined : TEXTURE_PROPS[cls];
  if (cls === null || props === undefined) return null;
  for (const c of chain) {
    for (const prop of props) {
      const p = c.node.props.get(prop);
      if (p === undefined) continue;
      const key = artKey(c.scene, p.value);
      if (key !== null) return { cls, key };
    }
  }
  return null;
}

function tintFinding(path: string, prop: Prop, name: string, what: string): Finding | null {
  const color = variantColor(prop.value);
  if (color === null || !isTint(color)) return null;
  return finding(NAME, at(path, prop.line), `\`${name}\` ${colorText(color)} tints ${what}; draw the color in its art, or change only alpha`);
}

function styleBoxFindings(path: string, scene: TextScene, section: Section): Finding[] {
  const key = artKey(scene, section.props.get('texture')?.value);
  const prop = section.props.get('modulate_color');
  if (key === null || prop === undefined) return [];
  const f = tintFinding(path, prop, 'modulate_color', `StyleBoxTexture of \`${key}\``);
  return f ? [f] : [];
}

async function fileTintFindings(sc: StaticContext, path: string): Promise<Finding[]> {
  const scene = await sc.scene(path);
  const out: Finding[] = [];
  for (const section of scene.sections) {
    const type = strOf(section.attrs.type);
    const isStyleBox = (section.tag === 'sub_resource' && type === 'StyleBoxTexture') || (section.tag === 'resource' && strOf(scene.header?.attrs.type) === 'StyleBoxTexture');
    if (isStyleBox) out.push(...styleBoxFindings(path, scene, section));
  }
  for (const node of scene.nodes) {
    const tints = NODE_TINTS.flatMap((name) => {
      const prop = node.props.get(name);
      return prop ? [{ name, prop }] : [];
    });
    if (tints.length === 0) continue;
    const art = await shownArt(sc, scene, node);
    if (art === null) continue;
    for (const { name, prop } of tints) {
      const f = tintFinding(path, prop, name, `${art.cls} \`${node.path}\` of \`${art.key}\``);
      if (f) out.push(f);
    }
  }
  return out;
}

/** `node` path joined with a relative node path: `.` is the root, `..` goes up. Null when it leaves the scene. */
function joinNodePath(from: string, rel: string): string | null {
  const parts = from === '.' ? [] : from.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length === 0 ? '.' : parts.join('/');
}

/** The scene node a node path of a script on `owner` names: `$A/B`, `get_node("A/B")`, a `NodePath("A/B")`, `%Unique`. */
function namedNode(scene: TextScene, owner: SceneNode, path: string, unique: boolean): SceneNode | null {
  if (unique) return scene.nodes.find((n) => n.name === path && n.props.get('unique_name_in_owner')?.value.t === 'bool' && (n.props.get('unique_name_in_owner')?.value as { v: boolean }).v) ?? null;
  const full = joinNodePath(owner.path, path);
  return full === null ? null : (scene.nodes.find((n) => n.path === full) ?? null);
}

/** The node an `@onready var` value names: `$Path`, `%Name`, `get_node("Path")`, optionally cast with `as`. */
function onreadyNode(scene: TextScene, owner: SceneNode, value: Expr): SceneNode | null {
  const e = value.k === 'cast' ? value.expr : value;
  if (e.k === 'nodepath') return namedNode(scene, owner, e.path, e.sigil === '%');
  if (e.k === 'call' && e.callee.k === 'name' && (e.callee.name === 'get_node' || e.callee.name === 'get_node_or_null') && e.args[0]?.k === 'str') {
    return namedNode(scene, owner, e.args[0].value, false);
  }
  return null;
}

/** The node an `@export var` of `owner` names in the `.tscn`: its `NodePath("...")` value. */
function exportNode(scene: TextScene, owner: SceneNode, field: string): SceneNode | null {
  const v = owner.props.get(field)?.value;
  if (v?.t !== 'call' || v.name !== 'NodePath') return null;
  const path = strOf(v.args[0]);
  return path === null ? null : namedNode(scene, owner, path, false);
}

/** Fields of the script class that name a node showing art, and whether the script's own node shows art. */
async function artTargets(sc: StaticContext, scene: TextScene, owner: SceneNode, file: GdFile): Promise<Map<string, ShownArt & { node: string }>> {
  const out = new Map<string, ShownArt & { node: string }>();
  for (const s of file.top.body) {
    if (s.k !== 'var' || s.isConst) continue;
    const isOnready = s.annotations.some((a) => a.name === 'onready');
    const isExport = s.annotations.some((a) => a.name === 'export');
    const target = isOnready && s.value ? onreadyNode(scene, owner, s.value) : isExport ? exportNode(scene, owner, s.name) : null;
    const art = target ? await shownArt(sc, scene, target) : null;
    if (art && target) out.set(s.name, { ...art, node: target.path });
  }
  return out;
}

interface CodeTint {
  line: number;
  field: string | null;
  property: string;
  value: Expr;
  resolver: TypeResolver;
}

/** Assignments with `=` to `modulate` or `self_modulate` of `self`, of a bare name, or of a field (`<field>.modulate`). */
function codeTints(file: GdFile, index: Awaited<ReturnType<typeof classIndex>>): CodeTint[] {
  const out: CodeTint[] = [];
  const cache = new Map<unknown, TypeResolver>();
  visitClass(file.top, {
    stmt(s, scope) {
      if (s.k !== 'assign' || s.op !== '=' || scope.cls !== file.top) return;
      const t = s.target;
      const resolver = resolverFor(index, file, scope, cache);
      if (t.k === 'name' && NODE_TINTS.includes(t.name) && !resolver.isLocal(t.name)) out.push({ line: s.line, field: null, property: t.name, value: s.value, resolver });
      if (t.k !== 'member' || !NODE_TINTS.includes(t.name)) return;
      if (t.obj.k === 'name' && t.obj.name === 'self') out.push({ line: s.line, field: null, property: t.name, value: s.value, resolver });
      else if (t.obj.k === 'name' && !resolver.isLocal(t.obj.name)) out.push({ line: s.line, field: t.obj.name, property: t.name, value: s.value, resolver });
    },
  });
  return out;
}

async function scriptTintFindings(sc: StaticContext, path: string): Promise<Finding[]> {
  const scene = await sc.scene(path);
  const index = await classIndex(sc);
  const out: Finding[] = [];
  for (const owner of scene.nodes) {
    const res = nodeScript(scene, owner);
    const gdPath = res === null ? null : repoPath(res);
    if (gdPath === null || !sc.has(gdPath) || !isClientContentGd(gdPath)) continue;
    const file = await sc.gd(gdPath);
    const assigns = codeTints(file, index);
    if (assigns.length === 0) continue;
    const consts = scriptConsts(file);
    const fields = await artTargets(sc, scene, owner, file);
    const self = await shownArt(sc, scene, owner);
    for (const a of assigns) {
      const target = a.field === null ? (self ? { ...self, node: owner.path } : null) : (fields.get(a.field) ?? null);
      const color = target ? codeColor(a.value, consts) : null;
      if (target === null || color === null || !isTint(color)) continue;
      const what = `${target.cls} \`${target.node}\` of \`${target.key}\` in ${path}`;
      const written = file.tokens.slice(a.value.t0, a.value.t1 + 1).map((t) => t.text).join('');
      out.push(finding(NAME, at(gdPath, a.line), `\`${a.property}\` \`${written}\` tints ${what}; draw the color in its art, or change only alpha`));
    }
  }
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const style = await Promise.all(
    sc.filter(isSceneOrPrefab).map(async (path) => {
      const out: Finding[] = [];
      (await sc.text(path)).split('\n').forEach((line, i) => {
        const message = problem(line);
        if (message !== null) out.push(finding(NAME, at(path, i + 1), message));
      });
      return out;
    }),
  );
  const tints = await Promise.all(sc.filter(isTintFile).map((path) => fileTintFindings(sc, path)));
  const code = await Promise.all(sc.filter(isSceneOrPrefab).map((path) => scriptTintFindings(sc, path)));
  const seen = new Set<string>();
  return [...style.flat(), ...tints.flat(), ...code.flat()].filter((f) => {
    const id = `${f.where}\n${f.message}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
