import type { Variant, TextScene } from './lib/tscn.ts';
import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { repoPath } from './lib/files.ts';

/**
 * scene links: the links inside a content `.tscn` or `.tres` hold (`client-content` Godot `## scene and prefab`): an
 * `ext_resource` path names a file with the same letter case (an export runs on case-sensitive file systems), each
 * `ext_resource` and `sub_resource` id is declared once and every `ExtResource` and `SubResource` id is declared, a
 * scene has one root, and every `parent` and `[connection]` node path is a node of the scene.
 */
export const NAME = 'scene links';

/** Content folders whose `.tscn` and `.tres` are checked, and the `res://` folders whose files are in the repo. */
const CONTENT = ['resource/', 'client/features/', 'client/common/', 'client/boot/', 'client/dev/'];
const LINKED = ['res://resource/', 'res://features/', 'res://common/', 'res://boot/', 'res://dev/'];

function isContentScene(path: string): boolean {
  return CONTENT.some((p) => path.startsWith(p)) && /\.(tscn|tres)$/.test(path);
}

/** Every `ExtResource("id")` and `SubResource("id")` inside a value, with the call name. */
function references(value: Variant, out: { call: string; id: string }[]): void {
  if (value.t === 'call') {
    const id = value.args[0];
    if ((value.name === 'ExtResource' || value.name === 'SubResource') && id?.t === 'str') out.push({ call: value.name, id: id.v });
    for (const arg of value.args) references(arg, out);
  } else if (value.t === 'arr') {
    for (const item of value.items) references(item, out);
  } else if (value.t === 'dict') {
    for (const entry of value.entries) {
      references(entry.key, out);
      references(entry.value, out);
    }
  }
}

function idProblems(scene: TextScene): Finding[] {
  const out: Finding[] = [];
  const seen = new Map<string, Set<string>>([['ext_resource', new Set()], ['sub_resource', new Set()]]);
  for (const section of scene.sections) {
    const ids = seen.get(section.tag);
    if (ids === undefined) continue;
    const id = section.attrs.id;
    const text = id?.t === 'str' ? id.v : id?.t === 'num' ? id.text : null;
    if (text === null) continue;
    if (ids.has(text)) out.push(finding(NAME, at(scene.path, section.line), `${section.tag} id "${text}" is declared twice`));
    ids.add(text);
  }
  for (const section of scene.sections) {
    const refs: { call: string; id: string }[] = [];
    for (const prop of section.props.values()) references(prop.value, refs);
    for (const value of Object.values(section.attrs)) references(value, refs);
    for (const ref of refs) {
      const declared = ref.call === 'ExtResource' ? scene.ext.has(ref.id) : scene.sub.has(ref.id);
      if (!declared) out.push(finding(NAME, at(scene.path, section.line), `${ref.call}("${ref.id}") is not declared`));
    }
  }
  return out;
}

/** True when the path goes through an instanced scene, whose nodes are not in this file. */
function insideInstance(scene: TextScene, path: string): boolean {
  return scene.nodes.some((n) => n.instance !== null && (n.path === '.' || path.startsWith(`${n.path}/`)));
}

function nodeProblems(scene: TextScene): Finding[] {
  if (!scene.path.endsWith('.tscn')) return [];
  const out: Finding[] = [];
  const roots = scene.nodes.filter((n) => n.parent === null);
  if (roots.length !== 1) out.push(finding(NAME, at(scene.path, roots[1]?.line ?? 1), `the scene has ${String(roots.length)} root nodes, not 1`));
  const paths = new Set(scene.nodes.map((n) => n.path));
  const known = (path: string): boolean => paths.has(path) || insideInstance(scene, path);
  for (const node of scene.nodes) {
    if (node.parent !== null && !known(node.parent)) out.push(finding(NAME, at(scene.path, node.line), `parent "${node.parent}" of node ${node.name} is not a node of the scene`));
  }
  for (const section of scene.sections.filter((s) => s.tag === 'connection')) {
    for (const end of ['from', 'to']) {
      const value = section.attrs[end];
      const path = value?.t === 'str' ? value.v : null;
      if (path !== null && !known(path)) out.push(finding(NAME, at(scene.path, section.line), `connection ${end} "${path}" is not a node of the scene`));
    }
  }
  return out;
}

function pathProblems(scene: TextScene, files: ReadonlySet<string>, lower: ReadonlyMap<string, string>): Finding[] {
  const out: Finding[] = [];
  for (const ext of scene.ext.values()) {
    if (!LINKED.some((p) => ext.path.startsWith(p))) continue;
    const file = repoPath(ext.path);
    if (file === null || files.has(file)) continue;
    const other = lower.get(file.toLowerCase());
    const why = other === undefined ? 'no such file' : `the file is ${other}: the letter case differs`;
    out.push(finding(NAME, at(scene.path, ext.line), `ext_resource ${ext.path}: ${why}`));
  }
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const files = new Set(sc.files);
  const lower = new Map(sc.files.map((f) => [f.toLowerCase(), f]));
  const results = await Promise.all(
    sc.filter(isContentScene).map(async (path) => {
      const scene = await sc.scene(path);
      return [...pathProblems(scene, files, lower), ...idProblems(scene), ...nodeProblems(scene)];
    }),
  );
  return results.flat();
}
