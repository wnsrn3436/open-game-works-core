import { mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { at, finding, listFiles } from '../../../../src/commands/check/static/lib/context.ts';
import { cellOf, parseCsv, parseDataTable } from '../../../../src/commands/check/static/lib/csv.ts';
import * as files from '../../../../src/commands/check/static/lib/files.ts';
import type { FuncDecl } from '../../../../src/commands/check/static/lib/gd-ast.ts';
import { parseGdExpr } from '../../../../src/commands/check/static/lib/gd-parser.ts';
import { classIndex } from '../../../../src/commands/check/static/lib/gd-shared.ts';
import { classRefs, TypeResolver, typeText } from '../../../../src/commands/check/static/lib/gd-types.ts';
import { JsonPosError, parseJsonWithLines } from '../../../../src/commands/check/static/lib/json-pos.ts';
import { qaBuiltins, splitTopLevel, tableCells, translationKeyInputs } from '../../../../src/commands/check/static/lib/specs.ts';
import { extIdOf, nodeInstance, nodeScript, parseTextScene, strOf } from '../../../../src/commands/check/static/lib/tscn.ts';
import { commitAll, gitInit } from '../../../helpers/workspace.ts';
import { CORE_STUBS, memContext, writeFiles } from './helpers.ts';

vi.mock('../../../../src/commands/generate/api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  gameCoreSpec: async () => (await import('./helpers.ts')).CORE_SPEC,
}));

describe('csv', () => {
  it('reads quoted cells, CRLF, BOM, empty lines and record lines', () => {
    const rows = parseCsv('﻿a,"b,1","c\n""d"""\r\n\r\nx,,\n"y"');
    expect(rows).toEqual([
      { cells: ['a', 'b,1', 'c\n"d"'], line: 1 },
      { cells: [''], line: 3 },
      { cells: ['x', '', ''], line: 4 },
      { cells: ['y'], line: 5 },
    ]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('a\n')).toEqual([{ cells: ['a'], line: 1 }]);
  });

  it('reads data tables and header tables', () => {
    const table = parseDataTable('data/tables/t.csv', ',\nAll,Client\nid(key),int\nid,n\n[a],1\n\n#[b],2\n[c],3\n');
    expect(table?.names).toEqual(['id', 'n']);
    expect(table?.types).toEqual(['id(key)', 'int']);
    expect(table?.targets).toEqual(['All', 'Client']);
    expect(table?.rows.map((r) => [r.cells[0], r.line])).toEqual([['[a]', 5], ['[c]', 8]]);
    expect(table && cellOf(table, table.rows[0] ?? { cells: [], line: 0 }, 'n')).toBe('1');
    expect(table && cellOf(table, table.rows[0] ?? { cells: [], line: 0 }, 'zz')).toBeUndefined();
    expect(parseDataTable('x', 'a\nb\n')).toBeNull();
  });
});

describe('json with lines', () => {
  it('records the line of every value', () => {
    const { value, lines } = parseJsonWithLines('{\n  "a": [1,\n    {"b": "x/y"}],\n  "c~d/e": null\n}');
    expect(value).toEqual({ a: [1, { b: 'x/y' }], 'c~d/e': null });
    expect(lines.get('')).toBe(1);
    expect(lines.get('/a')).toBe(2);
    expect(lines.get('/a/1')).toBe(3);
    expect(lines.get('/a/1/b')).toBe(3);
    expect(lines.get('/c~0d~1e')).toBe(4);
    expect(parseJsonWithLines('[]').value).toEqual([]);
    expect(parseJsonWithLines('{}').value).toEqual({});
    const proto = parseJsonWithLines('{"__proto__": {"x": 1}, "a": 2}').value as Record<string, unknown>;
    expect(Object.keys(proto)).toEqual(['__proto__', 'a']);
    expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
  });

  it('reports errors with lines', () => {
    const bad = (text: string): [string, number] => {
      try {
        parseJsonWithLines(text);
      } catch (error) {
        if (error instanceof JsonPosError) return [error.message, error.line];
      }
      return ['', 0];
    };
    expect(bad('{\n"a" 1}')).toEqual(['expected `:`', 2]);
    expect(bad('{"a": 1 "b"}')).toEqual(['expected `,` or `}`', 1]);
    expect(bad('[1 2]')).toEqual(['expected `,` or `]`', 1]);
    expect(bad('{1: 2}')).toEqual(['expected a string key', 1]);
    expect(bad('\n\nnope')).toEqual(['invalid JSON value', 3]);
    expect(bad('"a\nb"')).toEqual(['invalid string', 1]);
    expect(bad('1 2')).toEqual(['extra text after the JSON value', 1]);
  });
});

describe('text scenes', () => {
  it('reads sections, ext resources, nodes and multi-line values', () => {
    const scene = parseTextScene(
      'resource/scene/a/main.tscn',
      [
        '[gd_scene load_steps=3 format=3 uid="uid://abc"]',
        '',
        '[ext_resource type="Script" uid="uid://s" path="res://features/a/a.gd" id="1_s"]',
        '[ext_resource type="PackedScene" path="res://resource/prefab/a/b.tscn" id=2]',
        '',
        '[sub_resource type="GDScript" id="g1"]',
        'script/source = "extends Node',
        'func f():',
        '\tpass"',
        '',
        '[node name="Root" type="Control"]',
        'script = ExtResource("1_s")',
        'list = [1, 2.5, "x", &"y", null, true, Vector2(1, 2), {"k": [3]}]',
        'np = NodePath("A/B")',
        'esc = "a\\"b\\nc"',
        '',
        '[node name="Child" parent="." instance=ExtResource("2")]',
        'joystick_mode = 2',
        'weird = @@@',
        '',
        '[node name="Deep" type="Node" parent="Child"]',
        'typed = Array[StringName]([&"a"])',
        '',
      ].join('\n'),
    );
    expect(scene.header?.tag).toBe('gd_scene');
    expect([...scene.ext.values()].map((e) => [e.id, e.type, e.path, e.line])).toEqual([
      ['1_s', 'Script', 'res://features/a/a.gd', 3],
      ['2', 'PackedScene', 'res://resource/prefab/a/b.tscn', 4],
    ]);
    expect(scene.sub.get('g1')?.line).toBe(6);
    expect(scene.nodes.map((n) => [n.name, n.type, n.path, n.parent, n.line])).toEqual([
      ['Root', 'Control', '.', null, 11],
      ['Child', null, 'Child', '.', 17],
      ['Deep', 'Node', 'Child/Deep', 'Child', 21],
    ]);
    const root = scene.nodes[0];
    const child = scene.nodes[1];
    if (!root || !child) throw new Error('nodes expected');
    expect(nodeScript(scene, root)).toBe('res://features/a/a.gd');
    expect(nodeInstance(scene, child)).toBe('res://resource/prefab/a/b.tscn');
    expect(nodeInstance(scene, root)).toBeNull();
    expect(nodeScript(scene, child)).toBeNull();
    expect(root.props.get('list')?.value).toEqual({
      t: 'arr',
      items: [
        { t: 'num', v: 1, text: '1' },
        { t: 'num', v: 2.5, text: '2.5' },
        { t: 'str', v: 'x' },
        { t: 'sname', v: 'y' },
        { t: 'null' },
        { t: 'bool', v: true },
        { t: 'call', name: 'Vector2', args: [{ t: 'num', v: 1, text: '1' }, { t: 'num', v: 2, text: '2' }] },
        { t: 'dict', entries: [{ key: { t: 'str', v: 'k' }, value: { t: 'arr', items: [{ t: 'num', v: 3, text: '3' }] } }] },
      ],
    });
    expect(strOf(root.props.get('esc')?.value)).toBe('a"b\nc');
    expect(root.props.get('np')?.line).toBe(14);
    expect(child.props.get('joystick_mode')?.value).toEqual({ t: 'num', v: 2, text: '2' });
    expect(child.props.get('weird')?.value).toEqual({ t: 'raw', text: '@@@' });
    expect(scene.nodes[2]?.props.get('typed')?.value).toEqual({ t: 'call', name: 'Array[StringName]', args: [{ t: 'arr', items: [{ t: 'sname', v: 'a' }] }] });
    expect(extIdOf({ t: 'call', name: 'SubResource', args: [] })).toBeNull();
    expect(strOf(undefined)).toBeNull();
    expect(strOf({ t: 'num', v: 1, text: '1' })).toBeNull();
  });
});

describe('files', () => {
  it('classifies game files', () => {
    expect(files.isClientContentGd('client/features/a/a.gd')).toBe(true);
    expect(files.isClientContentGd('client/dev/a.gd')).toBe(true);
    expect(files.isClientContentGd('client/dev/generated/a.gd')).toBe(false);
    expect(files.isClientContentGd('client/core/a.gd')).toBe(false);
    expect(files.isClientContentGd('client/boot/boot.gd')).toBe(false);
    expect(files.isClientContentGd('client/boot/content_boot.gd')).toBe(true);
    expect(files.isClientContentGd('client/features/a/a.tscn')).toBe(false);
    expect(files.isClientGd('client/core/a.gd')).toBe(true);
    expect(files.isClientGd('client/addons/gut/a.gd')).toBe(false);
    expect(files.isServerContentTs('server/handlers/A.ts')).toBe(true);
    expect(files.isServerContentTs('server/dev/generated/a.ts')).toBe(false);
    expect(files.isServerContentTs('server/dev/main.ts')).toBe(false);
    expect(files.isServerContentTs('server/generated/a.ts')).toBe(false);
    expect(files.isServerContentTs('server/tests/a.test.ts')).toBe(true);
    expect(files.isServerContentTs('server/core/a.ts')).toBe(false);
    expect(files.isServerContentTs('server/a.js')).toBe(false);
    expect(files.isConstantsFile('client/common/constants.gd')).toBe(true);
    expect(files.isConstantsFile('client/features/shop/constants.gd')).toBe(true);
    expect(files.isConstantsFile('client/features/shop/sub/constants.gd')).toBe(false);
    expect(files.isConstantsFile('server/common/constants.ts')).toBe(true);
    expect(files.featureOf('client/features/daily_quest/x.gd')).toBe('daily_quest');
    expect(files.featureOf('client/common/x.gd')).toBeNull();
    expect(files.resPath('client/features/a.gd')).toBe('res://features/a.gd');
    expect(files.resPath('resource/a.png')).toBe('res://resource/a.png');
    expect(files.repoPath('res://resource/a.png')).toBe('resource/a.png');
    expect(files.repoPath('res://core/a.gd')).toBe('client/core/a.gd');
    expect(files.repoPath('user://a')).toBeNull();
    expect(files.pascal('daily_quest')).toBe('DailyQuest');
    expect(files.snake('ITEM_COUNT')).toBe('item_count');
    expect(files.snake('QuestCleared')).toBe('quest_cleared');
    expect(files.snake('HTTPCode')).toBe('http_code');
    expect(files.isSnakeCase('a_b1')).toBe(true);
    expect(files.isSnakeCase('a__b')).toBe(false);
    expect(files.isSnakeCase('A')).toBe(false);
  });

  it('lists working tree files without ignored files and symbolic links', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-list-')));
    gitInit(root);
    writeFiles(root, { '.gitignore': 'ignored/\n', 'a.txt': 'a', 'ignored/x': 'x', 'resource/r.png': 'r' });
    commitAll(root);
    writeFiles(root, { 'new.txt': 'n' });
    symlinkSync('../resource', join(root, 'link'));
    expect(await listFiles(root)).toEqual(['.gitignore', 'a.txt', 'new.txt', 'resource/r.png']);
    expect(finding('x', at('a', 2), 'y')).toEqual({ where: 'a:2', message: 'x: y' });
  });
});

describe('specs', () => {
  it('splits markdown table cells and inputs', () => {
    expect(tableCells('| `a` | b \\| c | d |')).toEqual(['`a`', 'b \\| c', 'd']);
    expect(splitTopLevel('a, b (c, d), `e, f`, g')).toEqual(['a', 'b (c, d)', '`e, f`', 'g']);
  });

  it('reads translation key inputs from the core spec and QACore built-in commands from the harness spec', async () => {
    const sc = memContext({});
    const inputs = await translationKeyInputs(sc);
    expect([...inputs]).toEqual([
      ['LocalizationCore.get_text', [0]],
      ['LocalizationCore.bind_text', [1]],
      ['MessageCore.show_toast', [0]],
      ['RequirementCore.register_judge', [3]],
    ]);
    const builtins = await qaBuiltins(sc);
    expect(builtins.get('tap')).toBe('input');
    expect(builtins.get('restart')).toBe('setup');
    expect(builtins.get('step')).toBe('step');
    expect(builtins.get('get_state')).toBe('other');
  });
});

describe('type resolver', () => {
  it('finds types of declarations, members, calls, indexes and operators', async () => {
    const sc = memContext({
      ...CORE_STUBS,
      'client/features/a/a_view.gd': [
        'class_name AView',
        'extends AnimationPlayer',
        'var field: int = 0',
        'var inferred := GameData.ItemTable.get_row(1)',
        'class Inner extends RefCounted:',
        '\tvar v: String',
        '\tstatic func make() -> AView.Inner:',
        '\t\treturn null',
        'func f(p: Array[GameData.ItemRow], d: Dictionary[String, int], s: String, b: PackedInt32Array) -> void:',
        '\tvar loc := p[0]',
        '\tvar cnt := 3',
        '\tfor row in p:',
        '\t\tpass',
        '\tvar e := Inner.make()',
        '',
      ].join('\n'),
    });
    const index = await classIndex(sc);
    const file = await sc.gd('client/features/a/a_view.gd');
    const top = classRefs(file)[0];
    const fn = file.top.body.find((s): s is FuncDecl => s.k === 'func');
    if (!top || !fn) throw new Error('setup');
    const r = new TypeResolver(index, { file, cls: top.cls, fns: [fn] });
    const t = async (src: string): Promise<string | null> => {
      const ty = await r.typeOf(parseGdExpr(src));
      return ty ? typeText(ty) : null;
    };
    expect(await t('field')).toBe('int');
    expect(await t('inferred')).toBe('GameData.ItemRow');
    expect(await t('inferred.price')).toBe('int');
    expect(await t('inferred.cost')).toBe('Array[CoreContract.ItemAmount]');
    expect(await t('inferred.cost[0].amount')).toBe('int');
    expect(await t('loc')).toBe('GameData.ItemRow');
    expect(await t('row')).toBe('GameData.ItemRow');
    expect(await t('cnt')).toBe('int');
    expect(await t('d["x"]')).toBe('int');
    expect(await t('b[0]')).toBe('int');
    expect(await t('s.length()')).toBe('int');
    expect(await t('p.duplicate()')).toBe('Array[GameData.ItemRow]');
    expect(await t('p.front()')).toBe('GameData.ItemRow');
    expect(await t('p.is_empty()')).toBe('bool');
    expect(await t('d.keys()')).toBe('Array[String]');
    expect(await t('d.values()')).toBe('Array[int]');
    expect(await t('e')).toBe('AView.Inner');
    expect(await t('Inner.new().v')).toBe('String');
    expect(await t('self')).toBe('AView');
    expect(await t('1 + 2.0')).toBe('float');
    expect(await t('1 < 2')).toBe('bool');
    expect(await t('"%d" % 3')).toBe('String');
    expect(await t('not x')).toBe('bool');
    expect(await t('-cnt')).toBe('int');
    expect(await t('x is Node')).toBe('bool');
    expect(await t('cnt if true else 2')).toBe('int');
    expect(await t('x as Label')).toBe('Label');
    expect(await t('[1]')).toBe('Array');
    expect(await t('{}')).toBe('Dictionary');
    expect(await t('&"n"')).toBe('StringName');
    expect(await t('^"n"')).toBe('NodePath');
    expect(await t('len(p)')).toBe('int');
    expect(await t('range(3)')).toBe('Array[int]');
    expect(await t('Vector2i(1, 2)')).toBe('Vector2i');
    expect(await t('int("3")')).toBe('int');
    expect(await t('unknown_thing')).toBeNull();
    expect(await t('unknown_thing.x')).toBeNull();
    expect(await t('await x')).toBeNull();
    expect(await t('GameData')).toBe('#class[GameData]');
    expect(await t('String')).toBe('#class[String]');
    expect(await t('String.new()')).toBe('String');
    expect(r.isLocal('cnt')).toBe(true);
    expect(r.isLocal('field')).toBe(false);
    expect(await index.isA(top, 'AnimationPlayer')).toBe(true);
    expect(await index.isA(top, 'Timer')).toBe(false);
    expect(await index.byName('GameData.Nope')).toBeNull();
    expect(await index.byName('Nope')).toBeNull();
    expect(await index.byPath('client/features/a/none.gd')).toBeNull();
  });
});
