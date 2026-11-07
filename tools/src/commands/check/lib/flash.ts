/**
 * The judgement of the flash check (ogw.md `### flash check`): general and red transitions per pixel, the flashing
 * frames of a pixel (7 transitions of a kind within one second), and the frames in which a 341 × 256 CSS px field holds
 * more flashing pixels than 25% of its area. Frames come in one at a time and a frame is final `fps` frames later, so
 * that a recording is judged while it is written.
 */

/** The fixed values of the check (ogw.md `### flash check`), not settings. */
export const FLASH = {
  /** The smallest change of relative luminance of a general transition. */
  luminanceStep: 0.1,
  /** The darker state of a general transition is under this relative luminance. */
  darkLimit: 0.8,
  /** The smallest redness of a saturated red. */
  saturatedRed: 0.8,
  /** A red transition moves the chromaticity more than this. */
  chromaticityStep: 0.2,
  /** Transitions of one kind within one second that make flashing frames: more than 3 flashes of 2 opposing transitions. */
  transitions: 7,
  /** The field, CSS px. */
  field: [341, 256] as const,
  /** The flashing area a field may hold, CSS px²: 25% of the field. */
  maxArea: 0.25 * 341 * 256,
} as const;

export type FlashKind = 'general' | 'red';

/** Linear value of an 8-bit sRGB channel value. */
const LINEAR = Float64Array.from({ length: 256 }, (_, c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});

/** CIE 1976 UCS chromaticity (u', v') of linear sRGB values; black has the chromaticity of white. */
export function chromaticity(r: number, g: number, b: number): [number, number] {
  const [lr, lg, lb] = r + g + b === 0 ? [1, 1, 1] : [r, g, b];
  const x = 0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = 0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb;
  const d = x + 15 * y + 3 * z;
  return [(4 * x) / d, (9 * y) / d];
}

/** Relative luminance of an 8-bit sRGB color. */
export function relativeLuminance(r8: number, g8: number, b8: number): number {
  return 0.2126 * (LINEAR[r8] as number) + 0.7152 * (LINEAR[g8] as number) + 0.0722 * (LINEAR[b8] as number);
}

/** The size of a field in frame pixels and the most flashing pixels it may hold (ogw.md `### flash check`). */
export interface FieldGeometry {
  width: number;
  height: number;
  /** A frame fails for a kind when a field holds more flashing pixels of that kind than this. */
  maxPixels: number;
  /** CSS px² of one frame pixel. */
  pixelArea: number;
}

/**
 * The field of frames `image` pixels large that record a screen of `window` window pixels at `pixelRatio`: one frame
 * pixel is w × h CSS px, a field round(341 ÷ w) × round(256 ÷ h) pixels within the image.
 */
export function fieldGeometry(image: readonly [number, number], window: readonly [number, number], pixelRatio: number): FieldGeometry {
  const w = window[0] / (image[0] * pixelRatio);
  const h = window[1] / (image[1] * pixelRatio);
  const side = (css: number, scale: number, size: number): number => Math.min(size, Math.max(1, Math.round(css / scale)));
  return { width: side(FLASH.field[0], w, image[0]), height: side(FLASH.field[1], h, image[1]), maxPixels: FLASH.maxArea / (w * h), pixelArea: w * h };
}

/** A frame that failed for a kind: the largest flashing pixel count of a field, and, for the first frame of a run, the mask of its flashing pixels. */
export interface FailedFrame {
  frame: number;
  kind: FlashKind;
  pixels: number;
  /** 0 or 1 per pixel, rows top to bottom; only on the first frame of a run of failed frames of that kind. */
  mask: Uint8Array | null;
}

/** The last 7 transitions of one kind per pixel and the flashing frames they make, for the last `fps` frames. */
class KindTrack {
  private readonly times: Int32Array;
  private readonly head: Uint8Array;
  private readonly seen: Uint8Array;
  private readonly markedTo: Int32Array;
  /** One bit per pixel per frame of the last `fps` frames: frame f is in slot f mod fps. */
  private readonly masks: Uint32Array[];
  private readonly counts: Int32Array;
  private previousFailed = false;
  readonly kind: FlashKind;
  private readonly pixels: number;
  private readonly fps: number;

  constructor(kind: FlashKind, pixels: number, fps: number) {
    this.kind = kind;
    this.pixels = pixels;
    this.fps = fps;
    this.times = new Int32Array(pixels * FLASH.transitions);
    this.head = new Uint8Array(pixels);
    this.seen = new Uint8Array(pixels);
    this.markedTo = new Int32Array(pixels).fill(-1);
    const words = Math.ceil(pixels / 32);
    this.masks = Array.from({ length: fps }, () => new Uint32Array(words));
    this.counts = new Int32Array(fps);
  }

  /** A transition of pixel `p` at frame `n`: when it is the 7th within `fps` frames, its frames become flashing frames. */
  transition(p: number, n: number): void {
    const base = p * FLASH.transitions;
    const at = this.head[p] as number;
    this.times[base + at] = n;
    const next = (at + 1) % FLASH.transitions;
    this.head[p] = next;
    if ((this.seen[p] as number) < FLASH.transitions) this.seen[p] = (this.seen[p] as number) + 1;
    if (this.seen[p] !== FLASH.transitions) return;
    // the slot after the newest holds the oldest of the last 7: the 6th transition before this one
    const oldest = this.times[base + next] as number;
    if (n - oldest >= this.fps) return;
    const word = p >>> 5;
    const bit = 1 << (p & 31);
    for (let f = Math.max(oldest, (this.markedTo[p] as number) + 1); f <= n; f++) {
      const slot = f % this.fps;
      const mask = this.masks[slot] as Uint32Array;
      if (((mask[word] as number) & bit) === 0) {
        mask[word] = (mask[word] as number) | bit;
        this.counts[slot] = (this.counts[slot] as number) + 1;
      }
    }
    this.markedTo[p] = n;
  }

  /** Judges frame `m`, whose flashing frames are all known, and empties its slot for frame m + fps. */
  evaluate(m: number, width: number, height: number, field: FieldGeometry, integral: Int32Array): FailedFrame | null {
    const slot = m % this.fps;
    const mask = this.masks[slot] as Uint32Array;
    const count = this.counts[slot] as number;
    let failed: FailedFrame | null = null;
    // a field holds at most every flashing pixel of the frame
    if (count > field.maxPixels) {
      const largest = largestField(mask, width, height, field, integral);
      if (largest > field.maxPixels) failed = { frame: m, kind: this.kind, pixels: largest, mask: this.previousFailed ? null : unpack(mask, this.pixels) };
    }
    this.previousFailed = failed !== null;
    if (count > 0) mask.fill(0);
    this.counts[slot] = 0;
    return failed;
  }
}

function unpack(mask: Uint32Array, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels);
  for (let p = 0; p < pixels; p++) out[p] = ((mask[p >>> 5] as number) >>> (p & 31)) & 1;
  return out;
}

/** The most set bits of `mask` that one field holds, with a summed-area table in `integral` ((width + 1) × (height + 1)). */
function largestField(mask: Uint32Array, width: number, height: number, field: FieldGeometry, integral: Int32Array): number {
  const stride = width + 1;
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      row += ((mask[p >>> 5] as number) >>> (p & 31)) & 1;
      integral[(y + 1) * stride + x + 1] = (integral[y * stride + x + 1] as number) + row;
    }
  }
  let best = 0;
  for (let y = 0; y + field.height <= height; y++) {
    for (let x = 0; x + field.width <= width; x++) {
      const sum =
        (integral[(y + field.height) * stride + x + field.width] as number) -
        (integral[y * stride + x + field.width] as number) -
        (integral[(y + field.height) * stride + x] as number) +
        (integral[y * stride + x] as number);
      if (sum > best) best = sum;
    }
  }
  return best;
}

/** Side of a pixel for red transitions. */
const RED = 1;
const OTHER = 2;
/** Direction of the last general transition of a pixel. */
const NONE = 0;
const RISE = 1;
const FALL = -1;

/**
 * Judges frames of `width` × `height` pixels, recorded at `fps` frames per second, one at a time (ogw.md
 * `### flash check`). `push` returns the frames that became final and failed, `finish` those of the frames left.
 */
export class FlashDetector {
  private frames = 0;
  private previous: Buffer | null = null;
  // general transitions: the direction of the last one, the highest (after a rise) or lowest (after a fall) since it, and
  // before the first the lowest and the highest since the first frame
  private readonly mode: Int8Array;
  private readonly extreme: Float64Array;
  private readonly lowest: Float64Array;
  private readonly highest: Float64Array;
  // red transitions: the side and the redness and chromaticity of the reference
  private readonly side: Uint8Array;
  private readonly refRedness: Float64Array;
  private readonly refU: Float64Array;
  private readonly refV: Float64Array;
  private readonly general: KindTrack;
  private readonly red: KindTrack;
  private readonly integral: Int32Array;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly field: FieldGeometry;

  constructor(width: number, height: number, fps: number, field: FieldGeometry) {
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.field = field;
    const pixels = width * height;
    this.mode = new Int8Array(pixels);
    this.extreme = new Float64Array(pixels);
    this.lowest = new Float64Array(pixels);
    this.highest = new Float64Array(pixels);
    this.side = new Uint8Array(pixels);
    this.refRedness = new Float64Array(pixels);
    this.refU = new Float64Array(pixels);
    this.refV = new Float64Array(pixels);
    this.general = new KindTrack('general', pixels, fps);
    this.red = new KindTrack('red', pixels, fps);
    this.integral = new Int32Array((width + 1) * (height + 1));
  }

  /** The number of frames pushed. */
  get count(): number {
    return this.frames;
  }

  /** Judges the next frame: 8-bit RGBA pixels, rows top to bottom, which the caller does not change after. */
  push(rgba: Buffer): FailedFrame[] {
    if (rgba.length !== this.width * this.height * 4) throw new Error(`a frame of ${String(rgba.length)} bytes, not ${String(this.width)}x${String(this.height)} RGBA`);
    const n = this.frames;
    // frame n takes the slot of frame n - fps, whose flashing frames are all known now
    const failed = n >= this.fps ? this.evaluate(n - this.fps) : [];
    const rowBytes = this.width * 4;
    const previous = this.previous;
    for (let y = 0; y < this.height; y++) {
      const start = y * rowBytes;
      // a pixel whose value repeats keeps its state (each step below is idempotent), so a repeated row or pixel is skipped
      if (previous !== null && rgba.compare(previous, start, start + rowBytes, start, start + rowBytes) === 0) continue;
      for (let x = 0; x < this.width; x++) {
        const i = start + x * 4;
        const r8 = rgba[i] as number;
        const g8 = rgba[i + 1] as number;
        const b8 = rgba[i + 2] as number;
        if (previous !== null && previous[i] === r8 && previous[i + 1] === g8 && previous[i + 2] === b8) continue;
        const p = y * this.width + x;
        const r = LINEAR[r8] as number;
        const g = LINEAR[g8] as number;
        const b = LINEAR[b8] as number;
        if (n === 0) this.start(p, r, g, b);
        else {
          this.generalStep(p, n, 0.2126 * r + 0.7152 * g + 0.0722 * b);
          this.redStep(p, n, r, g, b);
        }
      }
    }
    this.previous = rgba;
    this.frames++;
    return failed;
  }

  /** The state of a pixel at the first frame. */
  private start(p: number, r: number, g: number, b: number): void {
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    this.lowest[p] = l;
    this.highest[p] = l;
    const sum = r + g + b;
    const redness = sum === 0 ? 0 : r / sum;
    this.reference(p, redness >= FLASH.saturatedRed ? RED : OTHER, redness, r, g, b);
  }

  /** Judges the frames that are not final yet: no frame comes after them. */
  finish(): FailedFrame[] {
    const failed: FailedFrame[] = [];
    for (let m = Math.max(0, this.frames - this.fps); m < this.frames; m++) failed.push(...this.evaluate(m));
    return failed;
  }

  private evaluate(m: number): FailedFrame[] {
    return [this.general, this.red].flatMap((track) => track.evaluate(m, this.width, this.height, this.field, this.integral) ?? []);
  }

  private generalStep(p: number, n: number, l: number): void {
    const mode = this.mode[p] as number;
    if (mode === NONE) {
      if (l < (this.lowest[p] as number)) this.lowest[p] = l;
      if (l > (this.highest[p] as number)) this.highest[p] = l;
      const low = this.lowest[p] as number;
      if (l - low >= FLASH.luminanceStep && low < FLASH.darkLimit) this.generalTransition(p, n, RISE, l);
      else if ((this.highest[p] as number) - l >= FLASH.luminanceStep && l < FLASH.darkLimit) this.generalTransition(p, n, FALL, l);
    } else if (mode === RISE) {
      if (l > (this.extreme[p] as number)) this.extreme[p] = l;
      else if ((this.extreme[p] as number) - l >= FLASH.luminanceStep && l < FLASH.darkLimit) this.generalTransition(p, n, FALL, l);
    } else if (l < (this.extreme[p] as number)) {
      this.extreme[p] = l;
    } else if (l - (this.extreme[p] as number) >= FLASH.luminanceStep) {
      // a falling transition ends under 0.8, so the lowest since it is under 0.8
      this.generalTransition(p, n, RISE, l);
    }
  }

  private generalTransition(p: number, n: number, mode: number, l: number): void {
    this.mode[p] = mode;
    this.extreme[p] = l;
    this.general.transition(p, n);
  }

  private redStep(p: number, n: number, r: number, g: number, b: number): void {
    const sum = r + g + b;
    const redness = sum === 0 ? 0 : r / sum;
    const side = redness >= FLASH.saturatedRed ? RED : OTHER;
    const current = this.side[p] as number;
    if (current === side) {
      if (side === RED ? redness > (this.refRedness[p] as number) : redness < (this.refRedness[p] as number)) this.reference(p, side, redness, r, g, b);
      return;
    }
    const [u, v] = chromaticity(r, g, b);
    if (Math.hypot(u - (this.refU[p] as number), v - (this.refV[p] as number)) <= FLASH.chromaticityStep) return;
    this.side[p] = side;
    this.refRedness[p] = redness;
    this.refU[p] = u;
    this.refV[p] = v;
    this.red.transition(p, n);
  }

  private reference(p: number, side: number, redness: number, r: number, g: number, b: number): void {
    const [u, v] = chromaticity(r, g, b);
    this.side[p] = side;
    this.refRedness[p] = redness;
    this.refU[p] = u;
    this.refV[p] = v;
  }
}

/** A run of consecutive frames that failed for one kind. */
export interface FlashRun {
  kind: FlashKind;
  first: number;
  last: number;
  /** The largest flashing pixel count of a field in the run. */
  pixels: number;
  /** The mask of the first frame of the run. */
  mask: Uint8Array;
}

/** Joins failed frames into runs of consecutive frames per kind, in the order their first frames come. */
export function flashRuns(frames: readonly FailedFrame[]): FlashRun[] {
  const runs: FlashRun[] = [];
  const open = new Map<FlashKind, FlashRun>();
  for (const f of [...frames].sort((a, b) => a.frame - b.frame)) {
    const run = open.get(f.kind);
    if (run !== undefined && run.last === f.frame - 1) {
      run.last = f.frame;
      run.pixels = Math.max(run.pixels, f.pixels);
      continue;
    }
    const next: FlashRun = { kind: f.kind, first: f.frame, last: f.frame, pixels: f.pixels, mask: f.mask ?? new Uint8Array(0) };
    open.set(f.kind, next);
    runs.push(next);
  }
  return runs;
}
