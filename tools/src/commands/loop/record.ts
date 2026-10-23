import { expectPositionals, flag, positional, type CommandDef } from '../../lib/command.ts';
import { recordFindings } from './lib/record.ts';
import { openTarget } from './lib/run.ts';

const USAGE = 'ogw loop record <game> [--hardening]';

export const loopRecord: CommandDef = {
  name: ['loop', 'record'],
  usage: USAGE,
  options: { hardening: { type: 'boolean' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const { game, run } = await openTarget(ctx, positional(args, 0, 'game'));
    const result = await recordFindings(game, run, flag(args, 'hardening'));
    return { text: [result.defects, ...(result.record ? [result.record] : [])].join('\n'), data: result };
  },
};
