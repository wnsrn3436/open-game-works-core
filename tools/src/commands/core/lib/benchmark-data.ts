import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { exists, readJson, writeJsonAtomic } from '../../../lib/fsx.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { run } from '../../../lib/proc.ts';
import type { GameSettings } from '../../../lib/settings.ts';
import { dataToolArgs } from '../../data/api.ts';
import { withTempDir } from '../../data/lib/tool.ts';
import { enginesOf, readCoreSpecDir } from './impl.ts';
import { TEST_CORE_SPEC_VERSION } from './test-data.ts';
import { withBuiltTool } from './tools.ts';

/**
 * The binary build of the data tool of `implDir` on a copy of each `benchmark/<engine>/`, with the modules the
 * benchmark game uses and its `id_registry.json`, as `ogw instance measure` runs it on the released benchmark game.
 */
export async function benchmarkDataViolations(ctx: Context, implDir: string): Promise<string[]> {
  const violations: string[] = [];
  const modules = await readCoreSpecDir(implDir, { skipInvalid: true });
  for (const engine of await enginesOf(implDir)) {
    const source = join(implDir, 'benchmark', engine);
    if (!exists(join(source, 'settings.json'))) continue;
    const result = await withTempDir('ogw-benchmark-data-', ctx.env, async (work) => {
      const game = join(work, 'game');
      await cp(source, game, { recursive: true });
      await writeJsonAtomic(join(work, 'core-spec.json'), { version: TEST_CORE_SPEC_VERSION, modules });
      const args = await dataToolArgs(ctx, {
        gameDir: game,
        settings: await readJson<GameSettings>(join(game, 'settings.json')),
        release: { version: TEST_CORE_SPEC_VERSION, dir: work, local: true },
        toolDir: implDir,
        dir: join(work, 'args'),
        binary: true,
        strict: false,
        previous: null,
        idRegistry: join(game, 'id_registry.json'),
      });
      return withBuiltTool(ctx.env, implDir, 'data-tool', (entry) => run(process.execPath, [entry, ...args], { cwd: game, env: ctx.env, timeoutMs: LIMITS.programMs }));
    });
    if (result.timedOut) violations.push(`benchmark ${engine}: the data tool binary build timed out`);
    else if (result.code !== 0) violations.push(`benchmark ${engine}: the data tool binary build failed (${String(result.code)})\n  ${result.stderr.trim()}`);
  }
  return violations;
}
