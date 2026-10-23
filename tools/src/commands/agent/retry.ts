import { expectPositionals, flag, positional, type CommandDef } from '../../lib/command.ts';
import { LIMITS } from '../../lib/limits.ts';
import { agentWait } from './lib/outcome.ts';
import { retryAgent } from './lib/retry.ts';

export const retry: CommandDef = {
  name: ['agent', 'retry'],
  usage: 'ogw agent retry <id> [--background]',
  options: { background: { type: 'boolean' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const id = await retryAgent(ctx, positional(args, 0, 'job id'));
    if (flag(args, 'background')) return { text: id, data: { job: id } };
    return agentWait(id, LIMITS.jobMs, ctx.env);
  },
};
