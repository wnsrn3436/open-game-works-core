import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { runData } from './api.ts';

export const data: CommandDef = {
  name: ['data'],
  usage: 'ogw data <game>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const game = await ctx.game(positional(args, 0, 'game'));
    const result = await runData(ctx, game);
    if (result.stderr.trim() !== '') ctx.log(result.stderr.trimEnd());
    const glossaryMissing = result.lines.filter((line) => line.code === 'glossary_missing').map((line) => line.text);
    return {
      exitCode: result.exitCode,
      text: result.lines.map((line) => line.text).join('\n'),
      data: result,
      summary: { glossaryMissing },
    };
  },
};
