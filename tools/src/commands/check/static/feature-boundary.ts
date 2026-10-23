import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { featureOf, isClientContentGd, pascal } from './lib/files.ts';
import { classIndex } from './lib/gd-shared.ts';
import type { ClassIndex } from './lib/gd-types.ts';

/**
 * feature boundary (`client-content` `## feature boundary`, Godot `## scene and prefab`, `## GDScript`).
 */
export const NAME = 'feature boundary';

const FEATURE_RES = /res:\/\/features\/([^/"']+)\//g;

async function featureCode(sc: StaticContext, path: string, feature: string, index: ClassIndex): Promise<Finding[]> {
  const file = await sc.gd(path);
  const out: Finding[] = [];
  for (const t of file.tokens) {
    if (t.type === 'name') {
      const owner = index.pathOf(t.text);
      const other = owner === null ? null : featureOf(owner);
      if (other !== null && other !== feature) out.push(finding(NAME, at(path, t.line), `uses class \`${t.text}\` of feature \`${other}\``));
    }
    if (t.type === 'str') {
      for (const m of t.value.matchAll(FEATURE_RES)) {
        if (m[1] !== feature) out.push(finding(NAME, at(path, t.line), `uses \`res://features/${m[1] as string}/\``));
      }
    }
  }
  const className = file.top.name;
  const classLine = file.top.body.find((s) => s.k === 'class_name')?.line ?? 1;
  if (className !== null && !className.startsWith(pascal(feature))) {
    out.push(finding(NAME, at(path, classLine), `class_name \`${className}\` does not start with \`${pascal(feature)}\``));
  }
  return out;
}

async function commonCode(sc: StaticContext, path: string): Promise<Finding[]> {
  const file = await sc.gd(path);
  const className = file.top.name;
  if (className === null || className.startsWith('Common')) return [];
  const line = file.top.body.find((s) => s.k === 'class_name')?.line ?? 1;
  return [finding(NAME, at(path, line), `class_name \`${className}\` does not start with \`Common\``)];
}

/** Why an ext_resource path of a feature scene or prefab crosses the boundary, or null. */
export function sceneReference(feature: string, res: string): string | null {
  if (feature === 'common') {
    if (res.startsWith('res://features/')) return `common prefab points to \`${res}\``;
    const allowed = ['res://resource/', 'res://common/', 'res://core/'];
    return allowed.some((p) => res.startsWith(p)) ? null : `points to \`${res}\` outside \`res://resource/\`, \`res://common/\`, \`res://core/\``;
  }
  const allowed = ['res://resource/', `res://features/${feature}/`, 'res://common/', 'res://core/'];
  if (!allowed.some((p) => res.startsWith(p))) return `points to \`${res}\` outside \`res://resource/\`, \`res://features/${feature}/\`, \`res://common/\`, \`res://core/\``;
  const other = /^res:\/\/resource\/(scene|prefab)\/([^/]+)\//.exec(res);
  if (other && other[2] !== feature && other[2] !== 'common') return `points to \`${res}\` of feature \`${other[2] as string}\``;
  return null;
}

async function sceneFile(sc: StaticContext, path: string, feature: string): Promise<Finding[]> {
  const scene = await sc.scene(path);
  const out: Finding[] = [];
  for (const ext of scene.ext.values()) {
    const why = sceneReference(feature, ext.path);
    if (why) out.push(finding(NAME, at(path, ext.line), why));
  }
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const index = await classIndex(sc);
  const jobs: Promise<Finding[]>[] = [];
  for (const path of sc.filter(isClientContentGd)) {
    const feature = featureOf(path);
    if (feature !== null) jobs.push(featureCode(sc, path, feature, index));
    if (path.startsWith('client/common/')) jobs.push(commonCode(sc, path));
  }
  for (const path of sc.filter((p) => /\.(tscn|tres)$/.test(p))) {
    const m = /^resource\/(scene|prefab)\/([^/]+)\//.exec(path);
    if (m) jobs.push(sceneFile(sc, path, m[2] as string));
  }
  return (await Promise.all(jobs)).flat();
}
