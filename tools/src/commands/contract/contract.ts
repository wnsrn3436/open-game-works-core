import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { runContract } from './api.ts';

export const contract: CommandDef = {
  name: ['contract'],
  usage: 'ogw contract <game>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const result = await runContract(ctx, await ctx.game(positional(args, 0, 'game')));
    if (result.stderr.trim() !== '') ctx.log(result.stderr.trimEnd());
    return { exitCode: result.exitCode, text: result.violations.join('\n'), data: result };
  },
};
