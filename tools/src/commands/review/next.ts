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
 * `--respec`, `--full` and `--debt` of `review next` and `review run`: they exclude each other, `--full` and `--debt`
 * exclude `--since`, and `--full` takes a core target only.
 */
export function reviewOptions(args: CommandArgs, usage: string, side: Side): { respec: boolean; full: boolean; debt: boolean } {
  const options = { respec: flag(args, 'respec'), full: flag(args, 'full'), debt: flag(args, 'debt') };
  const given = Object.entries(options).flatMap(([name, on]) => (on ? [`--${name}`] : []));
  const refuse = (why: string): never => {
    throw new OgwError(`${why}\nusage: ${usage}`);
  };
  if (given.length > 1) refuse(`${given.join(' and ')} exclude each other: give one of --respec, --full, --debt`);
  if ((options.full || options.debt) && str(args, 'since') !== undefined) refuse(`--since and ${options.full ? '--full' : '--debt'} exclude each other`);
  if (options.full && side !== 'core') refuse('--full is for a core target');
  return options;
}

export const next: CommandDef = {
  name: ['review', 'next'],
  usage: `ogw review next core <target> [--full|--debt|[--since <commit>] [--respec]] | ${NEXT_TOOL_USAGE}`,
  options: { respec: { type: 'boolean' }, full: { type: 'boolean' }, debt: { type: 'boolean' }, since: { type: 'string' }, definition: { type: 'string', multiple: true } },
  async run(ctx, args) {
    const { side, target } = sideAndTarget(args, this.usage);
    const since = str(args, 'since');
    return reviewNext(ctx, side, target, {
      ...reviewOptions(args, this.usage, side),
      ...(since === undefined ? {} : { since }),
      definitions: list(args, 'definition'),
    });
  },
};
