import { expectPositionals, type CommandDef } from '../../lib/command.ts';
import { writeChecked } from './lib/change.ts';
import { display, unsetAt } from './lib/json-path.ts';
import { parsePath, withTarget } from './lib/target.ts';

export const unset: CommandDef = {
  name: ['settings', 'unset'],
  usage: 'ogw settings unset <harness|game <game>|core> <path>',
  async run(ctx, args) {
    const usage = this.usage;
    return withTarget(ctx, args.positionals, usage, async ({ target, rest }) => {
      expectPositionals({ ...args, positionals: rest }, 1, 1, usage);
      const segments = await parsePath(target, rest[0] as string);
      const path = display(segments);
      const next = unsetAt(target.value, segments);
      if (next === null) return { text: `${path} is not set`, data: { path, changed: false } };
      await writeChecked(ctx, target, next, { unsetPath: path });
      return { text: `unset ${path}`, data: { path, changed: true } };
    });
  },
};
