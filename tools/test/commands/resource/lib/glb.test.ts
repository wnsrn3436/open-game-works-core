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

  it('finds no overlap in a clean unwrap, and every overlapping pair in float and normalized byte UVs', () => {
    const clean = glbOf([{ uv: floatUv([0, 0, 0.5, 0, 0, 0.5, 0.5, 0.5]), indices: [0, 1, 2, 1, 3, 2] }]);
    expect(uvOverlap(readGlb(clean, 'm'), 'm')).toBeNull();
    const overlapped = glbOf([{ uv: floatUv([0, 0, 0.5, 0, 0, 0.5, 0.1, 0.1, 0.4, 0.1, 0.1, 0.4]) }, { uv: byteUv([0, 0, 64, 0, 0, 64]) }]);
    expect(uvOverlap(readGlb(overlapped, 'm'), 'm')).toEqual({ pairs: 3, first: 'triangle 0 of mesh 0 primitive 0 and triangle 1 of mesh 0 primitive 0' });
    // a strip and a fan list their triangles by the glTF rules
    // normalized bytes are c/255: this byte triangle stays under 0.26, away from the float one
    const apart = glbOf([{ uv: floatUv([10, 10, 20, 10, 10, 20]) }, { uv: byteUv([0, 0, 64, 0, 0, 64]) }]);
    expect(uvOverlap(readGlb(apart, 'm'), 'm')).toBeNull();
    // the indices name the triangles: the same triangle twice overlaps
    const twice = glbOf([{ uv: floatUv([0, 0, 1, 0, 0, 1, 5, 5]), indices: [0, 1, 2, 0, 1, 2] }]);
    expect(uvOverlap(readGlb(twice, 'm'), 'm')?.pairs).toBe(1);
    const strip = glbOf([{ uv: floatUv([0, 0, 0, 1, 1, 0, 1, 1]), mode: 5 }]);
    expect(uvOverlap(readGlb(strip, 'm'), 'm')).toBeNull();
    const folded = glbOf([{ uv: floatUv([0, 0, 1, 0, 0, 1, 0.9, 0.9]), mode: 6, indices: [0, 1, 2, 3, 0] }]);
    expect(uvOverlap(readGlb(folded, 'm'), 'm')?.pairs).toBe(1);
  });

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
    expect(uvOverlap(parsed, 'm')?.pairs).toBe(1);
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
      'model.glb: 1 pairs of TEXCOORD_0 triangles overlap, first triangle 0 of mesh 0 primitive 0 and triangle 1 of mesh 0 primitive 0; unwrap the UVs so that no two faces share UV space',
    ]);
    expect(() => modelProblems(Buffer.from('not a glb at all, no'), 'x.glb')).toThrow('x.glb: not a binary glTF 2.0 file');
  });
});
