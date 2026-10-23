import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readJson, writeJsonAtomic } from '../../../lib/fsx.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { run } from '../../../lib/proc.ts';
import { loadSchema, schemaPath, withDefaults, type GameSettings } from '../../../lib/settings.ts';
import { readCoreSpecDir } from './impl.ts';
import { withBuiltTool, type ToolName } from './tools.ts';

/** `core-spec.json` version field of the merged `core-spec/` a core test passes to the data tool. */
export const TEST_CORE_SPEC_VERSION = '0.0.0';

async function runTool(ctx: Context, implDir: string, tool: ToolName, args: string[], what: string): Promise<void> {
  const result = await withBuiltTool(ctx.env, implDir, tool, (entry) => run(process.execPath, [entry, ...args], { cwd: implDir, env: ctx.env, timeoutMs: LIMITS.programMs }));
  if (result.timedOut) throw new OgwError(`${tool} timed out on ${what}`);
  if (result.code !== 0) {
    const output = [result.stdout.trim(), result.stderr.trim()].filter((s) => s !== '').join('\n');
    throw new OgwError(`${tool} failed (${String(result.code)}) on ${what}${output ? `:\n${output}` : ''}`);
  }
}

/**
 * Builds the core test data (or, with `gameDir`, the test game of the tool tests) and its generated code with
 * the data tool and then the contract tool of `open-game-works-core-impl/` (`data` tool.md and `contract` tool.md
 * `## CLI`). Returns the ID names the build issued.
 */
/**
 * The game settings of a core test data folder with the game settings schema defaults filled in. With `missingOk` a
 * folder without `settings.json` (before `create server core` writes the core test data) gives the defaults alone.
 */
export async function testGameSettings(ctx: Context, testData: string, missingOk = false): Promise<GameSettings> {
  const schema = await loadSchema(schemaPath('game-settings', ctx.env));
  const path = join(testData, 'settings.json');
  return withDefaults<GameSettings>(schema, missingOk && !exists(path) ? {} : await readJson<GameSettings>(path));
}

export async function buildTestData(ctx: Context, implDir: string, engine: string | null, work: string, gameDir?: string): Promise<Set<string>> {
  const testData = gameDir ?? join(implDir, 'test-data');
  const what = gameDir === undefined ? 'the core test data' : gameDir;
  const proto = join(implDir, 'proto');
  const registry = join(work, 'id_registry.json');
  const coreSpec = join(work, 'core-spec.json');
  const modulesFile = join(work, 'modules.json');
  const gameSettings = join(work, 'game-settings.json');
  const modules = await readCoreSpecDir(implDir);
  await writeJsonAtomic(registry, {});
  await writeJsonAtomic(coreSpec, { version: TEST_CORE_SPEC_VERSION, modules });
  await writeJsonAtomic(modulesFile, modules.map((m) => m.name));
  await writeJsonAtomic(gameSettings, await testGameSettings(ctx, testData));
  const engineArgs = engine === null ? [] : ['--engine', engine];
  if (gameDir === undefined) {
    // the core test data that parallel core agents merged may not be matched: match it first (`data` tool.md)
    await runTool(ctx, implDir, 'data-tool', [
      '--game', testData, ...engineArgs, '--base-proto', proto, '--game-settings', gameSettings,
      '--core-spec', coreSpec, '--modules', modulesFile, '--id-registry', registry,
    ], what);
    await writeJsonAtomic(registry, {});
  }
  await runTool(ctx, implDir, 'data-tool', [
    '--game', testData, ...engineArgs, '--base-proto', proto, '--game-settings', gameSettings,
    // the core test data takes the binary build that issues ID values (`data` tool.md `## ID registry`); the tool test game
    // copy is thrown away, so a full run matches it, issues its ID values and writes every generation target
    '--core-spec', coreSpec, '--modules', modulesFile, ...(gameDir === undefined ? ['--binary'] : []), '--id-registry', registry,
  ], what);
  await runTool(ctx, implDir, 'contract-tool', [
    '--game', testData, ...engineArgs, '--base-proto', proto, '--core-settings', join(implDir, 'settings', 'core-settings.json'),
  ], what);
  return new Set(Object.keys(await readJson<Record<string, unknown>>(registry)));
}
