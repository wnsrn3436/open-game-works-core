/** GLB files for the model checks of `ogw resource finalize`. */

export interface Attr {
  data: Buffer;
  componentType: number;
  type: string;
  count: number;
  normalized?: boolean;
}

/** A GLB with one mesh per item of `prims` (each `{uv, indices, mode}`) and the given node fields. */
export function glbOf(prims: { uv: Attr; indices?: number[]; mode?: number }[], node: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Buffer {
  const chunks: Buffer[] = [];
  const views: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  const accessors: Record<string, unknown>[] = [];
  let length = 0;
  const add = (data: Buffer, acc: Record<string, unknown>): number => {
    const pad = (4 - (length % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      length += pad;
    }
    views.push({ buffer: 0, byteOffset: length, byteLength: data.length });
    chunks.push(data);
    length += data.length;
    accessors.push({ bufferView: views.length - 1, ...acc });
    return accessors.length - 1;
  };
  const meshes = prims.map((p) => {
    const uv = add(p.uv.data, { componentType: p.uv.componentType, type: p.uv.type, count: p.uv.count, ...(p.uv.normalized ? { normalized: true } : {}) });
    const prim: Record<string, unknown> = { attributes: { TEXCOORD_0: uv }, ...(p.mode === undefined ? {} : { mode: p.mode }) };
    if (p.indices) {
      const data = Buffer.alloc(p.indices.length * 2);
      p.indices.forEach((v, i) => data.writeUInt16LE(v, i * 2));
      prim.indices = add(data, { componentType: 5123, type: 'SCALAR', count: p.indices.length });
    }
    return { primitives: [prim] };
  });
  const bin = Buffer.concat([...chunks, Buffer.alloc((4 - (length % 4)) % 4)]);
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, nodes: meshes.map((_, i) => ({ mesh: i, ...node })), meshes, accessors, bufferViews: views, buffers: [{ byteLength: bin.length }], ...extra }));
  const jsonPadded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + bin.length, 8);
  const chunk = (len: number, type: number): Buffer => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(len, 0);
    h.writeUInt32LE(type, 4);
    return h;
  };
  return Buffer.concat([header, chunk(jsonPadded.length, 0x4e4f534a), jsonPadded, chunk(bin.length, 0x004e4942), bin]);
}

export function floatUv(points: number[]): Attr {
  const data = Buffer.alloc(points.length * 4);
  points.forEach((v, i) => data.writeFloatLE(v, i * 4));
  return { data, componentType: 5126, type: 'VEC2', count: points.length / 2 };
}

