import { flag, list, str, type CommandArgs, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import type { Side } from './lib/input.ts';
import { NEXT_TOOL_USAGE } from './lib/definitions.ts';
import { reviewNext } from './lib/next.ts';

/** `<core|tool> <target>`: the target is the rest of the positionals joined with a space (`settings get`). */
export function sideAndTarget(args: CommandArgs, usage: string): { side: Side; target: string } {
  const [side, ...words] = args.positionals;
  if ((side !== 'core' && side !== 'tool') || words.length === 0) throw new OgwError(`usage: ${usage}`);
  return { side, target: words.join(' ') };
}

/**
 * `--restart`, `--respec`, `--continue`, `--reopen`, `--full` and `--debt` of `review next` and `review run`: they
 * exclude each other, `--full` and `--debt` exclude `--since`, and `--full` takes a core target only.
 */
export function restartOrContinue(args: CommandArgs, usage: string, side: Side): { restart: boolean; continue: boolean; respec: boolean; reopen: boolean; full: boolean; debt: boolean } {
  const options = { restart: flag(args, 'restart'), continue: flag(args, 'continue'), respec: flag(args, 'respec'), reopen: flag(args, 'reopen'), full: flag(args, 'full'), debt: flag(args, 'debt') };
  if (Object.values(options).filter(Boolean).length > 1) throw new OgwError(`usage: ${usage}`);
  if ((options.full || options.debt) && str(args, 'since') !== undefined) throw new OgwError(`usage: ${usage}`);
  if (options.full && side !== 'core') throw new OgwError(`usage: ${usage}`);
  return options;
}

export const next: CommandDef = {
  name: ['review', 'next'],
  usage: `ogw review next core <target> [--since <commit>|--full|--debt] [--restart|--respec|--continue|--reopen] | ${NEXT_TOOL_USAGE}`,
  options: { restart: { type: 'boolean' }, respec: { type: 'boolean' }, continue: { type: 'boolean' }, reopen: { type: 'boolean' }, full: { type: 'boolean' }, debt: { type: 'boolean' }, since: { type: 'string' }, definition: { type: 'string', multiple: true } },
  async run(ctx, args) {
    const { side, target } = sideAndTarget(args, this.usage);
    const since = str(args, 'since');
    return reviewNext(ctx, side, target, {
      ...restartOrContinue(args, this.usage, side),
      ...(since === undefined ? {} : { since }),
      definitions: list(args, 'definition'),
    });
  },
};
