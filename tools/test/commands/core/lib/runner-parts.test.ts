import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startTestHost } from '../../../../src/commands/check/api.ts';
import { addOutcomes, appFolder, consoleMessages, gutArgs, gutPass, judgeRun, WEB_LOADING_PAGES, releasedLine, releasedOrDrained, testRunConfigQuery, waitForResult, webModuleTest, withConfigArgs } from '../../../../src/commands/core/lib/godot.ts';
import { createContext } from '../../../../src/lib/command.ts';
import { chmodSync } from 'node:fs';
import { runModulePool } from '../../../../src/commands/core/lib/ready-queue.ts';
import { longestFirst } from '../../../../src/commands/core/test.ts';
import { makeWorkspace } from '../../../helpers/workspace.ts';

describe('browser run helpers', () => {
  it('waits for the result the test host received', async () => {
    const host = await startTestHost();
    try {
      expect(await waitForResult(host, 10)).toBeNull();
      const waiting = waitForResult(host, 5000);
      expect((await fetch(`${host.url}/result`, { method: 'PUT', body: '{"run_id":"r"}' })).status).toBe(204);
      expect(await waiting).toEqual({ run_id: 'r' });
    } finally {
      await host.close();
    }
  });

  it('serves the export with an index.html carrying the run arguments', async () => {
    const exportDir = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-export-')));
    writeFileSync(join(exportDir, 'index.html'), 'const GODOT_CONFIG = {"args":[]};');
    writeFileSync(join(exportDir, 'index.wasm'), 'w');
    mkdirSync(join(exportDir, 'sub'));
    writeFileSync(join(exportDir, 'sub', 'a.bin'), 'b');
    const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-app-')));
    const host = await startTestHost(appDir);
    try {
      await appFolder(exportDir, appDir, ['-a', '--b=c']);
      expect(await (await fetch(`${host.url}/app/index.html`)).text()).toBe('const GODOT_CONFIG = {"args":["-a","--b=c"]};');
      expect(await (await fetch(`${host.url}/app/index.wasm`)).text()).toBe('w');
      expect(await (await fetch(`${host.url}/app/sub/a.bin`)).text()).toBe('b');
      expect(readFileSync(join(exportDir, 'index.html'), 'utf8')).toBe('const GODOT_CONFIG = {"args":[]};');
    } finally {
      await host.close();
    }
  });
});

describe('browser run with no result', () => {
  it('shows the last lines of the browser output', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-web-')));
    const exportDir = join(dir, 'export');
    mkdirSync(exportDir);
    writeFileSync(join(exportDir, 'index.html'), '<script>const GODOT_CONFIG = {"args":[],"executable":"index"};</script>');
    // a browser that never sends a result and prints why
    const chromium = join(dir, 'chromium');
    writeFileSync(chromium, `#!${process.execPath}\nprocess.stderr.write('ERROR:gpu_init.cc(1)] WebGL2 not available\\n'); setTimeout(() => undefined, 60000);\n`);
    chmodSync(chromium, 0o755);
    // a workspace env keeps the private temp folders out of the real harness repo
    const ctx = createContext({ cwd: dir, env: makeWorkspace().env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const outcome = await webModuleTest(ctx, { chromium, exportDir, module: 'LogCore', resultsDir: join(dir, 'results'), timeoutMs: 1500, startLimitMs: null });
    expect(outcome.failures).toContain('browser run: no result within 1500 ms');
    expect(outcome.failures).toContain('browser run: browser: ERROR:gpu_init.cc(1)] WebGL2 not available');
  }, 20_000);
});

describe('browser run whose page did not load', () => {
  it('ends the run at once when the browser cuts off an /app/ file, and opens the page once more', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-web-')));
    const exportDir = join(dir, 'export');
    mkdirSync(exportDir);
    writeFileSync(join(exportDir, 'index.html'), '<script>const GODOT_CONFIG = {"args":[],"executable":"index"};</script>');
    writeFileSync(join(exportDir, 'index.wasm'), Buffer.alloc(64 * 1024 * 1024));
    // a browser that starts loading the wasm, drops the connection after the first chunk and sends no result
    const chromium = join(dir, 'chromium');
    writeFileSync(chromium, `#!${process.execPath}
const fs = require('node:fs');
const http = require('node:http');
fs.appendFileSync(${JSON.stringify(join(dir, 'launches'))}, 'x');
const page = new URL(process.argv[process.argv.length - 1]);
const req = http.get(new URL('/app/index.wasm', page.origin), (res) => res.once('data', () => req.destroy()));
req.on('error', () => undefined);
setTimeout(() => undefined, 60000);
`);
    chmodSync(chromium, 0o755);
    const ctx = createContext({ cwd: dir, env: makeWorkspace().env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const started = Date.now();
    const outcome = await webModuleTest(ctx, { chromium, exportDir, module: 'LogCore', resultsDir: join(dir, 'results'), timeoutMs: 60_000, startLimitMs: null });
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(outcome.failures).toContain('browser run: the page did not load: the browser closed index.wasm before it was sent to the end');
    expect(readFileSync(join(dir, 'launches'), 'utf8')).toBe('xx');
  }, 60_000);
});

describe('a run that does not start', () => {
  it('ends a browser run that sends no PUT /started within the start limit, opens the page once more, and keeps one that started', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-web-')));
    const exportDir = join(dir, 'export');
    mkdirSync(exportDir);
    writeFileSync(join(exportDir, 'index.html'), '<script>const GODOT_CONFIG = {"args":[],"executable":"index"};</script>');
    const browser = (start: boolean): string => {
      const path = join(dir, start ? 'starts' : 'stalls');
      writeFileSync(path, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(join(dir, start ? 'launches-start' : 'launches-stall'))}, 'x');
const page = new URL(process.argv[process.argv.length - 1]);
const host = page.searchParams.get('ogw_test_host');
const runId = page.searchParams.get('ogw_run_id');
if (${String(start)}) {
  fetch(host + '/started', { method: 'PUT', body: JSON.stringify({ run_id: runId }) }).then(() => new Promise((r) => setTimeout(r, 1500)))
    .then(() => fetch(host + '/result', { method: 'PUT', body: JSON.stringify({ results: [{ name: 'a::t', status: 'pass' }], run_failures: [] }) }));
}
setTimeout(() => undefined, 60000);
`);
      chmodSync(path, 0o755);
      return path;
    };
    const ctx = createContext({ cwd: dir, env: makeWorkspace().env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const started = Date.now();
    const stalled = await webModuleTest(ctx, { chromium: browser(false), exportDir, module: 'LogCore', resultsDir: join(dir, 'results'), timeoutMs: 60_000, startLimitMs: 500 });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(stalled.failures).toContain('browser run: the page did not start within 500 ms (no PUT /started)');
    expect(readFileSync(join(dir, 'launches-stall'), 'utf8')).toBe('xx');
    const ran = await webModuleTest(ctx, { chromium: browser(true), exportDir, module: 'LogCore', resultsDir: join(dir, 'results'), timeoutMs: 60_000, startLimitMs: 500 });
    expect(ran.failures.filter((f) => f.includes('did not start'))).toEqual([]);
    expect(ran.tests).toBe(1);
    expect(readFileSync(join(dir, 'launches-start'), 'utf8')).toBe('x');
  }, 60_000);

  it('loads at most WEB_LOADING_PAGES pages at once and runs the started pages together', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-web-')));
    const exportDir = join(dir, 'export');
    mkdirSync(exportDir);
    writeFileSync(join(exportDir, 'index.html'), '<script>const GODOT_CONFIG = {"args":[],"executable":"index"};</script>');
    const log = join(dir, 'log');
    // loads for 300 ms, sends PUT /started, then runs its tests for 1000 ms
    const chromium = join(dir, 'chromium');
    writeFileSync(chromium, `#!${process.execPath}
const fs = require('node:fs');
const page = new URL(process.argv[process.argv.length - 1]);
const host = page.searchParams.get('ogw_test_host');
const runId = page.searchParams.get('ogw_run_id');
const put = (path, body) => fetch(host + path, { method: 'PUT', body: JSON.stringify(body) });
fs.appendFileSync(${JSON.stringify(log)}, 'open ' + Date.now() + '\\n');
setTimeout(async () => {
  fs.appendFileSync(${JSON.stringify(log)}, 'started ' + Date.now() + '\\n');
  await put('/started', { run_id: runId });
  setTimeout(() => put('/result', { results: [{ name: 'a::t', status: 'pass' }], run_failures: [] }), 1000);
}, 300);
setTimeout(() => undefined, 60000);
`);
    chmodSync(chromium, 0o755);
    const ctx = createContext({ cwd: dir, env: makeWorkspace().env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const runs = Array.from({ length: WEB_LOADING_PAGES + 3 }, () =>
      webModuleTest(ctx, { chromium, exportDir, module: 'LogCore', resultsDir: join(dir, 'results'), timeoutMs: 60_000, startLimitMs: 30_000 }),
    );
    const outcomes = await Promise.all(runs);
    expect(outcomes.every((o) => o.tests === 1)).toBe(true);
    const events = readFileSync(log, 'utf8').trim().split('\n').map((l) => { const [kind, at] = l.split(' '); return { kind, at: Number(at) }; }).sort((a, b) => a.at - b.at);
    let loadingNow = 0;
    let most = 0;
    for (const e of events) {
      loadingNow += e.kind === 'open' ? 1 : -1;
      most = Math.max(most, loadingNow);
    }
    expect(most).toBeLessThanOrEqual(WEB_LOADING_PAGES);
    expect(most).toBeGreaterThan(1);
  }, 60_000);

  it('kills a native run that sends no PUT /started within the start limit', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-native-')));
    const godot = join(dir, 'godot');
    writeFileSync(godot, `#!${process.execPath}\nsetTimeout(() => undefined, 60000);\n`);
    chmodSync(godot, 0o755);
    const ctx = createContext({ cwd: dir, env: makeWorkspace().env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const started = Date.now();
    const outcome = await gutPass(ctx, { godot, project: dir, headless: true, gut: [], config: (runId, host) => ({ ogw_run_id: runId, ogw_test_host: host }), timeoutMs: 60_000, startLimitMs: 500, label: 'headless pass', resultsDir: join(dir, 'results') });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(outcome.failures).toContain('headless pass: the run did not start within 500 ms (no PUT /started)');
  }, 60_000);
});

describe('browser run page input', () => {
  /** A fake browser: a DevTools endpoint in its profile, two `POST /input`, then a passing result and the release signal. */
  function fakeBrowser(dir: string, listPage: boolean): string {
    const ws = resolve(import.meta.dirname, '..', '..', '..', '..', 'node_modules', 'ws');
    const script = join(dir, 'chromium');
    writeFileSync(script, `#!${process.execPath}
const { WebSocketServer } = require(${JSON.stringify(ws)});
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const profile = args.find((a) => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
const page = args[args.length - 1];
const query = new URL(page).searchParams;
const host = query.get('ogw_test_host');
const runId = query.get('ogw_run_id');
const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
server.on('connection', (socket) => socket.on('message', (data) => {
  const m = JSON.parse(String(data));
  if (m.method.startsWith('Input.')) fs.appendFileSync(path.join(${JSON.stringify(dir)}, 'input.log'), m.method + ' ' + JSON.stringify(m.params) + ' ' + m.sessionId + '\\n');
  const result = m.method === 'Target.getTargets' ? { targetInfos: ${listPage ? "[{ type: 'page', url: page, targetId: 'p' }]" : '[]'} } : m.method === 'Target.attachToTarget' ? { sessionId: 's9' } : {};
  socket.send(JSON.stringify({ id: m.id, result }));
}));
server.on('listening', async () => {
  fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), server.address().port + '\\n/devtools/browser/x\\n');
  const post = (body) => fetch(host + '/input', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.status);
  const statuses = [await post({ type: 'click', x: 3, y: 4 }), await post({ type: 'key', key: 'Enter' })];
  fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'statuses'), JSON.stringify(statuses));
  await fetch(host + '/result', { method: 'PUT', body: JSON.stringify({ results: [{ name: 'a::t', status: 'pass' }], run_failures: [] }) });
  await fetch(host + '/released', { method: 'PUT', body: JSON.stringify({ run_id: runId }) });
  process.stderr.write('[1:INFO:CONSOLE:1] "UnitTestCore released run ' + runId + '", source: x (1)\\n');
  setTimeout(() => undefined, 60000);
});
`);
    chmodSync(script, 0o755);
    return script;
  }

  async function run(listPage: boolean): Promise<{ dir: string; outcome: Awaited<ReturnType<typeof webModuleTest>> }> {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-web-input-')));
    const exportDir = join(dir, 'export');
    mkdirSync(exportDir);
    writeFileSync(join(exportDir, 'index.html'), '<script>const GODOT_CONFIG = {"args":[],"executable":"index"};</script>');
    // a workspace env keeps the private temp folders out of the real harness repo
    const ctx = createContext({ cwd: dir, env: makeWorkspace().env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const outcome = await webModuleTest(ctx, { chromium: fakeBrowser(dir, listPage), exportDir, module: 'SoundCore', resultsDir: join(dir, 'results'), timeoutMs: 15_000, startLimitMs: null });
    return { dir, outcome };
  }

  it('puts a POST /input into the run page through DevTools and answers 204 after it', async () => {
    const { dir, outcome } = await run(true);
    expect(outcome).toEqual({ tests: 1, passed: 1, failures: [] });
    expect(JSON.parse(readFileSync(join(dir, 'statuses'), 'utf8'))).toEqual([204, 204]);
    expect(readFileSync(join(dir, 'input.log'), 'utf8').trim().split('\n')).toEqual([
      'Input.dispatchMouseEvent {"type":"mousePressed","x":3,"y":4,"button":"left","clickCount":1} s9',
      'Input.dispatchMouseEvent {"type":"mouseReleased","x":3,"y":4,"button":"left","clickCount":1} s9',
      'Input.dispatchKeyEvent {"type":"keyDown","key":"Enter"} s9',
      'Input.dispatchKeyEvent {"type":"keyUp","key":"Enter"} s9',
    ]);
  }, 30_000);

  it('answers 500 for an input it could not put and reports the cause as a failure of the run', async () => {
    const { dir, outcome } = await run(false);
    expect(JSON.parse(readFileSync(join(dir, 'statuses'), 'utf8'))).toEqual([500, 500]);
    expect(outcome.failures.filter((f) => f.startsWith('browser run: input: '))).toEqual([
      expect.stringContaining('no browser page at http://127.0.0.1:') as string,
      expect.stringContaining('no browser page at http://127.0.0.1:') as string,
    ]);
  }, 30_000);
});

describe('module pool', () => {
  it('runs every module without waiting for its dependencies, keeps the concurrency, reports each, and counts a throw as fail', async () => {
    let running = 0;
    let peak = 0;
    const reported: string[] = [];
    const results = await runModulePool(['a', 'b', 'c', 'd'], 2, async (m) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      if (m === 'c') throw new Error('boom');
      return m === 'b' ? 'fail' : 'pass';
    }, (m, r) => {
      reported.push(`${m} ${r}`);
      return Promise.resolve();
    });
    expect([...results]).toEqual([['a', 'pass'], ['b', 'fail'], ['c', 'fail'], ['d', 'pass']]);
    expect(peak).toBe(2);
    expect(reported.sort()).toEqual(['a pass', 'b fail', 'c fail', 'd pass']);
  });

  it('runs a module once when it is given twice, and one at a time with a concurrency of 0', async () => {
    const order: string[] = [];
    const results = await runModulePool(['p', 'q', 'p'], 0, (m) => {
      order.push(m);
      return Promise.resolve('pass');
    }, () => Promise.resolve());
    expect(order).toEqual(['p', 'q']);
    expect([...results]).toEqual([['p', 'pass'], ['q', 'pass']]);
  });
});

describe('longest first', () => {
  it('starts modules with no time first, then the longest last time first, ties in the given order', () => {
    expect(longestFirst(['a', 'b', 'c', 'd', 'e'], { a: 5, b: 30, c: 5, e: 12 })).toEqual(['d', 'b', 'e', 'a', 'c']);
  });
});

describe('Godot run judgement', () => {
  const ok = { results: [{ name: 'a::t1', status: 'pass' }, { name: 'a::t2', status: 'skip' }], run_failures: [] };

  it('passes a clean run', () => {
    expect(judgeRun(ok, 'fine\n', 0, 'headless pass')).toEqual({ tests: 2, passed: 2, failures: [] });
    expect(judgeRun(ok, '', null, 'browser run').failures).toEqual([]);
  });

  it('fails on every rule', () => {
    expect(judgeRun(null, '', 0, 'p')).toEqual({ tests: 0, passed: 0, failures: ['p: no result'] });
    const output = Array.from({ length: 25 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    expect(judgeRun(null, `${output}\n\n`, 0, 'p').failures).toEqual(['p: no result', ...Array.from({ length: 20 }, (_, i) => `p: output: line ${String(i + 6)}`)]);
    expect(judgeRun({ results: [] }, '', 0, 'p').failures).toEqual(['p: no tests']);
    const bad = { results: [{ name: 'a::t', status: 'fail', message: 'expected 1' }, { name: 'a::u', status: 'pass' }], run_failures: [{ message: 'timer' }] };
    expect(judgeRun(bad, 'x\nSCRIPT ERROR: boom\nERROR: e\nObjectDB instances leaked at exit\n', 3, 'p')).toEqual({
      tests: 2,
      passed: 1,
      failures: ['p: a::t: expected 1', 'p: run failure: timer', 'p: exit code 3', 'p: SCRIPT ERROR: boom', 'p: ERROR: e', 'p: ObjectDB instances leaked at exit'],
    });
    expect(judgeRun({ results: [{ name: 'n', status: 'fail' }] }, '', 0, 'p').failures).toEqual(['p: n: ']);
  });

  it('counts the script errors the tests checked against the SCRIPT ERROR: lines', () => {
    const checked = { results: [{ name: 'a::t', status: 'pass', checked_script_errors: 1 }, { name: 'a::u', status: 'pass', checked_script_errors: 1 }] };
    const two = 'SCRIPT ERROR: x\n   at: f (res://a.gd:1)\nSCRIPT ERROR: y\n';
    expect(judgeRun(checked, two, 0, 'p').failures).toEqual([]);
    expect(judgeRun(checked, 'SCRIPT ERROR: x\n', 0, 'p').failures).toEqual(['p: SCRIPT ERROR: x', 'p: 1 SCRIPT ERROR lines, checked_script_errors 2']);
    expect(judgeRun(checked, `${two}SCRIPT ERROR: z\n`, null, 'p').failures).toEqual(['p: SCRIPT ERROR: x', 'p: SCRIPT ERROR: y', 'p: SCRIPT ERROR: z', 'p: 3 SCRIPT ERROR lines, checked_script_errors 2']);
  });

  it('adds outcomes, builds GUT arguments, sets GODOT_CONFIG.args and reads console lines', () => {
    expect(addOutcomes({ tests: 1, passed: 1, failures: [] }, { tests: 2, passed: 1, failures: ['x'] })).toEqual({ tests: 3, passed: 2, failures: ['x'], ran: true });
    expect(addOutcomes({ tests: 1, passed: 1, failures: [] }, { tests: 0, passed: 0, failures: [], skipped: 'locked' })).toEqual({ tests: 1, passed: 1, failures: [], ran: true, skipped: 'locked' });
    // a module ran when one of its passes ran
    const stopped = { tests: 0, passed: 0, failures: ['a'], ran: false };
    const started = { tests: 1, passed: 0, failures: ['b'], ran: true };
    expect(addOutcomes(stopped, stopped).ran).toBe(false);
    expect(addOutcomes(stopped, started).ran).toBe(true);
    expect(addOutcomes(started, stopped).ran).toBe(true);
    // GUT refuses options it does not know: the run's values go in the test run config, not after `--`
    expect(gutArgs('UICore', 'test_')).toEqual([
      '-s', 'addons/gut/gut_cmdln.gd', '-gdir=res://core/ui_core', '-ginclude_subdirs', '-gprefix=test_', '-gsuffix=.gd',
      '-gpre_run_script=res://core/unit_test_core/dev/gut_pre_run.gd', '-gpost_run_script=res://core/unit_test_core/dev/gut_post_run.gd',
      '-gexit',
    ]);
    expect(gutArgs(null, 'test_render_')[2]).toBe('-gdir=res://core');
    expect(testRunConfigQuery({ ogw_run_id: 'r1', ogw_test_host: 'http://h:1', ogw_core_fixture_dir: 'res://core_fixtures' }))
      .toBe('ogw_run_id=r1&ogw_test_host=http%3A%2F%2Fh%3A1&ogw_core_fixture_dir=res%3A%2F%2Fcore_fixtures');
    expect(withConfigArgs('const GODOT_CONFIG = {"args":[],"x":1};', ['-a', '--b=c'])).toBe('const GODOT_CONFIG = {"args":["-a","--b=c"],"x":1};');
    expect(() => withConfigArgs('<html>', [])).toThrow('no GODOT_CONFIG.args');
    expect(consoleMessages('[1:2:INFO:CONSOLE(3)] "hello", source: y (3)\n[1:ERROR:gpu.cc(4)] noise\n[1:INFO:CONSOLE(9)] "ERROR: bad", source: z (9)')).toBe('hello\nERROR: bad');
    // captured from the pinned chrome-headless-shell 155: messages are raw, with inner quotes and line breaks
    const captured = [
      '[1018/042632.037332:ERROR:ui/display/mac/cv_display_link_mac.mm:188] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670',
      '[1018/042632.038029:INFO:CONSOLE:1] "hi "q"',
      'next", source: file:///tmp/a.html (1)',
      '[1018/042632.038046:INFO:CONSOLE:1] "Leak in "Foo"',
      'ERROR: 1 resources still in use at exit.", source: file:///tmp/a.html (1)',
      '[1018/042632.038052:INFO:CONSOLE:1] "ends with ", source: fake (3)", source: file:///tmp/a.html (1)',
      '[1018/042632.038059:INFO:CONSOLE:1] "last", source: file:///tmp/a.html (1)',
      '',
    ].join('\n');
    expect(consoleMessages(captured)).toBe('hi "q"\nnext\nLeak in "Foo"\nERROR: 1 resources still in use at exit.\nends with ", source: fake (3)\nlast');
  });
});

describe('releasedOrDrained', () => {
  it('waits for both the release request and the last console line of that run, and at most the longest time', async () => {
    let released: string | null = null;
    let stderr = '';
    const host = { url: '', result: () => null, released: () => released, onInput: () => undefined, inputFailures: () => [], appCutOff: () => [], started: () => null, close: () => Promise.resolve() };
    const started = Date.now();
    setTimeout(() => {
      released = 'r1';
    }, 100);
    // the line of another run ID does not end the wait
    setTimeout(() => {
      stderr += `[1:INFO:CONSOLE:1] "${releasedLine('other')}", source: x (1)\n`;
    }, 150);
    setTimeout(() => {
      stderr += `[1:INFO:CONSOLE:1] "${releasedLine('r1')}", source: x (1)\n`;
    }, 600);
    await releasedOrDrained(host, () => stderr, 'r1', 5000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
    expect(Date.now() - started).toBeLessThan(3000);
    const none = Date.now();
    await releasedOrDrained({ ...host, released: () => null }, () => '', 'r2', 300);
    expect(Date.now() - none).toBeGreaterThanOrEqual(280);
  });

  it('does not end on the console line alone when the release request comes later', async () => {
    let released: string | null = null;
    const host = { url: '', result: () => null, released: () => released, onInput: () => undefined, inputFailures: () => [], appCutOff: () => [], started: () => null, close: () => Promise.resolve() };
    const stderr = `[1:INFO:CONSOLE:1] "${releasedLine('r1')}", source: x (1)\n`;
    const started = Date.now();
    setTimeout(() => {
      released = 'r1';
    }, 500);
    await releasedOrDrained(host, () => stderr, 'r1', 5000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
