import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildToolProgram, enginePath, installEngines, installEnginesReport, requireEngine, toolProgram } from '../../../src/commands/env/api.ts';
import { downloadableBuildTools, godotDataRoot, hostDownloads, installBuildTool, installEngine, isGodotExecutable } from '../../../src/commands/env/lib/engines.ts';
import { listFiles, sha256Text } from '../../../src/commands/env/lib/files.ts';
import { setNet } from '../../../src/commands/env/lib/net.ts';
import { createContext, type Context } from '../../../src/lib/command.ts';
import type { ToolDownload } from '../../../src/lib/settings.ts';
import { ogw, makeGame, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeNet, type FakeNet } from './fakes.ts';

/** `<value>/<version>/`: published releases; `<value>/local/`: the release `useLocalCore` builds from open-game-works-core-impl. */
const releaseDir = vi.hoisted(() => ({ value: '' }));
vi.mock('../../../src/commands/core/api.ts', () => {
  const published = (version: string) => ({ version, dir: join(releaseDir.value, version), local: false });
  return {
    coreRelease: async (ctx: Context, version: string) => ((await ctx.settings()).useLocalCore ? { version, dir: join(releaseDir.value, 'local'), local: true } : published(version)),
    publishedRelease: (_ctx: unknown, version: string) => Promise.resolve(published(version)),
    extractedAsset: (_ctx: unknown, release: { version: string; dir: string }, asset: string) => {
      const dir = join(release.dir, asset.replace('.zip', ''));
      return existsSync(dir) ? Promise.resolve(dir) : Promise.reject(new Error(`core release ${release.version} has no asset ${asset}`));
    },
  };
});

type Files = Record<string, { body: string; mode?: number }>;

function archiveOf(dir: string, files: Files, name: string): Buffer {
  const src = join(dir, `${name}-src`);
  for (const [path, file] of Object.entries(files)) {
    mkdirSync(join(src, path, '..'), { recursive: true });
    writeFileSync(join(src, path), file.body);
    if (file.mode !== undefined) chmodSync(join(src, path), file.mode);
  }
  const out = join(dir, name);
  if (name.endsWith('.tar.gz')) sh(src, 'tar', ['-czf', out, '.']);
  else sh(src, 'zip', ['-qr', out, '.']);
  return readFileSync(out);
}

const sha = (b: Buffer | string): string => sha256Text(b as string);

/** A fake Godot executable: prints `output` and exits with `code`. */
function godotScript(output: string, code = 0): { body: string; mode: number } {
  return { body: `#!/bin/sh\nprintf '%s' '${output}'\nexit ${String(code)}\n`, mode: 0o755 };
}

interface Setup {
  ws: TestWorkspace;
  env: NodeJS.ProcessEnv;
  ctx: Context;
  routes: Record<string, Buffer>;
  engineJson: Record<string, unknown>;
  scratch: string;
}

const RAWTOOL = '#!/bin/sh\necho 2.0 rawtool\n';

function setup(godotOutput = 'Godot Engine v4.5.1.stable.official\n  4.5.1.stable.official.abc  \n', godotCode = 0, settings: Record<string, unknown> = {}): Setup {
  const ws = makeWorkspace(settings);
  const scratch = join(ws.root, 'scratch');
  const godot = archiveOf(
    scratch,
    { 'Godot.app/Contents/Info.plist': { body: 'plist' }, 'Godot.app/Contents/MacOS/Godot': godotScript(godotOutput, godotCode) },
    'godot-mac.zip',
  );
  const godotOld = archiveOf(scratch, { 'Godot.app/Contents/MacOS/Godot': godotScript('4.4.0.stable\n') }, 'godot-old.zip');
  const templates = archiveOf(scratch, { 'templates/version.txt': { body: '4.5.1.stable' }, 'README.txt': { body: 'readme' } }, 'templates.tpz');
  const jsign = archiveOf(scratch, { 'jsign-7.1/bin/jsign': { body: '#!/bin/sh\necho 7.1\n', mode: 0o755 } }, 'jsign.tar.gz');
  const routes: Record<string, Buffer> = {
    'https://dl/godot-mac.zip': godot,
    'https://dl/templates.tpz': templates,
    'https://dl/jsign.tar.gz': jsign,
    'https://dl/godot-old.zip': godotOld,
    'https://dl/rawtool': Buffer.from(RAWTOOL),
  };
  const buildTools = [
    { platform: 'windows', hosts: ['macos-arm64'], name: 'jsign', version: '7.1', versionCommand: ' jsign  --version', downloads: [{ platform: 'any', url: 'https://dl/jsign.tar.gz', sha256: sha(jsign) }] },
    { platform: 'windows', hosts: ['linux-x64'], name: 'other', version: '1', versionCommand: 'other', downloads: [{ platform: 'any', url: 'https://dl/other', sha256: 'b'.repeat(64) }] },
    { platform: 'ios', hosts: ['macos-arm64'], name: 'xcodebuild', version: '26', versionCommand: 'xcodebuild -version' },
    { platform: 'android', hosts: ['macos-arm64', 'windows-x64'], name: 'rawtool', version: '2.0', versionCommand: ' rawtool  --version', downloads: [{ platform: 'any', url: 'https://dl/rawtool', sha256: sha(RAWTOOL) }] },
  ];
  const engineJson: Record<string, unknown> = {
    godot: '4.5.1.stable',
    downloads: [
      { platform: 'macos-arm64', url: 'https://dl/godot-mac.zip', sha256: sha(godot) },
      { platform: 'linux-x64', url: 'https://dl/godot-linux.zip', sha256: 'a'.repeat(64) },
      { platform: 'any', url: 'https://dl/templates.tpz', sha256: sha(templates) },
    ],
    buildTools,
  };
  mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
  writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), JSON.stringify(engineJson));
  releaseDir.value = join(ws.root, 'release');
  mkdirSync(join(releaseDir.value, '1.2.0', 'client-godot'), { recursive: true });
  writeFileSync(
    join(releaseDir.value, '1.2.0', 'client-godot', 'engine.json'),
    JSON.stringify({ godot: '4.4.0.stable', downloads: [{ platform: 'macos-arm64', url: 'https://dl/godot-old.zip', sha256: sha(godotOld) }], buildTools }),
  );
  mkdirSync(join(releaseDir.value, 'local', 'client-godot'), { recursive: true });
  writeFileSync(join(releaseDir.value, 'local', 'client-godot', 'engine.json'), JSON.stringify(engineJson));
  const env = { ...ws.env, OGW_HOST_PLATFORM: 'macos-arm64' };
  const ctx = createContext({ cwd: ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
  return { ws, env, ctx, routes, engineJson, scratch };
}

function writeCoreEngineJson(s: Setup, patch: Record<string, unknown>): void {
  writeFileSync(join(s.ws.coreImpl, 'client', 'godot', 'engine.json'), JSON.stringify({ ...s.engineJson, ...patch }));
}

function contextFor(s: Setup, env: NodeJS.ProcessEnv): Context {
  return createContext({ cwd: s.ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
}

/** A fake network whose downloads take `delayMs`. */
function slowNet(routes: Record<string, Buffer>, delayMs: number): FakeNet {
  const inner = fakeNet(routes);
  return {
    ...inner,
    download: async (url, dest, headers) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      await inner.download(url, dest, headers);
    },
  };
}

beforeEach(() => {
  setNet(null);
});
afterEach(() => {
  setNet(null);
});

const OK = { installed: true, mismatches: [], reason: null };

describe('ogw env install-engines', () => {
  it('installs each engine version, its export templates and downloadable build tools once, and leaves the macOS bundle untouched', async () => {
    const s = setup();
    const { ws, env, ctx, routes } = s;
    // Games are read in locale order (g1 before G2); games without an engine and core version, or without settings, are skipped.
    makeGame(ws, 'a0', { 'settings.json': { engine: 'godot' } });
    makeGame(ws, 'a1', { 'settings.json': { coreVersion: '1.2.0' } });
    makeGame(ws, 'a2', { 'README.md': 'no settings' });
    writeFileSync(join(ws.games, 'a3.txt'), 'not a game');
    makeGame(ws, 'G2', { 'settings.json': { engine: 'godot', coreVersion: '1.2.0' } });
    makeGame(ws, 'g1', { 'settings.json': { engine: 'godot', coreVersion: '1.2.0' } });
    writeFileSync(join(ws.coreImpl, 'client', 'a-file'), 'not an engine');
    mkdirSync(join(ws.coreImpl, 'client', 'empty'));
    const net = fakeNet(routes);
    setNet(net);
    const run = await ogw(ws, ['env', 'install-engines'], { env });
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe(
      [
        'engine godot 4.4.0.stable (game g1): installed',
        'build tool jsign 7.1 (game g1): installed',
        'build tool rawtool 2.0 (game g1): installed',
        'engine godot 4.5.1.stable (open-game-works-core-impl): installed',
        '',
      ].join('\n'),
    );
    expect(run.code).toBe(0);
    const dir = join(ws.root, '.ogw', 'engines', 'godot', '4.5.1.stable');
    const exe = join(dir, 'editor', 'Godot.app', 'Contents', 'MacOS', 'Godot');
    expect(await enginePath(ctx, 'godot', '4.5.1.stable')).toBe(exe);
    // Nothing is written into the signed bundle: `_sc_` and `editor_data/` sit next to `Godot.app`.
    expect(await listFiles(join(dir, 'editor', 'Godot.app'))).toEqual(['Contents/Info.plist', 'Contents/MacOS/Godot']);
    expect(await listFiles(dir)).toEqual([
      'download/godot-mac.zip',
      'download/templates.tpz',
      'editor/Godot.app/Contents/Info.plist',
      'editor/Godot.app/Contents/MacOS/Godot',
      'editor/_sc_',
      'editor/editor_data/export_templates/4.5.1.stable/version.txt',
      'installed.json',
    ]);
    expect(readFileSync(join(dir, 'editor', 'editor_data', 'export_templates', '4.5.1.stable', 'version.txt'), 'utf8')).toBe('4.5.1.stable');
    expect(readFileSync(join(dir, 'editor', '_sc_'), 'utf8')).toBe('');
    expect(JSON.parse(readFileSync(join(dir, 'installed.json'), 'utf8'))).toEqual({
      name: 'godot',
      version: '4.5.1.stable',
      sha256: [sha(routes['https://dl/godot-mac.zip'] as Buffer), sha(routes['https://dl/templates.tpz'] as Buffer)],
      program: 'editor/Godot.app/Contents/MacOS/Godot',
    });
    expect(existsSync(join(ws.root, '.ogw', 'engines', 'godot', '.4.5.1.stable.lock'))).toBe(false);
    expect(await requireEngine(ctx, 'godot', '4.5.1.stable')).toBe(exe);
    expect(await requireEngine(ctx, 'godot', '4.4.0.stable')).toBe(join(ws.root, '.ogw', 'engines', 'godot', '4.4.0.stable', 'editor', 'Godot.app', 'Contents', 'MacOS', 'Godot'));
    expect(await buildToolProgram(ctx, 'jsign', '7.1')).toBe(join(ws.root, '.ogw', 'build-tools', 'jsign', '7.1', 'files', 'jsign-7.1', 'bin', 'jsign'));
    const raw = join(ws.root, '.ogw', 'build-tools', 'rawtool', '2.0', 'download', 'rawtool');
    expect(await buildToolProgram(ctx, 'rawtool', '2.0')).toBe(raw);
    expect(statSync(raw).mode & 0o777).toBe(0o755);
    expect(sh(ws.root, raw, [])).toBe('2.0 rawtool\n');
    expect(await buildToolProgram(ctx, 'xcodebuild', '26')).toBeNull();
    expect(await buildToolProgram(ctx, 'other', '1')).toBeNull();
    expect(await toolProgram(ctx, 'ffmpeg')).toBeNull();
    expect(net.calls).toEqual([
      'GET https://dl/godot-old.zip',
      'GET https://dl/jsign.tar.gz',
      'GET https://dl/rawtool',
      'GET https://dl/godot-mac.zip',
      'GET https://dl/templates.tpz',
    ]);
    const again = await ogw(ws, ['env', 'install-engines', '--json'], { env });
    expect(again.code).toBe(0);
    expect(net.calls).toHaveLength(5);
    expect((JSON.parse(again.stdout) as { items: unknown[] }).items).toEqual([
      { kind: 'engine', name: 'godot', version: '4.4.0.stable', from: 'game g1', result: OK },
      { kind: 'build tool', name: 'jsign', version: '7.1', from: 'game g1', result: OK },
      { kind: 'build tool', name: 'rawtool', version: '2.0', from: 'game g1', result: OK },
      { kind: 'engine', name: 'godot', version: '4.5.1.stable', from: 'open-game-works-core-impl', result: OK },
    ]);
    await expect(installEngines(ctx, 'g1')).resolves.toBeUndefined();
    await expect(installEngines(ctx, 'G2')).resolves.toBeUndefined();
  });

  it('installs the Linux editor build and keeps _sc_ and editor_data next to it', async () => {
    const s = setup();
    const linux = archiveOf(
      s.scratch,
      {
        '00-readme.txt': { body: 'x' },
        'A.x86_64': { body: 'x' },
        'Godot_v4.5.1-stable_README.txt': { body: 'x' },
        'Godot_v4.5.1-stable_linux.x86_64': godotScript('4.5.1.stable.official\n'),
      },
      'godot-linux.zip',
    );
    writeCoreEngineJson(s, {
      downloads: [
        { platform: 'linux-x64', url: 'https://dl/godot-linux.zip', sha256: sha(linux) },
        { platform: 'any', url: 'https://dl/templates.tpz', sha256: sha(s.routes['https://dl/templates.tpz'] as Buffer) },
      ],
    });
    setNet(fakeNet({ ...s.routes, 'https://dl/godot-linux.zip': linux }));
    const env = { ...s.ws.env, OGW_HOST_PLATFORM: 'linux-x64' };
    const run = await ogw(s.ws, ['env', 'install-engines'], { env });
    expect(run.stdout).toBe('engine godot 4.5.1.stable (open-game-works-core-impl): installed\nbuild tool other 1 (open-game-works-core-impl): failed: download failed (404): https://dl/other\n');
    expect(run.code).toBe(1);
    const editor = join(s.ws.root, '.ogw', 'engines', 'godot', '4.5.1.stable', 'editor');
    const ctx = contextFor(s, env);
    expect(await requireEngine(ctx, 'godot', '4.5.1.stable')).toBe(join(editor, 'Godot_v4.5.1-stable_linux.x86_64'));
    expect(existsSync(join(editor, '_sc_'))).toBe(true);
    expect(readFileSync(join(editor, 'editor_data', 'export_templates', '4.5.1.stable', 'version.txt'), 'utf8')).toBe('4.5.1.stable');
  });

  it('installs the Windows editor build and gives a raw build tool an .exe name', async () => {
    const s = setup();
    const jsignExe = archiveOf(s.scratch, { 'jsign/jsign.exe': { body: 'exe', mode: 0o755 } }, 'jsign-win.tar.gz');
    s.routes['https://dl/jsign-win.tar.gz'] = jsignExe;
    s.engineJson.buildTools = [
      ...(s.engineJson.buildTools as object[]),
      { platform: 'windows', hosts: ['windows-x64'], name: 'jsignw', version: '7.1', versionCommand: 'jsign --version', downloads: [{ platform: 'any', url: 'https://dl/jsign-win.tar.gz', sha256: sha(jsignExe) }] },
    ];
    const win = archiveOf(
      s.scratch,
      {
        'Godot_v4.5.1-stable_README.txt': { body: 'x' },
        'Godot_v4.5.1-stable_win64.exe': godotScript('4.5.1.stable.official\n'),
        'Godot_v4.5.1-stable_win64_console.exe': godotScript('4.5.1.stable.official\n'),
      },
      'godot-win.zip',
    );
    writeCoreEngineJson(s, { downloads: [{ platform: 'windows-x64', url: 'https://dl/godot-win.zip', sha256: sha(win) }] });
    setNet(fakeNet({ ...s.routes, 'https://dl/godot-win.zip': win }));
    const env = { ...s.ws.env, OGW_HOST_PLATFORM: 'windows-x64' };
    const run = await ogw(s.ws, ['env', 'install-engines'], { env });
    expect(run.stdout).toBe(
      'engine godot 4.5.1.stable (open-game-works-core-impl): installed\nbuild tool rawtool 2.0 (open-game-works-core-impl): installed\nbuild tool jsignw 7.1 (open-game-works-core-impl): installed\n',
    );
    const ctx = contextFor(s, env);
    expect(await buildToolProgram(ctx, 'jsignw', '7.1')).toBe(join(s.ws.root, '.ogw', 'build-tools', 'jsignw', '7.1', 'files', 'jsign', 'jsign.exe'));
    const editor = join(s.ws.root, '.ogw', 'engines', 'godot', '4.5.1.stable', 'editor');
    expect(await enginePath(ctx, 'godot', '4.5.1.stable')).toBe(join(editor, 'Godot_v4.5.1-stable_win64.exe'));
    expect(existsSync(join(editor, '_sc_'))).toBe(true);
    const raw = join(s.ws.root, '.ogw', 'build-tools', 'rawtool', '2.0', 'download', 'rawtool.exe');
    expect(await buildToolProgram(ctx, 'rawtool', '2.0')).toBe(raw);
    expect(readFileSync(raw, 'utf8')).toBe(RAWTOOL);
  });

  it('fails an item whose download differs from engine.json and leaves no install folder', async () => {
    const { ws, env, ctx, routes } = setup();
    setNet(fakeNet({ ...routes, 'https://dl/templates.tpz': Buffer.from('tampered'), 'https://dl/jsign.tar.gz': Buffer.from('bad') }));
    const run = await ogw(ws, ['env', 'install-engines'], { env });
    expect(run.code).toBe(1);
    const templates = sha(routes['https://dl/templates.tpz'] as Buffer);
    const jsign = sha(routes['https://dl/jsign.tar.gz'] as Buffer);
    expect(run.stdout).toBe(
      [
        'engine godot 4.5.1.stable (open-game-works-core-impl): failed: SHA-256 differs from engine.json',
        `  differs: https://dl/templates.tpz expected ${templates} actual ${sha('tampered')}`,
        'build tool jsign 7.1 (open-game-works-core-impl): failed: SHA-256 differs from engine.json',
        `  differs: https://dl/jsign.tar.gz expected ${jsign} actual ${sha('bad')}`,
        'build tool rawtool 2.0 (open-game-works-core-impl): installed',
        '',
      ].join('\n'),
    );
    expect(existsSync(join(ws.root, '.ogw', 'engines', 'godot', '4.5.1.stable'))).toBe(false);
    expect(existsSync(join(ws.root, '.ogw', 'build-tools', 'jsign', '7.1'))).toBe(false);
    expect(await enginePath(ctx, 'godot', '4.5.1.stable')).toBeNull();
    const json = await ogw(ws, ['env', 'install-engines', '--json'], { env });
    const items = (JSON.parse(json.stdout) as { items: { result: unknown }[] }).items;
    expect(items[0]?.result).toEqual({
      installed: false,
      reason: 'SHA-256 differs from engine.json',
      mismatches: [{ what: 'https://dl/templates.tpz', path: 'https://dl/templates.tpz', expected: templates, actual: sha('tampered') }],
    });
  });

  it('fails when a download fails or an archive has no program, and leaves no install folder', async () => {
    const s = setup();
    const noExe = archiveOf(s.scratch, { 'Godot.app/Contents/Info.plist': { body: 'plist' } }, 'godot-noexe.zip');
    const noJsign = archiveOf(s.scratch, { 'jsign-7.1/bin/jsign.sh': { body: 'x', mode: 0o755 } }, 'jsign-noexe.tar.gz');
    writeCoreEngineJson(s, {
      downloads: [{ platform: 'macos-arm64', url: 'https://dl/godot-noexe.zip', sha256: sha(noExe) }],
      buildTools: [
        { platform: 'windows', hosts: ['macos-arm64'], name: 'jsign', version: '7.1', versionCommand: 'jsign --version', downloads: [{ platform: 'any', url: 'https://dl/jsign-noexe.tar.gz', sha256: sha(noJsign) }] },
        { platform: 'windows', hosts: ['macos-arm64'], name: 'gone', version: '1', versionCommand: 'gone', downloads: [{ platform: 'any', url: 'https://dl/gone', sha256: 'c'.repeat(64) }] },
        { platform: 'windows', hosts: ['macos-arm64'], name: 'nodl', version: '1', versionCommand: 'nodl', downloads: [{ platform: 'linux-x64', url: 'https://dl/nodl', sha256: 'c'.repeat(64) }] },
      ],
    });
    setNet(fakeNet({ 'https://dl/godot-noexe.zip': noExe, 'https://dl/jsign-noexe.tar.gz': noJsign }));
    const run = await ogw(s.ws, ['env', 'install-engines'], { env: s.env });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe(
      [
        'engine godot 4.5.1.stable (open-game-works-core-impl): failed: godot executable not found in the download',
        'build tool jsign 7.1 (open-game-works-core-impl): failed: program jsign not found in the download',
        'build tool gone 1 (open-game-works-core-impl): failed: download failed (404): https://dl/gone',
        'build tool nodl 1 (open-game-works-core-impl): failed: no download for this host',
        '',
      ].join('\n'),
    );
    expect(existsSync(join(s.ws.root, '.ogw', 'engines', 'godot', '4.5.1.stable'))).toBe(false);
    expect(existsSync(join(s.ws.root, '.ogw', 'build-tools', 'jsign', '7.1'))).toBe(false);
    expect(await buildToolProgram(s.ctx, 'jsign', '7.1')).toBeNull();
  });

  it('fails an engine without a download for this host', async () => {
    const { ws, routes } = setup();
    setNet(fakeNet(routes));
    const run = await ogw(ws, ['env', 'install-engines'], { env: { ...ws.env, OGW_HOST_PLATFORM: 'windows-x64' } });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('engine godot 4.5.1.stable (open-game-works-core-impl): failed: engine.json has no download for this host\nbuild tool rawtool 2.0 (open-game-works-core-impl): installed\n');
  });

  it('reinstalls over an older install when engine.json changes, and ignores an install of another version', async () => {
    const s = setup();
    setNet(fakeNet(s.routes));
    await ogw(s.ws, ['env', 'install-engines'], { env: s.env });
    const dir = join(s.ws.root, '.ogw', 'engines', 'godot', '4.5.1.stable');
    const changed = archiveOf(s.scratch, { 'templates/version.txt': { body: 'changed' } }, 'templates2.tpz');
    writeCoreEngineJson(s, {
      downloads: [
        (s.engineJson.downloads as object[])[0],
        { platform: 'any', url: 'https://dl/templates2.tpz', sha256: sha(changed) },
      ],
    });
    setNet(fakeNet({ ...s.routes, 'https://dl/templates2.tpz': changed }));
    expect((await ogw(s.ws, ['env', 'install-engines'], { env: s.env })).code).toBe(0);
    expect(await listFiles(join(dir, 'download'))).toEqual(['godot-mac.zip', 'templates2.tpz']);
    expect(readFileSync(join(dir, 'editor', 'editor_data', 'export_templates', '4.5.1.stable', 'version.txt'), 'utf8')).toBe('changed');
    const marker = JSON.parse(readFileSync(join(dir, 'installed.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(dir, 'installed.json'), JSON.stringify({ ...marker, version: '4.5.0.stable' }));
    expect(await enginePath(s.ctx, 'godot', '4.5.1.stable')).toBeNull();
  });

  it('installs once when two processes install the same item at the same time', async () => {
    const s = setup();
    const net = slowNet(s.routes, 150);
    setNet(net);
    const [a, b] = await Promise.all([installEnginesReport(s.ctx), installEnginesReport(s.ctx)]);
    expect(a.map((l) => l.result)).toEqual([OK, OK, OK]);
    expect(b.map((l) => l.result)).toEqual([OK, OK, OK]);
    expect([...net.calls].sort()).toEqual(['GET https://dl/godot-mac.zip', 'GET https://dl/jsign.tar.gz', 'GET https://dl/rawtool', 'GET https://dl/templates.tpz']);
    expect(await requireEngine(s.ctx, 'godot', '4.5.1.stable')).toContain('Godot.app');
  });

  it('says when there is no engine.json, refuses extra arguments, and fails an engine it has no install rules for', async () => {
    const ws = makeWorkspace();
    expect(await ogw(ws, ['env', 'install-engines'])).toMatchObject({ code: 0, stdout: 'no engine.json found\n' });
    const extra = await ogw(ws, ['env', 'install-engines', 'godot']);
    expect(extra.code).not.toBe(0);
    expect(extra.stderr).toContain('ogw env install-engines');
    mkdirSync(join(ws.coreImpl, 'client', 'unity'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'unity', 'engine.json'), '{}');
    expect(await ogw(ws, ['env', 'install-engines'])).toMatchObject({ code: 1, stdout: 'engine.json (open-game-works-core-impl/client/unity): failed: not defined: engine unity (version field, install layout, version command)\n' });
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    const noVersion = await ogw(ws, ['env', 'install-engines']);
    expect(noVersion.stdout).toContain('engine.json (open-game-works-core-impl/client/godot): failed: engine.json of godot has no godot version\n');
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{"godot": ""}');
    expect((await ogw(ws, ['env', 'install-engines'])).stdout).toContain('engine.json of godot has no godot version');
    expect(downloadableBuildTools({ buildTools: [{ platform: 'windows', hosts: ['macos-arm64'], name: 'x', version: '1', versionCommand: 'x', downloads: [{ platform: 'any', url: 'u', sha256: 's' }] }] }, null)).toEqual([]);
  });
});

describe('ogw env install-engines sources', () => {
  it('installs the engine of the published release of a game while useLocalCore is true', async () => {
    const s = setup(undefined, 0, { useLocalCore: true });
    makeGame(s.ws, 'g1', { 'settings.json': { engine: 'godot', coreVersion: '1.2.0' } });
    setNet(fakeNet(s.routes));
    const run = await ogw(s.ws, ['env', 'install-engines'], { env: s.env });
    expect(run.stdout.split('\n')[0]).toBe('engine godot 4.4.0.stable (game g1): installed');
    expect(run.code).toBe(0);
    expect(await enginePath(s.ctx, 'godot', '4.4.0.stable')).not.toBeNull();
  });

  it('reports a source it cannot read and installs the other sources', async () => {
    const s = setup();
    makeGame(s.ws, 'g0', { 'settings.json': { engine: 'godot', coreVersion: '1.3.0' } });
    makeGame(s.ws, 'g1', { 'settings.json': { engine: 'godot', coreVersion: '1.2.0' } });
    makeGame(s.ws, 'g2', { 'settings.json': '{ not json' });
    setNet(fakeNet(s.routes));
    const run = await ogw(s.ws, ['env', 'install-engines'], { env: s.env });
    const lines = run.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe('engine.json (game g0): failed: core release 1.3.0 has no asset client-godot.zip');
    expect(lines[1]).toMatch(/^engine\.json \(game g2\): failed: /);
    expect(lines.slice(2)).toEqual([
      'engine godot 4.4.0.stable (game g1): installed',
      'build tool jsign 7.1 (game g1): installed',
      'build tool rawtool 2.0 (game g1): installed',
      'engine godot 4.5.1.stable (open-game-works-core-impl): installed',
    ]);
    expect(run.code).toBe(1);
    expect(await requireEngine(s.ctx, 'godot', '4.5.1.stable')).toContain('Godot.app');
  });

  it('fails an item whose version another source names with other downloads', async () => {
    const s = setup();
    makeGame(s.ws, 'g1', { 'settings.json': { engine: 'godot', coreVersion: '1.2.0' } });
    const tools = s.engineJson.buildTools as { name: string; downloads?: object[] }[];
    writeCoreEngineJson(s, {
      godot: '4.4.0.stable',
      downloads: [{ platform: 'macos-arm64', url: 'https://dl/godot-mac.zip', sha256: sha(s.routes['https://dl/godot-mac.zip'] as Buffer) }],
      buildTools: tools.map((t) => (t.name === 'jsign' ? { ...t, downloads: [{ platform: 'any', url: 'https://dl/jsign2.tar.gz', sha256: 'e'.repeat(64) }] } : t)),
    });
    const net = fakeNet(s.routes);
    setNet(net);
    const run = await ogw(s.ws, ['env', 'install-engines'], { env: s.env });
    expect(run.stdout).toBe(
      [
        'engine godot 4.4.0.stable (game g1): installed',
        'build tool jsign 7.1 (game g1): installed',
        'build tool rawtool 2.0 (game g1): installed',
        'engine godot 4.4.0.stable (open-game-works-core-impl): failed: engine.json of open-game-works-core-impl and of game g1 name 4.4.0.stable with different downloads',
        'build tool jsign 7.1 (open-game-works-core-impl): failed: engine.json of open-game-works-core-impl and of game g1 name 7.1 with different downloads',
        '',
      ].join('\n'),
    );
    expect(run.code).toBe(1);
    expect(net.calls).toEqual(['GET https://dl/godot-old.zip', 'GET https://dl/jsign.tar.gz', 'GET https://dl/rawtool']);
  });

  it('fails installEngines of a game only on the lines of that game', async () => {
    const s = setup();
    makeGame(s.ws, 'g1', { 'settings.json': { engine: 'godot', coreVersion: '1.2.0' } });
    makeGame(s.ws, 'g2', { 'settings.json': '{ not json' });
    writeCoreEngineJson(s, {
      buildTools: [{ platform: 'windows', hosts: ['macos-arm64'], name: 'gone', version: '1', versionCommand: 'gone', downloads: [{ platform: 'any', url: 'https://dl/gone', sha256: 'c'.repeat(64) }] }],
    });
    mkdirSync(join(s.ws.coreImpl, 'client', 'unity'), { recursive: true });
    writeFileSync(join(s.ws.coreImpl, 'client', 'unity', 'engine.json'), '{}');
    setNet(fakeNet(s.routes));
    await expect(installEngines(s.ctx, 'g1')).resolves.toBeUndefined();
    expect(await enginePath(s.ctx, 'godot', '4.4.0.stable')).not.toBeNull();
    await expect(installEngines(s.ctx, 'g2')).rejects.toThrow(/^engine\.json: /);
  });

  it('fails installEngines of a game on an item of that game an earlier source failed to install', async () => {
    const s = setup();
    makeGame(s.ws, 'g0', { 'settings.json': { engine: 'godot', coreVersion: '1.2.0' } });
    makeGame(s.ws, 'g1', { 'settings.json': { engine: 'godot', coreVersion: '1.2.0' } });
    setNet(fakeNet({ ...s.routes, 'https://dl/jsign.tar.gz': Buffer.from('bad'), 'https://dl/rawtool': Buffer.from('bad') }));
    await expect(installEngines(s.ctx, 'g1')).rejects.toMatchObject({
      message: 'build tool jsign 7.1: SHA-256 differs from engine.json\nbuild tool rawtool 2.0: SHA-256 differs from engine.json',
    });
  });

  it('reports and fails once an item that two engine.json files each name twice with the same downloads', async () => {
    const s = setup();
    makeGame(s.ws, 'g1', { 'settings.json': { engine: 'godot', coreVersion: '1.2.0' } });
    const rawtool = { hosts: ['macos-arm64'], name: 'rawtool', version: '2.0', versionCommand: 'rawtool --version', downloads: [{ platform: 'any', url: 'https://dl/rawtool', sha256: sha('bad') }] };
    const buildTools = [
      { ...rawtool, platform: 'android' },
      { ...rawtool, platform: 'windows' },
    ];
    writeCoreEngineJson(s, { buildTools });
    writeFileSync(
      join(releaseDir.value, '1.2.0', 'client-godot', 'engine.json'),
      JSON.stringify({ godot: '4.5.1.stable', downloads: s.engineJson.downloads, buildTools }),
    );
    const net = fakeNet(s.routes);
    setNet(net);
    const run = await ogw(s.ws, ['env', 'install-engines'], { env: s.env });
    expect(run.stdout).toBe(
      [
        'engine godot 4.5.1.stable (game g1): installed',
        'build tool rawtool 2.0 (game g1): failed: SHA-256 differs from engine.json',
        `  differs: https://dl/rawtool expected ${sha('bad')} actual ${sha(RAWTOOL)}`,
        '',
      ].join('\n'),
    );
    expect(net.calls.filter((c) => c === 'GET https://dl/rawtool')).toHaveLength(1);
    expect((await installEnginesReport(s.ctx)).map((l) => `${l.kind} ${l.name} ${l.from}`)).toEqual(['engine godot game g1', 'build tool rawtool game g1']);
    await expect(installEngines(s.ctx, 'g1')).rejects.toMatchObject({ message: 'build tool rawtool 2.0: SHA-256 differs from engine.json' });
  });

  it('reports once an item that a source names twice with downloads that differ from an earlier source', async () => {
    const s = setup();
    makeGame(s.ws, 'g1', { 'settings.json': { engine: 'godot', coreVersion: '1.2.0' } });
    const rawtool = { hosts: ['macos-arm64'], name: 'rawtool', version: '2.0', versionCommand: 'rawtool --version' };
    const twice = (url: string, sha256: string): Record<string, unknown>[] => ['android', 'windows'].map((platform) => ({ ...rawtool, platform, downloads: [{ platform: 'any', url, sha256 }] }));
    writeFileSync(
      join(releaseDir.value, '1.2.0', 'client-godot', 'engine.json'),
      JSON.stringify({ godot: '4.5.1.stable', downloads: s.engineJson.downloads, buildTools: twice('https://dl/rawtool', sha(RAWTOOL)) }),
    );
    writeCoreEngineJson(s, { buildTools: twice('https://dl/rawtool-other', sha('other')) });
    setNet(fakeNet(s.routes));
    const run = await ogw(s.ws, ['env', 'install-engines'], { env: s.env });
    const differ = run.stdout.split('\n').filter((l) => l.includes('with different downloads'));
    expect(differ).toHaveLength(1);
  });

  it('installs from the downloads it is given', async () => {
    const s = setup();
    setNet(fakeNet(s.routes));
    const downloads = s.engineJson.downloads as ToolDownload[];
    const source = { engine: 'godot', version: '4.5.1.stable', json: { godot: '4.5.1.stable', downloads: [] }, from: 'open-game-works-core-impl', buildPlatforms: null };
    expect(await installEngine(s.ctx, source, hostDownloads(downloads, 'macos-arm64'))).toEqual(OK);
    expect(await enginePath(s.ctx, 'godot', '4.5.1.stable')).not.toBeNull();
    const rawtool = { platform: 'android', hosts: ['macos-arm64'], name: 'rawtool', version: '2.0', versionCommand: 'rawtool --version', downloads: [] };
    expect(await installBuildTool(s.ctx, rawtool, { platform: 'any', url: 'https://dl/rawtool', sha256: sha(RAWTOOL) })).toEqual(OK);
    expect(await buildToolProgram(s.ctx, 'rawtool', '2.0')).not.toBeNull();
    expect(await installBuildTool(s.ctx, { ...rawtool, name: 'none' }, null)).toMatchObject({ installed: false, reason: 'no download for this host' });
  });

  it('fails a download whose URL file name leaves the download folder and writes nothing outside the install folder', async () => {
    const s = setup();
    const evil = 'https://dl/x/..%2F..%2F..%2Fevil.zip';
    writeCoreEngineJson(s, { downloads: [{ platform: 'macos-arm64', url: evil, sha256: 'a'.repeat(64) }], buildTools: [] });
    setNet(fakeNet({ ...s.routes, [evil]: Buffer.from('evil') }));
    const run = await ogw(s.ws, ['env', 'install-engines'], { env: s.env });
    expect(run).toMatchObject({ code: 1, stdout: `engine godot 4.5.1.stable (open-game-works-core-impl): failed: download URL file name is not a plain file name: ${evil}\n` });
    expect(existsSync(join(s.ws.root, '.ogw', 'engines', 'evil.zip'))).toBe(false);
    expect(existsSync(join(s.ws.root, '.ogw', 'engines', 'godot', '4.5.1.stable'))).toBe(false);
  });
});

describe('Godot layout', () => {
  it('keeps self-contained data next to the macOS bundle and next to other executables', () => {
    expect(godotDataRoot('/e/editor/Godot.app/Contents/MacOS/Godot')).toBe('/e/editor');
    expect(godotDataRoot('/e/editor/Godot_v4_linux.x86_64')).toBe('/e/editor');
    expect(godotDataRoot('/e/Foo/MacOS/Godot')).toBe('/e/Foo/MacOS');
    expect(godotDataRoot('/e/Contents/Other/Godot')).toBe('/e/Contents/Other');
  });

  it('picks the editor executable of each platform download', () => {
    expect(isGodotExecutable('Godot', 'Godot.app/Contents/MacOS/Godot')).toBe(true);
    expect(isGodotExecutable('Godot', 'Godot/Contents/MacOS/Godot')).toBe(false);
    expect(isGodotExecutable('Info.plist', 'Godot.app/Contents/Info.plist')).toBe(false);
    expect(isGodotExecutable('Godot_v4.5.1-stable_linux.x86_64', 'Godot_v4.5.1-stable_linux.x86_64')).toBe(true);
    expect(isGodotExecutable('Godot_v4.5.1-stable_win64.exe', 'Godot_v4.5.1-stable_win64.exe')).toBe(true);
    expect(isGodotExecutable('Godot_v4.5.1-stable_win64_console.exe', 'Godot_v4.5.1-stable_win64_console.exe')).toBe(false);
    expect(isGodotExecutable('A.x86_64', 'A.x86_64')).toBe(false);
    expect(isGodotExecutable('A_win64.exe', 'A_win64.exe')).toBe(false);
    expect(isGodotExecutable('Godot_v4.5.1-stable_README.txt', 'Godot_v4.5.1-stable_README.txt')).toBe(false);
  });
});

describe('requireEngine', () => {
  it('tells to run install-engines when the engine version is missing', async () => {
    const { ctx } = setup();
    await expect(requireEngine(ctx, 'godot', '4.5.1.stable')).rejects.toMatchObject({ message: 'engine godot 4.5.1.stable is not on this host. Run ogw env install-engines' });
  });

  it('fails when the executable reports another version', async () => {
    const { ws, env, ctx, routes } = setup('4.4.9.stable\n');
    setNet(fakeNet(routes));
    await ogw(ws, ['env', 'install-engines'], { env });
    const exe = join(ws.root, '.ogw', 'engines', 'godot', '4.5.1.stable', 'editor', 'Godot.app', 'Contents', 'MacOS', 'Godot');
    await expect(requireEngine(ctx, 'godot', '4.5.1.stable')).rejects.toMatchObject({ message: `engine godot at ${exe} reports version "4.4.9.stable", not 4.5.1.stable. Run ogw env install-engines` });
  });

  it('fails when the executable exits with an error even if it prints the version, or prints nothing', async () => {
    const failing = setup('4.5.1.stable.official\n', 3);
    setNet(fakeNet(failing.routes));
    await ogw(failing.ws, ['env', 'install-engines'], { env: failing.env });
    await expect(requireEngine(failing.ctx, 'godot', '4.5.1.stable')).rejects.toThrow('reports version "4.5.1.stable.official", not 4.5.1.stable');
    const silent = setup('');
    setNet(fakeNet(silent.routes));
    await ogw(silent.ws, ['env', 'install-engines'], { env: silent.env });
    await expect(requireEngine(silent.ctx, 'godot', '4.5.1.stable')).rejects.toThrow('reports version "", not 4.5.1.stable');
  });
});
