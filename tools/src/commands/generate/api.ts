import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists, formatJson, readJson, readJsonIfExists } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { checkoutLock } from '../../lib/git.ts';
import { isPlainObject, mergeSettings, type JsonObject } from '../../lib/json.ts';
import { withLock } from '../../lib/lock.ts';
import { span } from '../../lib/spans.ts';
import { loadGameSettings, loadSchema, schemaPath, type GameSettings } from '../../lib/settings.ts';
import { coreReleaseOfGame, extractedAsset, type CoreRelease } from '../core/api.ts';
import { gutPackage, isCorePlugin, packageDir, pluginsFor } from '../core/lib/engine-packages.ts';
import { hostPlatform, type EngineJson } from '../core/lib/impl.ts';
import { applyPlan, emptyPlan, type Applied, type Plan } from './lib/apply.ts';
import { clientModuleTableOrder, devCodeModules, moduleListOrder, readCoreSpec, usedModules, type CoreSpec, type SpecModule } from './lib/core-spec.ts';
import { coreGameValues, coreSettingTypes, schemaProperties, settingsSchema, typeSchema } from './lib/core-settings.ts';
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
async function enginePackages(ctx: Context, release: CoreRelease, engine: string, clientDir: string, plan: Plan): Promise<void> {
  const engineJson = await readJson<EngineJson>(join(clientDir, 'engine.json'));
  plan.overlays.push({ source: await packageDir(ctx, gutPackage(engineJson)), target: 'client' });
  const platform = hostPlatform();
  for (const plugin of pluginsFor(engineJson, platform)) {
    if (!isCorePlugin(plugin)) {
      plan.overlays.push({ source: await packageDir(ctx, plugin), target: 'client' });
      continue;
    }
    const plugins = await extractedAsset(ctx, release, `client-${engine}-plugins.zip`);
    const source = join(plugins, plugin.name, platform);
    if (!exists(source)) throw new OgwError(`client-${engine}-plugins.zip of core ${release.version} has no ${plugin.name}/${platform}/`);
    plan.overlays.push({ source, target: 'client' });
  }
}

async function coreFolders(ctx: Context, inputs: Inputs, engine: string, plan: Plan): Promise<void> {
  const client = await extractedAsset(ctx, inputs.release, `client-${engine}.zip`);
  plan.mirrors.push({ source: join(client, 'core'), target: 'client/core' });
  plan.mirrors.push({ source: await extractedAsset(ctx, inputs.release, 'server.tgz'), target: 'server/core' });
  await enginePackages(ctx, inputs.release, engine, client, plan);
}

/** The items of a core settings file: the core settings values and the core-read game settings values, by key. */
interface CoreSettingsItems {
  core: JsonObject;
  game: JsonObject;
}

/**
 * The items of a core settings file (`client-core` Godot `## folder`): the core settings of `settingsDir`'s
 * `core-settings.json` without `$schema`, the game settings `core` over them, and the core-read game settings values.
 */
async function coreSettingsItems(ctx: Context, settingsDir: string, modules: readonly SpecModule[], settings: GameSettings): Promise<CoreSettingsItems> {
  const schema = (await loadSchema(schemaPath('game-settings', ctx.env))) as JsonObject;
  const core = Object.fromEntries(Object.entries(await mergeReleaseSettings(settingsDir, settings.core)).filter(([key]) => key !== '$schema'));
  return { core, game: coreGameValues(modules, settings, schema) };
}

/** The contents of a core settings file (`client-core` Godot `## folder`) of `settingsDir`'s core settings. */
export async function coreSettingsFile(ctx: Context, settingsDir: string, modules: readonly SpecModule[], settings: GameSettings): Promise<string> {
  const items = await coreSettingsItems(ctx, settingsDir, modules, settings);
  return formatJson({ ...items.core, ...items.game });
}

/**
 * The settings schema of a core settings file (`server-core` SKILL `## generated code`): one property per key of the
 * file, all in `required`. A core settings key has its property in `core-settings.schema.json` of `settingsDir`, and a
 * core-read game settings item the property of the type of its settings row. A core settings key without a property
 * fails.
 */
async function coreSettingsSchemaFile(settingsDir: string, items: CoreSettingsItems, modules: readonly SpecModule[], settings: GameSettings): Promise<string> {
  const path = join(settingsDir, 'core-settings.schema.json');
  const coreProperties = schemaProperties(await readJsonIfExists(path), path);
  const types = coreSettingTypes(modules, settings);
  const properties: JsonObject = {};
  for (const key of Object.keys({ ...items.core, ...items.game })) {
    const type = Object.hasOwn(items.game, key) ? types[key] : undefined;
    if (type !== undefined) properties[key] = typeSchema(type);
    else if (Object.hasOwn(coreProperties, key)) properties[key] = coreProperties[key];
    else throw new OgwError(`core settings key ${key} has no property in ${path}`);
  }
  return formatJson(settingsSchema(properties, Object.keys(properties)));
}

/** The contents of a core settings type file (`client-core` Godot `## module`) for the core settings file of the same inputs. */
export function coreSettingTypesFile(modules: readonly SpecModule[], settings: GameSettings): string {
  return formatJson(coreSettingTypes(modules, settings));
}

/** The files made from the prepared modules: the core settings file, its settings schema and the server module list. */
export interface ModuleFiles {
  coreSettings: string;
  coreSettingsSchema: string;
  serverModules: string;
}

/**
 * The core settings file, its settings schema and the server module list of the `modules`: the used modules for an STG
 * or PROD build, the used modules and their DEV modules where DEV code goes in (`core` skill `## module`).
 */
async function moduleFiles(ctx: Context, releaseDir: string, modules: readonly SpecModule[], settings: GameSettings): Promise<ModuleFiles> {
  const items = await coreSettingsItems(ctx, releaseDir, modules, settings);
  return {
    coreSettings: formatJson({ ...items.core, ...items.game }),
    coreSettingsSchema: await coreSettingsSchemaFile(releaseDir, items, modules, settings),
    serverModules: formatJson(splitModules(modules).server),
  };
}

/**
 * The core settings file, its settings schema and the server module list of an STG or PROD build of the checkout: made
 * from the used modules only, without the DEV modules that `ogw generate` writes them with.
 */
export async function moduleFilesWithoutDev(ctx: Context, game: GameRepo): Promise<ModuleFiles> {
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
  plan.files.set('server/generated/core_settings_schema.json', dev.coreSettingsSchema);
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

/** The engine of game settings, whose engine rules `ogw generate` has: Godot. */
function definedEngine(settings: GameSettings): 'godot' {
  const engine = settings.engine;
  if (engine !== 'godot') throw new OgwError(`not defined: engine rules for engine ${String(engine)}`);
  return engine;
}

/** Everything `ogw generate` writes for the checkout. */
export async function planGenerate(ctx: Context, game: GameRepo): Promise<Plan> {
  const inputs = await loadInputs(ctx, game);
  const engine = definedEngine(inputs.settings);
  const plan = emptyPlan();
  await projectFiles(inputs, plan);
  await generatedFiles(ctx, inputs, plan);
  await coreFolders(ctx, inputs, engine, plan);
  return plan;
}

/** `ogw generate` on the checkout, holding the generate lock; returns the written and removed files. */
export async function generateCheckout(ctx: Context, game: GameRepo): Promise<Applied> {
  return span('generate', async () => withLock(await checkoutLock(game.root, 'ogw-generate.lock', { env: ctx.env }), async () => {
    const plan = await span('generate plan', () => planGenerate(ctx, game));
    return span('generate write', () => applyPlan(game.root, plan));
  }));
}

/**
 * The engine packages of `ogw generate` alone (GUT and the `engine.json` plugins of this host OS) put into `client/` of
 * the checkout, holding the generate lock: no other file of `ogw generate` is written, so the committed generated files
 * stay as they are (ogw.md `## check`). Returns the written files.
 */
export async function installEnginePackages(ctx: Context, game: GameRepo): Promise<Applied> {
  return span('engine packages', async () => withLock(await checkoutLock(game.root, 'ogw-generate.lock', { env: ctx.env }), async () => {
    const engine = definedEngine(await loadGameSettings(game.root));
    const release = await coreReleaseOfGame(ctx, game);
    const plan = emptyPlan();
    await enginePackages(ctx, release, engine, await extractedAsset(ctx, release, `client-${engine}.zip`), plan);
    return applyPlan(game.root, plan);
  }));
}

/** `ogw generate` on the checkout `game.root`. */
export async function runGenerate(ctx: Context, game: GameRepo): Promise<void> {
  await generateCheckout(ctx, game);
}
