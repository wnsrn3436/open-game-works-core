import { describe, expect, it } from 'vitest';
import * as forbiddenApi from '../../../../src/commands/check/static/forbidden-api.ts';
import type { Expr, Stmt } from '../../../../src/commands/check/static/lib/gd-ast.ts';
import { lexGd } from '../../../../src/commands/check/static/lib/gd-lexer.ts';
import { parseGd, parseGdExpr } from '../../../../src/commands/check/static/lib/gd-parser.ts';
import { classFuncs, exprChildren, stmtExprs, visitClass } from '../../../../src/commands/check/static/lib/gd-walk.ts';
import { lines, memContext, sorted } from './helpers.ts';

function kinds(stmts: readonly Stmt[]): string[] {
  return stmts.map((s) => s.k);
}

const DETAILS = [
  'class_name A extends "res://base.gd"',
  'enum { X, Y = 2 }',
  'signal changed(old: int, new: int)',
  '@export_range(0, 10) var level: int = 1',
  '@export_group("Stats")',
  '@export var hp: int',
  '@warning_ignore("unused") static func s() -> void: pass',
  'const C: int = 3',
  'var setter_ref: int = 0: set = _set_ref, get = _get_ref',
  'var x = 1',
  '',
].join('\n');

describe('gdscript parser details', () => {
  it('reads extends forms, unnamed enums, signals with parameters and annotations with arguments', () => {
    const file = parseGd('x.gd', DETAILS);
    expect(file.top.name).toBe('A');
    expect(file.top.extendsPath).toBe('res://base.gd');
    expect(kinds(file.top.body)).toEqual(['class_name', 'enum', 'signal', 'var', 'var', 'func', 'var', 'var', 'var']);
    const en = file.top.body[1];
    expect(en?.k === 'enum' && [en.name, en.members.map((m) => m.name)]).toEqual([null, ['X', 'Y']]);
    const level = file.top.body[3];
    expect(level?.k === 'var' && level.annotations.map((a) => [a.name, a.args.length])).toEqual([['export_range', 2]]);
    const hp = file.top.body[4];
    expect(hp?.k === 'var' && hp.annotations.map((a) => a.name)).toEqual(['export_group', 'export']);
  });

  it('reads static functions, typed constants, accessors and untyped variables', () => {
    const file = parseGd('x.gd', DETAILS);
    const s = file.top.body[5];
    expect(s?.k === 'func' && [s.isStatic, s.annotations.map((a) => a.name), s.body.length]).toEqual([true, ['warning_ignore'], 1]);
    const c = file.top.body[6];
    expect(c?.k === 'var' && [c.isConst, c.type?.name]).toEqual([true, 'int']);
    const ref = file.top.body[7];
    expect(ref?.k === 'var' && ref.accessors).toEqual([]);
    const x = file.top.body[8];
    expect(x?.k === 'var' && [x.inferred, x.type, x.value?.k]).toEqual([false, null, 'num']);
  });

  it('reads standalone annotations and extends paths with inner class', () => {
    const file = parseGd('x.gd', '@tool\n@icon("res://i.png")\nextends "res://a.gd".Inner\n');
    expect(kinds(file.top.body)).toEqual(['annotation', 'annotation', 'extends']);
    expect(file.top.extendsPath).toBe('res://a.gd');
    expect(parseGd('y.gd', 'extends Node2D.Sub\n').top.extendsName).toBe('Node2D.Sub');
  });

  it('reads function parameters, defaults, inferred parameters and return types', () => {
    const file = parseGd('x.gd', 'func f(a: int, b := 2, c = "x", d: Array[int] = []) -> Dictionary[String, int]:\n\treturn {}\nfunc g()\n');
    const [f, g] = classFuncs(file.top);
    expect(f?.params.map((p) => [p.name, p.type?.name ?? null, p.inferred, p.value?.k ?? null])).toEqual([
      ['a', 'int', false, null],
      ['b', null, true, 'num'],
      ['c', null, false, 'str'],
      ['d', 'Array', false, 'array'],
    ]);
    expect(f?.returnType).toEqual({ name: 'Dictionary', args: [{ name: 'String', args: [], line: 1 }, { name: 'int', args: [], line: 1 }], line: 1 });
    expect(g?.body).toEqual([]);
    expect(f?.endLine).toBe(2);
  });

  it('reads nested blocks, semicolons, while, match with guards and multi-line calls', () => {
    const file = parseGd(
      'x.gd',
      [
        'func f() -> void:',
        '\tvar a := 1; var b := 2',
        '\twhile a < 3:',
        '\t\ta += 1',
        '\t\tif a == 2:',
        '\t\t\tcontinue',
        '\tmatch [a, b]:',
        '\t\t[1, var y] when y > 0:',
        '\t\t\tpass',
        '\t\t_:',
        '\t\t\tbreak',
        '\tcall_it(',
        '\t\ta,',
        '\t\tb',
        '\t)',
        '\tvar d := {',
        '\t\t"k": func(): return 1,',
        '\t}',
        '\tbreakpoint',
        '',
      ].join('\n'),
    );
    const f = classFuncs(file.top)[0];
    expect(kinds(f?.body ?? [])).toEqual(['var', 'var', 'while', 'match', 'expr', 'var', 'simple']);
    const m = f?.body[3];
    expect(m?.k === 'match' && m.branches.map((b) => [b.patterns.map((t) => t.text).join(''), b.guard !== null])).toEqual([
      ['[1,vary]', true],
      ['_', false],
    ]);
    const call = f?.body[4];
    expect(call?.k === 'expr' && call.expr.k === 'call' && call.expr.args.length).toBe(2);
  });

  it('covers walker helpers', () => {
    const file = parseGd('x.gd', 'enum E { A = 1 + 2 }\nfunc f(p := 3) -> void:\n\tmatch p:\n\t\t1 when p > 0:\n\t\t\treturn\n@export_range(1, 5) var v: int\n');
    const exprs: string[] = [];
    visitClass(file.top, {
      expr(e) {
        exprs.push(e.k);
      },
    });
    expect(exprs).toEqual(['binary', 'num', 'num', 'num', 'name', 'binary', 'name', 'num', 'num', 'num']);
    const ret = parseGd('y.gd', 'func f():\n\treturn\n');
    const body = classFuncs(ret.top)[0]?.body ?? [];
    expect(body.map(stmtExprs)).toEqual([[]]);
    const dict = parseGdExpr('{a: 1, "b": c[0]}');
    expect(exprChildren(dict).map((e: Expr) => e.k)).toEqual(['name', 'num', 'str', 'index']);
    expect(exprChildren(parseGdExpr('x if y else z')).map((e) => e.k)).toEqual(['name', 'name', 'name']);
  });

  it('lexes edge cases without throwing', () => {
    const { tokens } = lexGd('a = "unterminated\nb = r"raw\\n" + \'s\' + """t\\"x""" # end\nc = 1. + x.y\n$"Quoted/Path".show()\nd = 5 % 3\ne = arr[1] % 2\n');
    const texts = tokens.filter((t) => t.type !== 'newline' && t.type !== 'eof').map((t) => `${t.type}:${t.type === 'str' ? t.value : t.text}`);
    expect(texts).toContain('str:unterminated');
    expect(texts).toContain('str:raw\\n');
    expect(texts).toContain('str:t"x');
    expect(texts).toContain('nodepath:$"Quoted/Path"');
    expect(texts.filter((t) => t === 'op:%')).toHaveLength(2);
    expect(texts).toContain('num:1.');
  });
});

describe('forbidden GDScript API receivers', () => {
  it('uses declared receiver types to tell Object APIs from Callable, collection and Signal methods', async () => {
    const sc = memContext({
      'client/common/common_x.gd': [
        'class_name CommonX',
        'var cb: Callable',
        'var node: Node',
        'var sig: Signal',
        'var arr: Array[Node]',
        'func f(name: StringName) -> void:',
        '\tcb.call("arg")',
        '\tnode.call(name)',
        '\tunknown.callv("m", [])',
        '\tunknown.callv([])',
        '\tnode.get_indexed("a:b")',
        '\tunknown.set_indexed("a", 1)',
        '\tarr.set(0, node)',
        '\tunknown.get("k")',
        '\tsig.connect(f)',
        '\tnode.connect(f)',
        '\tsig.is_connected(f)',
        '\tunknown.is_connected("s", f)',
        '\tself.set("x", 1)',
        '\tSignal(node, "ready")',
        '\tCallable(f)',
        '',
      ].join('\n'),
    });
    expect(lines(await forbiddenApi.run(sc))).toEqual(sorted([
      'client/common/common_x.gd:8 | forbidden GDScript API: `call()` by method name',
      'client/common/common_x.gd:9 | forbidden GDScript API: `callv()` by method name',
      'client/common/common_x.gd:11 | forbidden GDScript API: `get_indexed()` by property name',
      'client/common/common_x.gd:12 | forbidden GDScript API: `set_indexed()` by property name',
      'client/common/common_x.gd:16 | forbidden GDScript API: Object `connect()`',
      'client/common/common_x.gd:18 | forbidden GDScript API: Object `is_connected()`',
      'client/common/common_x.gd:19 | forbidden GDScript API: `set()` by property name',
      'client/common/common_x.gd:20 | forbidden GDScript API: `Signal(obj, "name")`',
    ]));
  });
});
