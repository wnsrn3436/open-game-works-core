import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessSettings } from '../../../lib/settings.ts';
import { blank, encodePng, type Rgba } from '../../resource/lib/image.ts';
import { rigMesh, rigSplit } from '../../resource/lib/rig.ts';
import type { Skeleton } from '../../resource/lib/skeleton.ts';

/** Size of the fixed rig fixture canvas. */
export const FIXTURE_SIZE = 64;

type Rect = [number, number, number, number];

/** The two parts of the fixture: a body and an arm drawn over it, each a filled rectangle `[x0, y0, x1, y1)`. */
const PARTS: { name: string; rect: Rect; color: [number, number, number] }[] = [
  { name: 'body', rect: [16, 8, 48, 56], color: [200, 60, 60] },
  { name: 'arm', rect: [40, 20, 60, 28], color: [60, 60, 200] },
];

function fill(image: Rgba, rect: Rect, color: [number, number, number]): void {
  for (let y = rect[1]; y < rect[3]; y++) {
    for (let x = rect[0]; x < rect[2]; x++) image.data.set([...color, 255], (y * image.width + x) * 4);
  }
}

function fixtureSkeleton(source: string): Skeleton {
  return {
    source,
    parts: [
      { name: 'body', bone: 'body', image: 'image/fixture/body', filled: false },
      { name: 'arm', bone: 'arm', image: 'image/fixture/arm', filled: false, bones: ['body', 'arm'] },
    ],
    bones: [
      { name: 'body', parent: null },
      { name: 'arm', parent: 'body' },
    ],
    animations: [{ name: 'idle', loop: true, duration_ms: 1000 }],
  };
}

/**
 * Runs `rig-split`, `rig-check` (inside `rig-split`) and `rig-mesh` on the fixed fixture in `work`.
 * Returns null when the fixture passes, else the reason it does not.
 */
export async function rigFixtureProblem(work: string, settings: HarnessSettings): Promise<string | null> {
  await rm(work, { recursive: true, force: true });
  const layers = join(work, 'layers');
  await mkdir(layers, { recursive: true });
  const source = blank(FIXTURE_SIZE, FIXTURE_SIZE);
  for (const part of PARTS) {
    fill(source, part.rect, part.color);
    const layer = blank(FIXTURE_SIZE, FIXTURE_SIZE);
    fill(layer, part.rect, part.color);
    await writeFile(join(layers, `${part.name}.png`), await encodePng(layer));
  }
  const sourceFile = join(work, 'source.png');
  await writeFile(sourceFile, await encodePng(source));
  const skeleton = fixtureSkeleton(sourceFile);
  const skeletonFile = join(work, 'skeleton.json');
  await writeFile(skeletonFile, JSON.stringify(skeleton));
  try {
    const split = await rigSplit({ source: sourceFile, skeleton: skeletonFile, layers, size: [FIXTURE_SIZE, FIXTURE_SIZE], out: join(work, 'split') }, settings.rigCheck);
    if (split.recompose.status !== 'pass') return `rig-split recompose is ${split.recompose.status} (alphaIou ${String(split.recompose.alphaIou)})`;
    const withPivots: Skeleton = { ...skeleton, bones: skeleton.bones.map((b) => ({ ...b, pivot: split.pivots[b.name] ?? [0, 0] })) };
    await writeFile(skeletonFile, JSON.stringify(withPivots));
    const meshes = await rigMesh({ skeleton: skeletonFile, split: join(work, 'split', 'rig-split.json'), out: join(work, 'mesh') });
    return meshes.length === 1 ? null : `rig-mesh wrote ${String(meshes.length)} meshes, not 1`;
  } catch (error) {
    return (error as Error).message;
  }
}
