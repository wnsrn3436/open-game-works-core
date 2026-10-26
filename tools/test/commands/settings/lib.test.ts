import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { coreRelease } from '../../../src/commands/core/api.ts';
import { coreFiles, coreKeys, implConstraints, matchCoreKey } from '../../../src/commands/settings/lib/core-files.ts';
import { constraintIssues } from '../../../src/commands/settings/lib/game-check.ts';
import { addedLeaves, changedPaths, getAt, mergeSettings, setAt, unsetAt } from '../../../src/commands/settings/lib/json-path.ts';
import { child, expand, infoOf, locate, ownerOf, propertyPaths, type SchemaNode } from '../../../src/commands/settings/lib/schema-nav.ts';
import { pointerPath, schemaIssues } from '../../../src/commands/settings/lib/validate.ts';
import { createContext } from '../../../src/lib/command.ts';
import { makeWorkspace } from '../../helpers/workspace.ts';

vi.mock('../../../src/commands/core/api.ts', () => ({
  coreRelease: vi.fn(),
  coreReleaseOfGame: vi.fn(),
  extractedAsset: vi.fn(),
  remoteReleaseVersions: vi.fn(),
  markProposalReleased: vi.fn(),
}));

const object = () => 'object' as const;

describe('json-path', () => {
  it('gets values', () => {
    const value = { a: [1, { b: 2 }], c: null };
    expect(getAt(value, ['a', '1', 'b'])).toBe(2);
    expect(getAt(value, ['a', 'x'])).toBeUndefined();
    expect(getAt(value, ['a', '01'])).toBeUndefined();
    expect(getAt(value, ['c', 'd'])).toBeUndefined();
    expect(getAt(value, ['toString'])).toBeUndefined();
    expect(getAt(value, [])).toBe(value);
  });

  it('sets values in a copy', () => {
    const root = { a: { b: 1 } };
    const value = { deep: [1] };
    const next = setAt(root, ['a', 'c'], value, object);
    value.deep.push(2);
    expect(next).toEqual({ a: { b: 1, c: { deep: [1] } } });
    expect(root).toEqual({ a: { b: 1 } });
    expect(setAt({}, ['x', '0', 'y'], 1, (p) => (p.length === 1 ? 'array' : 'object'))).toEqual({ x: [{ y: 1 }] });
    expect(() => setAt({}, [], 1, object)).toThrow('empty settings path');
    expect(() => setAt({ a: [] }, ['a', '1'], 1, object)).toThrow('a.1: index 1 is past the end of the array');
  });

  it('unsets values in a copy', () => {
    const root = { a: { b: 1, c: 2 }, l: [1, 2, 3] };
    expect(unsetAt(root, ['a', 'b'])).toEqual({ a: { c: 2 }, l: [1, 2, 3] });
    expect(unsetAt(root, ['l', '0'])).toEqual({ a: { b: 1, c: 2 }, l: [2, 3] });
    expect(unsetAt(root, ['a', 'x'])).toBeNull();
    expect(root).toEqual({ a: { b: 1, c: 2 }, l: [1, 2, 3] });
    expect(() => unsetAt(root, [])).toThrow('empty settings path');
  });

  it('lists changed paths', () => {
    expect(changedPaths({ a: 1, b: { c: 1 } }, { a: 1, b: { c: 1 } })).toEqual([]);
    expect(changedPaths({ a: 1 }, { a: 2 })).toEqual([['a']]);
    expect(changedPaths({ a: { c: 1 } }, { a: 3 })).toEqual([['a'], ['a', 'c']]);
    expect(changedPaths({}, { a: { b: [1] } })).toEqual([['a'], ['a', 'b'], ['a', 'b', '0']]);
    expect(changedPaths({ l: [1, 2] }, { l: [1] })).toEqual([['l', '1']]);
    expect(changedPaths({ l: [1] }, { l: { 0: 1 } })).toEqual([['l']]);
    expect(changedPaths({ a: {} }, {})).toEqual([['a']]);
  });

  it('lists added leaves', () => {
    expect(addedLeaves({ a: 1 }, { a: 1, b: { c: 2, d: {} }, e: [] })).toEqual([
      { path: ['b', 'c'], value: 2 },
      { path: ['b', 'd'], value: {} },
      { path: ['e'], value: [] },
    ]);
    expect(addedLeaves({ l: [{}, {}] }, { l: [{ k: 0 }, { k: 0 }] })).toEqual([
      { path: ['l', '0', 'k'], value: 0 },
      { path: ['l', '1', 'k'], value: 0 },
    ]);
    expect(addedLeaves({ a: 'x' }, { a: { b: 1 } })).toEqual([]);
    expect(addedLeaves({ a: [1] }, { a: [1, 2] })).toEqual([{ path: ['a', '1'], value: 2 }]);
  });

  it('merges settings by object key', () => {
    const base = { a: { b: 1, c: 2 }, l: [1, 2], s: 'x' };
    expect(mergeSettings(base, { a: { c: 3, d: 4 }, l: [9], n: { m: 1 } })).toEqual({ a: { b: 1, c: 3, d: 4 }, l: [9], s: 'x', n: { m: 1 } });
    expect(base).toEqual({ a: { b: 1, c: 2 }, l: [1, 2], s: 'x' });
    expect(mergeSettings(base, 5)).toBe(5);
  });
});

describe('schema-nav', () => {
  const root = {
    $defs: { name: { type: 'string', description: 'A name.' }, loop: { $ref: '#/$defs/loop' } },
    'x-owner': 'top',
    properties: {
      named: { $ref: '#/$defs/name', description: 'Own description.' },
      far: { $ref: 'other.json#/x' },
      loop: { $ref: '#/$defs/loop' },
      map: {
        patternProperties: { '^[0-9]+$': { type: 'integer' }, '(': { type: 'null' } },
        additionalProperties: { type: 'boolean' },
      },
      list: { type: 'array', items: { type: 'object', properties: { k: { type: 'string', 'x-owner': 'inner' } } } },
      both: { allOf: [{ properties: { p: { type: 'string' } } }, { properties: { p: { minLength: 1 }, q: {} } }] },
      'a/b': { type: 'string' },
    },
  };
  const start: SchemaNode[] = [{ node: root, root }];

  it('follows local $ref and allOf only', () => {
    expect(infoOf(child(start, 'named'))).toEqual({ description: 'Own description.', type: 'string', allowed: {} });
    expect(expand({ node: root.properties.far, root })).toHaveLength(1);
    expect(expand({ node: root.properties.loop, root }).length).toBeLessThan(40);
    expect(infoOf(child(child(start, 'both'), 'p'))).toEqual({ type: 'string', allowed: {} });
    expect(child(child(start, 'both'), 'p')).toHaveLength(2);
  });

  it('finds children by property, pattern, additional properties and items', () => {
    expect(infoOf(child(child(start, 'map'), '12')).type).toBe('integer');
    expect(infoOf(child(child(start, 'map'), 'name')).type).toBe('boolean');
    expect(infoOf(child(child(start, 'list'), '0')).type).toBe('object');
    expect(child(child(start, 'list'), 'x')).toEqual([]);
    expect(child(start, 'nope')).toEqual([]);
  });

  it('locates with the deepest x-owner', () => {
    expect(locate(start, ['list', '0', 'k']).owner).toBe('inner');
    expect(locate(start, ['list', '0']).owner).toBe('top');
    expect(locate(start, ['nope', 'x'])).toEqual({ nodes: [], owner: 'top' });
    expect(ownerOf([])).toBeUndefined();
  });

  it('lists property paths', () => {
    expect(propertyPaths(start).map((p) => p.join('.'))).toEqual(['named', 'far', 'loop', 'map', 'list', 'both', 'both.p', 'both.q', 'a/b']);
  });
});

describe('validate', () => {
  it('names paths of JSON pointers', () => {
    expect(pointerPath('')).toBe('(root)');
    expect(pointerPath('/a~1b/c~0d', ['x'])).toBe('x.a/b.c~d');
  });

  it('reports enum values and required values', () => {
    const schema = { type: 'object', required: ['a'], properties: { e: { enum: ['x', 1] } } };
    expect(schemaIssues(schema, { e: 'y' })).toEqual([
      { message: 'a: missing', missing: 'a' },
      { message: 'e: must be equal to one of the allowed values ("x", 1)' },
    ]);
    expect(schemaIssues(schema, { a: 1 })).toEqual([]);
  });
});

describe('core files', () => {
  it('matches the longest core settings key', () => {
    const keys = ['UICore.theme', 'UICore.theme.dark', 'UICore.themeX'];
    expect(matchCoreKey(keys, 'UICore.theme.dark')).toBe('UICore.theme.dark');
    expect(matchCoreKey(keys, 'UICore.theme.darkness')).toBe('UICore.theme');
    expect(matchCoreKey(keys, 'UICore.themeX.a')).toBe('UICore.themeX');
    expect(matchCoreKey(keys, 'UICore.them')).toBeNull();
    expect(coreKeys({})).toEqual([]);
  });

  it('reads release files and fails on wrong shapes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-release-'));
    const write = (name: string, value: unknown): void => {
      writeFileSync(join(dir, name), JSON.stringify(value));
    };
    write('core-spec.json', { version: '1.0.0' });
    write('core-settings.json', {});
    write('core-settings.schema.json', {});
    write('core-settings-constraints.json', []);
    vi.mocked(coreRelease).mockResolvedValue({ version: '1.0.0', dir, local: false });
    // a test harness: the core-v tags of the real harness are not of this test
    const ctx = createContext({ cwd: dir, env: makeWorkspace().env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    expect(await coreFiles(ctx, '1.0.0', 'g')).toEqual({ version: '1.0.0', settings: {}, schema: {}, constraints: [], modules: [] });
    write('core-settings-constraints.json', {});
    await expect(coreFiles(ctx, '1.0.0', 'g')).rejects.toThrow(`not a JSON array: ${join(dir, 'core-settings-constraints.json')}`);
    write('core-settings.json', []);
    await expect(coreFiles(ctx, '1.0.0', 'g')).rejects.toThrow(`not a JSON object: ${join(dir, 'core-settings.json')}`);
  });

  it('reads settings constraints of core-spec module files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-impl-'));
    expect(await implConstraints(dir)).toEqual([]);
    mkdirSync(join(dir, 'core-spec'));
    writeFileSync(join(dir, 'core-spec', 'b.json'), JSON.stringify({ settingsConstraints: [{ left: 'b', factor: 1, right: 'c' }] }));
    writeFileSync(join(dir, 'core-spec', 'a.json'), JSON.stringify({ settingsConstraints: [{ left: 'a', factor: 2, right: 'b' }] }));
    writeFileSync(join(dir, 'core-spec', 'c.json'), JSON.stringify({ name: 'c' }));
    expect(await implConstraints(dir)).toEqual([
      { left: 'a', factor: 2, right: 'b' },
      { left: 'b', factor: 1, right: 'c' },
    ]);
  });

  it('evaluates settings constraints', () => {
    const rule = [{ left: 'l', factor: 3, right: 'r' }];
    expect(constraintIssues(rule, { l: 2, r: 6 }, '')).toEqual([]);
    expect(constraintIssues(rule, { l: 2, r: 5 }, 'core.')).toEqual([{ message: 'core.l × 3 must be at most core.r' }]);
    expect(constraintIssues(rule, { l: 2 }, '')).toHaveLength(1);
    expect(constraintIssues(rule, { r: 2 }, '')).toHaveLength(1);
  });
});
