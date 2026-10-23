import { describe, expect, it } from 'vitest';
import {
  clientModuleTableOrder,
  compareBytes,
  devCodeModules,
  moduleListOrder,
  parseCoreSpec,
  usedModules,
  type SpecModule,
} from '../../../../src/commands/generate/lib/core-spec.ts';
import { makeWorkspace } from '../../../helpers/workspace.ts';
import { specJson } from '../helpers.ts';

const spec = parseCoreSpec(specJson('1.0.0'), 'core-spec.json');

describe('parseCoreSpec', () => {
  it('reads modules and rejects bad shapes', () => {
    expect(spec.version).toBe('1.0.0');
    expect(spec.modules.map((m) => m.name)).toContain('NetworkCore');
    expect(() => parseCoreSpec(null, 'f')).toThrow('invalid core spec file: f');
    expect(() => parseCoreSpec({ version: 1, modules: [] }, 'f')).toThrow('invalid core spec file');
    expect(() => parseCoreSpec({ version: '1', modules: {} }, 'f')).toThrow('invalid core spec file');
    const good = {
      name: 'A',
      side: 'client',
      lifecycle: true,
      dependencies: [],
      optionalDependencies: [],
      devDependencies: [],
      settings: [],
      tables: [],
      operations: [{ name: 'show', inputs: ['translationKey', 'other'] }],
    };
    expect(parseCoreSpec({ version: '1', modules: [good] }, 'f').modules[0]).toEqual(good);
    for (const bad of [
      null,
      { ...good, name: 1 },
      { ...good, side: 'both' },
      { ...good, dependencies: [1] },
      { ...good, dependencies: 'x' },
      { ...good, optionalDependencies: null },
      { ...good, devDependencies: null },
      { ...good, settings: null },
      { ...good, tables: null },
      { ...good, lifecycle: 'yes' },
      { ...good, lifecycle: undefined },
      { ...good, operations: null },
      { ...good, operations: [null] },
      { ...good, operations: [{ name: 1, inputs: [] }] },
      { ...good, operations: [{ name: 'a', inputs: null }] },
      { ...good, operations: [{ name: 'a', inputs: ['key'] }] },
    ]) {
      expect(() => parseCoreSpec({ version: '1', modules: [bad] }, 'f')).toThrow('invalid module in f');
    }
  });
});

describe('usedModules', () => {
  it('takes the always-used modules, the chosen modules and the dependency closure in byte order', () => {
    const names = usedModules(spec, { coreModules: { client: ['NetworkCore'], server: ['friend'] } }).map((m) => m.name);
    expect(names).toEqual([
      'BootstrapCore',
      'EventCore',
      'LogCore',
      'NetworkCore',
      'UtilCore',
      'auth',
      'friend',
      'migration',
      'routing',
      'storage',
      'user-snapshot-clone',
    ]);
  });

  it('works without coreModules and fails on an unknown module', () => {
    expect(usedModules(spec, {}).map((m) => m.name)).not.toContain('friend');
    expect(() => usedModules(spec, { coreModules: { client: ['Nope'] } })).toThrow('core module Nope is not in core version 1.0.0');
    expect(() => usedModules(spec, { coreModules: { server: ['nope'] } })).toThrow('core module nope');
  });
});

describe('devCodeModules', () => {
  it('adds the DEV modules: the closure of the used modules over dependencies and devDependencies', () => {
    const used = usedModules(spec, { coreModules: { client: ['NetworkCore'], server: ['friend'] } });
    expect(used.map((m) => m.name)).not.toContain('QACore');
    const names = devCodeModules(spec, used).map((m) => m.name);
    // QACore and cheat are DEV-only dependencies of BootstrapCore and routing; UICore and server-time are their dependencies
    expect(names).toEqual([
      'BootstrapCore',
      'EventCore',
      'LogCore',
      'NetworkCore',
      'QACore',
      'UICore',
      'UtilCore',
      'auth',
      'cheat',
      'friend',
      'migration',
      'routing',
      'server-time',
      'storage',
      'user-snapshot-clone',
    ]);
  });
});

describe('moduleListOrder', () => {
  const m = (name: string, dependencies: string[] = [], side: 'client' | 'server' = 'client', lifecycle = true): SpecModule => ({
    name,
    side,
    lifecycle,
    operations: [],
    dependencies,
    optionalDependencies: [],
    devDependencies: [],
    settings: [],
    tables: [],
  });
  const table = ['UtilCore', 'LogCore', 'EventCore', 'TimeCore', 'NetworkCore', 'UICore', 'BootstrapCore', 'QACore', 'UnitTestCore'];

  it('puts dependencies first, then the earlier module of the table, and leaves out modules without a list entry', () => {
    const modules = [
      m('UICore', ['EventCore']),
      m('NetworkCore', ['EventCore', 'auth']),
      m('EventCore', ['LogCore']),
      m('LogCore', ['UtilCore']),
      m('TimeCore'),
      m('UtilCore', [], 'client', false),
      m('BootstrapCore', ['LogCore'], 'client', false),
      m('QACore'),
      m('UnitTestCore'),
      m('auth', [], 'server'),
    ];
    expect(moduleListOrder(modules, table)).toEqual(['LogCore', 'EventCore', 'TimeCore', 'NetworkCore', 'UICore']);
  });

  it('takes the lifecycle from the core spec, not the module name', () => {
    expect(moduleListOrder([m('UtilCore'), m('LogCore', [], 'client', false)], table)).toEqual(['UtilCore']);
  });

  it('a dependency later in the table still comes first', () => {
    expect(moduleListOrder([m('LogCore', ['UICore']), m('UICore')], table)).toEqual(['UICore', 'LogCore']);
  });

  it('fails on a cycle and on a module outside the table', () => {
    expect(() => moduleListOrder([m('LogCore', ['EventCore']), m('EventCore', ['LogCore'])], table)).toThrow(
      'dependency cycle among client modules: LogCore, EventCore',
    );
    expect(() => moduleListOrder([m('NewCore'), m('LogCore')], table)).toThrow('client module NewCore is not in the client-core module table');
  });
});

describe('clientModuleTableOrder', () => {
  it('reads the client-core module table of the harness', async () => {
    const ws = makeWorkspace();
    const order = await clientModuleTableOrder(ws.env);
    expect(order.slice(0, 4)).toEqual(['UtilCore', 'LogCore', 'EventCore', 'TimeCore']);
    expect(order.at(-1)).toBe('UnitTestCore');
    expect(order.indexOf('NetworkCore')).toBeLessThan(order.indexOf('UICore'));
    expect(order).toHaveLength(43);
  });
});

describe('compareBytes', () => {
  it('orders by UTF-8 bytes', () => {
    expect(['b', 'B', 'a', '_'].sort(compareBytes)).toEqual(['B', '_', 'a', 'b']);
  });
});
