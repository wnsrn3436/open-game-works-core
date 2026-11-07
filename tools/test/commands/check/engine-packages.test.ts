import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckFailure, CheckResult } from '../../../src/commands/check/api.ts';
import { StaticContext } from '../../../src/commands/check/static/lib/context.ts';
import * as typeCheck from '../../../src/commands/check/static/type-check.ts';
import { hostPlatform } from '../../../src/commands/core/lib/impl.ts';
import { requireEngine } from '../../../src/commands/env/api.ts';
import { setNet } from '../../../src/commands/env/lib/net.ts';
import { makeGame, makeWorkspace, ogw, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { ctxOf, fakeNet, GAME_SETTINGS, makeRelease, SERVED, sha256Of, storedZip } from '../generate/helpers.ts';

vi.mock('../../../src/commands/core/api.ts', async () => (await import('../generate/helpers.ts')).coreApiMock);
vi.mock('../../../src/commands/env/api.ts', () => ({ requireEngine: vi.fn() }));
vi.mock('../../../src/commands/data/lib/binary-build.ts', () => ({ binaryBuild: vi.fn(() => Promise.resolve()) }));

const RTC_URL = 'https://example.test/webrtc-native.zip';
const RTC_ZIP = storedZip({ 'addons/webrtc/webrtc.gdextension': 'rtc' });
SERVED.set(RTC_URL, RTC_ZIP);

const PASSING = { run_id: 'r', kind: 'regression', results: [{ name: 'res://tests/a/test_a.gd::test_a', status: 'pass', message: '' }], run_failures: [] };

/**
 * A fake `godot` that behaves as Godot does without GUT in the project: `--import` keeps the folders of `addons/` it
 * found (the script classes and the GDExtensions of the import) in `.godot/` and logs them; the GUT command line ends
 * with the engine errors of a missing `addons/gut/gut_cmdln.gd` and no result; the type check fails a script that
 * extends `UnitTestCase` when the import found no GUT. Each run appends a line to the returned log.
 */
function fakeGodot(): { path: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ogw-godot-'));
  const log = join(dir, 'log');
  const path = join(dir, 'godot');
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const project = args[args.indexOf('--path') + 1];
const log = (line) => fs.appendFileSync(${JSON.stringify(log)}, line + '\\n');
const addons = path.join(project, 'addons');
const imported = path.join(project, '.godot', 'imported-addons');
if (args.includes('--import')) {
  const found = fs.existsSync(addons) ? fs.readdirSync(addons).sort() : [];
  fs.mkdirSync(path.join(project, '.godot'), { recursive: true });
  fs.writeFileSync(imported, found.join('\\n'));
  log('import ' + (found.join(',') || 'nothing'));
  process.exit(0);
}
const script = args[args.indexOf('-s') + 1];
if (script === 'addons/gut/gut_cmdln.gd') {
  const gut = fs.existsSync(path.join(project, script));
  log('gut ' + (gut ? 'found' : 'missing'));
  if (!gut) {
    process.stderr.write("ERROR: Attempt to open script 'res://addons/gut/gut_cmdln.gd' resulted in error 'File not found'.\\nERROR: Failed loading resource: res://addons/gut/gut_cmdln.gd.\\nERROR: Can't load script: addons/gut/gut_cmdln.gd\\n");
    process.exit(0);
  }
  const host = JSON.parse(fs.readFileSync(args.find((a) => a.startsWith('-gconfig=')).slice(9), 'utf8')).ogw_test_host;
  fetch(host + '/result', { method: 'PUT', body: ${JSON.stringify(JSON.stringify(PASSING))} }).then(() => process.exit(0));
} else {
  // the type check: one process for the list file \`-s <checker> -- <list>\`, or \`--check-only --script <file>\`
  const one = !args.includes('--check-only');
  const scripts = one ? fs.readFileSync(args[args.length - 1], 'utf8').split('\\n').filter(Boolean) : [args[args.indexOf('--script') + 1]];
  const gut = fs.existsSync(imported) && fs.readFileSync(imported, 'utf8').split('\\n').includes('gut');
  log('check ' + scripts.join(','));
  let code = 0;
  scripts.forEach((res, i) => {
    if (one) process.stderr.write('OGW_CHECK_BEGIN ' + i + '\\n');
    const valid = gut || !fs.readFileSync(path.join(project, res.slice('res://'.length)), 'utf8').includes('extends UnitTestCase');
    if (!valid) {
      process.stderr.write('SCRIPT ERROR: Parse Error: Could not resolve super class inheritance from "UnitTestCase".\\n   at: GDScript::reload (' + res + ':1)\\n');
      code = 1;
    }
    if (one) process.stderr.write('OGW_CHECK_END ' + i + ' ' + (valid ? 1 : 0) + '\\n');
  });
  process.exit(one ? 0 : code);
}
`,
  );
  chmodSync(path, 0o755);
  return { path, log };
}

let ws: TestWorkspace;
let godot: { path: string; log: string };
const host = hostPlatform();

beforeEach(() => {
  setNet(fakeNet());
  ws = makeWorkspace({ maxConcurrentInstances: 2 });
  makeRelease(ws, '1.0.0', {
    plugins: { [`ogw-secure-storage/${host}/addons/ogw-secure-storage/lib.gdextension`]: 'ext' },
    enginePlugins: [
      { name: 'ogw-secure-storage', version: '1.0.0', platforms: [host], url: 'u', sha256: 's' },
      { name: 'webrtc-native', version: '1.1.0', platforms: [host], url: RTC_URL, sha256: sha256Of(RTC_ZIP) },
      { name: 'ads-sdk', version: '2.0.0', platforms: ['android'], url: 'https://example.test/ads.zip', sha256: 'a'.repeat(64) },
    ],
  });
  // a game whose committed generated file is not what `ogw generate` writes: the check leaves it as it is
  makeGame(ws, 'g', {
    'settings.json': { ...GAME_SETTINGS, buildPlatforms: ['ios'] },
    'client/.gitignore': 'addons/\nandroid/\nios/plugins/\n.godot/\n',
    'client/generated/core_modules.gd': 'committed\n',
    'client/tests/a/test_a.gd': 'extends UnitTestCase\n\nfunc test_a():\n\tpass\n',
  });
  godot = fakeGodot();
  vi.mocked(requireEngine).mockReset().mockResolvedValue(godot.path);
});

afterEach(() => {
  setNet(null);
});

/** A worktree of the game's HEAD under `worktrees/g/`: a checkout no `ogw generate` ran in, so without `client/addons/`. */
function freshWorktree(): string {
  const worktree = join(ws.worktrees, 'g', `fresh-${String(Date.now())}`);
  sh(join(ws.games, 'g'), 'git', ['worktree', 'add', '--quiet', '--detach', worktree, 'HEAD']);
  expect(existsSync(join(worktree, 'client', 'addons'))).toBe(false);
  return worktree;
}

function logLines(): string[] {
  return existsSync(godot.log) ? readFileSync(godot.log, 'utf8').trim().split('\n') : [];
}

const clientFailures = (check: CheckResult | undefined): CheckFailure[] => (check?.failures ?? []).filter((f) => f.where.startsWith('client/'));

describe('the check of a checkout without client/addons/', () => {
  it('ogw regress check puts the engine packages of this host into its worktree before the import, so the client regression test runs GUT', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'ogw-regress-check-')), 'base.json');
    const commit = sh(join(ws.games, 'g'), 'git', ['rev-parse', 'HEAD']).trim();
    const run = await ogw(ws, ['regress', 'check', 'g', '--commit', commit, '--out', out, '--check', 'regression test']);
    expect(run.stderr).toBe('');
    const file = JSON.parse(readFileSync(out, 'utf8')) as { checks: CheckResult[] };
    expect(file.checks.map((c) => c.name)).toEqual(['regression test']);
    // the game has no server tests; the client regression test has no failure
    expect(clientFailures(file.checks[0])).toEqual([]);
    // the one import of the checks found GUT and the plugins of this host, not those of another platform
    expect(logLines()).toEqual(['import gut,ogw-secure-storage,webrtc', 'gut found']);
  });

  it('ogw check --regression puts them in and writes nothing else of ogw generate', async () => {
    const worktree = freshWorktree();
    const run = await ogw(ws, ['check', 'g', '--regression', 'client/tests'], { cwd: worktree });
    expect(run).toEqual({ code: 0, stdout: 'regression test: pass\n', stderr: '' });
    expect(readFileSync(join(worktree, 'client/addons/gut/gut_cmdln.gd'), 'utf8')).toBe('extends SceneTree\n');
    expect(readFileSync(join(worktree, 'client/addons/webrtc/webrtc.gdextension'), 'utf8')).toBe('rtc');
    expect(readFileSync(join(worktree, 'client/addons/ogw-secure-storage/lib.gdextension'), 'utf8')).toBe('ext');
    // the committed generated files stay as they are, and the rest of `ogw generate` is not written
    expect(readFileSync(join(worktree, 'client/generated/core_modules.gd'), 'utf8')).toBe('committed\n');
    expect(existsSync(join(worktree, 'client/project.godot'))).toBe(false);
    expect(existsSync(join(worktree, 'client/core'))).toBe(false);
    expect(sh(worktree, 'git', ['status', '--porcelain']).trim()).toBe('');
    expect(logLines()).toEqual(['import gut,ogw-secure-storage,webrtc', 'gut found']);
    const gitDir = sh(worktree, 'git', ['rev-parse', '--absolute-git-dir']).trim();
    expect(['ogw-generate.lock', 'ogw-import.lock'].filter((lock) => existsSync(join(gitDir, lock)))).toEqual([]);
  });

  it('the type check of the static check puts them in before its import, so a test that extends UnitTestCase resolves', async () => {
    const worktree = freshWorktree();
    const ctx = ctxOf(ws, worktree);
    const sc = await StaticContext.create(ctx, await ctx.game('g'));
    expect(await typeCheck.run(sc)).toEqual([]);
    expect(logLines()).toEqual(['import gut,ogw-secure-storage,webrtc', 'check res://tests/a/test_a.gd']);
    expect(existsSync(join(worktree, 'client/addons/gut/gut_cmdln.gd'))).toBe(true);
    expect(readFileSync(join(worktree, 'client/generated/core_modules.gd'), 'utf8')).toBe('committed\n');
  });

  it('fails with the error when a package cannot be got, and runs no Godot', async () => {
    SERVED.delete(RTC_URL);
    try {
      const worktree = freshWorktree();
      const run = await ogw(ws, ['check', 'g', '--regression', 'client/tests'], { cwd: worktree });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(`download failed (404): ${RTC_URL}`);
      expect(logLines()).toEqual([]);
    } finally {
      SERVED.set(RTC_URL, RTC_ZIP);
    }
  });
});
