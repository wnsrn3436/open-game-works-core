import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { extractArchive } from '../../../../src/commands/core/lib/archive.ts';
import { buildAssets } from '../../../../src/commands/core/lib/assets.ts';
import { gitInit, useGitOnlyHarness } from '../../../helpers/workspace.ts';
import { readJsonFile, sha256, writeFiles } from '../helpers.ts';
import { writeImpl } from '../impl-fixture.ts';

vi.mock('../../../../src/commands/core/lib/undefined.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isServerCoreTest: (rel: string) => rel.split('/').includes('tests'),
}));
vi.mock('../../../../src/commands/core/lib/tools.ts', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const { mkdirSync: mkdir, writeFileSync: write } = await import('node:fs');
  const { join: joinPath } = await import('node:path');
  return {
    ...original,
    stageToolPackage: (_env: unknown, _impl: string, tool: string, stage: string) => {
      mkdir(joinPath(stage, 'bin'), { recursive: true });
      write(joinPath(stage, 'bin', `${tool}.js`), `// ${tool}\n`);
      return Promise.resolve();
    },
  };
});

function temp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'ogw-assets-')));
}

function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? listFiles(join(dir, entry.name), `${prefix}${entry.name}/`)
    : [`${prefix}${entry.name}`]).sort();
}

useGitOnlyHarness();

describe('buildAssets', () => {
  it('builds every asset of the checkout and a manifest with their hashes', async () => {
    const impl = temp();
    gitInit(impl);
    writeImpl(impl);
    writeFiles(impl, { 'client/godot/core/log_core/new_untracked.gd': 'x\n', 'server/core/storage/core-schema-version': '7\n' });
    const out = temp();
    const built = await buildAssets(impl, '1.2.0', out, { assetUrl: (asset) => `https://example/v1.2.0/${asset}` });
    expect(readdirSync(out).sort()).toEqual([
      'benchmark-godot.zip', 'client-godot-plugins.zip', 'client-godot.zip', 'contract-tool.tgz', 'core-settings-constraints.json',
      'core-settings.json', 'core-settings.schema.json', 'core-spec.json', 'data-tool.tgz', 'licenses.json', 'manifest.json', 'server.tgz',
    ]);
    const manifest = readJsonFile(join(out, 'manifest.json')) as { version: string; assets: Record<string, string>; coreSchemaVersion: number };
    expect(manifest.version).toBe('1.2.0');
    expect(manifest.coreSchemaVersion).toBe(7);
    expect(Object.keys(manifest.assets).sort()).toEqual(readdirSync(out).filter((n) => n !== 'manifest.json').sort());
    for (const [name, hash] of Object.entries(manifest.assets)) expect(sha256(readFileSync(join(out, name)))).toBe(hash);

    const coreSpec = readJsonFile(join(out, 'core-spec.json')) as { version: string; modules: { name: string }[] };
    expect(coreSpec.version).toBe('1.2.0');
    expect(coreSpec.modules.map((m) => m.name)).toEqual(['LogCore', 'UICore', 'routing']);
    expect(readJsonFile(join(out, 'core-settings-constraints.json'))).toEqual([{ left: 'UICore.fadeMs', factor: 2, right: 'LogCore.maxLines' }]);

    const x = temp();
    await extractArchive(join(out, 'client-godot.zip'), join(x, 'client'));
    expect(listFiles(join(x, 'client'))).toEqual(['core/core_settings.gd', 'core/log_core/log_core.gd', 'core/log_core/new_untracked.gd', 'core/ui_core/ui_core.gd', 'core/web/service-worker.js', 'engine.json']);
    const zippedEngine = readJsonFile(join(x, 'client', 'engine.json')) as { plugins: { url: string; sha256: string }[] };
    expect(zippedEngine.plugins[0]?.url).toBe('https://example/v1.2.0/client-godot-plugins.zip');
    expect(zippedEngine.plugins[0]?.sha256).toBe(manifest.assets['client-godot-plugins.zip']);
    expect(built.engineJson.get('godot')).toBe(readFileSync(join(x, 'client', 'engine.json'), 'utf8'));

    await extractArchive(join(out, 'client-godot-plugins.zip'), join(x, 'plugins'));
    expect(listFiles(join(x, 'plugins'))).toEqual([
      'ogw-secure-storage/linux/addons/ogw-secure-storage/a.gdextension',
      'ogw-secure-storage/macos/addons/ogw-secure-storage/a.gdextension',
    ]);
    await extractArchive(join(out, 'benchmark-godot.zip'), join(x, 'bench'));
    expect(listFiles(join(x, 'bench'))).toEqual(['id_registry.json', 'settings.json']);
    await extractArchive(join(out, 'server.tgz'), join(x, 'server'));
    expect(listFiles(join(x, 'server'))).toEqual(['Dockerfile', 'routing/routing.ts', 'storage/core-schema-version']);
    await extractArchive(join(out, 'contract-tool.tgz'), join(x, 'ct'));
    expect(listFiles(join(x, 'ct'))).toEqual(['bin/contract-tool.js', 'proto/ogw/core.proto']);
  });

  it('leaves out what the checkout does not have and keeps engine.json without a URL function', async () => {
    const impl = temp();
    gitInit(impl);
    writeFiles(impl, { 'client/godot/engine.json': { godot: '4.5.1.stable', plugins: [] }, 'client/godot/core/a/a.gd': '' });
    const out = temp();
    const built = await buildAssets(impl, '0.1.0', out);
    expect(readdirSync(out).sort()).toEqual(['client-godot.zip', 'manifest.json']);
    expect(built.engineJson.get('godot')).toBe(`${JSON.stringify({ godot: '4.5.1.stable', plugins: [] }, null, 2)}\n`);
  });

  it('keeps plugin entries without a URL function and fails for an engine without rules', async () => {
    const impl = temp();
    gitInit(impl);
    writeImpl(impl);
    const out = temp();
    const built = await buildAssets(impl, '1.0.0', out);
    expect(built.engineJson.get('godot')).toContain('"url": ""');
    mkdirSync(join(impl, 'client', 'unity'), { recursive: true });
    writeFileSync(join(impl, 'client', 'unity', 'engine.json'), '{}');
    await expect(buildAssets(impl, '1.0.0', temp())).rejects.toThrow('not defined: client core rules of engine unity');
  });
});
