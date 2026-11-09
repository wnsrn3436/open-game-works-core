import { str, type CommandArgs, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { reviewRun, RUN_TIME_LIMIT_MS } from './lib/run.ts';
import { reviewOptions, sideAndTarget } from './next.ts';

export const run: CommandDef = {
  name: ['review', 'run'],
  usage: 'ogw review run core <target> [--full|--debt|[--since <commit>] [--respec]]',
  options: { respec: { type: 'boolean' }, full: { type: 'boolean' }, debt: { type: 'boolean' }, since: { type: 'string' } },
  background: {
    timeLimitMs: () => RUN_TIME_LIMIT_MS,
    // the options are refused before the job starts (ogw.md `## review run`)
    validate: (_ctx, args) => {
      runOptions(args, run.usage);
      return Promise.resolve();
    },
  },
  async run(ctx, args) {
    const { target, options } = runOptions(args, this.usage);
    const since = str(args, 'since');
    return reviewRun(ctx, target, { ...options, ...(since === undefined ? {} : { since }) });
  },
};

/** The target and the options of `ogw review run`, or a refusal. */
function runOptions(args: CommandArgs, usage: string): { target: string; options: ReturnType<typeof reviewOptions> } {
  const { side, target } = sideAndTarget(args, usage);
  if (side !== 'core') throw new OgwError(`usage: ${usage}`);
  return { target, options: reviewOptions(args, usage, side) };
}
