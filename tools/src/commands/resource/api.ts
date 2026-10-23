import type { Context } from '../../lib/command.ts';
import type { GameRepo } from '../../lib/game.ts';
import { requestResources } from './lib/request.ts';

export { isRequestFileName, requestPlace } from './lib/request.ts';
import { runSync } from './lib/sync.ts';

/** `ogw resource request <game> --pending`. Returns the request file path, or null when nothing was pending. */
export async function requestPendingResources(ctx: Context, game: GameRepo): Promise<string | null> {
  return (await requestResources(game, { keys: 'pending', see: [], base: null, retryLimit: (await ctx.settings()).backgroundRetryLimit }, ctx.env)).path;
}

/** `ogw resource sync <game>` on the checkout `game.root`. */
export async function syncResources(ctx: Context, game: GameRepo): Promise<void> {
  await runSync(ctx, game);
}
