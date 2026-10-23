import type { CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { secretTarget } from './lib/target.ts';

const USAGE = 'ogw secret show <game> <DEV|STG|PROD|signing> <name> | ogw secret show --harness <name>';

/**
 * Prints a secret value for a human in a terminal (ogw.md `## secret show`). The value goes to stdout only: the
 * result has no summary, so no run log or job record holds it.
 */
export const show: CommandDef = {
  name: ['secret', 'show'],
  usage: USAGE,
  options: { harness: { type: 'boolean' } },
  async run(ctx, args) {
    if (!ctx.terminal()) {
      throw new OgwError('ogw secret show is for a human in a terminal: stdin and stdout must both be a terminal');
    }
    const { service, name } = await secretTarget(ctx, args, USAGE);
    const value = ctx.secrets.get(service);
    if (value === null) throw new OgwError(`${name} is not in the secret store`);
    return { text: value, data: { name, value } };
  },
};
