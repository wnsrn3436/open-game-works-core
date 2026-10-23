/**
 * One module test of the `tools` target of `ogw core test` (`core` command.md `### create contract tool`):
 * the vitest tests of the tool, then the encode and decode round trip of its generated code in every engine
 * with `client/<engine>/engine.json` (Godot: `godot` `## test`).
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists } from '../../../lib/fsx.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { runOk } from '../../../lib/proc.ts';
import { addOutcomes, copyGodotProject, gutArgs, gutPass, resultsDirOf, type ModuleOutcome } from './godot.ts';
import { enginesOf, readEngineJson, unitTestProcessLimit } from './impl.ts';
import { buildTestData } from './test-data.ts';
import { passedEngines } from './test-records.ts';
import { buildTool, implementedTools, runVitest, TOOLS, withBuiltTool, type ToolName } from './tools.ts';
import { engineAssetRules } from './undefined.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';

/** GUT file name prefix of the Godot round trip tests of each tool in `tools/tests/godot/`. */
export const GODOT_PREFIX: Readonly<Record<ToolName, string>> = { 'contract-tool': 'test_contract_', 'data-tool': 'test_data_' };

function failed(label: string, message: string): ModuleOutcome {
  return { tests: 0, passed: 0, failures: [`${label}: ${message}`] };
}

/**
 * The Godot round trip: a copy of `client/godot/` as `client/` of a copy of `tools/tests/game/`, the generated
 * code of both tools for that game, `tools/tests/godot/` as `res://tool_tests`, and the headless pass on it.
 */
async function godotRoundTrip(ctx: Context, implDir: string, tool: ToolName, work: string): Promise<ModuleOutcome> {
  const label = 'godot round trip';
  const testGame = join(implDir, 'tools', 'tests', 'game');
  const tests = join(implDir, 'tools', 'tests', 'godot');
  if (!exists(testGame)) return failed(label, 'no tools/tests/game/');
  if (!exists(tests)) return failed(label, 'no tools/tests/godot/');
  const game = join(work, 'game');
  await cp(testGame, game, { recursive: true });
  const project = join(game, 'client');
  const setup = await copyGodotProject(ctx, implDir, await readEngineJson(implDir, 'godot'), project);
  const build = join(work, 'build');
  await mkdir(build, { recursive: true });
  await buildTestData(ctx, implDir, 'godot', build, game);
  await cp(tests, join(project, 'tool_tests'), { recursive: true });
  const timeoutMs = await unitTestProcessLimit(implDir);
  await runOk(setup.godot, ['--headless', '--path', project, '--import'], { cwd: project, env: ctx.env, timeoutMs: LIMITS.programMs });
  return gutPass(ctx, {
    godot: setup.godot,
    project,
    headless: true,
    gut: gutArgs(null, GODOT_PREFIX[tool]).map((arg) => (arg === '-gdir=res://core' ? '-gdir=res://tool_tests' : arg)),
    config: (runId, host) => ({ ogw_run_id: runId, ogw_test_host: host, ogw_core_fixture_dir: join(implDir, 'fixtures') }),
    label,
    resultsDir: resultsDirOf(work),
    timeoutMs,
  });
}

/** Runs the tests of one tool of `ogw core test tools`. */
export async function runToolTest(ctx: Context, implDir: string, tool: string): Promise<ModuleOutcome> {
  const name = TOOLS.find((t) => t === tool);
  if (name === undefined) throw new OgwError(`not a tool: ${tool}`);
  // every tool this test runs (the round trip of an engine runs both) is built before it reads any of them: a build waits
  // for the readers of its folder, and a run reading one tool while it waits to build another could wait for a run that
  // does the opposite
  const engines = await enginesOf(implDir);
  // the round trip of an engine whose client core passed (ogw.md `## agent merge`); the others are left out
  const passed = await passedEngines(implDir, engines);
  for (const each of passed.size > 0 ? implementedTools(implDir) : [name]) await buildTool(ctx.env, implDir, each);
  const work = await newPrivateTempFolder(`ogw-tool-test-${name}-`, ctx.env);
  try {
    return await withBuiltTool(ctx.env, implDir, name, async () => {
      const vitest = await runVitest(ctx, implDir, name, work);
      let outcome: ModuleOutcome = vitest;
      const leftOut: string[] = [];
      for (const engine of engines) {
        if (engine !== 'godot') engineAssetRules(engine);
        // the round trip compiles the engine's whole client core: it waits until that client core passed
        if (!passed.has(engine)) {
          leftOut.push(engine);
          continue;
        }
        const engineWork = join(work, engine);
        await mkdir(engineWork, { recursive: true });
        // a step before GUT that throws fails the round trip and keeps the vitest outcome
        const roundTrip = await godotRoundTrip(ctx, implDir, name, engineWork).catch((error: unknown) => failed('godot round trip', (error as Error).message));
        outcome = addOutcomes(outcome, roundTrip);
      }
      // the tool's own tests are its vitest tests: the round trip does not make them run
      const skipped = leftOut.length === 0 ? {} : { skipped: `${leftOut.join(', ')} round trip left out: no core test of the engine has passed every client module yet` };
      return { ...outcome, ran: vitest.ran !== false, ...skipped };
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
