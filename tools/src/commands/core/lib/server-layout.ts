/**
 * The server core folder layout (`server-core` SKILL.md `## folder`): module folders `server/core/<module>/` with the
 * entry file `index.ts` (or `dev/index.ts` for a module that is all DEV code), `adapters/`, `dev/` and `tests/`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { exists } from '../../../lib/fsx.ts';
import { stringText, ts, walkTs } from '../../check/static/lib/ts-source.ts';
import { filesUnder } from '../../../lib/fsx.ts';
import { byteCompare } from '../../../lib/order.ts';

/** The `server-time` files the server core static check exempts. Paths are relative to `server/core/`. */
export const SYSTEM_CLOCK_FILE = 'server-time/adapters/system_clock.ts';
export const TIMER_FILES: readonly string[] = ['server-time/scheduler.ts', 'server-time/network_time_limit.ts'];

/** A path relative to `open-game-works-core-impl/`, or to `server/core/` when it does not start with `server/core/`. */
function belowCore(path: string): string {
  return path.startsWith('server/core/') ? path.slice('server/core/'.length) : path;
}

/** True when a path (below `server/core/`, or starting with `server/core/`) is in a module folder's `tests/`. */
export function isServerCoreTest(path: string): boolean {
  const parts = belowCore(path).split('/');
  return parts.length > 2 && parts[1] === 'tests';
}

/** Which server core files the server core static check exempts (`server-core` `## folder`). */
export interface ServerClockLayout {
  /** The clock adapter `system`: the one file that may read the system clock. */
  isClockAdapter(relPath: string): boolean;
  /** The scheduler and `network_time_limit`: the files that may use timers. */
  isScheduler(relPath: string): boolean;
  /** A core test file below `open-game-works-core-impl/server/core/`; not core code. */
  isTest(relPath: string): boolean;
}

export const SERVER_CLOCK_LAYOUT: ServerClockLayout = {
  isClockAdapter: (path) => belowCore(path) === SYSTEM_CLOCK_FILE,
  isScheduler: (path) => TIMER_FILES.includes(belowCore(path)),
  isTest: isServerCoreTest,
};

/** Module folders of `open-game-works-core-impl/server/core/` that hold an entry file (`index.ts` or `dev/index.ts`). */
export async function serverImplementedModules(implDir: string): Promise<string[]> {
  const core = join(implDir, 'server', 'core');
  if (!exists(core)) return [];
  const entries = await readdir(core, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && (exists(join(core, e.name, 'index.ts')) || exists(join(core, e.name, 'dev', 'index.ts'))))
    .map((e) => e.name)
    .sort(byteCompare);
}


/** Module specifiers of the static imports, re-exports and dynamic imports of a TypeScript file. */
export function importSpecifiers(text: string): string[] {
  const source = ts.createSourceFile('file.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  walkTs(source, (node) => {
    let spec: ts.Expression | undefined;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) spec = node.moduleSpecifier;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) spec = node.arguments[0];
    const value = spec === undefined ? null : stringText(spec);
    if (value !== null) out.push(value);
  });
  return out;
}

/** The path relative to `server/core/` inside a module folder that a relative import of `file` lands on, or null. */
export function importedModuleFile(file: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const target = posix.normalize(posix.join(posix.dirname(file), spec));
  if (target.startsWith('..') || !target.includes('/')) return null;
  return target;
}

/** The module folder a relative import of `file` (relative to `server/core/`) lands in, or null. */
export function importedModule(file: string, spec: string): string | null {
  return importedModuleFile(file, spec)?.split('/')[0] ?? null;
}

/**
 * For each module, the other modules its files import (`server-core` `## folder`): files in `dev/` are DEV code,
 * files in `tests/` are left out.
 */
export async function serverModuleReferences(implDir: string, modules: readonly string[]): Promise<Map<string, { code: string[]; dev: string[] }>> {
  const names = new Set(modules);
  const out = new Map<string, { code: string[]; dev: string[] }>();
  for (const module of modules) {
    const code = new Set<string>();
    const dev = new Set<string>();
    const files = (await filesUnder(implDir, `server/core/${module}`)).sort(byteCompare).filter((f) => /\.(ts|mts|cts)$/.test(f) && !isServerCoreTest(f));
    for (const file of files) {
      const rel = belowCore(file);
      const isDev = rel.split('/')[1] === 'dev';
      for (const spec of importSpecifiers(await readFile(join(implDir, file), 'utf8'))) {
        const target = importedModule(rel, spec);
        if (target !== null && target !== module && names.has(target)) (isDev ? dev : code).add(target);
      }
    }
    out.set(module, { code: [...code].sort(byteCompare), dev: [...dev].sort(byteCompare) });
  }
  return out;
}
