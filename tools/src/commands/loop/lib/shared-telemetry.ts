import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { showFile } from '../../../lib/git.ts';
import { SCENARIO } from '../../check/lib/bot-playtest.ts';
import { parseScenario, runScenario, type Scenario } from '../../check/lib/scenario.ts';
import { readTelemetry } from '../../telemetry/api.ts';
import { compareTelemetry, failureIsNone, formatComparison, freeScenes } from '../../telemetry/lib/compare.ts';
import type { Telemetry } from '../../telemetry/lib/metrics.ts';

/**
 * The shared telemetry of `game-loop` `## iteration` 4: the bot run of the scenario on a headless instance of this
 * commit and one of the baseline game commit, the same inputs on both.
 */

/** The telemetry of one bot run and the `play-guide.md` text of its instance (null when it has none). */
export interface BotRun {
  telemetry: Telemetry;
  guide: string | null;
}

/** `client/dev/bot/scenario.json` of the work branch HEAD; null when it is missing or has another form. */
export async function scenarioAtHead(game: GameRepo, env: NodeJS.ProcessEnv): Promise<Scenario | null> {
  const bytes = await showFile(game.root, 'HEAD', SCENARIO, { env });
  if (bytes === null) return null;
  const scenario = parseScenario(bytes.toString('utf8'));
  return typeof scenario === 'string' ? null : scenario;
}

/**
 * Runs the scenario on the instance up to its last step or its first failed step and reads the telemetry of its
 * client. null when the run did not reach every step, or its telemetry could not be read.
 */
export async function botRun(ctx: Context, instance: { id: string; root: string }, scenario: Scenario, pollMs: number): Promise<BotRun | null> {
  try {
    const outcome = await runScenario(ctx, instance.id, scenario, { pollMs });
    if (outcome.stop !== null && outcome.stop.step < scenario.steps.length) return null;
    const telemetry = await readTelemetry(ctx, instance.id);
    const guide = await readFile(join(instance.root, 'play-guide.md'), 'utf8').catch(() => null);
    return { telemetry, guide };
  } catch {
    return null;
  }
}

/** The `ogw telemetry compare` output of the two runs as `A` and `B`. */
/**
 * The run as the player meets it when the runner held each input `latencyMs` (`ogw instance start --input-latency`):
 * the client measures `input_latency_ms` from when it gets the input, so the held time is added to every measured one.
 */
export function withInputLatency(run: BotRun, latencyMs: number): BotRun {
  if (latencyMs <= 0) return run;
  const inputs = run.telemetry.inputs.map((i) => (i.latency_ms === null ? i : { ...i, latency_ms: i.latency_ms + latencyMs }));
  return { ...run, telemetry: { ...run.telemetry, inputs } };
}

export function comparisonText(a: BotRun, b: BotRun): string {
  const noFailure = [a.guide, b.guide].some((guide) => guide !== null && failureIsNone(guide));
  const free = (guide: string | null) => (guide === null ? null : freeScenes(guide));
  return `${formatComparison(compareTelemetry(a.telemetry, b.telemetry, noFailure, free(a.guide), free(b.guide)))}\n`;
}
