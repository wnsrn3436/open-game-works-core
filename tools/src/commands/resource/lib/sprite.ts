import { OgwError } from '../../../lib/errors.ts';
import { readJson } from '../../../lib/fsx.ts';
import type { SheetFrame } from './godot.ts';
import { blank, crop, paste, resizeRgba, type Rgba } from './image.ts';
import type { SpecAnimation } from './spec.ts';

/** `frame_layout` of a sprite-gen `manifest.json`: frame rectangles per state, in order. */
export type FrameLayout = Map<string, SheetFrame[]>;

function isFrame(value: unknown): value is SheetFrame {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return [v.x, v.y].every((n) => Number.isInteger(n) && (n as number) >= 0) && [v.w, v.h].every((n) => Number.isInteger(n) && (n as number) >= 1);
}

/** Reads `frame_layout.rows` of a sprite-gen `manifest.json`. */
export async function readFrameLayout(path: string): Promise<FrameLayout> {
  const manifest = await readJson<Record<string, unknown>>(path);
  const layout = manifest.frame_layout as Record<string, unknown> | undefined;
  const rows = layout?.rows;
  if (typeof rows !== 'object' || rows === null || Array.isArray(rows)) throw new OgwError(`${path}: no frame_layout.rows object`);
  const result: FrameLayout = new Map();
  for (const [state, frames] of Object.entries(rows as Record<string, unknown>)) {
    if (!Array.isArray(frames) || !frames.every(isFrame)) throw new OgwError(`${path}: frame_layout.rows.${state} is not a list of {x, y, w, h}`);
    result.set(state, frames);
  }
  return result;
}

/** Problems of a frame layout against the `animations` of the spec. */
export function layoutProblems(layout: FrameLayout, animations: readonly SpecAnimation[]): string[] {
  const states = [...layout.keys()].sort();
  const names = animations.map((a) => a.name).sort();
  const problems: string[] = [];
  if (states.join(',') !== names.join(',')) problems.push(`manifest states ${states.join(',')} are not the spec animations ${names.join(',')}`);
  for (const [state, frames] of layout) if (frames.length === 0) problems.push(`manifest state ${state} has no frame`);
  return problems;
}

export interface Sheet {
  image: Rgba;
  animations: { anim: SpecAnimation; frames: SheetFrame[] }[];
}

/** Lays the frames out as a sheet: one row per animation in spec order, cells of the spec size, one scale for all frames. */
export async function buildSheet(source: Rgba, layout: FrameLayout, animations: readonly SpecAnimation[], size: [number, number]): Promise<Sheet> {
  const [cw, ch] = size;
  const all = animations.flatMap((a) => layout.get(a.name) ?? []);
  for (const f of all) {
    if (f.x + f.w > source.width || f.y + f.h > source.height) {
      throw new OgwError(`manifest frame ${JSON.stringify(f)} is outside the sheet ${String(source.width)}x${String(source.height)}`);
    }
  }
  const scale = Math.min(cw / Math.max(...all.map((f) => f.w)), ch / Math.max(...all.map((f) => f.h)));
  const columns = Math.max(...animations.map((a) => (layout.get(a.name) ?? []).length));
  const image = blank(cw * columns, ch * animations.length);
  const result: Sheet['animations'] = [];
  for (const [row, anim] of animations.entries()) {
    const frames: SheetFrame[] = [];
    for (const [col, f] of (layout.get(anim.name) ?? []).entries()) {
      const w = Math.min(cw, Math.max(1, Math.round(f.w * scale)));
      const h = Math.min(ch, Math.max(1, Math.round(f.h * scale)));
      const scaled = await resizeRgba(crop(source, f.x, f.y, f.w, f.h), w, h);
      paste(image, scaled, col * cw + Math.floor((cw - w) / 2), row * ch + Math.floor((ch - h) / 2));
      frames.push({ x: col * cw, y: row * ch, w: cw, h: ch });
    }
    result.push({ anim, frames });
  }
  return { image, animations: result };
}
