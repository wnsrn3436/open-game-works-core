import { expectPositionals, flag, positional, type CommandDef } from '../../lib/command.ts';
import { harnessRoot } from '../../lib/paths.ts';
import { loadGameSettings } from '../../lib/settings.ts';
import { gameCheckErrors } from '../settings/api.ts';
import { defaultsText, defaultValues } from './lib/defaults.ts';
import { humanPrep, humanPrepText } from './lib/human-prep.ts';

export const check: CommandDef = {
  name: ['game', 'check'],
  usage: 'ogw game check <game> [--build] [--defaults] [--human-prep]',
  options: { build: { type: 'boolean' }, defaults: { type: 'boolean' }, 'human-prep': { type: 'boolean' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const game = await ctx.game(positional(args, 0, 'game'));
    const wantsDefaults = flag(args, 'defaults');
    const wantsPrep = flag(args, 'human-prep');
    if (!wantsDefaults && !wantsPrep) {
      const errors = await gameCheckErrors(ctx, game, undefined, flag(args, 'build') ? 'build' : 'setup');
      return errors.length > 0 ? { exitCode: 1, text: errors.join('\n'), data: { errors } } : { text: 'pass', data: { errors } };
    }
    const settings = await loadGameSettings(game.root);
    const parts: string[] = [];
    const data: Record<string, unknown> = {};
    if (wantsDefaults) {
      const defaults = await defaultValues(ctx, settings);
      parts.push(defaultsText(defaults));
      data.defaults = defaults;
    }
    if (wantsPrep) {
      const prep = await humanPrep(harnessRoot(ctx.env), settings);
      parts.push(humanPrepText(prep));
      data.humanPrep = prep;
    }
    return { text: parts.join('\n\n'), data };
  },
};
