import { expectPositionals, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { clearReviews } from './api.ts';

export const clear: CommandDef = {
  name: ['review', 'clear'],
  usage: 'ogw review clear <core|tool>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const side = args.positionals[0];
    if (side !== 'core' && side !== 'tool') throw new OgwError(`usage: ${this.usage}`);
    const left = await clearReviews(ctx, side);
    return { text: [`cleared ${side} review state`, ...left.map((what) => `not removed: ${what}`)].join('\n'), data: { cleared: side, notRemoved: left } };
  },
};
