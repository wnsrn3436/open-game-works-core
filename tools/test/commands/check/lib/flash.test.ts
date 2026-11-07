import { describe, expect, it } from 'vitest';
import { chromaticity, fieldGeometry, FlashDetector, flashRuns, relativeLuminance, type FailedFrame, type FlashKind } from '../../../../src/commands/check/lib/flash.ts';

type Rgb = [number, number, number];
/** A rectangle of a frame and its color: x, y, width, height. */
type Paint = [number, number, number, number, Rgb];

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];
const FPS = 60;

function frame(width: number, height: number, background: Rgb, paint: readonly Paint[] = []): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) data.set([...background, 255], p * 4);
  for (const [x0, y0, w, h, color] of paint) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) data.set([...color, 255], (y * width + x) * 4);
  }
  return data;
}

/**
 * The failed frames of a recording of `count` frames of `width` × `height` pixels, each pixel 1 CSS px (a window of the
 * same size at pixel ratio 1), at `FPS`; `at(n)` draws frame n.
 */
function judge(width: number, height: number, count: number, at: (n: number) => Buffer, fps = FPS): FailedFrame[] {
  const detector = new FlashDetector(width, height, fps, fieldGeometry([width, height], [width, height], 1));
  const failed: FailedFrame[] = [];
  for (let n = 0; n < count; n++) failed.push(...detector.push(at(n)));
  failed.push(...detector.finish());
  return failed;
}

function kinds(failed: readonly FailedFrame[]): FlashKind[] {
  return [...new Set(failed.map((f) => f.kind))];
}

/** A square wave of `hz` that toggles a color every 60 ÷ (2 hz) frames: `on` in the first half of each period. */
function square(hz: number): (n: number) => boolean {
  const half = FPS / (2 * hz);
  return (n) => Math.floor(n / half) % 2 === 0;
}

describe('flash judgement of generated frame sequences', () => {
  // 200 × 150 CSS px: a full-screen flash covers 30000 CSS px², more than 21824, a quarter of a 341 × 256 field
  const W = 200;
  const H = 150;

  it('fails a 4 Hz full-screen black and white flash and passes a 2 Hz one', () => {
    const at = (hz: number) => (n: number) => frame(W, H, square(hz)(n) ? WHITE : BLACK);
    const fast = judge(W, H, 120, at(4));
    expect(kinds(fast)).toEqual(['general']);
    const [run] = flashRuns(fast);
    // 7 transitions come by frame 45 (one each 7.5 frames from frame 7): frames 0 to 45 and on are flashing frames
    expect(run).toMatchObject({ kind: 'general', pixels: W * H });
    expect(run?.first).toBeLessThanOrEqual(8);
    expect(run?.last).toBeGreaterThanOrEqual(110);
    expect(run?.mask.every((v) => v === 1)).toBe(true);
    expect(judge(W, H, 120, at(2))).toEqual([]);
  });

  it('passes exactly 3 flashes a second and fails a little more', () => {
    // 3 Hz: the 7th transition comes 60 frames after the 1st, not within one second; 3.75 Hz: 48 frames after it
    expect(judge(W, H, 180, (n) => frame(W, H, square(3)(n) ? WHITE : BLACK))).toEqual([]);
    expect(kinds(judge(W, H, 180, (n) => frame(W, H, square(3.75)(n) ? WHITE : BLACK)))).toEqual(['general']);
  });

  it('fails a smooth 4 Hz flash whose frames change little one by one', () => {
    // a sine of relative luminance 0.05 to 0.6: each frame moves it by under 0.1, a half period by 0.55
    const gray = (l: number): number => {
      let best = 0;
      for (let c = 0; c < 256; c++) if (Math.abs(relativeLuminance(c, c, c) - l) < Math.abs(relativeLuminance(best, best, best) - l)) best = c;
      return best;
    };
    const at = (n: number) => {
      const c = gray(0.325 + 0.275 * Math.sin((2 * Math.PI * 4 * n) / FPS));
      return frame(W, H, [c, c, c]);
    };
    expect(kinds(judge(W, H, 120, at))).toEqual(['general']);
  });

  it('passes a slow fade, a flash of a change under 0.1 and a flash whose darker state is not under 0.8', () => {
    // black to white over a second and back
    const fade = (n: number) => {
      const t = n % 120;
      const c = Math.round((255 * (t < 60 ? t : 120 - t)) / 60);
      return frame(W, H, [c, c, c]);
    };
    expect(judge(W, H, 240, fade)).toEqual([]);
    // 8 Hz between two grays 0.08 apart in relative luminance
    const [low, high] = [100, 125];
    expect(relativeLuminance(high, high, high) - relativeLuminance(low, low, low)).toBeLessThan(0.1);
    expect(judge(W, H, 120, (n) => frame(W, H, square(8)(n) ? [high, high, high] : [low, low, low]))).toEqual([]);
    // 8 Hz between relative luminance 0.85 and 1: a change of 0.15 whose darker state is 0.8 or more
    const bright = 237;
    expect(relativeLuminance(bright, bright, bright)).toBeGreaterThanOrEqual(0.8);
    expect(1 - relativeLuminance(bright, bright, bright)).toBeGreaterThanOrEqual(0.1);
    expect(judge(W, H, 120, (n) => frame(W, H, square(8)(n) ? WHITE : [bright, bright, bright]))).toEqual([]);
  });

  it('counts a fall when the luminance is under 0.8, not when it is 0.1 below the peak and still 0.8 or more', () => {
    // relative luminance 0.5, 1 and 0.85 by gray value
    const level: Record<string, number> = { low: 188, high: 255, bright: 237 };
    expect(relativeLuminance(188, 188, 188)).toBeCloseTo(0.5, 2);
    expect(relativeLuminance(237, 237, 237)).toBeGreaterThanOrEqual(0.8);
    // transitions at frames 5 (rise), 15, 25, 35, 45, 55, 67 (rise) and 75, where the luminance comes under 0.8 after
    // 0.85 from frame 70 on: from 15 to 75 is 60 frames, not within a second; from 15 to 70 it would be
    const segments: [string, number][] = [['low', 5], ['high', 10], ['low', 10], ['high', 10], ['low', 10], ['high', 10], ['low', 12], ['high', 3], ['bright', 5], ['low', 20]];
    const values = segments.flatMap(([name, length]) => Array<number>(length).fill(level[name] as number));
    expect(judge(W, H, values.length, (n) => frame(W, H, [values[n], values[n], values[n]] as Rgb))).toEqual([]);
    // the same with the luminance coming under 0.8 at frame 70: 7 transitions in 55 frames
    const sooner = values.map((v, n) => (n >= 70 && n < 75 ? level.low : v) as number);
    expect(kinds(judge(W, H, sooner.length, (n) => frame(W, H, [sooner[n], sooner[n], sooner[n]] as Rgb)))).toEqual(['general']);
  });

  it('needs the darker state of the first transition under 0.8 too', () => {
    const gray = (values: number[]) => (n: number) => frame(W, H, [values[n], values[n], values[n]] as Rgb);
    const run = (from: number[], length: number): number[] => from.flatMap((v) => Array<number>(length).fill(v));
    // 0.85 then 1: no rise from 0.85; then falls and rises between 1 and 0.5 at frames 10 to 60: 6 transitions
    const fromBright = [237, ...Array<number>(9).fill(255), ...run([188, 255, 188, 255, 188], 10), ...Array<number>(10).fill(255)];
    expect(judge(W, H, fromBright.length, gray(fromBright))).toEqual([]);
    // 1 then 0.85: no fall to 0.85; then 1 and the flicker: 5 transitions from frame 10
    const fromWhite = [255, 237, 237, 237, 237, ...Array<number>(5).fill(255), ...run([188, 255, 188, 255, 188], 10)];
    expect(judge(W, H, fromWhite.length, gray(fromWhite))).toEqual([]);
  });

  it('passes a small flashing area under a quarter of the field and fails one over it', () => {
    // 400 × 300 CSS px: a field of 341 × 256 fits within it; 140 × 140 is 19600 CSS px², 150 × 150 is 22500
    const at = (side: number) => (n: number) => frame(400, 300, BLACK, square(4)(n) ? [[10, 10, side, side, WHITE]] : []);
    expect(judge(400, 300, 120, at(140))).toEqual([]);
    const failed = judge(400, 300, 120, at(150));
    expect(kinds(failed)).toEqual(['general']);
    expect(Math.max(...failed.map((f) => f.pixels))).toBe(150 * 150);
  });

  it('adds the flashing areas that one field holds, and not those no field holds together', () => {
    // two 120 × 120 squares, 14400 CSS px² each: within one 341 × 256 field they make 28800, more than 21824
    const two = (gap: number) => (n: number) => frame(700, 300, BLACK, square(4)(n) ? [[0, 0, 120, 120, WHITE], [120 + gap, 0, 120, 120, WHITE]] : []);
    expect(kinds(judge(700, 300, 120, two(50)))).toEqual(['general']);
    // 240 + 220 = 460 CSS px wide together: no 341 px wide field holds both
    expect(judge(700, 300, 120, two(220))).toEqual([]);
  });

  it('fails a 4 Hz flash between a saturated red and a gray of the same relative luminance as a red flash, and passes a desaturated one', () => {
    const red: Rgb = [180, 0, 0];
    const gray: Rgb = [88, 88, 88];
    expect(Math.abs(relativeLuminance(...red) - relativeLuminance(...gray))).toBeLessThan(0.01);
    const failed = judge(W, H, 120, (n) => frame(W, H, square(4)(n) ? red : gray));
    expect(kinds(failed)).toEqual(['red']);
    // redness under 0.8 at the same relative luminance as the gray: no red transition
    const pink: Rgb = [180, 90, 90];
    const pinkGray: Rgb = [118, 118, 118];
    expect(Math.abs(relativeLuminance(...pink) - relativeLuminance(...pinkGray))).toBeLessThan(0.01);
    expect(judge(W, H, 120, (n) => frame(W, H, square(4)(n) ? pink : pinkGray))).toEqual([]);
  });

  it('makes a red flash only of a change to or from a saturated red, redness 0.8 or more', () => {
    const redness = ([r, g, b]: Rgb): number => {
      const lin = (c: number): number => relativeLuminance(c, 0, 0) / 0.2126;
      return lin(r) / (lin(r) + lin(g) + lin(b));
    };
    const distance = (a: Rgb, b: Rgb): number => {
      const lin = (c: number): number => relativeLuminance(c, 0, 0) / 0.2126;
      const [ua, va] = chromaticity(lin(a[0]), lin(a[1]), lin(a[2]));
      const [ub, vb] = chromaticity(lin(b[0]), lin(b[1]), lin(b[2]));
      return Math.hypot(ua - ub, va - vb);
    };
    const blue: Rgb = [0, 0, 255];
    // a red of redness 0.83 and one of 0.77, each far from blue in chromaticity and under 0.1 from it in luminance
    const saturated: Rgb = [180, 60, 60];
    const unsaturated: Rgb = [180, 75, 75];
    expect(redness(saturated)).toBeGreaterThanOrEqual(0.8);
    expect(redness(saturated)).toBeLessThan(0.85);
    expect(redness(unsaturated)).toBeLessThan(0.8);
    for (const c of [saturated, unsaturated]) {
      expect(distance(c, blue)).toBeGreaterThan(0.2);
      expect(Math.abs(relativeLuminance(...c) - relativeLuminance(...blue))).toBeLessThan(0.1);
    }
    expect(kinds(judge(W, H, 120, (n) => frame(W, H, square(4)(n) ? saturated : blue)))).toEqual(['red']);
    expect(judge(W, H, 120, (n) => frame(W, H, square(4)(n) ? unsaturated : blue))).toEqual([]);
    // blue and a gray of the same luminance, far apart in chromaticity, with no saturated red
    const gray: Rgb = [76, 76, 76];
    expect(distance(blue, gray)).toBeGreaterThan(0.2);
    expect(judge(W, H, 120, (n) => frame(W, H, square(4)(n) ? blue : gray))).toEqual([]);
  });

  it('measures a change into the red side from the least red frame of the other side', () => {
    // 5 Hz: gray, then a pink that is not saturated and within 0.2 of the red, then the red; from the gray the red is
    // more than 0.2 away, from the pink it is not
    const cycle: Rgb[] = [[88, 88, 88], [88, 88, 88], [88, 88, 88], [180, 90, 90], [180, 90, 90], [180, 90, 90], ...Array<Rgb>(6).fill([180, 0, 0])];
    const failed = judge(W, H, 120, (n) => frame(W, H, cycle[n % 12] as Rgb));
    expect(kinds(failed)).toEqual(['red']);
  });

  it('counts a red flash from black, whose chromaticity is that of white', () => {
    // a dark saturated red, under 0.1 of relative luminance above black: a red flash only
    const dark: Rgb = [100, 0, 0];
    expect(relativeLuminance(...dark)).toBeLessThan(0.1);
    expect(chromaticity(0, 0, 0)).toEqual(chromaticity(1, 1, 1));
    expect(kinds(judge(W, H, 120, (n) => frame(W, H, square(4)(n) ? dark : BLACK)))).toEqual(['red']);
  });

  it('judges the frames of the last second when the recording ends', () => {
    // still for a second, then a 4 Hz flash for the last second only
    const failed = judge(W, H, 120, (n) => frame(W, H, n >= 60 && square(4)(n - 60) ? WHITE : BLACK));
    expect(kinds(failed)).toEqual(['general']);
    expect(Math.min(...failed.map((f) => f.frame))).toBeGreaterThanOrEqual(60);
  });

  it('makes one run per stretch of failing frames and kind, with the mask of its first frame', () => {
    // a 4 Hz flash in seconds 0 to 1.5 and 3 to 4.5
    const on = (n: number): boolean => (n < 90 || (n >= 180 && n < 270)) && square(4)(n);
    const runs = flashRuns(judge(W, H, 300, (n) => frame(W, H, on(n) ? WHITE : BLACK)));
    expect(runs.map((r) => r.kind)).toEqual(['general', 'general']);
    expect(runs[0]?.last).toBeLessThan(runs[1]?.first ?? 0);
    expect(runs.every((r) => r.mask.length === W * H)).toBe(true);
  });

  it('measures the field and the area in CSS pixels of the recorded screen', () => {
    // a 1080 × 1920 window at pixel ratio 3 recorded at its CSS size: one pixel is one CSS px
    expect(fieldGeometry([360, 640], [1080, 1920], 3)).toEqual({ width: 341, height: 256, maxPixels: 21824, pixelArea: 1 });
    // the engine kept the window at half that size: one pixel is 2 × 2 CSS px
    expect(fieldGeometry([180, 320], [1080, 1920], 3)).toEqual({ width: 171, height: 128, maxPixels: 5456, pixelArea: 4 });
    // a field larger than the image is the image
    expect(fieldGeometry([100, 50], [100, 50], 1)).toMatchObject({ width: 100, height: 50 });
  });
});
