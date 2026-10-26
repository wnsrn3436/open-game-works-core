import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coreGameValues, coreSettingTypes, emptyValue, schemaDefault } from '../../../../src/commands/generate/lib/core-settings.ts';
import { isPlainObject, mergeSettings, type JsonObject } from '../../../../src/lib/json.ts';
import type { SpecModule } from '../../../../src/commands/generate/lib/core-spec.ts';
import { realHarness } from '../../../helpers/workspace.ts';

const realSchema = JSON.parse(readFileSync(join(realHarness, 'schemas', 'game-settings.schema.json'), 'utf8')) as JsonObject;

describe('mergeSettings', () => {
  it('merges objects key by key and replaces arrays and values', () => {
    const base = { a: 1, b: { x: 1, y: [1, 2], z: { q: 1 } }, c: [1], d: 'k' };
    const over = { a: 2, b: { y: [3], z: { r: 2 } }, c: { n: 1 }, e: null };
    expect(mergeSettings(base, over)).toEqual({ a: 2, b: { x: 1, y: [3], z: { q: 1, r: 2 } }, c: { n: 1 }, d: 'k', e: null });
    expect(base.b.z).toEqual({ q: 1 });
    expect(mergeSettings({ a: [1] }, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
    expect(mergeSettings({ a: { b: 1 } }, { a: 3 })).toEqual({ a: 3 });
  });

  it('isPlainObject', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('a')).toBe(false);
  });
});

describe('schemaDefault', () => {
  const schema: JsonObject = {
    $defs: { env: { properties: { level: { default: 3 }, deep: { $ref: '#/$defs/deep' } } }, deep: { properties: { x: { default: 'dx' } } } },
    properties: {
      top: { type: 'integer', default: 7 },
      none: { type: 'string' },
      environments: { properties: { DEV: { allOf: [{ $ref: '#/$defs/env' }, { properties: { extra: { default: true } } }] } } },
      pick: { anyOf: [{ properties: { a: { default: 'any' } } }], oneOf: [{ properties: { b: { default: 'one' } } }] },
      bad: { $ref: 'other.json#/x' },
      loop: { $ref: '#/properties/loop' },
    },
  };

  it('follows properties, $ref, allOf, anyOf and oneOf', () => {
    expect(schemaDefault(schema, ['top'])).toBe(7);
    expect(schemaDefault(schema, ['none'])).toBeUndefined();
    expect(schemaDefault(schema, ['missing'])).toBeUndefined();
    expect(schemaDefault(schema, ['environments', 'DEV', 'level'])).toBe(3);
    expect(schemaDefault(schema, ['environments', 'DEV', 'deep', 'x'])).toBe('dx');
    expect(schemaDefault(schema, ['environments', 'DEV', 'extra'])).toBe(true);
    expect(schemaDefault(schema, ['environments', 'STG', 'level'])).toBeUndefined();
    expect(schemaDefault(schema, ['pick', 'a'])).toBe('any');
    expect(schemaDefault(schema, ['pick', 'b'])).toBe('one');
    expect(schemaDefault(schema, ['bad', 'x'])).toBeUndefined();
    expect(schemaDefault(schema, ['loop', 'x'])).toBeUndefined();
  });

  it('reads defaults of the real game settings schema', () => {
    expect(schemaDefault(realSchema, ['gamepadSupported'])).toBe(false);
    expect(schemaDefault(realSchema, ['sourceLanguage'])).toBe('en');
  });
});

describe('emptyValue', () => {
  it('gives the empty value of each type', () => {
    expect(emptyValue('string')).toBe('');
    expect(emptyValue('integer')).toBe(0);
    expect(emptyValue('number')).toBe(0);
    expect(emptyValue('boolean')).toBe(false);
    expect(emptyValue('object')).toEqual({});
    expect(emptyValue('array<string>')).toEqual([]);
    expect(emptyValue('integer?')).toBeNull();
    expect(emptyValue('array<string>?')).toBeNull();
    expect(() => emptyValue('date')).toThrow('unknown settings type in core spec: date');
  });
});

const module = (name: string, rows: [string, string, string][]): SpecModule => ({
  name,
  side: 'client',
  lifecycle: true,
  operations: [],
  dependencies: [],
  optionalDependencies: [],
  devDependencies: [],
  tables: [],
  settings: rows.map(([key, type, source]) => ({ key, type, source, owner: 'none' })),
});

describe('coreGameValues', () => {

  it('takes game rows: the value, else the schema default, else the empty value; <ENV> per environment', () => {
    const modules = [
      module('A', [
        ['A.count', 'integer', 'core'],
        ['firstScene', 'string', 'game'],
        ['gamepadSupported', 'boolean', 'game'],
        ['maxResolution', 'array<integer>?', 'game'],
        ['termsDocuments', 'object', 'game'],
        ['environments.<ENV>.serverUrl', 'string', 'game'],
        ['consent.version', 'integer', 'game'],
      ]),
      module('B', [['firstScene', 'integer', 'game']]),
    ];
    const settings = {
      firstScene: 'scene/a',
      consent: { version: 0 },
      environments: { DEV: { serverUrl: 'https://dev' }, PROD: {} },
    };
    expect(coreGameValues(modules, settings, realSchema)).toEqual({
      firstScene: 'scene/a',
      gamepadSupported: false,
      maxResolution: null,
      termsDocuments: {},
      'environments.DEV.serverUrl': 'https://dev',
      'environments.PROD.serverUrl': '',
      'consent.version': 0,
    });
    const keys = Object.keys(coreGameValues(modules, settings, realSchema));
    expect(keys.indexOf('environments.DEV.serverUrl')).toBeLessThan(keys.indexOf('environments.PROD.serverUrl'));
  });

  it('gives no <ENV> entry without environments and reads values through non-objects as missing', () => {
    const modules = [module('A', [['environments.<ENV>.serverUrl', 'string', 'game'], ['a.b', 'string?', 'game']])];
    expect(coreGameValues(modules, { a: 'text' }, {})).toEqual({ 'a.b': null });
  });
});

describe('coreSettingTypes', () => {
  it('gives the spec type of every settings row as written, <ENV> per environment, a key shared by modules once', () => {
    const modules = [
      module('UICore', [['UICore.keyboardGap', 'number', 'core'], ['SoundCore.busLoudnessLufs', 'object', 'core'], ['maxResolution', 'array<integer>?', 'game']]),
      module('NetworkCore', [['environments.<ENV>.serverUrl', 'string', 'game'], ['UICore.keyboardGap', 'number', 'core'], ['routing.ids', 'array<object>', 'core']]),
    ];
    expect(coreSettingTypes(modules, { environments: { DEV: {}, PROD: {} } })).toEqual({
      'UICore.keyboardGap': 'number',
      'SoundCore.busLoudnessLufs': 'object',
      maxResolution: 'array<integer>?',
      'environments.DEV.serverUrl': 'string',
      'environments.PROD.serverUrl': 'string',
      'routing.ids': 'array<object>',
    });
    expect(coreSettingTypes(modules, {})).not.toHaveProperty(['environments.DEV.serverUrl']);
  });

  it('fails on a key that two rows give different types', () => {
    const modules = [module('A', [['A.gap', 'number', 'core']]), module('B', [['A.gap', 'integer', 'core']])];
    expect(() => coreSettingTypes(modules, {})).toThrow('core spec settings key A.gap has type number and, in B, type integer');
  });
});
