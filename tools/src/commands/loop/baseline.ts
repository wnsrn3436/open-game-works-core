import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { runBaseline } from './lib/baseline.ts';
import { openTarget } from './lib/run.ts';

const USAGE = 'ogw loop baseline <game>';

export const loopBaseline: CommandDef = {
  name: ['loop', 'baseline'],
  usage: USAGE,
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const { game, run } = await openTarget(ctx, positional(args, 0, 'game'));
    const baseline = await runBaseline(game, run);
    return { text: baseline ?? 'none', data: { baseline } };
  },
};
