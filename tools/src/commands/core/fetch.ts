import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { LIMITS } from '../../lib/limits.ts';
import { fetchCoreRelease, gameCoreVersion } from './api.ts';

/** `ogw core fetch <game>`: the game's core version release in `open-game-works-core-releases/`, hash-checked. */
export const fetchCommand: CommandDef = {
  name: ['core', 'fetch'],
  usage: 'ogw core fetch <game>',
  background: {
    game: (args) => args.positionals[0] ?? null,
    timeLimitMs: () => LIMITS.jobMs,
  },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const game = await ctx.game(positional(args, 0, 'game'));
    const release = await fetchCoreRelease(ctx, await gameCoreVersion(game));
    const where = release.local ? `built from open-game-works-core-impl/ in ${release.dir}` : release.dir;
    return {
      text: `core ${release.version}: ${where}`,
      data: { version: release.version, dir: release.dir, local: release.local },
    };
  },
};
