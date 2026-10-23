import { expectPositionals, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import type { GameRepo } from '../../lib/game.ts';
import { runData, type DataRun } from '../data/api.ts';
import { checkLanguage, formatTodo, GLOSSARY_PATH, readTable, todoOf, translationPath } from './lib/files.ts';

/** Runs `ogw data`; fails with its data check lines when it fails. */
export async function dataOrFail(ctx: Context, game: GameRepo): Promise<DataRun> {
  const result = await runData(ctx, game);
  if (result.exitCode !== 0) {
    const detail = [...result.lines.map((line) => line.text), result.stderr.trimEnd()].filter((l) => l !== '');
    throw new OgwError(['ogw data failed', ...detail].join('\n'), 1, result);
  }
  return result;
}

export const todo: CommandDef = {
  name: ['translation', 'todo'],
  usage: 'ogw translation todo <game> <language>',
  async run(ctx, args) {
    expectPositionals(args, 2, 2, this.usage);
    const game = await ctx.game(positional(args, 0, 'game'));
    const language = positional(args, 1, 'language');
    await checkLanguage(ctx, game, language);
    await dataOrFail(ctx, game);
    const result = todoOf(await readTable(game.root, translationPath(language)), await readTable(game.root, GLOSSARY_PATH), language);
    return { text: formatTodo(result), data: result };
  },
};
