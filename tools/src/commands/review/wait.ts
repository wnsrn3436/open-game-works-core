import type { CommandDef } from '../../lib/command.ts';
import { timeoutOption } from '../job/wait.ts';
import { reviewWait } from './lib/wait.ts';
import { sideAndTarget } from './next.ts';

export const wait: CommandDef = {
  name: ['review', 'wait'],
  usage: 'ogw review wait <core|tool> <target> [--timeout <ms>]',
  options: { timeout: { type: 'string' } },
  async run(ctx, args) {
    const { side, target } = sideAndTarget(args, this.usage);
    return reviewWait(ctx, side, target, await timeoutOption(ctx, args));
  },
};
