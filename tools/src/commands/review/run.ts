import { str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { reviewRun, RUN_TIME_LIMIT_MS } from './lib/run.ts';
import { restartOrContinue, sideAndTarget } from './next.ts';

export const run: CommandDef = {
  name: ['review', 'run'],
  usage: 'ogw review run core <target> [--since <commit>|--full|--debt] [--restart|--respec|--continue|--reopen]',
  options: { restart: { type: 'boolean' }, respec: { type: 'boolean' }, continue: { type: 'boolean' }, reopen: { type: 'boolean' }, full: { type: 'boolean' }, debt: { type: 'boolean' }, since: { type: 'string' } },
  background: { timeLimitMs: () => RUN_TIME_LIMIT_MS },
  async run(ctx, args) {
    const { side, target } = sideAndTarget(args, this.usage);
    if (side !== 'core') throw new OgwError(`usage: ${this.usage}`);
    const since = str(args, 'since');
    return reviewRun(ctx, target, { ...restartOrContinue(args, this.usage, side), ...(since === undefined ? {} : { since }) });
  },
};
