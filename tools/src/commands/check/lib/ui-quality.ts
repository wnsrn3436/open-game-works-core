import type { Context } from '../../../lib/command.ts';
import { decodeRgba, type Rgba } from '../../resource/lib/image.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { automationRequest, restartClient, type AutomationResponse } from '../../instance/automation.ts';
import type { CheckFailure, CheckResult } from '../api.ts';
import type { InstanceCheckOptions } from './bot-playtest.ts';
import { checkResult, failure, writeEvidence, type Evidence } from './evidence.ts';
import { withInstance } from './instances.ts';

/** Game settings `uiCheckScreens` item. */
export interface UiCheckScreen {
  name: string;
  window: [number, number];
  fillMode: string;
  notch: [number, number, number, number];
  keyboard?: number;
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
}

/** Game settings `uiQuality`: the numbers of the presentation conditions (`qa-core` UI quality check). */
export interface UiQualityLimits {
  maxFontSizes: number;
  minFontPx: number;
  minContrast: number;
  maxFlatShare: number;
  maxEmptyShare: number;
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

/** Clipped elements and overlaps (`qa-core` UI quality check) of one capture, with the `owner` of the problem. */
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

/** The shortest side of a panel body, in pixels of a window 1080 high: a thinner element is a bar, not a panel. */
const PANEL_MIN_SIDE = 64;

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
 * not thinner than `PANEL_MIN_SIDE` (a bar), and have a descendant element, with no such ancestor.
 */
export function panelBodies(elements: readonly UiElement[], sceneKey: string, window: { width: number; height: number }): UiElement[] {
  const windowArea = window.width * window.height;
  const minSide = (PANEL_MIN_SIDE * window.height) / 1080;
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
    for (let y = ry0; y < ry1; y++) mask.fill(1, (y - y0) * w + (rx0 - x0), (y - y0) * w + (rx1 - x0));
  }
  return mask;
}

/** Share of the uncovered pixels of `area` that lie within 8 (each of R, G, B) of their most common color; null with none uncovered. */
function flatShare(image: Rgba, area: [number, number, number, number], mask: Uint8Array): number | null {
  const [x0, y0, x1, y1] = area;
  const w = x1 - x0;
  const counts = new Map<number, number>();
  const pixels: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (mask[(y - y0) * w + (x - x0)] === 1) continue;
      const i = (y * image.width + x) * 4;
      const color = ((image.data[i] as number) << 16) | ((image.data[i + 1] as number) << 8) | (image.data[i + 2] as number);
      pixels.push(color);
      counts.set(color, (counts.get(color) ?? 0) + 1);
    }
  }
  if (pixels.length === 0) return null;
  let mode = 0;
  let best = -1;
  for (const [color, n] of counts) if (n > best) [mode, best] = [color, n];
  const near = (c: number): boolean =>
    Math.abs(((c >> 16) & 255) - ((mode >> 16) & 255)) <= 8 && Math.abs(((c >> 8) & 255) - ((mode >> 8) & 255)) <= 8 && Math.abs((c & 255) - (mode & 255)) <= 8;
  return pixels.filter(near).length / pixels.length;
}

/**
 * The presentation conditions of one capture (`qa-core` UI quality check): text sizes, small text, contrast, flat
 * panels and empty panels, each with the `owner` of the problem.
 */
export function presentationProblems(
  elements: readonly UiElement[],
  image: Rgba,
  sceneKey: string,
  limits: UiQualityLimits,
): { owner: string; message: string }[] {
  const problems: { owner: string; message: string }[] = [];
  const texts = elements.filter((e) => e.text !== '');
  const sizes = [...new Set(texts.map((e) => Math.round(e.fontSize)))].sort((a, b) => a - b);
  if (sizes.length > limits.maxFontSizes) problems.push({ owner: sceneKey, message: `${String(sizes.length)} text sizes (${sizes.join(', ')} px), more than ${String(limits.maxFontSizes)}` });
  for (const e of texts) {
    const at1080 = (e.fontSize * 1080) / image.height;
    if (at1080 < limits.minFontPx) problems.push({ owner: e.owner, message: `small text ${e.path}: ${at1080.toFixed(1)} px at 1080 high` });
    if (!inside(e.rect, image.width, image.height)) continue;
    const contrast = rectContrast(image, e.rect);
    if (contrast !== null && contrast < limits.minContrast) problems.push({ owner: e.owner, message: `low contrast ${e.path}: ${contrast.toFixed(2)}:1` });
  }
  for (const body of panelBodies(elements, sceneKey, image)) {
    const area = bounds(body.rect, image);
    if (area === null) continue;
    const textRects = texts.map((e) => e.rect);
    const flat = flatShare(image, area, covered(area, textRects));
    if (flat !== null && flat >= limits.maxFlatShare) problems.push({ owner: body.owner, message: `flat panel ${body.path}: ${(flat * 100).toFixed(0)}% one color` });
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

function point(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

const OPEN_COMMAND = /^[a-z][a-z0-9_]*\.open_[a-z][a-z0-9_]*$/;

/**
 * `where` of a UI quality failure the scene of which is not known (`game-loop` `## loop iteration record`: a file:line):
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

/** An open command whose request threw (the client crashed or hangs); the run stops after reporting it. */
class OpenThrew extends Error {}

class UiRun {
  readonly failures: CheckFailure[] = [];
  /** `where` of the failures of the screen being checked: its scene key (`game-loop` `## loop iteration record`). */
  where = unknownSceneWhere(null);
  private captures = 0;
  private readonly ctx: Context;
  private readonly id: string;
  private readonly platform: string;
  private readonly evidence: Evidence;

  constructor(ctx: Context, id: string, platform: string, options: UiQualityOptions) {
    this.ctx = ctx;
    this.id = id;
    this.platform = platform;
    this.evidence = options.evidence;
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
    this.captures++;
    const name = `ui-${this.platform}/${String(this.captures).padStart(4, '0')}-${label}`;
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
    const response = await this.request('get_state', []).catch(() => null);
    const state = response?.ok === true ? response.result : null;
    const key = typeof state === 'object' && state !== null ? (state as Record<string, unknown>).scene_key : undefined;
    return typeof key === 'string' && key !== '' ? key : unknownSceneWhere(command);
  }

  /**
   * Calls the open command of a screen and reads the scene the failures of the screen are at. A failing command fails
   * that screen (`qa-core` UI quality check 3): reported with the command in the message, then false. A request that
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
    if (opened.ok) return true;
    this.report(`${command} failed: ${JSON.stringify(opened.result)}`, context, []);
    return false;
  }
}

async function keyboardCaptures(run: UiRun, elements: UiElement[], item: UiCheckScreen, command: string, context: string): Promise<void> {
  const keyboard = item.keyboard ?? 0;
  for (const input of elements.filter((e) => e.textInput && !e.modalCovered)) {
    await run.setup('tap', [point(input.rect.x + input.rect.w / 2), point(input.rect.y + input.rect.h / 2)]);
    await run.setup('set_virtual_keyboard', [String(keyboard)]);
    const shot = await run.capture(`${context.replaceAll(' ', '_')}-keyboard`);
    for (const p of layoutProblems(shot.elements)) run.report(p.message, `${context}, keyboard`, shot.evidence, p.owner);
    const problem = keyboardProblem(shot.elements, item.window[1], keyboard);
    if (problem !== null) run.report(problem, context, shot.evidence, input.owner);
    await run.setup('set_virtual_keyboard', ['none']);
    await run.request(command, []);
  }
}

async function screenCaptures(run: UiRun, language: string, item: UiCheckScreen, command: string, scales: (number | null)[], quality: UiQualityLimits): Promise<void> {
  if (!(await run.open(command, `${language}, ${item.name}`))) return;
  for (const scale of scales) {
    if (scale !== null) await run.setup('set_text_scale', [String(scale)]);
    const context = `${language}, ${item.name}, ${command}, text scale ${String(scale ?? 1000)}`;
    const shot = await run.capture(`${language}-${item.name}-${command}-${String(scale ?? 1000)}`);
    for (const p of layoutProblems(shot.elements)) run.report(p.message, context, shot.evidence, p.owner);
    // the conditions look at the capture only through the elements of list_ui
    if ((scale ?? 1000) === 1000 && shot.elements.length > 0) {
      const image = await decodeRgba(shot.png, 'capture_screen').catch(() => null);
      if (image === null) run.report('capture_screen gave no PNG image', context, shot.evidence);
      else for (const p of presentationProblems(shot.elements, image, run.where, quality)) run.report(p.message, context, shot.evidence, p.owner);
    }
    if ((item.keyboard ?? 0) >= 1) await keyboardCaptures(run, shot.elements, item, command, context);
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
  const targets = elements.filter((e) => e.button && !e.modalCovered);
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

async function inspect(ctx: Context, id: string, platform: string, options: UiQualityOptions): Promise<CheckResult> {
  const run = new UiRun(ctx, id, platform, options);
  const screens = screensOfOrientation(options.screens, options.baseResolution);
  const scales = options.maxTextScale === null ? [null] : [...new Set([1000, options.maxTextScale])];
  try {
    const commands = await openCommands(run);
    for (const language of options.languages) {
      await run.language(language);
      for (const item of screens) {
        await run.screen(item);
        for (const command of commands) await screenCaptures(run, language, item, command, scales, options.quality);
      }
    }
    if (options.gamepadSupported) await gamepadCheck(run, options, screens, commands);
  } catch (error) {
    // Failures judged before the stop already make the result fail; with none, nothing was judged.
    if (run.failures.length > 0) return checkResult('UI quality', platform, run.failures);
    if (error instanceof SetupFailed || error instanceof OpenThrew) return checkResult('UI quality', platform, [failure(run.where, error.message)], true);
    throw error;
  }
  return checkResult('UI quality', platform, run.failures);
}

/** UI quality of one platform profile (`qa-core` UI quality check) in an instance that draws the screen. */
export async function uiQualityCheck(ctx: Context, game: string, platform: string, options: UiQualityOptions): Promise<CheckResult> {
  try {
    return await withInstance(ctx, options.slots, { game, platform, client: 'window', db: options.db }, (instance) =>
      inspect(ctx, instance.id, platform, options), options.evidence,
    );
  } catch (error) {
    return checkResult('UI quality', platform, [failure(unknownSceneWhere(null), `UI quality did not run: ${(error as Error).message}`)], true);
  }
}
