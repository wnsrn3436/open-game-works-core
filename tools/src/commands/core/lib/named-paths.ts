/** The server core files that `server-core` SKILL.md and the server module specs name by path for use by other modules. */
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { exists } from '../../../lib/fsx.ts';

const NAMED_SERVER_PATH = /`(?:server\/core\/)?([a-z0-9-]+\/[A-Za-z0-9_./-]+\.ts)`/g;

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
