import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { generateCheckout } from './api.ts';

export const generate: CommandDef = {
  name: ['generate'],
  usage: 'ogw generate <game>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const game = await ctx.game(positional(args, 0, 'game'));
    const applied = await generateCheckout(ctx, game);
    const lines = [...applied.written.map((path) => `written ${path}`), ...applied.removed.map((path) => `removed ${path}`)];
    return { text: lines.length > 0 ? lines.join('\n') : 'no change', data: applied };
  },
};
