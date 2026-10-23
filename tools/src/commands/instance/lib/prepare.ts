import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { importClientIfMissing } from '../../check/lib/engine.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readJson, readJsonIfExists, readText, writeJsonAtomic } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { gitDir, head, statusLines } from '../../../lib/git.ts';
import { loadSchema, schemaPath, type HarnessSettings, type GameSettings } from '../../../lib/settings.ts';
import { coreReleaseOfGame, extractedAsset } from '../../core/api.ts';
import { binaryBuild } from '../../data/lib/binary-build.ts';
import { requireEngine } from '../../env/api.ts';
import { gameModules, mergedCoreSettings, runGenerate } from '../../generate/api.ts';
import { boolCell, intCell, readTable } from './csv.ts';
import { renderingMethod } from './launch.ts';
import type { InstancePlan, MatchModeRow } from './records.ts';
import { FixtureError, parseFixture } from './steps.ts';

/** Marker of the last successful `ogw generate` and data tool binary build the runner did in a checkout. */
const MARKER = 'ogw-instance-generated.json';

/**
 * Runs `ogw generate` and the data tool binary build, unless (without `--commit`) both last succeeded at
 * the HEAD commit of the checkout and `git status` shows no change. Returns whether they ran.
 * The marker is kept only for a run on a tree without changes, so a run on changes that were later
 * discarded is never taken for a run at HEAD.
 */
export async function generateIfNeeded(ctx: Context, checkout: GameRepo, fresh: boolean): Promise<boolean> {
  const git = !fresh || exists(join(checkout.root, '.git'));
  const marker = git ? join(await gitDir(checkout.root, { env: ctx.env }), MARKER) : null;
  const commit = git ? await head(checkout.root, { env: ctx.env }) : '';
  const clean = git && (await statusLines(checkout.root, { env: ctx.env })).length === 0;
  if (!fresh && marker !== null && clean) {
    const last = await readJsonIfExists<{ head?: string }>(marker);
    if (last?.head === commit) return false;
  }
  if (marker !== null) await rm(marker, { force: true });
  await runGenerate(ctx, checkout);
  await binaryBuild(ctx, checkout);
  if (marker !== null && clean) await writeJsonAtomic(marker, { head: commit });
  return true;
}

/**
 * The one engine import of a checkout before its first dev run (client-content engines/godot `## dev run`):
 * `godot --headless --path client --import` when `client/.godot/` is missing. Returns whether it ran.
 */
export async function importIfNeeded(ctx: Context, plan: { engine: string; enginePath: string }, root: string): Promise<boolean> {
  if (plan.engine !== 'godot') throw new OgwError(`not defined: the dev run of engine ${plan.engine}`);
  const client = join(root, 'client');
  if (exists(join(client, '.godot'))) return false;
  // the one locked import of the checkout (`ogw check` shares it): a failed import leaves no `.godot/`
  const { ran, failed } = await importClientIfMissing(ctx, plan.enginePath, root);
  if (failed !== null) throw new OgwError(`${failed}: ${client}`);
  return ran;
}

/** Engine executable of the engine version of the game's core release (`engine.json` of `client-<engine>.zip`). */
export async function engineExecutable(ctx: Context, checkout: GameRepo, engine: string): Promise<string> {
  const release = await coreReleaseOfGame(ctx, checkout);
  const dir = await extractedAsset(ctx, release, `client-${engine}.zip`);
  const engineJson = await readJson<Record<string, unknown>>(join(dir, 'engine.json'));
  const version = engineJson[engine];
  if (typeof version !== 'string' || version === '') throw new OgwError(`engine.json of core ${release.version} has no ${engine} version`);
  return requireEngine(ctx, engine, version);
}

/** Rows of `data/tables/match_mode.csv`. */
export async function matchModes(root: string): Promise<MatchModeRow[]> {
  const table = await readTable(root, 'match_mode');
  return table.rows.map((row) => ({
    id: row.id ?? '',
    minPlayers: intCell('match_mode', row, 'min_players') ?? 0,
    maxPartySize: intCell('match_mode', row, 'max_party_size') ?? 0,
    allowQueue: boolCell('match_mode', row, 'allow_queue'),
    allowRoom: boolCell('match_mode', row, 'allow_room'),
  }));
}

/** One opponent bot client per `min_players` − 1 of each `match_mode` row, rows in file order. */
export function opponentRows(rows: readonly MatchModeRow[]): MatchModeRow[] {
  return rows.flatMap((row) => Array.from({ length: Math.max(0, row.minPlayers - 1) }, () => row));
}

export function concurrencyLimit(settings: HarnessSettings): number {
  const max = settings.maxConcurrentInstances;
  if (max === null) throw new OgwError('harness settings maxConcurrentInstances is null: run update env first');
  if (max < 2) throw new OgwError(`harness settings maxConcurrentInstances must be 2 or more: ${String(max)}`);
  if (settings.playInstances > max) {
    throw new OgwError(`harness settings playInstances (${String(settings.playInstances)}) is more than maxConcurrentInstances (${String(max)})`);
  }
  return max;
}

export function instancePlatform(settings: GameSettings, given: string | undefined): string {
  if (given !== undefined) return given;
  const first = settings.buildPlatforms?.[0];
  if (!first) throw new OgwError('game settings buildPlatforms is empty: give --platform');
  return first;
}

async function readFixture(path: string): Promise<string> {
  return readText(path).catch((error: unknown) => {
    throw new FixtureError((error as Error).message);
  });
}

export interface PlanInput {
  checkout: GameRepo;
  settings: HarnessSettings;
  gameSettings: GameSettings;
  platform: string;
  client: InstancePlan['client'];
  db: 'postgresql' | undefined;
  fixture: string | undefined;
}

function integerSetting(core: Record<string, unknown>, key: string): number | null {
  const value = core[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** Game settings `targetFps`, or its game settings JSON schema default when the game does not set it. */
export async function gameTargetFps(env: NodeJS.ProcessEnv, settings: GameSettings): Promise<number> {
  if (typeof settings.targetFps === 'number') return settings.targetFps;
  const schema = (await loadSchema(schemaPath('game-settings', env))) as { properties?: { targetFps?: { default?: number } } };
  const fps = schema.properties?.targetFps?.default;
  if (typeof fps !== 'number') throw new OgwError('game settings schema has no targetFps default');
  return fps;
}

/** Decides everything the supervisor needs. */
export async function makePlan(ctx: Context, input: PlanInput): Promise<InstancePlan> {
  const engine = input.gameSettings.engine;
  if (typeof engine !== 'string' || engine === '') throw new OgwError('game settings has no engine');
  const method = renderingMethod(engine, input.platform);
  const fixture = input.fixture === undefined ? null : parseFixture(await readFixture(input.fixture));
  const modules = await gameModules(ctx, input.checkout);
  const realtime = modules.client.includes('RealtimeCore');
  const core = await mergedCoreSettings(ctx, input.checkout);
  const commandTimeoutMs = core['QACore.commandTimeoutMs'];
  if (typeof commandTimeoutMs !== 'number') throw new OgwError('core settings has no QACore.commandTimeoutMs');
  const pg = input.settings.tools.postgresql;
  return {
    engine,
    enginePath: await engineExecutable(ctx, input.checkout, engine),
    renderingMethod: method,
    client: input.client,
    db: input.db ?? 'sqlite',
    postgresImage: input.db === 'postgresql' ? `postgres:${pg.tag}@${pg.digest}` : null,
    realtime,
    social: ['friend', 'guild', 'chat'].some((m) => modules.server.includes(m)),
    populate: exists(join(input.checkout.root, 'server', 'dev', 'populate.ts')),
    opponents: realtime ? opponentRows(await matchModes(input.checkout.root)) : [],
    fixture,
    commandTimeoutMs,
    videoMaxMs: integerSetting(core, 'QACore.videoMaxMs'),
    feedbackWindowMs: integerSetting(core, 'QACore.feedbackWindowMs'),
    targetFps: await gameTargetFps(ctx.env, input.gameSettings),
  };
}
