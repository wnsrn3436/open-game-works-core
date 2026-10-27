import { expectPositionals, flag, positional, str, type CommandDef, type Context } from '../../lib/command.ts';
import type { GameRepo } from '../../lib/game.ts';
import type { RunState } from '../../lib/runstate.ts';
import { OgwError } from '../../lib/errors.ts';
import { revParse } from '../../lib/git.ts';
import { changeOpenRun } from '../../lib/runstate.ts';
import { chooseMergeCommit, mergeBranch, prepareCommit, prepareCommitRecordsOnly, prepareRecordsOnly, type MergeChoice } from './lib/merge-branch.ts';
import { loopData, openTarget, type PrepareMergeRecord } from './lib/run.ts';

const USAGE = 'ogw loop prepare-merge <game> [--commit <sha> | --records-only]';

/** Recorded until preparation ends, so a process killed midway leaves a failure and not an older result. */
const NOT_FINISHED = 'ogw loop prepare-merge did not finish';

async function givenCommit(root: string, given: string, env: NodeJS.ProcessEnv): Promise<string> {
  const commit = await revParse(root, given, { env });
  if (commit === null) throw new OgwError(`not a commit: ${given}`);
  return commit;
}

/** The merge choice: none with `--records-only`, the given commit with the synced work, or `chooseMergeCommit`. */
async function mergeChoice(ctx: Context, game: GameRepo, run: RunState, given: string | undefined, recordsOnly: boolean): Promise<MergeChoice | null> {
  if (recordsOnly) return null;
  if (given !== undefined) return { commit: await givenCommit(game.root, given, ctx.env), withSyncedWork: true };
  return chooseMergeCommit(game, run, (await ctx.settings()).loopStop);
}

/** Makes `merge/<run>` for the choice (`game-loop` `## end` 2). */
async function prepareChoice(ctx: Context, game: GameRepo, run: RunState, choice: MergeChoice | null): Promise<void> {
  if (choice === null) await prepareRecordsOnly(game, run);
  else if (choice.withSyncedWork) await prepareCommit(ctx, game, run, choice.commit);
  else await prepareCommitRecordsOnly(game, run, choice.commit);
}

export const loopPrepareMerge: CommandDef = {
  name: ['loop', 'prepare-merge'],
  usage: USAGE,
  options: { commit: { type: 'string' }, 'records-only': { type: 'boolean' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const given = str(args, 'commit');
    const recordsOnly = flag(args, 'records-only');
    if (given !== undefined && recordsOnly) throw new OgwError(`usage: ${USAGE}`);
    const { game, run } = await openTarget(ctx, positional(args, 0, 'game'), 'loop');
    const branch = mergeBranch(run);
    const choice = await mergeChoice(ctx, game, run, given, recordsOnly);
    const commit = choice?.commit ?? null;
    const mainHead = await revParse(game.root, 'main', { env: ctx.env });
    if (mainHead === null) throw new OgwError('game repo has no main branch');
    const record = (fields: Pick<PrepareMergeRecord, 'created' | 'failed'>): Promise<unknown> =>
      changeOpenRun(game, (open) => {
        loopData(open).prepareMerge = { commit, withSyncedWork: choice?.withSyncedWork ?? false, mainHead, baseCommit: run.baseCommit, ...fields };
      });
    const chosen = given === undefined && !recordsOnly;
    if (chosen && mainHead !== run.baseCommit) {
      await record({ created: false });
      throw new OgwError(
        `main HEAD ${mainHead} is not the work branch base ${run.baseCommit}; merge/${run.name} is not made`,
        1,
        { mainHead, baseCommit: run.baseCommit, commit },
      );
    }
    await record({ created: false, failed: NOT_FINISHED });
    try {
      await prepareChoice(ctx, game, run, choice);
    } catch (error) {
      await record({ created: false, failed: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    await record({ created: true });
    if (!chosen) return { text: branch, data: commit === null ? { branch } : { branch, commit } };
    return { text: `merge commit: ${commit ?? 'none'}\nbranch: ${branch}`, data: { commit, branch } };
  },
};
