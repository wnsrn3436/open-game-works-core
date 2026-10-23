/**
 * `godot` `## resource loading` and `## DEV code` reference rules for core code.
 *
 * - resource loading: engine load functions only in `ResourceCore`, except a `preload()` constant of a `.gd` in the
 *   same module folder and the two DEV `load()` calls by path constant; `PackedScene.instantiate()` only in the
 *   modules `## resource loading` names; no file other than `.gd` and `.uid` in `core/` outside core tests.
 * - DEV reference: core code outside DEV code and core tests does not name a `dev/` class or path, except the DEV
 *   entry path constant in `BootstrapCore` and `CoreBuildInfo`.
 */
import { at, finding, type Finding } from '../../check/static/lib/context.ts';
import type { Expr, GdFile, VarDecl } from '../../check/static/lib/gd-ast.ts';
import { callsOf, resolverFor } from '../../check/static/lib/gd-shared.ts';
import type { ClassIndex, TypeResolver } from '../../check/static/lib/gd-types.ts';
import { visitClass } from '../../check/static/lib/gd-walk.ts';
import { loadCall } from '../../check/static/resource-load.ts';
import { isDevPath, isTestPath, moduleFolderOf } from './core-static-context.ts';
import { moduleFolder } from './impl.ts';

export const LOAD = 'resource loading';
export const DEV = 'DEV reference';

export const DEV_ENTRY = 'res://core/bootstrap_core/dev/bootstrap_core_dev.gd';
export const DEV_REGISTRATION = 'res://dev/generated/dev_registration.gd';
const DEV_ENTRY_FILE = 'client/core/bootstrap_core/dev/bootstrap_core_dev.gd';
const BOOTSTRAP = moduleFolder('BootstrapCore');
const RESOURCE_CORE = moduleFolder('ResourceCore');
const INSTANTIATE_MODULES = new Set(
  ['ResourceCore', 'PoolCore', 'SceneCore', 'UICore', 'MessageCore', 'BadgeCore', 'CutsceneCore', 'TutorialCore', 'VirtualPadCore'].map(moduleFolder),
);
/** The only files `core/` holds outside core tests (`godot` `## resource loading`): scripts and their `.uid`. */
const CORE_FILE_EXTENSIONS = ['.gd', '.uid'];
/** DEV classes of `godot` `### generated code` (`res://dev/generated/`). */
const GENERATED_DEV_CLASSES = ['CoreCheatContract', 'GameCheatContract', 'ContractJsonDev', 'GameDataDev'];

type Call = Extract<Expr, { k: 'call' }>;

/** `const` declarations of a file, class level and local. */
function constDecls(file: GdFile): VarDecl[] {
  const out: VarDecl[] = [];
  visitClass(file.top, {
    stmt(s) {
      if (s.k === 'var' && s.isConst) out.push(s);
    },
  });
  return out;
}

function stringConst(decl: unknown): string | null {
  const d = decl as VarDecl | undefined;
  return d?.k === 'var' && d.isConst && d.value?.k === 'str' ? d.value.value : null;
}

/** The string value of a constant an expression names (`NAME` declared in the file, or `Class.NAME`), or null. */
async function constString(file: GdFile, arg: Expr | undefined, resolver: TypeResolver): Promise<string | null> {
  if (arg?.k === 'name') return stringConst(constDecls(file).find((d) => d.name === arg.name));
  if (arg?.k !== 'member') return null;
  const ref = await resolver.classOf(await resolver.typeOf(arg.obj));
  return ref ? stringConst((await resolver.index.member(ref, arg.name))?.decl) : null;
}

function isBootstrapCode(path: string): boolean {
  return moduleFolderOf(path) === BOOTSTRAP && !isDevPath(path);
}

/** The two `load()` calls by path constant of `## DEV code`. */
async function isDevLoad(file: GdFile, call: Call, resolver: TypeResolver): Promise<boolean> {
  if (call.callee.k !== 'name' || call.callee.name !== 'load') return false;
  const path = await constString(file, call.args[0], resolver);
  if (isBootstrapCode(file.path)) return path === DEV_ENTRY;
  return file.path === DEV_ENTRY_FILE && path === DEV_REGISTRATION;
}

/** A `preload()` constant of a `.gd` in the file's own module folder. */
function isOwnPreloadConstant(file: GdFile, call: Call, constValues: ReadonlySet<Expr>): boolean {
  const folder = moduleFolderOf(file.path);
  const arg = call.args[0];
  if (folder === null || call.callee.k !== 'name' || call.callee.name !== 'preload' || arg?.k !== 'str') return false;
  return constValues.has(call) && arg.value.startsWith(`res://core/${folder}/`) && arg.value.endsWith('.gd');
}

async function instantiateProblem(call: Call, resolver: TypeResolver): Promise<string | null> {
  if (call.callee.k !== 'member' || call.callee.name !== 'instantiate') return null;
  const type = await resolver.typeOf(call.callee.obj);
  if (type !== null && type.name !== 'PackedScene') return null;
  return '`PackedScene.instantiate()` outside the modules `## resource loading` lets call it';
}

/** Resource loading findings of one core `.gd` file. */
export async function loadFindings(file: GdFile, index: ClassIndex): Promise<Finding[]> {
  const folder = moduleFolderOf(file.path);
  if (folder === RESOURCE_CORE) return [];
  const constValues = new Set<Expr>(constDecls(file).flatMap((d) => (d.value ? [d.value] : [])));
  const cache = new Map<unknown, TypeResolver>();
  const out: Finding[] = [];
  for (const { call, scope } of callsOf(file)) {
    const resolver = resolverFor(index, file, scope, cache);
    const load = await loadCall(call, resolver);
    if (load && !isOwnPreloadConstant(file, call, constValues) && !(await isDevLoad(file, call, resolver))) {
      out.push(finding(LOAD, at(file.path, call.line), `\`${load}\` outside ResourceCore`));
    }
    const instantiate = folder !== null && INSTANTIATE_MODULES.has(folder) ? null : await instantiateProblem(call, resolver);
    if (instantiate) out.push(finding(LOAD, at(file.path, call.line), instantiate));
  }
  return out;
}

/** The files of the Web export that client core ships in `core/` (`client-core` Godot `## folder`). */
const CORE_WEB_FILES = ['client/core/web/ogw-shell.html', 'client/core/web/service-worker.js'];

/**
 * Files in `core/` outside core tests that are not `.gd` or `.uid`, but for the Web export files (`files` are project
 * files in the `client/<path>` form).
 */
export function resourceFileFindings(files: readonly string[]): Finding[] {
  return files
    .filter((f) => f.startsWith('client/core/') && !isTestPath(f) && !CORE_FILE_EXTENSIONS.some((ext) => f.endsWith(ext)) && !CORE_WEB_FILES.includes(f))
    .map((f) => finding(LOAD, at(f, 1), 'file other than `.gd` and `.uid` in core code; core makes its screen elements with code'));
}

/** DEV class names: `class_name`s declared in DEV code and the generated DEV classes. */
export function devClassNames(index: ClassIndex): Set<string> {
  const names = index.classNames().filter((name) => isDevPath(index.pathOf(name) ?? ''));
  return new Set([...names, ...GENERATED_DEV_CLASSES]);
}

function isDevPathString(value: string): boolean {
  return value.includes('res://dev/') || /res:\/\/core\/[^/]+\/dev\//.test(value);
}

/** Token indexes of the DEV entry path constant where `## DEV code` allows it. */
function allowedDevEntryTokens(file: GdFile): Set<number> {
  if (!isBootstrapCode(file.path) && file.path !== 'client/core/core_build_info.gd') return new Set();
  return new Set(constDecls(file).flatMap((d) => (d.value?.k === 'str' && d.value.value === DEV_ENTRY ? [d.value.t0] : [])));
}

/** DEV reference findings of one core `.gd` file. */
export function devReferenceFindings(file: GdFile, devClasses: ReadonlySet<string>): Finding[] {
  if (isDevPath(file.path) || isTestPath(file.path)) return [];
  const allowed = allowedDevEntryTokens(file);
  const out: Finding[] = [];
  for (const t of file.tokens) {
    if (t.type === 'name' && devClasses.has(t.text)) out.push(finding(DEV, at(file.path, t.line), `uses DEV class \`${t.text}\``));
    if (t.type === 'str' && isDevPathString(t.value) && !allowed.has(t.index)) out.push(finding(DEV, at(file.path, t.line), 'uses a `dev/` path'));
  }
  return out;
}
