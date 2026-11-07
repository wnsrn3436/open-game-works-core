import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releasedProposals } from '../../../../src/commands/core/api.ts';
import { fixtureIdErrors, licenseErrors } from '../../../../src/commands/core/lib/content-checks.ts';
import { readCoreSpecDir } from '../../../../src/commands/core/lib/impl.ts';
import { verifyRelease } from '../../../../src/commands/core/lib/manifest.ts';
import { installServerDependencies } from '../../../../src/commands/core/lib/server-tests.ts';
import { collectedDataVocabulary } from '../../../../src/commands/core/lib/spec-build.ts';
import { resourceRightsSpans } from '../../../../src/commands/core/lib/spec-licenses.ts';
import { readModuleEntries } from '../../../../src/commands/core/lib/spec-modules.ts';
import { harnessToolsTree, keptResult } from '../../../../src/commands/core/lib/test-reuse.ts';
import type { GameRepo } from '../../../../src/lib/game.ts';

// A failure other than the one a read expects (a missing file, a file that is not JSON) is not turned into a default
// value: it fails the command. The expected case keeps its result.

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'ogw-read-failures-'));
}

function gitRepo(): string {
  const dir = temp();
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

describe('core reads that expect one failure', () => {
  it('released proposals: no folder gives none, a file where the folder is fails', async () => {
    const root = temp();
    const game = { root } as GameRepo;
    expect(await releasedProposals(game, '1.0.0', '2.0.0')).toEqual([]);
    mkdirSync(join(root, 'records'));
    writeFileSync(join(root, 'records', 'core-proposals'), 'not a folder');
    await expect(releasedProposals(game, '1.0.0', '2.0.0')).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('licenses.json: a missing or not-JSON file is invalid, a folder in its place fails the check run', async () => {
    const impl = temp();
    expect(await licenseErrors(impl, temp())).toEqual(['licenses.json is missing or invalid']);
    writeFileSync(join(impl, 'licenses.json'), 'not json');
    expect(await licenseErrors(impl, temp())).toEqual(['licenses.json is missing or invalid']);
    const folder = temp();
    mkdirSync(join(folder, 'licenses.json'));
    await expect(licenseErrors(folder, temp())).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('core test fixtures: a fixture that is not JSON fails the check run instead of naming no ID name', async () => {
    const impl = temp();
    mkdirSync(join(impl, 'fixtures'));
    writeFileSync(join(impl, 'fixtures', 'good.json'), JSON.stringify({ cases: [{ input: '[potion]', expected: null }] }));
    expect(await fixtureIdErrors(impl, new Set(['[potion]']))).toEqual([]);
    writeFileSync(join(impl, 'fixtures', 'broken.json'), '{"cases": [');
    await expect(fixtureIdErrors(impl, new Set(['[potion]']))).rejects.toThrow(/invalid JSON in .*broken\.json/);
  });

  it('release manifest: a missing or not-JSON manifest.json is invalid, a folder in its place fails', async () => {
    const dir = temp();
    expect(await verifyRelease(dir, '1.0.0')).toEqual(['manifest.json is missing or invalid']);
    writeFileSync(join(dir, 'manifest.json'), 'not json');
    expect(await verifyRelease(dir, '1.0.0')).toEqual(['manifest.json is missing or invalid']);
    const folder = temp();
    mkdirSync(join(folder, 'manifest.json'));
    await expect(verifyRelease(folder, '1.0.0')).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('core-spec/ with skipInvalid: a file that is not JSON is left out, a folder named like a module file fails', async () => {
    const impl = temp();
    mkdirSync(join(impl, 'core-spec'));
    writeFileSync(join(impl, 'core-spec', 'A.json'), JSON.stringify({ name: 'A', side: 'client', dependencies: [], optionalDependencies: [], devDependencies: [] }));
    writeFileSync(join(impl, 'core-spec', 'B.json'), 'not json');
    expect((await readCoreSpecDir(impl, { skipInvalid: true })).map((m) => m.name)).toEqual(['A']);
    mkdirSync(join(impl, 'core-spec', 'C.json'));
    await expect(readCoreSpecDir(impl, { skipInvalid: true })).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('server dependencies: no package-lock.json installs nothing, a path that cannot be read fails', async () => {
    const none = temp();
    mkdirSync(join(none, 'server'));
    await expect(installServerDependencies(none, process.env)).resolves.toBeUndefined();
    const file = temp();
    writeFileSync(join(file, 'server'), 'a file where the server folder is');
    await expect(installServerDependencies(file, process.env)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('harness skill files: a missing file is named, a folder in its place fails with its own error', async () => {
    const harness = temp();
    await expect(collectedDataVocabulary(harness)).rejects.toThrow('spec file not found: skills/core/SKILL.md');
    await expect(resourceRightsSpans(harness)).rejects.toThrow('file not found: skills/resource/SKILL.md');
    await expect(readModuleEntries(harness)).rejects.toThrow(/file not found: .*skills\/client-core\/SKILL\.md/);
    mkdirSync(join(harness, 'skills', 'core', 'SKILL.md'), { recursive: true });
    mkdirSync(join(harness, 'skills', 'resource', 'SKILL.md'), { recursive: true });
    mkdirSync(join(harness, 'skills', 'client-core', 'SKILL.md'), { recursive: true });
    await expect(collectedDataVocabulary(harness)).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(resourceRightsSpans(harness)).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(readModuleEntries(harness)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('core test result reuse', () => {
  it('harness tools/ tree: a git status that fails fails, instead of reading as changes', async () => {
    const harness = gitRepo();
    mkdirSync(join(harness, 'tools'));
    writeFileSync(join(harness, 'tools', 'a.ts'), 'x\n');
    const env = { ...process.env, OGW_HARNESS_ROOT: harness };
    // uncommitted changes: no tree
    expect(await harnessToolsTree(env)).toBeNull();
    execFileSync('git', ['-C', harness, 'add', '.']);
    execFileSync('git', ['-C', harness, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'tools']);
    expect(await harnessToolsTree(env)).toMatch(/^[0-9a-f]{40}$/);
    // a folder that is no git checkout
    await expect(harnessToolsTree({ ...process.env, OGW_HARNESS_ROOT: temp(), GIT_CEILING_DIRECTORIES: tmpdir() })).rejects.toThrow();
  });

  it('kept result: none kept gives null, a kept file that is not JSON fails', async () => {
    const harness = gitRepo();
    const env = { ...process.env, OGW_HARNESS_ROOT: harness };
    expect(await keptResult(env, 'k1')).toBeNull();
    const folder = join(harness, '.git', 'ogw-cache', 'core-test-results');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'k1.json'), JSON.stringify({ tests: 2, passed: 2 }));
    expect(await keptResult(env, 'k1')).toEqual({ tests: 2, passed: 2 });
    writeFileSync(join(folder, 'k2.json'), '{"tests": 2,');
    await expect(keptResult(env, 'k2')).rejects.toThrow(/invalid JSON in .*k2\.json/);
  });
});
