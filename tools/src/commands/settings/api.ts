import type { Context } from '../../lib/command.ts';
import { agentContext } from '../../lib/agentctx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { loadGameSettings, type GameSettings, type Role } from '../../lib/settings.ts';
import { writeChecked } from './lib/change.ts';
import { buildStageMissing, gameIssues, type CheckStage, type EnvName } from './lib/game-check.ts';
import type { JsonObject } from './lib/json-path.ts';
import { harnessTarget } from './lib/target.ts';

export { gameSettingsValue } from './lib/game-check.ts';

/**
 * Errors of `ogw game check` for these game settings (or the checkout's file); empty when it passes. `stage` `build`
 * also needs the build stage values (`ogw game check --build`, `ogw build start`).
 */
export async function gameCheckErrors(ctx: Context, game: GameRepo, settings?: GameSettings, stage: CheckStage = 'setup'): Promise<string[]> {
  const value = settings ?? (await loadGameSettings(game.root));
  return (await gameIssues(ctx, game.name, value, true, stage)).map((issue) => issue.message);
}

/** Role of the caller: the role of the agent `ogw agent` started, or `lead`. */
export async function callerRole(ctx: Context): Promise<Role | 'lead'> {
  const agent = await agentContext(ctx.env);
  return agent ? agent.meta.role : 'lead';
}

/**
 * Writes harness settings `next` after the checks of `ogw settings set` (schema, caller role).
 * `allowTool` also lets paths whose `x-owner` is `tool` change (`ogw env propose --apply`).
 */
export async function writeHarnessSettings(ctx: Context, next: JsonObject, options: { allowTool?: boolean } = {}): Promise<void> {
  await writeChecked(ctx, await harnessTarget(ctx), next, options);
}

/** Messages of the missing build stage values of the settings for a build of `env` (`ogw build start`). */
export async function buildStageMissingErrors(ctx: Context, game: string, settings: GameSettings, env: EnvName): Promise<string[]> {
  return (await buildStageMissing(ctx, game, settings, env)).map((issue) => issue.message);
}
