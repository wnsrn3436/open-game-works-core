import { describe, expect, it } from 'vitest';
import { interiorsIntersect, modelProblems, readGlb, transformProblems, uvOverlap } from '../../../../src/commands/resource/lib/glb.ts';
import { boxGlb } from '../../../../src/commands/resource/lib/gltf.ts';
import { floatUv, glbOf, type Attr } from './glb-fixture.ts';

function byteUv(points: number[]): Attr {
  return { data: Buffer.from(points), componentType: 5121, type: 'VEC2', count: points.length / 2, normalized: true };
}

const big = (pts: number[]): bigint[] => pts.map((v) => BigInt(v));

describe('glb model checks', () => {
  it('decides whether the interiors of two triangles intersect', () => {
    const a = big([0, 0, 4, 0, 0, 4]);
    expect(interiorsIntersect(a, big([1, 1, 5, 1, 1, 5]))).toBe(true);
    expect(interiorsIntersect(a, big([4, 0, 4, 4, 0, 4]))).toBe(false); // shares an edge
    expect(interiorsIntersect(a, big([4, 0, 8, 0, 4, 4]))).toBe(false); // shares a vertex
    expect(interiorsIntersect(a, big([0, 0, 0, 4, 4, 0]))).toBe(true); // the same triangle, other winding
    expect(interiorsIntersect(a, big([1, 1, 1, 1, 2, 2]))).toBe(false); // no area
    expect(interiorsIntersect(a, big([1, 1, 2, 1, 1, 2]))).toBe(true); // inside
    expect(interiorsIntersect(big([0, 0, 2, 2, 2, -2]), big([0, 0, -2, 2, -2, -2]))).toBe(false); // tips meet
    expect(interiorsIntersect(big([0, 0, 10, 0, 5, 1]), big([5, 0, 6, -1, 6, 3]))).toBe(true); // crossing edges
    // only an edge of the second separates them
    expect(interiorsIntersect(big([0, 0, 100, 0, 100, 17]), big([0, 0, -17, 98, 0, -100]))).toBe(false);
    expect(interiorsIntersect(big([0, 0, -17, 98, 0, -100]), big([0, 0, 100, 0, 100, 17]))).toBe(false);
  });

  it('finds no overlap in a clean unwrap, and an overlapping pair in float and normalized byte UVs', () => {
    const clean = glbOf([{ uv: floatUv([0, 0, 0.5, 0, 0, 0.5, 0.5, 0.5]), indices: [0, 1, 2, 1, 3, 2] }]);
    expect(uvOverlap(readGlb(clean, 'm'), 'm')).toBeNull();
    const outer = [0, 0, 0.5, 0, 0, 0.5];
    const inner = [0.1, 0.1, 0.4, 0.1, 0.1, 0.4];
    const bytes = byteUv([0, 0, 64, 0, 0, 64]);
    expect(uvOverlap(readGlb(glbOf([{ uv: floatUv([...outer, ...inner]) }]), 'm'), 'm')).toBe('triangle 0 of mesh 0 primitive 0 and triangle 1 of mesh 0 primitive 0');
    expect(uvOverlap(readGlb(glbOf([{ uv: floatUv(outer) }, { uv: bytes }]), 'm'), 'm')).toBe('triangle 0 of mesh 0 primitive 0 and triangle 0 of mesh 1 primitive 0');
    expect(uvOverlap(readGlb(glbOf([{ uv: floatUv(inner) }, { uv: bytes }]), 'm'), 'm')).toBe('triangle 0 of mesh 0 primitive 0 and triangle 0 of mesh 1 primitive 0');
    // a strip and a fan list their triangles by the glTF rules
    // normalized bytes are c/255: this byte triangle stays under 0.26, away from the float one
    const apart = glbOf([{ uv: floatUv([10, 10, 20, 10, 10, 20]) }, { uv: bytes }]);
    expect(uvOverlap(readGlb(apart, 'm'), 'm')).toBeNull();
    // the indices name the triangles: the same triangle twice overlaps
    const twice = glbOf([{ uv: floatUv([0, 0, 1, 0, 0, 1, 5, 5]), indices: [0, 1, 2, 0, 1, 2] }]);
    expect(uvOverlap(readGlb(twice, 'm'), 'm')).toBe('triangle 0 of mesh 0 primitive 0 and triangle 1 of mesh 0 primitive 0');
    const strip = glbOf([{ uv: floatUv([0, 0, 0, 1, 1, 0, 1, 1]), mode: 5 }]);
    expect(uvOverlap(readGlb(strip, 'm'), 'm')).toBeNull();
    const folded = glbOf([{ uv: floatUv([0, 0, 1, 0, 0, 1, 0.9, 0.9]), mode: 6, indices: [0, 1, 2, 3, 0] }]);
    expect(uvOverlap(readGlb(folded, 'm'), 'm')).toBe('triangle 0 of mesh 0 primitive 0 and triangle 1 of mesh 0 primitive 0');
  });

  it('finds a pair whose boxes meet while other triangles start between them in u', () => {
    // a wide flat triangle along the bottom, a row of small triangles above it, and a last one inside the wide one
    const wide = [0, 0, 10, 0, 0, 0.1];
    const row = Array.from({ length: 50 }, (_, i) => [i * 0.2, 1, i * 0.2 + 0.1, 1, i * 0.2, 1.1]).flat();
    const inside = [5, 0, 5.5, 0, 5, 0.04];
    expect(uvOverlap(readGlb(glbOf([{ uv: floatUv([...wide, ...row, ...inside]) }]), 'm'), 'm')).toBe('triangle 0 of mesh 0 primitive 0 and triangle 51 of mesh 0 primitive 0');
    expect(uvOverlap(readGlb(glbOf([{ uv: floatUv([...wide, ...row, 5, 0.06, 5.5, 0.06, 5, 0.1]) }]), 'm'), 'm')).toBeNull();
    // the triangles in another order than their u: the pair is found whatever triangle comes between them in the list
    expect(uvOverlap(readGlb(glbOf([{ uv: floatUv([0, 0, 1, 0, 0, 1, 5, 0, 6, 0, 5, 1, 0.1, 0.1, 0.5, 0.1, 0.1, 0.5]) }]), 'm'), 'm')).toBe(
      'triangle 0 of mesh 0 primitive 0 and triangle 2 of mesh 0 primitive 0',
    );
  });

  /** A clean unwrap of [0, 1]² as `n` × `n` quads of two triangles each, and `extra` triangles after them. */
  function unwrap(n: number, extra: number[] = []): Buffer {
    const points: number[] = [];
    for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) points.push(x / n, y / n);
    const indices: number[] = [];
    const at = (x: number, y: number): number => y * (n + 1) + x;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) indices.push(at(x, y), at(x + 1, y), at(x, y + 1), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1));
    const first = points.length / 2;
    points.push(...extra);
    for (let i = 0; i < extra.length / 2; i++) indices.push(first + i);
    return glbOf([{ uv: floatUv(points), indices }]);
  }

  it('checks a clean unwrap of 20000 triangles with an island far outside the 0-1 tile', () => {
    expect(uvOverlap(readGlb(unwrap(100, [100, 100, 101, 100, 100, 101]), 'm'), 'm')).toBeNull();
    // a triangle laid over the last quad overlaps it
    expect(uvOverlap(readGlb(unwrap(100, [0.995, 0.995, 0.999, 0.995, 0.995, 0.999]), 'm'), 'm')).toBe('triangle 19999 of mesh 0 primitive 0 and triangle 20000 of mesh 0 primitive 0');
  }, 20_000);

  it('stops at the first overlapping pair of an unwrap whose 20000 triangles all cover the unit square', () => {
    const indices = Array.from({ length: 10_000 }, () => [0, 1, 2, 1, 3, 2]).flat();
    const reset = glbOf([{ uv: floatUv([0, 0, 1, 0, 0, 1, 1, 1]), indices }]);
    // the two triangles of one quad share an edge; the first triangle of the next quad lies on the first one
    expect(uvOverlap(readGlb(reset, 'm'), 'm')).toBe('triangle 0 of mesh 0 primitive 0 and triangle 2 of mesh 0 primitive 0');
  }, 20_000);

  it('reads the values of a sparse accessor over its base values', () => {
    // base: two triangles apart; the sparse values move the second onto the first
    const base = floatUv([0, 0, 1, 0, 0, 1, 5, 5, 6, 5, 5, 6]);
    const sparseIndices = Buffer.alloc(6);
    [3, 4, 5].forEach((v, i) => sparseIndices.writeUInt16LE(v, i * 2));
    const sparseValues = floatUv([0, 0, 1, 0, 0, 1]).data;
    const glb = glbOf([{ uv: base }], {}, {});
    const parsed = readGlb(glb, 'm');
    const bin = Buffer.concat([parsed.bin, sparseIndices, Buffer.alloc(2), sparseValues]);
    const at = parsed.bin.length;
    parsed.bin = bin;
    parsed.json.bufferViews = [...(parsed.json.bufferViews ?? []), { buffer: 0, byteOffset: at, byteLength: 6 }, { buffer: 0, byteOffset: at + 8, byteLength: sparseValues.length }];
    const accessor = (parsed.json.accessors ?? [])[0] as { sparse?: unknown };
    accessor.sparse = { count: 3, indices: { bufferView: 1, componentType: 5123 }, values: { bufferView: 2 } };
    expect(uvOverlap(parsed, 'm')).toBe('triangle 0 of mesh 0 primitive 0 and triangle 1 of mesh 0 primitive 0');
    delete accessor.sparse;
    expect(uvOverlap(parsed, 'm')).toBeNull();
  });

  it('finds a mesh node whose transform is not the identity', () => {
    expect(transformProblems(readGlb(boxGlb(1, 1, 1), 'm'))).toEqual([]);
    const uv = { uv: floatUv([0, 0, 1, 0, 0, 1]) };
    expect(transformProblems(readGlb(glbOf([uv], { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }), 'm'))).toEqual([]);
    expect(transformProblems(readGlb(glbOf([uv], { name: 'body', translation: [0, 0.5, 0], scale: [2, 2, 2] }), 'm'))).toEqual([
      'node 0 `body` of mesh 0 has translation [0, 0.5, 0]; apply it to the mesh so that the node transform is the identity',
      'node 0 `body` of mesh 0 has scale [2, 2, 2]; apply it to the mesh so that the node transform is the identity',
    ]);
    expect(transformProblems(readGlb(glbOf([uv], { rotation: [0, 0.7071, 0, 0.7071], matrix: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }), 'm'))).toHaveLength(2);
    // a node without a mesh (an armature, a parent) is not checked
    expect(transformProblems(readGlb(glbOf([uv], {}, { nodes: [{ mesh: 0 }, { translation: [1, 0, 0] }] }), 'm'))).toEqual([]);
  });

  it('gives the problems of a model file and refuses a file that is not a GLB', () => {
    expect(modelProblems(boxGlb(1, 2, 3), 'model.glb')).toEqual([]);
    const both = glbOf([{ uv: floatUv([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]) }], { translation: [1, 0, 0] });
    expect(modelProblems(both, 'model.glb')).toEqual([
      'model.glb: node 0 of mesh 0 has translation [1, 0, 0]; apply it to the mesh so that the node transform is the identity',
      'model.glb: TEXCOORD_0 triangles overlap: triangle 0 of mesh 0 primitive 0 and triangle 1 of mesh 0 primitive 0; unwrap the UVs so that no two faces share UV space',
    ]);
    expect(() => modelProblems(Buffer.from('not a glb at all, no'), 'x.glb')).toThrow('x.glb: not a binary glTF 2.0 file');
  });
});
