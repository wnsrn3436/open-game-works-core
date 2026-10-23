import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fixtureIdErrors, idNamesIn, licenseErrors } from '../../../../src/commands/core/lib/content-checks.ts';
import type { CoreSpecModule } from '../../../../src/commands/core/lib/impl.ts';
import {
  adapterErrors,
  cycleErrors,
  gdCode,
  godotModuleNames,
  godotReferences,
  humanKeys,
  settingsErrors,
  specDirErrors,
} from '../../../../src/commands/core/lib/spec-dir-check.ts';
import { writeFiles } from '../helpers.ts';

vi.mock('../../../../src/commands/core/lib/server-layout.ts', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    serverImplementedModules: () => Promise.resolve(['routing', 'extra']),
    serverModuleReferences: () => Promise.resolve(new Map([['routing', { code: ['storage'], dev: ['cheat'] }]])),
  };
});

function temp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'ogw-core-check-')));
}

export function mod(name: string, side: 'client' | 'server', fields: Partial<CoreSpecModule> = {}): CoreSpecModule {
  return {
    name,
    side,
    dependencies: [],
    optionalDependencies: [],
    devDependencies: [],
    settings: [],
    settingsConstraints: [],
    collectedData: [],
    adapters: [],
    ...fields,
  };
}

describe('licenses.json check', () => {
  it('needs a component per plugin that is not an ogw- plugin, and the texts ogw core licenses writes', async () => {
    const impl = temp();
    const harness = temp();
    writeFiles(harness, { 'skills/resource/SKILL.md': '# resource\n\n## resource rights\n\n- `CC0-1.0`, `CC-BY-SA-4.0`, `unknown`\n\n## other\n\n- `OFL-1.1`\n' });
    writeFiles(impl, {
      'client/godot/engine.json': { godot: '4.5.1.stable', plugins: [{ name: 'webrtc-native' }, { name: 'ogw-x' }, { name: 'godot-steam' }] },
      'licenses.json': {
        components: [
          { name: 'webrtc-native', license: 'MIT AND Zlib' },
          { name: 'Google Mobile Ads SDK', license: 'LicenseRef-google-mobile-ads-sdk OR DocumentRef-d:LicenseRef-x' },
        ],
        texts: { MIT: '...', 'CC0-1.0': '' },
      },
    });
    // a `ogw-` plugin is core code and needs no component
    expect(await licenseErrors(impl, harness)).toEqual([
      'licenses.json has no component named godot-steam (engine.json plugins of godot)',
      'licenses.json texts has no CC-BY-SA-4.0',
      'licenses.json texts has no Zlib',
    ]);
    // nor may it have one
    writeFiles(impl, { 'licenses.json': { components: [{ name: 'webrtc-native', license: 'MIT' }, { name: 'godot-steam', license: 'MIT' }, { name: 'ogw-x', license: 'MIT' }], texts: { MIT: '...', 'CC-BY-SA-4.0': '', 'CC0-1.0': '' } } });
    expect(await licenseErrors(impl, harness)).toEqual(['licenses.json has a component named ogw-x, an ogw- plugin of core code (engine.json plugins of godot)']);
    writeFiles(impl, { 'licenses.json': '[]' });
    expect(await licenseErrors(impl, harness)).toEqual(['licenses.json is missing or invalid']);
    writeFiles(impl, { 'licenses.json': { components: [], texts: null } });
    expect(await licenseErrors(impl, harness)).toEqual(['licenses.json is missing or invalid']);
  });
});

describe('fixture ID name check', () => {
  it('finds whole-value ID names and reports the unknown ones', async () => {
    expect([...idNamesIn({ a: ['[x_1]', ' [y]', '[Z]', 3, null, { b: '[z]' }] })]).toEqual(['[x_1]', '[z]']);
    const impl = temp();
    expect(await fixtureIdErrors(impl, new Set())).toEqual([]);
    writeFiles(impl, {
      'fixtures/item-recovery.json': { cases: [{ name: 'c', input: { item: '[potion]', other: '[ghost]' }, expected: ['[potion]', '[gone]'] }] },
      'fixtures/empty.json': { cases: [] },
    });
    expect(await fixtureIdErrors(impl, new Set(['[potion]']))).toEqual([
      'fixture item-recovery: [ghost] is not in the core test data',
      'fixture item-recovery: [gone] is not in the core test data',
    ]);
  });
});

describe('core-spec/ check', () => {
  it('finds dependency cycles', () => {
    expect(cycleErrors([mod('A', 'client', { dependencies: ['B'] }), mod('B', 'client', { dependencies: ['A'] }), mod('C', 'client', { dependencies: ['A', 'Z'] })]))
      .toEqual(['dependency cycle: A -> B -> A']);
    expect(cycleErrors([mod('A', 'client'), mod('B', 'client', { dependencies: ['A'] })])).toEqual([]);
  });

  it('matches adapters and collected data sources', () => {
    const modules = [
      mod('auth', 'server', { adapters: ['login-apple', 'login-google'], collectedData: [{ source: 'login-apple' }, { source: 'module' }, { source: 'ads-x' }] }),
    ];
    expect(adapterErrors(modules)).toEqual([
      'adapter login-google has no collectedData row with that source',
      'auth collectedData source ads-x is neither module nor an adapter',
    ]);
  });

  it('checks settings keys and human owners against core-settings.json and its schema', () => {
    const modules = [mod('NetworkCore', 'client', {
      settings: [
        { key: 'NetworkCore.retryCount', type: 'integer', source: 'core', owner: 'content' },
        { key: 'NetworkCore.simLatencyMs', type: 'integer', source: 'core', owner: 'human' },
        { key: 'NetworkCore.missing', type: 'integer', source: 'core', owner: 'content' },
        { key: 'environments.<ENV>.serverUrl', type: 'string', source: 'game', owner: 'none' },
      ],
      settingsConstraints: [{ left: 'NetworkCore.retryCount', factor: 2, right: 'NetworkCore.none' }],
    })];
    const settings = { 'NetworkCore.retryCount': 3, 'NetworkCore.simLatencyMs': 0 };
    const schema = { properties: { 'NetworkCore.retryCount': { 'x-owner': 'human' }, 'NetworkCore.simLatencyMs': {} } };
    expect(humanKeys(schema)).toEqual(['NetworkCore.retryCount']);
    expect(humanKeys(null)).toEqual([]);
    const all = new Set(['NetworkCore']);
    expect(settingsErrors(modules, settings, schema, all)).toEqual([
      'NetworkCore settings constraint key NetworkCore.none is not in core-settings.json',
      'NetworkCore setting NetworkCore.missing is not in core-settings.json',
      'NetworkCore.simLatencyMs has owner human in the spec but no "x-owner": "human" in core-settings.schema.json',
      'NetworkCore.retryCount has "x-owner": "human" in core-settings.schema.json but not owner human in the spec',
    ]);
    expect(settingsErrors(modules, null, null, all)).toContain('NetworkCore setting NetworkCore.retryCount is not in core-settings.json');
    // a module without an implementation is not checked, nor a key of another module without one
    expect(settingsErrors(modules, null, schema, new Set())).toEqual([]);
    const other = [mod('push', 'server', {
      settings: [{ key: 'push.limit', type: 'integer', source: 'core', owner: 'content' }],
      settingsConstraints: [{ left: 'push.limit', factor: 1, right: 'NetworkCore.retryCount' }],
    })];
    expect(settingsErrors(other, { 'push.limit': 1 }, null, new Set(['push']))).toEqual([]);
  });

  it('reads GDScript references outside comments, strings and tests', async () => {
    expect(gdCode('var a = "UICore" # LogCore\nNetworkCore.x()')).toBe('var a =    \nNetworkCore.x()');
    const dir = temp();
    writeFiles(dir, {
      'ui_core.gd': 'class_name UICore\nfunc f():\n\tLogCore.log_info("EventCore")\n\tNetworkCoreDev.x()\n',
      'dev/ui_core_dev.gd': 'QACore.x()\n',
      'tests/test_x.gd': 'TimeCore.x()\n',
    });
    const names = ['UICore', 'LogCore', 'EventCore', 'NetworkCore', 'QACore', 'TimeCore'].map((name) => ({ name, classNames: [], folder: name.toLowerCase() }));
    expect(await godotReferences(dir, 'UICore', names)).toEqual({ code: ['LogCore'], dev: ['QACore'] });
  });

  it('reads the class_names of a Godot module folder, its dev/ files included', async () => {
    const project = temp();
    writeFiles(project, {
      'core/event_core/event_core.gd': 'class_name EventCore\n',
      'core/event_core/event_base.gd': '@abstract class_name EventBase extends RefCounted\n# class_name NotThis\nvar s = "class_name NorThis"\n',
      'core/event_core/dev/event_core_dev.gd': 'class_name EventCoreDev\n',
    });
    expect(await godotModuleNames(project, ['EventCore', 'LogCore'])).toEqual([
      { name: 'EventCore', classNames: ['EventBase', 'EventCore', 'EventCoreDev'], folder: 'event_core' },
      { name: 'LogCore', classNames: [], folder: 'log_core' },
    ]);
  });

  it('counts a class_name and a res:// path of another module folder as a reference to that module', async () => {
    const dir = temp();
    writeFiles(dir, {
      'ui_core.gd': 'var e: EventBase\nconst L = preload("res://core/log_core/log_entry.gd")\n# TimeBase, "res://core/time_core/x.gd"\nvar t = "res://core/time_core_other/x.gd"\n',
      'dev/ui_core_dev.gd': 'extends QACoreDev\nvar s = load("res://core/save_core/save.gd")\n',
      'tests/test_x.gd': 'var x: TimeBase\n',
    });
    const names = [
      { name: 'UICore', classNames: ['UICore'], folder: 'ui_core' },
      { name: 'EventCore', classNames: ['EventBase', 'EventCore'], folder: 'event_core' },
      { name: 'LogCore', classNames: [], folder: 'log_core' },
      { name: 'QACore', classNames: ['QACoreDev'], folder: 'qa_core' },
      { name: 'SaveCore', classNames: [], folder: 'save_core' },
      { name: 'TimeCore', classNames: ['TimeBase'], folder: 'time_core' },
    ];
    expect(await godotReferences(dir, 'UICore', names)).toEqual({ code: ['EventCore', 'LogCore'], dev: ['QACore', 'SaveCore'] });
  });

  it('fails a class_name or res:// path reference to a module that is not a dependency, and passes allowed ones', async () => {
    const impl = temp();
    writeFiles(impl, {
      'core-spec/UICore.json': mod('UICore', 'client', { dependencies: ['LogCore'], devDependencies: ['QACore'] }),
      'core-spec/LogCore.json': mod('LogCore', 'client'),
      'core-spec/EventCore.json': mod('EventCore', 'client'),
      'core-spec/QACore.json': mod('QACore', 'client'),
      'core-spec/SaveCore.json': mod('SaveCore', 'client'),
      'client/godot/core/ui_core/ui_core.gd': 'class_name UICore\nvar e: EventBase\nconst L = preload("res://core/log_core/log_entry.gd")\nvar l: LogEntry\n',
      'client/godot/core/ui_core/dev/ui_core_dev.gd': 'extends QACoreDev\nvar s = load("res://core/save_core/save.gd")\n',
      'client/godot/core/log_core/log_core.gd': '',
      'client/godot/core/log_core/log_entry.gd': 'class_name LogEntry\n',
      'client/godot/core/event_core/event_core.gd': '',
      'client/godot/core/event_core/event_base.gd': 'class_name EventBase\n',
      'client/godot/core/qa_core/qa_core.gd': '',
      'client/godot/core/qa_core/dev/qa_core_dev.gd': 'class_name QACoreDev\n',
      'client/godot/core/save_core/save_core.gd': '',
      'settings/core-settings.json': {},
    });
    expect(await specDirErrors(impl, { kind: 'engine', engine: 'godot' }, true)).toEqual([
      'UICore code refers to EventCore, which is not in dependencies or optionalDependencies',
      'UICore DEV code refers to SaveCore, which is not a dependency',
    ]);
  });

  it('takes a module whose class is in dev/, as a module that is all DEV code has it, as implemented', async () => {
    const impl = temp();
    writeFiles(impl, {
      'core-spec/QACore.json': mod('QACore', 'client'),
      'client/godot/core/qa_core/dev/qa_core.gd': 'class_name QACore\n',
      'settings/core-settings.json': {},
    });
    expect(await specDirErrors(impl, { kind: 'engine', engine: 'godot' }, true)).toEqual([]);
  });

  it('compares Godot implementations, names and references with core-spec/', async () => {
    const impl = temp();
    writeFiles(impl, {
      'core-spec/UICore.json': mod('UICore', 'client', { dependencies: ['LogCore'] }),
      'core-spec/LogCore.json': mod('LogCore', 'client'),
      'core-spec/TimeCore.json': mod('TimeCore', 'client'),
      'core-spec/Wrong.json': mod('Other', 'client', { devDependencies: [] }),
      'client/godot/core/ui_core/ui_core.gd': 'LogCore.x()\nTimeCore.y()\n',
      'client/godot/core/ui_core/dev/d.gd': 'Other.z()\n',
      'client/godot/core/log_core/log_core.gd': '',
      'client/godot/core/stray/stray.gd': '',
      'client/godot/core/not_module/readme.txt': '',
      'settings/core-settings.json': {},
    });
    expect(await specDirErrors(impl, { kind: 'engine', engine: 'godot' }, true)).toEqual([
      'core-spec/Wrong.json: name is "Other"',
      'client/godot/core/stray/ has no core-spec file',
      'Other has no implementation in client/godot/core/other/',
      'TimeCore has no implementation in client/godot/core/time_core/',
      'UICore code refers to TimeCore, which is not in dependencies or optionalDependencies',
      'UICore DEV code refers to Other, which is not a dependency',
    ]);
    // A run with modules checks names and references, not that every module has an implementation.
    expect(await specDirErrors(impl, { kind: 'engine', engine: 'godot' }, false)).toEqual([
      'core-spec/Wrong.json: name is "Other"',
      'UICore code refers to TimeCore, which is not in dependencies or optionalDependencies',
      'UICore DEV code refers to Other, which is not a dependency',
    ]);
    await expect(specDirErrors(impl, { kind: 'engine', engine: 'unity' }, true)).rejects.toThrow('not defined: client core rules of engine unity');
    expect(await specDirErrors(temp(), { kind: 'engine', engine: 'godot' }, true)).toEqual(['core-spec/ is missing']);
  });

  it('compares server implementations through the server layout functions', async () => {
    const impl = temp();
    writeFiles(impl, {
      'core-spec/routing.json': mod('routing', 'server', { dependencies: ['storage'] }),
      'core-spec/storage.json': mod('storage', 'server'),
    });
    expect(await specDirErrors(impl, { kind: 'server' }, true)).toEqual([
      'server module extra has no core-spec file',
      'storage has no implementation in server/core/',
      'routing DEV code refers to cheat, which is not a dependency',
    ]);
    expect(await specDirErrors(impl, { kind: 'server' }, false)).toEqual(['routing DEV code refers to cheat, which is not a dependency']);
  });
});
