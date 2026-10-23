import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { readJson } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { loadSchema, schemaPath } from '../../../lib/settings.ts';
import { coreReleaseOfGame, type CoreRelease } from '../../core/api.ts';
import { gameModules } from '../../generate/api.ts';
import { gameSettingsWithDefaults } from './buildrun.ts';
import type { Env } from './names.ts';
import { workingTree } from './repo.ts';
import type { CoreSpecModule, SettingsCheckInput } from './settingschecks.ts';

/** Adapter keys of the game settings schema whose enum has a name ending with `-sandbox`. */
export async function sandboxAdapterKeys(env: NodeJS.ProcessEnv): Promise<string[]> {
  const schema = (await loadSchema(schemaPath('game-settings', env))) as {
    $defs?: { environment?: { properties?: { adapters?: { properties?: Record<string, { enum?: string[] }> } } } };
  };
  const adapters = schema.$defs?.environment?.properties?.adapters?.properties ?? {};
  return Object.entries(adapters)
    .filter(([, def]) => (def.enum ?? []).some((name) => name.endsWith('-sandbox')))
    .map(([key]) => key);
}

export async function readCoreSpec(release: CoreRelease): Promise<CoreSpecModule[]> {
  const spec = await readJson<{ modules?: CoreSpecModule[] }>(join(release.dir, 'core-spec.json'));
  return spec.modules ?? [];
}

/** Inputs of the settings-based build-time checks for the checkout `game.root`. */
export async function settingsCheckInput(ctx: Context, game: GameRepo, env: Env, platforms: string[]): Promise<SettingsCheckInput> {
  const settings = await gameSettingsWithDefaults(game.root, ctx.env);
  const modules = await gameModules(ctx, game);
  const release = await coreReleaseOfGame(ctx, game);
  return {
    env,
    platforms,
    settings,
    reader: workingTree(game.root),
    modules: [...modules.client, ...modules.server],
    coreSpec: await readCoreSpec(release),
    sandboxKeys: await sandboxAdapterKeys(ctx.env),
  };
}
