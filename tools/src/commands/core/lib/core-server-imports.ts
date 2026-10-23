/**
 * Server core static check of imports between module folders (`server-core` SKILL.md `## folder`): a file outside
 * `tests/` imports from another module folder only that module's entry file (`index.ts`, and `dev/index.ts` from a
 * `dev/` file) and the files whose path the `server-core` skill or a module spec names. `testing` and the files
 * directly under `server/core/` are not checked.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { filesUnder } from '../../../lib/fsx.ts';
import { isNamedServerPath, namedServerPaths } from './named-paths.ts';
import { importSpecifiers, importedModuleFile, isServerCoreTest } from './server-layout.ts';

/** Findings `server/core/<file>: internal import: ...` of one file (relative to `server/core/`). */
export function internalImportFindings(file: string, text: string, named: ReadonlySet<string>): string[] {
  if (!file.includes('/')) return [];
  const module = file.split('/')[0] ?? '';
  if (module === 'testing' || isServerCoreTest(file)) return [];
  const inDev = file.split('/')[1] === 'dev';
  const out: string[] = [];
  for (const spec of importSpecifiers(text)) {
    const target = importedModuleFile(file, spec);
    if (target === null) continue;
    const other = target.split('/')[0] ?? '';
    if (other === module) continue;
    const allowed = target === `${other}/index.ts` || (inDev && target === `${other}/dev/index.ts`) || isNamedServerPath(named, target);
    if (!allowed) out.push(`server/core/${file}: internal import: \`${target}\` is an internal file of \`${other}\`; import its entry file or a file the spec names`);
  }
  return out;
}

/** The check over `open-game-works-core-impl/server/core/`. */
export async function serverInternalImports(implDir: string, harness: string): Promise<string[]> {
  const named = await namedServerPaths(harness);
  const files = (await filesUnder(implDir, 'server/core')).filter((f) => /\.(ts|mts|cts)$/.test(f)).map((f) => f.slice('server/core/'.length));
  const results = await Promise.all(files.map(async (f) => internalImportFindings(f, await readFile(join(implDir, 'server', 'core', f), 'utf8'), named)));
  return results.flat();
}
