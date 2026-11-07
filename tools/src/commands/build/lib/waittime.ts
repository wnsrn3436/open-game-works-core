import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { showFile } from '../../../lib/git.ts';
import { coreRelease, gameCoreVersionAt } from '../../core/api.ts';
import { mergeReleaseSettings } from '../../generate/api.ts';
import { dataRows, parseDuration } from './csv.ts';

/** A core settings value by `<module>.<key>`, whether the settings are flat or nested by module. */
export function coreValue(settings: Record<string, unknown>, key: string): unknown {
  if (key in settings) return settings[key];
  const dot = key.indexOf('.');
  const module = settings[key.slice(0, dot)];
  return typeof module === 'object' && module !== null ? (module as Record<string, unknown>)[key.slice(dot + 1)] : undefined;
}

function numberValue(settings: Record<string, unknown>, key: string): number {
  const value = coreValue(settings, key);
  if (typeof value !== 'number') throw new OgwError(`core settings ${key} is missing`);
  return value;
}

function durations(text: string | null, columns: string[], table: string): number[] {
  return dataRows(text ?? '').map((row) =>
    columns.reduce((sum, column) => {
      const ms = parseDuration(row[column] ?? '');
      if (ms === null) throw new OgwError(`data/tables/${table}.csv ${row.id ?? ''}: ${column} is not a duration`);
      return sum + ms;
    }, 0),
  );
}

/**
 * The merged core settings of a commit, read from git: the `core-settings.json` of the release of its game settings
 * `coreVersion`, overlaid with its game settings `core`.
 */
async function coreSettingsAt(ctx: Context, game: GameRepo, commit: string): Promise<Record<string, unknown>> {
  // it fails on a commit without settings.json or with one that is not JSON
  const release = await coreRelease(ctx, await gameCoreVersionAt(game, commit));
  const bytes = (await showFile(game.root, commit, 'settings.json', { env: ctx.env })) ?? Buffer.from('{}');
  return mergeReleaseSettings(release.dir, (JSON.parse(bytes.toString('utf8')) as { core?: unknown }).core);
}

/**
 * Match wait ms of `build` `## deploy` PROD 3, from the data and the merged core settings of the last PROD build
 * commit, both read from git. Null when the server uses neither `play-session` nor `matchmaker`.
 */
export async function matchWaitMs(ctx: Context, game: GameRepo, lastProdCommit: string, serverModules: readonly string[]): Promise<number | null> {
  const play = serverModules.includes('play-session');
  const match = serverModules.includes('matchmaker');
  if (!play && !match) return null;
  const core = await coreSettingsAt(ctx, game, lastProdCommit);
  const read = async (table: string): Promise<string | null> => (await showFile(game.root, lastProdCommit, `data/tables/${table}.csv`, { env: ctx.env }))?.toString('utf8') ?? null;
  const values: number[] = [];
  if (play) values.push(...durations(await read('play_session_mode'), ['max_duration'], 'play_session_mode'));
  if (match) {
    const margin = numberValue(core, 'matchmaker.reportMarginMs');
    values.push(...durations(await read('match_mode'), ['prepare_time', 'max_duration'], 'match_mode').map((ms) => ms + margin));
  }
  return Math.max(0, ...values) + numberValue(core, 'admin-api.switchCacheMs');
}
