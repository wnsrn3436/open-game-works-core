import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { featureOf, isClientContentGd } from './lib/files.ts';
import type { Expr, GdFile } from './lib/gd-ast.ts';
import { isRealLiteral } from './lib/gd-lexer.ts';
import { callsOf, classIndex, resolverFor } from './lib/gd-shared.ts';
import type { ClassIndex, ClassRef, GdType, TypeResolver } from './lib/gd-types.ts';
import { allClasses, chainText } from './lib/gd-walk.ts';

/**
 * determinism: a `.gd` in `client/features/*\/sim/` or `client/common/sim/` breaks the Godot `## deterministic simulation`
 * rules: a class of the file (inner classes included) not `extends RefCounted`, a real type or real literal, `/`, `%`, `/=`, `%=`, or a call outside the allowed list.
 */
export const NAME = 'determinism';

const REAL_TYPES = new Set([
  'float', 'Vector2', 'Vector3', 'Vector4', 'Rect2', 'Transform2D', 'Transform3D', 'Basis', 'Quaternion', 'Plane', 'AABB', 'Color',
  'PackedFloat32Array', 'PackedFloat64Array', 'PackedVector2Array', 'PackedVector3Array', 'PackedVector4Array', 'PackedColorArray',
]);
const DIVISION = new Set(['/', '%', '/=', '%=']);
const UTIL_ALLOWED = new Set(['floor_div', 'floor_mod', 'clamp_int', 'apply_permille', 'create_random', 'make_purpose_seed', 'next_uint32', 'range_int', 'shuffle_indices', 'pick_weighted']);
const GLOBAL_ALLOWED = new Set(['absi', 'clampi', 'maxi', 'mini', 'signi', 'range', 'len']);
const VALUE_TYPES = new Set(['int', 'bool', 'String', 'StringName', 'Array', 'Dictionary', 'PackedByteArray', 'PackedInt32Array', 'PackedInt64Array']);
/** Methods of the value types that return a real number. */
const REAL_RETURNING: Record<string, Set<string>> = {
  String: new Set(['to_float', 'similarity']),
  StringName: new Set(['to_float', 'similarity']),
  PackedByteArray: new Set(['decode_float', 'decode_double', 'decode_half', 'to_float32_array', 'to_float64_array']),
};

export function isSimFile(path: string): boolean {
  return /^client\/(features\/[^/]+|common)\/sim\//.test(path) && path.endsWith('.gd');
}

/** Sim folders a sim file may call: its own feature's `sim/` and `client/common/sim/`. */
function simPrefixes(path: string): string[] {
  const feature = featureOf(path);
  return feature === null ? ['client/common/sim/'] : [`client/features/${feature}/sim/`, 'client/common/sim/'];
}

function isGeneratedContractOrData(path: string): boolean {
  return path.startsWith('client/generated/contract/') || path.startsWith('client/generated/data/');
}

/** A receiver whose type is not known: an engine class name, or a value to give a declared type. */
function unknownReceiver(recv: Expr, label: string, resolver: TypeResolver): string {
  const engineClass = recv.k === 'name' && /^[A-Z]/.test(recv.name) && !resolver.isLocal(recv.name);
  return engineClass ? `call of ${label}` : `call of ${label} whose receiver type is not known; declare the receiver type`;
}

class CallJudge {
  private readonly file: GdFile;
  private readonly prefixes: string[];

  constructor(file: GdFile) {
    this.file = file;
    this.prefixes = simPrefixes(file.path);
  }

  private allowedClass(ref: ClassRef | null): boolean {
    if (!ref) return false;
    const path = ref.file.path;
    return path === this.file.path || this.prefixes.some((p) => path.startsWith(p)) || isGeneratedContractOrData(path);
  }

  private valueTypeCall(typeName: string, method: string): boolean {
    return VALUE_TYPES.has(typeName) && !(REAL_RETURNING[typeName]?.has(method) ?? false);
  }

  async judge(call: Extract<Expr, { k: 'call' }>, resolver: TypeResolver): Promise<string | null> {
    const callee = call.callee;
    if (callee.k === 'name') return this.bare(callee.name, resolver);
    if (callee.k !== 'member') return 'call of a computed function';
    return this.member(callee.obj, callee.name, resolver);
  }

  private async bare(name: string, resolver: TypeResolver): Promise<string | null> {
    if (name === 'super' || GLOBAL_ALLOWED.has(name) || VALUE_TYPES.has(name)) return null;
    return this.classCall(resolver.self, name, name, resolver);
  }

  /** A call of the method `name` that `owner` declares or inherits: allowed when an allowed class declares it. */
  private async classCall(owner: ClassRef | null, name: string, label: string, resolver: TypeResolver): Promise<string | null> {
    const member = owner === null ? null : await resolver.index.member(owner, name);
    if (member?.decl.k === 'func' && this.allowedClass(member.owner)) return null;
    return `call of \`${label}()\``;
  }

  private async member(recv: Expr, name: string, resolver: TypeResolver): Promise<string | null> {
    if (recv.k === 'name' && recv.name === 'self') return this.classCall(resolver.self, name, `self.${name}`, resolver);
    if (recv.k === 'name' && recv.name === 'super') return this.classCall(await resolver.index.superOf(resolver.self), name, `super.${name}`, resolver);
    const root = chainText(recv);
    if (root === 'UtilCore') return UTIL_ALLOWED.has(name) ? null : `call of \`UtilCore.${name}()\``;
    if (root === 'DataCore') return null;
    const t = await resolver.typeOf(recv);
    const label = `\`${root ?? 'value'}.${name}()\``;
    if (!t) return unknownReceiver(recv, label, resolver);
    const ok = t.name === '#class' ? await this.staticAllowed(t.args[0]?.name ?? '', name, resolver) : await this.instanceAllowed(t, name, resolver);
    return ok ? null : `call of ${label}`;
  }

  private async staticAllowed(target: string, name: string, resolver: TypeResolver): Promise<boolean> {
    if (VALUE_TYPES.has(target)) return this.valueTypeCall(target, name);
    return this.allowedClass(await resolver.index.resolve(target, resolver.self));
  }

  private async instanceAllowed(t: GdType, name: string, resolver: TypeResolver): Promise<boolean> {
    if (VALUE_TYPES.has(t.name)) return this.valueTypeCall(t.name, name);
    return this.allowedClass(await resolver.classOf(t));
  }
}

/** Classes of the file that do not extend RefCounted; an inner class without `extends` is a RefCounted. */
function classFindings(file: GdFile): Finding[] {
  const out: Finding[] = [];
  const extendsLine = file.top.body.find((s) => s.k === 'extends')?.line ?? 1;
  if (file.top.extendsName !== 'RefCounted' || file.top.extendsPath !== null) out.push(finding(NAME, at(file.path, extendsLine), 'class does not `extends RefCounted`'));
  for (const inner of allClasses(file.top).slice(1)) {
    const refCounted = (inner.extendsName === null || inner.extendsName === 'RefCounted') && inner.extendsPath === null;
    if (!refCounted) out.push(finding(NAME, at(file.path, inner.line), `class \`${inner.name ?? ''}\` does not \`extends RefCounted\``));
  }
  return out;
}

export async function checkFile(file: GdFile, index: ClassIndex): Promise<Finding[]> {
  const out: Finding[] = classFindings(file);
  for (const t of file.tokens) {
    if (t.type === 'name' && REAL_TYPES.has(t.text)) out.push(finding(NAME, at(file.path, t.line), `real type \`${t.text}\``));
    if (t.type === 'num' && isRealLiteral(t.text)) out.push(finding(NAME, at(file.path, t.line), `real literal \`${t.text}\``));
    if (t.type === 'op' && DIVISION.has(t.text)) out.push(finding(NAME, at(file.path, t.line), `operator \`${t.text}\`; use \`UtilCore.floor_div\` or \`UtilCore.floor_mod\``));
  }
  const judge = new CallJudge(file);
  const cache = new Map<unknown, TypeResolver>();
  for (const { call, scope } of callsOf(file)) {
    const why = await judge.judge(call, resolverFor(index, file, scope, cache));
    if (why) out.push(finding(NAME, at(file.path, call.line), why));
  }
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const index = await classIndex(sc);
  return (await Promise.all(sc.filter((p) => isClientContentGd(p) && isSimFile(p)).map(async (p) => checkFile(await sc.gd(p), index)))).flat();
}
