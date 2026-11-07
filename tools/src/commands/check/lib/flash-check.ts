import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';
import { automationRequest } from '../../instance/automation.ts';
import { decodeRgba, encodePng, type Rgba } from '../../resource/lib/image.ts';
import type { CheckFailure } from '../api.ts';
import { SCENARIO_WHERE, type InstanceCheckOptions } from './bot-playtest.ts';
import { failure, writeEvidence } from './evidence.ts';
import { fieldGeometry, FlashDetector, flashRuns, FLASH, type FailedFrame, type FlashRun } from './flash.ts';
import { withInstance } from './instances.ts';
import { runScenario, type Scenario } from './scenario.ts';
import type { MeasuredScreen } from './ui-quality.ts';

/** `readingMs`: the interval of the `get_state` readings that give the scene of the frames; `feedMs`: how often the image folder is read. */
export const flashTiming = { readingMs: 250, feedMs: 20 };

export interface FlashOptions extends InstanceCheckOptions {
  /** The `uiCheckScreens` items of the orientation of `baseResolution` that have a `pixelRatio`. */
  screens: MeasuredScreen[];
  baseResolution: [number, number];
  /** Game settings `targetFps`: the movie fps. */
  targetFps: number;
  /** `readScenario` of the checkout. */
  scenario: Scenario | string;
}

/** The flash check part of a UI quality item: its failures, `unknown` when they are reasons it could not judge. */
export interface FlashPart {
  failures: CheckFailure[];
  unknown: boolean;
}

/** The fill scale of a screen item: window ÷ base resolution per axis, the larger for `Crop`, the smaller for `Letterbox`. */
function fillScale(screen: MeasuredScreen, base: readonly [number, number]): number {
  const sx = screen.window[0] / base[0];
  const sy = screen.window[1] / base[1];
  return screen.fillMode === 'Crop' ? Math.max(sx, sy) : Math.min(sx, sy);
}

/** The recorded screen (ogw.md `### flash check`): the item whose game area is the largest in CSS size, the first of equal ones. */
export function recordedScreen(screens: readonly MeasuredScreen[], base: readonly [number, number]): MeasuredScreen | null {
  let best: MeasuredScreen | null = null;
  for (const screen of screens) if (best === null || fillScale(screen, base) / screen.pixelRatio > fillScale(best, base) / best.pixelRatio) best = screen;
  return best;
}

/** The window of the recording: the CSS size of the screen, each side rounded and at least 1. */
export function cssSize(screen: MeasuredScreen): [number, number] {
  return [Math.max(1, Math.round(screen.window[0] / screen.pixelRatio)), Math.max(1, Math.round(screen.window[1] / screen.pixelRatio))];
}

/** The movie maker names its images `frame<8-digit number from 0>.png` (`## runner`). */
const IMAGE = /^frame(\d{8})\.png$/;

function imageName(n: number): string {
  return `frame${String(n).padStart(8, '0')}.png`;
}

/** The scene readings: `written` images had been written when a reading answered with `scene`. */
interface Reading {
  written: number;
  scene: string;
}

/** The scene of a frame: of the first reading that answered after its image was written, else of the last reading. */
export function sceneOf(readings: readonly Reading[], frame: number): string | null {
  return (readings.find((r) => r.written > frame) ?? readings.at(-1))?.scene ?? null;
}

/**
 * How many images ahead of the one the detector takes next are being decoded: the decodes run in the thread pool of
 * sharp (4 threads of libuv by default) while the detector, on the JS thread, takes the images in frame order.
 */
const DECODE_AHEAD = 4;

type Decoded = { image: Rgba } | { error: unknown };

/**
 * Reads the images of the movie maker folder in frame order into the detector while they are written, and removes each
 * image once its frame is final. An image is read once the next one exists (the engine wrote it whole), and the last one
 * when the recording ends. The images after the next are decoded beside the detector, at most `DECODE_AHEAD` at a time.
 */
class ImageFeed {
  private next = 0;
  private written = 0;
  /** The decodes started of images the detector has not taken, by frame number. */
  private readonly decoding = new Map<number, Promise<Decoded>>();
  private readonly failed: FailedFrame[] = [];
  private detector: FlashDetector | null = null;
  private readonly kept = new Map<string, string>();
  private readonly dir: string;
  private readonly options: FlashOptions;
  private readonly screen: MeasuredScreen;
  private readonly platform: string;

  constructor(dir: string, options: FlashOptions, screen: MeasuredScreen, platform: string) {
    this.dir = dir;
    this.options = options;
    this.screen = screen;
    this.platform = platform;
  }

  /** The number of images written by now. */
  async count(): Promise<number> {
    const names = await readdir(this.dir);
    for (const name of names) {
      const n = IMAGE.exec(name)?.[1];
      if (n !== undefined) this.written = Math.max(this.written, Number(n) + 1);
    }
    return this.written;
  }

  /** The decode of image `n`, started once; its failure is a value, so that one decoded ahead is not an unhandled rejection. */
  private decode(n: number): Promise<Decoded> {
    let pending = this.decoding.get(n);
    if (pending === undefined) {
      pending = decodeRgba(join(this.dir, imageName(n)), imageName(n)).then(
        (image): Decoded => ({ image }),
        (error: unknown): Decoded => ({ error }),
      );
      this.decoding.set(n, pending);
    }
    return pending;
  }

  /** Reads the images whose next image exists; with `last`, every image left, an unreadable last one left out. */
  async feed(last = false): Promise<void> {
    const written = await this.count();
    const end = last ? written : written - 1;
    while (this.next < end) {
      const n = this.next;
      for (let ahead = n; ahead < Math.min(end, n + DECODE_AHEAD); ahead++) void this.decode(ahead);
      const decoded = await this.decode(n);
      this.decoding.delete(n);
      if ('error' in decoded) {
        if (last && n === written - 1) break;
        throw decoded.error;
      }
      const image = decoded.image;
      this.detector ??= new FlashDetector(image.width, image.height, this.options.targetFps, fieldGeometry([image.width, image.height], this.screen.window, this.screen.pixelRatio));
      await this.take(this.detector.push(image.data));
      this.next++;
      // the frame `targetFps` before is final now: its image is no longer needed for evidence
      if (n >= this.options.targetFps) await rm(join(this.dir, imageName(n - this.options.targetFps)), { force: true });
    }
    if (last && this.detector !== null) await this.take(this.detector.finish());
  }

  /** The number of frames read. */
  get frames(): number {
    return this.next;
  }

  get size(): [number, number] | null {
    return this.detector === null ? null : [this.detector.width, this.detector.height];
  }

  get failures(): readonly FailedFrame[] {
    return this.failed;
  }

  /** The evidence of a frame that starts a run: its image and the mask of its flashing pixels of that kind. */
  evidence(run: FlashRun): string[] {
    return [this.kept.get(String(run.first)), this.kept.get(`${String(run.first)}-${run.kind}`)].filter((p): p is string => p !== undefined);
  }

  private async take(frames: FailedFrame[]): Promise<void> {
    for (const f of frames) {
      this.failed.push(f);
      if (f.mask === null || this.detector === null) continue;
      const prefix = `flash-${this.platform}/frame-${String(f.frame).padStart(8, '0')}`;
      if (!this.kept.has(String(f.frame))) {
        // the image of a frame is removed only `targetFps` frames after it, once it is final: it is still there
        const image = await readFile(join(this.dir, imageName(f.frame)));
        const path = await writeEvidence(this.options.evidence, `${prefix}.png`, image);
        if (path !== null) this.kept.set(String(f.frame), path);
      }
      const { width, height } = this.detector;
      // white at the flashing pixels, black elsewhere, opaque
      const data = Buffer.alloc(width * height * 4);
      for (let p = 0; p < width * height; p++) {
        const v = f.mask[p] === 1 ? 255 : 0;
        data[p * 4] = v;
        data[p * 4 + 1] = v;
        data[p * 4 + 2] = v;
        data[p * 4 + 3] = 255;
      }
      const path = await writeEvidence(this.options.evidence, `${prefix}-${f.kind}.png`, await encodePng({ width, height, data }));
      if (path !== null) this.kept.set(`${String(f.frame)}-${f.kind}`, path);
    }
  }
}

/** The failure of a run of frames that failed for one kind (ogw.md `### flash check`). */
function runFailure(run: FlashRun, readings: readonly Reading[], screen: MeasuredScreen, pixelArea: number, evidence: string[]): CheckFailure {
  // a reading with an empty `scene_key` (no scene yet) names no scene
  const scene = sceneOf(readings, run.first) || null;
  const area = Math.round(run.pixels * pixelArea);
  const [w, h] = FLASH.field;
  const message = `flash ${run.kind}: more than 3 flashes in one second over ${String(area)} CSS px² of a ${String(w)}x${String(h)} CSS px field, frames ${String(run.first)}-${String(run.last)} in ${scene ?? 'no scene'} (${screen.name})`;
  return failure(scene ?? SCENARIO_WHERE, message, evidence);
}

function unknownPart(where: string, message: string): FlashPart {
  return { failures: [failure(where, message)], unknown: true };
}

/**
 * A `get_state` reading of the recording, or null when the client does not answer it (`automationRequest` throws an
 * `OgwError`: no answer, a closed channel, a time limit). Another error is thrown.
 */
async function sceneReading(ctx: Context, id: string, feed: ImageFeed): Promise<Reading | null> {
  const response = await automationRequest(ctx, id, 'get_state', []).catch((error: unknown) => {
    if (error instanceof OgwError) return null;
    throw error;
  });
  const state = response?.ok === true && typeof response.result === 'object' && response.result !== null ? (response.result as Record<string, unknown>) : null;
  if (state === null) return null;
  return { written: await feed.count(), scene: typeof state.scene_key === 'string' ? state.scene_key : '' };
}

/**
 * The flash check of the UI quality check of one platform profile (ogw.md `### flash check`): the bot playtest scenario
 * on an instance whose client `main` records every frame with the movie maker, judged frame by frame while it is written.
 */
export async function flashCheck(ctx: Context, game: string, platform: string, options: FlashOptions): Promise<FlashPart> {
  const screen = recordedScreen(options.screens, options.baseResolution);
  if (screen === null) return unknownPart('settings.json:1', 'flash: no uiCheckScreens item of the orientation of baseResolution');
  if (typeof options.scenario === 'string') return unknownPart(SCENARIO_WHERE, `flash: ${options.scenario}`);
  const scenario = options.scenario;
  const dir = await newPrivateTempFolder('ogw-check-flash-', ctx.env);
  try {
    const feed = new ImageFeed(dir, options, screen, platform);
    const readings: Reading[] = [];
    const movie = { file: join(dir, 'frame.png'), resolution: cssSize(screen), fps: options.targetFps };
    const testScreen = { window: screen.window, fillMode: screen.fillMode, notch: screen.notch };
    const instanceOptions = { game, platform, client: 'window' as const, db: options.db, movie, testScreen };
    // `step`: the client clock does not follow the movie frame step, so no frame is judged; `stopped`: the scenario stopped
    const recorded = await withInstance(ctx, options.slots, instanceOptions, async (instance): Promise<{ step: FlashPart | null; stopped: FlashPart | null }> => {
      const first = await automationRequest(ctx, instance.id, 'get_state', []);
      const state = first.ok && typeof first.result === 'object' && first.result !== null ? (first.result as Record<string, unknown>) : {};
      const frameStep = state.frame_step_fps;
      if (frameStep !== options.targetFps) {
        const value = frameStep === undefined ? 'missing' : JSON.stringify(frameStep);
        const why = `flash: get_state frame_step_fps is ${value}, not targetFps ${String(options.targetFps)}: the client clock does not follow the movie maker frame step`;
        return { step: unknownPart(SCENARIO_WHERE, why), stopped: null };
      }
      readings.push({ written: await feed.count(), scene: typeof state.scene_key === 'string' ? state.scene_key : '' });
      const stop = { done: false };
      const feeding = (async () => {
        while (!stop.done) {
          await feed.feed();
          await sleep(flashTiming.feedMs);
        }
      })();
      const reading = (async () => {
        while (!stop.done) {
          await sleep(flashTiming.readingMs);
          // a reading after the instance stopped does not answer and is left out
          const r = await sceneReading(ctx, instance.id, feed);
          if (r !== null) readings.push(r);
        }
      })();
      try {
        const outcome = await runScenario(ctx, instance.id, scenario, { pollMs: options.pollMs });
        const last = await sceneReading(ctx, instance.id, feed);
        if (last !== null) readings.push(last);
        const stopped = outcome.stop === null ? null : unknownPart(`step ${String(outcome.stop.step)}`, `flash: scenario stopped: ${outcome.stop.message}`);
        return { step: null, stopped };
      } finally {
        stop.done = true;
        await Promise.all([feeding, reading]);
      }
    }, options.evidence);
    if (recorded.step !== null) return recorded.step;
    // the client has stopped: the images left are whole except perhaps the last
    await feed.feed(true);
    const size = feed.size;
    const runs = flashRuns(feed.failures);
    if (size !== null && runs.length > 0) {
      const area = fieldGeometry(size, screen.window, screen.pixelRatio).pixelArea;
      return { failures: runs.map((run) => runFailure(run, readings, screen, area, feed.evidence(run))), unknown: false };
    }
    if (recorded.stopped !== null) return recorded.stopped;
    if (feed.frames === 0) return unknownPart(SCENARIO_WHERE, 'flash: the movie maker wrote no image');
    return { failures: [], unknown: false };
  } catch (error) {
    return unknownPart(SCENARIO_WHERE, `flash did not run: ${(error as Error).message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
