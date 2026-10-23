import { isAbsolute } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { readJson } from '../../../lib/fsx.ts';
import { isSnakeCase } from './list.ts';

export type Point = [number, number];

export interface SkeletonPart {
  name: string;
  bone: string;
  image: string;
  filled: boolean;
  bones?: string[];
}

export interface SkeletonBone {
  name: string;
  parent: string | null;
  pivot?: Point;
}

export interface SkeletonAnimation {
  name: string;
  loop: boolean;
  duration_ms: number;
}

/** Skeleton spec (`production.md` `## skeleton spec`). */
export interface Skeleton {
  source: string;
  parts: SkeletonPart[];
  bones: SkeletonBone[];
  animations: SkeletonAnimation[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPoint(value: unknown): value is Point {
  return Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'number' && Number.isFinite(v));
}

function names(items: readonly { name: string }[], what: string, problems: string[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (!isSnakeCase(item.name)) problems.push(`${what} name ${item.name} is not snake_case`);
    if (seen.has(item.name)) problems.push(`${what} name ${item.name} is not unique`);
    seen.add(item.name);
  }
}

function checkPart(value: unknown, i: number, problems: string[]): value is SkeletonPart {
  if (!isObject(value) || typeof value.name !== 'string' || typeof value.bone !== 'string' || typeof value.image !== 'string' || typeof value.filled !== 'boolean') {
    problems.push(`parts[${String(i)}] needs name, bone, image (strings) and filled (boolean)`);
    return false;
  }
  if (value.bones !== undefined && !(Array.isArray(value.bones) && value.bones.every((b) => typeof b === 'string'))) {
    problems.push(`parts[${String(i)}].bones is not a list of bone names`);
    return false;
  }
  return true;
}

/** Checks a bone; `pivots`: the `pivot` is read and checked. Otherwise the result has no `pivot`. */
function checkBone(value: unknown, i: number, pivots: boolean, problems: string[]): SkeletonBone | null {
  if (!isObject(value) || typeof value.name !== 'string' || !(value.parent === null || typeof value.parent === 'string')) {
    problems.push(`bones[${String(i)}] needs name (string) and parent (string or null)`);
    return null;
  }
  const bone: SkeletonBone = { name: value.name, parent: value.parent };
  if (!pivots || value.pivot === undefined) return bone;
  if (!isPoint(value.pivot)) {
    problems.push(`bones[${String(i)}].pivot is not [x, y]`);
    return null;
  }
  return { ...bone, pivot: value.pivot };
}

function checkAnimation(value: unknown, i: number, problems: string[]): value is SkeletonAnimation {
  if (!isObject(value) || typeof value.name !== 'string' || typeof value.loop !== 'boolean' || !Number.isInteger(value.duration_ms)) {
    problems.push(`animations[${String(i)}] needs name (string), loop (boolean) and duration_ms (integer)`);
    return false;
  }
  return true;
}

/** Problems of the bone tree: one root, known parents, every bone reaches the root. */
function treeProblems(bones: readonly SkeletonBone[]): string[] {
  const problems: string[] = [];
  const byName = new Map(bones.map((b) => [b.name, b]));
  const roots = bones.filter((b) => b.parent === null);
  if (roots.length !== 1) problems.push(`bones has ${String(roots.length)} roots, needs 1`);
  for (const bone of bones) {
    const seen = new Set<string>();
    let at: SkeletonBone | undefined = bone;
    while (at && at.parent !== null && !seen.has(at.name)) {
      seen.add(at.name);
      const parent: SkeletonBone | undefined = byName.get(at.parent);
      if (!parent) problems.push(`bone ${at.name} parent ${at.parent} is not in bones`);
      at = parent;
    }
    if (at && at.parent !== null) problems.push(`bone ${bone.name} does not reach the root`);
  }
  return problems;
}

function partBoneProblems(parts: readonly SkeletonPart[], bones: readonly SkeletonBone[]): string[] {
  const problems: string[] = [];
  const boneNames = new Set(bones.map((b) => b.name));
  for (const part of parts) {
    if (!boneNames.has(part.bone)) problems.push(`part ${part.name} bone ${part.bone} is not in bones`);
    if (part.bones === undefined) continue;
    if (!part.bones.includes(part.bone)) problems.push(`part ${part.name} bones does not contain its bone ${part.bone}`);
    for (const b of part.bones) if (!boneNames.has(b)) problems.push(`part ${part.name} bones has ${b}, which is not in bones`);
  }
  return problems;
}

/** Reads and checks a skeleton spec. `pivots`: every bone needs a `pivot`; otherwise `pivot` is not read. */
export async function readSkeleton(path: string, pivots: boolean): Promise<Skeleton> {
  const value = await readJson(path);
  const problems: string[] = [];
  if (!isObject(value) || typeof value.source !== 'string' || !isAbsolute(value.source) || !Array.isArray(value.parts) || !Array.isArray(value.bones) || !Array.isArray(value.animations)) {
    throw new OgwError(`${path}: skeleton spec needs source (absolute path), parts, bones and animations (lists)`);
  }
  const parts = value.parts.filter((p, i) => checkPart(p, i, problems));
  const bones = value.bones.map((b, i) => checkBone(b, i, pivots, problems)).filter((b) => b !== null);
  const animations = value.animations.filter((a, i) => checkAnimation(a, i, problems));
  if (problems.length === 0) {
    names(parts, 'part', problems);
    names(bones, 'bone', problems);
    names(animations, 'animation', problems);
    problems.push(...treeProblems(bones), ...partBoneProblems(parts, bones));
    if (pivots) for (const bone of bones) if (bone.pivot === undefined) problems.push(`bone ${bone.name} has no pivot`);
  }
  if (problems.length > 0) throw new OgwError(`${path}: ${problems.join('; ')}`);
  return { source: value.source, parts, bones, animations };
}

/** Bones from the root, each after its parent; children in `bones` order. */
export function rootFirst(bones: readonly SkeletonBone[]): SkeletonBone[] {
  const order: SkeletonBone[] = [];
  const queue = bones.filter((b) => b.parent === null);
  while (queue.length > 0) {
    const bone = queue.shift() as SkeletonBone;
    order.push(bone);
    queue.push(...bones.filter((b) => b.parent === bone.name));
  }
  return order;
}
