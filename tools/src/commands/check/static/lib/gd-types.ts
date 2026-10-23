import type { ClassDecl, Expr, FuncDecl, GdFile, Stmt, TypeRef } from './gd-ast.ts';
import { isRealLiteral } from './gd-lexer.ts';
import { allClasses, childBodies, innerClasses } from './gd-walk.ts';
import type { StaticContext } from './context.ts';
import { isClientGd, repoPath } from './files.ts';

/**
 * A light type model of the game's GDScript: class names, inheritance, member types and
 * the type of an expression where declarations make it known.
 */

export interface GdType {
  /** A type name (`int`, `Array`, `GameData.ItemRow`) or `#class` for a class object (static access). */
  name: string;
  args: GdType[];
}

export interface ClassRef {
  file: GdFile;
  cls: ClassDecl;
  /** `GameData.ItemRow`, or the `res://` path of a script without `class_name`. */
  qname: string;
}

export function typeOfRef(ref: TypeRef): GdType {
  return { name: ref.name, args: ref.args.map(typeOfRef) };
}

export function typeText(t: GdType): string {
  return t.args.length === 0 ? t.name : `${t.name}[${t.args.map(typeText).join(', ')}]`;
}

function simple(name: string): GdType {
  return { name, args: [] };
}

/** PascalCase with a lower-case letter: a class name, not a CONSTANT_CASE constant. */
const ENGINE_CLASS_NAME = /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/;

const BUILTIN_CONSTRUCTOR_TYPES = new Set([
  'int', 'float', 'bool', 'String', 'StringName', 'NodePath', 'Array', 'Dictionary', 'Callable', 'Signal',
  'Vector2', 'Vector2i', 'Vector3', 'Vector3i', 'Vector4', 'Vector4i', 'Rect2', 'Rect2i', 'Transform2D', 'Transform3D',
  'Basis', 'Quaternion', 'Plane', 'AABB', 'Color', 'Projection', 'RID',
  'PackedByteArray', 'PackedInt32Array', 'PackedInt64Array', 'PackedFloat32Array', 'PackedFloat64Array',
  'PackedStringArray', 'PackedVector2Array', 'PackedVector3Array', 'PackedVector4Array', 'PackedColorArray',
]);

const PACKED_ELEMENT: Record<string, string> = {
  PackedByteArray: 'int', PackedInt32Array: 'int', PackedInt64Array: 'int', PackedFloat32Array: 'float', PackedFloat64Array: 'float',
  PackedStringArray: 'String', PackedVector2Array: 'Vector2', PackedVector3Array: 'Vector3', PackedVector4Array: 'Vector4', PackedColorArray: 'Color',
};

const GLOBAL_RETURNS: Record<string, string> = {
  len: 'int', str: 'String', absi: 'int', clampi: 'int', maxi: 'int', mini: 'int', signi: 'int', absf: 'float', clampf: 'float',
  maxf: 'float', minf: 'float', snappedf: 'float', snappedi: 'int', is_instance_valid: 'bool', typeof: 'int', hash: 'int',
};

const ARRAY_SAME = new Set(['duplicate', 'slice', 'filter']);
const ARRAY_ELEMENT = new Set(['front', 'back', 'pop_back', 'pop_front', 'pop_at', 'pick_random', 'max', 'min', 'get']);
const INT_METHODS = new Set(['size', 'find', 'rfind', 'count', 'bsearch', 'length', 'hash']);
const BOOL_METHODS = new Set(['is_empty', 'has', 'has_all', 'is_read_only', 'is_typed', 'begins_with', 'ends_with', 'contains']);

/** Class names, files and inheritance of every client `.gd` file. */
export class ClassIndex {
  private readonly sc: StaticContext;
  private readonly names = new Map<string, string>();

  private constructor(sc: StaticContext) {
    this.sc = sc;
  }

  static async build(sc: StaticContext): Promise<ClassIndex> {
    const index = new ClassIndex(sc);
    await Promise.all(
      sc.filter(isClientGd).map(async (path) => {
        // the parsed `class_name`: it may follow annotations on its line (`@abstract class_name X extends Node`)
        const name = (await sc.gd(path)).top.name;
        if (name !== null) index.names.set(name, path);
      }),
    );
    return index;
  }

  /** Path of the file that declares the class name. */
  pathOf(name: string): string | null {
    return this.names.get(name) ?? null;
  }

  classNames(): string[] {
    return [...this.names.keys()];
  }

  async byPath(path: string): Promise<ClassRef | null> {
    if (!this.sc.has(path) || !path.endsWith('.gd')) return null;
    const file = await this.sc.gd(path);
    return { file, cls: file.top, qname: file.top.name ?? `res://${path.replace(/^client\//, '')}` };
  }

  /** A dotted class name: a global class, optionally followed by inner class names. */
  async byName(qname: string): Promise<ClassRef | null> {
    const parts = qname.split('.');
    const path = this.pathOf(parts[0] as string);
    if (path === null) return null;
    const top = await this.byPath(path);
    if (!top) return null;
    let cls = top.cls;
    for (const part of parts.slice(1)) {
      const inner = innerClasses(cls).find((c) => c.name === part);
      if (!inner) return null;
      cls = inner;
    }
    return { file: top.file, cls, qname };
  }

  /** Resolves a type name as written in `from`: inner classes of the enclosing classes first. */
  async resolve(name: string, from: ClassRef): Promise<ClassRef | null> {
    const first = name.split('.')[0] as string;
    for (let c: ClassDecl | null = from.cls; c; c = c.outer) {
      const inner = innerClasses(c).find((x) => x.name === first);
      if (inner) {
        let cls: ClassDecl = inner;
        for (const part of name.split('.').slice(1)) {
          const next = innerClasses(cls).find((x) => x.name === part);
          if (!next) return null;
          cls = next;
        }
        return { file: from.file, cls, qname: qualify(from.file, cls) };
      }
    }
    return this.byName(name);
  }

  async superOf(ref: ClassRef): Promise<ClassRef | null> {
    if (ref.cls.extendsPath !== null) {
      const path = repoPath(ref.cls.extendsPath);
      return path === null ? null : this.byPath(path);
    }
    if (ref.cls.extendsName === null) return null;
    return this.resolve(ref.cls.extendsName, { ...ref, cls: ref.cls.outer ?? ref.cls });
  }

  /** The class and its ancestors that the index knows, nearest first. */
  async lineage(ref: ClassRef): Promise<ClassRef[]> {
    const out: ClassRef[] = [];
    const seen = new Set<string>();
    for (let c: ClassRef | null = ref; c && !seen.has(`${c.file.path}#${c.qname}`); c = await this.superOf(c)) {
      seen.add(`${c.file.path}#${c.qname}`);
      out.push(c);
    }
    return out;
  }

  /** True when the class is `base` or inherits from it (by class name, engine classes included by name). */
  async isA(ref: ClassRef, base: string): Promise<boolean> {
    for (const c of await this.lineage(ref)) {
      if (c.qname === base) return true;
      if (c.cls.extendsName === base) return true;
    }
    return false;
  }

  /** A member declared in the class or an ancestor. */
  async member(ref: ClassRef, name: string): Promise<{ owner: ClassRef; decl: Stmt } | null> {
    for (const c of await this.lineage(ref)) {
      const decl = c.cls.body.find((s) => (s.k === 'var' || s.k === 'func' || s.k === 'class' || s.k === 'enum' || s.k === 'signal') && 'name' in s && s.name === name);
      if (decl) return { owner: c, decl };
    }
    return null;
  }
}

/** Qualified name of a class in a file: the top class name followed by inner class names. */
export function qualify(file: GdFile, cls: ClassDecl): string {
  const names: string[] = [];
  for (let c: ClassDecl | null = cls; c; c = c.outer) {
    names.unshift(c.isTop ? (c.name ?? `res://${file.path.replace(/^client\//, '')}`) : (c.name ?? ''));
  }
  return names.join('.');
}

interface Local {
  type: TypeRef | null;
  value: Expr | null;
  /** For a `for` variable: the iterated expression. */
  iter: Expr | null;
}

function collectLocals(stmts: readonly Stmt[], out: Map<string, Local>): void {
  for (const s of stmts) {
    if (s.k === 'var') out.set(s.name, { type: s.type, value: s.value, iter: null });
    if (s.k === 'for') out.set(s.name, { type: s.varType, value: null, iter: s.iter });
    for (const body of childBodies(s)) collectLocals(body, out);
  }
}

/** Where an expression is evaluated: its file, class, and the functions around it. */
export interface Env {
  file: GdFile;
  cls: ClassDecl;
  /** Functions around the expression, outermost first (a method, then lambdas). */
  fns: FuncDecl[];
}

/** Types of expressions in one environment. */
export class TypeResolver {
  readonly index: ClassIndex;
  private readonly env: Env;
  private readonly locals = new Map<string, Local>();
  private readonly params = new Map<string, TypeRef | null>();
  private readonly busy = new Set<string>();
  readonly self: ClassRef;

  constructor(index: ClassIndex, env: Env) {
    this.index = index;
    this.env = env;
    for (const fn of env.fns) {
      for (const p of fn.params) this.params.set(p.name, p.type);
      collectLocals(fn.body, this.locals);
    }
    this.self = { file: env.file, cls: env.cls, qname: qualify(env.file, env.cls) };
  }

  /** True when `name` is a parameter or local variable here. */
  isLocal(name: string): boolean {
    return this.params.has(name) || this.locals.has(name);
  }

  async typeOf(e: Expr): Promise<GdType | null> {
    switch (e.k) {
      case 'num':
        return simple(isRealLiteral(e.text) ? 'float' : 'int');
      case 'str':
        return simple(e.kind === 'stringname' ? 'StringName' : e.kind === 'nodepath' ? 'NodePath' : 'String');
      case 'array':
        return simple('Array');
      case 'dict':
        return simple('Dictionary');
      case 'cast':
        return this.canonical(typeOfRef(e.type));
      case 'name':
        return this.nameType(e.name);
      case 'member':
        return this.memberType(e.obj, e.name);
      case 'call':
        return this.callType(e);
      default:
        return this.compositeType(e);
    }
  }

  private async compositeType(e: Expr): Promise<GdType | null> {
    switch (e.k) {
      case 'index':
        return this.indexType(e.obj);
      case 'ternary':
        return this.typeOf(e.then);
      case 'binary':
        return this.binaryType(e.op, e.left, e.right);
      case 'unary':
        return e.op === 'not' ? simple('bool') : this.typeOf(e.expr);
      case 'is':
        return simple('bool');
      default:
        return null;
    }
  }

  /** A written type made canonical: class names become their qualified name. */
  async canonical(t: GdType): Promise<GdType> {
    if (BUILTIN_CONSTRUCTOR_TYPES.has(t.name) || PACKED_ELEMENT[t.name]) {
      return { name: t.name, args: await Promise.all(t.args.map((a) => this.canonical(a))) };
    }
    const ref = await this.index.resolve(t.name, this.self);
    return ref ? { name: ref.qname, args: [] } : t;
  }

  /** The class of a class type, or null for built-in and unknown types. */
  async classOf(t: GdType | null): Promise<ClassRef | null> {
    if (!t) return null;
    const name = t.name === '#class' ? (t.args[0]?.name ?? '') : t.name;
    return this.index.resolve(name, this.self);
  }

  private async localType(name: string): Promise<GdType | null> {
    if (this.params.has(name)) {
      const p = this.params.get(name);
      return p ? this.canonical(typeOfRef(p)) : null;
    }
    const local = this.locals.get(name);
    if (!local) return null;
    if (local.type) return this.canonical(typeOfRef(local.type));
    if (this.busy.has(name)) return null;
    this.busy.add(name);
    try {
      if (local.value) return await this.typeOf(local.value);
      if (local.iter) return await this.elementType(local.iter);
      return null;
    } finally {
      this.busy.delete(name);
    }
  }

  private async nameType(name: string): Promise<GdType | null> {
    if (name === 'self') return simple(this.self.qname);
    if (name === 'true' || name === 'false') return simple('bool');
    if (this.isLocal(name)) return this.localType(name);
    const member = await this.index.member(this.self, name);
    if (member) return this.declType(member.owner, member.decl);
    if (BUILTIN_CONSTRUCTOR_TYPES.has(name)) return { name: '#class', args: [simple(name)] };
    const ref = await this.index.resolve(name, this.self);
    if (ref) return { name: '#class', args: [simple(ref.qname)] };
    // An unresolved global PascalCase name is an engine class (`Image`, `Timer`): `X.new()` is an `X`.
    if (ENGINE_CLASS_NAME.test(name)) return { name: '#class', args: [simple(name)] };
    return null;
  }

  /** Type of a declared member. */
  async declType(owner: ClassRef, decl: Stmt): Promise<GdType | null> {
    if (decl.k === 'class') return { name: '#class', args: [simple(qualify(owner.file, decl))] };
    if (decl.k !== 'var') return null;
    const sub = new TypeResolver(this.index, { file: owner.file, cls: owner.cls, fns: [] });
    if (decl.type) return sub.canonical(typeOfRef(decl.type));
    return decl.value ? sub.typeOf(decl.value) : null;
  }

  private async memberType(obj: Expr, name: string): Promise<GdType | null> {
    const objType = await this.typeOf(obj);
    const ref = await this.classOf(objType);
    if (!ref) return null;
    const member = await this.index.member(ref, name);
    return member ? this.declType(member.owner, member.decl) : null;
  }

  /** Element type when iterating or indexing a value of type `t`. */
  elementOf(t: GdType | null): GdType | null {
    if (!t) return null;
    if (t.name === 'Array' || t.name === 'Dictionary') return t.args[t.args.length - 1] ?? null;
    const packed = PACKED_ELEMENT[t.name];
    if (packed) return simple(packed);
    if (t.name === 'String') return simple('String');
    if (t.name === 'int') return simple('int');
    return null;
  }

  async elementType(iter: Expr): Promise<GdType | null> {
    return this.elementOf(await this.typeOf(iter));
  }

  private async indexType(obj: Expr): Promise<GdType | null> {
    return this.elementOf(await this.typeOf(obj));
  }

  private async binaryType(op: string, left: Expr, right: Expr): Promise<GdType | null> {
    if (['==', '!=', '<', '>', '<=', '>=', 'and', 'or', '&&', '||', 'in', 'not in'].includes(op)) return simple('bool');
    const l = await this.typeOf(left);
    const r = await this.typeOf(right);
    if (l?.name === 'float' || r?.name === 'float') return simple('float');
    if (op === '%' && l?.name === 'String') return simple('String');
    return l ?? r;
  }

  private async callType(call: Extract<Expr, { k: 'call' }>): Promise<GdType | null> {
    if (call.callee.k === 'name') return this.bareCallType(call.callee.name);
    if (call.callee.k !== 'member') return null;
    const name = call.callee.name;
    const recv = await this.typeOf(call.callee.obj);
    if (!recv) return null;
    if (recv.name === '#class') {
      const target = recv.args[0]?.name ?? '';
      if (name === 'new') return BUILTIN_CONSTRUCTOR_TYPES.has(target) ? simple(target) : this.canonical(simple(target));
      return this.methodReturn(await this.index.resolve(target, this.self), name);
    }
    const builtin = this.builtinMethodType(recv, name);
    if (builtin !== undefined) return builtin;
    return this.methodReturn(await this.classOf(recv), name);
  }

  private builtinMethodType(recv: GdType, name: string): GdType | null | undefined {
    const isList = recv.name === 'Array' || recv.name === 'Dictionary' || PACKED_ELEMENT[recv.name] !== undefined || recv.name === 'String';
    if (!isList) return undefined;
    if (ARRAY_SAME.has(name)) return recv;
    if (ARRAY_ELEMENT.has(name)) return this.elementOf(recv);
    if (INT_METHODS.has(name)) return simple('int');
    if (BOOL_METHODS.has(name)) return simple('bool');
    if (recv.name === 'Dictionary' && name === 'keys') return { name: 'Array', args: recv.args.slice(0, 1) };
    if (recv.name === 'Dictionary' && name === 'values') return { name: 'Array', args: recv.args.slice(1, 2) };
    return null;
  }

  private async bareCallType(name: string): Promise<GdType | null> {
    if (BUILTIN_CONSTRUCTOR_TYPES.has(name)) return simple(name);
    const global = GLOBAL_RETURNS[name];
    if (global) return simple(global);
    if (name === 'range') return { name: 'Array', args: [simple('int')] };
    return this.methodReturn(this.self, name);
  }

  private async methodReturn(ref: ClassRef | null, name: string): Promise<GdType | null> {
    if (!ref) return null;
    const member = await this.index.member(ref, name);
    if (member?.decl.k !== 'func' || !member.decl.returnType) return null;
    const sub = new TypeResolver(this.index, { file: member.owner.file, cls: member.owner.cls, fns: [] });
    return sub.canonical(typeOfRef(member.decl.returnType));
  }
}

/** All classes of a file with their qualified names. */
export function classRefs(file: GdFile): ClassRef[] {
  return allClasses(file.top).map((cls) => ({ file, cls, qname: qualify(file, cls) }));
}

