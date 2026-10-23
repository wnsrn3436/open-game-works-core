/** Minimal glTF 2.0 binary writers for placeholder `model` and `rig` resources. */

const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

class GlbBuilder {
  private readonly chunks: Buffer[] = [];
  private length = 0;
  readonly bufferViews: { buffer: number; byteOffset: number; byteLength: number; target?: number }[] = [];
  readonly accessors: Accessor[] = [];

  add(data: Buffer, componentType: number, type: string, count: number, target?: number, bounds?: { min: number[]; max: number[] }): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad > 0) this.push(Buffer.alloc(pad));
    this.bufferViews.push({ buffer: 0, byteOffset: this.length, byteLength: data.length, ...(target === undefined ? {} : { target }) });
    this.push(data);
    this.accessors.push({ bufferView: this.bufferViews.length - 1, componentType, count, type, ...(bounds ?? {}) });
    return this.accessors.length - 1;
  }

  private push(data: Buffer): void {
    this.chunks.push(data);
    this.length += data.length;
  }

  build(json: Record<string, unknown>): Buffer {
    const bin = Buffer.concat(this.chunks);
    const binPadded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    const doc = { asset: { version: '2.0', generator: 'ogw' }, ...json, accessors: this.accessors, bufferViews: this.bufferViews, buffers: [{ byteLength: binPadded.length }] };
    const text = Buffer.from(JSON.stringify(doc), 'utf8');
    const jsonPadded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12);
    header.write('glTF', 0, 'ascii');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binPadded.length, 8);
    return Buffer.concat([header, chunkHeader(jsonPadded.length, 0x4e4f534a), jsonPadded, chunkHeader(binPadded.length, 0x004e4942), binPadded]);
  }
}

function chunkHeader(length: number, type: number): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(length, 0);
  header.writeUInt32LE(type, 4);
  return header;
}

function floats(values: readonly number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buffer.writeFloatLE(v, i * 4));
  return buffer;
}

function bounds(positions: readonly number[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const axis = i % 3;
    const f = Math.fround(positions[i] as number);
    min[axis] = Math.min(min[axis] as number, f);
    max[axis] = Math.max(max[axis] as number, f);
  }
  return { min, max };
}

type Vec3 = [number, number, number];

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

const FACES: readonly { quad: number[]; normal: Vec3 }[] = [
  { quad: [1, 3, 7, 5], normal: [1, 0, 0] },
  { quad: [0, 4, 6, 2], normal: [-1, 0, 0] },
  { quad: [2, 6, 7, 3], normal: [0, 1, 0] },
  { quad: [0, 1, 5, 4], normal: [0, -1, 0] },
  { quad: [4, 5, 7, 6], normal: [0, 0, 1] },
  { quad: [0, 2, 3, 1], normal: [0, 0, -1] },
];

/** A box of size x, y (up), z in metres: centered on x and z, from y 0 up. */
export function boxGlb(x: number, y: number, z: number): Buffer {
  const corner = (i: number): Vec3 => [(i & 1) !== 0 ? x / 2 : -x / 2, (i & 2) !== 0 ? y : 0, (i & 4) !== 0 ? z / 2 : -z / 2];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const face of FACES) {
    let quad = face.quad.map(corner);
    const n = cross(sub(quad[1] as Vec3, quad[0] as Vec3), sub(quad[2] as Vec3, quad[0] as Vec3));
    if (n[0] * face.normal[0] + n[1] * face.normal[1] + n[2] * face.normal[2] < 0) quad = quad.reverse();
    const base = positions.length / 3;
    for (const p of quad) {
      positions.push(...p);
      normals.push(...face.normal);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const glb = new GlbBuilder();
  const position = glb.add(floats(positions), FLOAT, 'VEC3', positions.length / 3, 34962, bounds(positions));
  const normal = glb.add(floats(normals), FLOAT, 'VEC3', normals.length / 3, 34962);
  const indexData = Buffer.alloc(indices.length * 2);
  indices.forEach((v, i) => indexData.writeUInt16LE(v, i * 2));
  const index = glb.add(indexData, UNSIGNED_SHORT, 'SCALAR', indices.length, 34963);
  return glb.build({
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'box', mesh: 0 }],
    meshes: [{ name: 'box', primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices: index }] }],
  });
}

/** A skin with one joint `root` and one small skinned triangle, imported by Godot as a `Skeleton3D` with one bone. */
export function oneBoneRigGlb(): Buffer {
  const positions = [0, 0, 0, 0.1, 0, 0, 0, 0.1, 0];
  const glb = new GlbBuilder();
  const position = glb.add(floats(positions), FLOAT, 'VEC3', 3, 34962, bounds(positions));
  const joints = glb.add(Buffer.alloc(12), UNSIGNED_BYTE, 'VEC4', 3, 34962);
  const weights = glb.add(floats([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), FLOAT, 'VEC4', 3, 34962);
  const inverseBind = glb.add(floats([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), FLOAT, 'MAT4', 1);
  return glb.build({
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'mesh', mesh: 0, skin: 0 }, { name: 'root' }],
    skins: [{ joints: [1], inverseBindMatrices: inverseBind }],
    meshes: [{ name: 'mesh', primitives: [{ attributes: { POSITION: position, JOINTS_0: joints, WEIGHTS_0: weights } }] }],
  });
}
