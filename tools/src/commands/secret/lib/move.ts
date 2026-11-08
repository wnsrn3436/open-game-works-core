import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { exists } from '../../../lib/fsx.ts';
import { gameSecretService, harnessSecretService } from '../../../lib/secrets.ts';
import { gameSettingsPath, loadGameSettings } from '../../../lib/settings.ts';
import { harnessSecretNames, SCOPES, scopeSecretNames } from './names.ts';

/**
 * The secret store services of every secret that harness settings and the game settings under `paths.games` name. A
 * game without game settings names none; game settings that cannot be read or are not JSON fail, so that the move is not
 * recorded as done without their secrets.
 */
export async function knownSecretServices(ctx: Context): Promise<string[]> {
  const services = harnessSecretNames(await ctx.settings()).map(harnessSecretService);
  const { games } = await ctx.workspace();
  if (exists(games)) {
    const folders = (await readdir(games, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    for (const game of folders) {
      const root = join(games, game);
      if (!exists(gameSettingsPath(root))) continue;
      const settings = await loadGameSettings(root);
      for (const scope of SCOPES) for (const name of scopeSecretNames(settings, scope)) services.push(gameSecretService(game, scope, name));
    }
  }
  return [...new Set(services)];
}

/**
 * Moves every known secret still in the old store of this host (the login keychain, the Secret Service) into the
 * secret store (`tools/ogw.md` `## secret store`). Only the first run on a host moves; later runs read no store and no
 * game settings.
 */
export async function moveOldSecrets(ctx: Context): Promise<void> {
  const store = ctx.secrets;
  if (store.moveOld === undefined || store.oldMoved?.() === true) return;
  store.moveOld(await knownSecretServices(ctx));
}
