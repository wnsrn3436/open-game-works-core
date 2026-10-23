import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractArchive, isSafeEntryName, sha256File, writeTgz, writeZip } from '../../../../src/commands/core/lib/archive.ts';
import { changedPaths, exportTree } from '../../../../src/commands/core/lib/gitx.ts';
import { hostPlatform, moduleFolder, workingFiles } from '../../../../src/commands/core/lib/impl.ts';
import { verifyRelease } from '../../../../src/commands/core/lib/manifest.ts';
import { overlay } from '../../../../src/commands/core/lib/merge.ts';
import {
  compareVersions,
  isVersion,
  majorOf,
  releaseTag,
  requireVersion,
  sortVersions,
  versionParts,
} from '../../../../src/commands/core/lib/version.ts';
import { commitAll, gitInit, sh } from '../../../helpers/workspace.ts';
import { makeReleaseDir, sha256 } from '../helpers.ts';

function temp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'ogw-core-lib-')));
}

describe('version', () => {
  it('accepts <major>.<minor>.<patch> only', () => {
    expect(isVersion('1.2.3')).toBe(true);
    expect(isVersion('0.0.0')).toBe(true);
    expect(isVersion('01.2.3')).toBe(false);
    expect(isVersion('1.2')).toBe(false);
    expect(isVersion('v1.2.3')).toBe(false);
    expect(() => requireVersion('x')).toThrow('invalid core version: x (expected <major>.<minor>.<patch>)');
    expect(() => versionParts('1.x.0')).toThrow('invalid core version');
    expect(requireVersion('3.0.1')).toBe('3.0.1');
  });

  it('compares numerically and sorts without duplicates', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(sortVersions(['1.10.0', '1.2.0', '1.2.0', '0.9.9'])).toEqual(['0.9.9', '1.2.0', '1.10.0']);
    expect(majorOf('4.1.2')).toBe(4);
    expect(releaseTag('1.2.3')).toBe('v1.2.3');
    expect(versionParts('7.8.9')).toEqual([7, 8, 9]);
  });
});

describe('archive', () => {
  it('writes a zip and a tgz that extract to the same files', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'a.txt'), 'A');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'b.txt'), 'B');
    await writeZip(join(dir, 'out', 'x.zip'), [
      { name: 'sub/b.txt', source: join(dir, 'sub', 'b.txt') },
      { name: 'a.txt', source: join(dir, 'a.txt') },
    ]);
    await writeTgz(join(dir, 'out', 'x.tgz'), dir, ['a.txt', 'sub/b.txt']);
    await extractArchive(join(dir, 'out', 'x.zip'), join(dir, 'z'));
    await extractArchive(join(dir, 'out', 'x.tgz'), join(dir, 't'));
    for (const root of ['z', 't']) {
      expect(readFileSync(join(dir, root, 'a.txt'), 'utf8')).toBe('A');
      expect(readFileSync(join(dir, root, 'sub', 'b.txt'), 'utf8')).toBe('B');
    }
    expect(await sha256File(join(dir, 'a.txt'))).toBe(sha256('A'));
  });

  it('rejects other files and leaves nothing behind', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'x.rar'), 'no');
    await expect(extractArchive(join(dir, 'x.rar'), join(dir, 'out'))).rejects.toThrow('not an archive asset');
    writeFileSync(join(dir, 'bad.zip'), 'not a zip');
    await expect(extractArchive(join(dir, 'bad.zip'), join(dir, 'out'))).rejects.toThrow('cannot read zip');
    writeFileSync(join(dir, 'bad.tgz'), 'not a tgz');
    await expect(extractArchive(join(dir, 'bad.tgz'), join(dir, 'out'))).rejects.toThrow('cannot read tgz');
    expect(sh(dir, 'ls', ['-a']).split('\n').filter((n) => n.startsWith('out'))).toEqual([]);
  });

  it('tells safe entry names', () => {
    expect(isSafeEntryName('a/b.txt')).toBe(true);
    expect(isSafeEntryName('../a')).toBe(false);
    expect(isSafeEntryName('a/../../b')).toBe(false);
    expect(isSafeEntryName('..')).toBe(false);
    expect(isSafeEntryName('/etc/passwd')).toBe(false);
    expect(isSafeEntryName('C:x')).toBe(false);
    expect(isSafeEntryName('a\\b')).toBe(false);
    expect(isSafeEntryName('')).toBe(false);
  });
});

describe('manifest', () => {
  it('passes a matching release and lists every problem otherwise', async () => {
    const dir = makeReleaseDir(join(temp(), 'r'), '1.0.0', { 'a.json': '{}', 'b.tgz': 'B' });
    mkdirSync(join(dir, 'b'));
    expect(await verifyRelease(dir, '1.0.0')).toEqual([]);
    expect(await verifyRelease(dir, '1.0.1')).toEqual(['manifest.json version is "1.0.0", not 1.0.1']);
    writeFileSync(join(dir, 'a.json'), '{"x":1}');
    writeFileSync(join(dir, 'extra.txt'), '');
    sh(dir, 'rm', ['b.tgz']);
    expect(await verifyRelease(dir, '1.0.0')).toEqual([
      'a.json does not match its SHA-256 in manifest.json',
      'b.tgz is missing',
      'extra.txt is not in manifest.json',
    ]);
    writeFileSync(join(dir, 'manifest.json'), '{"version":"1.0.0"}');
    expect(await verifyRelease(dir, '1.0.0')).toEqual(['manifest.json is missing or invalid']);
    writeFileSync(join(dir, 'manifest.json'), 'not json');
    expect(await verifyRelease(dir, '1.0.0')).toEqual(['manifest.json is missing or invalid']);
  });
});

describe('overlay', () => {
  it('merges objects by key and replaces arrays and values', () => {
    expect(overlay({ a: 1, b: { c: 1, d: [1, 2] }, e: [1] }, { b: { d: [3] }, e: [2], f: 'x' })).toEqual({
      a: 1,
      b: { c: 1, d: [3] },
      e: [2],
      f: 'x',
    });
    expect(overlay({ a: 1 }, null)).toBeNull();
    expect(overlay([1], { a: 1 })).toEqual({ a: 1 });
  });
});

describe('impl helpers', () => {
  it('makes module folders and host platform names', () => {
    expect(moduleFolder('UICore')).toBe('ui_core');
    expect(moduleFolder('LocalDataCore')).toBe('local_data_core');
    expect(moduleFolder('QACore')).toBe('qa_core');
    expect(moduleFolder('UnitTestCore')).toBe('unit_test_core');
    expect(hostPlatform('darwin')).toBe('macos');
    expect(hostPlatform('win32')).toBe('windows');
    expect(hostPlatform('linux')).toBe('linux');
  });

  it('lists working files git tracks or would track, and changed paths', async () => {
    const dir = temp();
    gitInit(dir);
    writeFileSync(join(dir, '.gitignore'), 'ignored/\n');
    mkdirSync(join(dir, 'd', 'ignored'), { recursive: true });
    writeFileSync(join(dir, 'd', 'kept.txt'), '1');
    writeFileSync(join(dir, 'd', 'gone.txt'), '1');
    commitAll(dir);
    writeFileSync(join(dir, 'd', 'new.txt'), '1');
    writeFileSync(join(dir, 'd', 'ignored', 'x.txt'), '1');
    sh(dir, 'rm', ['d/gone.txt']);
    expect(await workingFiles(dir, 'd/')).toEqual(['d/kept.txt', 'd/new.txt']);
    sh(dir, 'git', ['mv', 'd/kept.txt', 'd/moved.txt']);
    expect([...(await changedPaths(dir))].sort()).toEqual(['d/gone.txt', 'd/kept.txt', 'd/moved.txt', 'd/new.txt']);
    const out = temp();
    expect(await exportTree(dir, 'HEAD', 'd', out)).toBe(2);
    expect(readFileSync(join(out, 'd', 'kept.txt'), 'utf8')).toBe('1');
  });
});
