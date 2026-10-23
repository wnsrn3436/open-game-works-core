// Generation group API for other groups: the `## method` rule of `skills/resource/production.md` and the catalog listing.
import type { Context } from '../../lib/command.ts';
import type { GameRepo } from '../../lib/game.ts';
import { chooseMethods, type MethodChoice } from './lib/select.ts';
import { catalogEntries as listCatalog, type CatalogFile } from './list.ts';

export type { CatalogFile, MethodChoice };

/** Methods a resource key can use and the stage of each, as `ogw generation methods <game> <key>` gives them. */
export async function generationMethods(ctx: Context, game: GameRepo, resourceKey: string): Promise<MethodChoice[]> {
  return chooseMethods(ctx, await ctx.settings(), game, resourceKey);
}

/** Files of a catalog method with path, license, source URL, attribution and character set, as `ogw generation list <method>` gives them. */
export function catalogEntries(ctx: Context, method: string): Promise<CatalogFile[]> {
  return listCatalog(ctx, method);
}
