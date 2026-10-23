import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { measureRecompose, partMesh, pointWeights } from '../../../src/commands/resource/lib/rig.ts';
import type { Skeleton } from '../../../src/commands/resource/lib/skeleton.ts';
import { ogw, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';

type Rect = [number, number, number, number, [number, number, number]];

const W = 40;
const H = 40;
const PARTS: Record<string, Rect> = {
  body: [10, 10, 30, 30, [200, 0, 0]],
  head: [14, 0, 26, 12, [0, 0, 200]],
  arm: [32, 14, 38, 20, [0, 200, 0]],
};

function raw(rects: readonly Rect[]): Buffer {
  const data = Buffer.alloc(W * H * 4);
  for (const [x0, y0, x1, y1, c] of rects) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([...c, 255], (y * W + x) * 4);
  }
  return data;
}

async function writePng(path: string, data: Buffer, width = W, height = H): Promise<void> {
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(path);
}

const SKELETON = {
  parts: [
    { name: 'body', bone: 'hips', image: 'image/hero/body', filled: false },
    { name: 'head', bone: 'neck', image: 'image/hero/head', filled: true },
    { name: 'arm', bone: 'arm', image: 'image/hero/arm', filled: false },
  ],
  bones: [
    { name: 'hips', parent: null },
    { name: 'neck', parent: 'hips' },
    { name: 'arm', parent: 'hips' },
    { name: 'tail', parent: 'hips' },
  ],
  animations: [{ name: 'idle', loop: true, duration_ms: 800 }],
};

interface Rig {
  ws: TestWorkspace;
  dir: string;
  source: string;
  skeleton: string;
  layers: string;
}

async function makeRig(skeleton: object = SKELETON): Promise<Rig> {
  const ws = makeWorkspace();
  const dir = join(ws.root, 'work');
  const layers = join(dir, 'layers');
  mkdirSync(layers, { recursive: true });
  const source = join(dir, 'source.png');
  await writePng(source, raw([PARTS.body, PARTS.head, PARTS.arm] as Rect[]));
  for (const [name, rect] of Object.entries(PARTS)) await writePng(join(layers, `${name}.png`), raw([rect]));
  const skeletonPath = join(dir, 'skeleton.json');
  writeFileSync(skeletonPath, JSON.stringify({ source, ...skeleton }));
  return { ws, dir, source, skeleton: skeletonPath, layers };
}

function split(rig: Rig, out: string, size = `${String(W)}x${String(H)}`): Promise<{ code: number; stdout: string; stderr: string }> {
  return ogw(rig.ws, ['resource', 'rig-split', '--source', rig.source, '--skeleton', rig.skeleton, '--layers', rig.layers, '--size', size, '--out', out]);
}

describe('ogw resource rig-split and rig-check', () => {
  it('cuts parts with a transparent border, sets initial pivots, measures recompose and writes the rig split JSON', async () => {
    const rig = await makeRig();
    const out = join(rig.dir, 'split');
    const run = await split(rig, out);
    expect(run.stderr).toBe('');
    const json = JSON.parse(readFileSync(join(out, 'rig-split.json'), 'utf8')) as Record<string, unknown>;
    expect(JSON.parse(run.stdout)).toEqual(json);
    // Each box widened by 3 px; the head box touches the top edge, so its offset is negative.
    expect(json).toEqual({
      source: rig.source,
      canvas: [40, 40],
      parts: [
        { name: 'body', file: join(out, 'body.png'), offset: [7, 7], size: [26, 26] },
        { name: 'head', file: join(out, 'head.png'), offset: [11, -3], size: [18, 18] },
        { name: 'arm', file: join(out, 'arm.png'), offset: [29, 11], size: [12, 12] },
      ],
      pivots: { hips: [20, 20], neck: [20, 11], arm: [32, 19], tail: [20, 20] },
      recompose: { alphaIou: 1, colorDiff: 0, status: 'pass', iouMin: 0.95, colorDiffMax: 8 },
    });
    expect(readdirSync(out).sort()).toEqual(['arm.png', 'body.png', 'head.png', 'rig-canvas.png', 'rig-split.json']);
    const head = await sharp(join(out, 'head.png')).raw().toBuffer({ resolveWithObject: true });
    expect([head.info.width, head.info.height]).toEqual([18, 18]);
    const alphaAt = (x: number, y: number): number => head.data[(y * 18 + x) * 4 + 3] as number;
    expect([alphaAt(2, 3), alphaAt(3, 2), alphaAt(3, 3), alphaAt(14, 14), alphaAt(15, 14), alphaAt(14, 15)]).toEqual([0, 0, 255, 255, 0, 0]);
    expect(await sharp(join(out, 'rig-canvas.png')).ensureAlpha().raw().toBuffer()).toEqual(raw([PARTS.body, PARTS.head, PARTS.arm] as Rect[]));

    const check = await ogw(rig.ws, ['resource', 'rig-check', join(out, 'rig-split.json'), '--json']);
    expect(check.code).toBe(0);
    expect(JSON.parse(check.stdout)).toEqual({ recompose: json.recompose });

    // The head turns white inside its border.
    const white = Buffer.alloc(18 * 18 * 4);
    for (let y = 3; y < 15; y++) for (let x = 3; x < 15; x++) white.fill(255, (y * 18 + x) * 4, (y * 18 + x) * 4 + 4);
    await writePng(join(out, 'head.png'), white, 18, 18);
    const failed = await ogw(rig.ws, ['resource', 'rig-check', join(out, 'rig-split.json'), '--json']);
    expect(failed.code).toBe(1);
    const recompose = (JSON.parse(failed.stdout) as { recompose: { status: string; alphaIou: number; colorDiff: number } }).recompose;
    expect(recompose.status).toBe('fail');
    expect(recompose.alphaIou).toBe(1);
    expect(recompose.colorDiff).toBeCloseTo((144 * ((255 + 255 + 55) / 3)) / (400 + 144 - 12 * 2 + 36), 9);
  });

  it('gives the parent pivot to a bone without parts and the canvas middle to such a root', async () => {
    const rig = await makeRig({
      parts: [{ name: 'arm', bone: 'child', image: 'image/hero/arm', filled: false }],
      bones: [{ name: 'root', parent: null }, { name: 'child', parent: 'root' }, { name: 'leaf', parent: 'root' }],
      animations: [],
    });
    rmSync(join(rig.layers, 'head.png'));
    rmSync(join(rig.layers, 'body.png'));
    const run = await split(rig, join(rig.dir, 'split'));
    const json = JSON.parse(run.stdout) as { pivots: Record<string, number[]>; recompose: { status: string; alphaIou: number } };
    expect(json.pivots).toEqual({ root: [20, 20], child: [35, 17], leaf: [20, 20] });
    expect(json.recompose.status).toBe('fail');
    expect(json.recompose.alphaIou).toBe(36 / 556);
  });

  it('picks the nearest point of B to the middle of P when they do not overlap', async () => {
    const rig = await makeRig({
      parts: [
        { name: 'head', bone: 'top', image: 'image/hero/head', filled: false },
        { name: 'arm', bone: 'side', image: 'image/hero/arm', filled: false },
      ],
      bones: [{ name: 'top', parent: null }, { name: 'side', parent: 'top' }],
      animations: [],
    });
    rmSync(join(rig.layers, 'body.png'));
    const json = JSON.parse((await split(rig, join(rig.dir, 's'))).stdout) as { pivots: Record<string, number[]> };
    expect(json.pivots).toEqual({ top: [20, 6], side: [32, 14] });
  });

  it.each([null, [1], 'x'])('does not read pivot (pivot %j)', async (pivot) => {
    const bones = SKELETON.bones.map((b) => ({ ...b, pivot }));
    const rig = await makeRig({ ...SKELETON, bones });
    const run = await split(rig, join(rig.dir, 'split'));
    expect(run.stderr).toBe('');
    expect((JSON.parse(run.stdout) as { pivots: unknown }).pivots).toEqual({ hips: [20, 20], neck: [20, 11], arm: [32, 19], tail: [20, 20] });
  });

  it('boxes a part by its pixels with alpha above 0 and recomposes only opaque pixels', async () => {
    const rig = await makeRig();
    // The arm [32, 14, 38, 20] gets a 1 px band of alpha 1..127 around it.
    const data = raw([PARTS.arm as Rect]);
    const [x0, y0, x1, y1] = [31, 13, 39, 21];
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (x >= 32 && x < 38 && y >= 14 && y < 20) continue;
        data.set([0, 200, 0, 1 + (n++ % 127)], (y * W + x) * 4);
      }
    }
    await writePng(join(rig.layers, 'arm.png'), data);
    const out = join(rig.dir, 'split');
    const json = JSON.parse((await split(rig, out)).stdout) as { parts: { name: string; offset: number[]; size: number[] }[]; recompose: object };
    expect(json.parts.find((p) => p.name === 'arm')).toMatchObject({ offset: [28, 10], size: [14, 14] });
    expect(json.recompose).toEqual({ alphaIou: 1, colorDiff: 0, status: 'pass', iouMin: 0.95, colorDiffMax: 8 });
    const arm = await sharp(join(out, 'arm.png')).raw().toBuffer({ resolveWithObject: true });
    expect([arm.info.width, arm.info.height]).toEqual([14, 14]);
    expect(arm.data[3]).toBe(0);
    expect(arm.data[(3 * 14 + 3) * 4 + 3]).toBe(1);
  });

  it('scales the source illustration and the layers to fit in --size at the center of the canvas', async () => {
    const rig = await makeRig();
    const out = join(rig.dir, 'split');
    const run = await split(rig, out, '40x20');
    expect(run.stderr).toBe('');
    const json = JSON.parse(run.stdout) as { canvas: number[]; parts: { name: string; offset: number[]; size: number[] }[]; recompose: { status: string } };
    expect(json.canvas).toEqual([40, 20]);
    expect(json.recompose.status).toBe('pass');
    const canvas = await sharp(join(out, 'rig-canvas.png')).raw().toBuffer({ resolveWithObject: true });
    expect([canvas.info.width, canvas.info.height]).toEqual([40, 20]);
    // The 40x40 illustration becomes 20x20 at x 10..30; the body [10, 30) becomes [15, 25) on the canvas.
    const alphaAt = (x: number, y: number): number => canvas.data[(y * 40 + x) * 4 + 3] as number;
    expect([alphaAt(9, 10), alphaAt(20, 10), alphaAt(30, 10)]).toEqual([0, 255, 0]);
    const body = json.parts.find((p) => p.name === 'body') as { offset: number[]; size: number[] };
    expect(body.offset[0]).toBeLessThanOrEqual(15 - 3);
    expect((body.offset[0] as number) + (body.size[0] as number)).toBeGreaterThanOrEqual(25 + 3);
    const check = await ogw(rig.ws, ['resource', 'rig-check', join(out, 'rig-split.json'), '--json']);
    expect(JSON.parse(check.stdout)).toEqual({ recompose: json.recompose });
  });

  it('gives colorDiff null and fail when no pixel is opaque in both, and cuts a part at the canvas edge', async () => {
    const rig = await makeRig({
      parts: [{ name: 'arm', bone: 'root', image: 'image/hero/arm', filled: false }],
      bones: [{ name: 'root', parent: null }],
      animations: [],
    });
    rmSync(join(rig.layers, 'head.png'));
    rmSync(join(rig.layers, 'body.png'));
    await writePng(join(rig.layers, 'arm.png'), raw([[0, 32, 6, 38, [0, 200, 0]]]));
    const json = JSON.parse((await split(rig, join(rig.dir, 'split'))).stdout) as { parts: object[]; recompose: object };
    expect(json.parts[0]).toMatchObject({ offset: [-3, 29], size: [12, 12] });
    expect(json.recompose).toEqual({ alphaIou: 0, colorDiff: null, status: 'fail', iouMin: 0.95, colorDiffMax: 8 });
    const source = { width: 2, height: 1, data: Buffer.from([0, 0, 0, 255, 0, 0, 0, 0]) };
    const part = { width: 1, height: 1, data: Buffer.from([0, 0, 0, 255]) };
    expect(measureRecompose(source, [{ image: part, offset: [1, 0] }], { iouMin: 0, colorDiffMax: 8 })).toEqual({
      alphaIou: 0,
      colorDiff: null,
      status: 'fail',
      iouMin: 0,
      colorDiffMax: 8,
    });
  });

  const failures: [string, (rig: Rig) => void | Promise<void>, string][] = [
    ['a missing layer', (rig) => { rmSync(join(rig.layers, 'arm.png')); }, 'missing layer arm.png'],
    ['a layer that is not an image', (rig) => { writeFileSync(join(rig.layers, 'arm.png'), ''); }, 'cannot read image'],
    ['an extra layer', (rig) => { writeFileSync(join(rig.layers, 'leg.png'), 'x'); }, 'layer leg.png is not a part'],
    ['a layer of another size', async (rig) => { await writePng(join(rig.layers, 'arm.png'), Buffer.alloc(4 * 4 * 4, 255), 4, 4); }, 'is not the source illustration size 40x40'],
    ['a skeleton spec source that is not --source', (rig) => { writeFileSync(rig.skeleton, JSON.stringify({ ...SKELETON, source: join(rig.dir, 'other.png') })); }, '/work/source.png is not the skeleton spec source '],
    ['a relative skeleton spec source', (rig) => { writeFileSync(rig.skeleton, JSON.stringify({ ...SKELETON, source: 'source.png' })); }, 'skeleton spec needs source (absolute path)'],
    ['an empty layer', async (rig) => { await writePng(join(rig.layers, 'arm.png'), Buffer.alloc(W * H * 4)); }, 'no pixel with alpha above 0'],
    ['a part bone not in bones', (rig) => { writeFileSync(rig.skeleton, JSON.stringify({ ...SKELETON, source: rig.source, parts: [{ ...SKELETON.parts[0], bone: 'leg' }, SKELETON.parts[1], SKELETON.parts[2]] })); }, 'part body bone leg is not in bones'],
    ['two roots', (rig) => { writeFileSync(rig.skeleton, JSON.stringify({ ...SKELETON, source: rig.source, bones: [...SKELETON.bones, { name: 'x', parent: null }] })); }, 'bones has 2 roots, needs 1'],
    ['a bone cycle', (rig) => { writeFileSync(rig.skeleton, JSON.stringify({ ...SKELETON, source: rig.source, bones: [...SKELETON.bones, { name: 'p', parent: 'q' }, { name: 'q', parent: 'p' }] })); }, 'bone p does not reach the root'],
    ['an unknown parent', (rig) => { writeFileSync(rig.skeleton, JSON.stringify({ ...SKELETON, source: rig.source, bones: [...SKELETON.bones, { name: 'p', parent: 'zz' }] })); }, 'bone p parent zz is not in bones'],
    ['weight bones without the bone', (rig) => { writeFileSync(rig.skeleton, JSON.stringify({ ...SKELETON, source: rig.source, parts: [{ ...SKELETON.parts[0], bones: ['neck', 'nope'] }, SKELETON.parts[1], SKELETON.parts[2]] })); }, 'part body bones does not contain its bone hips; part body bones has nope, which is not in bones'],
    ['a name that is not snake_case', (rig) => { writeFileSync(rig.skeleton, JSON.stringify({ ...SKELETON, source: rig.source, animations: [{ name: 'Idle', loop: true, duration_ms: 1 }, { name: 'Idle', loop: true, duration_ms: 1 }] })); }, 'animation name Idle is not snake_case; animation name Idle is not unique'],
    ['a bad part', (rig) => { writeFileSync(rig.skeleton, JSON.stringify({ ...SKELETON, source: rig.source, parts: [{ name: 'body' }] })); }, 'parts[0] needs name, bone, image (strings) and filled (boolean)'],
    ['a bad bone', (rig) => { writeFileSync(rig.skeleton, JSON.stringify({ ...SKELETON, source: rig.source, bones: [{ name: 'hips', parent: 3 }] })); }, 'bones[0] needs name (string) and parent (string or null)'],
    ['a bad weight list', (rig) => { writeFileSync(rig.skeleton, JSON.stringify({ ...SKELETON, source: rig.source, parts: [{ ...SKELETON.parts[0], bones: 'hips' }] })); }, 'parts[0].bones is not a list of bone names'],
    ['a bad animation', (rig) => { writeFileSync(rig.skeleton, JSON.stringify({ ...SKELETON, source: rig.source, animations: [{ name: 'idle', loop: 'yes', duration_ms: 1 }] })); }, 'animations[0] needs name (string), loop (boolean) and duration_ms (integer)'],
    ['no lists', (rig) => { writeFileSync(rig.skeleton, JSON.stringify({ source: rig.source })); }, 'skeleton spec needs source (absolute path), parts, bones and animations (lists)'],
  ];

  it.each(failures)('writes nothing on %s', async (_name, change, message) => {
    const rig = await makeRig();
    await change(rig);
    const out = join(rig.dir, 'split');
    const run = await split(rig, out);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(message);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(rig.dir).filter((e) => e.startsWith('.split'))).toEqual([]);
  });

  it('needs a new out folder and every option', async () => {
    const rig = await makeRig();
    mkdirSync(join(rig.dir, 'taken'));
    expect((await split(rig, join(rig.dir, 'taken'))).stderr).toContain('already exists; --out must be a new folder');
    expect((await ogw(rig.ws, ['resource', 'rig-split', '--source', rig.source])).stderr).toContain('usage: ogw resource rig-split');
    expect((await ogw(rig.ws, ['resource', 'rig-check'])).stderr).toContain('usage: ogw resource rig-check');
    for (const size of ['40', '0x40', '40x40.5', '40X40']) {
      const run = await split(rig, join(rig.dir, 'sized'), size);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(`--size ${size} is not <width>x<height> in px integers`);
    }
    expect(existsSync(join(rig.dir, 'sized'))).toBe(false);
  });

  it('rejects a rig split JSON of another form', async () => {
    const rig = await makeRig();
    const bad = join(rig.dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ source: 'relative.png', canvas: [1, 1], parts: [], pivots: {} }));
    expect((await ogw(rig.ws, ['resource', 'rig-check', bad])).stderr).toContain('rig split JSON needs source (absolute path)');
    writeFileSync(bad, JSON.stringify({ source: rig.source, canvas: [1, 1], parts: [{ name: 'a', file: 'a.png', offset: [0, 0], size: [1, 1] }], pivots: {} }));
    expect((await ogw(rig.ws, ['resource', 'rig-check', bad])).code).toBe(1);
    writeFileSync(bad, JSON.stringify({ source: rig.source, canvas: [1, 1], parts: [], pivots: { a: [1] } }));
    expect((await ogw(rig.ws, ['resource', 'rig-check', bad])).code).toBe(1);
    writeFileSync(bad, JSON.stringify({ source: rig.source, canvas: [0, 1.5], parts: [], pivots: {} }));
    expect((await ogw(rig.ws, ['resource', 'rig-check', bad])).stderr).toContain('canvas (positive integers)');
  });
});

describe('ogw resource rig-mesh', () => {
  const PIVOTED = {
    ...SKELETON,
    parts: [{ ...SKELETON.parts[0], bones: ['hips', 'neck', 'arm', 'tail'] }, SKELETON.parts[1], SKELETON.parts[2]],
    bones: [
      { name: 'hips', parent: null, pivot: [20, 20] },
      { name: 'neck', parent: 'hips', pivot: [20, 11] },
      { name: 'arm', parent: 'hips', pivot: [32, 19] },
      { name: 'tail', parent: 'hips', pivot: [20, 30] },
    ],
  };

  it('makes the same mesh and weights every time', async () => {
    const rig = await makeRig(PIVOTED);
    await split(rig, join(rig.dir, 'split'));
    const splitJson = join(rig.dir, 'split', 'rig-split.json');
    const run = await ogw(rig.ws, ['resource', 'rig-mesh', '--skeleton', rig.skeleton, '--split', splitJson, '--out', join(rig.dir, 'm1')]);
    expect(run.stderr).toBe('');
    expect(run.stdout.trim()).toBe(join(rig.dir, 'm1', 'body.mesh.json'));
    await ogw(rig.ws, ['resource', 'rig-mesh', '--skeleton', rig.skeleton, '--split', splitJson, '--out', join(rig.dir, 'm2')]);
    const a = readFileSync(join(rig.dir, 'm1', 'body.mesh.json'), 'utf8');
    expect(readFileSync(join(rig.dir, 'm2', 'body.mesh.json'), 'utf8')).toBe(a);
    expect(readdirSync(join(rig.dir, 'm1'))).toEqual(['body.mesh.json']);
    const mesh = JSON.parse(a) as { polygon: number[][]; uv: number[][]; polygons: number[][]; weights: Record<string, number[]> };
    expect(mesh.polygon.length).toBe(mesh.uv.length);
    mesh.polygon.forEach((p, i) => {
      expect(p).toEqual([(mesh.uv[i] as number[])[0] as number + 7, (mesh.uv[i] as number[])[1] as number + 7]);
    });
    // The body part image is 26x26 with the opaque pixels at 3..22; the shape grown by 2 px leaves 1 transparent px.
    expect(mesh.uv[0]).toEqual([3, 1]);
    expect(mesh.uv).toContainEqual([11, 11]);
    expect(mesh.uv.every(([x, y]) => (x as number) >= 1 && (x as number) <= 25 && (y as number) >= 1 && (y as number) <= 25)).toBe(true);
    expect(mesh.uv.some(([x]) => x === 1) && mesh.uv.some(([x]) => x === 25) && mesh.uv.some(([, y]) => y === 25)).toBe(true);
    expect(mesh.polygons.length).toBeGreaterThan(10);
    expect(Object.keys(mesh.weights)).toEqual(['hips', 'neck', 'arm', 'tail']);
    for (let i = 0; i < mesh.polygon.length; i++) {
      const ws = Object.values(mesh.weights).map((list) => list[i] as number);
      expect(ws.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 9);
      expect(ws.filter((w) => w > 0).length).toBeLessThanOrEqual(3);
    }
  });

  it('keeps every point inside the part image when the opaque pixels reach its edge', () => {
    const skeleton = PIVOTED as unknown as Skeleton;
    const image = { width: 10, height: 6, data: Buffer.alloc(10 * 6 * 4, 255) };
    const mesh = partMesh(skeleton, skeleton.parts[0] as Skeleton['parts'][number], image, [5, 5]);
    const xs = mesh.uv.map((p) => p[0]);
    const ys = mesh.uv.map((p) => p[1]);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([0, 10, 0, 6]);
    expect(mesh.polygons.length).toBeGreaterThan(0);
  });

  it('weights by 1 / (d + 1)² over bone segments, keeping the largest 3', () => {
    const skeleton = PIVOTED as unknown as Skeleton;
    const weights = pointWeights(skeleton, ['hips', 'neck', 'arm', 'tail'], [20, 11]);
    const raw = [1 / (0 + 1) ** 2, 1 / (0 + 1) ** 2, 1 / (Math.hypot(12, 8) + 1) ** 2, 1 / (19 + 1) ** 2];
    const kept = [raw[0], raw[1], raw[2], 0] as number[];
    const sum = kept.reduce((s, w) => s + w, 0);
    expect(weights).toEqual(kept.map((w) => w / sum));
    expect(pointWeights(skeleton, ['tail', 'neck'], [20, 30])).toEqual([1 / (1 + 1 / 400), 1 / 400 / (1 + 1 / 400)]);
  });

  it('needs every pivot and the weighted parts in the split', async () => {
    const rig = await makeRig(PIVOTED);
    await split(rig, join(rig.dir, 'split'));
    const splitJson = join(rig.dir, 'split', 'rig-split.json');
    writeFileSync(rig.skeleton, JSON.stringify({ ...PIVOTED, source: rig.source, bones: [{ name: 'hips', parent: null }, ...PIVOTED.bones.slice(1)] }));
    const run = await ogw(rig.ws, ['resource', 'rig-mesh', '--skeleton', rig.skeleton, '--split', splitJson, '--out', join(rig.dir, 'm')]);
    expect(run.stderr).toContain('bone hips has no pivot');
    expect(existsSync(join(rig.dir, 'm'))).toBe(false);
    writeFileSync(rig.skeleton, JSON.stringify({ ...PIVOTED, source: rig.source, bones: [{ name: 'hips', parent: null, pivot: [1] }, ...PIVOTED.bones.slice(1)] }));
    expect((await ogw(rig.ws, ['resource', 'rig-mesh', '--skeleton', rig.skeleton, '--split', splitJson, '--out', join(rig.dir, 'm')])).stderr).toContain('bones[0].pivot is not [x, y]');
    writeFileSync(rig.skeleton, JSON.stringify({ ...PIVOTED, source: rig.source, parts: [...PIVOTED.parts, { name: 'leg', bone: 'hips', image: 'image/hero/leg', filled: false, bones: ['hips'] }] }));
    expect((await ogw(rig.ws, ['resource', 'rig-mesh', '--skeleton', rig.skeleton, '--split', splitJson, '--out', join(rig.dir, 'm')])).stderr).toContain('no part leg');
    writeFileSync(rig.skeleton, JSON.stringify({ ...SKELETON, source: rig.source, bones: PIVOTED.bones }));
    expect((await ogw(rig.ws, ['resource', 'rig-mesh', '--skeleton', rig.skeleton, '--split', splitJson, '--out', join(rig.dir, 'm')])).stdout).toBe('no part has weight bones\n');
    expect((await ogw(rig.ws, ['resource', 'rig-mesh', '--skeleton', rig.skeleton])).stderr).toContain('usage: ogw resource rig-mesh');
  });
});
