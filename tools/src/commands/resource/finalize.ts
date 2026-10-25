import { list, positional, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { finalizeResource, type FinalizeResult } from './lib/finalize.ts';

function text(result: FinalizeResult): string {
  const lines = Object.entries(result.changed).map(([column, value]) => `${column}=${value}`);
  for (const l of result.loudness ?? []) {
    lines.push(`${l.file} integrated loudness ${String(l.integratedLufs)} LUFS, true peak ${String(l.truePeakDbtp)} dBTP`);
  }
  return lines.join('\n');
}

/** `ogw resource finalize <game> <key> --method <method> --file <path>... [...]`. */
export const finalize: CommandDef = {
  name: ['resource', 'finalize'],
  usage:
    'ogw resource finalize <game> <key> --method <method> --file <path>... [--inputs <key>...] [--bus <Sfx|Ui>] [--music <file>] [--manifest <file>] [--skeleton <file> --split <file>]',
  options: {
    method: { type: 'string' },
    file: { type: 'string', multiple: true },
    inputs: { type: 'string', multiple: true },
    bus: { type: 'string' },
    music: { type: 'string' },
    manifest: { type: 'string' },
    skeleton: { type: 'string' },
    split: { type: 'string' },
  },
  async run(ctx, args) {
    const method = str(args, 'method');
    const files = list(args, 'file');
    if (args.positionals.length !== 2 || method === undefined || files.length === 0) throw new OgwError(`usage: ${this.usage}`);
    const game = await ctx.game(positional(args, 0, 'game'));
    const result = await finalizeResource(ctx, game, {
      key: positional(args, 1, 'resource key'),
      method,
      files,
      inputs: list(args, 'inputs'),
      bus: str(args, 'bus') ?? null,
      music: str(args, 'music') ?? null,
      manifest: str(args, 'manifest') ?? null,
      skeleton: str(args, 'skeleton') ?? null,
      split: str(args, 'split') ?? null,
    });
    return { text: text(result), data: result };
  },
};
