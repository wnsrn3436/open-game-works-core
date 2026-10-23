import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { runSync, syncText } from './lib/sync.ts';

export function syncCommand(word: 'sync' | 'placeholder'): CommandDef {
  return {
    name: ['resource', word],
    usage: `ogw resource ${word} <game>`,
    async run(ctx, args) {
      expectPositionals(args, 1, 1, this.usage);
      const game = await ctx.game(positional(args, 0, 'game'));
      const result = await runSync(ctx, game);
      return { text: syncText(result), data: { files: result.files, rows: result.rows } };
    },
  };
}

/** `ogw resource sync <game>`. */
export const sync = syncCommand('sync');
