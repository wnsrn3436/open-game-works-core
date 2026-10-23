import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { git, head, revParse } from '../../lib/git.ts';
import { mergeBranch, mergeBranchGap } from './lib/merge-branch.ts';
import { loopData, openTarget } from './lib/run.ts';

const USAGE = 'ogw loop merge <game>';

export const loopMerge: CommandDef = {
  name: ['loop', 'merge'],
  usage: USAGE,
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const { game, run } = await openTarget(ctx, positional(args, 0, 'game'), 'loop');
    const branch = mergeBranch(run);
    const failed = loopData(run).prepareMerge?.failed;
    if (failed !== undefined) throw new OgwError(`ogw loop prepare-merge failed: ${failed}; not merged`, 1, { failed });
    const gap = await mergeBranchGap(game, run, ctx.env);
    if (gap === 'missing') throw new OgwError(`branch ${branch} does not exist`);
    // A branch with no commit beyond the work branch base is one a failed preparation left; merging it adds nothing.
    if (gap === 'empty') throw new OgwError(`branch ${branch} has no commit beyond the work branch base ${run.baseCommit}; not merged`);
    const mainHead = await revParse(game.root, 'main', { env: ctx.env });
    if (mainHead !== run.baseCommit) {
      throw new OgwError(`main HEAD ${String(mainHead)} is not the work branch base ${run.baseCommit}; not merged`, 1, {
        mainHead,
        baseCommit: run.baseCommit,
      });
    }
    await git(game.root, ['checkout', '--quiet', 'main'], { env: ctx.env });
    await git(game.root, ['merge', '--quiet', '--no-ff', '-m', `loop ${run.name}: merge ${branch}`, branch], { env: ctx.env });
    const commit = await head(game.root, { env: ctx.env });
    return { text: commit, data: { commit } };
  },
};
