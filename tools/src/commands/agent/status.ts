import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { outcomeOf } from './lib/outcome.ts';

export const status: CommandDef = {
  name: ['agent', 'status'],
  usage: 'ogw agent status <id>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const id = positional(args, 0, 'job id');
    const outcome = await outcomeOf(id, ctx.env);
    return { text: outcome.status, data: { id, status: outcome.status, output: outcome.output } };
  },
};
