import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isClientContentGd } from './lib/files.ts';
import type { Expr, GdFile } from './lib/gd-ast.ts';
import { callsOf, classIndex, resolverFor } from './lib/gd-shared.ts';
import type { ClassIndex, TypeResolver } from './lib/gd-types.ts';
import { chainText } from './lib/gd-walk.ts';

/**
 * resource load: content code calls `load()`, `preload()`, `ResourceLoader.load()`, `ResourceLoader.load_threaded_request()`,
 * `ResourceLoader.load_threaded_get()`, `Image.load()`, `Image.load_from_file()`.
 */
export const NAME = 'resource load';

const RESOURCE_LOADER = new Set(['load', 'load_threaded_request', 'load_threaded_get']);

async function isImage(recv: Expr, resolver: TypeResolver): Promise<boolean> {
  if (recv.k === 'name' && recv.name === 'Image') return true;
  const t = await resolver.typeOf(recv);
  return t?.name === 'Image';
}

export async function loadCall(call: Extract<Expr, { k: 'call' }>, resolver: TypeResolver): Promise<string | null> {
  const callee = call.callee;
  if (callee.k === 'name') return callee.name === 'load' || callee.name === 'preload' ? `${callee.name}()` : null;
  if (callee.k !== 'member') return null;
  if (chainText(callee.obj) === 'ResourceLoader' && RESOURCE_LOADER.has(callee.name)) return `ResourceLoader.${callee.name}()`;
  if (callee.name === 'load_from_file') return 'Image.load_from_file()';
  if (callee.name === 'load' && (await isImage(callee.obj, resolver))) return 'Image.load()';
  return null;
}

export async function checkFile(file: GdFile, index: ClassIndex): Promise<Finding[]> {
  const out: Finding[] = [];
  const cache = new Map<unknown, TypeResolver>();
  for (const { call, scope } of callsOf(file)) {
    const what = await loadCall(call, resolverFor(index, file, scope, cache));
    if (what) out.push(finding(NAME, at(file.path, call.line), `\`${what}\``));
  }
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const index = await classIndex(sc);
  return (await Promise.all(sc.filter(isClientContentGd).map(async (p) => checkFile(await sc.gd(p), index)))).flat();
}
