import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import type { GameRepo } from '../../lib/game.ts';
import { isAncestor } from '../../lib/git.ts';
import { changeOpenRun, type RunState } from '../../lib/runstate.ts';
import type { DefectsFile } from './lib/defects.ts';
import { iterationRecords } from './lib/iteration-record.ts';
import { agentJobsOf, runJobs } from './lib/jobs.ts';
import { WORKER_ROLES } from './lib/sync.ts';
import { gameSettings, loopData, openTarget, readRunJson, runRel, type VerdictRecord } from './lib/run.ts';
import { verdict } from './lib/verdict.ts';

const USAGE = 'ogw loop verdict <game>';

/**
 * Worker jobs the iteration's commit has not seen (`## stop`): running, done and not merged, or merged after the
 * commit. A job given again or given up, and a stuck job, is not one.
 */
async function unhandledJobs(game: GameRepo, run: RunState, jobs: readonly string[], commit: string | null): Promise<string[]> {
  const data = loopData(run);
  const out: string[] = [];
  for (const job of jobs) {
    if (data.stuck.some((s) => s.job === job)) continue;
    if (!data.handled.includes(job)) {
      out.push(job);
      continue;
    }
    const merge = data.merges.find((m) => m.job === job);
    if (merge && (commit === null || !(await isAncestor(game.root, merge.after, commit)))) out.push(job);
  }
  return out;
}

export const loopVerdict: CommandDef = {
  name: ['loop', 'verdict'],
  usage: USAGE,
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const { game, run } = await openTarget(ctx, positional(args, 0, 'game'), 'loop');
    const n = String(run.iteration);
    const records = await iterationRecords(game, run);
    if (!records.some((r) => r.iteration === run.iteration)) {
      throw new OgwError(`${runRel(run, `iteration-${n}.md`)} is missing: run ogw loop record ${game.name} first`);
    }
    const defects = await readRunJson<DefectsFile>(game, run, 'defects.json');
    if (defects?.recordedBy !== `iteration-${n}`) {
      throw new OgwError(`${runRel(run, 'defects.json')} is not recorded by iteration-${n} (${defects?.recordedBy ?? 'missing'}): run ogw loop record ${game.name} first`);
    }
    const commit = records.find((r) => r.iteration === run.iteration)?.commit ?? null;
    const unhandled = await unhandledJobs(game, run, agentJobsOf(await runJobs(ctx, game, run), WORKER_ROLES).map((job) => job.id), commit);
    const result = verdict({
      iteration: run.iteration,
      limit: Number((await gameSettings(ctx, game)).loopIterationLimit),
      loopStop: (await ctx.settings()).loopStop,
      records,
      checkPath: runRel(run, `check-${n}.json`),
      defects,
      unhandled,
    });
    const record: VerdictRecord = { iteration: run.iteration, ...result };
    await changeOpenRun(game, (open) => {
      loopData(open).verdict = record;
    });
    const text = [result.reason, ...result.evidence].join('\n');
    return { text, data: record };
  },
};
