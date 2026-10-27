import { expectPositionals, flag, positional, type CommandDef } from '../../lib/command.ts';
import type { Context } from '../../lib/command.ts';
import type { GameRepo } from '../../lib/game.ts';
import { harnessRoot } from '../../lib/paths.ts';
import { loadGameSettings, type GameSettings } from '../../lib/settings.ts';
import { nativePluginProblems, releaseModules } from '../build/lib/native-plugins.ts';
import { coreRelease } from '../core/api.ts';
import { requireSupportedCore } from '../core/lib/harness-core.ts';
import { gameCheckErrors } from '../settings/api.ts';
import { defaultsText, defaultValues } from './lib/defaults.ts';
import { humanPrep, humanPrepText } from './lib/human-prep.ts';

/** Check `native plugin` of STG and PROD builds of every `buildPlatforms` platform (`build` engines/godot.md `## native plugin`). */
async function nativePluginErrors(ctx: Context, game: GameRepo, settings: GameSettings): Promise<string[]> {
  if (typeof settings.coreVersion !== 'string') return [];
  await requireSupportedCore(ctx, game.name, settings.coreVersion);
  const release = await coreRelease(ctx, settings.coreVersion);
  const platforms = Array.isArray(settings.buildPlatforms) ? settings.buildPlatforms : [];
  const modules = releaseModules(release, settings);
  const errors: string[] = [];
  for (const env of ['STG', 'PROD'] as const) {
    errors.push(...(await nativePluginProblems(ctx, release, settings, env, platforms, modules)).map((line) => `native plugin: ${line}`));
  }
  return errors;
}

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
      const build = flag(args, 'build');
      const errors = await gameCheckErrors(ctx, game, undefined, build ? 'build' : 'setup');
      // after the other checks pass: a core version or a coreModules name the release does not have fails there first
      if (build && errors.length === 0) errors.push(...(await nativePluginErrors(ctx, game, await loadGameSettings(game.root))));
      return errors.length > 0 ? { exitCode: 1, text: errors.join('\n'), data: { errors } } : { text: 'pass', data: { errors } };
    }
    const settings = await loadGameSettings(game.root);
    const parts: string[] = [];
    const data: Record<string, unknown> = {};
    if (wantsDefaults) {
      const defaults = await defaultValues(ctx, game.name, settings);
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
