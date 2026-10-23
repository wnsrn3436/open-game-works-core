import type { Context } from '../../../lib/command.ts';
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

  async capture(label: string): Promise<{ elements: UiElement[]; evidence: (string | null)[] }> {
    this.captures++;
    const name = `ui-${this.platform}/${String(this.captures).padStart(4, '0')}-${label}`;
    const png = await this.setup('capture_screen', []);
    const list = await this.setup('list_ui', []);
    const evidence = [
      await writeEvidence(this.evidence, `${name}.png`, png.bytes),
      await writeEvidence(this.evidence, `${name}.json`, `${JSON.stringify(list.result, null, 2)}\n`),
    ];
    return { elements: toElements(list.result), evidence };
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

async function screenCaptures(run: UiRun, language: string, item: UiCheckScreen, command: string, scales: (number | null)[]): Promise<void> {
  if (!(await run.open(command, `${language}, ${item.name}`))) return;
  for (const scale of scales) {
    if (scale !== null) await run.setup('set_text_scale', [String(scale)]);
    const context = `${language}, ${item.name}, ${command}, text scale ${String(scale ?? 1000)}`;
    const shot = await run.capture(`${language}-${item.name}-${command}-${String(scale ?? 1000)}`);
    for (const p of layoutProblems(shot.elements)) run.report(p.message, context, shot.evidence, p.owner);
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
        for (const command of commands) await screenCaptures(run, language, item, command, scales);
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
