import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { changeOpenRun } from '../../lib/runstate.ts';
import { buildData, gameSettingsWithDefaults, requireBuildRun } from './lib/buildrun.ts';

export const retry: CommandDef = {
  name: ['build', 'retry'],
  usage: 'ogw build retry <game>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const game = await ctx.game(positional(args, 0, 'game'));
    await requireBuildRun(game);
    const settings = await gameSettingsWithDefaults(game.root, ctx.env);
    const limit = settings.buildRetryLimit;
    if (typeof limit !== 'number') throw new OgwError('game settings buildRetryLimit is not a number');
    const retries = await changeOpenRun(game, (run) => {
      const data = buildData(run);
      if (data.retries + 1 > limit) {
        throw new OgwError(`retries ${String(data.retries)}\nbuildRetryLimit ${String(limit)}`, 1, {
          retries: data.retries,
          buildRetryLimit: limit,
        });
      }
      data.retries += 1;
      run.data.build = data;
      return data.retries;
    });
    return {
      text: `retries ${String(retries)}\nbuildRetryLimit ${String(limit)}`,
      data: { retries, buildRetryLimit: limit },
    };
  },
};
