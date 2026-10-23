import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { stopInstance } from './api.ts';

export const stop: CommandDef = {
  name: ['instance', 'stop'],
  usage: 'ogw instance stop <id>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const id = positional(args, 0, 'instance id');
    await stopInstance(ctx, id);
    return { text: `stopped ${id}`, data: { id, stopped: true } };
  },
};
