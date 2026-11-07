import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { span } from '../../../lib/spans.ts';
import { writeJsonAtomic } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import type { RunState } from '../../../lib/runstate.ts';
import { runBaseline } from '../../loop/lib/baseline.ts';
import { botRun, pairRuns, scenarioAtHead, telemetryRunsRel, type BotRun, type CheckTelemetryRuns } from '../../loop/lib/shared-telemetry.ts';
import type { InstanceCheckOptions } from './bot-playtest.ts';
import { withInstance } from './instances.ts';

/**
 * The shared telemetry runs that `ogw check --loop` makes beside the checks (ogw.md `## check`): those of `commit` and
 * the baseline game commit of the iteration, each on a new headless instance of its commit within the slots of the
 * check, written to `telemetry-runs.json` of the check evidence folder. Nothing without a baseline game or without a
 * scenario at the checkout HEAD; then `ogw loop evaluate` finds no file and makes the runs itself.
 */
export async function makeTelemetryRuns(ctx: Context, game: GameRepo, run: RunState, commit: string, instance: InstanceCheckOptions): Promise<void> {
  const baseline = await runBaseline(game, run);
  if (baseline === null) return;
  const shared = await scenarioAtHead(game, ctx.env);
  if (shared === null) return;
  const once = async (sha: string): Promise<BotRun | null> => {
    try {
      const made = await withInstance(ctx, instance.slots, { game: game.name, commit: sha, client: 'headless', db: instance.db }, (started) =>
        botRun(ctx, started, shared.scenario, instance.pollMs),
      );
      if (made === null) ctx.log(`shared telemetry: a bot run of ${sha} did not reach every step`);
      return made;
    } catch (error) {
      ctx.log(`shared telemetry: no bot run of ${sha}: ${(error as Error).message.split('\n', 1)[0] ?? ''}`);
      return null;
    }
  };
  const runs = await pairRuns((side) => span(`telemetry run ${side}`, () => once(side === 'commit' ? commit : baseline)));
  const file: CheckTelemetryRuns = { commit, baseline, scenario: shared.sha256, runs };
  await writeJsonAtomic(join(game.root, telemetryRunsRel(run, run.iteration)), file);
}
