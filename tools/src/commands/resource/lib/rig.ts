import Delaunator from 'delaunator';
import { mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { exists, formatJson, readJson, writeFileAtomic } from '../../../lib/fsx.ts';
import { alphaBox, blank, decodeRgba, encodePng, fitCentered, paste, type Rgba } from './image.ts';
import { isPoint, readSkeleton, rootFirst, type Point, type Skeleton, type SkeletonPart } from './skeleton.ts';

/** Alpha of an opaque pixel. */
const OPAQUE = 128;
/** Spacing of mesh contour points and interior grid points, in pixels. */
export const MESH_SPACING_PX = 8;
/** How far the mesh shape grows past the opaque pixels, in pixels. */
const MESH_GROW_PX = 2;
/** Transparent border `rig-split` adds around each part: the mesh growth plus 1 px, so a transparent pixel lies between the mesh and the part image edge. */
const PART_BORDER_PX = MESH_GROW_PX + 1;
/** File next to the rig split JSON that holds the source illustration on the canvas. */
const CANVAS_FILE = 'rig-canvas.png';

export interface Thresholds {
  iouMin: number;
  colorDiffMax: number;
}

export interface Recompose {
  alphaIou: number;
  colorDiff: number | null;
  status: 'pass' | 'fail';
  iouMin: number;
  colorDiffMax: number;
}

export interface SplitPart {
  name: string;
  file: string;
  offset: Point;
  size: Point;
}

/** Rig split JSON (`production.md` `### rig-split`). */
export interface RigSplit {
  source: string;
  canvas: Point;
  parts: SplitPart[];
  pivots: Record<string, Point>;
  recompose: Recompose;
}

type Box = [number, number, number, number];

/** Draws `src` over `dst` at an offset with source-over alpha blending. */
function drawOver(dst: Rgba, src: Rgba, ox: number, oy: number): void {
  for (let y = 0; y < src.height; y++) {
    const ty = oy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = ox + x;
      const s = (y * src.width + x) * 4;
      const sa = (src.data[s + 3] as number) / 255;
      if (tx < 0 || tx >= dst.width || sa === 0) continue;
      const d = (ty * dst.width + tx) * 4;
      const da = (dst.data[d + 3] as number) / 255;
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        dst.data[d + c] = Math.round(((src.data[s + c] as number) * sa + (dst.data[d + c] as number) * da * (1 - sa)) / oa);
      }
      dst.data[d + 3] = Math.round(oa * 255);
    }
  }
}

/** Recompose: draws the parts in order at their offsets and compares with the source illustration on the canvas. */
export function measureRecompose(source: Rgba, parts: readonly { image: Rgba; offset: Point }[], thresholds: Thresholds): Recompose {
  const canvas = blank(source.width, source.height);
  for (const part of parts) drawOver(canvas, part.image, part.offset[0], part.offset[1]);
  let both = 0;
  let either = 0;
  let diffSum = 0;
  for (let i = 0; i < source.data.length; i += 4) {
    const a = (canvas.data[i + 3] as number) >= OPAQUE;
    const b = (source.data[i + 3] as number) >= OPAQUE;
    if (a || b) either++;
    if (!(a && b)) continue;
    both++;
    let channel = 0;
    for (let c = 0; c < 3; c++) channel += Math.abs((canvas.data[i + c] as number) - (source.data[i + c] as number));
    diffSum += channel / 3;
  }
  const alphaIou = either === 0 ? 0 : both / either;
  const colorDiff = both === 0 ? null : diffSum / both;
  const pass = alphaIou >= thresholds.iouMin && colorDiff !== null && colorDiff <= thresholds.colorDiffMax;
  return { alphaIou, colorDiff, status: pass ? 'pass' : 'fail', iouMin: thresholds.iouMin, colorDiffMax: thresholds.colorDiffMax };
}

function union(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  return [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
}

function middle(box: Box): Point {
  return [Math.floor((box[0] + box[2]) / 2), Math.floor((box[1] + box[3]) / 2)];
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** Initial joint positions (`### rig-split` step 4). */
export function initialPivots(skeleton: Skeleton, boxes: ReadonlyMap<string, Box>, canvas: Point): Record<string, Point> {
  const boneBox = (bone: string): Box | null => union(skeleton.parts.filter((p) => p.bone === bone).map((p) => boxes.get(p.name) as Box));
  const pivots: Record<string, Point> = {};
  for (const bone of rootFirst(skeleton.bones)) {
    const b = boneBox(bone.name);
    const p = bone.parent === null ? null : boneBox(bone.parent);
    if (!b) pivots[bone.name] = bone.parent === null ? [Math.floor(canvas[0] / 2), Math.floor(canvas[1] / 2)] : (pivots[bone.parent] as Point);
    else if (bone.parent === null || !p) pivots[bone.name] = middle(b);
    else {
      const overlap: Box = [Math.max(b[0], p[0]), Math.max(b[1], p[1]), Math.min(b[2], p[2]), Math.min(b[3], p[3])];
      if (overlap[0] < overlap[2] && overlap[1] < overlap[3]) pivots[bone.name] = middle(overlap);
      else {
        const target = middle(p);
        pivots[bone.name] = [clamp(target[0], b[0], b[2] - 1), clamp(target[1], b[1], b[3] - 1)];
      }
    }
  }
  return pivots;
}

async function newFolder(out: string, write: (dir: string) => Promise<void>): Promise<void> {
  const target = resolve(out);
  if (exists(target)) throw new OgwError(`${target} already exists; --out must be a new folder`);
  const tmp = await mkdtemp(join(dirname(target), `.${basename(target)}-`));
  try {
    await write(tmp);
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    throw error;
  }
}

async function layerFiles(skeleton: Skeleton, layers: string): Promise<void> {
  const pngs = (await readdir(layers)).filter((f) => f.toLowerCase().endsWith('.png')).sort();
  const expected = skeleton.parts.map((p) => `${p.name}.png`).sort();
  const missing = expected.filter((f) => !pngs.includes(f));
  const extra = pngs.filter((f) => !expected.includes(f));
  const problems = [...missing.map((f) => `missing layer ${f}`), ...extra.map((f) => `layer ${f} is not a part`)];
  if (problems.length > 0) throw new OgwError(`${layers}: ${problems.join('; ')}`);
}

/** The box widened by `PART_BORDER_PX` on each side, cut from the layer; transparent where it is outside the layer. */
function cutPart(layer: Rgba, box: Box): { image: Rgba; offset: Point } {
  const b = PART_BORDER_PX;
  const offset: Point = [box[0] - b, box[1] - b];
  const image = blank(box[2] - box[0] + 2 * b, box[3] - box[1] + 2 * b);
  paste(image, layer, -offset[0], -offset[1]);
  return { image, offset };
}

/** `ogw resource rig-split`. `size` is the canvas size. */
export async function rigSplit(options: { source: string; skeleton: string; layers: string; size: Point; out: string }, thresholds: Thresholds): Promise<RigSplit> {
  const skeleton = await readSkeleton(options.skeleton, false);
  const sourceFile = resolve(options.source);
  if (sourceFile !== resolve(skeleton.source)) throw new OgwError(`--source ${sourceFile} is not the skeleton spec source ${skeleton.source}`);
  await layerFiles(skeleton, options.layers);
  const original = await decodeRgba(sourceFile, sourceFile);
  const canvas: Point = [options.size[0], options.size[1]];
  const source = await fitCentered(original, canvas[0], canvas[1]);
  const out = resolve(options.out);
  const boxes = new Map<string, Box>();
  const cut: { part: SkeletonPart; image: Rgba; offset: Point }[] = [];
  for (const part of skeleton.parts) {
    const file = join(options.layers, `${part.name}.png`);
    const layer = await decodeRgba(file, file);
    if (layer.width !== original.width || layer.height !== original.height) {
      throw new OgwError(`${file}: size ${String(layer.width)}x${String(layer.height)} is not the source illustration size ${String(original.width)}x${String(original.height)}`);
    }
    const scaled = await fitCentered(layer, canvas[0], canvas[1]);
    const box = alphaBox(scaled, 0);
    if (!box) throw new OgwError(`${file}: no pixel with alpha above 0 on the canvas`);
    boxes.set(part.name, box);
    cut.push({ part, ...cutPart(scaled, box) });
  }
  const split: RigSplit = {
    source: sourceFile,
    canvas,
    parts: cut.map((c) => ({ name: c.part.name, file: join(out, `${c.part.name}.png`), offset: c.offset, size: [c.image.width, c.image.height] })),
    pivots: initialPivots(skeleton, boxes, canvas),
    recompose: measureRecompose(source, cut, thresholds),
  };
  await newFolder(out, async (dir) => {
    for (const c of cut) await writeFileAtomic(join(dir, `${c.part.name}.png`), await encodePng(c.image));
    await writeFileAtomic(join(dir, CANVAS_FILE), await encodePng(source));
    await writeFileAtomic(join(dir, 'rig-split.json'), formatJson(split));
  });
  return split;
}

function isSplitPart(value: unknown): value is SplitPart {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && typeof v.file === 'string' && isAbsolute(v.file) && isPoint(v.offset) && isPoint(v.size);
}

/** Reads a rig split JSON and checks its form. */
export async function readSplit(path: string): Promise<RigSplit> {
  const value = await readJson<Record<string, unknown>>(path);
  const pivots = value.pivots;
  const ok =
    typeof value === 'object' &&
    typeof value.source === 'string' &&
    isAbsolute(value.source) &&
    isPoint(value.canvas) &&
    value.canvas.every((v) => Number.isInteger(v) && v > 0) &&
    Array.isArray(value.parts) &&
    value.parts.every(isSplitPart) &&
    typeof pivots === 'object' &&
    pivots !== null &&
    Object.values(pivots).every(isPoint);
  if (!ok) throw new OgwError(`${path}: rig split JSON needs source (absolute path), canvas (positive integers), parts (name, file, offset, size) and pivots`);
  return value as unknown as RigSplit;
}

/** `ogw resource rig-check`: measures recompose from the files a rig split JSON names, with `source` scaled to the canvas as `rig-split` does. */
export async function rigCheck(path: string, thresholds: Thresholds): Promise<Recompose> {
  const split = await readSplit(path);
  const source = await fitCentered(await decodeRgba(split.source, split.source), split.canvas[0], split.canvas[1]);
  const parts: { image: Rgba; offset: Point }[] = [];
  for (const part of split.parts) parts.push({ image: await decodeRgba(part.file, part.file), offset: part.offset });
  return measureRecompose(source, parts, thresholds);
}

/** The part's opaque pixels grown by `MESH_GROW_PX`, limited to the part image, so every mesh point is inside the texture. */
interface Shape {
  width: number;
  height: number;
  cells: Uint8Array;
}

function growShape(image: Rgba): Shape {
  const g = MESH_GROW_PX;
  const shape: Shape = { width: image.width, height: image.height, cells: new Uint8Array(image.width * image.height) };
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if ((image.data[(y * image.width + x) * 4 + 3] as number) < OPAQUE) continue;
      for (let dy = -g; dy <= g; dy++) {
        for (let dx = -g; dx <= g; dx++) {
          const tx = x + dx;
          const ty = y + dy;
          if (dx * dx + dy * dy <= g * g && tx >= 0 && ty >= 0 && tx < shape.width && ty < shape.height) shape.cells[ty * shape.width + tx] = 1;
        }
      }
    }
  }
  return shape;
}

/** Whether the pixel at part image coordinates (x, y) is in the shape. */
function inShape(shape: Shape, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < shape.width && y < shape.height && shape.cells[y * shape.width + x] === 1;
}

/** A boundary edge between pixel corners; `dir` 0 right, 1 down, 2 left, 3 up. The shape is on its right side. */
interface Edge {
  from: Point;
  to: Point;
  dir: number;
}

function boundaryEdges(shape: Shape): Edge[] {
  const edges: Edge[] = [];
  for (let y = 0; y < shape.height; y++) {
    for (let x = 0; x < shape.width; x++) {
      if (!inShape(shape, x, y)) continue;
      if (!inShape(shape, x, y - 1)) edges.push({ from: [x, y], to: [x + 1, y], dir: 0 });
      if (!inShape(shape, x + 1, y)) edges.push({ from: [x + 1, y], to: [x + 1, y + 1], dir: 1 });
      if (!inShape(shape, x, y + 1)) edges.push({ from: [x + 1, y + 1], to: [x, y + 1], dir: 2 });
      if (!inShape(shape, x - 1, y)) edges.push({ from: [x, y + 1], to: [x, y], dir: 3 });
    }
  }
  return edges;
}

const pointKey = (p: Point): string => `${String(p[0])},${String(p[1])}`;

/** Closed boundary loops as vertex lists, each starting at its top-left vertex. */
function boundaryLoops(shape: Shape): Point[][] {
  const edges = boundaryEdges(shape);
  const outgoing = new Map<string, Edge[]>();
  for (const edge of edges) {
    const key = pointKey(edge.from);
    outgoing.set(key, [...(outgoing.get(key) ?? []), edge]);
  }
  const used = new Set<Edge>();
  const loops: Point[][] = [];
  for (const start of edges) {
    if (used.has(start)) continue;
    const loop: Point[] = [];
    let edge: Edge | undefined = start;
    while (edge && !used.has(edge)) {
      used.add(edge);
      loop.push(edge.from);
      const dir: number = edge.dir;
      const next: Edge[] = (outgoing.get(pointKey(edge.to)) ?? []).filter((e) => !used.has(e));
      edge = [1, 0, 3].map((turn) => next.find((e) => e.dir === (dir + turn) % 4)).find((e) => e !== undefined);
    }
    let first = 0;
    loop.forEach((p, i) => {
      const f = loop[first] as Point;
      if (p[1] < f[1] || (p[1] === f[1] && p[0] < f[0])) first = i;
    });
    loops.push([...loop.slice(first), ...loop.slice(0, first)]);
  }
  return loops;
}

/** Mesh points: contour points every spacing along each loop, then interior grid points not closer than the spacing. The grid goes through `origin`. */
function meshPoints(shape: Shape, origin: Point): Point[] {
  const s = MESH_SPACING_PX;
  const points: Point[] = [];
  const seen = new Set<string>();
  const add = (p: Point): void => {
    if (seen.has(pointKey(p))) return;
    seen.add(pointKey(p));
    points.push(p);
  };
  for (const loop of boundaryLoops(shape)) for (let i = 0; i < loop.length; i += s) add(loop[i] as Point);
  const contour = [...points];
  for (let y = origin[1] % s; y <= shape.height; y += s) {
    for (let x = origin[0] % s; x <= shape.width; x += s) {
      const inside = inShape(shape, x - 1, y - 1) && inShape(shape, x, y - 1) && inShape(shape, x - 1, y) && inShape(shape, x, y);
      if (inside && contour.every((c) => Math.hypot(c[0] - x, c[1] - y) >= s)) add([x, y]);
    }
  }
  return points;
}

function triangles(shape: Shape, points: readonly Point[]): [number, number, number][] {
  if (points.length < 3) return [];
  const d = Delaunator.from([...points]);
  const result: [number, number, number][] = [];
  for (let t = 0; t < d.triangles.length; t += 3) {
    const tri: [number, number, number] = [d.triangles[t] as number, d.triangles[t + 1] as number, d.triangles[t + 2] as number];
    const cx = tri.reduce((sum, i) => sum + (points[i] as Point)[0], 0) / 3;
    const cy = tri.reduce((sum, i) => sum + (points[i] as Point)[1], 0) / 3;
    if (inShape(shape, Math.floor(cx), Math.floor(cy))) result.push(tri);
  }
  return result;
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len, 0, 1);
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Distance from a canvas point to a bone: its segments to each child pivot, or its pivot when it has no child. */
function boneDistance(skeleton: Skeleton, bone: string, p: Point): number {
  const pivot = skeleton.bones.find((b) => b.name === bone)?.pivot as Point;
  const children = skeleton.bones.filter((b) => b.parent === bone);
  if (children.length === 0) return Math.hypot(p[0] - pivot[0], p[1] - pivot[1]);
  return Math.min(...children.map((c) => segmentDistance(p, pivot, c.pivot as Point)));
}

/** Weights of a canvas point over the part's bones: 1 / (d + 1)², the largest 3 kept, normalized to a sum of 1. */
export function pointWeights(skeleton: Skeleton, bones: readonly string[], p: Point): number[] {
  const raw = bones.map((bone) => 1 / (boneDistance(skeleton, bone, p) + 1) ** 2);
  const keep = new Set(raw.map((w, i) => ({ w, i })).sort((a, b) => b.w - a.w || a.i - b.i).slice(0, 3).map((e) => e.i));
  const kept = raw.map((w, i) => (keep.has(i) ? w : 0));
  const sum = kept.reduce((a, b) => a + b, 0);
  return kept.map((w) => w / sum);
}

export interface PartMesh {
  polygon: Point[];
  uv: Point[];
  polygons: [number, number, number][];
  weights: Record<string, number[]>;
}

export function partMesh(skeleton: Skeleton, part: SkeletonPart, image: Rgba, offset: Point): PartMesh {
  const shape = growShape(image);
  // The grid starts at the box of pixels with alpha above 0, so the border rig-split adds does not move it on the canvas.
  const box = alphaBox(image, 0);
  const uv = meshPoints(shape, box ? [box[0], box[1]] : [0, 0]);
  const polygon = uv.map((p): Point => [p[0] + offset[0], p[1] + offset[1]]);
  const bones = part.bones ?? [part.bone];
  const weights: Record<string, number[]> = {};
  for (const bone of bones) weights[bone] = [];
  for (const p of polygon) pointWeights(skeleton, bones, p).forEach((w, i) => (weights[bones[i] as string] as number[]).push(w));
  return { polygon, uv, polygons: triangles(shape, uv), weights };
}

/** `ogw resource rig-mesh`. Returns the written mesh JSON paths. */
export async function rigMesh(options: { skeleton: string; split: string; out: string }): Promise<string[]> {
  const skeleton = await readSkeleton(options.skeleton, true);
  const split = await readSplit(options.split);
  const weighted = skeleton.parts.filter((p) => p.bones !== undefined);
  const meshes: { name: string; mesh: PartMesh }[] = [];
  for (const part of weighted) {
    const entry = split.parts.find((p) => p.name === part.name);
    if (!entry) throw new OgwError(`${options.split}: no part ${part.name}`);
    meshes.push({ name: part.name, mesh: partMesh(skeleton, part, await decodeRgba(entry.file, entry.file), entry.offset) });
  }
  const out = resolve(options.out);
  await newFolder(out, async (dir) => {
    for (const m of meshes) await writeFileAtomic(join(dir, `${m.name}.mesh.json`), formatJson(m.mesh));
  });
  return meshes.map((m) => join(out, `${m.name}.mesh.json`));
}
