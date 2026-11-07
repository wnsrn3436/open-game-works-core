// What other commands use of `ogw time` (ogw.md `## time`): the report of a job or run, and its lines.
import type { Context } from '../../lib/command.ts';
import type { GameRepo } from '../../lib/game.ts';
import type { RunState } from '../../lib/runstate.ts';
import { loadHarnessSettings } from '../../lib/settings.ts';
import { jobReport, noIteration, runStateReport } from './lib/report.ts';
import { timeSection } from './lib/render.ts';

export { jobReport, runReport, type TimeReport } from './lib/report.ts';
export { formatMs, renderReport, reportData, timeSection } from './lib/render.ts';

/** The `## time` section of a record that the command of a job writes: that of its job, `none` outside a job (ogw.md `## time`). */
export async function jobTimeSection(ctx: Context): Promise<string> {
  return ctx.jobId === null ? 'none: the command does not run as a job' : timeSection(await jobReport(ctx, ctx.jobId));
}

/**
 * The `## time` section of a record of a run (ogw.md `## time`): that of the run, or of its iteration `iteration`, as
 * `ogw time <game> --run <run> [--iteration <n>]` reports it.
 */
export async function runTimeSection(env: NodeJS.ProcessEnv, game: GameRepo, run: RunState, iteration: number | null): Promise<string> {
  const report = await runStateReport(env, (await loadHarnessSettings(env)).time, game, run, iteration);
  return report === null ? `none: ${noIteration(run, iteration as number)}` : timeSection(report);
}
