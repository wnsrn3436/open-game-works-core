import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readJsonIfExists, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { revParse, showFile } from '../../../lib/git.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { runOk } from '../../../lib/proc.ts';
import { gameSecretService } from '../../../lib/secrets.ts';
import type { GameSettings } from '../../../lib/settings.ts';
import { coreReleaseOfGame, extractedAsset } from '../../core/api.ts';
import { packageDir } from '../../core/lib/engine-packages.ts';
import { moduleFilesWithoutDev } from '../../generate/api.ts';
import { compareBytes } from '../../generate/lib/core-spec.ts';
import { parseCfg, quote } from '../../generate/lib/godot-cfg.ts';
import { runData } from '../../data/api.ts';
import { requireEngine, toolProgram } from '../../env/api.ts';
import { withCommitCheckout } from './atcommit.ts';
import { dataRows } from './csv.ts';
import { engineJson, type BuildTool, type EngineJson } from './host.ts';
import { freeSigning } from './signing-method.ts';
import { ENVS, requireVersion, type Env } from './names.ts';
import { adaptersOf } from './settingschecks.ts';
import { matchesFilter, pckPaths } from './pck.ts';
import type { PlatformBuild, PlatformBuildInput } from './platform.ts';
import { iosIdentity, iosOptions, localizeTracking, trackingRequested, trackingSource, trackingTexts } from './godot-ios.ts';
import { prepareSigning, signWindows, windowsSigner } from './godot-signing.ts';
import { isZip, zipEntries } from './zip.ts';
import { installServiceWorker, WEB_EXPORT_OPTIONS } from '../../../lib/godot-web.ts';

export const PRESET_PLATFORM: Record<string, string> = {
  android: 'Android', ios: 'iOS', macos: 'macOS', windows: 'Windows Desktop', linux: 'Linux', web: 'Web',
};

export function excludeFilter(env: Env): string {
  return env === 'DEV'
    ? 'tests/*,addons/gut/*,generated/launch_values.json'
    : 'tests/*,addons/gut/*,dev/*,core/*/dev/*,generated/core_settings_types.json,generated/launch_values.json';
}

/** Android `version/code` and iOS `application/version`. */
export function versionCode(version: string, env: Env): number {
  const [major, minor, patch] = requireVersion(version);
  if (major > 209 || minor > 999 || patch > 999) throw new OgwError(`version ${version} does not fit the version code`);
  return (major * 1_000_000 + minor * 1000 + patch) * 10 + ENVS.indexOf(env);
}

export function outputFile(game: string, platform: string, env: Env): string {
  switch (platform) {
    case 'android':
      return `${game}.${env === 'DEV' ? 'apk' : 'aab'}`;
    case 'ios':
      return `${game}.ipa`;
    case 'macos':
      return `${game}.zip`;
    case 'windows':
      return `${game}.exe`;
    case 'linux':
      return `${game}.x86_64`;
    default:
      return 'index.html';
  }
}

function cfgValue(value: unknown): string {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `PackedStringArray(${value.map((v) => JSON.stringify(String(v))).join(', ')})`;
  return JSON.stringify(String(value));
}

/** One preset of `export_presets.cfg` (or of `.godot/export_credentials.cfg`). */
export function presetCfg(head: Record<string, unknown>, options: Record<string, unknown>): string {
  const lines = ['[preset.0]', '', ...Object.entries(head).map(([k, v]) => `${k}=${cfgValue(v)}`), '', '[preset.0.options]', ''];
  lines.push(...Object.entries(options).map(([k, v]) => `${k}=${cfgValue(v)}`));
  return `${lines.join('\n')}\n`;
}

/** Source text of reserved string `[app_name]` (`data/system/reserved_string.csv`). */
async function appName(root: string): Promise<string> {
  const path = join(root, 'data', 'system', 'reserved_string.csv');
  const rows = exists(path) ? dataRows(await readFile(path, 'utf8')) : [];
  const row = rows.find((r) => r.id === '[app_name]');
  if (!row?.text) throw new OgwError('data/system/reserved_string.csv has no [app_name] text');
  return row.text;
}

async function iconSource(root: string): Promise<string> {
  const dir = join(root, 'resource', 'app_icon');
  const name = exists(dir) ? (await readdir(dir)).find((n) => n.startsWith('main.')) : undefined;
  if (name === undefined) throw new OgwError('resource app_icon/main is missing');
  return join(dir, name);
}

/** Resource `app_icon/main` scaled to `size` square in `client/.ogw-build/<name>`; `opaque` drops the alpha channel. */
async function icon(ctx: Context, root: string, size: number, name: string, opaque = false): Promise<string> {
  const ffmpeg = await toolProgram(ctx, 'ffmpeg');
  if (ffmpeg === null) throw new OgwError('harness settings tools.ffmpeg is not on this host');
  const out = join(root, 'client', '.ogw-build', name);
  await mkdir(join(root, 'client', '.ogw-build'), { recursive: true });
  const pixels = opaque ? ['-pix_fmt', 'rgb24'] : [];
  await runOk(ffmpeg, ['-y', '-loglevel', 'error', '-i', await iconSource(root), '-vf', `scale=${String(size)}:${String(size)}`, ...pixels, out], { env: ctx.env, timeoutMs: LIMITS.programMs });
  return `res://.ogw-build/${name}`;
}

interface PresetContext {
  ctx: Context;
  root: string;
  game: string;
  env: Env;
  version: string;
  settings: GameSettings;
  iosPrivacy: PlatformBuildInput['iosPrivacy'];
  /** `[config] name` of the `.gdip` files the ios plugins put into `client/ios/plugins/`. */
  iosPlugins: readonly string[];
}

async function iosPreset(p: PresetContext): Promise<Record<string, unknown>> {
  const options = await iosOptions({
    settings: p.settings,
    env: p.env,
    version: p.version,
    versionCode: versionCode(p.version, p.env),
    privacy: p.iosPrivacy,
    trackingText: trackingRequested(p.settings) ? await trackingSource(p.root) : null,
    icon: (size) => icon(p.ctx, p.root, size, `ios_${String(size)}.png`, true),
  });
  for (const name of p.iosPlugins) options[`plugins/${name}`] = true;
  return options;
}

async function androidOptions(p: PresetContext): Promise<Record<string, unknown>> {
  return {
    'gradle_build/use_gradle_build': true,
    'gradle_build/export_format': p.env === 'DEV' ? 0 : 1,
    'architectures/armeabi-v7a': true,
    'architectures/arm64-v8a': true,
    'architectures/x86': false,
    'architectures/x86_64': false,
    'version/code': versionCode(p.version, p.env),
    'version/name': p.version,
    'package/unique_name': p.settings.appId,
    'permissions/internet': true,
    'launcher_icons/main_192x192': await icon(p.ctx, p.root, 192, 'icon_192.png'),
    'launcher_icons/adaptive_foreground_432x432': await icon(p.ctx, p.root, 432, 'icon_432.png'),
  };
}

async function macosOptions(p: PresetContext): Promise<Record<string, unknown>> {
  const options: Record<string, unknown> = {
    'binary_format/architecture': 'universal',
    'application/bundle_identifier': p.settings.appId,
    'application/icon': await icon(p.ctx, p.root, 1024, 'icon_1024.png'),
  };
  if (adaptersOf(p.settings, p.env)['login-apple'] === 'login-apple') {
    const plist = join(p.root, 'client', '.ogw-build', 'macos.entitlements');
    await writeFileAtomic(
      plist,
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>com.apple.developer.applesignin</key>\n\t<array>\n\t\t<string>Default</string>\n\t</array>\n</dict>\n</plist>\n',
    );
    options['codesign/entitlements/custom_file'] = plist;
  }
  return options;
}

async function platformOptions(p: PresetContext, platform: string): Promise<Record<string, unknown>> {
  switch (platform) {
    case 'android':
      return androidOptions(p);
    case 'macos':
      return macosOptions(p);
    case 'windows':
      return {
        'binary_format/architecture': 'x86_64',
        'codesign/enable': false,
        'application/icon': await icon(p.ctx, p.root, 256, 'icon.ico'),
        'application/product_name': await appName(p.root),
      };
    case 'linux':
      return { 'binary_format/architecture': 'x86_64' };
    case 'ios':
      return iosPreset(p);
    case 'web':
      return { ...WEB_EXPORT_OPTIONS };
    default:
      throw new OgwError(`unknown platform ${platform}`);
  }
}

/**
 * STG, PROD: `client/generated/core_settings.json` of the used modules without their DEV modules (`core` skill
 * `## module`); DEV keeps the file `ogw generate` wrote.
 */
export async function writeCoreSettingsWithoutDev(ctx: Context, game: GameRepo, root: string, env: Env): Promise<void> {
  if (env === 'DEV') return;
  const files = await moduleFilesWithoutDev(ctx, { ...game, root });
  await writeFileAtomic(join(root, 'client', 'generated', 'core_settings.json'), files.coreSettings);
}

/** `client/generated/core_settings.json` and `core_settings_types.json` without the items of the other environments. */
export async function filterCoreSettings(root: string, env: Env): Promise<void> {
  for (const name of ['core_settings.json', 'core_settings_types.json']) await filterCoreSettingsFile(join(root, 'client', 'generated', name), env);
}

/** A `core_settings.json` without the items whose path names another environment; nothing when the file is absent. */
export async function filterCoreSettingsFile(path: string, env: Env): Promise<void> {
  const settings = await readJsonIfExists<Record<string, unknown>>(path);
  if (!settings) return;
  const others = ENVS.filter((e) => e !== env);
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (others.some((other) => key.split('.').includes(other))) continue;
    if (key === 'environments' && typeof value === 'object' && value !== null) {
      kept[key] = Object.fromEntries(Object.entries(value).filter(([name]) => !others.includes(name as Env)));
    } else kept[key] = value;
  }
  await writeJsonAtomic(path, kept);
}

interface Plugin {
  name: string;
  platforms?: string[];
  url?: string;
  sha256?: string;
}

/**
 * Puts the `engine.json` plugins of the build platform into `client/` (`client-core` Godot `## engine version`). Returns the
 * folder each plugin was copied from; paths below it are project-root paths.
 */
async function installPlugins(ctx: Context, game: GameRepo, root: string, meta: EngineJson, platform: string): Promise<string[]> {
  const plugins = ((meta.plugins ?? []) as Plugin[]).filter((p) => Array.isArray(p.platforms) && p.platforms.includes(platform));
  const own = plugins.filter((p) => p.name.startsWith('ogw-'));
  const sources: string[] = [];
  for (const plugin of plugins.filter((p) => !p.name.startsWith('ogw-'))) sources.push(await packageDir(ctx, plugin));
  if (own.length > 0) {
    const dir = await extractedAsset(ctx, await coreReleaseOfGame(ctx, game), 'client-godot-plugins.zip');
    for (const plugin of own) {
      const source = join(dir, plugin.name, platform);
      if (!exists(source)) throw new OgwError(`client-godot-plugins.zip has no ${plugin.name}/${platform}/`);
      sources.push(source);
    }
  }
  for (const source of sources) await cp(source, join(root, 'client'), { recursive: true });
  return sources;
}

/** `res://addons/<folder>/plugin.cfg` of the plugin folders `sources` (Godot Android plugin v2 editor plugins), in byte order. */
export async function editorPluginPaths(sources: readonly string[]): Promise<string[]> {
  const paths = new Set<string>();
  for (const source of sources) {
    const addons = join(source, 'addons');
    if (!exists(addons)) continue;
    for (const entry of await readdir(addons, { withFileTypes: true })) {
      if (entry.isDirectory() && exists(join(addons, entry.name, 'plugin.cfg'))) paths.add(`res://addons/${entry.name}/plugin.cfg`);
    }
  }
  return [...paths].sort(compareBytes);
}

/** `[config] name` of each `.gdip` below `ios/plugins/` of the plugin folders `sources`, in byte order. */
export async function iosPluginNames(sources: readonly string[]): Promise<string[]> {
  const names = new Set<string>();
  for (const source of sources) {
    const dir = join(source, 'ios', 'plugins');
    if (!exists(dir)) continue;
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith('.gdip'))) {
      const file = join(entry.parentPath, entry.name);
      const name = parseCfg(await readFile(file, 'utf8'), file).find((e) => e.section === 'config' && e.key === 'name');
      const value = name === undefined ? '' : (JSON.parse(name.value) as unknown);
      if (typeof value !== 'string' || value === '') throw new OgwError(`${file} has no [config] name`);
      names.add(value);
    }
  }
  return [...names].sort(compareBytes);
}

/** `project.godot` text with `[editor_plugins] enabled` set to `paths`, in place of an `[editor_plugins]` section it had. */
export function withEditorPlugins(project: string, paths: readonly string[]): string {
  const rest = project.replace(/^\[editor_plugins\][^]*?(?=^\[|(?![^]))/m, '').trimEnd();
  return `${rest}\n\n[editor_plugins]\n\nenabled=PackedStringArray(${paths.map(quote).join(', ')})\n`;
}

/** AdMob app ID meta-data and the Firebase config file of `android/build/`. */
export async function androidExtras(root: string, settings: GameSettings, env: Env): Promise<void> {
  const adapters = adaptersOf(settings, env);
  const dir = join(root, 'client', 'android', 'build');
  if (adapters.ads === 'ads-admob') {
    const id = (settings.admob as { appIdAndroid?: string } | undefined)?.appIdAndroid;
    if (!id) throw new OgwError('game settings admob.appIdAndroid is missing');
    const manifest = join(dir, 'AndroidManifest.xml');
    const text = await readFile(manifest, 'utf8');
    if (!text.includes('</application>')) throw new OgwError('android/build/AndroidManifest.xml has no </application>');
    const meta = `    <meta-data android:name="com.google.android.gms.ads.APPLICATION_ID" android:value=${JSON.stringify(id)} />\n`;
    await writeFile(manifest, text.replace('</application>', `${meta}    </application>`));
  }
  if (adapters['push-fcm'] === 'push-fcm') {
    const fcm = settings.environments?.[env]?.fcm as Record<string, string> | undefined;
    if (!fcm) throw new OgwError(`game settings environments.${env}.fcm is missing`);
    await writeJsonAtomic(join(dir, 'google-services.json'), {
      project_info: { project_number: fcm.projectNumber, project_id: fcm.projectId },
      client: [{ client_info: { mobilesdk_app_id: fcm.appIdAndroid, android_client_info: { package_name: settings.appId } }, api_key: [{ current_key: fcm.apiKeyAndroid }] }],
    });
  }
}

/** STG, PROD: `LogCore.log_debug(...)` lines become `pass` with the same indentation. */
export async function stripLogDebug(clientDir: string): Promise<number> {
  let changed = 0;
  const entries = await readdir(clientDir, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith('.gd'))) {
    const path = join(entry.parentPath, entry.name);
    const text = await readFile(path, 'utf8');
    const next = text.replace(/^([ \t]*)LogCore\.log_debug\(.*\)[ \t]*$/gm, '$1pass');
    if (next !== text) {
      changed++;
      await writeFile(path, next);
    }
  }
  return changed;
}

async function keyId(publicKey: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 16);
}

/** `ad_units`: placement ID value (read from `id_registry.json` of the `id-registry` branch) to the platform's ad unit ID. */
async function adUnits(root: string, settings: GameSettings, env: Env, platform: string): Promise<Record<string, string>> {
  const units = (settings.environments?.[env]?.adUnits ?? {}) as Record<string, Record<string, string>>;
  if (Object.keys(units).length === 0) return {};
  const text = (await showFile(root, 'id-registry', 'id_registry.json'))?.toString('utf8');
  const registry = text === undefined ? null : (JSON.parse(text) as Record<string, number>);
  const result: Record<string, string> = {};
  for (const [placement, ids] of Object.entries(units)) {
    const value = registry?.[placement];
    const id = ids[platform];
    if (value === undefined) throw new OgwError(`game settings environments.${env}.adUnits placement ${placement} has no ID value in the id-registry branch`);
    if (id !== undefined) result[String(value)] = id;
  }
  return result;
}

export async function writeBuildInfo(ctx: Context, p: PresetContext, platform: string): Promise<void> {
  const envSettings = p.settings.environments?.[p.env] ?? {};
  const serverUrl = typeof envSettings.serverUrl === 'string' ? envSettings.serverUrl : '';
  const keys = (envSettings.updatePublicKeys ?? []) as string[];
  const info: Record<string, unknown> = {
    app_id: p.settings.appId,
    app_version: p.version,
    environment: p.env,
    platform,
    server_url: serverUrl,
    game_update_url: `${serverUrl}/update/deploy_list.json`,
    update_trust_keys: await Promise.all(keys.map(async (key) => ({ key_id: await keyId(key), public_key: key }))),
    adapters: adaptersOf(p.settings, p.env),
    ad_units: await adUnits(p.root, p.settings, p.env, platform),
    instance_id: '',
  };
  if (p.env === 'DEV') {
    const name = (envSettings.secrets as Record<string, string> | undefined)?.devAccess;
    const value = name === undefined ? null : ctx.secrets.get(gameSecretService(p.game, 'DEV', name));
    if (value === null) throw new OgwError('secret devAccess of DEV is not in the secret store');
    info.dev_access = value;
  }
  await writeJsonAtomic(join(p.root, 'client', 'generated', 'build_info.json'), info);
  await writeProjectVersion(p.root, p.version);
}

/** `application/config/version` of `project.godot`. */
async function writeProjectVersion(root: string, version: string): Promise<void> {
  const projectPath = join(root, 'client', 'project.godot');
  const project = await readFile(projectPath, 'utf8');
  const line = `config/version=${JSON.stringify(version)}`;
  const next = /^config\/version=.*$/m.test(project)
    ? project.replace(/^config\/version=.*$/m, line)
    : project.replace(/^\[application\]\s*$/m, `[application]\n\n${line}`);
  await writeFile(projectPath, next);
}

/** Files inside the exported package, project-relative. */
export async function packagePaths(file: string): Promise<string[]> {
  const bytes = await readFile(file);
  if (file.endsWith('.pck')) return pckPaths(bytes);
  if (!isZip(bytes)) return [];
  const paths: string[] = [];
  for (const entry of zipEntries(bytes)) {
    if (entry.name.endsWith('.pck')) paths.push(...pckPaths(entry.data()));
    else paths.push(entry.name.replace(/^(base\/)?assets\//, ''));
  }
  return paths;
}

/** Export filter globs of DEV code (`dev/`, core `dev/`), which only STG and PROD exclude. */
const DEV_CODE_FILTER = 'dev/*,core/*/dev/*';

/**
 * Checks the exported files of a platform. Returns the `DEV code` check failures (an STG or PROD package holding DEV
 * code); throws on the other problems.
 */
export async function checkPackage(outDir: string, platform: string, game: string, env: Env): Promise<string[]> {
  const files = await readdir(outDir);
  const named = platform === 'web' ? files.includes('index.html') : files.some((f) => f.startsWith(game));
  if (!named) throw new OgwError(`export of ${platform} made no ${outputFile(game, platform, env)}`);
  const filter = excludeFilter(env);
  const devCode: string[] = [];
  for (const name of files) {
    const paths = await packagePaths(join(outDir, name));
    const excluded = paths.filter((p) => matchesFilter(p, filter));
    const dev = excluded.filter((p) => matchesFilter(p, DEV_CODE_FILTER));
    devCode.push(...dev.map((p) => `${platform}/${name} holds DEV code: ${p}`));
    const other = excluded.filter((p) => !dev.includes(p));
    if (other.length > 0) throw new OgwError(`${name} holds excluded files: ${other.slice(0, 10).join(', ')}`);
    if (platform === 'ios' && name.endsWith('.ipa')) {
      const entries = zipEntries(await readFile(join(outDir, name))).map((e) => e.name);
      if (!entries.some((e) => /^Payload\/[^/]+\.app\/PrivacyInfo\.xcprivacy$/.test(e))) throw new OgwError(`${name} has no PrivacyInfo.xcprivacy`);
    }
  }
  return devCode;
}

async function godotRun(ctx: Context, godot: string, root: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await runOk(godot, ['--headless', '--path', join(root, 'client'), ...args], { env: { ...ctx.env, ...env }, timeoutMs: LIMITS.programMs });
}

/** Launch values of the DEV export of check `device performance` or `web smoke` (`## device performance`, `## web smoke`). */
export type LaunchValues = Record<string, string>;

/**
 * Engine, data binaries, core settings, plugins and android build files of the build workspace (`## export` 1). Returns
 * the engine and the `[config] name` of the ios plugins.
 */
async function prepareWorkspace(ctx: Context, input: PlatformBuildInput, platform: string, root: string): Promise<{ godot: string; iosPlugins: string[] }> {
  const meta = await engineJson(ctx, input.game, 'godot');
  const godot = await requireEngine(ctx, 'godot', meta.godot ?? '');
  // `ogw build run` compared this commit's data with the PROD data tag in the checkout
  const data = await runData(ctx, { ...input.game, root }, { binary: true, strict: true, prodCompare: false });
  if (data.exitCode !== 0) throw new OgwError(`ogw data failed in the build workspace: ${data.stderr}`);
  await writeCoreSettingsWithoutDev(ctx, input.game, root, input.env);
  await filterCoreSettings(root, input.env);
  const sources = await installPlugins(ctx, input.game, root, meta, platform);
  if (platform === 'android') {
    await godotRun(ctx, godot, root, ['--install-android-build-template'], {});
    await androidExtras(root, input.settings, input.env);
    // an export plugin of an editor plugin that is not enabled adds no `.aar` and no dependency
    const editorPlugins = await editorPluginPaths(sources);
    const projectPath = join(root, 'client', 'project.godot');
    if (editorPlugins.length > 0) await writeFile(projectPath, withEditorPlugins(await readFile(projectPath, 'utf8'), editorPlugins));
  }
  return { godot, iosPlugins: platform === 'ios' ? await iosPluginNames(sources) : [] };
}

/**
 * `## export` 2–7 in the build workspace. With `launchValues` it is the DEV export of a build-time check:
 * `generated/launch_values.json` instead of `generated/build_info.json`, and `generated/launch_values.json`
 * taken out of `exclude_filter`.
 */
async function exportPreset(ctx: Context, input: PlatformBuildInput, platform: string, root: string, exportPath: string, launchValues: LaunchValues | null): Promise<void> {
  const { godot, iosPlugins } = await prepareWorkspace(ctx, input, platform, root);
  if (input.env !== 'DEV') await stripLogDebug(join(root, 'client'));
  const p: PresetContext = { ctx, root, game: input.game.name, env: input.env, version: input.version, settings: input.settings, iosPrivacy: input.iosPrivacy, iosPlugins };
  const options = await platformOptions(p, platform);
  if (launchValues === null) await writeBuildInfo(ctx, p, platform);
  else {
    await writeProjectVersion(root, input.version);
    await writeJsonAtomic(join(root, 'client', 'generated', 'launch_values.json'), launchValues);
  }
  const buildTools = async (): Promise<readonly BuildTool[]> => (await engineJson(ctx, input.game, 'godot')).buildTools ?? [];
  const signing = await prepareSigning(ctx, input.game.name, input.settings, input.env, platform, buildTools);
  const name = `${platform}-${input.env.toLowerCase()}`;
  const filter = launchValues === null ? excludeFilter(input.env) : excludeFilter(input.env).replace(',generated/launch_values.json', '');
  const head = { name, platform: PRESET_PLATFORM[platform], runnable: true, export_filter: 'all_resources', include_filter: 'build/data/*,generated/*.json', exclude_filter: filter, export_path: exportPath };
  try {
    await writeFileAtomic(join(root, 'client', 'export_presets.cfg'), presetCfg(head, { ...options, ...signing.options }));
    if (Object.keys(signing.credentials).length > 0) {
      await writeFileAtomic(join(root, 'client', '.godot', 'export_credentials.cfg'), presetCfg({ name }, signing.credentials));
    }
    await godotRun(ctx, godot, root, ['--import'], signing.env);
    await godotRun(ctx, godot, root, [input.env === 'DEV' ? '--export-debug' : '--export-release', name, exportPath], signing.env);
    // an export that made no page is reported by the output check of the caller
    if (platform === 'web' && exists(exportPath)) await installServiceWorker(join(root, 'client'), dirname(exportPath));
    if (platform === 'ios' && trackingRequested(input.settings) && signing.keychain !== undefined) {
      const texts = await trackingTexts(root, input.settings.supportedLanguages ?? [], await trackingSource(root));
      await localizeTracking(ctx, exportPath, texts, signing.keychain, iosIdentity(input.env));
    }
  } finally {
    await rm(join(root, 'client', '.godot', 'export_credentials.cfg'), { force: true });
    await signing.cleanup();
  }
}

/** Exports and checks the package; returns the `DEV code` check failures. */
async function exportIn(ctx: Context, input: PlatformBuildInput, platform: string, root: string, outDir: string): Promise<string[]> {
  await exportPreset(ctx, input, platform, root, join(outDir, outputFile(input.game.name, platform, input.env)), null);
  const devCode = await checkPackage(outDir, platform, input.game.name, input.env);
  if (platform === 'windows' && freeSigning(input.settings, input.env, platform) === null) {
    const files = (await readdir(outDir)).filter((f) => f.endsWith('.exe') || f.endsWith('.dll')).map((f) => join(outDir, f));
    const signer = await windowsSigner(ctx, (await engineJson(ctx, input.game, 'godot')).buildTools ?? []);
    await signWindows(ctx, input.game.name, input.settings, files, signer);
  }
  return devCode;
}

/**
 * The DEV export (`android-dev` apk, `web-dev` web export) of check `device performance` or `web smoke`
 * into `outDir` of the build workspace `root`, with `generated/launch_values.json`. Returns the output file.
 * The caller deletes the export and `generated/launch_values.json` when the check ends.
 */
export async function godotCheckExport(ctx: Context, input: PlatformBuildInput, platform: 'android' | 'web', root: string, outDir: string, launchValues: LaunchValues): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const exportPath = join(outDir, outputFile(input.game.name, platform, 'DEV'));
  await exportPreset(ctx, { ...input, env: 'DEV' }, platform, root, exportPath, launchValues);
  if (!exists(exportPath)) throw new OgwError(`export of ${platform} made no ${outputFile(input.game.name, platform, 'DEV')}`);
  return exportPath;
}

/** Exports one platform from a clean checkout of the build branch (`build` engines/godot.md `## export`). */
export async function godotBuild(ctx: Context, input: PlatformBuildInput, platform: string): Promise<PlatformBuild> {
  const outDir = join(input.outDir, platform);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const head = await revParse(input.game.root, 'HEAD', { env: ctx.env });
  if (head === null) throw new OgwError('the build branch has no commit');
  const devCode = await withCommitCheckout(ctx, input.game, head, (repo) => exportIn(ctx, input, platform, repo.root, outDir));
  const free = freeSigning(input.settings, input.env, platform);
  return { artifact: { platform, path: relative(input.game.root, outDir), ...(free === null ? {} : { freeSigning: free }) }, devCode };
}

