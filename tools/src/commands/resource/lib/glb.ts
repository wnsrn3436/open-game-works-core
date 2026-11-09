/**
 * The model checks of `ogw resource finalize` on a binary glTF 2.0 file (`resource` production.md `## finalize` step 1):
 * the node of each mesh has the identity transform, and no two triangles of the `TEXCOORD_0` of the primitives overlap.
 */
import { OgwError } from '../../../lib/errors.ts';

interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  sparse?: { count: number; indices: { bufferView: number; byteOffset?: number; componentType: number }; values: { bufferView: number; byteOffset?: number } };
}

interface GltfNode {
  name?: string;
  mesh?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

interface Primitive {
  attributes: Record<string, number>;
  indices?: number;
  mode?: number;
}

interface Gltf {
  nodes?: GltfNode[];
  meshes?: { name?: string; primitives: Primitive[] }[];
  accessors?: Accessor[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  buffers?: { byteLength: number; uri?: string }[];
}

interface Glb {
  json: Gltf;
  bin: Buffer;
}

const MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

/** The JSON and the binary chunk of a GLB file. */
export function readGlb(data: Buffer, where: string): Glb {
  if (data.length < 20 || data.readUInt32LE(0) !== MAGIC || data.readUInt32LE(4) !== 2) throw new OgwError(`${where}: not a binary glTF 2.0 file`);
  let json: Gltf | null = null;
  let bin: Buffer = Buffer.alloc(0);
  for (let at = 12; at + 8 <= data.length; ) {
    const length = data.readUInt32LE(at);
    const type = data.readUInt32LE(at + 4);
    const body = data.subarray(at + 8, at + 8 + length);
    if (type === JSON_CHUNK) json = JSON.parse(body.toString('utf8')) as Gltf;
    if (type === BIN_CHUNK) bin = body;
    at += 8 + length;
  }
  if (json === null) throw new OgwError(`${where}: the GLB has no JSON chunk`);
  return { json, bin };
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const SIZES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function readComponent(bin: Buffer, at: number, componentType: number): number {
  switch (componentType) {
    case 5120:
      return bin.readInt8(at);
    case 5121:
      return bin.readUInt8(at);
    case 5122:
      return bin.readInt16LE(at);
    case 5123:
      return bin.readUInt16LE(at);
    case 5125:
      return bin.readUInt32LE(at);
    case 5126:
      return bin.readFloatLE(at);
    default:
      throw new OgwError(`accessor component type ${String(componentType)} is not a glTF component type`);
  }
}

function viewOf(glb: Glb, index: number, where: string): { offset: number; stride: number | undefined } {
  const view = glb.json.bufferViews?.[index];
  if (!view) throw new OgwError(`${where}: buffer view ${String(index)} does not exist`);
  if (view.buffer !== 0 || glb.json.buffers?.[0]?.uri !== undefined) throw new OgwError(`${where}: buffer view ${String(index)} is not in the binary chunk of the GLB`);
  return { offset: view.byteOffset ?? 0, stride: view.byteStride };
}

/** The values of an accessor as raw component values (integers for integer types), `count` × components long. */
export function accessorValues(glb: Glb, index: number, where: string): { values: number[]; components: number; accessor: Accessor } {
  const accessor = glb.json.accessors?.[index];
  if (!accessor) throw new OgwError(`${where}: accessor ${String(index)} does not exist`);
  const components = COMPONENTS[accessor.type];
  const size = SIZES[accessor.componentType];
  if (components === undefined || size === undefined) throw new OgwError(`${where}: accessor ${String(index)} has type ${accessor.type} of component type ${String(accessor.componentType)}`);
  const values = new Array<number>(accessor.count * components).fill(0);
  if (accessor.bufferView !== undefined) {
    const view = viewOf(glb, accessor.bufferView, where);
    const stride = view.stride ?? components * size;
    const base = view.offset + (accessor.byteOffset ?? 0);
    for (let i = 0; i < accessor.count; i++) for (let c = 0; c < components; c++) values[i * components + c] = readComponent(glb.bin, base + i * stride + c * size, accessor.componentType);
  }
  if (accessor.sparse) applySparse(glb, accessor, values, components, size, where);
  return { values, components, accessor };
}

/** Writes the values of a sparse accessor over its base values. */
function applySparse(glb: Glb, accessor: Accessor, values: number[], components: number, size: number, where: string): void {
  const sparse = accessor.sparse as NonNullable<Accessor['sparse']>;
  const iv = viewOf(glb, sparse.indices.bufferView, where);
  const vv = viewOf(glb, sparse.values.bufferView, where);
  const isize = SIZES[sparse.indices.componentType] ?? 4;
  for (let s = 0; s < sparse.count; s++) {
    const target = readComponent(glb.bin, iv.offset + (sparse.indices.byteOffset ?? 0) + s * isize, sparse.indices.componentType);
    for (let c = 0; c < components; c++) values[target * components + c] = readComponent(glb.bin, vv.offset + (sparse.values.byteOffset ?? 0) + (s * components + c) * size, accessor.componentType);
  }
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function sameValues(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Nodes with a `mesh` whose transform is not the identity, as messages. */
export function transformProblems(glb: Glb): string[] {
  const out: string[] = [];
  for (const [i, node] of (glb.json.nodes ?? []).entries()) {
    if (node.mesh === undefined) continue;
    const name = node.name === undefined ? `node ${String(i)}` : `node ${String(i)} \`${node.name}\``;
    const parts: [string, number[] | undefined, number[]][] = [
      ['matrix', node.matrix, IDENTITY_MATRIX],
      ['translation', node.translation, [0, 0, 0]],
      ['rotation', node.rotation, [0, 0, 0, 1]],
      ['scale', node.scale, [1, 1, 1]],
    ];
    for (const [what, value, identity] of parts) {
      if (value !== undefined && !sameValues(value, identity)) out.push(`${name} of mesh ${String(node.mesh)} has ${what} [${value.join(', ')}]; apply it to the mesh so that the node transform is the identity`);
    }
  }
  return out;
}

/**
 * UV coordinates as exact integers over one denominator (2^149 × 255 × 65535) for every component type: a float is a
 * float32, which times 2^149 is an integer, and a normalized byte or short is c/255 or c/65535.
 */
function exactUv(raw: number, accessor: Accessor): bigint {
  if (accessor.componentType === 5126) return BigInt(raw * 2 ** 149) * 255n * 65535n;
  if (accessor.componentType === 5121 && accessor.normalized === true) return BigInt(raw) * 2n ** 149n * 65535n;
  if (accessor.componentType === 5123 && accessor.normalized === true) return BigInt(raw) * 2n ** 149n * 255n;
  throw new OgwError(`TEXCOORD_0 of component type ${String(accessor.componentType)} is not a glTF texture coordinate type`);
}

interface UvTriangle {
  /** Exact coordinates: x0, y0, x1, y1, x2, y2. */
  p: bigint[];
  /** Exact bounding box: min x, min y, max x, max y. */
  exactBox: [bigint, bigint, bigint, bigint];
  /** Approximate bounding box, which chooses the pairs to check. */
  box: [number, number, number, number];
  label: string;
}

/** Triangle vertex index triples of a primitive (`mode` 4, 5 or 6); none for points and lines. */
function triangleIndices(glb: Glb, prim: Primitive, count: number, where: string): number[][] {
  const order = prim.indices === undefined ? Array.from({ length: count }, (_, i) => i) : accessorValues(glb, prim.indices, where).values;
  const mode = prim.mode ?? 4;
  const out: number[][] = [];
  if (mode === 4) for (let i = 0; i + 2 < order.length; i += 3) out.push([order[i] as number, order[i + 1] as number, order[i + 2] as number]);
  // the winding of a strip triangle does not change whether it overlaps another
  if (mode === 5) for (let i = 0; i + 2 < order.length; i++) out.push([order[i] as number, order[i + 1] as number, order[i + 2] as number]);
  if (mode === 6) for (let i = 1; i + 1 < order.length; i++) out.push([order[0] as number, order[i] as number, order[i + 1] as number]);
  return out;
}

function orient(ax: bigint, ay: bigint, bx: bigint, by: bigint, cx: bigint, cy: bigint): bigint {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function sign(v: bigint): number {
  return v > 0n ? 1 : v < 0n ? -1 : 0;
}

/**
 * True when an edge line of `a` (whose winding sign is `dir`) has every vertex of `b` on its outer side or on it. A
 * triangle with no area (`dir` 0) has no interior, and it separates every triangle.
 */
function separates(a: readonly bigint[], dir: number, b: readonly bigint[]): boolean {
  for (let e = 0; e < 3; e++) {
    const [ax, ay, bx, by] = [a[e * 2] as bigint, a[e * 2 + 1] as bigint, a[((e + 1) % 3) * 2] as bigint, a[((e + 1) % 3) * 2 + 1] as bigint];
    let outside = true;
    for (let v = 0; v < 3 && outside; v++) if (sign(orient(ax, ay, bx, by, b[v * 2] as bigint, b[v * 2 + 1] as bigint)) * dir > 0) outside = false;
    if (outside) return true;
  }
  return false;
}

/** Whether the interiors of two triangles intersect: no edge line of either separates them. A triangle with no area has no interior. */
export function interiorsIntersect(a: readonly bigint[], b: readonly bigint[]): boolean {
  const da = sign(orient(a[0] as bigint, a[1] as bigint, a[2] as bigint, a[3] as bigint, a[4] as bigint, a[5] as bigint));
  const db = sign(orient(b[0] as bigint, b[1] as bigint, b[2] as bigint, b[3] as bigint, b[4] as bigint, b[5] as bigint));
  return !separates(a, da, b) && !separates(b, db, a);
}

function uvTriangles(glb: Glb, where: string): UvTriangle[] {
  const out: UvTriangle[] = [];
  for (const [m, mesh] of (glb.json.meshes ?? []).entries()) {
    for (const [p, prim] of mesh.primitives.entries()) {
      const uvIndex = prim.attributes.TEXCOORD_0;
      if (uvIndex === undefined) continue;
      const uv = accessorValues(glb, uvIndex, where);
      const exact = uv.values.map((v) => exactUv(v, uv.accessor));
      const approx = uv.values.map((v) => (uv.accessor.componentType === 5126 ? v : v / (uv.accessor.componentType === 5121 ? 255 : 65535)));
      for (const [t, tri] of triangleIndices(glb, prim, uv.accessor.count, where).entries()) {
        if (tri.some((i) => i >= uv.accessor.count)) throw new OgwError(`${where}: triangle ${String(t)} of mesh ${String(m)} primitive ${String(p)} has an index past TEXCOORD_0`);
        const pts = tri.flatMap((i) => [exact[i * 2] as bigint, exact[i * 2 + 1] as bigint]);
        const xs = tri.map((i) => approx[i * 2] as number);
        const ys = tri.map((i) => approx[i * 2 + 1] as number);
        const ex = [pts[0], pts[2], pts[4]] as bigint[];
        const ey = [pts[1], pts[3], pts[5]] as bigint[];
        const lo = (v: bigint[]): bigint => v.reduce((a, b) => (b < a ? b : a));
        const hi = (v: bigint[]): bigint => v.reduce((a, b) => (b > a ? b : a));
        out.push({
          p: pts,
          exactBox: [lo(ex), lo(ey), hi(ex), hi(ey)],
          box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
          label: `triangle ${String(t)} of mesh ${String(m)} primitive ${String(p)}`,
        });
      }
    }
  }
  return out;
}

/** min u, min v, max u, max v. */
type Box = [number, number, number, number];

/** The median of `values`. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

interface UvGrid {
  /** The level of each box: the lowest level whose cell is as large as the box. */
  levelOf: number[];
  /** The levels that hold a box, lowest first. */
  levels: number[];
  /** The keys of the cells of level `k` that box `b` meets. */
  cellsOf: (b: Box, k: number) => string[];
}

/**
 * The grid of levels of `uvOverlap` over `boxes`: the cells of level 0 have the median width and height of the boxes,
 * and each level doubles them. The cells count from the median low corner of the boxes, which keeps every cell index
 * within about 2 × 10^9: each box is at least the two margins of its coordinates wide, and a box of at most the median
 * width lies at or past that corner, so a far box does not make the indices of the others large.
 */
function uvGrid(boxes: readonly Box[]): UvGrid {
  const [su, sv] = [median(boxes.map((b) => b[2] - b[0])), median(boxes.map((b) => b[3] - b[1]))];
  const [u0, v0] = [median(boxes.map((b) => b[0])), median(boxes.map((b) => b[1]))];
  const levelOf = boxes.map((b) => {
    let k = 0;
    while (b[2] - b[0] > su * 2 ** k || b[3] - b[1] > sv * 2 ** k) k++;
    return k;
  });
  const cellsOf = (b: Box, k: number): string[] => {
    const [cu, cv] = [su * 2 ** k, sv * 2 ** k];
    const keys: string[] = [];
    for (let x = Math.floor((b[0] - u0) / cu); x <= Math.floor((b[2] - u0) / cu); x++) {
      for (let y = Math.floor((b[1] - v0) / cv); y <= Math.floor((b[3] - v0) / cv); y++) keys.push(`${String(k)} ${String(x)} ${String(y)}`);
    }
    return keys;
  };
  return { levelOf, levels: [...new Set(levelOf)].sort((a, b) => a - b), cellsOf };
}

/**
 * The first pair of triangles of `TEXCOORD_0` whose interiors intersect, as `<triangle> and <triangle>` in list order, or
 * null when no pair does. The pairs to check come from the grid of `uvGrid`, where a triangle is kept at its level. The
 * triangles are taken from the highest level down, each checked against those taken before it in the cells that its
 * box meets at its level and above, so that each pair whose boxes meet is checked once, the work follows those pairs
 * whichever way the UV islands lie, and the check stops at the first overlap.
 */
export function uvOverlap(glb: Glb, where: string): string | null {
  const tris = uvTriangles(glb, where);
  if (tris.length < 2) return null;
  // the approximate boxes, grown by a margin for rounding, only choose the pairs to check; the exact boxes and points decide
  const boxes = tris.map((t): Box => [t.box[0] - margin(t.box[0]), t.box[1] - margin(t.box[1]), t.box[2] + margin(t.box[2]), t.box[3] + margin(t.box[3])]);
  const { levelOf, levels, cellsOf } = uvGrid(boxes);
  const grid = new Map<string, number[]>();
  const order = tris.map((_, i) => i).sort((a, b) => (levelOf[b] as number) - (levelOf[a] as number) || a - b);
  for (const i of order) {
    const [t, b, own] = [tris[i] as UvTriangle, boxes[i] as Box, levelOf[i] as number];
    const met = new Set<number>();
    for (const k of levels) if (k >= own) for (const key of cellsOf(b, k)) for (const j of grid.get(key) ?? []) met.add(j);
    for (const j of [...met].sort((x, y) => x - y)) {
      const o = tris[j] as UvTriangle;
      if (overlaps(o, t)) return j < i ? `${o.label} and ${t.label}` : `${t.label} and ${o.label}`;
    }
    for (const key of cellsOf(b, own)) {
      const members = grid.get(key);
      if (members) members.push(i);
      else grid.set(key, [i]);
    }
  }
  return null;
}

/** Whether the interiors of two triangles intersect, their exact boxes first. */
function overlaps(a: UvTriangle, b: UvTriangle): boolean {
  const [ea, eb] = [a.exactBox, b.exactBox];
  if (ea[2] <= eb[0] || eb[2] <= ea[0] || ea[3] <= eb[1] || eb[3] <= ea[1]) return false;
  return interiorsIntersect(a.p, b.p);
}

/** A bound on the rounding of an approximate UV coordinate near `v`. */
function margin(v: number): number {
  return 1e-9 * (1 + Math.abs(v));
}

/** The finalize check of a `model` GLB: the problems of its node transforms and its UV overlap. */
export function modelProblems(data: Buffer, where: string): string[] {
  const glb = readGlb(data, where);
  const out = transformProblems(glb).map((p) => `${where}: ${p}`);
  const overlap = uvOverlap(glb, where);
  if (overlap) out.push(`${where}: TEXCOORD_0 triangles overlap: ${overlap}; unwrap the UVs so that no two faces share UV space`);
  return out;
}

