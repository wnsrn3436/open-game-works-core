import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists, formatJson, readJson } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { checkoutLock } from '../../lib/git.ts';
import { isPlainObject, mergeSettings, type JsonObject } from '../../lib/json.ts';
import { withLock } from '../../lib/lock.ts';
import { loadGameSettings, loadSchema, schemaPath, type GameSettings } from '../../lib/settings.ts';
import { coreReleaseOfGame, extractedAsset, type CoreRelease } from '../core/api.ts';
import { gutPackage, isCorePlugin, packageDir, pluginsFor } from '../core/lib/engine-packages.ts';
import { hostPlatform, type EngineJson } from '../core/lib/impl.ts';
import { applyPlan, emptyPlan, type Applied, type Plan } from './lib/apply.ts';
import { clientModuleTableOrder, devCodeModules, moduleListOrder, readCoreSpec, usedModules, type CoreSpec, type SpecModule } from './lib/core-spec.ts';
import { coreGameValues, coreSettingTypes } from './lib/core-settings.ts';
import { BOOT_GD, BOOT_TSCN, CLIENT_GITIGNORE, coreModulesGd, devFeatures, devRegistration, RESOURCE_LIST_IMPORT } from './lib/godot-files.ts';
import { contentSettings, projectGodot } from './lib/project.ts';
import { gameLicenses, godotResourceKeys, readResourceRows, resourceKeyGd, resourceKeyTs, type ResourceRow } from './lib/resources.ts';
import { simulationTables, tableNames, tickChangedVersions } from './lib/sim.ts';

export { resourceKeyPaths, type ResourceKeyEntry } from './lib/resources.ts';

/** Release `core-settings.json` with a game settings `core` object over it. */
export async function mergeReleaseSettings(releaseDir: string, gameCore: unknown): Promise<JsonObject> {
  const path = join(releaseDir, 'core-settings.json');
  const base = await readJson(path);
  if (!isPlainObject(base)) throw new OgwError(`core settings file is not a JSON object: ${path}`);
  return mergeSettings(base, isPlainObject(gameCore) ? gameCore : {});
}

/** Merged core settings values of the checkout: release `core-settings.json` overlaid with game settings `core`. */
export async function mergedCoreSettings(ctx: Context, game: GameRepo): Promise<Record<string, unknown>> {
  const settings = await loadGameSettings(game.root);
  return mergeReleaseSettings((await coreReleaseOfGame(ctx, game)).dir, settings.core);
}

/** Module names of a used-module list split by side, each in byte order. */
export function splitModules(modules: readonly SpecModule[]): { client: string[]; server: string[] } {
  return {
    client: modules.filter((m) => m.side === 'client').map((m) => m.name),
    server: modules.filter((m) => m.side === 'server').map((m) => m.name),
  };
}

/** Modules the game uses (`core` skill `## module`): the chosen modules and their dependency closure. */
export async function gameModules(ctx: Context, game: GameRepo): Promise<{ client: string[]; server: string[] }> {
  const settings = await loadGameSettings(game.root);
  const spec = await readCoreSpec((await coreReleaseOfGame(ctx, game)).dir);
  return splitModules(usedModules(spec, settings));
}

/** `core-spec.json` of the game settings `coreVersion` release of the checkout. */
export async function gameCoreSpec(ctx: Context, game: GameRepo): Promise<CoreSpec> {
  return readCoreSpec((await coreReleaseOfGame(ctx, game)).dir);
}

interface Inputs {
  root: string;
  settings: GameSettings;
  release: CoreRelease;
  spec: CoreSpec;
  /** The modules the game uses. */
  modules: SpecModule[];
  /** The used modules and their DEV modules (`core` skill `## module`): `ogw generate` writes for a dev run. */
  devModules: SpecModule[];
  resources: ResourceRow[];
}

/** GUT and the `engine.json` plugins whose `platforms` hold this host OS, put into `client/`. */
async function enginePackages(ctx: Context, inputs: Inputs, engine: string, clientDir: string, plan: Plan): Promise<void> {
  const engineJson = await readJson<EngineJson>(join(clientDir, 'engine.json'));
  plan.overlays.push({ source: await packageDir(ctx, gutPackage(engineJson)), target: 'client' });
  const platform = hostPlatform();
  for (const plugin of pluginsFor(engineJson, platform)) {
    if (!isCorePlugin(plugin)) {
      plan.overlays.push({ source: await packageDir(ctx, plugin), target: 'client' });
      continue;
    }
    const plugins = await extractedAsset(ctx, inputs.release, `client-${engine}-plugins.zip`);
    const source = join(plugins, plugin.name, platform);
    if (!exists(source)) throw new OgwError(`client-${engine}-plugins.zip of core ${inputs.release.version} has no ${plugin.name}/${platform}/`);
    plan.overlays.push({ source, target: 'client' });
  }
}

async function coreFolders(ctx: Context, inputs: Inputs, engine: string, plan: Plan): Promise<void> {
  const client = await extractedAsset(ctx, inputs.release, `client-${engine}.zip`);
  plan.mirrors.push({ source: join(client, 'core'), target: 'client/core' });
  plan.mirrors.push({ source: await extractedAsset(ctx, inputs.release, 'server.tgz'), target: 'server/core' });
  await enginePackages(ctx, inputs, engine, client, plan);
}

/**
 * The contents of a core settings file (`client-core` Godot `## folder`): the core settings of `settingsDir`'s
 * `core-settings.json` without `$schema`, the game settings `core` over them, and the core-read game settings values.
 */
export async function coreSettingsFile(ctx: Context, settingsDir: string, modules: readonly SpecModule[], settings: GameSettings): Promise<string> {
  const schema = (await loadSchema(schemaPath('game-settings', ctx.env))) as JsonObject;
  const core = Object.fromEntries(Object.entries(await mergeReleaseSettings(settingsDir, settings.core)).filter(([key]) => key !== '$schema'));
  return formatJson({ ...core, ...coreGameValues(modules, settings, schema) });
}

/** The contents of a core settings type file (`client-core` Godot `## module`) for the core settings file of the same inputs. */
export function coreSettingTypesFile(modules: readonly SpecModule[], settings: GameSettings): string {
  return formatJson(coreSettingTypes(modules, settings));
}

/**
 * The core settings file and the server module list of the `modules`: the used modules for an STG or PROD build, the
 * used modules and their DEV modules where DEV code goes in (`core` skill `## module`).
 */
async function moduleFiles(ctx: Context, releaseDir: string, modules: readonly SpecModule[], settings: GameSettings): Promise<{ coreSettings: string; serverModules: string }> {
  return { coreSettings: await coreSettingsFile(ctx, releaseDir, modules, settings), serverModules: formatJson(splitModules(modules).server) };
}

/**
 * The core settings file and the server module list of an STG or PROD build of the checkout: made from the used modules
 * only, without the DEV modules that `ogw generate` writes them with.
 */
export async function moduleFilesWithoutDev(ctx: Context, game: GameRepo): Promise<{ coreSettings: string; serverModules: string }> {
  const settings = await loadGameSettings(game.root);
  const release = await coreReleaseOfGame(ctx, game);
  return moduleFiles(ctx, release.dir, usedModules(await readCoreSpec(release.dir), settings), settings);
}

async function generatedFiles(ctx: Context, inputs: Inputs, plan: Plan): Promise<void> {
  const { root, settings, release, modules, devModules, resources } = inputs;
  const dev = await moduleFiles(ctx, release.dir, devModules, settings);
  plan.files.set('client/generated/core_settings.json', dev.coreSettings);
  plan.files.set('client/generated/core_settings_types.json', coreSettingTypesFile(devModules, settings));
  plan.files.set('server/generated/core_settings.json', dev.coreSettings);
  const keyList = formatJson(godotResourceKeys(resources, join(root, 'resource')));
  plan.files.set('client/generated/resource_keys.json', keyList);
  plan.files.set('server/generated/resource_keys.json', keyList);
  const keys = resources.map((row) => row.key);
  plan.files.set('client/generated/resource_key.gd', resourceKeyGd(keys));
  plan.files.set('server/generated/resource_key.ts', resourceKeyTs(keys));
  plan.files.set('client/generated/core_modules.gd', coreModulesGd(moduleListOrder(modules, await clientModuleTableOrder(ctx.env))));
  plan.files.set('server/generated/server_modules.json', dev.serverModules);
  const licensesPath = join(release.dir, 'licenses.json');
  const licenses = gameLicenses(
    await readJson(licensesPath),
    licensesPath,
    new Set(modules.map((m) => m.name)),
    resources,
    settings.buildPlatforms ?? [],
  );
  plan.files.set('client/generated/licenses.json', formatJson(licenses));
  plan.files.set('data/simulation_tables.csv', await simulationTables(root, await tableNames(root)));
  plan.files.set('client/dev/generated/dev_registration.gd', devRegistration(await devFeatures(root)));
  plan.files.set('server/generated/tick_changed_versions.ts', await tickChangedVersions(root));
}

async function projectFiles(inputs: Inputs, plan: Plan): Promise<void> {
  const content = await contentSettings(inputs.root);
  plan.files.set('client/project.godot', await projectGodot(inputs.root, inputs.settings, content));
  plan.files.set('client/.gitignore', CLIENT_GITIGNORE);
  plan.files.set('client/boot/boot.gd', BOOT_GD);
  plan.files.set('client/boot/boot.tscn', BOOT_TSCN);
  if (exists(join(inputs.root, 'resource', 'resources.csv'))) plan.files.set('resource/resources.csv.import', RESOURCE_LIST_IMPORT);
  plan.links.push({ path: 'client/resource', target: '../resource' });
}

async function loadInputs(ctx: Context, game: GameRepo): Promise<Inputs> {
  const settings = await loadGameSettings(game.root);
  const release = await coreReleaseOfGame(ctx, game);
  const spec = await readCoreSpec(release.dir);
  const resourcesPath = join(game.root, 'resource', 'resources.csv');
  const resources = readResourceRows(exists(resourcesPath) ? await readFile(resourcesPath, 'utf8') : null, 'resource/resources.csv');
  const modules = usedModules(spec, settings);
  return { root: game.root, settings, release, spec, modules, devModules: devCodeModules(spec, modules), resources };
}

/** Everything `ogw generate` writes for the checkout. */
export async function planGenerate(ctx: Context, game: GameRepo): Promise<Plan> {
  const inputs = await loadInputs(ctx, game);
  const engine = inputs.settings.engine;
  if (engine !== 'godot') throw new OgwError(`not defined: engine rules for engine ${String(engine)}`);
  const plan = emptyPlan();
  await projectFiles(inputs, plan);
  await generatedFiles(ctx, inputs, plan);
  await coreFolders(ctx, inputs, engine, plan);
  return plan;
}

/** `ogw generate` on the checkout, holding the generate lock; returns the written and removed files. */
export async function generateCheckout(ctx: Context, game: GameRepo): Promise<Applied> {
  return withLock(await checkoutLock(game.root, 'ogw-generate.lock', { env: ctx.env }), async () => {
    return applyPlan(game.root, await planGenerate(ctx, game));
  });
}

/** `ogw generate` on the checkout `game.root`. */
export async function runGenerate(ctx: Context, game: GameRepo): Promise<void> {
  await generateCheckout(ctx, game);
}
