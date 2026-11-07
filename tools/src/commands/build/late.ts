import { expectPositionals, positional, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { writeJsonAtomic } from '../../lib/fsx.ts';
import { revParse } from '../../lib/git.ts';
import { LIMITS } from '../../lib/limits.ts';
import { withCommitCheckout } from './lib/atcommit.ts';
import { gameSettingsAt, lateChecksFile, requireBuildRun, type BuildCheck, type LateChecksResult } from './lib/buildrun.ts';
import { withWorkspacesOf, type ClientCheckInput } from './lib/client-check.ts';
import { repeatTest } from './lib/repeat-test.ts';
import { soakTest } from './lib/soak-test.ts';

const USAGE = 'ogw build late <game> --commit <sha>';

/**
 * The late checks of a DEV build (ogw.md `## build run`): checks `repeat test` and then `soak test` of the build commit,
 * which `ogw build run` starts as a job after the platform build. They run in a worktree of that commit, so that the
 * merge of `ogw build finish` in the game repo checkout does not change the files their check instances run. The result
 * goes to `builds/<env>-<version>/late-checks.json`, which `ogw build report --late` writes into the build report.
 */
export const late: CommandDef = {
  name: ['build', 'late'],
  usage: USAGE,
  options: { commit: { type: 'string' } },
  background: { game: (args) => args.positionals[0] ?? null, timeLimitMs: () => LIMITS.jobMs },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const game = await ctx.game(positional(args, 0, 'game'));
    const open = await requireBuildRun(game);
    if (open.env !== 'DEV') throw new OgwError(`the late checks are of a DEV build, not of ${open.env}`);
    const given = str(args, 'commit');
    if (given === undefined) throw new OgwError(`usage: ${USAGE}`);
    const commit = await revParse(game.root, given, { env: ctx.env });
    if (commit === null) throw new OgwError(`commit not found in ${game.name}: ${given}`);
    const settings = await gameSettingsAt(game.root, commit, ctx.env);
    const checks = await withCommitCheckout(ctx, game, commit, async (repo) => {
      const input: ClientCheckInput = {
        ctx, game, env: open.env, version: open.version, exportVersion: open.run.bundleFor ?? open.version, settings, platforms: open.run.platforms, checkout: repo.root,
      };
      // the soak test after the repeat test, so that the runs of the repeat test do not change its frame intervals
      return withWorkspacesOf(input, async (shared) => {
        const repeat = await repeatTest(shared);
        const soak = await soakTest(shared);
        return [repeat, soak].filter((c): c is BuildCheck => c !== null);
      });
    });
    const result: LateChecksResult = { commit, checks };
    await writeJsonAtomic(lateChecksFile(game, open.env, open.version), result);
    const text = checks.map((c) => `check ${c.name}: ${c.result}${c.details.length > 0 ? `\n  ${c.details.join('\n  ')}` : ''}`).join('\n');
    return { text, data: result };
  },
};
