import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { exists, readJson } from '../../../lib/fsx.ts';
import { newSecretFolder } from '../../../lib/secret-files.ts';
import { gameSecretService } from '../../../lib/secrets.ts';
import type { GameSettings } from '../../../lib/settings.ts';
import { extractedAsset, type CoreRelease } from '../../core/api.ts';
import { ALWAYS_MODULES } from '../../generate/lib/core-spec.ts';
import { trackingRequested } from './godot-ios.ts';
import { profileApplicationIdentifier, profilePlist } from './godot-signing.ts';
import type { EngineJson } from './host.ts';
import type { Env } from './names.ts';
import { adaptersOf } from './settingschecks.ts';

/** When an STG or PROD build needs a native plugin (`build` engines/godot.md `## native plugin`). */
export type PluginNeed = { always: true } | { adapter: string } | { module: string } | { trackingRequest: true };

/**
 * The native plugins of the `client-core` engines/godot.md table that an STG or PROD build checks, with their target
 * platforms in that table and when a build needs them.
 */
export const GODOT_NATIVE_PLUGINS: readonly { plugin: string; platforms: readonly string[]; need: PluginNeed }[] = [
  // AuthCore is in every game and keeps the login token there
  { plugin: 'ogw-secure-storage', platforms: ['android', 'ios', 'macos', 'windows', 'linux'], need: { always: true } },
  { plugin: 'ogw-apple-signin', platforms: ['ios', 'macos'], need: { adapter: 'login-apple' } },
  { plugin: 'ogw-google-signin', platforms: ['android', 'ios'], need: { adapter: 'login-google' } },
  { plugin: 'ogw-iap-apple', platforms: ['ios', 'macos'], need: { adapter: 'iap-apple' } },
  { plugin: 'ogw-iap-google', platforms: ['android'], need: { adapter: 'iap-google' } },
  { plugin: 'ogw-ads-admob', platforms: ['android', 'ios'], need: { adapter: 'ads' } },
  { plugin: 'ogw-push-fcm', platforms: ['android'], need: { adapter: 'push-fcm' } },
  { plugin: 'ogw-push-apns', platforms: ['ios'], need: { adapter: 'push-apns' } },
  { plugin: 'ogw-notification', platforms: ['android', 'ios'], need: { module: 'PushCore' } },
  { plugin: 'ogw-tracking', platforms: ['ios'], need: { trackingRequest: true } },
];

/** The modules the game uses, read only when a plugin of a target platform depends on one. */
export type ModulesOf = () => Promise<readonly string[]>;

async function needed(need: PluginNeed, settings: GameSettings, env: Env, modules: ModulesOf): Promise<boolean> {
  if ('always' in need) return true;
  if ('adapter' in need) {
    const value = adaptersOf(settings, env)[need.adapter];
    return value !== undefined && value !== 'fake';
  }
  if ('module' in need) return (await modules()).includes(need.module);
  return trackingRequested(settings);
}

/** The native plugins an STG or PROD build of `platform` needs; none for DEV and web. */
export async function neededPlugins(settings: GameSettings, env: Env, platform: string, modules: ModulesOf): Promise<string[]> {
  if (env === 'DEV' || platform === 'web') return [];
  const plugins: string[] = [];
  for (const entry of GODOT_NATIVE_PLUGINS) {
    if (entry.platforms.includes(platform) && (await needed(entry.need, settings, env, modules))) plugins.push(entry.plugin);
  }
  return plugins;
}

interface Plugin {
  name?: unknown;
  platforms?: unknown;
}

/**
 * What the provisioning profile of `signing.macos` lacks for the keychain access group of `ogw-secure-storage`
 * (`build` engines/godot.md `## native plugin`): the profile, its secret in the secret store of this host, or
 * `com.apple.application-identifier` `<appleTeamId>.<appId>` in its `Entitlements`. Null when it has all.
 */
async function macosProfileProblem(ctx: Context, game: string, settings: GameSettings): Promise<string | null> {
  const name = (settings.signing as Record<string, Record<string, unknown> | undefined> | undefined)?.macos?.provisioningProfile;
  if (typeof name !== 'string') return 'game settings signing.macos has no provisioningProfile';
  const value = ctx.secrets.get(gameSecretService(game, 'signing', name));
  if (value === null) return `signing secret ${name} is not in the secret store`;
  const expected = `${String(settings.appleTeamId)}.${String(settings.appId)}`;
  const dir = await newSecretFolder('ogw-profile-', ctx.env);
  let granted: string | null;
  try {
    const file = join(dir, 'profile.provisionprofile');
    await writeFile(file, Buffer.from(value, 'base64'), { mode: 0o600 });
    granted = profileApplicationIdentifier(await profilePlist(ctx, file));
  } catch (error) {
    return `provisioning profile ${name} cannot be decoded with security cms: ${(error as Error).message}`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (granted === expected) return null;
  return `provisioning profile ${name} grants com.apple.application-identifier ${granted ?? 'none'}, not ${expected}, so the app has no keychain access group`;
}

/**
 * Failure lines of check `native plugin` (`build` engines/godot.md `## native plugin`): each plugin a build of `env` on
 * `platforms` needs that `engine.json` of the core release lacks for that platform, or whose `<plugin>/<platform>/`
 * `client-godot-plugins.zip` lacks. With `game` (`ogw build start`, `ogw build run`), a macos build that needs
 * `ogw-secure-storage` also fails on what the provisioning profile of `signing.macos` lacks. Empty for an engine
 * other than Godot.
 */
export async function nativePluginProblems(ctx: Context, release: CoreRelease, settings: GameSettings, env: Env, platforms: readonly string[], modules: ModulesOf, game?: string): Promise<string[]> {
  if ((settings.engine ?? 'godot') !== 'godot') return [];
  const wanted: { platform: string; plugin: string }[] = [];
  for (const platform of platforms) for (const plugin of await neededPlugins(settings, env, platform, modules)) wanted.push({ platform, plugin });
  if (wanted.length === 0) return [];
  const engine = await readJson<EngineJson>(join(await extractedAsset(ctx, release, 'client-godot.zip'), 'engine.json'));
  const listed = ((engine.plugins ?? []) as Plugin[]).filter((p) => typeof p.name === 'string');
  const has = (plugin: string, platform: string): boolean => listed.some((p) => p.name === plugin && Array.isArray(p.platforms) && p.platforms.includes(platform));
  const problems: string[] = [];
  let zip: string | null = null;
  for (const { platform, plugin } of wanted) {
    const what = `${env} ${platform} needs native plugin ${plugin}`;
    if (!has(plugin, platform)) {
      problems.push(`${what}: engine.json of core ${release.version} has no ${plugin} for ${platform}`);
      continue;
    }
    zip ??= await extractedAsset(ctx, release, 'client-godot-plugins.zip');
    if (!exists(join(zip, plugin, platform))) problems.push(`${what}: client-godot-plugins.zip of core ${release.version} has no ${plugin}/${platform}/`);
  }
  if (game !== undefined && wanted.some((w) => w.platform === 'macos' && w.plugin === 'ogw-secure-storage')) {
    const problem = await macosProfileProblem(ctx, game, settings);
    if (problem !== null) problems.push(`${env} macos needs native plugin ogw-secure-storage: ${problem}`);
  }
  return problems;
}

/**
 * The modules a game of game settings `settings` uses in the core release, for `nativePluginProblems`: the always
 * used modules and `coreModules`, with their closure over `dependencies` of `core-spec.json`.
 */
export function releaseModules(release: CoreRelease, settings: GameSettings): ModulesOf {
  return async () => {
    const spec = await readJson<{ modules?: { name?: unknown; dependencies?: unknown }[] }>(join(release.dir, 'core-spec.json'));
    const dependencies = new Map((spec.modules ?? []).map((m) => [m.name, Array.isArray(m.dependencies) ? (m.dependencies as string[]) : []]));
    const used = new Set<string>();
    const queue = [...ALWAYS_MODULES, ...(settings.coreModules?.client ?? []), ...(settings.coreModules?.server ?? [])];
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      if (used.has(name)) continue;
      used.add(name);
      queue.push(...(dependencies.get(name) ?? []));
    }
    return [...used];
  };
}
