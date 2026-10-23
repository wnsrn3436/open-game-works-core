import { expectPositionals, flag, positional, type CommandDef } from '../../lib/command.ts';
import { readTelemetry, summaryLines } from './api.ts';

export const telemetry: CommandDef = {
  name: ['telemetry'],
  usage: 'ogw telemetry <instance> [--summary]',
  options: { summary: { type: 'boolean' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const value = await readTelemetry(ctx, positional(args, 0, 'instance'));
    if (flag(args, 'summary')) {
      const lines = summaryLines(value, Date.now());
      return { text: lines.join('\n'), data: { summary: lines } };
    }
    return { text: JSON.stringify(value, null, 2), data: value };
  },
};
