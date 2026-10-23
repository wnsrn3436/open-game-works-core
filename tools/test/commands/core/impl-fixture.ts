import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitAll } from '../../helpers/workspace.ts';
import { writeFiles } from './helpers.ts';

export function specModule(name: string, side: 'client' | 'server', fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    side,
    dependencies: [],
    optionalDependencies: [],
    devDependencies: [],
    settings: [],
    settingsConstraints: [],
    tables: [],
    usedTables: [],
    enums: [],
    invariants: [],
    reserved: [],
    formatArguments: [],
    collectedData: [],
    adapters: [],
    ...fields,
  };
}

/** A small `open-game-works-core-impl/` working tree, committed on main. */
export function writeImpl(impl: string, engineJson: Record<string, unknown> = {}): void {
  writeFiles(impl, {
    '.gitignore': 'client/godot/addons/\nclient/godot/.godot/\ntools/*/bin/\ntools/*/node_modules/\n',
    'client/godot/engine.json': {
      godot: '4.5.1.stable',
      gut: { version: '9.4.0', url: 'https://example.test/gut.zip', sha256: 'a'.repeat(64) },
      downloads: [],
      plugins: [{ name: 'ogw-secure-storage', version: '1.0.0', platforms: ['macos', 'linux'], url: '', sha256: '' }],
      buildTools: [],
      ...engineJson,
    },
    'client/godot/project.godot': '; project\n',
    'client/godot/core/ui_core/ui_core.gd': 'class_name UICore\nLogCore.x()\n',
    'client/godot/core/ui_core/tests/test_ui.gd': 'extends UnitTestCase\n',
    'client/godot/core/log_core/log_core.gd': 'class_name LogCore\n',
    'client/godot/core/web/service-worker.js': 'const CACHE_VERSION = "___GODOT_VERSION___";\n',
    'client/godot/core/core_settings.gd': 'class_name CoreSettings\n',
    'client/godot/plugins/.gdignore': '',
    'client/godot/plugins/ogw-secure-storage/dist/macos/addons/ogw-secure-storage/a.gdextension': 'mac',
    'client/godot/plugins/ogw-secure-storage/dist/linux/addons/ogw-secure-storage/a.gdextension': 'linux',
    'benchmark/godot/settings.json': { engine: 'godot' },
    'benchmark/godot/id_registry.json': {},
    'server/core/Dockerfile': 'FROM node\n',
    'server/core/routing/routing.ts': 'export {};\n',
    'server/core/routing/tests/routing.test.ts': 'test\n',
    'tools/contract-tool/package.json': { name: 'contract-tool', scripts: { build: 'build' } },
    'tools/data-tool/package.json': { name: 'data-tool', scripts: { build: 'build' } },
    'proto/ogw/core.proto': 'syntax = "proto3";\n',
    'settings/core-settings.json': { 'UICore.fadeMs': 100, 'LogCore.maxLines': 300 },
    'settings/core-settings.schema.json': { properties: { 'UICore.fadeMs': {}, 'LogCore.maxLines': { 'x-owner': 'human' } } },
    'licenses.json': { components: [{ name: 'Godot Engine', license: 'MIT' }], texts: { MIT: 'm', 'CC0-1.0': 'c', 'CC-BY-4.0': 'b', 'OFL-1.1': 'o' } },
    'core-spec/UICore.json': specModule('UICore', 'client', {
      dependencies: ['LogCore'],
      settings: [{ key: 'UICore.fadeMs', type: 'integer', source: 'core', owner: 'content' }],
      settingsConstraints: [{ left: 'UICore.fadeMs', factor: 2, right: 'LogCore.maxLines' }],
    }),
    'core-spec/LogCore.json': specModule('LogCore', 'client', {
      settings: [{ key: 'LogCore.maxLines', type: 'integer', source: 'core', owner: 'human' }],
    }),
    'core-spec/routing.json': specModule('routing', 'server'),
    'test-data/settings.json': { engine: 'godot' },
    'fixtures/text-format.json': { cases: [{ name: 'a', input: '[known]', expected: 1 }] },
  });
  mkdirSync(join(impl, 'client', 'godot', 'addons'), { recursive: true });
  writeFileSync(join(impl, 'client', 'godot', 'addons', 'ignored.txt'), 'x');
  commitAll(impl, 'impl');
}
