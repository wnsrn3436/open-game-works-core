import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { currentBranch, git, head, revParse, tagExists } from '../../lib/git.ts';
import { buildMergeSubject, isBuildRunMerge, requireBuildRun } from './lib/buildrun.ts';
import { buildTagName } from './lib/names.ts';

export const finish: CommandDef = {
  name: ['build', 'finish'],
  usage: 'ogw build finish <game>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const game = await ctx.game(positional(args, 0, 'game'));
    const { run, env, version } = await requireBuildRun(game);
    const tag = buildTagName(env, version);
    if (await tagExists(game.root, tag, { env: ctx.env })) throw new OgwError(`tag ${tag} already exists`);
    if (env === 'PROD') {
      await git(game.root, ['tag', tag, run.baseCommit], { env: ctx.env });
      return { text: `${tag} ${run.baseCommit}`, data: { tag, commit: run.baseCommit, merged: false } };
    }
    const mainHead = await revParse(game.root, 'main', { env: ctx.env });
    let merge: string;
    if (mainHead === run.baseCommit) {
      await git(game.root, ['checkout', '--quiet', 'main'], { env: ctx.env });
      await git(game.root, ['merge', '--quiet', '--no-ff', '--no-edit', '-m', buildMergeSubject(run), run.branch], { env: ctx.env });
      merge = await head(game.root, { env: ctx.env });
    } else if (mainHead !== null && (await isBuildRunMerge(game.root, run, mainHead, ctx.env))) {
      if ((await currentBranch(game.root, { env: ctx.env })) !== 'main') await git(game.root, ['checkout', '--quiet', 'main'], { env: ctx.env });
      merge = mainHead;
    } else {
      throw new OgwError(`main moved: build branch made from ${run.baseCommit}, main HEAD is ${String(mainHead)}`, 1, {
        baseCommit: run.baseCommit,
        mainHead,
      });
    }
    await git(game.root, ['tag', tag, merge], { env: ctx.env });
    return { text: `${tag} ${merge}`, data: { tag, commit: merge, merged: true } };
  },
};
