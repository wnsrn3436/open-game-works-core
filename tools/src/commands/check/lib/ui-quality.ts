import { setTimeout as sleep } from 'node:timers/promises';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { decodeRgba, type Rgba } from '../../resource/lib/image.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { automationRequest, restartClient, type AutomationResponse } from '../../instance/automation.ts';
import type { CheckFailure, CheckResult } from '../api.ts';
import type { InstanceCheckOptions } from './bot-playtest.ts';
import { checkResult, failure, writeEvidence, type Evidence } from './evidence.ts';
import { flashCheck, type FlashPart } from './flash-check.ts';
import { onInstance, withInstance } from './instances.ts';
import { shareUnits, UnitQueue } from './units.ts';
import type { Scenario } from './scenario.ts';

/** Game settings `uiCheckScreens` item. */
export interface UiCheckScreen {
  name: string;
  window: [number, number];
  fillMode: string;
  notch: [number, number, number, number];
  keyboard?: number;
  /** Window pixels per CSS pixel of the device the item models; a required value that a game may not have filled yet. */
  pixelRatio?: number;
}

/** A `uiCheckScreens` item with its `pixelRatio`: every size of its captures is judged in CSS pixels. */
export interface MeasuredScreen extends UiCheckScreen {
  pixelRatio: number;
}

export interface UiQualityOptions extends InstanceCheckOptions {
  languages: string[];
  screens: UiCheckScreen[];
  baseResolution: [number, number];
  gamepadSupported: boolean;
  /** Max of `AccessibilityCore.textScales`, or null when `AccessibilityCore` is not in the module list. */
  maxTextScale: number | null;
  /** Game settings `uiQuality`. */
  quality: UiQualityLimits;
  /** Game settings `targetFps`: the movie fps of the flash check. */
  targetFps: number;
  /** `readScenario` of the checkout: the flash check records it. */
  scenario: Scenario | string;
}

/** Game settings `uiQuality`: the numbers of the presentation conditions (ogw.md `## UI quality`). */
export interface UiQualityLimits {
  /** The longest real time waited after an open command for the opening presentation to end. */
  settleLimitMs: number;
  maxFontSizes: number;
  /** The smallest `font_size` of text, in CSS pixels. */
  minFontSize: number;
  /** The smallest contrast ratio of text that is not large text. */
  minContrast: number;
  /** The smallest contrast ratio of large text. */
  minLargeContrast: number;
  maxEmptyShare: number;
  /** The smallest width and height of a target button on a touch platform, in CSS pixels. */
  minTouchTarget: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A `list_ui` element. */
export interface UiElement {
  path: string;
  rect: Rect;
  text: string;
  fontSize: number;
  clipped: boolean;
  owner: string;
  button: boolean;
  padAction: boolean;
  modalCovered: boolean;
  dimmed: boolean;
  textInput: boolean;
  focused: boolean;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/** `list_ui` `rect`: window pixel `[x, y, w, h]`. */
function toRect(value: unknown): Rect {
  const r: unknown[] = Array.isArray(value) ? value : [];
  return { x: num(r[0]), y: num(r[1]), w: num(r[2]), h: num(r[3]) };
}

export function toElements(result: unknown): UiElement[] {
  if (!Array.isArray(result)) return [];
  return (result as Record<string, unknown>[]).map((e) => ({
    path: String(e.path),
    rect: toRect(e.rect),
    text: typeof e.text === 'string' ? e.text : '',
    fontSize: num(e.font_size),
    clipped: e.clipped === true,
    owner: String(e.owner),
    button: e.button === true,
    padAction: e.pad_action === true,
    modalCovered: e.modal_covered === true,
    dimmed: e.dimmed === true,
    textInput: e.text_input === true,
    focused: e.focused === true,
  }));
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return Math.max(0, w) * Math.max(0, h);
}

function isAncestor(a: string, b: string): boolean {
  return b.startsWith(`${a}/`);
}

/** Clipped elements and overlaps (ogw.md `## UI quality`) of one capture, with the `owner` of the problem. */
export function layoutProblems(elements: readonly UiElement[]): { owner: string; message: string }[] {
  const problems = elements.filter((e) => e.clipped).map((e) => ({ owner: e.owner, message: `clipped ${e.path}` }));
  const texts = elements.filter((e) => e.text !== '');
  for (const [i, a] of texts.entries()) {
    for (const b of texts.slice(i + 1)) {
      if (a.owner !== b.owner || isAncestor(a.path, b.path) || isAncestor(b.path, a.path)) continue;
      if (overlapArea(a.rect, b.rect) >= 1) problems.push({ owner: a.owner, message: `overlap ${a.path} ${b.path}` });
    }
  }
  return problems;
}

/** Relative luminance (sRGB) of an 8-bit color. */
function luminance(r: number, g: number, b: number): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The shortest side of a panel body, in CSS pixels: a thinner element is a bar, not a panel. */
const PANEL_MIN_SIDE = 64;

/** The smallest `font_size` of large text, in CSS pixels (ogw.md `## UI quality`). */
const LARGE_TEXT_CSS_PX = 24;

/** The platforms whose UI quality check judges touch targets (ogw.md `## UI quality`). */
const TOUCH_PLATFORMS: readonly string[] = ['android', 'ios'];

/** Target buttons (ogw.md `## UI quality`): the elements with a `UIButton` that no modal panel or popup covers. */
export function targetButtons(elements: readonly UiElement[]): UiElement[] {
  return elements.filter((e) => e.button && !e.modalCovered);
}

/** Touch target problems of one capture: target buttons narrower or lower than `minTouchTarget` CSS pixels. */
export function touchTargetProblems(elements: readonly UiElement[], pixelRatio: number, minTouchTarget: number): { owner: string; message: string }[] {
  return targetButtons(elements)
    .map((e) => ({ e, w: e.rect.w / pixelRatio, h: e.rect.h / pixelRatio }))
    .filter(({ w, h }) => w < minTouchTarget || h < minTouchTarget)
    .map(({ e, w, h }) => ({ owner: e.owner, message: `small touch target ${e.path}: ${w.toFixed(1)}x${h.toFixed(1)} CSS px, under ${String(minTouchTarget)}` }));
}

/** Integer pixel bounds of a rect clipped to the image: [x0, y0, x1, y1), or null when nothing is left. */
function bounds(rect: Rect, image: Rgba): [number, number, number, number] | null {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(image.width, Math.round(rect.x + rect.w));
  const y1 = Math.min(image.height, Math.round(rect.y + rect.h));
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

function inside(rect: Rect, width: number, height: number): boolean {
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= width && rect.y + rect.h <= height;
}

/**
 * Contrast ratio between the background of a text rect (the median relative luminance of its pixels) and its text
 * (the luminance whose distance from the median is at the 99.9th percentile of the distances of its pixels).
 */
export function rectContrast(image: Rgba, rect: Rect): number | null {
  const b = bounds(rect, image);
  if (b === null) return null;
  const values: number[] = [];
  for (let y = b[1]; y < b[3]; y++) {
    for (let x = b[0]; x < b[2]; x++) {
      const i = (y * image.width + x) * 4;
      values.push(luminance(image.data[i] as number, image.data[i + 1] as number, image.data[i + 2] as number));
    }
  }
  values.sort((p, q) => p - q);
  const background = values[Math.floor(values.length / 2)] as number;
  const byDistance = [...values].sort((p, q) => Math.abs(p - background) - Math.abs(q - background));
  const text = byDistance[Math.min(byDistance.length - 1, Math.floor(0.999 * byDistance.length))] as number;
  return (Math.max(background, text) + 0.05) / (Math.min(background, text) + 0.05);
}

/**
 * Panel bodies: elements of a popup, panel or system popup that hold no text, take no input, are not window-sized, are
 * not thinner than `PANEL_MIN_SIDE` CSS pixels (a bar), and have a descendant element, with no such ancestor.
 */
export function panelBodies(elements: readonly UiElement[], sceneKey: string, window: { width: number; height: number }, pixelRatio: number): UiElement[] {
  const windowArea = window.width * window.height;
  const minSide = PANEL_MIN_SIDE * pixelRatio;
  const candidates = elements.filter(
    (e) =>
      e.owner !== sceneKey &&
      e.text === '' &&
      !e.button &&
      !e.textInput &&
      e.rect.w > 0 &&
      e.rect.h > 0 &&
      e.rect.w * e.rect.h <= 0.9 * windowArea &&
      Math.min(e.rect.w, e.rect.h) >= minSide &&
      elements.some((d) => isAncestor(e.path, d.path)),
  );
  return candidates.filter((e) => !candidates.some((o) => o !== e && o.owner === e.owner && isAncestor(o.path, e.path)));
}

/** A mask of the pixels of `area` covered by any of `rects`. */
function covered(area: [number, number, number, number], rects: readonly Rect[]): Uint8Array {
  const [x0, y0, x1, y1] = area;
  const w = x1 - x0;
  const mask = new Uint8Array(w * (y1 - y0));
  for (const r of rects) {
    const rx0 = Math.max(x0, Math.round(r.x));
    const ry0 = Math.max(y0, Math.round(r.y));
    const rx1 = Math.min(x1, Math.round(r.x + r.w));
    const ry1 = Math.min(y1, Math.round(r.y + r.h));
    // a rect outside the area covers none of it; a fill end before the row start would count from the mask's end
    if (rx1 <= rx0 || ry1 <= ry0) continue;
    for (let y = ry0; y < ry1; y++) mask.fill(1, (y - y0) * w + (rx0 - x0), (y - y0) * w + (rx1 - x0));
  }
  return mask;
}

/**
 * The presentation conditions of one capture (ogw.md `## UI quality`): text sizes, small text, the contrast of text
 * that is not dimmed and empty panels, each with the `owner` of the problem. `pixelRatio` is that of the
 * `uiCheckScreens` item of the capture: text sizes and panel sides are judged in CSS pixels.
 */
export function presentationProblems(
  elements: readonly UiElement[],
  image: Rgba,
  sceneKey: string,
  limits: UiQualityLimits,
  pixelRatio: number,
): { owner: string; message: string }[] {
  const problems: { owner: string; message: string }[] = [];
  const texts = elements.filter((e) => e.text !== '');
  const sizes = [...new Set(texts.map((e) => Math.round(e.fontSize)))].sort((a, b) => a - b);
  if (sizes.length > limits.maxFontSizes) problems.push({ owner: sceneKey, message: `${String(sizes.length)} text sizes (${sizes.join(', ')} px), more than ${String(limits.maxFontSizes)}` });
  for (const e of texts) {
    const css = e.fontSize / pixelRatio;
    if (css < limits.minFontSize) problems.push({ owner: e.owner, message: `small text ${e.path}: ${css.toFixed(1)} CSS px, under ${String(limits.minFontSize)}` });
    // text under a modal panel or popup is not seen; text under one whose modal is off stays measured
    if (e.dimmed || e.modalCovered || !inside(e.rect, image.width, image.height)) continue;
    const contrast = rectContrast(image, e.rect);
    const min = css >= LARGE_TEXT_CSS_PX ? limits.minLargeContrast : limits.minContrast;
    if (contrast !== null && contrast < min) problems.push({ owner: e.owner, message: `low contrast ${e.path}: ${contrast.toFixed(2)}:1, under ${String(min)}:1 for ${css.toFixed(1)} CSS px text` });
  }
  for (const body of panelBodies(elements, sceneKey, image, pixelRatio)) {
    const area = bounds(body.rect, image);
    if (area === null) continue;
    const size = body.rect.w * body.rect.h;
    const parts = elements.filter((e) => isAncestor(body.path, e.path) && e.rect.w * e.rect.h < 0.9 * size).map((e) => e.rect);
    const mask = covered(area, parts);
    const empty = mask.filter((v) => v === 0).length / mask.length;
    if (empty >= limits.maxEmptyShare) problems.push({ owner: body.owner, message: `empty panel ${body.path}: ${(empty * 100).toFixed(0)}% empty` });
  }
  return problems;
}

/** The keyboard capture rule: one focused text input, inside the window above the keyboard. */
export function keyboardProblem(elements: readonly UiElement[], windowHeight: number, keyboard: number): string | null {
  const focused = elements.filter((e) => e.textInput && e.focused);
  const [only] = focused;
  if (focused.length !== 1 || only === undefined) return `keyboard capture has ${String(focused.length)} focused text inputs`;
  if (only.rect.y < 0 || only.rect.y + only.rect.h > windowHeight - keyboard) return `keyboard covers focused text input ${only.path}`;
  return null;
}

function orientation(size: readonly number[]): string {
  return num(size[0]) > num(size[1]) ? 'Landscape' : 'Portrait';
}

/** `uiCheckScreens` items whose orientation is the orientation of `baseResolution`. */
export function screensOfOrientation(screens: readonly UiCheckScreen[], base: readonly number[]): UiCheckScreen[] {
  return screens.filter((screen) => orientation(screen.window) === orientation(base));
}

/** The settings paths of the `pixelRatio` that `uiCheckScreens` items of the orientation of `baseResolution` miss. */
export function missingPixelRatios(screens: readonly UiCheckScreen[], base: readonly number[]): string[] {
  return screens.flatMap((screen, i) => (orientation(screen.window) === orientation(base) && typeof screen.pixelRatio !== 'number' ? [`uiCheckScreens.${String(i)}.pixelRatio`] : []));
}

function measured(screens: readonly UiCheckScreen[]): MeasuredScreen[] {
  return screens.filter((screen): screen is MeasuredScreen => typeof screen.pixelRatio === 'number');
}

function point(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

const OPEN_COMMAND = /^[a-z][a-z0-9_]*\.open_[a-z][a-z0-9_]*$/;

/**
 * `where` of a UI quality failure the scene of which is not known (ogw.md `## check`: a file:line):
 * line 1 of the DEV registration file of the open command's feature (client-content engines/godot `## DEV code`), or
 * line 1 of game settings, which holds `uiCheckScreens`, when no open command is involved.
 */
export function unknownSceneWhere(command: string | null): string {
  if (command === null) return 'settings.json:1';
  const feature = command.split('.')[0] ?? '';
  return `client/dev/features/${feature}/${feature}_dev.gd:1`;
}
const PAD_DIRECTIONS = ['dpad_up', 'dpad_down', 'dpad_left', 'dpad_right'];

class SetupFailed extends Error {}

/**
 * A request the client did not answer (`automationRequest` throws an `OgwError`: no answer, a closed channel, a time
 * limit): no response. Another error is thrown.
 */
function unanswered(error: unknown): null {
  if (error instanceof OgwError) return null;
  throw error;
}

/** An open command whose request threw (the client crashed or hangs); the run stops after reporting it. */
class OpenThrew extends Error {}

/** The number of captures of one UI quality item so far, over all its instances: it numbers their evidence files. */
interface CaptureCount {
  value: number;
}

/** One unit of the captures of a UI quality item on one instance: its failures and the `where` of its screen. */
class UiRun {
  readonly failures: CheckFailure[] = [];
  /** `where` of the failures of the screen being checked: its scene key (ogw.md `## check`). */
  where = unknownSceneWhere(null);
  private readonly captures: CaptureCount;
  private readonly ctx: Context;
  private readonly id: string;
  private readonly platform: string;
  private readonly evidence: Evidence;
  private readonly settleLimitMs: number;
  private readonly pollMs: number;

  constructor(ctx: Context, id: string, platform: string, options: UiQualityOptions, captures: CaptureCount) {
    this.ctx = ctx;
    this.id = id;
    this.platform = platform;
    this.evidence = options.evidence;
    this.settleLimitMs = options.quality.settleLimitMs;
    this.pollMs = options.pollMs;
    this.captures = captures;
  }

  request(command: string, args: string[]): Promise<AutomationResponse> {
    return automationRequest(this.ctx, this.id, command, args);
  }

  async setup(command: string, args: string[]): Promise<AutomationResponse> {
    const response = await this.request(command, args);
    if (!response.ok) throw new SetupFailed(`${command} ${args.join(' ')} failed: ${JSON.stringify(response.result)}`);
    return response;
  }

  /** `set_language` through the runner (`restartClient`), which waits for the new boot to reach `Done`. */
  async language(code: string): Promise<void> {
    this.where = unknownSceneWhere(null);
    try {
      await restartClient(this.ctx, this.id, 'main', { command: 'set_language', args: [code], timeoutMs: LIMITS.httpMs });
    } catch (error) {
      throw new SetupFailed(`set_language ${code} did not reach boot_stage Done: ${(error as Error).message}`);
    }
  }

  async screen(item: UiCheckScreen): Promise<void> {
    await this.setup('set_test_screen', [String(item.window[0]), String(item.window[1]), item.fillMode]);
    await this.setup('set_virtual_notch', item.notch.map(String));
  }

  async capture(label: string): Promise<{ elements: UiElement[]; evidence: (string | null)[]; png: Buffer }> {
    this.captures.value++;
    const name = `ui-${this.platform}/${String(this.captures.value).padStart(4, '0')}-${label}`;
    const png = await this.setup('capture_screen', []);
    const list = await this.setup('list_ui', []);
    const evidence = [
      await writeEvidence(this.evidence, `${name}.png`, png.bytes),
      await writeEvidence(this.evidence, `${name}.json`, `${JSON.stringify(list.result, null, 2)}\n`),
    ];
    return { elements: toElements(list.result), evidence, png: png.bytes };
  }

  /** A failure of the screen being checked, at its scene; `owner` is the panel or popup key (`qa-core` `list_ui`), when known. */
  report(message: string, context: string, evidence: (string | null)[], owner?: string): void {
    this.failures.push(failure(this.where, `${message}${owner === undefined ? '' : ` in ${owner}`} (${context})`, evidence));
  }

  /** `scene_key` of `get_state`, or {@link unknownSceneWhere} of `command` when the client does not answer it. */
  async sceneWhere(command: string): Promise<string> {
    const response = await this.request('get_state', []).catch(unanswered);
    const state = response?.ok === true ? response.result : null;
    const key = typeof state === 'object' && state !== null ? (state as Record<string, unknown>).scene_key : undefined;
    return typeof key === 'string' && key !== '' ? key : unknownSceneWhere(command);
  }

  /**
   * Calls the open command of a screen and reads the scene the failures of the screen are at. A failing command fails
   * that screen (ogw.md `## UI quality` 3): reported with the command in the message, then false. A request that
   * throws is reported the same way and stops the run.
   */
  async open(command: string, context: string): Promise<boolean> {
    let opened: AutomationResponse;
    try {
      opened = await this.request(command, []);
    } catch (error) {
      this.where = await this.sceneWhere(command);
      this.report(`${command} failed: ${(error as Error).message}`, context, []);
      throw new OpenThrew(`${command} failed: ${(error as Error).message}`);
    }
    this.where = await this.sceneWhere(command);
    if (!opened.ok) {
      this.report(`${command} failed: ${JSON.stringify(opened.result)}`, context, []);
      return false;
    }
    await this.settle();
    return true;
  }

  /**
   * Waits until `get_state` has `ui_flow` false and `finite_tweens` 0, at most `settleLimitMs` (ogw.md `## UI quality`
   * 3), so that the opening presentation of the screen has ended. A core whose state has neither field is
   * waited for the whole limit.
   */
  private async settle(): Promise<void> {
    const until = Date.now() + this.settleLimitMs;
    for (;;) {
      const response = await this.request('get_state', []).catch(unanswered);
      const state = response?.ok === true && typeof response.result === 'object' && response.result !== null ? (response.result as Record<string, unknown>) : null;
      const known = state !== null && 'ui_flow' in state && 'finite_tweens' in state;
      if (known && state.ui_flow === false && state.finite_tweens === 0) return;
      const left = until - Date.now();
      if (left <= 0) return;
      await sleep(known ? Math.min(this.pollMs, left) : left);
    }
  }
}

/** Keyboard captures of one capture; false when a reopen of the screen failed, which fails the rest of that screen. */
async function keyboardCaptures(run: UiRun, elements: UiElement[], item: UiCheckScreen, command: string, context: string): Promise<boolean> {
  const keyboard = item.keyboard ?? 0;
  for (const input of elements.filter((e) => e.textInput && !e.modalCovered)) {
    await run.setup('tap', [point(input.rect.x + input.rect.w / 2), point(input.rect.y + input.rect.h / 2)]);
    await run.setup('set_virtual_keyboard', [String(keyboard)]);
    const shot = await run.capture(`${context.replaceAll(' ', '_')}-keyboard`);
    for (const p of layoutProblems(shot.elements)) run.report(p.message, `${context}, keyboard`, shot.evidence, p.owner);
    const problem = keyboardProblem(shot.elements, item.window[1], keyboard);
    if (problem !== null) run.report(problem, context, shot.evidence, input.owner);
    await run.setup('set_virtual_keyboard', ['none']);
    if (!(await run.open(command, context))) return false;
  }
  return true;
}

type Shot = Awaited<ReturnType<UiRun['capture']>>;

/**
 * The conditions of a capture at text scale 1000 that is not a keyboard capture (ogw.md `## UI quality`), in CSS pixels
 * of `pixelRatio` of its screen; touch targets when `touch`, the platform of the check being a touch platform.
 */
async function judgeCapture(run: UiRun, shot: Shot, item: MeasuredScreen, context: string, quality: UiQualityLimits, touch: boolean): Promise<void> {
  const ratio = item.pixelRatio;
  // the conditions look at the capture only through the elements of list_ui
  if (shot.elements.length > 0) {
    // decodeRgba fails with an OgwError that says why the bytes are no image
    const image = await decodeRgba(shot.png, 'capture_screen').catch((error: unknown) => {
      if (error instanceof OgwError) return error;
      throw error;
    });
    if (image instanceof OgwError) run.report(`capture_screen gave no PNG image: ${image.message}`, context, shot.evidence);
    else for (const p of presentationProblems(shot.elements, image, run.where, quality, ratio)) run.report(p.message, context, shot.evidence, p.owner);
  }
  if (touch) for (const p of touchTargetProblems(shot.elements, ratio, quality.minTouchTarget)) run.report(p.message, context, shot.evidence, p.owner);
}

/** Captures of one screen; `touch` when the platform of the check is a touch platform. */
async function screenCaptures(run: UiRun, language: string, item: MeasuredScreen, command: string, scales: (number | null)[], quality: UiQualityLimits, touch: boolean): Promise<void> {
  if (!(await run.open(command, `${language}, ${item.name}`))) return;
  for (const scale of scales) {
    if (scale !== null) await run.setup('set_text_scale', [String(scale)]);
    const context = `${language}, ${item.name}, ${command}, text scale ${String(scale ?? 1000)}`;
    const shot = await run.capture(`${language}-${item.name}-${command}-${String(scale ?? 1000)}`);
    for (const p of layoutProblems(shot.elements)) run.report(p.message, context, shot.evidence, p.owner);
    if ((scale ?? 1000) === 1000) await judgeCapture(run, shot, item, context, quality, touch);
    if ((item.keyboard ?? 0) >= 1 && !(await keyboardCaptures(run, shot.elements, item, command, context))) return;
  }
}

async function expand(run: UiRun, path: string): Promise<string[]> {
  const found: string[] = [];
  for (const direction of PAD_DIRECTIONS) {
    if (!(await run.request('focus_ui', [path])).ok) return [];
    await run.setup('pad_button_down', [direction]);
    await run.setup('pad_button_up', [direction]);
    const elements = toElements((await run.setup('list_ui', [])).result);
    for (const e of elements) if (e.button && e.focused) found.push(e.path);
  }
  return found;
}

/** Gamepad focus check of one screen; returns the target buttons that no gamepad focus reached, or null when the screen did not open. */
async function gamepadUnreached(run: UiRun, command: string, context: string): Promise<UiElement[] | null> {
  if (!(await run.open(command, context))) return null;
  await run.setup('set_input_device', ['Gamepad']);
  const elements = toElements((await run.setup('list_ui', [])).result);
  const targets = targetButtons(elements);
  const reached = new Set([...elements.filter((e) => e.focused), ...targets.filter((e) => e.padAction)].map((e) => e.path));
  const expanded = new Set<string>();
  for (let next = [...reached].find((p) => !expanded.has(p)); next !== undefined; next = [...reached].find((p) => !expanded.has(p))) {
    expanded.add(next);
    for (const path of await expand(run, next)) reached.add(path);
  }
  return targets.filter((e) => !reached.has(e.path));
}

async function openCommands(run: UiRun): Promise<string[]> {
  const listed = await run.setup('list_commands', []);
  const names = Array.isArray(listed.result) ? (listed.result as { name?: unknown }[]).map((c) => c.name) : [];
  return names.filter((name): name is string => typeof name === 'string' && OPEN_COMMAND.test(name));
}

async function gamepadCheck(run: UiRun, options: UiQualityOptions, screens: UiCheckScreen[], commands: string[]): Promise<void> {
  const [language] = options.languages;
  const [item] = screens;
  if (language === undefined || item === undefined) return;
  await run.language(language);
  await run.screen(item);
  if (options.maxTextScale !== null) await run.setup('set_text_scale', ['1000']);
  for (const command of commands) {
    const context = `${language}, ${item.name}, gamepad`;
    const unreached = await gamepadUnreached(run, command, context);
    const owners = [...new Set((unreached ?? []).map((e) => e.owner))];
    for (const owner of owners) {
      const paths = (unreached ?? []).filter((e) => e.owner === owner).map((e) => e.path);
      run.report(`gamepad focus does not reach ${paths.join(' ')} after ${command}`, context, [], owner);
    }
  }
}

/** A unit of the captures of a UI quality item: the captures of one language, or the gamepad focus check. */
type UiUnit = { language: string } | 'gamepad';

/** What a unit, or the reading of the open commands before the units, judged, and the error that stopped it. */
interface UnitOutcome {
  failures: CheckFailure[];
  where: string;
  error: { value: unknown } | null;
}

/** The captures of one language: each screen of step 2, each open command of step 3 and each text scale of step 4. */
async function languageCaptures(run: UiRun, language: string, screens: readonly MeasuredScreen[], commands: readonly string[], scales: readonly (number | null)[], quality: UiQualityLimits, touch: boolean): Promise<void> {
  await run.language(language);
  for (const item of screens) {
    await run.screen(item);
    for (const command of commands) await screenCaptures(run, language, item, command, [...scales], quality, touch);
  }
}

/** A setup command that failed or an open command whose request threw: the run stops, and what was judged before stays. */
function isStop(error: unknown): error is SetupFailed | OpenThrew {
  return error instanceof SetupFailed || error instanceof OpenThrew;
}

function didNotRun(platform: string, error: unknown): CheckResult {
  return checkResult('UI quality', platform, [failure(unknownSceneWhere(null), `UI quality did not run: ${(error as Error).message}`)], true);
}

/**
 * The result of the outcomes in unit order, as one instance that ran the units one after another gives it: the failures
 * up to the first unit that stopped. A stop with no failure before it is `unknown` with its reason.
 */
function unitsResult(platform: string, outcomes: readonly (UnitOutcome | undefined)[]): CheckResult {
  const failures: CheckFailure[] = [];
  for (const outcome of outcomes) {
    if (outcome === undefined) continue;
    failures.push(...outcome.failures);
    if (outcome.error === null) continue;
    // failures judged before the stop already make the result fail; with none, nothing was judged
    if (failures.length > 0) return checkResult('UI quality', platform, failures);
    const error = outcome.error.value;
    return isStop(error) ? checkResult('UI quality', platform, [failure(outcome.where, error.message)], true) : didNotRun(platform, error);
  }
  return checkResult('UI quality', platform, failures);
}

/**
 * The captures of one platform profile (ogw.md `## UI quality`): the units (each language, then the gamepad focus
 * check) in order on an instance that draws the screen, and beside it on more such instances in free slots of the check
 * (`shareUnits`). The result is that of the units in order (`unitsResult`).
 */
async function capturesCheck(ctx: Context, game: string, platform: string, options: UiQualityOptions): Promise<CheckResult> {
  const screens = measured(screensOfOrientation(options.screens, options.baseResolution));
  const scales = options.maxTextScale === null ? [null] : [...new Set([1000, options.maxTextScale])];
  const touch = TOUCH_PLATFORMS.includes(platform);
  const units: UiUnit[] = [...options.languages.map((language) => ({ language })), ...(options.gamepadSupported ? ['gamepad' as const] : [])];
  const queue = new UnitQueue(units.length);
  // index 0: the reading of the open commands, which comes before every unit
  const outcomes: (UnitOutcome | undefined)[] = [];
  const count: CaptureCount = { value: 0 };
  let commands: string[] = [];
  const instanceOptions = { game, platform, client: 'window' as const, db: options.db };
  // an error other than a stop is thrown after its outcome is kept, so that the instance keeps its logs
  const runUnits = async (id: string, next: () => number | null): Promise<void> => {
    for (let i = next(); i !== null; i = next()) {
      const run = new UiRun(ctx, id, platform, options, count);
      const unit = units[i] as UiUnit;
      try {
        if (unit === 'gamepad') await gamepadCheck(run, options, screens, commands);
        else await languageCaptures(run, unit.language, screens, commands, scales, options.quality, touch);
        outcomes[i + 1] = { failures: run.failures, where: run.where, error: null };
      } catch (error) {
        outcomes[i + 1] = { failures: run.failures, where: run.where, error: { value: error } };
        shared.stopAfter(i);
        if (!isStop(error)) throw error;
        return;
      }
    }
  };
  const shared = shareUnits(
    options.slots,
    queue,
    (next, signal) => onInstance(ctx, instanceOptions, (instance) => runUnits(instance.id, next), options.evidence, signal),
    (error) => {
      ctx.log(`UI quality (${platform}): a helper instance ended: ${(error as Error).message}`);
    },
  );
  const recorded = (error: unknown): boolean => outcomes.some((o) => o?.error?.value === error);
  try {
    await withInstance(ctx, options.slots, instanceOptions, async (instance) => {
      const run = new UiRun(ctx, instance.id, platform, options, count);
      try {
        commands = await openCommands(run);
      } catch (error) {
        outcomes[0] = { failures: run.failures, where: run.where, error: { value: error } };
        if (!isStop(error)) throw error;
        return;
      }
      await runUnits(instance.id, () => shared.claim());
    }, options.evidence);
  } catch (error) {
    // an error that an outcome holds is judged with the outcomes; another error of the instance leaves nothing judged in full
    if (!recorded(error)) {
      await shared.helpers();
      return didNotRun(platform, error);
    }
  }
  await shared.helpers();
  return unitsResult(platform, outcomes);
}

/**
 * The UI quality item of the captures and that of the flash check together (ogw.md `## UI quality`): `fail` with the
 * failures of the parts that fail, else `unknown` with the reasons of the parts that are `unknown`, else `pass`.
 */
export function withFlash(captures: CheckResult, flash: FlashPart): CheckResult {
  const flashFails = !flash.unknown && flash.failures.length > 0;
  if (captures.result === 'fail' || flashFails) return { ...captures, result: 'fail', failures: [...(captures.result === 'fail' ? captures.failures : []), ...(flashFails ? flash.failures : [])] };
  if (captures.result === 'unknown' || flash.unknown) return { ...captures, result: 'unknown', failures: [...(captures.result === 'unknown' ? captures.failures : []), ...(flash.unknown ? flash.failures : [])] };
  return captures;
}

/** UI quality of one platform profile (ogw.md `## UI quality`): the captures and the flash check, each in an instance that draws the screen. */
export async function uiQualityCheck(ctx: Context, game: string, platform: string, options: UiQualityOptions): Promise<CheckResult> {
  // without the pixel ratio of a screen no size of its captures can be judged: no instance starts
  const missing = missingPixelRatios(options.screens, options.baseResolution);
  if (missing.length > 0) return checkResult('UI quality', platform, missing.map((path) => failure(unknownSceneWhere(null), `${path}: missing`)), true);
  const screens = measured(screensOfOrientation(options.screens, options.baseResolution));
  const flashOptions = { ...options, screens };
  const [captures, flash] = await Promise.all([capturesCheck(ctx, game, platform, options), flashCheck(ctx, game, platform, flashOptions)]);
  return withFlash(captures, flash);
}
