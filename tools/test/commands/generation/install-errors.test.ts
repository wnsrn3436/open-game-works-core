// `ogw generation install`: failures that are no expected case (a marker that is not JSON, a link that fails for another
// reason than that no hard link can be made, a real path that cannot be read) are thrown or fail the install, and the
// expected cases still work.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setNet } from '../../../src/commands/env/lib/net.ts';
import { sha256Text } from '../../../src/commands/env/lib/files.ts';
import { installedFrom, methodMarker, type MethodMarker } from '../../../src/commands/generation/lib/install.ts';
import { createContext } from '../../../src/lib/command.ts';
import type { GenerationMethod, GenerationPin } from '../../../src/lib/settings.ts';
import { makeWorkspace, ogw, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeBin, fakeNet } from '../env/fakes.ts';
import { installFolder, type MethodLike } from './install-folder.ts';

vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link), realpath: vi.fn(actual.realpath) };
});

afterEach(() => {
  setNet(null);
  vi.mocked(fsPromises.link).mockReset();
  vi.mocked(fsPromises.realpath).mockReset();
});

const REV = 'c'.repeat(40);
const HF = { kind: 'hf', source: 'o/m', revision: REV };

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: link failed`), { code });
}

/** A workspace with the hf method `m`, its hf files on a fake network, and a fake uv for the pip pin of a second install. */
function setup(): { ws: TestWorkspace; env: NodeJS.ProcessEnv; install: (pins: object[]) => Promise<{ code: number; result: { installed: boolean; reason: string | null } | null; stderr: string }> } {
  const ws = makeWorkspace({ resourceGeneration: [{ name: 'm', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [HF] }] });
  const bin = fakeBin(join(ws.root, 'bin'), { uv: 'if [ "$1" = venv ]; then for last; do :; done; mkdir -p "$last/bin"; touch "$last/bin/python"; fi\nexit 0' });
  const env = { ...ws.env, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: join(ws.root, 'tmp'), OGW_HOST_PLATFORM: 'macos-arm64' };
  setNet(
    fakeNet({
      [`https://huggingface.co/api/models/o/m/revision/${REV}?blobs=true`]: { sha: REV, siblings: [{ rfilename: 'big.bin', lfs: { sha256: sha256Text('big') } }] },
      [`https://huggingface.co/o/m/resolve/${REV}/big.bin`]: 'big',
    }),
  );
  const settingsFile = join(ws.harness, 'settings.json');
  const install = async (pins: object[]) => {
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { resourceGeneration: { pins: unknown[] }[] };
    (settings.resourceGeneration[0] as { pins: unknown[] }).pins = pins;
    writeFileSync(settingsFile, JSON.stringify(settings));
    const run = await ogw(ws, ['generation', 'install', 'm', '--json'], { env });
    const result = run.stdout === '' ? null : ((JSON.parse(run.stdout) as { methods?: Record<string, { installed: boolean; reason: string | null }> }).methods?.m ?? null);
    return { code: run.code, result, stderr: run.stderr };
  };
  return { ws, env, install };
}

function method(pins: object[]): MethodLike {
  return { name: 'm', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins };
}

describe('the hf file of another install', () => {
  it('is hard-linked, copied when no hard link can be made, and fails the install on any other link failure', async () => {
    const { ws, env, install } = setup();
    expect((await install([HF])).result).toMatchObject({ installed: true });
    const first = join(await installFolder(ws, method([HF]), env), 'hf', '0', 'big.bin');
    // linked: one file with two names
    const linked = [{ kind: 'pip', source: 'x==1' }, HF];
    expect((await install(linked)).result).toMatchObject({ installed: true });
    expect(statSync(first).nlink).toBe(2);
    // another file system: copied
    vi.mocked(fsPromises.link).mockRejectedValueOnce(errno('EXDEV'));
    const copied = [{ kind: 'pip', source: 'x==2' }, HF];
    expect((await install(copied)).result).toMatchObject({ installed: true });
    expect(readFileSync(join(await installFolder(ws, method(copied), env), 'hf', '1', 'big.bin'), 'utf8')).toBe('big');
    expect(statSync(first).nlink).toBe(2);
    // a failure that is not about hard links: not copied over, the install fails with it
    vi.mocked(fsPromises.link).mockRejectedValueOnce(errno('EIO'));
    const failed = await install([{ kind: 'pip', source: 'x==3' }, HF]);
    expect(failed.result).toMatchObject({ installed: false, reason: 'EIO: link failed', mismatches: [] });
  });
});

describe('install markers', () => {
  it('fails the install when the install folder holds an installed.json that is not JSON', async () => {
    const { ws, env, install } = setup();
    const dir = await installFolder(ws, method([HF]), env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'installed.json'), '{ broken');
    const run = await install([HF]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`invalid JSON in ${join(dir, 'installed.json')}`);
    expect(readFileSync(join(dir, 'installed.json'), 'utf8')).toBe('{ broken');
  });

  it('fails the install when another install of the method holds an installed.json that is not JSON', async () => {
    const { ws, env, install } = setup();
    const dir = await installFolder(ws, method([HF]), env);
    const other = join(dir, '..', 'other');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'installed.json'), 'not json');
    const run = await install([HF]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('invalid JSON in');
    expect(run.stderr).toContain(join('other', 'installed.json'));
  });

  it('fails the install when the hf files a failed install kept name their pins in a file that is not JSON', async () => {
    const { ws, env, install } = setup();
    const dir = await installFolder(ws, method([HF]), env);
    mkdirSync(join(dir, '.reuse'), { recursive: true });
    writeFileSync(join(dir, '.reuse', 'pins.json'), '{ broken');
    const run = await install([HF]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`invalid JSON in ${join(dir, '.reuse', 'pins.json')}`);
  });

  it('fails the install when the pins of its marker or of the marker of another install are not JSON', async () => {
    const { ws, env, install } = setup();
    const dir = await installFolder(ws, method([HF]), env);
    const marker = JSON.stringify({ name: 'm', pins: '[broken', git: [], hf: [], files: null, python: null, cli: null, skill: null });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'installed.json'), marker);
    const own = await install([HF]);
    expect(own.code).toBe(1);
    expect(own.stderr).toContain('JSON');
    rmSync(dir, { recursive: true });
    const other = join(dir, '..', 'other');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'installed.json'), marker);
    const theirs = await install([HF]);
    expect(theirs.code).toBe(1);
    expect(theirs.stderr).toContain('JSON');
  });
});

describe('methodMarker and installedFrom', () => {
  it('read an absent marker as not installed and throw one that is not JSON or whose pins are not JSON', async () => {
    const { ws, env } = setup();
    const ctx = createContext({ cwd: ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const pinned = method([HF]) as unknown as GenerationMethod;
    expect(await methodMarker(ctx, pinned)).toBeNull();
    const dir = await installFolder(ws, method([HF]), env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'installed.json'), '{ broken');
    await expect(methodMarker(ctx, pinned)).rejects.toThrow(`invalid JSON in ${join(dir, 'installed.json')}`);
    const marker = { name: 'm', git: [], hf: [], files: null, python: null, cli: null, skill: null };
    expect(() => installedFrom({ ...marker, pins: '[broken' }, [HF as GenerationPin])).toThrow(SyntaxError);
    // a marker without the pins JSON is not one of these pins
    expect(installedFrom({ ...marker } as unknown as MethodMarker, [])).toBe(false);
    expect(installedFrom({ ...marker, pins: '[]' }, [])).toBe(true);
  });
});

describe('install folder', () => {
  it('takes the real path of the deepest folder that exists, and throws a real path that cannot be read', async () => {
    const { ws, env } = setup();
    // `.ogw/generation-install/` is not there yet: the folder is that of the workspace with the rest after it
    expect(await installFolder(ws, method([HF]), env)).toMatch(new RegExp(`^${ws.root}/\\.ogw/generation-install/m/[0-9a-f]{16}$`));
    vi.mocked(fsPromises.realpath).mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied, realpath'), { code: 'EACCES' }));
    await expect(installFolder(ws, method([HF]), env)).rejects.toThrow('EACCES: permission denied, realpath');
  });
});
