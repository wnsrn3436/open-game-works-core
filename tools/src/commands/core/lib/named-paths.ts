/**
 * The core files that the harness names by path for use by other modules: the server ones that `server-core` SKILL.md
 * and the server module specs name, and the client ones that the engine implementation rules
 * (`skills/client-core/engines/<engine>.md`) name.
 */
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { exists } from '../../../lib/fsx.ts';

const NAMED_SERVER_PATH = /`(?:server\/core\/)?([a-z0-9-]+\/[A-Za-z0-9_./-]+\.ts)`/g;
const NAMED_CLIENT_PATH = /`(?:res:\/\/|client\/[a-z0-9_]+\/)?(core\/[a-z0-9_]+\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`/g;

async function markdownFiles(dir: string): Promise<string[]> {
  return exists(dir) ? (await readdir(dir)).filter((f) => f.endsWith('.md')).map((f) => join(dir, f)) : [];
}

async function matches(files: readonly string[], pattern: RegExp): Promise<Set<string>> {
  const named = new Set<string>();
  for (const file of files) for (const match of (await readFile(file, 'utf8')).matchAll(pattern)) if (match[1] !== undefined) named.add(match[1]);
  return named;
}

/** The prefix of a named server path that is relative to a module folder: the path names that file of each module. */
export const ANY_MODULE = '*/';

/**
 * The paths that `server-core` SKILL.md and the module specs name, relative to `server/core/`: `<module>/<path>.ts`, or
 * `*\/<path>.ts` (`ANY_MODULE`) for a path whose first folder is not a module (it names that file of each module, as
 * `dev/adapters/fake.ts`). A module's entry files `index.ts` and `dev/index.ts` are not named paths, and neither are the
 * game repo paths (`server/main.ts`).
 */
export async function namedServerPaths(harness: string): Promise<Set<string>> {
  const skill = join(harness, 'skills', 'server-core');
  const specs = await markdownFiles(join(skill, 'modules'));
  const modules = new Set(specs.map((file) => basename(file, '.md')));
  const out = new Set<string>();
  for (const path of await matches([join(skill, 'SKILL.md'), ...specs], NAMED_SERVER_PATH)) {
    const first = path.split('/')[0] ?? '';
    if (modules.has(first)) out.add(path);
    else if (first !== 'server' && path !== 'dev/index.ts') out.add(`${ANY_MODULE}${path}`);
  }
  return out;
}

/** Whether `file` (relative to `server/core/`, `<module>/<path>`) is a path of `named` (`namedServerPaths`). */
export function isNamedServerPath(named: ReadonlySet<string>, file: string): boolean {
  const slash = file.indexOf('/');
  return named.has(file) || (slash > 0 && named.has(`${ANY_MODULE}${file.slice(slash + 1)}`));
}

/** For each engine with implementation rules, the `core/<folder>/<path>` paths the rules name, relative to `client/<engine>/`. */
export async function namedClientPaths(harness: string): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const file of await markdownFiles(join(harness, 'skills', 'client-core', 'engines'))) {
    out.set(basename(file, '.md'), await matches([file], NAMED_CLIENT_PATH));
  }
  return out;
}

/**
 * The checkout relative paths of `open-game-works-core-impl/` that the harness names for use by other modules. A server path
 * relative to a module folder is `server/core/*\/<path>` (`isNamedCorePath`).
 */
export async function namedCorePaths(harness: string): Promise<Set<string>> {
  const out = new Set([...(await namedServerPaths(harness))].map((path) => `server/core/${path}`));
  for (const [engine, paths] of await namedClientPaths(harness)) for (const path of paths) out.add(`client/${engine}/${path}`);
  return out;
}

/** Whether `path` (checkout relative) is a path of `named` (`namedCorePaths`). */
export function isNamedCorePath(named: ReadonlySet<string>, path: string): boolean {
  const server = /^server\/core\/[^/]+\/(.+)$/.exec(path);
  return named.has(path) || (server !== null && named.has(`server/core/${ANY_MODULE}${server[1] as string}`));
}
