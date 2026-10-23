import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isClientContentGd, isClientDev, isClientTest } from './lib/files.ts';
import type { ClassDecl, Expr, FuncDecl, GdFile } from './lib/gd-ast.ts';
import { fnsOf } from './lib/gd-shared.ts';
import { visitClass, visitStmts } from './lib/gd-walk.ts';
import { strOf } from './lib/tscn.ts';

/**
 * debug text (STG and PROD builds): a non-empty string literal that client content code (outside `client/dev/` and `client/tests/`),
 * a scene or a prefab puts in the text of a UI text element: an assignment to `text`, `set_text()`, `add_text()`,
 * `append_text()`, or a node `text` property in `resource/scene/` and `resource/prefab/`.
 */
export const NAME = 'debug text';

const TEXT_SETTERS = new Set(['set_text', 'add_text', 'append_text']);

/** Non-empty string literals that make up a text value, the receiver of a method call included (not those passed to calls inside it). */
export function textLiterals(e: Expr): Expr[] {
  switch (e.k) {
    case 'str':
      return e.value === '' ? [] : [e];
    case 'call':
      return e.callee.k === 'member' ? textLiterals(e.callee.obj) : [];
    case 'binary':
      return e.op === '+' || e.op === '%' ? [...textLiterals(e.left), ...textLiterals(e.right)] : [];
    case 'ternary':
      return [...textLiterals(e.then), ...textLiterals(e.else)];
    case 'cast':
      return textLiterals(e.expr);
    default:
      return [];
  }
}

/** True when a function has a parameter or local variable of that name. */
function declaresLocal(fn: FuncDecl, name: string): boolean {
  if (fn.params.some((p) => p.name === name)) return true;
  let found = false;
  visitStmts(fn.body, { cls: dummy, fn, method: fn }, {
    stmt(s) {
      if ((s.k === 'var' && s.name === name) || (s.k === 'for' && s.name === name)) found = true;
    },
  });
  return found;
}

const dummy: ClassDecl = { k: 'class', name: null, extendsName: null, extendsPath: null, body: [], isTop: false, outer: null, line: 0, t0: 0, t1: 0 };

export function checkFile(file: GdFile): Finding[] {
  const out: Finding[] = [];
  const report = (value: Expr): void => {
    for (const lit of textLiterals(value)) out.push(finding(NAME, at(file.path, lit.line), 'string literal in UI text'));
  };
  visitClass(file.top, {
    stmt(s, scope) {
      if (s.k !== 'assign' || (s.op !== '=' && s.op !== '+=')) return;
      const bareProperty = s.target.k === 'name' && s.target.name === 'text' && !fnsOf(scope).some((fn) => declaresLocal(fn, 'text'));
      if ((s.target.k === 'member' && s.target.name === 'text') || bareProperty) report(s.value);
    },
    expr(e) {
      if (e.k !== 'call' || !e.args[0]) return;
      const callee = e.callee.k === 'member' || e.callee.k === 'name' ? e.callee.name : null;
      if (callee !== null && TEXT_SETTERS.has(callee)) report(e.args[0]);
    },
  });
  return out;
}

async function sceneFindings(sc: StaticContext, path: string): Promise<Finding[]> {
  const scene = await sc.scene(path);
  const out: Finding[] = [];
  for (const node of scene.nodes) {
    const prop = node.props.get('text');
    const text = strOf(prop?.value);
    if (prop && text !== null && text !== '') out.push(finding(NAME, at(path, prop.line), `string literal in UI text of node \`${node.path}\``));
  }
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const code = sc.filter((p) => isClientContentGd(p) && !isClientDev(p) && !isClientTest(p)).map(async (p) => checkFile(await sc.gd(p)));
  const scenes = sc.filter((p) => /^resource\/(scene|prefab)\/.*\.tscn$/.test(p)).map((p) => sceneFindings(sc, p));
  return (await Promise.all([...code, ...scenes])).flat();
}
