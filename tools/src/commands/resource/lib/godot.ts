import { OgwError } from '../../../lib/errors.ts';
import type { Spec, SpecAnimation } from './spec.ts';

/**
 * Godot `## resource type` of `client-core` `engines/godot.md`: file extension per resource type and the class
 * `ogw resource sync` checks in `.tres` and `.tscn` files.
 */
export interface EngineType {
  extensions: readonly string[];
  /** `.tres`: the `[gd_resource]` class (or a subclass) or script class. */
  resourceClass?: string;
  /** `.tscn`: the root node class; null when the table names no class. */
  rootNode?: (spec: Spec) => string | null;
}

const PNG: EngineType = { extensions: ['.png'] };
const GLB: EngineType = { extensions: ['.glb'] };

const GODOT: Record<string, EngineType> = {
  image: PNG,
  sprite_sheet: PNG,
  texture_atlas: PNG,
  icon: PNG,
  background: PNG,
  nine_slice: PNG,
  texture: PNG,
  skybox: PNG,
  tileset: PNG,
  app_icon: PNG,
  splash: PNG,
  model: GLB,
  rig: GLB,
  material: { extensions: ['.tres'], resourceClass: 'Material' },
  sprite_animation: { extensions: ['.tres'], resourceClass: 'SpriteFrames' },
  rig_animation_2d: { extensions: ['.tscn'], rootNode: () => 'Node2D' },
  animation_3d: { extensions: ['.tres'], resourceClass: 'Animation' },
  tween: { extensions: ['.tres'], resourceClass: 'TweenDefinition' },
  particle: { extensions: ['.tscn'], rootNode: (spec) => (spec.space === '3D' ? 'GPUParticles3D' : 'GPUParticles2D') },
  shader: { extensions: ['.gdshader'] },
  sfx: { extensions: ['.wav'] },
  voice: { extensions: ['.wav'] },
  bgm: { extensions: ['.ogg'] },
  haptic: { extensions: ['.json'] },
  font: { extensions: ['.ttf', '.otf'] },
  scene: { extensions: ['.tscn'], rootNode: () => null },
  prefab: { extensions: ['.tscn'], rootNode: () => null },
};

/** Godot classes below the classes the table names. */
const SUBCLASSES: Record<string, readonly string[]> = {
  Material: [
    'BaseMaterial3D',
    'StandardMaterial3D',
    'ORMMaterial3D',
    'ShaderMaterial',
    'CanvasItemMaterial',
    'ParticleProcessMaterial',
    'PanoramaSkyMaterial',
    'ProceduralSkyMaterial',
    'PhysicalSkyMaterial',
    'FogMaterial',
    'PlaceholderMaterial',
  ],
};

/** Whether the engine's `## resource type` table has the type. */
export function isEngineType(engine: string, type: string): boolean {
  return engine === 'godot' && Object.hasOwn(GODOT, type);
}

export function engineType(engine: string, type: string): EngineType {
  if (engine !== 'godot') throw new OgwError(`not defined: resource types of engine ${engine}`);
  if (!isEngineType(engine, type)) throw new OgwError(`not defined: resource type ${type}`);
  return GODOT[type] as EngineType;
}

function attributes(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of header.matchAll(/([A-Za-z_]+)=("([^"]*)"|[^\s\]]+)/g)) {
    result[match[1] as string] = match[3] ?? (match[2] as string);
  }
  return result;
}

/** Class of a `.tres` file: `script_class` when given, else `[gd_resource]` `type`. */
export function tresClass(text: string): string | null {
  const header = /^\[gd_resource\b[^\]]*\]/m.exec(text);
  if (!header) return null;
  const attrs = attributes(header[0]);
  return attrs.script_class ?? attrs.type ?? null;
}

interface SceneNode {
  name: string;
  type: string | null;
  parent: string | null;
}

/** `[node]` headers of a `.tscn` file in file order. */
export function sceneNodes(text: string): SceneNode[] {
  const nodes: SceneNode[] = [];
  for (const match of text.matchAll(/^\[node\b[^\]]*\]/gm)) {
    const attrs = attributes(match[0]);
    nodes.push({ name: attrs.name ?? '', type: attrs.type ?? null, parent: attrs.parent ?? null });
  }
  return nodes;
}

export function tscnRootType(text: string): string | null {
  const root = sceneNodes(text).find((node) => node.parent === null);
  return root?.type ?? null;
}

/** Problem of a file's engine class against the table, or null. */
export function classProblem(entry: EngineType, spec: Spec, extension: string, text: string): string | null {
  if (extension === '.tres' && entry.resourceClass !== undefined) {
    const found = tresClass(text);
    const allowed = [entry.resourceClass, ...(SUBCLASSES[entry.resourceClass] ?? [])];
    if (found === null || !allowed.includes(found)) return `class ${found ?? 'none'} is not ${entry.resourceClass}`;
  }
  if (extension === '.tscn' && entry.rootNode !== undefined) {
    const expected = entry.rootNode(spec);
    const found = tscnRootType(text);
    if (expected !== null && found !== expected) return `root node ${found ?? 'none'} is not ${expected}`;
  }
  return null;
}

/** Godot float literal. */
export function godotFloat(value: number): string {
  return Number.isInteger(value) ? `${String(value)}.0` : String(value);
}

/** `Color(...)` arguments of an opaque 8-bit RGB color: Godot's text resource format needs all 4 components. */
export function rgba(color: readonly [number, number, number]): string {
  return [...color.map((c) => godotFloat(Math.round((c / 255) * 1000) / 1000)), '1.0'].join(', ');
}

function animationSubResources(animations: readonly SpecAnimation[]): string {
  return animations
    .map((a, i) => {
      const loop = a.loop ? 'loop_mode = 1\n' : '';
      return `[sub_resource type="Animation" id="Animation_${String(i + 1)}"]\nresource_name = "${a.name}"\nlength = ${godotFloat(a.lengthMs / 1000)}\n${loop}`;
    })
    .join('\n');
}

/** Placeholder `rig_animation_2d`: `Node2D` root, `Skeleton2D` with one `Bone2D`, a solid rectangle `Polygon2D`, an `AnimationPlayer`. */
export function placeholderRigScene(last: string, size: [number, number], animations: readonly SpecAnimation[], color: readonly [number, number, number]): string {
  const [w, h] = size;
  const library = animations.map((a, i) => `&"${a.name}": SubResource("Animation_${String(i + 1)}")`).join(',\n');
  const hw = godotFloat(w / 2);
  const hh = godotFloat(h / 2);
  return [
    '[gd_scene format=3]\n',
    animationSubResources(animations),
    `[sub_resource type="AnimationLibrary" id="AnimationLibrary_1"]\n_data = {\n${library}\n}\n`,
    `[node name="${last}" type="Node2D"]\n`,
    '[node name="Skeleton2D" type="Skeleton2D" parent="."]\n',
    '[node name="root" type="Bone2D" parent="Skeleton2D"]\nrest = Transform2D(1, 0, 0, 1, 0, 0)\n',
    `[node name="body" type="Polygon2D" parent="Skeleton2D/root"]\ncolor = Color(${rgba(color)})\npolygon = PackedVector2Array(-${hw}, -${hh}, ${hw}, -${hh}, ${hw}, ${hh}, -${hw}, ${hh})\n`,
    '[node name="AnimationPlayer" type="AnimationPlayer" parent="."]\nlibraries = {\n&"": SubResource("AnimationLibrary_1")\n}\n',
  ].join('\n');
}

/** Placeholder `sprite_animation`: one solid frame per animation, the image inside the `.tres`. */
export function placeholderSpriteFrames(size: [number, number], animations: readonly SpecAnimation[], color: readonly number[]): string {
  const [w, h] = size;
  const pixel = `${String(color[0])}, ${String(color[1])}, ${String(color[2])}, 255`;
  const bytes = new Array<string>(w * h).fill(pixel).join(', ');
  const list = animations
    .map((a) => `{\n"frames": [{\n"duration": 1.0,\n"texture": SubResource("ImageTexture_1")\n}],\n"loop": ${String(a.loop)},\n"name": &"${a.name}",\n"speed": ${godotFloat(1000 / a.lengthMs)}\n}`)
    .join(', ');
  return [
    '[gd_resource type="SpriteFrames" format=3]\n',
    `[sub_resource type="Image" id="Image_1"]\ndata = {\n"data": PackedByteArray(${bytes}),\n"format": "RGBA8",\n"height": ${String(h)},\n"mipmaps": false,\n"width": ${String(w)}\n}\n`,
    '[sub_resource type="ImageTexture" id="ImageTexture_1"]\nimage = SubResource("Image_1")\n',
    `[resource]\nanimations = [${list}]\n`,
  ].join('\n');
}

export interface SheetFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Final `sprite_animation`: `SpriteFrames` whose frames are `AtlasTexture` regions of the sheet. */
export function spriteFramesFromSheet(sheetPath: string, animations: readonly { anim: SpecAnimation; frames: SheetFrame[] }[]): string {
  const subs: string[] = [];
  const lists: string[] = [];
  let id = 0;
  for (const { anim, frames } of animations) {
    const refs: string[] = [];
    for (const f of frames) {
      id++;
      subs.push(`[sub_resource type="AtlasTexture" id="AtlasTexture_${String(id)}"]\natlas = ExtResource("1")\nregion = Rect2(${String(f.x)}, ${String(f.y)}, ${String(f.w)}, ${String(f.h)})\n`);
      refs.push(`{\n"duration": 1.0,\n"texture": SubResource("AtlasTexture_${String(id)}")\n}`);
    }
    const fps = (frames.length * 1000) / anim.lengthMs;
    lists.push(`{\n"frames": [${refs.join(', ')}],\n"loop": ${String(anim.loop)},\n"name": &"${anim.name}",\n"speed": ${godotFloat(fps)}\n}`);
  }
  return [
    '[gd_resource type="SpriteFrames" format=3]\n',
    `[ext_resource type="Texture2D" path="res://${sheetPath}" id="1"]\n`,
    ...subs,
    `[resource]\nanimations = [${lists.join(', ')}]\n`,
  ].join('\n');
}

export function placeholderMaterial(): string {
  return '[gd_resource type="StandardMaterial3D" format=3]\n\n[resource]\n';
}

export function placeholderAnimation3d(lengthMs: number): string {
  return `[gd_resource type="Animation" format=3]\n\n[resource]\nlength = ${godotFloat(lengthMs / 1000)}\n`;
}

export function placeholderParticle(last: string, space: '2D' | '3D'): string {
  return `[gd_scene format=3]\n\n[node name="${last}" type="GPUParticles${space}"]\nemitting = false\n`;
}

export function placeholderShader(space: '2D' | '3D'): string {
  return `shader_type ${space === '2D' ? 'canvas_item' : 'spatial'};\n`;
}

/** Names in a rig scene: `Bone2D` nodes, part nodes (`Sprite2D`, `Polygon2D`), `AnimationLibrary` animations. */
export function rigSceneNames(text: string): { bones: string[]; parts: string[]; animations: string[] } {
  const nodes = sceneNodes(text);
  const animations: string[] = [];
  for (const block of text.matchAll(/^_data = \{([^}]*)\}/gm)) {
    for (const entry of (block[1] as string).matchAll(/&?"([^"]+)"\s*:\s*SubResource/g)) animations.push(entry[1] as string);
  }
  return {
    bones: nodes.filter((n) => n.type === 'Bone2D').map((n) => n.name),
    parts: nodes.filter((n) => n.type === 'Sprite2D' || n.type === 'Polygon2D').map((n) => n.name),
    animations,
  };
}
