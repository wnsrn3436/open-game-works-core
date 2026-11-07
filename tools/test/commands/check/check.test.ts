import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { check, coreTryChecks, timing } from '../../../src/commands/check/check.ts';
import { botPlaytest } from '../../../src/commands/check/lib/bot-playtest.ts';
import { instanceProcesses, instanceServerLog } from '../../../src/commands/check/lib/instance-probe.ts';
import { fpsSampling } from '../../../src/commands/check/lib/performance.ts';
import { staticCheck } from '../../../src/commands/check/static-api.ts';
import { coreReleaseOfGame, extractedAsset } from '../../../src/commands/core/api.ts';
import { runData } from '../../../src/commands/data/api.ts';
import { requireEngine } from '../../../src/commands/env/api.ts';
import { gameModules, installEnginePackages, mergedCoreSettings } from '../../../src/commands/generate/api.ts';
import { listInstances, startInstance, stopInstance, type InstanceOptions } from '../../../src/commands/instance/api.ts';
import { encodePng } from '../../../src/commands/resource/lib/image.ts';
import { automationRequest } from '../../../src/commands/instance/automation.ts';
import { createContext } from '../../../src/lib/command.ts';
import { resolveGame } from '../../../src/lib/game.ts';
import { git, head } from '../../../src/lib/git.ts';
import { changeRuns, newRunState } from '../../../src/lib/runstate.ts';
import { workspaceFrom, loadHarnessSettings } from '../../../src/lib/settings.ts';
import { commitAll, ogw, makeGame, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeAgentJob } from '../instance/agents.ts';
import { doneState, fakeAutomation, ok } from './helpers.ts';

vi.mock('../../../src/commands/check/lib/bot-playtest.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/commands/check/lib/bot-playtest.ts')>();
  return { ...original, botPlaytest: vi.fn(original.botPlaytest) };
});
vi.mock('../../../src/commands/instance/automation.ts', () => ({
  automationRequest: vi.fn(),
  restartClient: async (...args: Parameters<typeof import('./helpers.ts').fakeRestartClient>) => (await import('./helpers.ts')).fakeRestartClient(...args),
}));
vi.mock('../../../src/commands/instance/api.ts', () => ({ startInstance: vi.fn(), stopInstance: vi.fn(), listInstances: vi.fn(), leaseHoldersEnd: vi.fn(() => Promise.resolve(true)) }));
vi.mock('../../../src/commands/instance/lib/records.ts', async (orig) => ({
  ...(await orig<object>()),
  // the instance record of a fake check instance: a checkout without client/generated/core_settings.json (no input gap), no client pid
  readRecord: vi.fn((id: string) => Promise.resolve({ id, root: '/nonexistent/ogw-check-instance', pids: {}, startedAt: 0 })),
}));
vi.mock('../../../src/lib/display.ts', () => ({ hostRefreshHz: () => Promise.resolve(null) }));
vi.mock('../../../src/commands/check/lib/instance-probe.ts', () => ({ instanceProcesses: vi.fn(), instanceServerLog: vi.fn() }));
vi.mock('../../../src/commands/check/static-api.ts', () => ({ staticCheck: vi.fn() }));
vi.mock('../../../src/commands/core/api.ts', () => ({ coreReleaseOfGame: vi.fn(), extractedAsset: vi.fn() }));
vi.mock('../../../src/commands/env/api.ts', () => ({ requireEngine: vi.fn() }));
vi.mock('../../../src/commands/data/api.ts', () => ({ runData: vi.fn() }));
vi.mock('../../../src/commands/generate/api.ts', () => ({ gameModules: vi.fn(), mergedCoreSettings: vi.fn(), generateCheckout: vi.fn(), installEnginePackages: vi.fn() }));
vi.mock('../../../src/commands/core/lib/postgres.ts', () => ({
  startPostgres: () => Promise.resolve({ id: 'c', createDatabase: (name: string) => Promise.resolve(`postgresql://p/${name}`), remove: () => Promise.resolve() }),
}));

const saved = { ...timing };
const savedSampling = { ...fpsSampling };
timing.pollMs = 1;
timing.sampleMs = 20;
fpsSampling.intervalMs = 0;
afterAll(() => {
  Object.assign(timing, saved);
  Object.assign(fpsSampling, savedSampling);
});

const SETTINGS = {
  engine: 'godot',
  coreVersion: '1.0.0',
  buildPlatforms: ['ios', 'web'],
  sourceLanguage: 'ko',
  supportedLanguages: ['ko'],
  baseResolution: [1080, 1920],
  uiCheckScreens: [{ name: 'phone', window: [1080, 1920], fillMode: 'Crop', notch: [0, 0, 0, 0], pixelRatio: 2.625 }],
};

const SCENARIO = {
  steps: [{ kind: 'input', command: 'tap', args: ['1', '1'], timeoutMs: 2000 }],
  goal: { path: 'telemetry.goal_intervals', op: 'count_gte', value: 1 },
};

const PASSING = { run_id: 'r', kind: 'regression', results: [{ name: 'res://tests/a/test_a.gd::test_a', status: 'pass', message: '' }], run_failures: [] };

/** A fake `godot` that passes a GUT run with `result`; each `--import` takes 200 ms and then appends a line to `imports` beside it. */
function fakeGodot(result: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'ogw-godot-'));
  const path = join(dir, 'godot');
  writeFileSync(
    path,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--import')) {
  setTimeout(() => {
    require('node:fs').appendFileSync(${JSON.stringify(join(dir, 'imports'))}, 'import\\n');
    require('node:fs').mkdirSync(require('node:path').join(args[args.indexOf('--path') + 1], '.godot'), { recursive: true });
    process.exit(0);
  }, 200);
} else {
  const host = JSON.parse(require('node:fs').readFileSync(args.find((a) => a.startsWith('-gconfig=')).slice(9), 'utf8')).ogw_test_host;
  fetch(host + '/result', { method: 'PUT', body: ${JSON.stringify(JSON.stringify(result))} }).then(() => process.exit(0));
}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function setupGame(ws: TestWorkspace, files: Record<string, string | object> = {}): string {
  return makeGame(ws, 'g', {
    'settings.json': SETTINGS,
    'client/dev/bot/scenario.json': SCENARIO,
    'client/tests/a/test_a.gd': 'func test_a():\n',
    ...files,
  });
}

/** get_stats calls of an instance after which its tap ends (the fps sampler of the performance check reads them). */
const TICKS = 6;

function serveClient(): string[] {
  const calls: string[] = [];
  const stats = new Map<string, number>();
  const answer = fakeAutomation((command, args) => {
    calls.push([command, ...args].join(' '));
    switch (command) {
      case 'get_state':
        // the clock of the client follows the movie maker frame step of the flash check (targetFps 60)
        return ok(doneState({ frame_step_fps: 60 }));
      case 'get_telemetry':
        return ok({ started_at: 0, goal_intervals: [{}], scene_loads: [{ scene_key: 'lobby', duration_ms: 10 }] });
      case 'get_stats':
        // 5 s of frames on time at 60 fps
        return ok({ fps: 60, frame_intervals_ms: Array<number>(300).fill(16.67) });
      case 'list_commands':
        return ok([{ name: 'shop.open_main' }]);
      case 'capture_screen':
        return ok(null, Buffer.from('PNG'));
      case 'list_ui':
      case 'extract_logs':
        return ok([]);
      default:
        return ok(null);
    }
  });
  vi.mocked(automationRequest).mockImplementation(async (c, id, command, args) => {
    if (command === 'get_stats') stats.set(id, (stats.get(id) ?? 0) + 1);
    // a tap of the performance check ends after the sampler read enough ticks; another instance reads none
    const until = Date.now() + 500;
    while (command === 'tap' && (stats.get(id) ?? 0) < TICKS && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 1));
    return answer(c, id, command, args);
  });
  return calls;
}

let ws: TestWorkspace;
let assetDir: string;

/** The movie maker of a client the flash check records: a second of one still image. */
async function stillMovie(options: InstanceOptions): Promise<void> {
  if (options.movie === undefined) return;
  const [width, height] = options.movie.resolution ?? [1, 1];
  const png = await encodePng({ width, height, data: Buffer.alloc(width * height * 4, 128) });
  for (let f = 0; f < 60; f++) writeFileSync(join(dirname(options.movie.file), `frame${String(f).padStart(8, '0')}.png`), png);
}

beforeEach(() => {
  ws = makeWorkspace({ maxConcurrentInstances: 2 });
  assetDir = mkdtempSync(join(tmpdir(), 'ogw-asset-'));
  writeFileSync(join(assetDir, 'engine.json'), JSON.stringify({ godot: '4.5.1.stable' }));
  vi.mocked(coreReleaseOfGame).mockReset().mockResolvedValue({ version: '1.0.0', dir: assetDir, local: false });
  vi.mocked(extractedAsset).mockReset().mockResolvedValue(assetDir);
  vi.mocked(requireEngine).mockReset().mockResolvedValue(fakeGodot(PASSING));
  vi.mocked(runData).mockReset().mockResolvedValue({ exitCode: 0, lines: [], stderr: '' });
  vi.mocked(staticCheck).mockReset().mockResolvedValue({ name: 'static check', platform: null, result: 'pass', failures: [], warnings: [] });
  vi.mocked(gameModules).mockReset().mockResolvedValue({ client: ['QualityCore', 'AccessibilityCore'], server: [] });
  vi.mocked(mergedCoreSettings).mockReset().mockResolvedValue({ 'AccessibilityCore.textScales': [1000, 1300], 'UnitTestCore.runTimeLimitMs': 30_000 });
  vi.mocked(installEnginePackages).mockReset().mockResolvedValue({ written: [], removed: [] });
  let n = 0;
  vi.mocked(startInstance).mockReset().mockImplementation(async (_c, given) => {
    await stillMovie(given);
    return { id: `i${String(++n)}` } as Awaited<ReturnType<typeof startInstance>>;
  });
  vi.mocked(stopInstance).mockReset().mockResolvedValue();
  vi.mocked(listInstances).mockReset().mockResolvedValue([]);
  vi.mocked(instanceProcesses).mockReset().mockResolvedValue({ server: true, clients: [{ client: 'main', alive: true }] });
  vi.mocked(instanceServerLog).mockReset().mockResolvedValue('');
});

describe('ogw check usage', () => {
  it('needs exactly one mode, the game, and only --db postgresql', async () => {
    setupGame(ws);
    expect((await ogw(ws, ['check', 'g'])).stderr).toMatch(/^give one of --loop, --regression, --static, --bot, --placeholder/);
    expect((await ogw(ws, ['check', 'g', '--static', '--placeholder'])).code).toBe(1);
    expect((await ogw(ws, ['check', '--static'])).stderr).toContain('usage: ogw check <game>');
    expect((await ogw(ws, ['check', 'g', 'x', '--static'])).stderr).toContain('usage: ogw check <game>');
    expect((await ogw(ws, ['check', 'g', 'a', 'b', '--regression'])).stderr).toContain('usage: ogw check <game>');
    expect((await ogw(ws, ['check', 'g', '--static', '--db', 'sqlite'])).stderr).toContain('--db takes only postgresql: sqlite');
    expect(runData).not.toHaveBeenCalled();
  });

  it('refuses --loop from an agent that ogw agent started', async () => {
    setupGame(ws);
    const remove = await fakeAgentJob(ws.env, 'agentcontent1', { role: 'content', cliPid: process.ppid });
    try {
      const run = await ogw(ws, ['check', 'g', '--loop']);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('ogw check --loop is for the lead agent, not the content agent: run --regression, --static or --bot');
    } finally {
      remove();
    }
    expect(runData).not.toHaveBeenCalled();
  });

  it('stops when the engine is not on this host or not pinned', async () => {
    setupGame(ws);
    vi.mocked(requireEngine).mockRejectedValueOnce(new Error('engine godot 4.5.1.stable is not on this host'));
    const missing = await ogw(ws, ['check', 'g', '--static']);
    expect(missing.code).toBe(1);
    expect(requireEngine).toHaveBeenCalledWith(expect.anything(), 'godot', '4.5.1.stable');
    expect(extractedAsset).toHaveBeenCalledWith(expect.anything(), { version: '1.0.0', dir: assetDir, local: false }, 'client-godot.zip');
    writeFileSync(join(assetDir, 'engine.json'), '{}');
    expect((await ogw(ws, ['check', 'g', '--static'])).stderr).toContain('engine.json of core 1.0.0 has no godot version');
  });

  it('stops when game settings has no engine', async () => {
    makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' } });
    expect((await ogw(ws, ['check', 'g', '--placeholder'])).stderr).toContain('game settings engine is not set');
  });

  it('stops when the data tool binary build fails', async () => {
    setupGame(ws);
    vi.mocked(runData).mockResolvedValue({
      exitCode: 1,
      lines: [{ level: 'ERROR', code: 'structure', where: 'data/tables/a.csv:1:1', message: 'bad', text: 'data/tables/a.csv:1:1 ERROR structure bad' }],
      stderr: 'detail\n',
    });
    const run = await ogw(ws, ['check', 'g', '--static']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('data tool binary build failed; run ogw data and commit, then check again\ndata/tables/a.csv:1:1 ERROR structure bad\ndetail\n');
    expect(runData).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: 'g' }), { binary: true, generate: false });
    expect(staticCheck).not.toHaveBeenCalled();
  });
});

describe('ogw check modes', () => {
  it('--placeholder prints the no placeholder check', async () => {
    setupGame(ws, { 'resource/resources.csv': 'key,status\nui/a,placeholder\n' });
    const run = await ogw(ws, ['check', 'g', '--placeholder']);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('no placeholder: fail\n  resource/resources.csv:2 placeholder ui/a\n');
    const json = await ogw(ws, ['check', 'g', '--placeholder', '--json']);
    expect(JSON.parse(json.stdout)).toEqual({
      checks: [{ name: 'no placeholder', platform: null, result: 'fail', failures: [{ where: 'resource/resources.csv:2', message: 'placeholder ui/a', evidence: [] }], warnings: [] }],
    });
  });

  it('--static runs the static check and passes --db', async () => {
    setupGame(ws);
    vi.mocked(staticCheck).mockResolvedValue({
      name: 'static check',
      platform: null,
      result: 'fail',
      failures: [{ where: 'client/a.gd:3', message: 'lint x', evidence: [] }],
      warnings: [{ where: 'data/tables/a.csv:2:1', message: 'data check w m', evidence: [] }],
    });
    const run = await ogw(ws, ['check', 'g', '--static', '--db', 'postgresql']);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('static check: fail\n  client/a.gd:3 lint x\n  warning data/tables/a.csv:2:1 data check w m\n');
    expect(staticCheck).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: 'g' }), { db: 'postgresql' });
    vi.mocked(staticCheck).mockResolvedValue({ name: 'static check', platform: null, result: 'pass', failures: [], warnings: [] });
    expect(await ogw(ws, ['check', 'g', '--static'])).toEqual({ code: 0, stdout: 'static check: pass\n', stderr: '' });
    expect(staticCheck).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ name: 'g' }), {});
  });

  it('prints every failure of a check outside --loop, which a background run cannot read elsewhere, and the first warnings', async () => {
    setupGame(ws);
    const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ where: `${prefix}:${String(i + 1)}`, message: 'm', evidence: [] }));
    vi.mocked(staticCheck).mockResolvedValue({ name: 'static check', platform: null, result: 'fail', failures: many(23, 'f'), warnings: many(8, 'w') });
    const run = await ogw(ws, ['check', 'g', '--static']);
    const lines = run.stdout.trimEnd().split('\n');
    expect(lines.slice(0, 24)).toEqual(['static check: fail', ...many(23, 'f').map((f) => `  ${f.where} m`)]);
    expect(lines.slice(24)).toEqual(['  warning w:1 m', '  warning w:2 m', '  warning w:3 m', '  warning w:4 m', '  warning w:5 m', '  3 more warnings, all in ogw data <game> --json']);
  });

  it('--regression runs the client regression test of a path and removes its evidence folder unless a failure points into it', async () => {
    setupGame(ws);
    const temp = join(ws.harness, '.git', 'ogw-temp');
    const folders = (): string[] => (existsSync(temp) ? readdirSync(temp).filter((name) => name.startsWith('ogw-check-')) : []);
    const run = await ogw(ws, ['check', 'g', '--regression', 'client/tests/a']);
    expect(run).toEqual({ code: 0, stdout: 'regression test: pass\n', stderr: '' });
    expect(folders()).toEqual([]);
    vi.mocked(requireEngine).mockResolvedValue(fakeGodot({ ...PASSING, run_failures: [{ message: 'no tests' }] }));
    const failing = await ogw(ws, ['check', 'g', '--regression']);
    expect(failing.code).toBe(1);
    expect(failing.stdout).toMatch(/^regression test: fail\n {2}client\/tests:1 run failure: no tests\n {4}\/.+client-result\.json\n/);
    const kept = /\n {4}(\/.+client-result\.json)\n/.exec(failing.stdout)?.[1] ?? '';
    expect(existsSync(kept)).toBe(true);
    expect(folders()).toHaveLength(1);
  });
});

/** `ogw check` run in this process, for the run log `summary` of its result (`tools/ogw.md`). */
async function checkSummary(values: Record<string, string | boolean>): Promise<unknown> {
  const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
  return (await check.run(ctx, { positionals: ['g'], values, raw: [] })).summary;
}

describe('ogw check text of the modes without a result file', () => {
  const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ where: `${prefix}:${String(i + 1)}`, message: 'm', evidence: [] }));

  it('--bot prints every failure of a check', async () => {
    setupGame(ws);
    vi.mocked(botPlaytest).mockResolvedValueOnce([
      { name: 'no blocker', platform: null, result: 'fail', failures: many(23, 'f'), warnings: [] },
      { name: 'full flow', platform: null, result: 'pass', failures: [], warnings: [] },
    ]);
    const lines = (await ogw(ws, ['check', 'g', '--bot'])).stdout.split('\n');
    expect(lines.slice(0, 25)).toEqual(['no blocker: fail', ...many(23, 'f').map((f) => `  ${f.where} m`), 'full flow: pass']);
  });

  it('ogw core try prints every failure and every warning of a check', async () => {
    setupGame(ws);
    serveClient();
    vi.mocked(staticCheck).mockResolvedValueOnce({ name: 'static check', platform: null, result: 'fail', failures: many(23, 'f'), warnings: many(8, 'w') });
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const { lines } = await coreTryChecks(ctx, await ctx.game('g'), { root: ws.root, dir: null, relative: false });
    const at = lines.indexOf('static check: fail');
    expect(lines.slice(at + 1, at + 32)).toEqual([...many(23, 'f').map((f) => `  ${f.where} m`), ...many(8, 'w').map((w) => `  warning ${w.where} m`)]);
    expect(lines.filter((line) => line.includes(' more '))).toEqual([]);
  });
});

describe('ogw check --bot', () => {
  it('runs only the bot playtest on the checkout for a content agent, writes and commits no result file, and keeps its evidence only for a failure it points into', async () => {
    const root = setupGame(ws);
    await openRun(1);
    const temp = join(ws.harness, '.git', 'ogw-temp');
    const folders = (): string[] => (existsSync(temp) ? readdirSync(temp).filter((name) => name.startsWith('ogw-check-')) : []);
    const remove = await fakeAgentJob(ws.env, 'agentcontent2', { role: 'content', cliPid: process.ppid });
    try {
      serveClient();
      const before = await head(root);
      const run = await ogw(ws, ['check', 'g', '--bot']);
      expect(run).toEqual({ code: 0, stdout: 'no blocker: pass\nfull flow: pass\n', stderr: '' });
      // the client is imported first, as --loop does
      const godot = vi.mocked(requireEngine).mock.results[0]?.value as Promise<string>;
      expect(readFileSync(join(dirname(await godot), 'imports'), 'utf8')).toBe('import\n');
      expect(vi.mocked(startInstance).mock.calls.map((c) => c[1])).toEqual([{ game: 'g', client: 'headless', db: undefined }]);
      expect(staticCheck).not.toHaveBeenCalled();
      expect(await head(root)).toBe(before);
      expect(existsSync(join(root, 'records/loops/create-1/check-1.json'))).toBe(false);
      expect(folders()).toEqual([]);
      // the goal is never reached: full flow fails
      const answer = fakeAutomation((command) => (command === 'get_state' ? ok(doneState()) : command === 'get_telemetry' ? ok({ goal_intervals: [], scene_loads: [] }) : ok(command === 'extract_logs' ? [] : null)));
      vi.mocked(automationRequest).mockImplementation(answer);
      const failing = await ogw(ws, ['check', 'g', '--bot']);
      expect(failing.code).toBe(1);
      expect(failing.stdout).toMatch(/^no blocker: pass\nfull flow: fail\n/);
      // the evidence folder is kept and named while a check did not pass
      const kept = /\nevidence: (\/.+)\n$/.exec(failing.stdout)?.[1] ?? '';
      expect(existsSync(kept)).toBe(true);
      expect(folders()).toHaveLength(1);
      expect(await head(root)).toBe(before);
    } finally {
      remove();
    }
  });
});

describe('ogw check --regression start limit', () => {
  it('ends a client run that sends no PUT /started within UnitTestCore.startTimeLimitMs of the game', async () => {
    setupGame(ws);
    vi.mocked(mergedCoreSettings).mockResolvedValue({ 'UnitTestCore.runTimeLimitMs': 60_000, 'UnitTestCore.startTimeLimitMs': 300 });
    const dir = mkdtempSync(join(tmpdir(), 'ogw-godot-'));
    const godot = join(dir, 'godot');
    // imports at once, then a test run that never starts
    writeFileSync(godot, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--import')) {
  require('node:fs').mkdirSync(require('node:path').join(args[args.indexOf('--path') + 1], '.godot'), { recursive: true });
  process.exit(0);
}
setInterval(() => undefined, 1000);
`);
    chmodSync(godot, 0o755);
    vi.mocked(requireEngine).mockResolvedValue(godot);
    const started = Date.now();
    const run = await ogw(ws, ['check', 'g', '--regression']);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(run.stdout).toContain('test run did not start within 300 ms (no PUT /started)');
  }, 60_000);
});

describe('ogw check run log summary', () => {
  it('gives every mode one name and merged result per check', async () => {
    setupGame(ws, { 'resource/resources.csv': 'key,status\nui/a,placeholder\n' });
    expect(await checkSummary({ placeholder: true })).toEqual({ checks: [{ name: 'no placeholder', result: 'fail' }] });
    expect(await checkSummary({ static: true })).toEqual({ checks: [{ name: 'static check', result: 'pass' }] });
    expect(await checkSummary({ regression: true })).toEqual({ checks: [{ name: 'regression test', result: 'fail' }] });
    await openRun(1);
    serveClient();
    // performance and UI quality have one item per platform profile (ios, web) and one summary entry each
    expect(await checkSummary({ loop: true })).toEqual({
      checks: [
        { name: 'regression test', result: 'fail' },
        { name: 'static check', result: 'pass' },
        { name: 'no blocker', result: 'pass' },
        { name: 'full flow', result: 'pass' },
        { name: 'performance', result: 'pass' },
        { name: 'UI quality', result: 'pass' },
        { name: 'no placeholder', result: 'fail' },
        { name: 'row simulation', result: 'pass' },
      ],
    });
  });
});

async function openRun(iteration: number, data: Record<string, unknown> = {}, command: 'create' | 'update' = 'create'): Promise<string> {
  const settings = await loadHarnessSettings(ws.env);
  const game = await resolveGame(workspaceFrom(settings, ws.env), 'g', ws.root);
  const base = await head(game.root);
  await changeRuns(game, (runs) => {
    runs.push(newRunState({ name: `${command}-1`, kind: 'loop', branch: `loop/${command}-1`, baseCommit: base, iteration, command, data }));
  });
  return base;
}

describe('ogw check --loop', () => {
  it('runs every check, writes check-<iteration>.json and prints gate: pass', async () => {
    const root = setupGame(ws, { 'server/tests/a.test.ts': "it('a', () => { expect(process.env.OGW_POSTGRESQL).toBe('postgresql://p/ogw_regression'); });\n" });
    await openRun(1);
    const calls = serveClient();
    mkdirSync(join(root, 'records/loops/create-1/evidence/check-1/old'), { recursive: true });
    const before = await head(root);
    const run = await ogw(ws, ['check', 'g', '--loop', '--db', 'postgresql']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout.split('\n').slice(-3)).toEqual(['result file: records/loops/create-1/check-1.json', 'gate: pass', '']);
    const file = JSON.parse(readFileSync(join(root, 'records/loops/create-1/check-1.json'), 'utf8')) as { commit: string; checks: { name: string; platform: string | null; result: string; hostLoad?: unknown }[]; gate: string };
    expect(file.commit).toBe(before);
    expect(await git(root, ['rev-parse', 'HEAD^'])).toBe(`${before}\n`);
    expect(await git(root, ['log', '-1', '--format=%s'])).toBe('loop create-1: check 1\n');
    expect(await git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toBe('records/loops/create-1/check-1.json\n');
    expect(await git(root, ['status', '--porcelain', '--', 'records/loops/create-1/check-1.json'])).toBe('');
    expect(file.gate).toBe('pass');
    expect(Object.keys(file)).toEqual(['commit', 'checks', 'gate', 'fixTestProof']);
    // no content agent report: no fix test proof
    expect((file as unknown as { fixTestProof: unknown }).fixTestProof).toEqual([]);
    expect(file.checks.map((c) => [c.name, c.platform, c.result])).toEqual([
      ['regression test', null, 'pass'],
      ['static check', null, 'pass'],
      ['no blocker', null, 'pass'],
      ['full flow', null, 'pass'],
      ['performance', 'ios', 'pass'],
      ['performance', 'web', 'pass'],
      ['UI quality', 'ios', 'pass'],
      ['UI quality', 'web', 'pass'],
      ['no placeholder', null, 'pass'],
      ['row simulation', null, 'pass'],
    ]);
    expect(file.checks[4]?.hostLoad).toEqual({ cpuMaxPercent: expect.any(Number) as number, memoryMaxPercent: expect.any(Number) as number, instancesMax: 0 });
    expect(existsSync(join(root, 'records/loops/create-1/evidence/check-1/old'))).toBe(false);
    expect(existsSync(join(root, 'records/loops/create-1/evidence/check-1/regression/client-result.json'))).toBe(true);
    // the bot playtest, the row simulation, and per platform profile the performance, the captures and the flash recording
    expect(startInstance).toHaveBeenCalledTimes(8);
    expect(vi.mocked(startInstance).mock.calls.map((c) => c[1])).toEqual(
      expect.arrayContaining([
        { game: 'g', client: 'headless', db: 'postgresql' },
        { game: 'g', platform: 'ios', client: 'window', db: 'postgresql' },
        { game: 'g', platform: 'web', client: 'window', db: 'postgresql' },
      ]),
    );
    // the flash recording of each platform profile: the phone screen at its CSS size, at targetFps (the profiles run side by side: in either order)
    const recordings = vi.mocked(startInstance).mock.calls.map((c) => c[1]).filter((o) => o.movie !== undefined).sort((a, b) => String(a.platform).localeCompare(String(b.platform)));
    expect(recordings.map((o) => [o.platform, o.client, o.db, o.movie?.resolution, o.movie?.fps, o.testScreen])).toEqual(
      ['ios', 'web'].map((p) => [p, 'window', 'postgresql', [411, 731], 60, { window: [1080, 1920], fillMode: 'Crop', notch: [0, 0, 0, 0] }]),
    );
    expect(stopInstance).toHaveBeenCalledTimes(8);
    expect(calls).toContain('set_quality_level High');
    expect(calls).toContain('set_text_scale 1300');
    // the loop imported client/ before the checks: the static type check does not import again
    expect(staticCheck).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: 'g' }), { db: 'postgresql', imported: true });
  });

  it('runs the tests that the report names for a fixed defect on the fix base, with the changed test files laid over it, and writes the fix test proof', async () => {
    const R = 'records/loops/create-1';
    const defect = (id: string, owner: string, source = 'play'): object => ({ id, severity: 'major', owner, where: 'w', what: 'x', why: 'y', evidence: [], source, status: 'open', refusedReason: null, repeatedDefect: 0, oscillation: 0 });
    const root = setupGame(ws, {
      'client/tests/b/test_b.gd': 'func test_b():\n',
      'client/tests/c/test_c.gd': 'func test_c():\n',
      'server/limit.json': { max: 3 },
      [`${R}/content-input-1.md`]: '## kind\n\ncompleteness\n',
      [`${R}/defects.json`]: {
        defects: ['crash', 'slow', 'old', 'load', 'flat'].map((id) => defect(id, 'client content')).concat([defect('bal', 'data'), defect('ui', 'client content', 'check')]),
        previous: null,
        recordedBy: 'iteration-0',
      },
    });
    const base = await openRun(1);
    // the iteration: the fix of server/limit.json with its test, changed client tests, a client test that does not load on the fix base
    writeFileSync(join(root, 'client/tests/a/test_a.gd'), 'func test_a():\n\tpass\n');
    // the iteration has more than one commit: the fix base is not the parent of the checked commit
    commitAll(root, 'content agent: first fix');
    writeFileSync(join(root, 'server/limit.json'), JSON.stringify({ max: 5 }));
    mkdirSync(join(root, 'client/tests/d'), { recursive: true });
    mkdirSync(join(root, 'server/tests'), { recursive: true });
    writeFileSync(join(root, 'client/tests/b/test_b.gd'), 'func test_b():\n\tpass\n');
    writeFileSync(join(root, 'client/tests/d/test_d.gd'), 'func test_d():\n');
    writeFileSync(join(root, 'server/tests/b.test.ts'), "import { readFileSync } from 'node:fs';\nit('limit', () => { expect(JSON.parse(readFileSync(new URL('../limit.json', import.meta.url), 'utf8')).max).toBe(5); });\n");
    const rows = [
      '| crash | fixed | `client/tests/a/test_a.gd::test_a`, `server/tests/b.test.ts::limit` |',
      '| slow | fixed | `client/tests/b/test_b.gd::test_b` |',
      '| old | fixed | `client/tests/c/test_c.gd::test_c` |',
      '| load | fixed | `client/tests/d/test_d.gd::test_d` |',
      '| flat | fixed | presentation |',
      '| bal | fixed | |',
      '| ui | fixed | |',
      '| gone | fixed | |',
      '| kept | not done | later |',
    ];
    writeFileSync(join(root, `${R}/content-1.md`), ['## defects', '', '| id | result | note |', '|---|---|---|', ...rows, ''].join('\n'));
    commitAll(root, 'content agent');
    // the client tests on the fix base: test_a fails there, test_b passes, test_d does not load; on the checked commit all pass
    const godotDir = mkdtempSync(join(tmpdir(), 'ogw-godot-'));
    const godot = join(godotDir, 'godot');
    writeFileSync(
      godot,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const project = args[args.indexOf('--path') + 1];
if (args.includes('--import')) {
  fs.mkdirSync(require('node:path').join(project, '.godot'), { recursive: true });
  process.exit(0);
}
const config = JSON.parse(fs.readFileSync(args.find((a) => a.startsWith('-gconfig=')).slice(9), 'utf8'));
const target = (args.find((a) => a.startsWith('-gtest=')) || '').slice(7);
const onBase = project.includes('/proof-');
fs.appendFileSync(${JSON.stringify(join(godotDir, 'runs'))}, (onBase ? 'base ' : 'head ') + (target || 'all') + '\\n');
const put = (path, body) => fetch(config.ogw_test_host + path, { method: 'PUT', body: JSON.stringify(body) });
const results = onBase
  ? [{ name: 'res://tests/a/test_a.gd::test_a', status: 'fail', message: 'x' }, { name: 'res://tests/b/test_b.gd::test_b', status: 'pass', message: '' }]
  : [{ name: 'res://tests/a/test_a.gd::test_a', status: 'pass', message: '' }];
put('/started', { run_id: config.ogw_run_id })
  .then(() => (onBase && target.endsWith('test_d.gd') ? process.exit(1) : put('/result', { run_id: config.ogw_run_id, kind: 'regression', results, run_failures: [] })))
  .then(() => process.exit(0));
`,
    );
    chmodSync(godot, 0o755);
    vi.mocked(requireEngine).mockResolvedValue(godot);
    serveClient();
    const run = await ogw(ws, ['check', 'g', '--loop']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const file = JSON.parse(readFileSync(join(root, `${R}/check-1.json`), 'utf8')) as { gate: string; fixTestProof: unknown };
    expect(file.gate).toBe('pass');
    const test = (name: string, result: string, reason: string | null = null): object => ({ name, result, reason });
    expect(file.fixTestProof).toEqual([
      { id: 'crash', result: 'pass', reason: null, tests: [test('client/tests/a/test_a.gd::test_a', 'fail'), test('server/tests/b.test.ts::limit', 'fail')] },
      { id: 'slow', result: 'fail', reason: `the named tests pass on ${base.slice(0, 12)}, the code before the fix`, tests: [test('client/tests/b/test_b.gd::test_b', 'pass')] },
      { id: 'old', result: 'fail', reason: 'no named test in a test file that the commits of the iteration added or changed', tests: [] },
      { id: 'load', result: 'pass', reason: null, tests: [test('client/tests/d/test_d.gd::test_d', 'fail', 'the run does not report it: the run sent no result (exit code 1)')] },
      { id: 'flat', result: 'unknown', reason: 'presentation', tests: [] },
      { id: 'bal', result: 'unknown', reason: 'owner data', tests: [] },
      { id: 'ui', result: 'unknown', reason: 'source check', tests: [] },
      { id: 'gone', result: 'unknown', reason: 'not a defect of defects.json', tests: [] },
    ]);
    // each named client test file ran alone on the fix base, and the worktree of the fix base is gone
    const runs = readFileSync(join(godotDir, 'runs'), 'utf8').split('\n').filter((line) => line.startsWith('base '));
    expect(runs.sort()).toEqual(['base res://tests/a/test_a.gd', 'base res://tests/b/test_b.gd', 'base res://tests/d/test_d.gd']);
    expect(readdirSync(join(ws.worktrees, 'g')).filter((name) => name.startsWith('proof-'))).toEqual([]);
  });

  it('writes a fix test proof that could not be decided as unknown with its reason, not as no proof', async () => {
    const R = 'records/loops/create-1';
    const root = setupGame(ws, {
      [`${R}/content-input-1.md`]: '## kind\n\ncompleteness\n',
      [`${R}/content-1.md`]: '## defects\n\n| id | result | note |\n|---|---|---|\n| crash | fixed | `client/tests/a/test_a.gd::test_a` |\n',
      [`${R}/defects.json`]: '{"defects": [',
    });
    await openRun(1);
    serveClient();
    const run = await ogw(ws, ['check', 'g', '--loop']);
    expect(run.stderr).toBe('');
    const file = JSON.parse(readFileSync(join(root, `${R}/check-1.json`), 'utf8')) as { fixTestProof: { id: string; result: string; reason: string | null }[] };
    expect(file.fixTestProof).toEqual([{ id: 'crash', result: 'unknown', reason: expect.stringMatching(/^records\/loops\/create-1\/defects\.json could not be read: invalid JSON/) as unknown, tests: [] }]);
  });

  it('fails before any check starts when the content agent report cannot be read', async () => {
    const R = 'records/loops/create-1';
    const root = setupGame(ws, { [`${R}/content-input-1.md`]: '## kind\n\ncompleteness\n', [`${R}/content-1.md/x`]: 'a folder, not a report' });
    await openRun(1);
    serveClient();
    const run = await ogw(ws, ['check', 'g', '--loop']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('EISDIR');
    expect(startInstance).not.toHaveBeenCalled();
    expect(existsSync(join(root, `${R}/check-1.json`))).toBe(false);
  });

  it('starts the fix test proof in its worktree without waiting for the import of the checkout', async () => {
    const R = 'records/loops/create-1';
    const defect = { id: 'crash', severity: 'major', owner: 'client content', where: 'w', what: 'x', why: 'y', evidence: [], source: 'play', status: 'open', refusedReason: null, repeatedDefect: 0, oscillation: 0 };
    const root = setupGame(ws, { [`${R}/content-input-1.md`]: '## kind\n\ncompleteness\n', [`${R}/defects.json`]: { defects: [defect], previous: null, recordedBy: 'iteration-0' } });
    await openRun(1);
    writeFileSync(join(root, 'client/tests/a/test_a.gd'), 'func test_a():\n\tpass\n');
    writeFileSync(join(root, `${R}/content-1.md`), '## defects\n\n| id | result | note |\n|---|---|---|\n| crash | fixed | `client/tests/a/test_a.gd::test_a` |\n');
    commitAll(root, 'content agent');
    // the import of the checkout takes 3 s; the run of the proof on the fix base logs when it starts
    const godotDir = mkdtempSync(join(tmpdir(), 'ogw-godot-'));
    const godot = join(godotDir, 'godot');
    const log = join(godotDir, 'log');
    writeFileSync(
      godot,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const project = args[args.indexOf('--path') + 1];
const onBase = project.includes('/proof-');
if (args.includes('--import')) {
  setTimeout(() => {
    fs.mkdirSync(require('node:path').join(project, '.godot'), { recursive: true });
    if (!onBase) fs.appendFileSync(${JSON.stringify(log)}, 'import end ' + Date.now() + '\\n');
    process.exit(0);
  }, onBase ? 0 : 3000);
} else {
  if (onBase) fs.appendFileSync(${JSON.stringify(log)}, 'base run ' + Date.now() + '\\n');
  const config = JSON.parse(fs.readFileSync(args.find((a) => a.startsWith('-gconfig=')).slice(9), 'utf8'));
  const put = (path, body) => fetch(config.ogw_test_host + path, { method: 'PUT', body: JSON.stringify(body) });
  const status = onBase ? 'fail' : 'pass';
  put('/started', { run_id: config.ogw_run_id })
    .then(() => put('/result', { run_id: config.ogw_run_id, kind: 'regression', results: [{ name: 'res://tests/a/test_a.gd::test_a', status, message: '' }], run_failures: [] }))
    .then(() => process.exit(0));
}
`,
    );
    chmodSync(godot, 0o755);
    vi.mocked(requireEngine).mockResolvedValue(godot);
    serveClient();
    const run = await ogw(ws, ['check', 'g', '--loop']);
    expect(run.stderr).toBe('');
    const file = JSON.parse(readFileSync(join(root, `${R}/check-1.json`), 'utf8')) as { fixTestProof: { id: string; result: string }[] };
    expect(file.fixTestProof.map((p) => [p.id, p.result])).toEqual([['crash', 'pass']]);
    const at = (prefix: string): number => Number(readFileSync(log, 'utf8').split('\n').find((line) => line.startsWith(prefix))?.slice(prefix.length));
    expect(at('base run ')).toBeLessThan(at('import end '));
  });

  it('runs only the regression test, the static check and the bot playtest in a fun iteration', async () => {
    const root = setupGame(ws, { 'server/tests/a.test.ts': "it('a', () => { expect(1).toBe(1); });\n" });
    await openRun(2, { loop: { kinds: [{ iteration: 2, kind: 'fun' }] } });
    serveClient();
    const run = await ogw(ws, ['check', 'g', '--loop']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('regression test: pass\nstatic check: pass\nno blocker: pass\nfull flow: pass\nresult file: records/loops/create-1/check-2.json\ngate: pass\n');
    const file = JSON.parse(readFileSync(join(root, 'records/loops/create-1/check-2.json'), 'utf8')) as { checks: { name: string; result: string }[]; gate: string };
    expect(file.checks.map((c) => [c.name, c.result])).toEqual([
      ['regression test', 'pass'],
      ['static check', 'pass'],
      ['no blocker', 'pass'],
      ['full flow', 'pass'],
    ]);
    expect(file.gate).toBe('pass');
    // one headless instance: the bot playtest
    expect(vi.mocked(startInstance).mock.calls.map((c) => c[1])).toEqual([{ game: 'g', client: 'headless' }]);
  });

  it('--loop prints the first failures and warnings of a check and the count of the rest; the result file holds them all', async () => {
    const root = setupGame(ws, { 'server/tests/a.test.ts': "it('a', () => { expect(1).toBe(1); });\n" });
    await openRun(2, { loop: { kinds: [{ iteration: 2, kind: 'fun' }] } });
    serveClient();
    const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ where: `${prefix}:${String(i + 1)}`, message: 'm', evidence: [] }));
    vi.mocked(staticCheck).mockResolvedValueOnce({ name: 'static check', platform: null, result: 'fail', failures: many(23, 'f'), warnings: many(8, 'w') });
    const lines = (await ogw(ws, ['check', 'g', '--loop'])).stdout.split('\n');
    const at = lines.indexOf('static check: fail');
    expect(lines.slice(at + 1, at + 21)).toEqual(many(20, 'f').map((f) => `  ${f.where} m`));
    expect(lines.slice(at + 21, at + 28)).toEqual(['  3 more failures, all in the result file', '  warning w:1 m', '  warning w:2 m', '  warning w:3 m', '  warning w:4 m', '  warning w:5 m', '  3 more warnings, all in the result file']);
    const file = JSON.parse(readFileSync(join(root, 'records/loops/create-1/check-2.json'), 'utf8')) as { checks: { name: string; failures: unknown[]; warnings: unknown[] }[] };
    const check = file.checks.find((c) => c.name === 'static check');
    expect(check?.failures).toHaveLength(23);
    expect(check?.warnings).toHaveLength(8);
  });

  it('imports the client once, before any instance starts, and the regression test does not import again', async () => {
    setupGame(ws);
    await openRun(1);
    serveClient();
    const godot = fakeGodot(PASSING);
    vi.mocked(requireEngine).mockResolvedValue(godot);
    const imports = join(dirname(godot), 'imports');
    const seenAtStart: string[] = [];
    vi.mocked(startInstance).mockImplementation(() => {
      seenAtStart.push(existsSync(imports) ? readFileSync(imports, 'utf8') : '');
      return Promise.resolve({ id: `i${String(seenAtStart.length)}` } as Awaited<ReturnType<typeof startInstance>>);
    });
    // the engine packages go in once, before that import
    const seenAtPackages: boolean[] = [];
    vi.mocked(installEnginePackages).mockImplementation(() => {
      seenAtPackages.push(existsSync(imports));
      return Promise.resolve({ written: [], removed: [] });
    });
    const run = await ogw(ws, ['check', 'g', '--loop']);
    expect(run.stderr).toBe('');
    expect(readFileSync(imports, 'utf8')).toBe('import\n');
    expect(seenAtStart.length).toBeGreaterThan(0);
    expect(seenAtStart.every((text) => text === 'import\n')).toBe(true);
    expect(seenAtPackages).toEqual([false]);
    expect(vi.mocked(installEnginePackages).mock.calls[0]?.[1]).toMatchObject({ name: 'g', root: join(ws.games, 'g') });
  });

  it('a failed import removes client/.godot/ before any instance starts, and no check imports again', async () => {
    const root = setupGame(ws);
    await openRun(1);
    serveClient();
    const dir = mkdtempSync(join(tmpdir(), 'ogw-godot-'));
    const godot = join(dir, 'godot');
    const imports = join(dir, 'imports');
    writeFileSync(godot, `#!/bin/sh\necho import >> ${imports}\nmkdir -p "$3/.godot"\nexit 1\n`);
    chmodSync(godot, 0o755);
    vi.mocked(requireEngine).mockResolvedValue(godot);
    const seenAtStart: boolean[] = [];
    vi.mocked(startInstance).mockImplementation(() => {
      seenAtStart.push(existsSync(join(root, 'client', '.godot')));
      return Promise.resolve({ id: `i${String(seenAtStart.length)}` } as Awaited<ReturnType<typeof startInstance>>);
    });
    const run = await ogw(ws, ['check', 'g', '--loop', '--json']);
    const data = JSON.parse(run.stdout) as { checks: { name: string; failures: { where: string; message: string }[] }[] };
    expect(readFileSync(imports, 'utf8')).toBe('import\n');
    expect(seenAtStart.length).toBeGreaterThan(0);
    expect(seenAtStart.every((seen) => !seen)).toBe(true);
    expect(data.checks[0]?.failures).toContainEqual({ where: 'client/tests:1', message: 'godot --import failed (1)', evidence: [] });
    expect(staticCheck).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: 'g' }), { importFailure: 'godot --import failed (1)' });
  });

  it('gate fails on a failing gate check, still writes the file, and records checks that did not run as unknown', async () => {
    const root = setupGame(ws, { 'server/tests/a.test.ts': '' });
    await openRun(2);
    serveClient();
    vi.mocked(staticCheck).mockRejectedValue(new Error('static broken'));
    vi.mocked(gameModules).mockResolvedValue({ client: [], server: [] });
    const run = await ogw(ws, ['check', 'g', '--loop', '--json']);
    expect(run.code).toBe(1);
    const data = JSON.parse(run.stdout) as { gate: string; file: string; checks: { name: string; result: string; failures: { where: string; message: string }[] }[] };
    expect(data.gate).toBe('fail');
    expect(data.file).toBe('records/loops/create-1/check-2.json');
    expect(data.checks[0]).toMatchObject({ name: 'regression test', result: 'fail' });
    expect(data.checks[0]?.failures.map((f) => f.message)).toContain('run failure: no tests');
    expect(data.checks[1]).toMatchObject({ name: 'static check', result: 'unknown', failures: [{ where: 'settings.json:1', message: 'static check did not run: static broken' }] });
    expect((JSON.parse(readFileSync(join(root, 'records/loops/create-1/check-2.json'), 'utf8')) as { gate: string }).gate).toBe('fail');
    expect(await git(root, ['status', '--porcelain', '--', 'records/loops/create-1/check-2.json'])).toBe('');
    const text = await ogw(ws, ['check', 'g', '--loop']);
    expect(text.stdout.trimEnd().split('\n').at(-1)).toBe('gate: fail');
  });

  it('makes the shared telemetry runs of this commit and the baseline game beside the checks, and measures performance with no other instance of the check running', async () => {
    const root = setupGame(ws, { 'server/tests/a.test.ts': "it('a', () => { expect(1).toBe(1); });\n" });
    // an update run: its baseline game at iteration 1 is the commit the work branch was made from
    const base = await openRun(1, {}, 'update');
    writeFileSync(join(root, 'client/tests/a/test_b.gd'), 'func test_b():\n');
    commitAll(root, 'content');
    const commit = (await head(root)).trim();
    serveClient();
    const answer = vi.mocked(automationRequest).getMockImplementation() as typeof automationRequest;
    const measured = new Set<string>();
    vi.mocked(automationRequest).mockImplementation((c, id, command, args, ...rest) => {
      if (command === 'set_quality_level') measured.add(id);
      return answer(c, id, command, args, ...rest);
    });
    // starts and stops in order; each instance has a checkout with a play guide
    const events: [string, string][] = [];
    const checkout = mkdtempSync(join(tmpdir(), 'ogw-instance-'));
    writeFileSync(join(checkout, 'play-guide.md'), '## controls\n\ntap\n');
    let n = 0;
    vi.mocked(startInstance).mockImplementation(() => {
      const id = `i${String(++n)}`;
      events.push(['start', id]);
      return Promise.resolve({ id, root: checkout } as Awaited<ReturnType<typeof startInstance>>);
    });
    vi.mocked(stopInstance).mockImplementation((_c, id) => {
      events.push(['stop', id]);
      return Promise.resolve();
    });
    const run = await ogw(ws, ['check', 'g', '--loop']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    // three headless runs of each commit, each on a new instance of its commit
    const starts = vi.mocked(startInstance).mock.calls.map((c) => c[1]);
    expect(starts.filter((o) => o.commit === commit)).toEqual(Array.from({ length: 3 }, () => ({ game: 'g', commit, client: 'headless', db: undefined })));
    expect(starts.filter((o) => o.commit === base)).toEqual(Array.from({ length: 3 }, () => ({ game: 'g', commit: base, client: 'headless', db: undefined })));
    const scenario = createHash('sha256').update(readFileSync(join(root, 'client/dev/bot/scenario.json'))).digest('hex');
    const runs = JSON.parse(readFileSync(join(root, 'records/loops/update-1/evidence/check-1/telemetry-runs.json'), 'utf8')) as { commit: string; baseline: string; scenario: string; runs: Record<string, { telemetry: { started_at: number }; guide: string | null }[] | null> };
    expect({ commit: runs.commit, baseline: runs.baseline, scenario: runs.scenario }).toEqual({ commit, baseline: base, scenario });
    for (const side of ['commit', 'baseline']) {
      expect(runs.runs[side]?.map((r) => [r.telemetry.started_at, r.guide])).toEqual(Array.from({ length: 3 }, () => [0, '## controls\n\ntap\n']));
    }
    // the runs are not a check
    const file = JSON.parse(readFileSync(join(root, 'records/loops/update-1/check-1.json'), 'utf8')) as { checks: { name: string }[] };
    expect([...new Set(file.checks.map((c) => c.name))]).toEqual(['regression test', 'static check', 'no blocker', 'full flow', 'performance', 'UI quality', 'no placeholder', 'row simulation']);
    // each performance measurement (one per platform profile) starts when no other instance of the check runs, and
    // no instance starts or stops until it stops
    expect(measured.size).toBe(2);
    for (const id of measured) {
      const at = events.findIndex(([kind, i]) => kind === 'start' && i === id);
      const running = new Set<string>();
      for (const [kind, i] of events.slice(0, at)) {
        if (kind === 'start') running.add(i);
        else running.delete(i);
      }
      expect([...running]).toEqual([]);
      expect(events[at + 1]).toEqual(['stop', id]);
    }
  });

  it('runs only in an iteration of an open run, with maxConcurrentInstances set', async () => {
    setupGame(ws);
    expect((await ogw(ws, ['check', 'g', '--loop'])).stderr).toBe('no open run for game g\n');
    await openRun(0);
    expect((await ogw(ws, ['check', 'g', '--loop'])).stderr).toBe('run create-1 has no iteration yet\n');
    const other = makeWorkspace({ maxConcurrentInstances: null });
    ws = other;
    setupGame(ws);
    await openRun(1);
    expect((await ogw(ws, ['check', 'g', '--loop'])).stderr).toBe('harness settings maxConcurrentInstances is null: do update env first\n');
  });
});
