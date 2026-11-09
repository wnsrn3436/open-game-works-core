// `ogw generation install`: failures that are no expected case (a marker that is not JSON, a link that fails for another
// reason than that no hard link can be made, a real path that cannot be read) are thrown or fail the install, and the
// expected cases still work: among them the hf file of another install that is removed or replaced while it is taken.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setNet } from '../../../src/commands/env/lib/net.ts';
import * as files from '../../../src/commands/env/lib/files.ts';
import { sha256Text } from '../../../src/commands/env/lib/files.ts';
import { installedFrom, methodMarker, type MethodMarker } from '../../../src/commands/generation/lib/install.ts';
import { createContext } from '../../../src/lib/command.ts';
import type { GenerationMethod, GenerationPin } from '../../../src/lib/settings.ts';
import { makeWorkspace, ogw, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeBin, fakeNet, type FakeNet } from '../env/fakes.ts';
import { installFolder, type MethodLike } from './install-folder.ts';

vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>();
  return { ...actual, copyFile: vi.fn(actual.copyFile), link: vi.fn(actual.link), realpath: vi.fn(actual.realpath) };
});

vi.mock('../../../src/commands/env/lib/files.ts', async (orig) => {
  const actual = await orig<typeof import('../../../src/commands/env/lib/files.ts')>();
  return { ...actual, sha256File: vi.fn(actual.sha256File) };
});

const actualLink = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).link;
const actualSha256File = (await vi.importActual<typeof import('../../../src/commands/env/lib/files.ts')>('../../../src/commands/env/lib/files.ts')).sha256File;

afterEach(() => {
  setNet(null);
  vi.mocked(fsPromises.copyFile).mockReset();
  vi.mocked(fsPromises.link).mockReset();
  vi.mocked(fsPromises.realpath).mockReset();
  vi.mocked(files.sha256File).mockReset();
});

const REV = 'c'.repeat(40);
const HF = { kind: 'hf', source: 'o/m', revision: REV };

function errno(code: string, what = 'link'): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${what} failed`), { code });
}

/** A workspace with the hf method `m`, its hf files on a fake network, and a fake uv for the pip pin of a second install. */
function setup(): { ws: TestWorkspace; env: NodeJS.ProcessEnv; net: FakeNet; install: (pins: object[]) => Promise<{ code: number; result: { installed: boolean; reason: string | null } | null; stderr: string }> } {
  const ws = makeWorkspace({ resourceGeneration: [{ name: 'm', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins: [HF] }] });
  const bin = fakeBin(join(ws.root, 'bin'), { uv: 'if [ "$1" = venv ]; then for last; do :; done; mkdir -p "$last/bin"; touch "$last/bin/python"; fi\nexit 0' });
  const env = { ...ws.env, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: join(ws.root, 'tmp'), OGW_HOST_PLATFORM: 'macos-arm64' };
  const net = fakeNet({
    [`https://huggingface.co/api/models/o/m/revision/${REV}?blobs=true`]: { sha: REV, siblings: [{ rfilename: 'big.bin', lfs: { sha256: sha256Text('big') } }] },
    [`https://huggingface.co/o/m/resolve/${REV}/big.bin`]: 'big',
  });
  setNet(net);
  const settingsFile = join(ws.harness, 'settings.json');
  const install = async (pins: object[]) => {
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { resourceGeneration: { pins: unknown[] }[] };
    (settings.resourceGeneration[0] as { pins: unknown[] }).pins = pins;
    writeFileSync(settingsFile, JSON.stringify(settings));
    const run = await ogw(ws, ['generation', 'install', 'm', '--json'], { env });
    const result = run.stdout === '' ? null : ((JSON.parse(run.stdout) as { methods?: Record<string, { installed: boolean; reason: string | null }> }).methods?.m ?? null);
    return { code: run.code, result, stderr: run.stderr };
  };
  return { ws, env, net, install };
}

function method(pins: object[]): MethodLike {
  return { name: 'm', kind: 'local-model', resourceTypes: ['bgm'], safetyTimeoutMs: 1, license: 'X', pins };
}

describe('the hf file of another install', () => {
  it('is hard-linked, copied when no hard link can be made, and fails the install on any other link or copy failure', async () => {
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
    // a copy that fails for another reason than a file that is gone: the install fails with it
    vi.mocked(fsPromises.link).mockRejectedValueOnce(errno('EXDEV'));
    vi.mocked(fsPromises.copyFile).mockRejectedValueOnce(errno('EIO', 'copy'));
    const notCopied = await install([{ kind: 'pip', source: 'x==4' }, HF]);
    expect(notCopied.result).toMatchObject({ installed: false, reason: 'EIO: copy failed', mismatches: [] });
  });
});

/** Writes into `folder` an install of `m` with the hf pin `HF` and its file, and returns that file. */
function writeOtherInstall(folder: string): string {
  const file = join(folder, 'hf', '0', 'big.bin');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'big');
  writeFileSync(join(folder, 'installed.json'), JSON.stringify({ name: 'm', pins: JSON.stringify([HF]), git: [], hf: [], files: null, python: null, cli: null, skill: null }));
  return file;
}

/**
 * The first step of an install of `m` by a harness whose install folder of `m` is `.ogw/generation/m/`, which holds no
 * lock of the install folders of this harness: it removes the marker of `folder` and moves `hf/0` to `.reuse/0`.
 */
function emptyOtherInstall(folder: string): void {
  rmSync(join(folder, 'installed.json'));
  mkdirSync(join(folder, '.reuse'), { recursive: true });
  renameSync(join(folder, 'hf', '0'), join(folder, '.reuse', '0'));
}

/** Puts another file with the text `other` at the hf file of the install in `folder`, as a new download of that install does. */
function replaceOtherInstallFile(folder: string): void {
  const file = join(folder, 'hf', '0', 'big.bin');
  rmSync(file);
  writeFileSync(file, 'other');
}

describe('the hf file of another install that is removed or replaced while the install takes it', () => {
  // `older`: the install in `.ogw/generation/m/`; `next`: a second other install in `.ogw/generation/m/next/`, when the
  // case has one. `during`: what happens to them while the install reads a SHA-256 (`hash`) or makes the link (`link`).
  const cases: { name: string; at: 'hash' | 'link'; during: (older: string) => void; noHardLink?: boolean; next?: boolean; downloads: number; olderKeeps?: string }[] = [
    { name: 'removed while a SHA-256 is read: taken', at: 'hash', during: emptyOtherInstall, downloads: 0 },
    { name: 'removed before it is linked: downloaded', at: 'link', during: emptyOtherInstall, downloads: 1 },
    { name: 'removed before it is copied: downloaded', at: 'link', during: emptyOtherInstall, noHardLink: true, downloads: 1 },
    { name: 'removed before it is linked, with a next other install: taken from that one', at: 'link', during: emptyOtherInstall, next: true, downloads: 0 },
    { name: 'replaced by another file before it is linked: downloaded, the other install keeps its file', at: 'link', during: replaceOtherInstallFile, downloads: 1, olderKeeps: 'other' },
    { name: 'replaced by another file before it is copied: downloaded, the other install keeps its file', at: 'link', during: replaceOtherInstallFile, noHardLink: true, downloads: 1, olderKeeps: 'other' },
  ];
  it.each(cases)('$name', async ({ at, during, noHardLink, next, downloads, olderKeeps }) => {
    const { ws, env, net, install } = setup();
    const dir = await installFolder(ws, method([HF]), env);
    // `dir` is `.ogw/generation-install/m/<install key>/`
    const older = join(dirname(dirname(dirname(dir))), 'generation', 'm');
    writeOtherInstall(older);
    const nextFile = next === true ? writeOtherInstall(join(older, 'next')) : null;
    if (at === 'hash') {
      vi.mocked(files.sha256File).mockImplementationOnce((path) => {
        during(older);
        return actualSha256File(path);
      });
    } else {
      vi.mocked(fsPromises.link).mockImplementationOnce((from, to) => {
        during(older);
        return noHardLink === true ? Promise.reject(errno('EXDEV')) : actualLink(from, to);
      });
    }
    expect((await install([HF])).result).toMatchObject({ installed: true, reason: null });
    const file = join(dir, 'hf', '0', 'big.bin');
    expect(readFileSync(file, 'utf8')).toBe('big');
    expect(net.calls.filter((c) => c === `GET https://huggingface.co/o/m/resolve/${REV}/big.bin`)).toHaveLength(downloads);
    if (nextFile !== null) expect(statSync(file).ino).toBe(statSync(nextFile).ino);
    if (olderKeeps !== undefined) expect(readFileSync(join(older, 'hf', '0', 'big.bin'), 'utf8')).toBe(olderKeeps);
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
