import { expectPositionals, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { reviewStatus } from './lib/status.ts';

export const status: CommandDef = {
  name: ['review', 'status'],
  usage: 'ogw review status <core|tool>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const side = args.positionals[0];
    if (side !== 'core' && side !== 'tool') throw new OgwError(`usage: ${this.usage}`);
    return reviewStatus(ctx, side);
  },
};
