import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Text } from '../../../../src/commands/env/lib/files.ts';
import { InstallFailure, installItem, installLockPath, makeRunnable, readMarker } from '../../../../src/commands/env/lib/install.ts';
import { setNet } from '../../../../src/commands/env/lib/net.ts';
import {
  downloadFor,
  hasLibvorbis,
  installedToolProgram,
  installTool,
  pinFiles,
  postgresImage,
  postgresPresent,
  pullPostgres,
  toolDir,
} from '../../../../src/commands/env/lib/tools.ts';
import type { PythonToolPin, ToolDownload, ToolPin } from '../../../../src/lib/settings.ts';
import { createContext, type Context } from '../../../../src/lib/command.ts';
import { makeWorkspace, sh, type TestWorkspace } from '../../../helpers/workspace.ts';
import { fakeBin, fakeNet } from '../fakes.ts';

const sha = (body: string | Buffer): string => sha256Text(body as string);

interface Setup {
  ws: TestWorkspace;
  env: NodeJS.ProcessEnv;
  ctx: Context;
  log: string;
  bin: string;
}

const UV = 'echo "uv $*" >> "$OGW_TEST_LOG"\ncase "$*" in *fail-install*) echo "uv broke" >&2; exit 3;; esac';
const DOCKER = [
  'echo "docker $*" >> "$OGW_TEST_LOG"',
  'case "$*" in',
  '  "image inspect postgres@sha256:here") exit 0;;',
  '  "image inspect"*) exit 1;;',
  '  *"@sha256:stderr") echo "  manifest unknown  " >&2; exit 1;;',
  '  *"@sha256:stdout") echo "  denied on stdout  "; exit 1;;',
  '  *"@sha256:silent") exit 1;;',
  'esac',
].join('\n');

function setup(platform = 'macos-arm64'): Setup {
  const ws = makeWorkspace();
  const log = join(ws.root, 'calls.log');
  writeFileSync(log, '');
  const bin = fakeBin(join(ws.root, 'bin'), { uv: UV, docker: DOCKER });
  const env = { ...ws.env, PATH: `${bin}:/usr/bin:/bin`, OGW_TEST_LOG: log, OGW_HOST_PLATFORM: platform };
  const ctx = createContext({ cwd: ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
  return { ws, env, ctx, log, bin };
}

function ffmpegScript(encoders: string, code = 0): string {
  return `#!/bin/sh\nprintf '%s\\n' '${encoders}'\nexit ${String(code)}\n`;
}

function zipOf(dir: string, files: Record<string, string>, name: string): Buffer {
  const src = join(dir, `${name}-src`);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(src, path, '..'), { recursive: true });
    writeFileSync(join(src, path), body);
  }
  sh(src, 'zip', ['-qr', join(dir, name), '.']);
  return readFileSync(join(dir, name));
}

const d = (platform: ToolDownload['platform'], url: string, body: string | Buffer): ToolDownload => ({ platform, url, sha256: sha(body) });

beforeEach(() => {
  setNet(null);
});
afterEach(() => {
  setNet(null);
});

describe('tool pins', () => {
  it('picks the download of this host, then any', () => {
    const mac = { platform: 'macos-arm64', url: 'm', sha256: '1' } as const;
    const any = { platform: 'any', url: 'a', sha256: '2' } as const;
    const linux = { platform: 'linux-x64', url: 'l', sha256: '3' } as const;
    expect(downloadFor([any, mac], 'macos-arm64')).toBe(mac);
    expect(downloadFor([linux, any], 'macos-arm64')).toBe(any);
    expect(downloadFor([linux], 'macos-arm64')).toBeNull();
    expect(downloadFor([linux], null)).toBeNull();
    const python: PythonToolPin = { version: '4', python: '3.12', downloads: [any], dependencies: [linux, mac, { platform: 'any', url: 'x', sha256: '4' }] };
    expect(pinFiles(python, 'macos-arm64')).toEqual([any, mac, { platform: 'any', url: 'x', sha256: '4' }]);
    expect(pinFiles({ version: '1', downloads: [mac] }, 'macos-arm64')).toEqual([mac]);
    expect(pinFiles({ version: '1', downloads: [linux] }, 'macos-arm64')).toBeNull();
    expect(postgresImage({ tag: '18.1', digest: 'sha256:abc' })).toBe('postgres:18.1@sha256:abc');
  });

  it('installs a raw ffmpeg that has libvorbis once, and finds it only while the pin matches', async () => {
    const { ws, ctx } = setup();
    const body = ffmpegScript(' A....D libvorbis            Vorbis');
    const net = fakeNet({ 'https://dl/ffmpeg': body });
    setNet(net);
    const pin: ToolPin = { version: '6.1 b', downloads: [d('macos-arm64', 'https://dl/ffmpeg', body)] };
    const dir = join(ws.root, '.ogw', 'tools', 'ffmpeg', '6.1_b');
    expect(await toolDir(ctx, 'ffmpeg', pin)).toBe(dir);
    expect(await installTool(ctx, 'ffmpeg', pin)).toEqual({ installed: true, mismatches: [], reason: null });
    const program = join(dir, 'download', 'ffmpeg');
    expect(statSync(program).mode & 0o777).toBe(0o755);
    expect(await readMarker(dir)).toEqual({ name: 'ffmpeg', version: '6.1 b', sha256: [sha(body)], program: 'download/ffmpeg' });
    expect(await installedToolProgram(ctx, 'ffmpeg', pin)).toBe(program);
    expect(await installTool(ctx, 'ffmpeg', pin)).toEqual({ installed: true, mismatches: [], reason: null });
    expect(net.calls).toEqual(['GET https://dl/ffmpeg']);
    expect(await installedToolProgram(ctx, 'ffmpeg', undefined)).toBeNull();
    expect(await installedToolProgram(ctx, 'ffmpeg', { ...pin, downloads: [{ ...d('macos-arm64', 'https://dl/ffmpeg', 'other') }] })).toBeNull();
    expect(await installedToolProgram(ctx, 'ffmpeg', { ...pin, downloads: [d('linux-x64', 'https://dl/ffmpeg', body)] })).toBeNull();
    expect(await installedToolProgram(ctx, 'blender', pin)).toBeNull();
  });

  it('fails an ffmpeg without libvorbis and a pin without a download for this host', async () => {
    const { ws, ctx } = setup();
    const body = ffmpegScript(' A....D aac  AAC');
    setNet(fakeNet({ 'https://dl/ffmpeg': body }));
    expect(await installTool(ctx, 'ffmpeg', { version: '6', downloads: [d('any', 'https://dl/ffmpeg', body)] })).toEqual({
      installed: false,
      mismatches: [],
      reason: 'ffmpeg has no libvorbis encoder',
    });
    expect(existsSync(join(ws.root, '.ogw', 'tools', 'ffmpeg', '6'))).toBe(false);
    expect(await installTool(ctx, 'ffmpeg', { version: '6', downloads: [d('linux-x64', 'https://dl/ffmpeg', body)] })).toEqual({
      installed: false,
      mismatches: [],
      reason: 'no download for this host',
    });
  });

  it('finds the program of an archive, and fails when the archive has none', async () => {
    const { ws, ctx } = setup();
    const scratch = join(ws.root, 'scratch');
    const chrome = zipOf(scratch, { 'chrome-headless-shell-mac/LICENSE': 'l', 'chrome-headless-shell-mac/chrome-headless-shell': 'c' }, 'chrome.zip');
    const blender = zipOf(scratch, { 'blender/readme': 'r', 'blender/blender.exe': 'b' }, 'blender.zip');
    const empty = zipOf(scratch, { 'x/readme': 'r' }, 'empty.zip');
    setNet(fakeNet({ 'https://dl/chrome.zip': chrome, 'https://dl/blender.zip': blender, 'https://dl/empty.zip': empty }));
    expect(await installTool(ctx, 'chromium', { version: '1', downloads: [d('any', 'https://dl/chrome.zip', chrome)] })).toMatchObject({ installed: true });
    expect(await installedToolProgram(ctx, 'chromium', { version: '1', downloads: [d('any', 'https://dl/chrome.zip', chrome)] })).toBe(
      join(ws.root, '.ogw', 'tools', 'chromium', '1', 'files', 'chrome-headless-shell-mac', 'chrome-headless-shell'),
    );
    expect(await installTool(ctx, 'blender', { version: '5', downloads: [d('any', 'https://dl/blender.zip', blender)] })).toMatchObject({ installed: true });
    expect(await installedToolProgram(ctx, 'blender', { version: '5', downloads: [d('any', 'https://dl/blender.zip', blender)] })).toBe(
      join(ws.root, '.ogw', 'tools', 'blender', '5', 'files', 'blender', 'blender.exe'),
    );
    expect(await installTool(ctx, 'ffmpeg', { version: '2', downloads: [d('any', 'https://dl/empty.zip', empty)] })).toEqual({
      installed: false,
      mismatches: [],
      reason: 'program of ffmpeg not found in the download',
    });
    expect(existsSync(join(ws.root, '.ogw', 'tools', 'ffmpeg', '2'))).toBe(false);
  });

  it('keeps a placeholder font as downloaded', async () => {
    const { ws, ctx } = setup();
    setNet(fakeNet({ 'https://dl/Noto%20Sans.ttf': 'font' }));
    const pin: ToolPin = { version: 'v1', downloads: [d('any', 'https://dl/Noto%20Sans.ttf', 'font')] };
    expect(await installTool(ctx, 'placeholderFont', pin)).toMatchObject({ installed: true });
    const font = join(ws.root, '.ogw', 'tools', 'placeholderFont', 'v1', 'download', 'Noto Sans.ttf');
    expect(await installedToolProgram(ctx, 'placeholderFont', pin)).toBe(font);
    expect(statSync(font).mode & 0o111).toBe(0);
  });

  it('installs gdtoolkit wheels into an isolated environment of the pinned Python', async () => {
    const { ws, ctx, log } = setup();
    setNet(fakeNet({ 'https://dl/gdtoolkit.whl': 'g', 'https://dl/lark.whl': 'l', 'https://dl/linux.whl': 'x' }));
    const pin: PythonToolPin = {
      version: '4.5.0',
      python: '3.12',
      downloads: [d('any', 'https://dl/gdtoolkit.whl', 'g')],
      dependencies: [d('any', 'https://dl/lark.whl', 'l'), d('linux-x64', 'https://dl/linux.whl', 'x')],
    };
    expect(await installTool(ctx, 'gdtoolkit', pin)).toEqual({ installed: true, mismatches: [], reason: null });
    const dir = join(ws.root, '.ogw', 'tools', 'gdtoolkit', '4.5.0');
    expect(readFileSync(log, 'utf8')).toBe(
      [
        `uv venv --quiet --python 3.12 ${join(dir, 'venv')}`,
        `uv pip install --quiet --no-deps --python ${join(dir, 'venv', 'bin', 'python')} ${join(dir, 'download', 'gdtoolkit.whl')} ${join(dir, 'download', 'lark.whl')}`,
        '',
      ].join('\n'),
    );
    expect(await installedToolProgram(ctx, 'gdtoolkit', pin)).toBe(join(dir, 'venv', 'bin', 'gdlint'));
    const win = setup('windows-x64');
    setNet(fakeNet({ 'https://dl/gdtoolkit.whl': 'g', 'https://dl/lark.whl': 'l' }));
    expect(await installTool(win.ctx, 'gdtoolkit', pin)).toMatchObject({ installed: true });
    const winDir = join(win.ws.root, '.ogw', 'tools', 'gdtoolkit', '4.5.0');
    expect(readFileSync(win.log, 'utf8')).toContain(`--python ${join(winDir, 'venv', 'Scripts', 'python.exe')} `);
    expect(await installedToolProgram(win.ctx, 'gdtoolkit', pin)).toBe(join(winDir, 'venv', 'Scripts', 'gdlint.exe'));
  });

  it('reports every download that differs from the pin, and a failing uv', async () => {
    const { ws, ctx } = setup();
    setNet(fakeNet({ 'https://dl/gdtoolkit.whl': 'G', 'https://dl/lark.whl': 'L', 'https://dl/fail-install.whl': 'f' }));
    const pin: PythonToolPin = { version: '4', python: '3.12', downloads: [d('any', 'https://dl/gdtoolkit.whl', 'g')], dependencies: [d('any', 'https://dl/lark.whl', 'l')] };
    expect(await installTool(ctx, 'gdtoolkit', pin)).toEqual({
      installed: false,
      reason: 'SHA-256 differs from the pin',
      mismatches: [
        { what: 'https://dl/gdtoolkit.whl', path: 'https://dl/gdtoolkit.whl', expected: sha('g'), actual: sha('G') },
        { what: 'https://dl/lark.whl', path: 'https://dl/lark.whl', expected: sha('l'), actual: sha('L') },
      ],
    });
    const failing = await installTool(ctx, 'gdtoolkit', { ...pin, downloads: [d('any', 'https://dl/fail-install.whl', 'f')], dependencies: [] });
    expect(failing.installed).toBe(false);
    expect(failing.reason).toContain('uv broke');
    expect(existsSync(join(ws.root, '.ogw', 'tools', 'gdtoolkit', '4'))).toBe(false);
  });
});

describe('ffmpeg and postgres probes', () => {
  it('needs the libvorbis encoder as its own word in a successful encoder list', async () => {
    const { ctx, ws } = setup();
    const bin = fakeBin(join(ws.root, 'probe'), {
      yes: "printf '%s\\n' ' A....D libvorbis            Vorbis'",
      fails: "printf '%s\\n' ' A....D libvorbis            Vorbis'; exit 1",
      prefixed: "printf '%s\\n' ' A....D xlibvorbis  X'",
      suffixed: "printf '%s\\n' ' A....D libvorbisx  X'",
      args: '[ "$1 $2" = "-hide_banner -encoders" ] && printf \'%s\\n\' \' A....D libvorbis  V\'',
    });
    expect(await hasLibvorbis(ctx, join(bin, 'yes'))).toBe(true);
    expect(await hasLibvorbis(ctx, join(bin, 'args'))).toBe(true);
    expect(await hasLibvorbis(ctx, join(bin, 'fails'))).toBe(false);
    expect(await hasLibvorbis(ctx, join(bin, 'prefixed'))).toBe(false);
    expect(await hasLibvorbis(ctx, join(bin, 'suffixed'))).toBe(false);
    expect(await hasLibvorbis(ctx, join(bin, 'missing'))).toBe(false);
  });

  it('checks and pulls the pinned postgres image', async () => {
    const { ctx, log, env } = setup();
    expect(await postgresPresent(ctx, { tag: '18', digest: 'sha256:here' })).toBe(true);
    expect(await postgresPresent(ctx, { tag: '18', digest: 'sha256:gone' })).toBe(false);
    expect(await pullPostgres(ctx, { tag: '18.1', digest: 'sha256:ok' })).toEqual({ installed: true, mismatches: [], reason: null });
    expect(await pullPostgres(ctx, { tag: '18.1', digest: 'sha256:stderr' })).toEqual({ installed: false, mismatches: [], reason: 'manifest unknown' });
    expect(await pullPostgres(ctx, { tag: '18.1', digest: 'sha256:stdout' })).toEqual({ installed: false, mismatches: [], reason: 'denied on stdout' });
    expect(await pullPostgres(ctx, { tag: '18.1', digest: 'sha256:silent' })).toEqual({ installed: false, mismatches: [], reason: 'docker pull failed' });
    expect(readFileSync(log, 'utf8')).toBe(
      [
        'docker image inspect postgres@sha256:here',
        'docker image inspect postgres@sha256:gone',
        'docker pull postgres:18.1@sha256:ok',
        'docker pull postgres:18.1@sha256:stderr',
        'docker pull postgres:18.1@sha256:stdout',
        'docker pull postgres:18.1@sha256:silent',
        '',
      ].join('\n'),
    );
    const noDocker = createContext({ cwd: '/', env: { ...env, PATH: '/nowhere' }, stdin: () => Promise.resolve(''), stderr: () => undefined });
    expect(await postgresPresent(noDocker, { tag: '18', digest: 'sha256:here' })).toBe(false);
    const pulled = await pullPostgres(noDocker, { tag: '18', digest: 'sha256:ok' });
    expect(pulled.installed).toBe(false);
    expect(pulled.reason).toContain('cannot run docker');
  });
});

describe('install routine', () => {
  it('makes a raw program runnable, with an .exe copy on Windows', async () => {
    const { ws } = setup();
    const file = join(ws.root, 'prog');
    writeFileSync(file, 'p');
    expect(await makeRunnable(file, { OGW_HOST_PLATFORM: 'macos-arm64' })).toBe(file);
    expect(statSync(file).mode & 0o777).toBe(0o755);
    expect(existsSync(`${file}.exe`)).toBe(false);
    expect(await makeRunnable(file, { OGW_HOST_PLATFORM: 'windows-x64' })).toBe(`${file}.exe`);
    expect(readFileSync(`${file}.exe`, 'utf8')).toBe('p');
    const exe = join(ws.root, 'TOOL.EXE');
    writeFileSync(exe, 'e');
    expect(await makeRunnable(exe, { OGW_HOST_PLATFORM: 'windows-x64' })).toBe(exe);
    expect(existsSync(`${exe}.exe`)).toBe(false);
  });

  it('locks a hidden sibling of the install folder while installing, and fails with the reason of a failed placement', async () => {
    const { ws } = setup();
    const dir = join(ws.root, 'items', 'thing', '1.0');
    expect(installLockPath(dir)).toBe(join(ws.root, 'items', 'thing', '.1.0.lock'));
    setNet(fakeNet({ 'https://dl/a': 'a' }));
    let lockedDuring = false;
    const item = {
      dir,
      name: 'thing',
      version: '1.0',
      downloads: [d('any', 'https://dl/a', 'a')],
      mismatchReason: 'differs',
      notFoundReason: 'none',
      place: (files: { file: string }[]): Promise<string | null> => {
        lockedDuring = existsSync(installLockPath(dir));
        return Promise.resolve(files[0]?.file ?? null);
      },
    };
    expect(await installItem(item)).toEqual({ installed: true, mismatches: [], reason: null });
    expect(lockedDuring).toBe(true);
    expect(existsSync(installLockPath(dir))).toBe(false);
    expect(await readMarker(dir)).toEqual({ name: 'thing', version: '1.0', sha256: [sha('a')], program: 'download/a' });
    const other = join(ws.root, 'items', 'thing', '2.0');
    const failed = await installItem({ ...item, dir: other, place: () => Promise.reject(new InstallFailure('bad place', [{ what: 'w', path: 'p', expected: 'e', actual: 'a' }])) });
    expect(failed).toEqual({ installed: false, mismatches: [{ what: 'w', path: 'p', expected: 'e', actual: 'a' }], reason: 'bad place' });
    expect(await installItem({ ...item, dir: other, place: () => Promise.resolve(null) })).toEqual({ installed: false, mismatches: [], reason: 'none' });
    expect(existsSync(other)).toBe(false);
  });
});
