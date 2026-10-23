import { positional, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { firstFinal } from './lib/first-final.ts';

/** `ogw resource first-final <game> (--name <name> | --speaker <speaker>)`. Changes nothing. */
export const firstFinalCommand: CommandDef = {
  name: ['resource', 'first-final'],
  usage: 'ogw resource first-final <game> (--name <name> | --speaker <speaker>)',
  options: { name: { type: 'string' }, speaker: { type: 'string' } },
  async run(ctx, args) {
    const name = str(args, 'name');
    const speaker = str(args, 'speaker');
    if (args.positionals.length !== 1 || (name === undefined) === (speaker === undefined)) throw new OgwError(`usage: ${this.usage}`);
    const game = await ctx.game(positional(args, 0, 'game'));
    const found = await firstFinal(game, name !== undefined ? { name } : { speaker: speaker as string }, ctx.env);
    if (!found) return { text: 'none', data: { key: null, files: [] } };
    return { text: [found.key, ...found.files].join('\n'), data: found };
  },
};
