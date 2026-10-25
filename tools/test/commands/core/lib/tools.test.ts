import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { baseProtoBreaks } from '../../../../src/commands/core/lib/base-proto-compat.ts';
import { readCoreSchemaVersion } from '../../../../src/commands/core/lib/manifest.ts';
import { GODOT_PREFIX, runToolTest } from '../../../../src/commands/core/lib/tool-test.ts';
import {
  buildTool,
  compareBaseProto,
  implementedTools,
  stageToolPackage,
  TOOLS,
} from '../../../../src/commands/core/lib/tools.ts';
import { requireEngine } from '../../../../src/commands/env/api.ts';
import { createContext, type Context } from '../../../../src/lib/command.ts';
import { addTestRecord } from '../../../../src/commands/core/lib/test-records.ts';
import { makeWorkspace, sh, type TestWorkspace } from '../../../helpers/workspace.ts';
import { fakeBin, fakeGh, makeReleaseDir, pathEnv, writeFiles } from '../helpers.ts';
import { writeImpl } from '../impl-fixture.ts';

vi.mock('../../../../src/commands/env/api.ts', () => ({ requireEngine: vi.fn() }));
vi.mock('../../../../src/commands/core/lib/engine-packages.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  installPackage: vi.fn(() => Promise.resolve()),
}));

/** Fake npm: logs `<tool folder> <args>`; `ci` installs a fake vitest, `run build` writes `bin/<tool>.js` from `tool.js`. */
const NPM = `
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2).join(' ');
const tool = path.basename(process.cwd());
fs.appendFileSync(process.env.FAKE_LOG, tool + ' npm ' + args + '\\n');
if (process.env.FAKE_NPM_FAIL === args) { console.log('npm says no'); process.exit(3); }
if (args === 'ci --no-audit --no-fund') {
  fs.mkdirSync('node_modules/.bin', { recursive: true });
  if (process.env.FAKE_VITEST) { fs.copyFileSync(process.env.FAKE_VITEST, 'node_modules/.bin/vitest'); fs.chmodSync('node_modules/.bin/vitest', 0o755); }
}
if (args === 'run build' && !process.env.FAKE_NO_BIN) {
  fs.mkdirSync('bin', { recursive: true });
  fs.copyFileSync('tool.js', 'bin/' + tool + '.js');
}
`;

/** Fake vitest: writes the report of `FAKE_REPORT_<TOOL>` (a JSON text, file names relative to the tool folder) to --outputFile. */
const VITEST = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const tool = path.basename(process.cwd()).replace('-', '_').toUpperCase();
const out = process.argv.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length);
fs.appendFileSync(process.env.FAKE_LOG, 'vitest ' + process.argv.slice(2, 4).join(' ') + '\\n');
const report = process.env['FAKE_REPORT_' + tool] && JSON.parse(process.env['FAKE_REPORT_' + tool]);
for (const file of (report && report.testResults) || []) file.name = path.join(process.cwd(), file.name);
if (report) fs.writeFileSync(out, JSON.stringify(report));
process.exit(Number(process.env.FAKE_VITEST_CODE || 0));
`;

/** Fake tool: the contract tool prints `FAKE_BREAKS` lines and exits with `FAKE_TOOL_CODE`; it logs its args and the previous folder. */
const TOOL = `
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
const get = (name) => args[args.indexOf(name) + 1];
const previous = args.includes('--previous') ? get('--previous') : null;
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: path.basename(process.argv[1]), args, previous: previous && fs.readdirSync(previous).sort(),
  proto: previous && fs.readFileSync(path.join(previous, 'proto/ogw/core.proto'), 'utf8'), settings: previous && fs.readFileSync(path.join(previous, 'core-settings.json'), 'utf8'),
  current: args.includes('--core-settings') ? fs.readFileSync(get('--core-settings'), 'utf8') : null }) + '\\n');
if (args.includes('--id-registry')) fs.writeFileSync(get('--id-registry'), '{}');
if (args.includes('--engine')) { const g = get('--game'); fs.mkdirSync(path.join(g, 'client/generated'), { recursive: true }); fs.writeFileSync(path.join(g, 'client/generated', path.basename(process.argv[1])), 'x'); }
if (process.env.FAKE_BREAKS) process.stdout.write(process.env.FAKE_BREAKS);
if (process.env.FAKE_TOOL_ERR) process.stderr.write(process.env.FAKE_TOOL_ERR);
process.exit(Number(process.env.FAKE_TOOL_CODE || 0));
`;

/** Fake Godot: runs GUT by sending a result with one test per tool_tests file of the prefix. */
const GODOT = `
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, 'godot ' + JSON.stringify(args) + '\\n');
if (args.includes('--import')) process.exit(process.env.FAKE_IMPORT_FAIL ? 3 : 0);
const get = (p) => (args.find((a) => a.startsWith(p)) || '').slice(p.length);
const project = args[args.indexOf('--path') + 1];
const dir = path.join(project, get('-gdir=res://'));
const prefix = get('-gprefix=');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(prefix)) : [];
const generated = fs.existsSync(path.join(project, 'generated')) ? fs.readdirSync(path.join(project, 'generated')).sort().join(',') : '';
const fail = process.env.FAKE_GODOT_FAIL === prefix;
const results = files.map((f) => ({ name: f + ':' + generated, status: fail ? 'fail' : 'pass', message: fail ? 'decoded differs' : '' }));
const cfg = JSON.parse(fs.readFileSync(get('-gconfig='), 'utf8'));
fs.appendFileSync(process.env.FAKE_LOG, 'config ' + JSON.stringify(cfg) + '\\n');
// a run that never starts: no PUT /started, no result
if (process.env.FAKE_GODOT_STALL) setInterval(() => undefined, 1000);
else
fetch(cfg.ogw_test_host + '/result', { method: 'PUT', body: JSON.stringify({ run_id: cfg.ogw_run_id, results, run_failures: [] }) }).then(() => process.exit(fail ? 1 : 0));
`;

const REPORT_OK = JSON.stringify({
  testResults: [{ name: 'tests/a.test.ts', status: 'passed', message: '', assertionResults: [{ title: 'a', status: 'passed', failureMessages: [] }, { title: 'b', status: 'passed', failureMessages: [] }] }],
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface Env {
  ws: TestWorkspace;
  ctx: Context;
  env: NodeJS.ProcessEnv;
  log: () => string[];
}

function context(ws: TestWorkspace, env: NodeJS.ProcessEnv): Context {
  return createContext({ cwd: ws.root, env: { ...ws.env, ...env }, stdin: () => Promise.resolve(''), stderr: () => undefined });
}

/** A `godot` core test record that passed every client module of main's `core-spec/`: the round trip runs after it. */
async function clientCoreRecord(ws: TestWorkspace): Promise<void> {
  const modules = Object.fromEntries(
    sh(ws.coreImpl, 'git', ['ls-tree', '--name-only', 'main', 'core-spec/']).split('\n').filter((p) => p.endsWith('.json')).map((p) => [p.slice('core-spec/'.length, -'.json'.length), 'pass' as const]),
  );
  await addTestRecord(ws.coreImpl, { commit: sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim(), target: 'godot', modules, recordedAt: 1 });
}

function setup(extra: NodeJS.ProcessEnv = {}, engine = false): Env {
  const ws = makeWorkspace();
  writeImpl(ws.coreImpl);
  if (!engine) sh(ws.coreImpl, 'rm', ['-r', 'client']);
  // the round trip runs on the GUT hooks of UnitTestCore
  else writeFiles(ws.coreImpl, { 'client/godot/core/unit_test_core/dev/gut_pre_run.gd': 'extends GutHookScript\n' });
  for (const tool of TOOLS) writeFiles(ws.coreImpl, { [`tools/${tool}/tool.js`]: TOOL });
  const logFile = join(ws.root, 'fake.log');
  writeFileSync(logFile, '');
  fakeBin(ws, 'npm', NPM);
  fakeBin(ws, 'godot', GODOT);
  const vitest = join(ws.root, 'vitest.js');
  writeFileSync(vitest, VITEST);
  vi.mocked(requireEngine).mockResolvedValue(join(ws.root, 'bin', 'godot'));
  const env = pathEnv(ws, { FAKE_LOG: logFile, FAKE_VITEST: vitest, FAKE_REPORT_CONTRACT_TOOL: REPORT_OK, FAKE_REPORT_DATA_TOOL: REPORT_OK, ...extra });
  return { ws, env, ctx: context(ws, env), log: () => readFileSync(logFile, 'utf8').split('\n').filter((l) => l !== '') };
}

beforeEach(() => {
  vi.mocked(requireEngine).mockReset();
});

describe('buildTool', () => {
  it('runs npm ci and npm run build once per command run and returns bin/<tool>.js', async () => {
    const { ws, ctx, log } = setup();
    const entry = await buildTool(ctx.env, ws.coreImpl, 'contract-tool');
    expect(entry).toBe(join(ws.coreImpl, 'tools/contract-tool/bin/contract-tool.js'));
    expect(readFileSync(entry, 'utf8')).toBe(TOOL);
    expect(await buildTool(ctx.env, ws.coreImpl, 'contract-tool')).toBe(entry);
    expect(log()).toEqual(['contract-tool npm ci --no-audit --no-fund', 'contract-tool npm run build']);
    await buildTool({ ...ctx.env }, ws.coreImpl, 'contract-tool');
    expect(log()).toHaveLength(4);
    expect(sh(ws.coreImpl, 'git', ['status', '--porcelain', '--', 'tools'])).toContain('tool.js');
    expect(sh(ws.coreImpl, 'git', ['status', '--porcelain', '--', 'tools'])).not.toContain('bin/');
  });

  it('removes a node_modules link before npm ci, so the build does not write into the folder it points to', async () => {
    const { ws, ctx } = setup();
    const other = join(ws.root, 'other-checkout-node_modules');
    mkdirSync(join(other, 'kept'), { recursive: true });
    symlinkSync(other, join(ws.coreImpl, 'tools/contract-tool/node_modules'), 'dir');
    await buildTool(ctx.env, ws.coreImpl, 'contract-tool');
    expect(existsSync(join(other, 'kept'))).toBe(true);
    expect(existsSync(join(other, '.bin'))).toBe(false);
    expect(lstatSync(join(ws.coreImpl, 'tools/contract-tool/node_modules')).isSymbolicLink()).toBe(false);
  });

  it('fails without package.json, when npm fails, and when the build makes no bin file', async () => {
    const { ws, env } = setup();
    sh(ws.coreImpl, 'rm', ['tools/data-tool/package.json']);
    await expect(buildTool({ ...env }, ws.coreImpl, 'data-tool')).rejects.toThrow(`data-tool: no tools/data-tool/package.json in ${ws.coreImpl}`);
    await expect(buildTool({ ...env, FAKE_NPM_FAIL: 'ci --no-audit --no-fund' }, ws.coreImpl, 'contract-tool')).rejects.toThrow('contract-tool: npm ci --no-audit --no-fund failed (3):\nnpm says no');
    await expect(buildTool({ ...env, FAKE_NPM_FAIL: 'run build' }, ws.coreImpl, 'contract-tool')).rejects.toThrow('contract-tool: npm run build failed (3)');
    await expect(buildTool({ ...env, FAKE_NO_BIN: '1' }, ws.coreImpl, 'contract-tool')).rejects.toThrow('contract-tool: npm run build made no bin/contract-tool.js');
    const failing: NodeJS.ProcessEnv = { ...env, FAKE_NPM_FAIL: 'ci --no-audit --no-fund' };
    await expect(buildTool(failing, ws.coreImpl, 'contract-tool')).rejects.toThrow('npm ci --no-audit --no-fund failed');
    failing.FAKE_NPM_FAIL = '';
    await expect(buildTool(failing, ws.coreImpl, 'contract-tool')).resolves.toContain('bin/contract-tool.js');
  });

  it('stages bin/<tool>.js and lists the tools that have package.json', async () => {
    const { ws, ctx } = setup();
    const stage = join(ws.root, 'stage');
    await stageToolPackage(ctx.env, ws.coreImpl, 'data-tool', stage);
    expect(readFileSync(join(stage, 'bin', 'data-tool.js'), 'utf8')).toBe(TOOL);
    expect(implementedTools(ws.coreImpl)).toEqual(['contract-tool', 'data-tool']);
    sh(ws.coreImpl, 'rm', ['tools/contract-tool/package.json']);
    expect(implementedTools(ws.coreImpl)).toEqual(['data-tool']);
  });
});

describe('runToolTest', () => {
  it('runs the vitest tests of the tool and passes without engines', async () => {
    const { ws, ctx, log } = setup();
    expect(await runToolTest(ctx, ws.coreImpl, 'data-tool')).toEqual({ tests: 2, passed: 2, failures: [], ran: true });
    expect(log()).toEqual(['data-tool npm ci --no-audit --no-fund', 'data-tool npm run build', 'vitest run --reporter=json']);
  });

  it('fails on failing tests, a missing report, a non-zero exit and a missing vitest', async () => {
    const { ws, env } = setup();
    const failing = JSON.stringify({ testResults: [{ name: 'tests/a.test.ts', status: 'failed', assertionResults: [{ ancestorTitles: ['d'], title: 't', status: 'failed', failureMessages: ['bad\n at x'] }] }] });
    const run = (extra: NodeJS.ProcessEnv): ReturnType<typeof runToolTest> => runToolTest(context(ws, { ...env, ...extra }), ws.coreImpl, 'contract-tool');
    expect(await run({ FAKE_REPORT_CONTRACT_TOOL: failing, FAKE_VITEST_CODE: '1' })).toEqual({ tests: 1, passed: 0, failures: ['contract-tool vitest: tests/a.test.ts::d > t bad'], ran: true });
    expect(await run({ FAKE_REPORT_CONTRACT_TOOL: '' })).toEqual({ tests: 0, passed: 0, failures: ['contract-tool vitest: the test run wrote no result:'], ran: true });
    expect((await run({ FAKE_VITEST_CODE: '2' })).failures).toEqual(['contract-tool vitest: run failure: vitest ended with exit code 2:']);
    expect(await run({ FAKE_REPORT_CONTRACT_TOOL: JSON.stringify({ testResults: [] }) })).toEqual({ tests: 0, passed: 0, failures: ['contract-tool vitest: run failure: no tests'], ran: true });
    sh(ws.coreImpl, 'rm', ['-r', 'tools/contract-tool/node_modules']);
    expect(await run({ FAKE_VITEST: '' })).toEqual({ tests: 0, passed: 0, failures: ['contract-tool: no node_modules/.bin/vitest (vitest is not a devDependency)'], ran: false });
    await expect(runToolTest(context(ws, env), ws.coreImpl, 'other')).rejects.toThrow('not a tool: other');
  });

  it('fails a skipped test, which is not a pass, and a test file that failed outside its tests', async () => {
    const { ws, env } = setup();
    const report = JSON.stringify({ testResults: [
      { name: 'tests/a.test.ts', status: 'passed', assertionResults: [{ title: 'p', status: 'passed' }, { title: 's', status: 'skipped' }, { title: 'o', status: 'todo' }] },
      { name: 'tests/b.test.ts', status: 'failed', message: 'SyntaxError: x\nmore', assertionResults: [] },
    ] });
    expect(await runToolTest(context(ws, { ...env, FAKE_REPORT_DATA_TOOL: report, FAKE_VITEST_CODE: '1' }), ws.coreImpl, 'data-tool')).toEqual({ tests: 3, passed: 1, failures: [
      'data-tool vitest: tests/a.test.ts::s skipped; a tool test does not skip',
      'data-tool vitest: tests/a.test.ts::o skipped; a tool test does not skip',
      'data-tool vitest: run failure: tests/b.test.ts: SyntaxError: x',
    ], ran: true });
  });


  it('runs the Godot round trip of the tool on a copy with the generated code of both tools', async () => {
    const { ws, ctx, log } = setup({}, true);
    writeFiles(ws.coreImpl, {
      'tools/tests/game/settings.json': { engine: 'godot' },
      'tools/tests/game/contract/game.proto': 'syntax = "proto3";\n',
      'tools/tests/godot/test_contract_roundtrip.gd': 'extends UnitTestCase\n',
      'tools/tests/godot/test_data_roundtrip.gd': 'extends UnitTestCase\n',
    });
    // until a godot core test passed every client module, the client core does not compile as a whole: no round trip,
    // and the tool is `skipped` with the reason
    expect(await runToolTest(ctx, ws.coreImpl, 'contract-tool')).toEqual({
      tests: 2,
      passed: 2,
      failures: [],
      ran: true,
      skipped: 'godot round trip left out: no core test of the engine has passed every client module yet',
    });
    expect(log().some((l) => l.includes('gut_cmdln'))).toBe(false);
    await clientCoreRecord(ws);
    const outcome = await runToolTest(ctx, ws.coreImpl, 'contract-tool');
    expect(outcome).toEqual({ tests: 3, passed: 3, failures: [], ran: true });
    const lines = log();
    const gut = lines.find((l) => l.startsWith('godot ') && l.includes('gut_cmdln')) ?? '';
    const args = JSON.parse(gut.slice('godot '.length)) as string[];
    expect(args).toContain('-gdir=res://tool_tests');
    expect(args).toContain(`-gprefix=${GODOT_PREFIX['contract-tool']}`);
    const config = JSON.parse((lines.find((l) => l.startsWith('config ')) ?? 'config {}').slice('config '.length)) as Record<string, string>;
    expect(config.ogw_core_fixture_dir).toBe(join(ws.coreImpl, 'fixtures'));
    const tools = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as { tool: string; args: string[] });
    expect(tools.map((t) => t.tool)).toEqual(['data-tool.js', 'contract-tool.js']);
    expect(tools[0]?.args.slice(2, 4)).toEqual(['--engine', 'godot']);
    // the thrown-away test game copy is matched and issued in full: no binary build
    expect(tools[0]?.args).not.toContain('--binary');
    expect(existsSync(join(ws.coreImpl, 'client/godot/tool_tests'))).toBe(false);
    expect(existsSync(join(ws.coreImpl, 'client/godot/generated'))).toBe(false);
    // the tool's own tests are its vitest tests: without vitest they did not run, though the round trip did
    sh(ws.coreImpl, 'rm', ['-r', 'tools/contract-tool/node_modules']);
    const noVitest = await runToolTest(context(ws, { ...ctx.env, FAKE_VITEST: '' }), ws.coreImpl, 'contract-tool');
    expect(noVitest.ran).toBe(false);
    expect(noVitest.passed).toBeGreaterThan(0);
    // a round trip step before GUT that throws fails the round trip and keeps the vitest outcome
    const importFailed = await runToolTest(context(ws, { ...ctx.env, FAKE_IMPORT_FAIL: '1', FAKE_REPORT_DATA_TOOL: JSON.stringify({ testResults: [{ name: 'tests/a.test.ts', status: 'failed', assertionResults: [{ ancestorTitles: ['d'], title: 't', status: 'failed', failureMessages: ['bad'] }] }] }), FAKE_VITEST_CODE: '1' }), ws.coreImpl, 'data-tool');
    expect(importFailed.ran).toBe(true);
    expect(importFailed.failures[0]).toBe('data-tool vitest: tests/a.test.ts::d > t bad');
    expect(importFailed.failures.some((f) => f.startsWith('godot round trip: '))).toBe(true);
    const failed = await runToolTest(context(ws, { ...ctx.env, FAKE_GODOT_FAIL: 'test_data_' }), ws.coreImpl, 'data-tool');
    expect(failed.failures).toEqual([
      'godot round trip: test_data_roundtrip.gd:contract-tool.js,data-tool.js: decoded differs',
      'godot round trip: exit code 1',
    ]);
    // with the start limit in the core settings, a round trip run that never starts ends at that limit
    const settingsPath = join(ws.coreImpl, 'settings', 'core-settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    writeFiles(ws.coreImpl, { 'settings/core-settings.json': { ...settings, 'UnitTestCore.startTimeLimitMs': 300 } });
    const stalled = await runToolTest(context(ws, { ...ctx.env, FAKE_GODOT_STALL: '1' }), ws.coreImpl, 'data-tool');
    expect(stalled.failures).toContain('godot round trip: the run did not start within 300 ms (no PUT /started)');
  }, 60_000);

  it('builds only the tool it tests while every engine round trip is left out', async () => {
    const { ws, ctx, log } = setup({}, true);
    expect(await runToolTest(ctx, ws.coreImpl, 'contract-tool')).toMatchObject({ tests: 2, passed: 2, failures: [], ran: true });
    expect(log().filter((l) => l.endsWith('npm ci --no-audit --no-fund'))).toEqual(['contract-tool npm ci --no-audit --no-fund']);
  });

  it('fails the round trip without the test game or the Godot tests', async () => {
    const { ws, ctx } = setup({}, true);
    await clientCoreRecord(ws);
    expect((await runToolTest(ctx, ws.coreImpl, 'data-tool')).failures).toEqual(['godot round trip: no tools/tests/game/']);
    writeFiles(ws.coreImpl, { 'tools/tests/game/settings.json': {} });
    expect((await runToolTest(ctx, ws.coreImpl, 'data-tool')).failures).toEqual(['godot round trip: no tools/tests/godot/']);
    writeFiles(ws.coreImpl, { 'tools/tests/godot/test_contract_x.gd': '' });
    expect((await runToolTest(ctx, ws.coreImpl, 'data-tool')).failures).toEqual(['godot round trip: no tests']);
  });
});

describe('compareBaseProto and baseProtoBreaks', () => {
  function previous(ws: TestWorkspace): { proto: string; coreSettings: string } {
    writeFiles(ws.root, { 'prev/proto/ogw/core.proto': 'old proto\n', 'prev/core-settings.json': '{"a": 1}\n' });
    return { proto: join(ws.root, 'prev/proto'), coreSettings: join(ws.root, 'prev/core-settings.json') };
  }

  it('runs the contract tool of open-game-works-core-impl/ with --base-proto-only and returns its violation lines', async () => {
    const { ws, ctx, log } = setup();
    expect(await compareBaseProto(ctx, ws.coreImpl, previous(ws))).toEqual([]);
    const call = JSON.parse(log().at(-1) ?? '') as { args: string[]; previous: string[]; proto: string; settings: string; current: string };
    expect(call.args.slice(0, 4)).toEqual(['--base-proto-only', '--base-proto', join(ws.coreImpl, 'proto'), '--core-settings']);
    expect(call.current).toBe(readFileSync(join(ws.coreImpl, 'settings', 'core-settings.json'), 'utf8'));
    expect(call.args[5]).toBe('--previous');
    expect(call.previous).toEqual(['core-settings.json', 'proto']);
    expect([call.proto, call.settings]).toEqual(['old proto\n', '{"a": 1}\n']);
    const breaks = context(ws, { ...ctx.env, FAKE_TOOL_CODE: '1', FAKE_BREAKS: 'proto/ogw/core.proto:3:1 ERROR field removed\n\nproto/ogw/core.proto:9:1 ERROR rpc removed\n' });
    expect(await compareBaseProto(breaks, ws.coreImpl, previous(ws))).toEqual(['proto/ogw/core.proto:3:1 ERROR field removed', 'proto/ogw/core.proto:9:1 ERROR rpc removed']);
  });

  it('passes {} for core settings that the lower release or open-game-works-core-impl/ does not have', async () => {
    const { ws, ctx, log } = setup();
    rmSync(join(ws.coreImpl, 'settings', 'core-settings.json'));
    const prev = previous(ws);
    rmSync(prev.coreSettings);
    expect(await compareBaseProto(ctx, ws.coreImpl, prev)).toEqual([]);
    const call = JSON.parse(log().at(-1) ?? '') as { settings: string; current: string };
    expect([call.settings, call.current]).toEqual(['{}\n', '{}\n']);
  });

  it('fails when the contract tool fails without violation lines', async () => {
    const { ws, ctx } = setup();
    await expect(compareBaseProto(context(ws, { ...ctx.env, FAKE_TOOL_CODE: '2', FAKE_TOOL_ERR: 'bad --previous' }), ws.coreImpl, previous(ws)))
      .rejects.toThrow('contract-tool --base-proto-only failed (2):\nbad --previous');
    await expect(compareBaseProto(context(ws, { ...ctx.env, FAKE_TOOL_CODE: '1' }), ws.coreImpl, previous(ws))).rejects.toThrow('contract-tool --base-proto-only failed (1)');
  });

  it('compares with the published release even when useLocalCore is true', async () => {
    const ws = makeWorkspace({ useLocalCore: true });
    writeImpl(ws.coreImpl);
    sh(ws.coreImpl, 'rm', ['-r', 'client']);
    for (const tool of TOOLS) writeFiles(ws.coreImpl, { [`tools/${tool}/tool.js`]: TOOL });
    const logFile = join(ws.root, 'fake.log');
    writeFileSync(logFile, '');
    fakeBin(ws, 'npm', NPM);
    const { writeTgz } = await import('../../../../src/commands/core/lib/archive.ts');
    writeFiles(ws.root, { 'tgz/proto/ogw/core.proto': 'released proto\n', 'tgz/bin/contract-tool.js': '' });
    const source = makeReleaseDir(join(ws.root, 'r'), '1.0.0', { 'core-settings.json': '{"b": 2}\n' });
    await writeTgz(join(source, 'contract-tool.tgz'), join(ws.root, 'tgz'), ['bin/contract-tool.js', 'proto/ogw/core.proto']);
    const assets = { 'core-settings.json': sha256(readFileSync(join(source, 'core-settings.json'))), 'contract-tool.tgz': sha256(readFileSync(join(source, 'contract-tool.tgz'))) };
    writeFileSync(join(source, 'manifest.json'), JSON.stringify({ version: '1.0.0', assets, coreSchemaVersion: 1 }));
    const gh = fakeGh(ws, { 'v1.0.0': source });
    const ctx = context(ws, pathEnv(ws, { ...gh.env, FAKE_LOG: logFile }));
    expect(await baseProtoBreaks(ctx, ws.coreImpl, '1.0.0')).toEqual([]);
    const call = JSON.parse(readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('{')).at(-1) ?? '') as { proto: string; settings: string };
    expect([call.proto, call.settings]).toEqual(['released proto\n', '{"b": 2}\n']);
    expect(existsSync(join(ws.coreReleases, '1.0.0', 'manifest.json'))).toBe(true);
  });
});

describe('readCoreSchemaVersion', () => {
  it('reads the integer line, 0 without the file, and fails on anything else', async () => {
    const { ws } = setup();
    expect(await readCoreSchemaVersion(ws.coreImpl)).toBe(0);
    const file = 'server/core/storage/core-schema-version';
    writeFiles(ws.coreImpl, { [file]: '12\n' });
    expect(await readCoreSchemaVersion(ws.coreImpl)).toBe(12);
    writeFiles(ws.coreImpl, { [file]: '0' });
    expect(await readCoreSchemaVersion(ws.coreImpl)).toBe(0);
    for (const bad of ['', 'x\n', '01\n', '-1\n', '3\n4\n', ' 3\n']) {
      writeFiles(ws.coreImpl, { [file]: bad });
      await expect(readCoreSchemaVersion(ws.coreImpl)).rejects.toThrow(`${file} must be one line with an integer of 0 or more: ${JSON.stringify(bad)}`);
    }
  });
});
