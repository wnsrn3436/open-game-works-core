import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { extractedAsset } from '../../../../src/commands/core/api.ts';
import { GODOT_NATIVE_PLUGINS, nativePluginProblems, neededPlugins, releaseModules } from '../../../../src/commands/build/lib/native-plugins.ts';
import { createContext } from '../../../../src/lib/command.ts';
import { makeWorkspace } from '../../../helpers/workspace.ts';

vi.mock('../../../../src/commands/core/api.ts', async (orig) => ({ ...(await orig<object>()), extractedAsset: vi.fn() }));

const HARNESS = resolve(import.meta.dirname, '..', '..', '..', '..', '..');

/** The rows `| <plugin> | <cell> | ...` of the first table of `section` of a harness document, as plugin → second cell. */
function tableRows(file: string, section: string): Map<string, string> {
  const lines = readFileSync(join(HARNESS, file), 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trim() === section || line.trim().startsWith(section));
  expect(start).toBeGreaterThan(-1);
  const rows = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    const cells = line.trim().split('|').map((cell) => cell.trim());
    const plugin = /^`([^`]+)`$/.exec(cells[1] ?? '')?.[1];
    if (plugin !== undefined) rows.set(plugin, cells[2] ?? '');
    else if (rows.size > 0 && !line.trim().startsWith('|')) break;
  }
  return rows;
}

describe('native plugins of check native plugin', () => {
  it('are the plugins of the client-core Godot table with the same target platforms, and the rows of the build Godot table', () => {
    const table = tableRows('skills/client-core/engines/godot.md', '- Native plugins that core modules use');
    for (const { plugin, platforms } of GODOT_NATIVE_PLUGINS) {
      const cell = table.get(plugin);
      expect(cell, plugin).toBeDefined();
      expect([...(cell ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]), plugin).toEqual(platforms);
    }
    const build = tableRows('skills/build/engines/godot.md', '## native plugin');
    expect([...build.keys()]).toEqual(GODOT_NATIVE_PLUGINS.map((p) => p.plugin));
  });

  it('needs ogw-secure-storage on every platform but web, and the plugins of the adapters, PushCore and tracking', async () => {
    const none = () => Promise.resolve([]);
    expect(await neededPlugins({}, 'STG', 'macos', none)).toEqual(['ogw-secure-storage']);
    expect(await neededPlugins({}, 'STG', 'web', none)).toEqual([]);
    expect(await neededPlugins({}, 'DEV', 'macos', none)).toEqual([]);
    const adapters = { 'login-apple': 'login-apple', 'iap-apple': 'iap-apple-sandbox', 'push-apns': 'fake', ads: 'ads-admob' };
    const settings = { environments: { STG: { adapters } }, consent: { trackingRequest: true } };
    const push = () => Promise.resolve(['PushCore']);
    expect(await neededPlugins(settings, 'STG', 'ios', push)).toEqual(['ogw-secure-storage', 'ogw-apple-signin', 'ogw-iap-apple', 'ogw-ads-admob', 'ogw-notification', 'ogw-tracking']);
    expect(await neededPlugins(settings, 'STG', 'macos', push)).toEqual(['ogw-secure-storage', 'ogw-apple-signin', 'ogw-iap-apple']);
    expect(await neededPlugins(settings, 'PROD', 'ios', none)).toEqual(['ogw-secure-storage', 'ogw-tracking']);
  });

  it('fails each needed plugin that engine.json lacks for the platform or that client-godot-plugins.zip lacks', async () => {
    const ws = makeWorkspace();
    const dir = join(ws.root, 'release');
    mkdirSync(join(dir, 'client-godot'), { recursive: true });
    mkdirSync(join(dir, 'plugins', 'ogw-secure-storage', 'macos'), { recursive: true });
    const plugins = [{ name: 'ogw-native-ui', platforms: ['macos'] }, { name: 'ogw-secure-storage', platforms: ['macos', 'linux'] }];
    writeFileSync(join(dir, 'client-godot', 'engine.json'), JSON.stringify({ godot: '4.7.2.stable', plugins }));
    vi.mocked(extractedAsset).mockImplementation((_c, _r, asset) => Promise.resolve(join(dir, asset === 'client-godot.zip' ? 'client-godot' : 'plugins')));
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const release = { version: '0.4.0', dir, local: false };
    const none = () => Promise.resolve([]);
    expect(await nativePluginProblems(ctx, release, {}, 'STG', ['macos', 'web'], none)).toEqual([]);
    expect(await nativePluginProblems(ctx, release, {}, 'PROD', ['windows', 'linux'], none)).toEqual([
      'PROD windows needs native plugin ogw-secure-storage: engine.json of core 0.4.0 has no ogw-secure-storage for windows',
      'PROD linux needs native plugin ogw-secure-storage: client-godot-plugins.zip of core 0.4.0 has no ogw-secure-storage/linux/',
    ]);
    expect(await nativePluginProblems(ctx, release, {}, 'DEV', ['windows'], none)).toEqual([]);
  });

  it('reads the used modules of the release over dependencies for PushCore', async () => {
    const ws = makeWorkspace();
    const dir = join(ws.root, 'release');
    mkdirSync(dir, { recursive: true });
    const modules = [{ name: 'BootstrapCore', dependencies: [] }, { name: 'MissionCore', dependencies: ['PushCore'] }, { name: 'PushCore', dependencies: [] }];
    writeFileSync(join(dir, 'core-spec.json'), JSON.stringify({ version: '0.4.0', modules }));
    const release = { version: '0.4.0', dir, local: false };
    expect(await releaseModules(release, { coreModules: { client: ['MissionCore'], server: [] } })()).toContain('PushCore');
    expect(await releaseModules(release, { coreModules: { client: [], server: [] } })()).not.toContain('PushCore');
  });
});
