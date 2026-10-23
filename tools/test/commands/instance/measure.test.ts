import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STANDARD_JOBS } from '../../../src/commands/generation/lib/standard.ts';
import { firstCount, measureHost, nextCount } from '../../../src/commands/instance/measure.ts';
import { ogw, makeGame, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';

interface State {
  versions: string[];
  releases: Record<string, string>;
  running: Set<string>;
  started: Record<string, unknown>[];
  calls: string[];
  next: number;
  crashAt: number | null;
  startFailAt: number | null;
  statsFailAt: number | null;
  seenRoots: string[];
  starting: number;
  maxStarting: number;
}

const state = vi.hoisted(
  (): State => ({
    versions: [],
    releases: {},
    running: new Set<string>(),
    started: [],
    calls: [],
    next: 0,
    crashAt: null,
    startFailAt: null,
    statsFailAt: null,
    seenRoots: [],
    starting: 0,
    maxStarting: 0,
  }),
);

vi.mock('../../../src/commands/core/api.ts', () => ({
  remoteReleaseVersions: () => Promise.resolve(state.versions),
  coreRelease: (_ctx: unknown, version: string) => Promise.resolve({ version, dir: state.releases[version], local: false }),
}));

vi.mock('../../../src/commands/instance/api.ts', () => ({
  startInstance: (_ctx: unknown, options: Record<string, unknown>) => {
    if (state.startFailAt !== null && state.running.size + 1 >= state.startFailAt) return Promise.reject(new Error('no free port'));
    state.next++;
    const id = `i${String(state.next)}`;
    state.running.add(id);
    state.started.push(options);
    if (typeof options.root === 'string') state.seenRoots.push(options.root);
    // a start ends a tick later: starts of one count that overlap were started together
    state.starting++;
    state.maxStarting = Math.max(state.maxStarting, state.starting);
    return new Promise((resolve) => setTimeout(() => {
      state.starting--;
      resolve({ id, game: options.game });
    }, 0));
  },
  stopInstance: (_ctx: unknown, id: string) => {
    state.running.delete(id);
    return Promise.resolve();
  },
  instanceProcesses: (_ctx: unknown, id: string) => Promise.resolve({ server: true, clients: [{ client: 'main', alive: state.running.has(id) }] }),
  instanceServerLog: () => Promise.resolve(''),
}));

vi.mock('../../../src/commands/instance/automation.ts', () => ({
  automationRequest: (_ctx: unknown, id: string, command: string, args: string[]) => {
    state.calls.push(`${id} ${command} ${args.join(' ')}`.trim());
    if (state.crashAt !== null && state.running.size >= state.crashAt) return Promise.reject(new Error('automation channel closed'));
    if (command === 'get_stats' && state.statsFailAt !== null && state.running.size >= state.statsFailAt) return Promise.reject(new Error('client ended'));
    const results: Record<string, unknown> = {
      get_state: { boot_stage: 'Done', scene_key: 'battle', score: 3 },
      get_telemetry: { goal_intervals: [{}] },
      get_stats: { fps: 120 / state.running.size },
      'battle.bot_next_input': { command: 'tap', args: ['enemy'] },
    };
    return Promise.resolve({ ok: true, result: results[command] ?? null, bytes: Buffer.alloc(0), frames: [] });
  },
  restartClient: (_ctx: unknown, id: string, _client: unknown, options: { command?: string; args?: string[] } = {}) => {
    state.calls.push(`${id} ${options.command ?? 'restart'} ${(options.args ?? []).join(' ')}`.trim());
    if (state.crashAt !== null && state.running.size >= state.crashAt) return Promise.reject(new Error('automation channel closed'));
    return Promise.resolve({ boot_stage: 'Done', scene_key: 'battle', score: 3 });
  },
}));

const SCENARIO = {
  steps: [
    { kind: 'input', command: 'tap', args: ['start'], until: { path: 'state.boot_stage', op: 'eq', value: 'Done' }, timeoutMs: 1000 },
    { kind: 'auto', command: 'battle.bot_next_input', until: { path: 'telemetry.goal_intervals', op: 'count_gte', value: 1 }, timeoutMs: 1000 },
    { kind: 'save', timeoutMs: 1000 },
    { kind: 'setup', command: 'restart', timeoutMs: 1000 },
  ],
  goal: { path: 'telemetry.goal_intervals', op: 'count_gte', value: 1 },
};

function benchmarkZip(ws: TestWorkspace, version: string): void {
  const src = join(ws.root, `bench-${version}`);
  mkdirSync(join(src, 'client', 'dev', 'bot'), { recursive: true });
  writeFileSync(join(src, 'client', 'dev', 'bot', 'scenario.json'), JSON.stringify(SCENARIO));
  const dir = join(ws.root, 'releases', version);
  mkdirSync(dir, { recursive: true });
  sh(src, 'zip', ['-qr', join(dir, 'benchmark-godot.zip'), '.']);
  state.releases[version] = dir;
}

function setup(): { ws: TestWorkspace; env: NodeJS.ProcessEnv } {
  const ws = makeWorkspace();
  state.versions = ['1.0.0', '1.2.0', '1.1.0'];
  state.releases = {};
  benchmarkZip(ws, '1.0.0');
  benchmarkZip(ws, '1.1.0');
  state.releases['1.2.0'] = join(ws.root, 'releases', '1.2.0');
  mkdirSync(state.releases['1.2.0'], { recursive: true });
  writeFileSync(join(state.releases['1.2.0'], 'server.tgz'), '');
  makeGame(ws, 'g', { 'settings.json': { targetFps: 30 }, 'client/dev/bot/scenario.json': SCENARIO });
  makeGame(ws, 'h', { 'settings.json': {} });
  return { ws, env: { ...ws.env, TMPDIR: join(ws.root, 'tmp') } };
}

// the first count of a host with no measured value is half its CPU count: 2 here
measureHost.cpus = () => 4;

afterEach(() => {
  state.running.clear();
  state.started = [];
  state.calls = [];
  state.next = 0;
  state.crashAt = null;
  state.startFailAt = null;
  state.statsFailAt = null;
  state.seenRoots = [];
  state.starting = 0;
  state.maxStarting = 0;
});

describe('ogw instance measure', () => {
  it('picks the next count: after the last value, doubling, halving, then the middle', () => {
    expect(firstCount(null, 12)).toBe(6);
    expect(firstCount(null, 18)).toBe(8);
    expect(firstCount(null, 1)).toBe(1);
    expect(firstCount(5, 18)).toBe(5);
    expect(firstCount(40, 18)).toBe(8);
    // no broken count yet: the count after the last value, else doubled, up to the bound
    expect(nextCount(5, 9, 5)).toBe(6);
    expect(nextCount(6, 9, 5)).toBe(8);
    expect(nextCount(3, 9, null)).toBe(6);
    expect(nextCount(6, 9, null)).toBe(8);
    expect(nextCount(8, 9, null)).toBeNull();
    // no held count yet: halved; otherwise the middle, until held and broke are next to each other
    expect(nextCount(0, 8, null)).toBe(4);
    expect(nextCount(0, 2, null)).toBe(1);
    expect(nextCount(0, 1, null)).toBeNull();
    expect(nextCount(3, 8, null)).toBe(5);
    expect(nextCount(5, 6, null)).toBeNull();
  });

  it('starts the instances of a count together, from this host\'s last value, and checks the count after it', async () => {
    const { ws, env } = setup();
    state.versions = [];
    expect((await ogw(ws, ['settings', 'set', 'harness', 'maxConcurrentInstances', '3'])).code).toBe(0);
    const run = await ogw(ws, ['instance', 'measure', '--json'], { env });
    expect(JSON.parse(run.stdout)).toMatchObject({ targets: [{ name: 'g', kind: 'game', value: 4, detail: null }] });
    // 3 holds, 4 (the count after 3) holds, 8 breaks, 6 breaks, 5 breaks
    expect(state.started).toHaveLength(3 + 4 + 8 + 6 + 5);
    expect(state.maxStarting).toBe(8);
    expect(state.running.size).toBe(0);
  });

  it('raises the instance count per target until the fps condition breaks', async () => {
    const { ws, env } = setup();
    const run = await ogw(ws, ['instance', 'measure'], { env });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(`benchmark-godot 1.1.0: 2\ng: 4\nno generation load job\nresult: ${join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'instance-measure.json')}\n`);
    const result = JSON.parse(readFileSync(join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'instance-measure.json'), 'utf8')) as { targets: unknown[] };
    expect(result.targets).toEqual([
      { name: 'benchmark-godot 1.1.0', kind: 'benchmark', value: 2, detail: null },
      { name: 'g', kind: 'game', value: 4, detail: null },
    ]);
    // from half the CPU count: benchmark 2 holds, 4 and 3 break; game 2 and 4 hold, 8, 6 and 5 break
    expect(state.started).toHaveLength(2 + 4 + 3 + (2 + 4 + 8 + 6 + 5));
    expect(state.started[0]).toMatchObject({ game: 'benchmark-godot', client: 'window', coreVersion: '1.1.0' });
    expect(state.started[9]).toEqual({ game: 'g', client: 'window', ignoreConcurrencyLimit: true });
    expect(state.running.size).toBe(0);
    expect(state.seenRoots.length).toBeGreaterThan(0);
    for (const root of state.seenRoots) expect(existsSync(root)).toBe(false);
    expect(state.calls).toContain('i1 tap start');
    expect(state.calls).toContain('i1 battle.bot_next_input');
    expect(state.calls).toContain('i1 restart');
    expect(state.calls).toContain('i1 get_telemetry');
  });

  it('records 0 when a process ends at the first instance', async () => {
    const { ws, env } = setup();
    state.versions = [];
    state.crashAt = 1;
    const run = await ogw(ws, ['instance', 'measure', '--json'], { env });
    expect(JSON.parse(run.stdout)).toMatchObject({ targets: [{ name: 'g', kind: 'game', value: 0, detail: null }] });
    expect(state.running.size).toBe(0);
  });

  it('is not bound by maxConcurrentInstances, and says why a count did not hold when an instance does not start', async () => {
    const { ws, env } = setup();
    state.versions = [];
    state.startFailAt = 3;
    const run = await ogw(ws, ['instance', 'measure', '--json'], { env });
    expect(JSON.parse(run.stdout)).toMatchObject({ targets: [{ name: 'g', kind: 'game', value: 2, detail: 'instance 3 of 3 did not start: no free port' }] });
    expect(state.started.every((options) => options.ignoreConcurrencyLimit === true)).toBe(true);
    expect(state.running.size).toBe(0);
  });

  it('keeps the reason of a count that did not start when a smaller count then breaks on fps', async () => {
    const { ws, env } = setup();
    state.versions = [];
    // game g holds 30 fps up to 4 instances; the 6th instance does not start
    state.startFailAt = 6;
    const run = await ogw(ws, ['instance', 'measure', '--json'], { env });
    // 2 and 4 hold, 8 and 6 do not start, 5 breaks on fps
    expect(JSON.parse(run.stdout)).toMatchObject({ targets: [{ name: 'g', kind: 'game', value: 4, detail: 'instance 6 of 6 did not start: no free port' }] });
    expect(state.running.size).toBe(0);
  });

  it('takes a failed fps sample as a count that did not hold, with its reason', async () => {
    const { ws, env } = setup();
    state.versions = [];
    state.statsFailAt = 3;
    const run = await ogw(ws, ['instance', 'measure', '--json'], { env });
    expect(run.code).toBe(0);
    const target = (JSON.parse(run.stdout) as { targets: { value: number; detail: string }[] }).targets[0];
    expect(target?.value).toBe(2);
    expect(target?.detail).toMatch(/^instance i\d+: the fps sample failed: client ended$/);
    expect(state.running.size).toBe(0);
  });

  it('fails without a result when the first instance does not start', async () => {
    const { ws, env } = setup();
    state.versions = [];
    state.startFailAt = 1;
    const run = await ogw(ws, ['instance', 'measure'], { env });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('g: the first instance did not start: no free port');
    expect(existsSync(join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'instance-measure.json'))).toBe(false);
  });

  it('records 0 with the reason when scenario.json does not have the defined form', async () => {
    const { ws, env } = setup();
    state.versions = [];
    writeFileSync(join(ws.games, 'g', 'client', 'dev', 'bot', 'scenario.json'), JSON.stringify({ steps: [] }));
    const run = await ogw(ws, ['instance', 'measure', '--json'], { env });
    expect(JSON.parse(run.stdout)).toMatchObject({ targets: [{ name: 'g', kind: 'game', value: 0, detail: 'scenario.json: scenario: no `goal`' }] });
    expect(state.started).toEqual([]);
  });

  it('says so when there is no target', async () => {
    const ws = makeWorkspace();
    state.versions = [];
    const env = { ...ws.env, TMPDIR: join(ws.root, 'tmp') };
    const run = await ogw(ws, ['instance', 'measure'], { env });
    expect(run.stdout).toBe(
      `not measured: no core release has benchmark-<engine>.zip and no game has client/dev/bot/scenario.json\nresult: ${join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'instance-measure.json')}\n`,
    );
    expect(JSON.parse(readFileSync(join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'instance-measure.json'), 'utf8'))).toMatchObject({ targets: [] });
  });

  it.runIf(process.platform === 'darwin')('runs the heaviest ok local-model standard test job while it measures', async () => {
    const { ws, env } = setup();
    state.versions = [];
    const saved = STANDARD_JOBS.heavy;
    STANDARD_JOBS.heavy = { stages: [{ resolution: 8 }], prompt: '', image: false, call: (input) => Promise.resolve({ cmd: '/bin/sh', args: ['-c', 'echo $1 > "$2/r"', 'sh', String(input.stage?.resolution), input.out] }) };
    try {
      const settings = JSON.parse(readFileSync(join(ws.harness, 'settings.json'), 'utf8')) as Record<string, unknown>;
      settings.resourceGeneration = [
        { name: 'light', kind: 'local-model', resourceTypes: ['sfx'], safetyTimeoutMs: 5000, license: 'X', pins: [] },
        { name: 'heavy', kind: 'local-model', resourceTypes: ['image'], safetyTimeoutMs: 5000, license: 'X', pins: [] },
      ];
      writeFileSync(join(ws.harness, 'settings.json'), JSON.stringify(settings));
      expect((await ogw(ws, ['generation', 'install', 'heavy'], { env })).code).toBe(0);
      mkdirSync(join(ws.harness, '.git', 'ogw-temp', 'ogw-env'), { recursive: true });
      const step = (memory: number | null, result = 'ok') => ({ resolution: 8, jobMs: 1, result, maxMemoryBytes: memory, output: null, blocked: [] });
      writeFileSync(
        join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'generation-measure.json'),
        JSON.stringify({ measuredAt: 1, methods: { light: { kind: 'local-model', error: null, steps: [step(10), step(999, 'failed')] }, heavy: { kind: 'local-model', error: null, steps: [step(null), step(50)] } } }),
      );
      const run = await ogw(ws, ['instance', 'measure'], { env });
      expect(run.stdout).toContain('generation load job: heavy\n');
      expect(readFileSync(join(ws.root, '.ogw', 'generation', 'heavy', 'measure', '8', 'out', 'r'), 'utf8')).toBe('8\n');
      // a load job run that fails ends the measure without a result
      STANDARD_JOBS.heavy = { ...STANDARD_JOBS.heavy, call: () => Promise.resolve({ cmd: '/bin/sh', args: ['-c', 'echo out of memory >&2; exit 1'] }) };
      rmSync(join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'instance-measure.json'));
      const failed = await ogw(ws, ['instance', 'measure'], { env });
      expect(failed.code).not.toBe(0);
      expect(failed.stderr).toContain('the generation load job failed while measuring: heavy failed');
      expect(existsSync(join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'instance-measure.json'))).toBe(false);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(STANDARD_JOBS, 'heavy');
      else STANDARD_JOBS.heavy = saved;
    }
  });
});

