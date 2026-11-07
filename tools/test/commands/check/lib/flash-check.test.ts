import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cssSize, flashCheck, flashTiming, recordedScreen, sceneOf, type FlashOptions } from '../../../../src/commands/check/lib/flash-check.ts';
import { Slots } from '../../../../src/commands/check/lib/instances.ts';
import type { MeasuredScreen } from '../../../../src/commands/check/lib/ui-quality.ts';
import { parseScenario, type Scenario } from '../../../../src/commands/check/lib/scenario.ts';
import { instanceProcesses, instanceServerLog, listInstances, startInstance, stopInstance, type InstanceOptions } from '../../../../src/commands/instance/api.ts';
import { automationRequest } from '../../../../src/commands/instance/automation.ts';
import { decodeRgba, encodePng } from '../../../../src/commands/resource/lib/image.ts';
import { createContext } from '../../../../src/lib/command.ts';
import { makeWorkspace, type TestWorkspace } from '../../../helpers/workspace.ts';
import { doneState, fakeAutomation, notOk, ok } from '../helpers.ts';

vi.mock('../../../../src/commands/instance/automation.ts', () => ({
  automationRequest: vi.fn(),
  restartClient: async (...args: Parameters<typeof import('../helpers.ts').fakeRestartClient>) => (await import('../helpers.ts')).fakeRestartClient(...args),
}));
vi.mock('../../../../src/commands/instance/api.ts', () => ({
  startInstance: vi.fn(),
  stopInstance: vi.fn(),
  listInstances: vi.fn(),
  instanceProcesses: vi.fn(),
  instanceServerLog: vi.fn(),
}));

const saved = { ...flashTiming };
flashTiming.readingMs = 5;
flashTiming.feedMs = 1;
afterAll(() => {
  Object.assign(flashTiming, saved);
});

type Rgb = [number, number, number];
const FPS = 24;
const SCENARIO = parseScenario(JSON.stringify({
  steps: [{ kind: 'input', command: 'tap', args: ['1', '1'], timeoutMs: 2000 }],
  goal: { path: 'telemetry.goal_intervals', op: 'count_gte', value: 1 },
})) as Scenario;

/** The screens of the check: `tablet` shows the 200 × 150 game area at 1 CSS px per game pixel, `phone` at half that. */
const SCREENS: MeasuredScreen[] = [
  { name: 'phone', window: [400, 300], fillMode: 'Letterbox', notch: [0, 0, 0, 0], pixelRatio: 4 },
  { name: 'tablet', window: [400, 300], fillMode: 'Crop', notch: [0, 10, 0, 0], pixelRatio: 2 },
];

let ws: TestWorkspace;
let evidenceRoot: string;
/** The images the fake movie maker writes, by frame number, for the size and fps it was started with; null: an unreadable file. */
let movie: (n: number, size: [number, number]) => Rgb | null;
let frames: number;
let state: Record<string, unknown>;
let calls: string[];

function ctx() {
  return createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
}

function options(extra: Partial<FlashOptions> = {}): FlashOptions {
  return { evidence: { root: evidenceRoot, dir: 'ev', relative: true }, slots: new Slots(1), pollMs: 1, screens: SCREENS, baseResolution: [200, 150], targetFps: FPS, scenario: SCENARIO, ...extra };
}

/** A square wave of `hz` at `FPS`: true in the first half of each period. */
function on(hz: number, n: number): boolean {
  return Math.floor(n / (FPS / (2 * hz))) % 2 === 0;
}

async function writeMovie(file: string, size: [number, number]): Promise<void> {
  for (let n = 0; n < frames; n++) {
    const color = movie(n, size);
    const path = join(dirname(file), `frame${String(n).padStart(8, '0')}.png`);
    if (color === null) {
      writeFileSync(path, 'not a PNG');
      continue;
    }
    const data = Buffer.alloc(size[0] * size[1] * 4);
    for (let p = 0; p < size[0] * size[1]; p++) data.set([...color, 255], p * 4);
    writeFileSync(path, await encodePng({ width: size[0], height: size[1], data }));
  }
}

beforeEach(() => {
  ws = makeWorkspace();
  evidenceRoot = mkdtempSync(join(tmpdir(), 'ogw-flash-'));
  frames = 2 * FPS;
  movie = (n) => (on(4, n) ? [255, 255, 255] : [0, 0, 0]);
  state = doneState({ scene_key: 'scene/play', frame_step_fps: FPS });
  calls = [];
  // the fake client: its movie maker has written every image when the instance has started
  vi.mocked(startInstance).mockReset().mockImplementation(async (_c, given: InstanceOptions) => {
    if (given.movie !== undefined) await writeMovie(given.movie.file, given.movie.resolution ?? [0, 0]);
    return { id: 'f1' } as Awaited<ReturnType<typeof startInstance>>;
  });
  vi.mocked(stopInstance).mockReset().mockResolvedValue();
  vi.mocked(listInstances).mockReset().mockResolvedValue([]);
  vi.mocked(instanceProcesses).mockReset().mockResolvedValue({ server: true, clients: [{ client: 'main', alive: true }] });
  vi.mocked(instanceServerLog).mockReset().mockResolvedValue('');
  vi.mocked(automationRequest).mockReset().mockImplementation(fakeAutomation((command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'get_state') return ok(state);
    if (command === 'get_telemetry') return ok({ goal_intervals: [{}] });
    if (command === 'extract_logs') return ok([]);
    return ok(null);
  }));
});

/** The folders of the recordings the check left in `ogw-temp/`. */
function recordings(): string[] {
  const temp = join(ws.harness, '.git', 'ogw-temp');
  return existsSync(temp) ? readdirSync(temp).filter((name) => name.startsWith('ogw-check-flash-')) : [];
}

describe('flash check recording', () => {
  it('records the screen whose game area is the largest in CSS px, at its CSS size and targetFps, with its window, fill mode and notch', async () => {
    expect(recordedScreen(SCREENS, [200, 150])?.name).toBe('tablet');
    // equal CSS game areas: the first
    expect(recordedScreen([SCREENS[0] as MeasuredScreen, { ...(SCREENS[0] as MeasuredScreen), name: 'same' }], [200, 150])?.name).toBe('phone');
    expect(recordedScreen([], [200, 150])).toBeNull();
    expect(cssSize({ name: 'p', window: [1179, 2556], fillMode: 'Crop', notch: [0, 0, 0, 0], pixelRatio: 3 })).toEqual([393, 852]);
    movie = () => [0, 0, 0];
    await flashCheck(ctx(), 'g', 'ios', options());
    const started = vi.mocked(startInstance).mock.calls[0]?.[1];
    expect(started).toMatchObject({
      game: 'g',
      platform: 'ios',
      client: 'window',
      movie: { resolution: [200, 150], fps: FPS },
      testScreen: { window: [400, 300], fillMode: 'Crop', notch: [0, 10, 0, 0] },
    });
    expect(started?.movie?.file).toMatch(/\/ogw-check-flash-[^/]+\/frame\.png$/);
    expect(stopInstance).toHaveBeenCalledWith(expect.anything(), 'f1');
  });

  it('fails a 4 Hz full-screen flash with a failure at its scene, the image of its first frame and its mask, and removes the recording', async () => {
    const part = await flashCheck(ctx(), 'g', 'ios', options());
    expect(part.unknown).toBe(false);
    expect(part.failures).toHaveLength(1);
    const [found] = part.failures;
    expect(found?.where).toBe('scene/play');
    // the 7th transition comes at frame 21, 18 frames after the 1st at frame 3; the last at frame 45
    expect(found?.message).toBe('flash general: more than 3 flashes in one second over 30000 CSS px² of a 341x256 CSS px field, frames 3-45 in scene/play (tablet)');
    expect(found?.evidence).toEqual(['ev/flash-ios/frame-00000003.png', 'ev/flash-ios/frame-00000003-general.png']);
    const image = await decodeRgba(join(evidenceRoot, 'ev/flash-ios/frame-00000003.png'), 'image');
    expect([image.width, image.height, image.data[0]]).toEqual([200, 150, 0]);
    const mask = await decodeRgba(join(evidenceRoot, 'ev/flash-ios/frame-00000003-general.png'), 'mask');
    expect(mask.data[0]).toBe(255);
    // the scenario ran on the recording client
    expect(calls).toContain('tap 1 1');
    expect(recordings()).toEqual([]);
  });

  it('puts a flash at the scenario when its reading names no scene', async () => {
    state = doneState({ scene_key: '', frame_step_fps: FPS });
    const [found] = (await flashCheck(ctx(), 'g', 'ios', options())).failures;
    expect(found?.where).toBe('client/dev/bot/scenario.json:1');
    expect(found?.message).toMatch(/, frames 3-45 in no scene \(tablet\)$/);
  });

  it('passes a 2 Hz flash and a still screen', async () => {
    movie = (n) => (on(2, n) ? [255, 255, 255] : [0, 0, 0]);
    expect(await flashCheck(ctx(), 'g', 'ios', options())).toEqual({ failures: [], unknown: false });
    movie = () => [30, 60, 90];
    expect(await flashCheck(ctx(), 'g', 'web', options())).toEqual({ failures: [], unknown: false });
    expect(recordings()).toEqual([]);
  });

  it('fails a 4 Hz red flash between a saturated red and a gray of the same luminance', async () => {
    movie = (n) => (on(4, n) ? [180, 0, 0] : [88, 88, 88]);
    const part = await flashCheck(ctx(), 'g', 'ios', options());
    expect(part.failures.map((f) => f.message)).toEqual(['flash red: more than 3 flashes in one second over 30000 CSS px² of a 341x256 CSS px field, frames 3-45 in scene/play (tablet)']);
  });

  it('measures the area in CSS px of the recorded screen when the engine kept the window smaller', async () => {
    // the engine kept the 200 x 150 window at 100 x 75: each image pixel is 2 x 2 CSS px
    vi.mocked(startInstance).mockImplementation(async (_c, given: InstanceOptions) => {
      if (given.movie !== undefined) await writeMovie(given.movie.file, [100, 75]);
      return { id: 'f1' } as Awaited<ReturnType<typeof startInstance>>;
    });
    const part = await flashCheck(ctx(), 'g', 'ios', options());
    expect(part.failures.map((f) => f.message)).toEqual(['flash general: more than 3 flashes in one second over 30000 CSS px² of a 341x256 CSS px field, frames 3-45 in scene/play (tablet)']);
  });

  it('is unknown and runs no scenario when the client clock does not follow the movie maker frame step', async () => {
    state = doneState({ scene_key: 'scene/play' });
    const missing = await flashCheck(ctx(), 'g', 'ios', options());
    expect(missing).toEqual({
      unknown: true,
      failures: [{ where: 'client/dev/bot/scenario.json:1', message: `flash: get_state frame_step_fps is missing, not targetFps ${String(FPS)}: the client clock does not follow the movie maker frame step`, evidence: [] }],
    });
    state = doneState({ scene_key: 'scene/play', frame_step_fps: 60 });
    expect((await flashCheck(ctx(), 'g', 'ios', options())).failures[0]?.message).toBe(`flash: get_state frame_step_fps is 60, not targetFps ${String(FPS)}: the client clock does not follow the movie maker frame step`);
    expect(calls).not.toContain('tap 1 1');
    expect(stopInstance).toHaveBeenCalledTimes(2);
    expect(recordings()).toEqual([]);
  });

  it('is unknown when the scenario stopped, unless the frames it recorded fail', async () => {
    vi.mocked(automationRequest).mockImplementation(fakeAutomation((command) => {
      if (command === 'get_state') return ok(state);
      if (command === 'extract_logs') return ok([]);
      return command === 'tap' ? notOk('no such button') : ok(null);
    }));
    movie = () => [0, 0, 0];
    expect(await flashCheck(ctx(), 'g', 'ios', options())).toEqual({
      unknown: true,
      failures: [{ where: 'step 1', message: 'flash: scenario stopped: tap returned ok false: "no such button"', evidence: [] }],
    });
    movie = (n) => (on(4, n) ? [255, 255, 255] : [0, 0, 0]);
    const part = await flashCheck(ctx(), 'g', 'ios', options());
    expect(part.unknown).toBe(false);
    expect(part.failures[0]?.message).toMatch(/^flash general: /);
  });

  it('leaves out an unreadable last image, is unknown with an unreadable earlier one, and is unknown when no image was written', async () => {
    movie = (n) => (n === frames - 1 ? null : [0, 0, 0]);
    expect(await flashCheck(ctx(), 'g', 'ios', options())).toEqual({ failures: [], unknown: false });
    movie = (n) => (n === 5 ? null : [0, 0, 0]);
    const broken = await flashCheck(ctx(), 'g', 'ios', options());
    expect(broken.unknown).toBe(true);
    expect(broken.failures[0]?.message).toMatch(/^flash did not run: frame00000005\.png: cannot read image/);
    // an image of another size than the first
    movie = () => [0, 0, 0];
    vi.mocked(startInstance).mockImplementationOnce(async (_c, given: InstanceOptions) => {
      const file = given.movie?.file ?? '';
      frames = 10;
      await writeMovie(file, [200, 150]);
      writeFileSync(join(dirname(file), 'frame00000010.png'), await encodePng({ width: 100, height: 75, data: Buffer.alloc(100 * 75 * 4) }));
      writeFileSync(join(dirname(file), 'frame00000011.png'), await encodePng({ width: 100, height: 75, data: Buffer.alloc(100 * 75 * 4) }));
      return { id: 'f1' } as Awaited<ReturnType<typeof startInstance>>;
    });
    const resized = await flashCheck(ctx(), 'g', 'ios', options());
    expect(resized.unknown).toBe(true);
    expect(resized.failures[0]?.message).toBe('flash did not run: a frame of 30000 bytes, not 200x150 RGBA');
    frames = 0;
    expect(await flashCheck(ctx(), 'g', 'ios', options())).toEqual({
      unknown: true,
      failures: [{ where: 'client/dev/bot/scenario.json:1', message: 'flash: the movie maker wrote no image', evidence: [] }],
    });
    expect(recordings()).toEqual([]);
  });

  it('is unknown without a recorded screen or a scenario, and starts no instance', async () => {
    expect(await flashCheck(ctx(), 'g', 'ios', options({ screens: [] }))).toEqual({
      unknown: true,
      failures: [{ where: 'settings.json:1', message: 'flash: no uiCheckScreens item of the orientation of baseResolution', evidence: [] }],
    });
    expect((await flashCheck(ctx(), 'g', 'ios', options({ scenario: 'client/dev/bot/scenario.json does not exist' }))).failures).toEqual([
      { where: 'client/dev/bot/scenario.json:1', message: 'flash: client/dev/bot/scenario.json does not exist', evidence: [] },
    ]);
    expect(startInstance).not.toHaveBeenCalled();
  });

  it('gives a frame the scene of the first reading after its image was written, or of the last reading', () => {
    const readings = [{ written: 0, scene: 'title' }, { written: 10, scene: 'lobby' }, { written: 30, scene: 'play' }];
    expect([sceneOf(readings, 0), sceneOf(readings, 9), sceneOf(readings, 10), sceneOf(readings, 29), sceneOf(readings, 30)]).toEqual(['lobby', 'lobby', 'play', 'play', 'play']);
    expect(sceneOf([], 3)).toBeNull();
  });
});
