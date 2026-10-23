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
  screensOfOrientation,
  toElements,
  uiQualityCheck,
  type UiElement,
  type UiQualityOptions,
} from '../../../../src/commands/check/lib/ui-quality.ts';
import { fakeAutomation, fakeContext, notOk, ok } from '../helpers.ts';

vi.mock('../../../../src/commands/instance/automation.ts', () => ({
  automationRequest: vi.fn(),
  restartClient: async (...args: Parameters<typeof import('../helpers.ts').fakeRestartClient>) => (await import('../helpers.ts')).fakeRestartClient(...args),
}));
vi.mock('../../../../src/commands/instance/api.ts', () => ({ startInstance: vi.fn(), stopInstance: vi.fn(), listInstances: vi.fn() }));

const ctx = fakeContext();

function el(path: string, extra: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { path, rect: [0, 0, 10, 10], text: '', clipped: false, owner: 'lobby', button: false, pad_action: false, modal_covered: false, text_input: false, focused: false, ...extra };
}

function elements(list: Record<string, unknown>[]): UiElement[] {
  return toElements(list);
}

describe('UI quality rules', () => {
  it('toElements reads [x, y, w, h] rects and defaults', () => {
    expect(toElements([{ path: 'a', rect: [1, 2, 3, 4], text: 5, owner: 'o' }])).toEqual([
      { path: 'a', rect: { x: 1, y: 2, w: 3, h: 4 }, text: '', clipped: false, owner: 'o', button: false, padAction: false, modalCovered: false, textInput: false, focused: false },
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
function fakeUi(): { calls: string[] } {
  const calls: string[] = [];
  let screen = '';
  let scale = 1000;
  let focus = '';
  let booting = 0;
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
    return ok({ boot_stage: 'Done', scene_key: 'lobby' });
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
    switch (command) {
      case 'list_commands':
        return ok([{ name: 'shop.open_main' }, { name: 'inv.open_bag' }, { name: 'shop.buy' }, { name: 'get_state' }]);
      case 'get_state':
        return state();
      case 'capture_screen':
        return ok(null, Buffer.from('PNG'));
      case 'list_ui':
        return ok(ui());
      default:
        change(command, args);
        return ok(null);
    }
  }));
  return { calls };
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
    ...extra,
  };
}

beforeEach(() => {
  vi.mocked(startInstance).mockReset().mockResolvedValue({ id: 'u1' } as Awaited<ReturnType<typeof startInstance>>);
  vi.mocked(stopInstance).mockReset().mockResolvedValue();
});

describe('uiQualityCheck', () => {
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
    expect(readFileSync(join(root, 'ev/ui-ios/0003-ko-phone-shop.open_main-1400.png'), 'utf8')).toBe('PNG');
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
