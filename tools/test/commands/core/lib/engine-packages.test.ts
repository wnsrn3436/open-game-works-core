import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gutPackage, installPackage, isCorePlugin, packageDir, pluginsFor } from '../../../../src/commands/core/lib/engine-packages.ts';
import { setNet } from '../../../../src/commands/env/lib/net.ts';
import { makeWorkspace } from '../../../helpers/workspace.ts';
import { ctxOf, fakeNet, GUT_URL, GUT_ZIP, SERVED, sha256Of, storedZip } from '../../generate/helpers.ts';

let downloads = new Map<string, number>();

beforeEach(() => {
  downloads = new Map();
  setNet(fakeNet(downloads));
});

afterEach(() => {
  setNet(null);
});

describe('engine.json items', () => {
  it('tells core plugins apart and picks the plugins of a platform', () => {
    expect(isCorePlugin({ name: 'ogw-x' })).toBe(true);
    expect(isCorePlugin({ name: 'webrtc-native' })).toBe(false);
    const json = {
      plugins: [
        { name: 'a', platforms: ['ios', 'macos'] },
        { name: 'b', platforms: ['android'] },
        { name: 'c' },
        { name: 'd', platforms: ['macos'] },
      ],
    };
    expect(pluginsFor(json, 'macos').map((p) => p.name)).toEqual(['a', 'd']);
    expect(pluginsFor({}, 'macos')).toEqual([]);
  });

  it('reads the gut item and fails without one', () => {
    expect(gutPackage({ gut: { version: '9.4.0', url: 'u', sha256: 's' } })).toEqual({ version: '9.4.0', url: 'u', sha256: 's', name: 'gut' });
    expect(() => gutPackage({})).toThrow('engine.json has no gut item');
    expect(() => gutPackage({ gut: '9.4.0' } as never)).toThrow('engine.json has no gut item');
    expect(() => gutPackage({ gut: [] } as never)).toThrow('engine.json has no gut item');
  });
});

describe('packageDir and installPackage', () => {
  it('downloads once, checks the hash and copies the files with their project-root paths', async () => {
    const ws = makeWorkspace();
    const ctx = ctxOf(ws);
    const item = { name: 'gut', url: GUT_URL, sha256: sha256Of(GUT_ZIP) };
    const dir = await packageDir(ctx, item);
    expect(dir).toBe(join(ws.root, '.ogw', 'engine-packages', sha256Of(GUT_ZIP), 'files'));
    const project = join(ws.root, 'project');
    await installPackage(ctx, item, project);
    expect(readFileSync(join(project, 'addons', 'gut', 'gut_cmdln.gd'), 'utf8')).toBe('extends SceneTree\n');
    expect(downloads.get(GUT_URL)).toBe(1);
  });

  it('takes the one folder of a zip without addons/ at its root as the project root, as in a GitHub tag archive', async () => {
    const ws = makeWorkspace();
    const ctx = ctxOf(ws);
    const url = 'https://example.test/Gut-9.7.1.zip';
    const zip = storedZip({ 'Gut-9.7.1/addons/gut/gut_cmdln.gd': 'extends SceneTree\n', 'Gut-9.7.1/README.md': 'r' });
    SERVED.set(url, zip);
    const item = { name: 'gut', url, sha256: sha256Of(zip) };
    const project = join(ws.root, 'project');
    await installPackage(ctx, item, project);
    expect(readFileSync(join(project, 'addons', 'gut', 'gut_cmdln.gd'), 'utf8')).toBe('extends SceneTree\n');
    expect(existsSync(join(project, 'Gut-9.7.1'))).toBe(false);
    // a second call finds the extracted files and the same root
    expect(await packageDir(ctx, item)).toBe(join(ws.root, '.ogw', 'engine-packages', sha256Of(zip), 'files', 'Gut-9.7.1'));
    // a zip whose one folder is addons/ keeps its root
    expect(await packageDir(ctx, { name: 'gut', url: GUT_URL, sha256: sha256Of(GUT_ZIP) })).toBe(join(ws.root, '.ogw', 'engine-packages', sha256Of(GUT_ZIP), 'files'));
  });

  it('keeps the root of a zip whose one folder is a project root path, as an iOS plugin under ios/', async () => {
    const ws = makeWorkspace();
    const ctx = ctxOf(ws);
    const url = 'https://example.test/ios-plugin.zip';
    const zip = storedZip({ 'ios/plugins/sample.gdip': '[config]\n', 'ios/plugins/sample/lib.a': 'a' });
    SERVED.set(url, zip);
    const item = { name: 'sample-ios', url, sha256: sha256Of(zip) };
    const project = join(ws.root, 'project');
    await installPackage(ctx, item, project);
    expect(readFileSync(join(project, 'ios', 'plugins', 'sample.gdip'), 'utf8')).toBe('[config]\n');
    expect(existsSync(join(project, 'plugins'))).toBe(false);
    // a wrapper folder around android/ is taken off
    const wrapped = 'https://example.test/android-plugin.zip';
    const wrappedZip = storedZip({ 'plugin-1.0/android/plugins/sample.aar': 'x' });
    SERVED.set(wrapped, wrappedZip);
    await installPackage(ctx, { name: 'sample-android', url: wrapped, sha256: sha256Of(wrappedZip) }, project);
    expect(readFileSync(join(project, 'android', 'plugins', 'sample.aar'), 'utf8')).toBe('x');
  });

  it('fails on a bad sha256 form and leaves nothing on a mismatch', async () => {
    const ws = makeWorkspace();
    const ctx = ctxOf(ws);
    await expect(packageDir(ctx, { name: 'p', url: GUT_URL, sha256: 'ABC' })).rejects.toThrow('engine.json item p has no url or sha256');
    await expect(packageDir(ctx, { name: 'p', url: 1, sha256: sha256Of(GUT_ZIP) })).rejects.toThrow('engine.json item p has no url or sha256');
    const wrong = 'c'.repeat(64);
    await expect(packageDir(ctx, { name: 'p', url: GUT_URL, sha256: wrong })).rejects.toThrow(`SHA-256 of p from ${GUT_URL} is ${sha256Of(GUT_ZIP)}, not ${wrong}`);
    expect(existsSync(join(ws.root, '.ogw', 'engine-packages', wrong, 'files'))).toBe(false);
    expect(existsSync(join(ws.root, '.ogw', 'engine-packages', wrong, 'download.zip'))).toBe(false);
  });
});
