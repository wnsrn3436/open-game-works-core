// The fake engine, browser, tools and docker of the `ogw core test` tests, and the workspace they run in. The test
// files mock `tools.ts` and `env/api.ts`, whose functions `setup` points at the fakes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { buildTool } from '../../../src/commands/core/lib/tools.ts';
import { requireEngine, toolProgram } from '../../../src/commands/env/api.ts';
import { commitAll, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeBin, pathEnv, writeFiles } from './helpers.ts';
import { writeImpl } from './impl-fixture.ts';

/** Fake Godot: imports, exports, and runs GUT by sending a result to the test host. `FAKE_FAIL` names a failing module folder. */
export const GODOT = `
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n');
if (args.includes('--import')) {
  // like Godot 4.4 and later, the import gives a script without a .uid one (the fixture's own scripts have none: only
  // the generated folder is walked)
  const project = args[args.indexOf('--path') + 1];
  const walk = (dir) => { if (!fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'addons' && e.name !== '.godot') walk(p); } else if (p.endsWith('.gd') && !fs.existsSync(p + '.uid')) fs.writeFileSync(p + '.uid', 'uid://x\\n'); } };
  if (process.env.FAKE_UIDS) walk(path.join(project, 'generated'));
  process.exit(0);
}
const exp = args.indexOf('--export-debug');
if (exp >= 0) {
  const out = args[exp + 2]; fs.writeFileSync(out, '<script>const GODOT_CONFIG = {"args":[],"executable":"index"};</script>');
  fs.writeFileSync(path.join(path.dirname(out), 'index.wasm'), 'w');
  fs.writeFileSync(path.join(path.dirname(out), 'index.service.worker.js'), 'const CACHE_VERSION = "v1";\\n');
  const project = args[args.indexOf('--path') + 1];
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ fixtures: fs.readdirSync(path.join(project, 'core_fixtures')), preset: fs.readFileSync(path.join(project, 'export_presets.cfg'), 'utf8').includes('variant/thread_support=true') && fs.readFileSync(path.join(project, 'export_presets.cfg'), 'utf8').includes('script_export_mode=0'), filter: (/include_filter="([^"]*)"/.exec(fs.readFileSync(path.join(project, 'export_presets.cfg'), 'utf8')) || [])[1], addons: fs.readdirSync(path.join(project, 'addons')), extensionList: fs.existsSync(path.join(project, '.godot', 'extension_list.cfg')), mainScene: (/run\\/main_scene="([^"]*)"/.exec(fs.readFileSync(path.join(project, 'project.godot'), 'utf8')) || [])[1], runner: fs.readFileSync(path.join(project, 'ogw_web_runner.tscn'), 'utf8').includes('res://ogw_web_runner.gd') && fs.readFileSync(path.join(project, 'ogw_web_runner.gd'), 'utf8').includes('res://addons/gut/cli/gut_cli.gd') }) + '\\n');
  process.exit(0);
}
const get = (p) => (args.find((a) => a.startsWith(p)) || '').slice(p.length);
const cfgPath = (args.find((a) => a.startsWith('-gconfig=')) || '').slice('-gconfig='.length);
const cfg = cfgPath ? JSON.parse(require('node:fs').readFileSync(cfgPath, 'utf8')) : {};
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ config: cfg }) + '\\n');
const folder = get('-gdir=res://core/');
const failing = folder === process.env.FAKE_FAIL;
// a GUT run that ends at its start, with no result
if (folder === process.env.FAKE_NO_RESULT) process.exit(2);
const render = get('-gprefix=') === 'test_render_';
const dataDir = process.env[process.env.FAKE_DATA_VAR] || null;
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ dataDir, dataDirExists: dataDir !== null && fs.existsSync(dataDir) }) + '\\n');
if (process.env.FAKE_PROJECT_LOCK) { const readers = process.env.FAKE_PROJECT_LOCK + '-readers'; fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ projectLocked: fs.existsSync(readers) && fs.readdirSync(readers).length > 0 }) + '\\n'); }
const body = { run_id: cfg.ogw_run_id, kind: 'core', engine: 'godot', results: [{ name: folder + '::' + (render ? 'render' : 'test'), status: failing ? 'fail' : 'pass', duration_ms: 1, message: failing ? 'expected 1' : '' }], run_failures: [] };
const startedAt = Date.now();
setTimeout(() => fetch(cfg.ogw_test_host + '/result', { method: 'PUT', body: JSON.stringify(body) }).then(() => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ span: [startedAt, Date.now()], folder, render }) + '\\n');
  process.exit(failing ? 1 : 0);
}), Number(process.env.FAKE_DELAY || 0));
`;

/** Fake Chromium: reads GODOT_CONFIG.args from index.html and sends a result; logs a console line. */
export const CHROMIUM = `
const url = process.argv[process.argv.length - 1];
(async () => {
  const html = await (await fetch(url)).text();
  const args = JSON.parse(/"args":(\\[[^\\]]*\\])/.exec(html)[1]);
  const get = (p) => (args.find((a) => a.startsWith(p)) || '').slice(p.length);
  // the test run config comes in the page URL query
  const query = new URL(url).searchParams;
  process.stderr.write('[1:INFO:CONSOLE(1)] "' + (query.get('ogw_core_fixture_dir') === 'res://core_fixtures' && !args.some((a) => a.startsWith('-gconfig=') || a === '-s') && process.argv.includes('--autoplay-policy=no-user-gesture-required') ? 'ok' : 'ERROR: fixtures') + '", source: x\\n');
  const folder = get('-gdir=res://core/');
  await fetch(query.get('ogw_test_host') + '/result', { method: 'PUT', body: JSON.stringify({ run_id: query.get('ogw_run_id'), results: [{ name: folder + '::web', status: 'pass' }], run_failures: [] }) });
  // a release that prints a second after the result, then the release signal and the last line of the run
  if (process.env.FAKE_RELEASE_ERROR) await new Promise((r) => setTimeout(r, 1000));
  if (process.env.FAKE_RELEASE_ERROR) process.stderr.write('[1:INFO:CONSOLE(2)] "ERROR: release", source: x\\n');
  await fetch(query.get('ogw_test_host') + '/released', { method: 'PUT', body: JSON.stringify({ run_id: query.get('ogw_run_id') }) });
  process.stderr.write('[1:INFO:CONSOLE(3)] "UnitTestCore released run ' + query.get('ogw_run_id') + '", source: x\\n');
  setInterval(() => undefined, 1000);
})();
`;

export const DATA_TOOL = `
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: 'data', args }) + '\\n');
const read = (flag) => JSON.parse(fs.readFileSync(args[args.indexOf(flag) + 1], 'utf8'));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ dataInputs: { coreSpec: read('--core-spec'), modules: read('--modules'), gameSettings: read('--game-settings'), registry: read('--id-registry') } }) + '\\n');
fs.writeFileSync(args[args.indexOf('--id-registry') + 1], JSON.stringify({ '[known]': 1 }));
if (process.env.FAKE_DATA_FAIL) { process.stdout.write('data/tables/x.csv:2 ERROR structure'); process.exit(1); }
if (process.env.FAKE_MATCH && !args.includes('--binary')) {
  const file = require('node:path').join(args[args.indexOf('--game') + 1], 'data', 'translations', 'en.csv');
  fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
  fs.writeFileSync(file, 'key,source,source_hash,current_hash,text\\nmatched,M,h,h,M\\n');
}
if (process.env.FAKE_GENERATED_SCRIPT) {
  const dir = require('node:path').join(process.cwd(), 'client', 'godot', 'generated', 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(require('node:path').join(dir, 'new_table.gd'), 'class_name NewTable\\n');
}
`;

export const CONTRACT_TOOL = `
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: 'contract', args: process.argv.slice(2) }) + '\\n');
`;

export const DOCKER = `
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ docker: args }) + '\\n');
if (args[0] === 'create') { process.stdout.write('cid123\\n'); process.exit(0); }
if (args[0] === 'cp') { fs.writeFileSync(process.env.FAKE_LOG + '.tar', fs.readFileSync(0)); process.exit(0); }
if (args[0] === 'port') { process.stdout.write('127.0.0.1:5555\\n'); process.exit(0); }
process.exit(0);
`;

export interface Setup {
  ws: TestWorkspace;
  env: NodeJS.ProcessEnv;
  log: () => unknown[];
}

export function setup(): Setup {
  const ws = makeWorkspace();
  writeImpl(ws.coreImpl);
  writeFiles(ws.coreImpl, { 'client/godot/core/ui_core/tests/test_render_ui.gd': 'extends UnitTestCase\n' });
  commitAll(ws.coreImpl, 'render test');
  const logFile = join(ws.root, 'fake.log');
  writeFileSync(logFile, '');
  fakeBin(ws, 'godot', GODOT);
  fakeBin(ws, 'chromium', CHROMIUM);
  fakeBin(ws, 'docker', DOCKER);
  const tools = join(ws.root, 'tools');
  mkdirSync(tools);
  writeFileSync(join(tools, 'data-tool.js'), DATA_TOOL);
  writeFileSync(join(tools, 'contract-tool.js'), CONTRACT_TOOL);
  vi.mocked(buildTool).mockImplementation((_env, _impl, tool) => Promise.resolve(join(tools, `${tool}.js`)));
  vi.mocked(requireEngine).mockResolvedValue(join(ws.root, 'bin', 'godot'));
  vi.mocked(toolProgram).mockResolvedValue(join(ws.root, 'bin', 'chromium'));
  return {
    ws,
    env: pathEnv(ws, { FAKE_LOG: logFile }),
    log: () => readFileSync(logFile, 'utf8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as unknown),
  };
}
