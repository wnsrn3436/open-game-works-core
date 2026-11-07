import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { changeOpenRun, openRun, type RunState } from '../../lib/runstate.ts';
import { commitWithoutHook, printHookFailures } from '../game/lib/commit-without-hook.ts';
import { SETTINGS_COMMIT_KEY, settingsCommitFailures } from '../loop/lib/api.ts';
import { callerRole } from './api.ts';

const USAGE = 'ogw settings commit game <game>';

/** A loop run whose content input of iteration 1 is still to be written. */
function beforeIterationOne(run: RunState | null): run is RunState {
  return run?.kind === 'loop' && run.iteration === 0;
}

/**
 * `ogw settings commit game <game>` (ogw.md `## settings commit`): the lead agent's commit of `settings.json` without
 * the hook, which prints the failures the hook would refuse it for and keeps them for the content agent of iteration 1.
 */
export const commit: CommandDef = {
  name: ['settings', 'commit'],
  usage: USAGE,
  async run(ctx, args) {
    expectPositionals(args, 2, 2, USAGE);
    if (args.positionals[0] !== 'game') throw new OgwError(`usage: ${USAGE}`);
    const role = await callerRole(ctx);
    if (role !== 'lead') throw new OgwError(`role ${role} cannot run ogw settings commit, which skips the pre-commit hook; commit settings.json with git`);
    const game = await ctx.game(positional(args, 1, 'game'));
    const made = await commitWithoutHook(ctx, game, ['settings.json'], 'game settings');
    if (made === null) return { text: 'settings.json has no change', data: { commit: null, failures: [] } };
    const failures = await printHookFailures(ctx, game, made);
    if (failures.length > 0 && beforeIterationOne(await openRun(game))) {
      await changeOpenRun(game, (run) => {
        run.data[SETTINGS_COMMIT_KEY] = [...settingsCommitFailures(run), ...failures];
      });
    }
    return { text: `commit: ${made}`, data: { commit: made, failures } };
  },
};
