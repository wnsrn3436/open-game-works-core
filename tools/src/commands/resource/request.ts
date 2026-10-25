import { flag, list, positional, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { requestResources } from './lib/request.ts';
import { MIN_NINE_SLICE_SIDE } from './lib/spec.ts';

/** `ogw resource request <game> (<key>... | --pending) [--see <key>...] [--base <key>]`. */
export const request: CommandDef = {
  name: ['resource', 'request'],
  usage: 'ogw resource request <game> (<key>... | --pending) [--see <key>...] [--base <key>]',
  options: { pending: { type: 'boolean' }, see: { type: 'string', multiple: true }, base: { type: 'string' } },
  async run(ctx, args) {
    const game = await ctx.game(positional(args, 0, 'game'));
    const keys = args.positionals.slice(1);
    const pending = flag(args, 'pending');
    if (pending === (keys.length > 0)) throw new OgwError(`usage: ${this.usage}`);
    const result = await requestResources(game, { keys: pending ? 'pending' : keys, see: list(args, 'see'), base: str(args, 'base') ?? null, retryLimit: (await ctx.settings()).backgroundRetryLimit }, ctx.env);
    const leftOut = result.leftOut.map((key) => `left out ${key}: the long side of a nine_slice size is under ${String(MIN_NINE_SLICE_SIDE)}`);
    const text = [result.path ?? 'no pending resource', ...leftOut].join('\n');
    return { text, data: { path: result.path, keys: result.keys, leftOut: result.leftOut } };
  },
};
