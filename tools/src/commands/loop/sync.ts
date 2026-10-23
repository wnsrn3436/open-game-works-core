import { LIMITS } from '../../lib/limits.ts';
import { expectPositionals, flag, positional, type CommandDef } from '../../lib/command.ts';
import { openTarget } from './lib/run.ts';
import { sync, syncText } from './lib/sync.ts';

const USAGE = 'ogw loop sync <game> [--wait]';

export const loopSync: CommandDef = {
  name: ['loop', 'sync'],
  usage: USAGE,
  options: { wait: { type: 'boolean' } },
  background: {
    game: (args) => args.positionals[0] ?? null,
    timeLimitMs: () => LIMITS.jobMs,
  },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const { game } = await openTarget(ctx, positional(args, 0, 'game'));
    const result = await sync(ctx, game, flag(args, 'wait'));
    return { exitCode: result.failed.length > 0 ? 1 : 0, text: syncText(result), data: result };
  },
};
