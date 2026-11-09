import { constants, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientCheckTiming, measureGate, withCheckWorkspaces, type ClientCheckInput } from '../../../../src/commands/build/lib/client-check.ts';
import { godotCheckExport, godotCheckPrepare } from '../../../../src/commands/build/lib/godot.ts';
import { webSmoke } from '../../../../src/commands/build/lib/web-smoke.ts';
import { coreReleaseOfGame, extractedAsset } from '../../../../src/commands/core/api.ts';
import { runData } from '../../../../src/commands/data/api.ts';
import { requireEngine, toolProgram } from '../../../../src/commands/env/api.ts';
import { gameModules } from '../../../../src/commands/generate/api.ts';
import { startInstance, stopInstance, type InstanceInfo } from '../../../../src/commands/instance/api.ts';
import { automationRequest } from '../../../../src/commands/instance/automation.ts';
import { ClientChannel } from '../../../../src/commands/instance/lib/channel.ts';
import { createContext } from '../../../../src/lib/command.ts';
import { makeWorkspace, type TestWorkspace } from '../../../helpers/workspace.ts';
import { commit, fakeBin, gameRepo, gameSettings, setupGame, write } from '../helpers.ts';

vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return { ...real, cp: vi.fn(real.cp) };
});
vi.mock('../../../../src/commands/core/api.ts', async (orig) => ({ ...(await orig<object>()), coreReleaseOfGame: vi.fn(), extractedAsset: vi.fn() }));
vi.mock('../../../../src/commands/env/api.ts', async (orig) => ({ ...(await orig<object>()), requireEngine: vi.fn(), toolProgram: vi.fn() }));
vi.mock('../../../../src/commands/data/api.ts', async (orig) => ({ ...(await orig<object>()), runData: vi.fn() }));
vi.mock('../../../../src/commands/generate/api.ts', async (orig) => ({ ...(await orig<object>()), gameModules: vi.fn() }));
vi.mock('../../../../src/commands/build/lib/godot.ts', async (orig) => {
  const real = await orig<typeof import('../../../../src/commands/build/lib/godot.ts')>();
  return { ...real, godotCheckExport: vi.fn(real.godotCheckExport), godotCheckPrepare: vi.fn(real.godotCheckPrepare) };
});
vi.mock('../../../../src/commands/instance/api.ts', () => ({
  startInstance: vi.fn(),
  stopInstance: vi.fn(),
  instanceProcesses: vi.fn(() => Promise.resolve({ server: true, clients: [] })),
  instanceServerLog: vi.fn(() => Promise.resolve('{"level":"info","message":"up"}\n')),
}));
vi.mock('../../../../src/commands/instance/lib/records.ts', async (orig) => ({
  ...(await orig<object>()),
  // the instance record of the fake check instance: a checkout without client/generated/core_settings.json (no input gap)
  readRecord: vi.fn((id: string) => Promise.resolve({ id, root: '/nonexistent/ogw-check-instance' })),
}));
vi.mock('../../../../src/commands/instance/automation.ts', () => ({
  automationRequest: vi.fn(),
  restartClient: async (...args: Parameters<typeof import('../../check/helpers.ts').fakeRestartClient>) => (await import('../../check/helpers.ts')).fakeRestartClient(...args),
}));

const fakes = join(dirname(fileURLToPath(import.meta.url)), '..', 'fakes');
const GOAL = { path: 'telemetry.goal_intervals', op: 'count_gte', value: 1 };
const SCENARIO = { steps: [{ kind: 'auto', command: 'f.bot_next_input', args: [], until: GOAL, timeoutMs: 3000 }], goal: GOAL };
/** Fake Godot: the web check export writes a page; the import leaves a marker in `.godot/`. */
const GODOT = `case "$*" in
  *--export-*) for last; do :; done; printf '<html>' > "$last"; printf 'const CACHE_VERSION = "v1";\\n' > "$(dirname "$last")/index.service.worker.js";;
  *--import*) mkdir -p "$3/.godot" && touch -t 202001010000 "$3/.godot/imported-once";;
esac`;
const TAP = { ok: true, result: { command: 'tap', args: ['1', '2'] } };

/** One channel per instance. */
const channels = new Map<string, ClientChannel>();
let started = 0;
const saved = { poll: clientCheckTiming.pollMs };
interface Setup {
  ws: TestWorkspace;
  dir: string;
  input: ClientCheckInput;
  bin: string;
  config: (value: Record<string, unknown>) => void;
  requests: () => string[];
}

async function setup(harness: Record<string, unknown> = {}): Promise<Setup> {
  const ws = makeWorkspace({ webSmokeCpuThrottleRate: 4, ...harness });
  const settings = { ...gameSettings(), buildPlatforms: ['web'], targetFps: 60 };
  const dir = setupGame(ws, 'g', settings, { 'client/dev/bot/scenario.json': SCENARIO, 'client/project.godot': '[application]\n\nconfig/name="G"\n', 'resource/app_icon/main.png': 'png', 'client/core/web/service-worker.js': 'const CACHE_VERSION = "___GODOT_VERSION___";\n' });
  commit(dir, 'client');
  const bin = fakeBin(ws, { godot: GODOT, ffmpeg: 'for last; do :; done; printf png > "$last"' });
  const config = join(bin.bin, 'client-config.json');
  writeFileSync(config, '{}');
  const env = { ...ws.env, ...bin.env, FAKE_DIR: bin.bin, FAKE_LOG_DIR: bin.bin, FAKE_GODOT_CONFIG: config };
  const ctx = createContext({ cwd: ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
  vi.mocked(requireEngine).mockResolvedValue(join(bin.bin, 'godot'));
  vi.mocked(toolProgram).mockImplementation((_c, tool) => Promise.resolve(tool === 'chromium' ? join(bin.bin, 'chromium') : join(bin.bin, 'ffmpeg')));
  writeFileSync(join(bin.bin, 'chromium'), `#!/bin/sh\nexec "${process.execPath}" "${join(fakes, 'fake-chromium.ts')}" "$@"\n`, { mode: 0o755 });
  const release = join(ws.root, 'release');
  write(release, 'engine.json', { godot: '4.5.1.stable' });
  vi.mocked(coreReleaseOfGame).mockResolvedValue({ version: '1.0.0', dir: release, local: false });
  vi.mocked(extractedAsset).mockResolvedValue(release);
  const game = await gameRepo(ws);
  return {
    ws,
    dir,
    input: { ctx, game, env: 'STG', version: '0.2.0', exportVersion: '0.2.0', settings, platforms: ['web'] },
    bin: bin.bin,
    config: (value) => {
      writeFileSync(config, JSON.stringify(value));
    },
    requests: () =>
      existsSync(join(bin.bin, 'main.jsonl'))
        ? readFileSync(join(bin.bin, 'main.jsonl'), 'utf8').trim().split('\n').map((l) => {
          const r = JSON.parse(l) as { command: string; args: string[] };
          return [r.command, ...r.args].join(' ');
        })
        : [],
  };
}

beforeEach(() => {
  clientCheckTiming.pollMs = 5;
  channels.clear();
  started = 0;
  // back to the real export and preparation that `vi.fn` wraps
  vi.mocked(godotCheckExport).mockReset();
  vi.mocked(godotCheckPrepare).mockReset();
  vi.mocked(runData).mockResolvedValue({ exitCode: 0, lines: [], stderr: '' });
  vi.mocked(gameModules).mockResolvedValue({ client: [], server: [] });
  vi.mocked(startInstance).mockReset();
  vi.mocked(startInstance).mockImplementation(async (_ctx, options) => {
    started += 1;
    const id = `i${String(started)}`;
    const channel = new ClientChannel('main');
    await channel.listen();
    channels.set(id, channel);
    const info: InstanceInfo = {
      id, game: 'g', root: '', commit: '', platform: options.platform ?? '', serverUrl: 'http://127.0.0.1:4321', adminSecret: 'a', startedAt: 0, fixture: false, clients: [], exited: {}, serverLog: '',
      external: { automationPort: channel.port, automationToken: channel.token, devAccess: 'DEV-ACCESS', devAccount: 'main', ...(options.randomBase === undefined ? {} : { randomBase: String(options.randomBase) }) },
    };
    return info;
  });
  vi.mocked(stopInstance).mockReset();
  vi.mocked(stopInstance).mockImplementation(async (_ctx, id) => {
    await channels.get(id)?.close();
  });
  vi.mocked(automationRequest).mockImplementation(async (_ctx, id, command, args, _client, options) => {
    const channel = channels.get(id);
    if (channel === undefined) throw new Error(`no instance ${id}`);
    return { ...(await channel.request(command, args, options?.timeoutMs ?? 3000)), framePaths: [] };
  });
});

afterEach(async () => {
  clientCheckTiming.pollMs = saved.poll;
  for (const channel of channels.values()) await channel.close();
});

describe('web smoke', () => {
  it('ends only when the web check export it started has ended, also when its check instance does not start, so that the measure gate opens after the export', async () => {
    const s = await setup();
    const real = await vi.importActual<typeof import('../../../../src/commands/build/lib/godot.ts')>('../../../../src/commands/build/lib/godot.ts');
    const events: string[] = [];
    vi.mocked(startInstance).mockImplementation(() => {
      events.push('instance start failed');
      return Promise.reject(new Error('no instance slot'));
    });
    vi.mocked(godotCheckExport).mockImplementation(async (...args) => {
      events.push('export start');
      await new Promise((resolve) => setTimeout(resolve, 400));
      const file = await real.godotCheckExport(...args);
      events.push('export end');
      return file;
    });
    // the check workspaces of a build run, which outlive web smoke: their close does not wait for its export
    await withCheckWorkspaces(s.input, async (workspaces) => {
      const gate = measureGate();
      const web = webSmoke({ ...s.input, workspaces }, gate.gate).then((result) => {
        events.push('web smoke ended');
        return result;
      });
      // `ogw build run` lets the measured runs start once the export of web smoke is made or web smoke has ended
      await gate.exportedOr(web);
      events.push('gate may open');
      expect((await web)?.check).toEqual({ name: 'web smoke', result: 'unknown', details: ['web smoke did not run: no instance slot'] });
    });
    expect(events).toEqual(['instance start failed', 'export start', 'export end', 'web smoke ended', 'gate may open']);
  });

  it('starts its check instance and the web check export together, and opens the page when both are ready', async () => {
    const s = await setup();
    s.config({ clients: { main: { results: { 'f.bot_next_input': TAP } } }, telemetry: { goal_intervals: [{}] } });
    const real = await vi.importActual<typeof import('../../../../src/commands/build/lib/godot.ts')>('../../../../src/commands/build/lib/godot.ts');
    const instanceStart = vi.mocked(startInstance).getMockImplementation() as typeof startInstance;
    const request = vi.mocked(automationRequest).getMockImplementation() as typeof automationRequest;
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    /** The order of the events of one web smoke whose instance start and export last the given ms. */
    const run = async (instanceMs: number, exportMs: number): Promise<string[]> => {
      const events: string[] = [];
      vi.mocked(startInstance).mockImplementation(async (...args) => {
        events.push('instance start');
        await delay(instanceMs);
        const info = await instanceStart(...args);
        events.push('instance ready');
        return info;
      });
      vi.mocked(godotCheckExport).mockImplementation(async (...args) => {
        events.push('export start');
        await delay(exportMs);
        const file = await real.godotCheckExport(...args);
        events.push('export end');
        return file;
      });
      // the first request to the client is the boot wait after the page opened
      vi.mocked(automationRequest).mockImplementation(async (...args) => {
        if (!events.includes('first request')) events.push('first request');
        return request(...args);
      });
      expect((await webSmoke(s.input))?.check.result).toBe('pass');
      return events;
    };
    // a slow instance start: the export starts before the instance is ready
    const slowInstance = await run(400, 0);
    expect(slowInstance.indexOf('export start')).toBeGreaterThanOrEqual(0);
    expect(slowInstance.indexOf('export start')).toBeLessThan(slowInstance.indexOf('instance ready'));
    // a slow export: the instance is ready before the export ends
    const slowExport = await run(0, 400);
    expect(slowExport.indexOf('instance ready')).toBeLessThan(slowExport.indexOf('export end'));
    // the page opens when both are ready
    for (const events of [slowInstance, slowExport]) expect(events.indexOf('first request')).toBeGreaterThan(Math.max(events.indexOf('instance ready'), events.indexOf('export end')));
  });

  it('prepares, imports and copies the web check workspace before its check instance starts, and exports the copy beside it with the times of the imported files', async () => {
    const s = await setup();
    s.config({ clients: { main: { results: { 'f.bot_next_input': TAP } } }, telemetry: { goal_intervals: [{}] } });
    const real = await vi.importActual<typeof import('../../../../src/commands/build/lib/godot.ts')>('../../../../src/commands/build/lib/godot.ts');
    const events: string[] = [];
    vi.mocked(godotCheckPrepare).mockImplementation(async (...args) => {
      events.push('prepare start');
      const prepared = await real.godotCheckPrepare(...args);
      events.push('prepare end');
      return prepared;
    });
    const instanceStart = vi.mocked(startInstance).getMockImplementation();
    vi.mocked(startInstance).mockImplementation(async (...args) => {
      events.push('instance start');
      return (instanceStart as typeof startInstance)(...args);
    });
    const realCp = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).cp;
    vi.mocked(cp).mockClear();
    vi.mocked(cp).mockImplementation(async (...args) => {
      if (String(args[1]).includes('/.ogw-copy/')) events.push('copy');
      return realCp(...args);
    });
    vi.mocked(godotCheckExport).mockImplementation(async (...args) => {
      events.push('export start');
      // the copy holds the imported workspace with the times of its files, so that the engine imports nothing again
      const marker = 'client/.godot/imported-once';
      expect(statSync(join(args[3], marker)).mtimeMs).toBe(new Date(2020, 0, 1).getTime());
      expect(statSync(join(args[3], marker)).mtimeMs).toBe(statSync(join(args[3], '..', '..', marker)).mtimeMs);
      return real.godotCheckExport(...args);
    });
    try {
      expect((await webSmoke(s.input))?.check).toEqual({ name: 'web smoke', result: 'pass', details: [] });
    } finally {
      vi.mocked(cp).mockImplementation(realCp);
    }
    expect(vi.mocked(godotCheckPrepare)).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(s.bin, 'calls.log'), 'utf8').match(/--import/g)).toHaveLength(1);
    expect(vi.mocked(godotCheckExport)).toHaveBeenCalledTimes(1);
    expect(events.slice(0, 2)).toEqual(['prepare start', 'prepare end']);
    expect(events.indexOf('instance start')).toBeGreaterThan(events.lastIndexOf('copy'));
    // the copy holds client/ and resource/, cloned where the file system clones, with the file times and the links as they are
    const copied = vi.mocked(cp).mock.calls.filter((c) => String(c[1]).includes('/.ogw-copy/'));
    expect(copied.map((c) => String(c[1]).split('/').slice(-2).join('/')).sort()).toEqual(['web/client', 'web/resource']);
    for (const call of copied) expect(call[2]).toEqual({ recursive: true, mode: constants.COPYFILE_FICLONE, preserveTimestamps: true, verbatimSymlinks: true });
    expect(readdirSync(join(s.ws.worktrees, 'g'))).toEqual([]);
  });

  it('deletes the web check export and its copy when it ends, before the check workspaces of the build run close', async () => {
    const s = await setup();
    s.config({ clients: { main: { results: { 'f.bot_next_input': TAP } } }, telemetry: { goal_intervals: [{}] } });
    const real = await vi.importActual<typeof import('../../../../src/commands/build/lib/godot.ts')>('../../../../src/commands/build/lib/godot.ts');
    const made: { copy: string; file: string }[] = [];
    vi.mocked(godotCheckExport).mockImplementation(async (...args) => {
      const file = await real.godotCheckExport(...args);
      made.push({ copy: args[3], file });
      return file;
    });
    await withCheckWorkspaces(s.input, async (workspaces) => {
      expect((await webSmoke({ ...s.input, workspaces }))?.check.result).toBe('pass');
      expect(made).toHaveLength(1);
      expect(made[0]?.file.split('/').slice(-3).join('/')).toBe('.ogw-check/web/index.html');
      expect(existsSync(made[0]?.file ?? '')).toBe(false);
      expect(existsSync(made[0]?.copy ?? '')).toBe(false);
      // the check workspace stays for the other client checks of the build run
      expect(readdirSync(join(s.ws.worktrees, 'g'))).toHaveLength(1);
    });
    expect(readdirSync(join(s.ws.worktrees, 'g'))).toEqual([]);
  });
});
