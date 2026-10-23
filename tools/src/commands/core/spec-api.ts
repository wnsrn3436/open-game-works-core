import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists, formatJson, isNotFound, writeIfChanged } from '../../lib/fsx.ts';
import { checkoutLock } from '../../lib/git.ts';
import { resolveCoreImpl } from '../../lib/game.ts';
import { withLock } from '../../lib/lock.ts';
import { buildFromHarness } from './lib/spec-build.ts';

export interface CoreSpecBuild {
  /** `<module>` objects by module name, in `core-spec/` form (`core` command `## core spec file`). */
  modules: Map<string, unknown>;
  /** One line per violation of the tool-read form: `<spec file>:<line>: <reason>`. */
  errors: string[];
}

export interface CoreSpecWrite extends CoreSpecBuild {
  /** The `core-spec/` folder. */
  dir: string;
  /** File names written because their bytes differed. */
  written: string[];
  /** File names deleted because they are not `<module>.json`. */
  deleted: string[];
}

/** Reads the module specs of the harness working tree into `core-spec/` objects. Writes nothing. */
export async function buildCoreSpec(ctx: Context): Promise<CoreSpecBuild> {
  const ws = await ctx.workspace();
  const result = await buildFromHarness(ws.harness);
  return { modules: result.modules, errors: result.errors };
}

/**
 * `ogw core spec`: writes `core-spec/` of `open-game-works-core-impl/` (or the core worktree the command runs in).
 * Writes nothing when the specs break the tool-read form; `errors` then lists every violation.
 */
export async function writeCoreSpec(ctx: Context): Promise<CoreSpecWrite> {
  const build = await buildCoreSpec(ctx);
  const ws = await ctx.workspace();
  const coreImpl = await resolveCoreImpl(ws, ctx.cwd, ctx.env);
  const dir = join(coreImpl, 'core-spec');
  if (build.errors.length > 0) return { ...build, dir, written: [], deleted: [] };
  if (!exists(coreImpl)) throw new OgwError(`core implementation folder not found: ${coreImpl}`);
  // One writer per `core-spec/` at a time: the delete step would otherwise remove another run's temp files.
  return withLock(await checkoutLock(coreImpl, 'ogw-core-spec.lock', { env: ctx.env }), async () => {
    await mkdir(dir, { recursive: true });
    const written: string[] = [];
    for (const [name, module] of build.modules) {
      const file = `${name}.json`;
      if (await writeIfChanged(join(dir, file), formatJson(module))) written.push(file);
    }
    const keep = new Set([...build.modules.keys()].map((name) => `${name}.json`));
    const deleted: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() || keep.has(entry.name)) continue;
      try {
        await rm(join(dir, entry.name));
        deleted.push(entry.name);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return { ...build, dir, written, deleted: deleted.sort() };
  });
}
