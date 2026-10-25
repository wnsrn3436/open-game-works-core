import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { automationRequest, type AutomationResponse } from '../../../../src/commands/instance/automation.ts';
import { startInstance, stopInstance } from '../../../../src/commands/instance/api.ts';
import { Slots } from '../../../../src/commands/check/lib/instances.ts';
import {
  keyboardProblem,
  layoutProblems,
  panelBodies,
  presentationProblems,
  rectContrast,
  screensOfOrientation,
  toElements,
  uiQualityCheck,
  type UiElement,
  type UiQualityOptions,
} from '../../../../src/commands/check/lib/ui-quality.ts';
import { fakeAutomation, fakeContext, notOk, ok } from '../helpers.ts';
import type { Rgba } from '../../../../src/commands/resource/lib/image.ts';

vi.mock('../../../../src/commands/instance/automation.ts', () => ({
  automationRequest: vi.fn(),
  restartClient: async (...args: Parameters<typeof import('../helpers.ts').fakeRestartClient>) => (await import('../helpers.ts')).fakeRestartClient(...args),
}));
vi.mock('../../../../src/commands/instance/api.ts', () => ({ startInstance: vi.fn(), stopInstance: vi.fn(), listInstances: vi.fn() }));

const ctx = fakeContext();

/** Limits no capture breaks, for the tests of the other conditions. */
const NO_LIMITS = { settleLimitMs: 0, maxFontSizes: 1000, minFontPx: 0, minContrast: 1, maxFlatShare: 2, maxEmptyShare: 2 };
/** A 1 × 1 white PNG, as capture_screen gives it. */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==', 'base64');

function el(path: string, extra: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { path, rect: [0, 0, 10, 10], text: '', clipped: false, owner: 'lobby', button: false, pad_action: false, modal_covered: false, text_input: false, focused: false, ...extra };
}

function elements(list: Record<string, unknown>[]): UiElement[] {
  return toElements(list);
}

/** An image of one color, with `paint` drawing rectangles of other colors on it. */
function canvas(width: number, height: number, color: [number, number, number], paint: [number, number, number, number, [number, number, number]][] = []): Rgba {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...color, 255], i * 4);
  for (const [x, y, w, h, c] of paint) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) data.set([...c, 255], (yy * width + xx) * 4);
  }
  return { width, height, data };
}

const LIMITS = { settleLimitMs: 0, maxFontSizes: 2, minFontPx: 18, minContrast: 3, maxFlatShare: 0.85, maxEmptyShare: 0.6 };

describe('UI quality presentation conditions', () => {
  it('counts text sizes, finds small text and low contrast', () => {
    // 1080 high: font_size is in pixels at 1080
    const image = canvas(200, 1080, [20, 20, 40], [[0, 0, 100, 40, [240, 240, 240]], [100, 100, 100, 40, [30, 30, 50]]]);
    const list = elements([
      el('hud/title', { text: 'T', font_size: 40, rect: [0, 0, 120, 40], owner: 'run' }),
      el('hud/body', { text: 'B', font_size: 20, rect: [100, 100, 100, 40], owner: 'run' }),
      el('hud/tiny', { text: 'x', font_size: 12, rect: [0, 200, 10, 10], owner: 'run' }),
      // one color where it is inside the image, but partly outside it: its contrast is not judged
      el('hud/edge', { text: 'E', font_size: 20, rect: [190, 100, 20, 40], owner: 'run' }),
    ]);
    expect(presentationProblems(list, image, 'run', LIMITS).map((p) => p.message)).toEqual([
      '3 text sizes (12, 20, 40 px), more than 2',
      'low contrast hud/body: 1.00:1',
      'small text hud/tiny: 12.0 px at 1080 high',
      'low contrast hud/tiny: 1.00:1',
    ]);
    // half the pixels of a rect bright: the 98th percentile is bright, the 2nd dark
    expect(rectContrast(canvas(10, 10, [0, 0, 0], [[0, 0, 10, 5, [255, 255, 255]]]), { x: 0, y: 0, w: 10, h: 10 })).toBeCloseTo(21, 5);
  });

  it('takes the top non-text, non-input, non-window elements of a popup or panel as panel bodies', () => {
    const list = elements([
      el('root', { owner: 'shop', rect: [0, 0, 100, 100] }),
      el('root/dim', { owner: 'shop', rect: [0, 0, 100, 100] }),
      el('root/frame', { owner: 'shop', rect: [10, 10, 50, 50] }),
      el('root/frame/inset', { owner: 'shop', rect: [15, 15, 40, 40] }),
      el('root/frame/ok', { owner: 'shop', rect: [20, 50, 20, 10], button: true }),
      el('hud/plate', { owner: 'run', rect: [0, 0, 10, 10] }),
    ]);
    expect(panelBodies(list, 'run', { width: 100, height: 100 }).map((e) => e.path)).toEqual(['root/frame']);
    // a bar thinner than 64 px at 1080 high and a leaf are not panel bodies
    const bars = elements([
      el('hud/xp', { owner: 'hud', rect: [0, 0, 800, 20] }),
      el('hud/xp/fill', { owner: 'hud', rect: [0, 0, 10, 20] }),
      el('hud/plate', { owner: 'hud', rect: [0, 100, 300, 80] }),
      el('hud/plate/label', { owner: 'hud', rect: [0, 100, 50, 20], text: 'x' }),
      el('hud/leaf', { owner: 'hud', rect: [0, 300, 300, 300] }),
    ]);
    expect(panelBodies(bars, 'run', { width: 1920, height: 1080 }).map((e) => e.path)).toEqual(['hud/plate']);
  });

  it('finds a flat panel and an empty panel, and passes a textured, filled one', () => {
    const big = { ...LIMITS, maxFontSizes: 10, minFontPx: 0, minContrast: 1 };
    const flat = canvas(100, 100, [0, 0, 0], [[10, 10, 80, 80, [30, 30, 60]]]);
    const list = elements([
      el('p', { owner: 'pop', rect: [10, 10, 80, 80] }),
      el('p/label', { owner: 'pop', text: 'Hi', font_size: 20, rect: [20, 20, 20, 10] }),
    ]);
    expect(presentationProblems(list, flat, 'scene', big).map((p) => p.message)).toEqual(['flat panel p: 100% one color', 'empty panel p: 97% empty']);
    // stripes every other row in two colors 40 apart, and children covering most of it
    const stripes: [number, number, number, number, [number, number, number]][] = [];
    for (let y = 10; y < 90; y += 2) stripes.push([10, y, 80, 1, [70, 70, 100]]);
    const textured = canvas(100, 100, [0, 0, 0], [[10, 10, 80, 80, [30, 30, 60]], ...stripes]);
    const filled = elements([
      el('p', { owner: 'pop', rect: [10, 10, 80, 80] }),
      el('p/a', { owner: 'pop', rect: [10, 10, 80, 40] }),
      el('p/b', { owner: 'pop', rect: [10, 50, 80, 30] }),
    ]);
    expect(presentationProblems(filled, textured, 'scene', big)).toEqual([]);
  });
});

describe('UI quality rules', () => {
  it('toElements reads [x, y, w, h] rects and defaults', () => {
    expect(toElements([{ path: 'a', rect: [1, 2, 3, 4], text: 5, owner: 'o' }])).toEqual([
      { path: 'a', rect: { x: 1, y: 2, w: 3, h: 4 }, text: '', fontSize: 0, clipped: false, owner: 'o', button: false, padAction: false, modalCovered: false, textInput: false, focused: false },
    ]);
    expect(toElements([el('b', { rect: [1, 2, 'x'], button: true, pad_action: true, modal_covered: true, text_input: true, focused: true, clipped: true })])[0]).toMatchObject({
      rect: { x: 1, y: 2, w: 0, h: 0 }, button: true, padAction: true, modalCovered: true, textInput: true, focused: true, clipped: true,
    });
    expect(toElements([{ path: 'c', rect: null }])[0]?.rect).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(toElements([{ path: 'd', rect: { x: 1, y: 2, w: 3, h: 4 } }])[0]?.rect).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(toElements('x')).toEqual([]);
  });

  it('layoutProblems: clipped elements and overlapping texts of one owner that are not ancestors', () => {
    const list = elements([
      el('root/a', { text: 'A', rect: [0, 0, 10, 10] }),
      el('root/b', { text: 'B', rect: [9, 9, 10, 10] }),
      el('root/a/child', { text: 'C', rect: [0, 0, 5, 5] }),
      el('root/d', { text: 'D', rect: [19, 0, 10, 9] }),
      el('root/e', { text: '', rect: [0, 0, 10, 10] }),
      el('root/f', { text: 'F', rect: [0, 0, 10, 10], owner: 'shop' }),
      el('root/g', { clipped: true, owner: 'shop' }),
    ]);
    expect(layoutProblems(list)).toEqual([
      { owner: 'shop', message: 'clipped root/g' },
      { owner: 'lobby', message: 'overlap root/a root/b' },
    ]);
    expect(layoutProblems(elements([el('x', { text: 'X', rect: [0, 0, 10, 10] }), el('xy', { text: 'Y', rect: [0, 0, 10, 10] })]))).toEqual([
      { owner: 'lobby', message: 'overlap x xy' },
    ]);
  });

  it('keyboardProblem: exactly one focused text input above the keyboard', () => {
    const input = (rect: number[], focused = true): Record<string, unknown> => el('in', { text_input: true, focused, rect });
    expect(keyboardProblem(elements([input([0, 100, 10, 100])]), 1000, 800)).toBeNull();
    expect(keyboardProblem(elements([input([0, 100, 10, 101])]), 1000, 800)).toBe('keyboard covers focused text input in');
    expect(keyboardProblem(elements([input([0, -1, 10, 10])]), 1000, 800)).toBe('keyboard covers focused text input in');
    expect(keyboardProblem(elements([input([0, 0, 10, 10], false)]), 1000, 800)).toBe('keyboard capture has 0 focused text inputs');
    expect(keyboardProblem(elements([input([0, 0, 1, 1]), input([0, 0, 1, 1])]), 1000, 800)).toBe('keyboard capture has 2 focused text inputs');
    expect(keyboardProblem(elements([el('t', { focused: true })]), 1000, 800)).toBe('keyboard capture has 0 focused text inputs');
  });

  it('screensOfOrientation keeps the orientation of baseResolution', () => {
    const phone = { name: 'phone', window: [1080, 1920] as [number, number], fillMode: 'Crop', notch: [0, 0, 0, 0] as [number, number, number, number] };
    const pad = { ...phone, name: 'pad', window: [2048, 1536] as [number, number] };
    const square = { ...phone, name: 'square', window: [1000, 1000] as [number, number] };
    expect(screensOfOrientation([phone, pad, square], [1080, 1920]).map((s) => s.name)).toEqual(['phone', 'square']);
    expect(screensOfOrientation([phone, pad, square], [1920, 1080]).map((s) => s.name)).toEqual(['pad']);
  });
});

/** A fake client with two screens: `shop.open_main` (a text input; overlap at text scale 1400) and `inv.open_bag`. */
/**
 * A fake client of the UI quality check. After an open command, `settleReads` reads of `get_state` give `ui_flow` true and
 * one finite tween; `legacy` leaves both fields out, as a core before them.
 */
function fakeUi(flow: { settleReads?: number; legacy?: boolean } = {}): { calls: string[]; times: { command: string; at: number }[] } {
  const calls: string[] = [];
  const times: { command: string; at: number }[] = [];
  let screen = '';
  let scale = 1000;
  let focus = '';
  let booting = 0;
  let settling = 0;
  const ui = (): Record<string, unknown>[] => {
    if (screen === 'shop.open_main') {
      return [
        el('shop/buy', { text: 'Buy', button: true, focused: focus === 'shop/buy', rect: [0, 0, scale === 1400 ? 20 : 10, 10], owner: 'shop_panel' }),
        el('shop/price', { text: '9', rect: [15, 0, 10, 10], owner: 'shop_panel' }),
        el('shop/next', { button: true, focused: focus === 'shop/next', rect: [0, 50, 10, 10], owner: 'shop_panel' }),
        el('shop/name', { text_input: true, focused: focus === 'shop/name', rect: [0, 1500, 100, 100], owner: 'shop_panel' }),
        el('shop/hidden', { text_input: true, modal_covered: true, owner: 'shop_panel' }),
      ];
    }
    return [el('bag/close', { button: true, pad_action: true, rect: [0, 0, 10, 10] }), el('bag/sort', { button: true, rect: [0, 30, 10, 10] })];
  };
  const state = (): AutomationResponse => {
    if (booting > 0) {
      booting--;
      if (booting === 1) throw new Error('restarting');
      return ok({ boot_stage: 'Login' });
    }
    if (flow.legacy === true) return ok({ boot_stage: 'Done', scene_key: 'lobby' });
    const busy = settling > 0;
    if (busy) settling--;
    return ok({ boot_stage: 'Done', scene_key: 'lobby', ui_flow: busy, finite_tweens: busy ? 1 : 0 });
  };
  /** Commands that only change the fake's state and answer null. */
  const change = (command: string, args: string[]): void => {
    switch (command) {
      case 'set_language':
        booting = 2;
        break;
      case 'shop.open_main':
      case 'inv.open_bag':
        screen = command;
        focus = command === 'shop.open_main' ? 'shop/buy' : '';
        settling = flow.settleReads ?? 0;
        break;
      case 'set_text_scale':
        scale = Number(args[0]);
        break;
      case 'tap':
        focus = 'shop/name';
        break;
      case 'focus_ui':
        focus = args[0] ?? '';
        break;
      case 'pad_button_down':
        if (focus === 'shop/buy' && args[0] === 'dpad_down') focus = 'shop/next';
        break;
    }
  };
  vi.mocked(automationRequest).mockImplementation(fakeAutomation((command, args) => {
    calls.push([command, ...args].join(' '));
    times.push({ command, at: Date.now() });
    switch (command) {
      case 'list_commands':
        return ok([{ name: 'shop.open_main' }, { name: 'inv.open_bag' }, { name: 'shop.buy' }, { name: 'get_state' }]);
      case 'get_state':
        return state();
      case 'capture_screen':
        return ok(null, PNG_1X1);
      case 'list_ui':
        return ok(ui());
      default:
        change(command, args);
        return ok(null);
    }
  }));
  return { calls, times };
}

function options(evidenceRoot: string, extra: Partial<UiQualityOptions> = {}): UiQualityOptions {
  return {
    evidence: { root: evidenceRoot, dir: 'ev', relative: true },
    slots: new Slots(1),
    pollMs: 1,
    languages: ['ko', 'en'],
    screens: [
      { name: 'phone', window: [1080, 1920], fillMode: 'Crop', notch: [0, 80, 0, 0], keyboard: 600 },
      { name: 'wide', window: [1920, 1080], fillMode: 'Letterbox', notch: [0, 0, 0, 0] },
    ],
    baseResolution: [1080, 1920],
    gamepadSupported: true,
    maxTextScale: 1400,
    quality: NO_LIMITS,
    ...extra,
  };
}

beforeEach(() => {
  vi.mocked(startInstance).mockReset().mockResolvedValue({ id: 'u1' } as Awaited<ReturnType<typeof startInstance>>);
  vi.mocked(stopInstance).mockReset().mockResolvedValue();
});

describe('uiQualityCheck', () => {
  it('after every open command, keyboard reopens and the gamepad check included, reads get_state until the UI flow and finite tweens end', async () => {
    const { times } = fakeUi({ settleReads: 2 });
    const root = mkdtempSync(join(tmpdir(), 'ui-settle-'));
    await uiQualityCheck(ctx, 'g', 'ios', options(root, { languages: ['en'], quality: { ...NO_LIMITS, settleLimitMs: 60_000 } }));
    const opens = times.map((t, i) => ({ ...t, i })).filter((t) => t.command.includes('.open_'));
    // the first open, the keyboard reopens and the open of the gamepad check
    expect(opens.length).toBeGreaterThan(2);
    for (const open of opens) {
      const after = times.slice(open.i + 1);
      const next = after.findIndex((t) => t.command !== 'get_state');
      // the two busy reads (the read for the scene of the failures is one of them) and the settled read
      expect(next === -1 ? after.length : next).toBeGreaterThanOrEqual(3);
    }
  });

  it('waits the whole uiQuality.settleLimitMs after an open command for a core whose state has no UI flow fields', async () => {
    const { times } = fakeUi({ legacy: true });
    const root = mkdtempSync(join(tmpdir(), 'ui-settle-'));
    await uiQualityCheck(ctx, 'g', 'ios', options(root, { languages: ['en'], gamepadSupported: false, quality: { ...NO_LIMITS, settleLimitMs: 30 } }));
    for (const open of times.map((t, i) => ({ ...t, i })).filter((t) => t.command.includes('.open_'))) {
      const next = times.slice(open.i + 1).find((t) => t.command !== 'get_state');
      if (next !== undefined) expect(next.at - open.at).toBeGreaterThanOrEqual(30);
    }
  });

  it('captures every combination, judges captures, keyboard captures and gamepad focus', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-ui-'));
    const { calls } = fakeUi();
    const result = await uiQualityCheck(ctx, 'g', 'ios', options(root));
    expect(startInstance).toHaveBeenCalledWith(ctx, { game: 'g', platform: 'ios', client: 'window', db: undefined }, { beforeFailedStop: expect.any(Function) as unknown });
    expect(stopInstance).toHaveBeenCalledWith(ctx, 'u1');
    expect(result.name).toBe('UI quality');
    expect(result.platform).toBe('ios');
    expect(result.result).toBe('fail');
    expect(result.failures.map((f) => `${f.where} | ${f.message}`)).toEqual([
      'lobby | keyboard covers focused text input shop/name in shop_panel (ko, phone, shop.open_main, text scale 1000)',
      'lobby | overlap shop/buy shop/price in shop_panel (ko, phone, shop.open_main, text scale 1400)',
      'lobby | overlap shop/buy shop/price in shop_panel (ko, phone, shop.open_main, text scale 1400, keyboard)',
      'lobby | keyboard covers focused text input shop/name in shop_panel (ko, phone, shop.open_main, text scale 1400)',
      'lobby | keyboard covers focused text input shop/name in shop_panel (en, phone, shop.open_main, text scale 1000)',
      'lobby | overlap shop/buy shop/price in shop_panel (en, phone, shop.open_main, text scale 1400)',
      'lobby | overlap shop/buy shop/price in shop_panel (en, phone, shop.open_main, text scale 1400, keyboard)',
      'lobby | keyboard covers focused text input shop/name in shop_panel (en, phone, shop.open_main, text scale 1400)',
      'lobby | gamepad focus does not reach bag/sort after inv.open_bag in lobby (ko, phone, gamepad)',
    ]);
    expect(result.failures[1]?.evidence).toEqual(['ev/ui-ios/0003-ko-phone-shop.open_main-1400.png', 'ev/ui-ios/0003-ko-phone-shop.open_main-1400.json']);
    expect(readFileSync(join(root, 'ev/ui-ios/0003-ko-phone-shop.open_main-1400.png'), 'utf8')).toBe(PNG_1X1.toString('utf8'));
    expect(existsSync(join(root, 'ev/ui-ios/0002-ko,_phone,_shop.open_main,_text_scale_1000-keyboard.png'))).toBe(true);
    expect(calls).toContain('set_test_screen 1080 1920 Crop');
    expect(calls).toContain('set_virtual_notch 0 80 0 0');
    expect(calls).not.toContain('set_test_screen 1920 1080 Letterbox');
    expect(calls).toContain('tap 50 1550');
    expect(calls).toContain('set_virtual_keyboard 600');
    expect(calls).toContain('set_virtual_keyboard none');
    expect(calls).toContain('set_input_device Gamepad');
    expect(calls.filter((c) => c.startsWith('set_language'))).toEqual(['set_language ko', 'set_language en', 'set_language ko']);
    expect(calls.filter((c) => c === 'focus_ui shop/next')).toHaveLength(4);
  });

  it('without AccessibilityCore, keyboard or gamepad support it captures once per screen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-ui-'));
    const { calls } = fakeUi();
    const screens = [{ name: 'phone', window: [1080, 1920] as [number, number], fillMode: 'Crop', notch: [0, 0, 0, 0] as [number, number, number, number] }];
    const result = await uiQualityCheck(ctx, 'g', 'web', options(root, { languages: ['en'], screens, maxTextScale: null, gamepadSupported: false }));
    expect(result.result).toBe('pass');
    expect(calls.filter((c) => c.startsWith('set_text_scale'))).toEqual([]);
    expect(calls.filter((c) => c === 'capture_screen')).toHaveLength(2);
    expect(calls).not.toContain('set_input_device Gamepad');
  });

  it('judges the presentation conditions only on captures at text scale 1000 that are not keyboard captures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-ui-'));
    fakeUi();
    const screens = [{ name: 'phone', window: [1080, 1920] as [number, number], fillMode: 'Crop', notch: [0, 0, 0, 0] as [number, number, number, number], keyboard: 600 }];
    // every capture with text breaks maxFontSizes 0
    const strict = { ...NO_LIMITS, maxFontSizes: 0 };
    const result = await uiQualityCheck(ctx, 'g', 'web', options(root, { languages: ['en'], screens, gamepadSupported: false, quality: strict }));
    expect(result.failures.map((f) => f.message).filter((m) => m.includes('text sizes'))).toEqual(['1 text sizes (0 px), more than 0 in lobby (en, phone, shop.open_main, text scale 1000)']);
  });

  it('reports a capture that is no PNG image once per screen at text scale 1000', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-ui-'));
    fakeUi();
    const base = vi.mocked(automationRequest).getMockImplementation();
    vi.mocked(automationRequest).mockImplementation(async (c, i, command, args, client) =>
      command === 'capture_screen' ? ok(null, Buffer.from('PNG')) : (base?.(c, i, command, args, client) ?? ok(null)),
    );
    const screens = [{ name: 'phone', window: [1080, 1920] as [number, number], fillMode: 'Crop', notch: [0, 0, 0, 0] as [number, number, number, number], keyboard: 600 }];
    const result = await uiQualityCheck(ctx, 'g', 'web', options(root, { languages: ['en'], screens, gamepadSupported: false }));
    expect(result.failures.map((f) => f.message).filter((m) => m.includes('PNG'))).toEqual([
      'capture_screen gave no PNG image (en, phone, shop.open_main, text scale 1000)',
      'capture_screen gave no PNG image (en, phone, inv.open_bag, text scale 1000)',
    ]);
  });

  it('an open command that fails fails that screen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-ui-'));
    fakeUi();
    const base = vi.mocked(automationRequest).getMockImplementation();
    vi.mocked(automationRequest).mockImplementation(async (c, i, command, args, client) =>
      command === 'inv.open_bag' ? notOk('no bag') : (base?.(c, i, command, args, client) ?? ok(null)),
    );
    const result = await uiQualityCheck(ctx, 'g', 'web', options(root, { languages: ['en'], maxTextScale: 1000, screens: [{ name: 'p', window: [1, 2], fillMode: 'Crop', notch: [0, 0, 0, 0] }] }));
    expect(result.failures.map((f) => `${f.where} | ${f.message}`)).toEqual([
      'lobby | inv.open_bag failed: "no bag" (en, p)',
      'lobby | inv.open_bag failed: "no bag" (en, p, gamepad)',
    ]);
  });

  it('an open command whose request throws fails that screen and stops the run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-ui-'));
    const { calls } = fakeUi();
    const base = vi.mocked(automationRequest).getMockImplementation();
    vi.mocked(automationRequest).mockImplementation(async (c, i, command, args, client) => {
      if (command === 'shop.open_main') throw new Error('request timed out');
      return base?.(c, i, command, args, client) ?? ok(null);
    });
    const result = await uiQualityCheck(ctx, 'g', 'web', options(root, { languages: ['en'] }));
    expect(result.result).toBe('fail');
    expect(result.failures.map((f) => `${f.where} | ${f.message}`)).toEqual(['lobby | shop.open_main failed: request timed out (en, phone)']);
    expect(calls).not.toContain('inv.open_bag');
  });

  it('an open command that crashes the client fails at the DEV registration file of its feature', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-ui-'));
    fakeUi();
    const base = vi.mocked(automationRequest).getMockImplementation();
    let crashed = false;
    vi.mocked(automationRequest).mockImplementation(async (c, i, command, args, client) => {
      if (command === 'shop.open_main') crashed = true;
      if (crashed) throw new Error('connection refused');
      return base?.(c, i, command, args, client) ?? ok(null);
    });
    const result = await uiQualityCheck(ctx, 'g', 'web', options(root, { languages: ['en'] }));
    expect(result.result).toBe('fail');
    expect(result.failures.map((f) => `${f.where} | ${f.message}`)).toEqual([
      'client/dev/features/shop/shop_dev.gd:1 | shop.open_main failed: connection refused (en, phone)',
    ]);
  });

  it('keeps failures judged before a setup command fails: the result is fail, not unknown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-ui-'));
    fakeUi();
    const base = vi.mocked(automationRequest).getMockImplementation();
    vi.mocked(automationRequest).mockImplementation(async (c, i, command, args, client) =>
      command === 'set_language' && args[0] === 'en' ? notOk('no en') : (base?.(c, i, command, args, client) ?? ok(null)),
    );
    const result = await uiQualityCheck(ctx, 'g', 'web', options(root));
    expect(result.result).toBe('fail');
    expect(result.failures.map((f) => f.message)).toContain('overlap shop/buy shop/price in shop_panel (ko, phone, shop.open_main, text scale 1400)');
    expect(result.failures.every((f) => f.where === 'lobby')).toBe(true);
  });

  it('does not expand a reached button whose focus_ui fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-ui-'));
    const { calls } = fakeUi();
    const base = vi.mocked(automationRequest).getMockImplementation();
    vi.mocked(automationRequest).mockImplementation(async (c, i, command, args, client) =>
      command === 'focus_ui' && args[0] === 'shop/buy' ? notOk('gone') : (base?.(c, i, command, args, client) ?? ok(null)),
    );
    const screens = [{ name: 'phone', window: [1080, 1920] as [number, number], fillMode: 'Crop', notch: [0, 0, 0, 0] as [number, number, number, number] }];
    const result = await uiQualityCheck(ctx, 'g', 'web', options(root, { languages: ['en'], screens, maxTextScale: null }));
    expect(result.failures.map((f) => `${f.where} | ${f.message}`)).toEqual([
      'lobby | gamepad focus does not reach shop/next after shop.open_main in shop_panel (en, phone, gamepad)',
      'lobby | gamepad focus does not reach bag/sort after inv.open_bag in lobby (en, phone, gamepad)',
    ]);
    expect(calls.filter((c) => c.startsWith('pad_button_down')).length).toBe(4);
  });

  it('is unknown when a setup command fails or the instance does not start', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-ui-'));
    fakeUi();
    const base = vi.mocked(automationRequest).getMockImplementation();
    vi.mocked(automationRequest).mockImplementation(async (c, i, command, args, client) =>
      command === 'capture_screen' ? notOk('headless') : (base?.(c, i, command, args, client) ?? ok(null)),
    );
    const result = await uiQualityCheck(ctx, 'g', 'web', options(root, { languages: ['en'] }));
    expect(result.result).toBe('unknown');
    expect(result.failures.at(-1)).toEqual({ where: 'lobby', message: 'capture_screen  failed: "headless"', evidence: [] });
    vi.mocked(startInstance).mockRejectedValue(new Error('wait timeout'));
    expect((await uiQualityCheck(ctx, 'g', 'web', options(root))).failures).toEqual([{ where: 'settings.json:1', message: 'UI quality did not run: wait timeout', evidence: [] }]);
  });

  it('is unknown when boot does not reach Done after set_language', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const root = mkdtempSync(join(tmpdir(), 'ogw-ui-'));
      vi.mocked(automationRequest).mockImplementation(fakeAutomation((command) => {
        if (command === 'list_commands') return ok([]);
        if (command === 'get_state') {
          vi.setSystemTime(Date.now() + 10 * 60_000);
          return ok({ boot_stage: 'Login' });
        }
        return ok(null);
      }));
      const result = await uiQualityCheck(ctx, 'g', 'web', options(root, { languages: ['ja'] }));
      expect(result.failures).toEqual([{ where: 'settings.json:1', message: 'set_language ja did not reach boot_stage Done: boot_stage did not reach Done within 300000 ms', evidence: [] }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
