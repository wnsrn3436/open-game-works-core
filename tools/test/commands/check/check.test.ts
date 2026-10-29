import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { check, timing } from '../../../src/commands/check/check.ts';
import { instanceProcesses, instanceServerLog } from '../../../src/commands/check/lib/instance-probe.ts';
import { fpsSampling } from '../../../src/commands/check/lib/performance.ts';
import { staticCheck } from '../../../src/commands/check/static-api.ts';
import { coreReleaseOfGame, extractedAsset } from '../../../src/commands/core/api.ts';
import { runData } from '../../../src/commands/data/api.ts';
import { requireEngine } from '../../../src/commands/env/api.ts';
import { gameModules, mergedCoreSettings } from '../../../src/commands/generate/api.ts';
import { listInstances, startInstance, stopInstance } from '../../../src/commands/instance/api.ts';
import { automationRequest } from '../../../src/commands/instance/automation.ts';
import { createContext } from '../../../src/lib/command.ts';
import { resolveGame } from '../../../src/lib/game.ts';
import { git, head } from '../../../src/lib/git.ts';
import { changeRuns, newRunState } from '../../../src/lib/runstate.ts';
import { workspaceFrom, loadHarnessSettings } from '../../../src/lib/settings.ts';
import { ogw, makeGame, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeAgentJob } from '../instance/agents.ts';
import { doneState, fakeAutomation, ok } from './helpers.ts';

vi.mock('../../../src/commands/instance/automation.ts', () => ({
  automationRequest: vi.fn(),
  restartClient: async (...args: Parameters<typeof import('./helpers.ts').fakeRestartClient>) => (await import('./helpers.ts')).fakeRestartClient(...args),
}));
vi.mock('../../../src/commands/instance/api.ts', () => ({ startInstance: vi.fn(), stopInstance: vi.fn(), listInstances: vi.fn() }));
vi.mock('../../../src/lib/display.ts', () => ({ hostRefreshHz: () => Promise.resolve(null) }));
vi.mock('../../../src/commands/check/lib/instance-probe.ts', () => ({ instanceProcesses: vi.fn(), instanceServerLog: vi.fn() }));
vi.mock('../../../src/commands/check/static-api.ts', () => ({ staticCheck: vi.fn() }));
vi.mock('../../../src/commands/core/api.ts', () => ({ coreReleaseOfGame: vi.fn(), extractedAsset: vi.fn() }));
vi.mock('../../../src/commands/env/api.ts', () => ({ requireEngine: vi.fn() }));
vi.mock('../../../src/commands/data/api.ts', () => ({ runData: vi.fn() }));
vi.mock('../../../src/commands/generate/api.ts', () => ({ gameModules: vi.fn(), mergedCoreSettings: vi.fn() }));
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
  uiCheckScreens: [{ name: 'phone', window: [1080, 1920], fillMode: 'Crop', notch: [0, 0, 0, 0] }],
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
        return ok(doneState());
      case 'get_telemetry':
        return ok({ goal_intervals: [{}], scene_loads: [{ scene_key: 'lobby', duration_ms: 10 }] });
      case 'get_stats':
        return ok({ fps: 60 });
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
  let n = 0;
  vi.mocked(startInstance).mockReset().mockImplementation(() => Promise.resolve({ id: `i${String(++n)}` } as Awaited<ReturnType<typeof startInstance>>));
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

async function openRun(iteration: number, data: Record<string, unknown> = {}): Promise<void> {
  const settings = await loadHarnessSettings(ws.env);
  const game = await resolveGame(workspaceFrom(settings, ws.env), 'g', ws.root);
  const base = await head(game.root);
  await changeRuns(game, (runs) => {
    runs.push(newRunState({ name: 'create-1', kind: 'loop', branch: 'loop/create-1', baseCommit: base, iteration, command: 'create', data }));
  });
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
    expect(Object.keys(file)).toEqual(['commit', 'checks', 'gate']);
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
    expect(startInstance).toHaveBeenCalledTimes(6);
    expect(vi.mocked(startInstance).mock.calls.map((c) => c[1])).toEqual(
      expect.arrayContaining([
        { game: 'g', client: 'headless', db: 'postgresql' },
        { game: 'g', platform: 'ios', client: 'window', db: 'postgresql' },
        { game: 'g', platform: 'web', client: 'window', db: 'postgresql' },
      ]),
    );
    expect(stopInstance).toHaveBeenCalledTimes(6);
    expect(calls).toContain('set_quality_level High');
    expect(calls).toContain('set_text_scale 1300');
    // the loop imported client/ before the checks: the static type check does not import again
    expect(staticCheck).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: 'g' }), { db: 'postgresql', imported: true });
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
    const run = await ogw(ws, ['check', 'g', '--loop']);
    expect(run.stderr).toBe('');
    expect(readFileSync(imports, 'utf8')).toBe('import\n');
    expect(seenAtStart.length).toBeGreaterThan(0);
    expect(seenAtStart.every((text) => text === 'import\n')).toBe(true);
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
