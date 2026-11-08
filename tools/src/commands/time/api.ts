// What other commands use of `ogw time` (ogw.md `## time`): the report of a job or run, and its lines.
import { OgwError } from '../../lib/errors.ts';
import type { GameRepo } from '../../lib/game.ts';
import type { RunState } from '../../lib/runstate.ts';
import { loadHarnessSettings } from '../../lib/settings.ts';
import { noIteration, runStateReport } from './lib/report.ts';
import { timeSection } from './lib/render.ts';

export { jobReport, runReport, type TimeReport } from './lib/report.ts';
export { formatMs, renderReport, reportData, timeSection } from './lib/render.ts';

/**
 * The section when the report cannot be made: `unknown: <reason>` for the failure that `ogw time` gives (a spans line it
 * cannot read, a parent span the spans file does not hold); any other failure is thrown.
 */
async function orUnknown(make: () => Promise<string>): Promise<string> {
  try {
    return await make();
  } catch (error) {
    if (!(error instanceof OgwError)) throw error;
    return `unknown: ${error.message}`;
  }
}

/**
 * The `## time` section of a record of a run (ogw.md `## time`): that of the run, or of its iteration `iteration`, as
 * `ogw time <game> --run <run> [--iteration <n>]` reports it.
 */
export async function runTimeSection(env: NodeJS.ProcessEnv, game: GameRepo, run: RunState, iteration: number | null): Promise<string> {
  const criteria = (await loadHarnessSettings(env)).time;
  return orUnknown(async () => {
    const report = await runStateReport(env, criteria, game, run, iteration);
    return report === null ? `none: ${noIteration(run, iteration as number)}` : timeSection(report);
  });
}
