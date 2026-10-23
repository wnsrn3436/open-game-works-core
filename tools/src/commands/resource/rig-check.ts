import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { formatJson } from '../../lib/fsx.ts';
import { rigCheck } from './lib/rig.ts';

/** `ogw resource rig-check <rig split JSON>`. Ends with a non-zero code when `status` is `fail`. */
export const rigCheckCommand: CommandDef = {
  name: ['resource', 'rig-check'],
  usage: 'ogw resource rig-check <rig split JSON>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const recompose = await rigCheck(positional(args, 0, 'rig split JSON'), (await ctx.settings()).rigCheck);
    const data = { recompose };
    return { exitCode: recompose.status === 'pass' ? 0 : 1, text: formatJson(data), data };
  },
};
