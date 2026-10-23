import { describe, expect, it } from 'vitest';
import type { Expr, FuncDecl, Stmt } from '../../../../src/commands/check/static/lib/gd-ast.ts';
import { isRealLiteral, lexGd, numberValue } from '../../../../src/commands/check/static/lib/gd-lexer.ts';
import { parseGd, parseGdExpr } from '../../../../src/commands/check/static/lib/gd-parser.ts';
import { allClasses, callTarget, chainText, classFuncs, eachExpr, isNumberLiteral, visitClass } from '../../../../src/commands/check/static/lib/gd-walk.ts';

const SAMPLE = `@tool
class_name ShopPanel extends UIPanel
## doc
signal bought(id: int)
enum State { IDLE, BUSY = 3 }
const MAX := 5 # reason
@export var speed: float = 1.5
@onready var _label: Label = $Box/Label
var _rows: Array[GameData.ItemRow] = []
var hp: int = 0:
	get:
		return hp
	set(value):
		hp = value

static func make() -> ShopPanel:
	return ShopPanel.new()

func _ready() -> void:
	var t := InputBlockCore.block("ui")
	if t == null: return
	elif hp > 2:
		pass
	else:
		hp += 1
	for r: GameData.ItemRow in GameData.ItemTable.all_rows():
		r.price = 3
	button.pressed.connect(func() -> void:
		_on_buy()
		var x := 1
	)
	match hp:
		1, 2:
			print("a")
		var v when v > 3:
			print(%Unique.text % 3)
	while hp < 10 and not done:
		await get_tree().process_frame
	var d: Dictionary[String, int] = {"a": 1, b = 2}
	var s := "x" if hp > 0 else 'y'
	var n := (hp as int) * -2
	_label.text = """multi
line"""
	foo(func(): return 1, 2)
	InputBlockCore.unblock(t)

class Inner extends RefCounted:
	var a: int
	func f() -> int:
		return a
`;

function func(stmts: Stmt[], name: string): FuncDecl {
  const found = stmts.find((s): s is FuncDecl => s.k === 'func' && s.name === name);
  if (!found) throw new Error(`no func ${name}`);
  return found;
}

describe('gdscript lexer', () => {
  it('reads strings, node paths, numbers and comments', () => {
    const { tokens, comments } = lexGd('var a := &"n" + ^"p" + r"\\d" + "q\\"x" # c\nb = $A/B % %C\nc = .5 + 0x1F + 1_000 + 1e3\n');
    const strs = tokens.filter((t) => t.type === 'str').map((t) => [t.kind, t.value]);
    expect(strs).toEqual([['stringname', 'n'], ['nodepath', 'p'], ['string', '\\d'], ['string', 'q"x']]);
    const paths = tokens.filter((t) => t.type === 'nodepath').map((t) => [t.kind, t.value]);
    expect(paths).toEqual([['$', 'A/B'], ['%', 'C']]);
    expect(tokens.filter((t) => t.type === 'op' && t.text === '%')).toHaveLength(1);
    expect(tokens.filter((t) => t.type === 'num').map((t) => t.text)).toEqual(['.5', '0x1F', '1_000', '1e3']);
    expect(comments).toEqual([{ line: 1, text: ' c', trailing: true }]);
    expect(numberValue('0x1F')).toBe(31);
    expect(numberValue('0b101')).toBe(5);
    expect(numberValue('1_000')).toBe(1000);
    expect(isRealLiteral('1.0')).toBe(true);
    expect(isRealLiteral('1e3')).toBe(true);
    expect(isRealLiteral('0x1e')).toBe(false);
    expect(isRealLiteral('10')).toBe(false);
  });

  it('emits line breaks with the next line indentation and joins backslash lines', () => {
    const { tokens } = lexGd('a = 1 + \\\n\t2\nif x:\n\tb()\n');
    const newlines = tokens.filter((t) => t.type === 'newline').map((t) => [t.line, t.indent]);
    expect(newlines).toEqual([[2, 0], [3, 4], [4, 0]]);
    expect(tokens.at(-1)?.type).toBe('eof');
  });

  it('keeps a comment-only line as a non-trailing comment and reads triple quoted strings', () => {
    const { tokens, comments } = lexGd('# ogw:shared a.b\nvar s = """x\ny"""\n');
    expect(comments).toEqual([{ line: 1, text: ' ogw:shared a.b', trailing: false }]);
    const str = tokens.find((t) => t.type === 'str');
    expect(str?.value).toBe('x\ny');
    expect(str?.endLine).toBe(3);
  });
});

describe('gdscript parser', () => {
  const file = parseGd('client/x.gd', SAMPLE);

  it('reads the class header and declarations', () => {
    expect(file.top.name).toBe('ShopPanel');
    expect(file.top.extendsName).toBe('UIPanel');
    const kinds = file.top.body.map((s) => s.k);
    expect(kinds).toEqual(['annotation', 'class_name', 'signal', 'enum', 'var', 'var', 'var', 'var', 'var', 'func', 'func', 'class']);
    const speed = file.top.body[5];
    expect(speed?.k === 'var' && speed.annotations.map((a) => a.name)).toEqual(['export']);
    const hp = file.top.body[8];
    expect(hp?.k === 'var' && hp.accessors.map((a) => a.name)).toEqual(['get', 'set']);
    const rows = file.top.body[7];
    expect(rows?.k === 'var' && rows.type).toEqual({ name: 'Array', args: [{ name: 'GameData.ItemRow', args: [], line: 9 }], line: 9 });
    const make = func(file.top.body, 'make');
    expect(make.isStatic).toBe(true);
    expect(make.returnType?.name).toBe('ShopPanel');
    const en = file.top.body[3];
    expect(en?.k === 'enum' && en.members.map((m) => m.name)).toEqual(['IDLE', 'BUSY']);
  });

  it('reads function bodies, blocks, lambdas and match branches', () => {
    const ready = func(file.top.body, '_ready');
    expect(ready.body.map((s) => [s.k, s.line])).toEqual([
      ['var', 20], ['if', 21], ['for', 26], ['expr', 28], ['match', 32], ['while', 37], ['var', 39], ['var', 40], ['var', 41],
      ['assign', 42], ['expr', 44], ['expr', 45],
    ]);
    const ifs = ready.body[1];
    expect(ifs?.k === 'if' && [ifs.branches.length, ifs.elseBody.length]).toEqual([2, 1]);
    const connect = ready.body[3];
    if (connect?.k !== 'expr' || connect.expr.k !== 'call') throw new Error('call expected');
    const lambda = connect.expr.args[0];
    expect(lambda?.k === 'lambda' && lambda.fn.body.map((s) => [s.k, s.line])).toEqual([['expr', 29], ['var', 30]]);
  });

  it('reads match branches, call arguments and multiline strings', () => {
    const ready = func(file.top.body, '_ready');
    const match = ready.body[4];
    expect(match?.k === 'match' && match.branches.map((b) => [b.patterns.map((t) => t.text).join(' '), b.guard?.k ?? null, b.body.length])).toEqual([
      ['1 , 2', null, 1],
      ['var v', 'binary', 1],
    ]);
    const foo = ready.body[10];
    expect(foo?.k === 'expr' && foo.expr.k === 'call' && foo.expr.args.map((a) => a.k)).toEqual(['lambda', 'num']);
    const assign = ready.body[9];
    expect(assign?.k === 'assign' && assign.value.k === 'str' && assign.value.value).toBe('multi\nline');
  });

  it('reads inner classes', () => {
    const classes = allClasses(file.top);
    expect(classes.map((c) => c.name)).toEqual(['ShopPanel', 'Inner']);
    const inner = classes[1];
    expect(inner?.extendsName).toBe('RefCounted');
    expect(inner?.outer).toBe(file.top);
    expect(classFuncs(inner ?? file.top).map((f) => f.name)).toEqual(['f']);
  });

  it('visits every expression with its scope', () => {
    const calls: string[] = [];
    visitClass(file.top, {
      expr(e, scope) {
        if (e.k === 'call') calls.push(`${scope.method?.name ?? '-'}:${chainText(e.callee) ?? '?'}`);
      },
    });
    expect(calls).toContain('_ready:InputBlockCore.block');
    expect(calls).toContain('_ready:_on_buy');
    expect(calls).toContain('_ready:foo');
    expect(calls).toContain('make:ShopPanel.new');
    expect(calls).toContain('-:GameData.ItemTable.all_rows'.replace('-', '_ready'));
  });

  it('parses expressions with precedence', () => {
    const e = parseGdExpr('a + b * -c.d(1, "x")[2] as int');
    expect(e.k).toBe('cast');
    const sum = e.k === 'cast' ? e.expr : e;
    expect(sum.k === 'binary' && sum.op).toBe('+');
    const tern = parseGdExpr('x if a or b else y if c else z');
    expect(tern.k === 'ternary' && tern.else.k).toBe('ternary');
    const notIn = parseGdExpr('a not in b and not c');
    expect(notIn.k === 'binary' && notIn.op).toBe('and');
    const isNot = parseGdExpr('a is not Node');
    expect(isNot.k).toBe('is');
    const aw = parseGdExpr('await x.f()');
    expect(aw.k === 'await' && aw.expr.k).toBe('call');
    const all: string[] = [];
    eachExpr(parseGdExpr('f(func(): return g(1))'), (x: Expr) => all.push(x.k));
    expect(all).toEqual(['call', 'name', 'lambda', 'call', 'name', 'num']);
    const call = parseGdExpr('obj.m(1)');
    expect(call.k === 'call' && callTarget(call)?.name).toBe('m');
    expect(isNumberLiteral(parseGdExpr('-3'))).toBe(true);
    expect(isNumberLiteral(parseGdExpr('-x'))).toBe(false);
  });

  it('recovers from broken lines', () => {
    const broken = parseGd('x.gd', 'func a() -> void:\n\tvar = = )\n\tb()\nfunc c():\n\tpass\n');
    expect(classFuncs(broken.top).map((f) => f.name)).toEqual(['a', 'c']);
    expect(func(broken.top.body, 'a').body.map((s) => s.k)).toEqual(['var', 'expr']);
  });
});
