import type { GameSettings } from '../../../lib/settings.ts';
import type { BuildCheck, CheckOutcome, HumanFailure } from './buildrun.ts';
import { LIST_PATH, unknownLicenseKeys } from '../../resource/lib/list.ts';
import { dataRows } from './csv.ts';
import { ENVS, type Env } from './names.ts';
import type { RepoReader } from './repo.ts';

export interface CollectedDataRow {
  dataType: string;
  description: string;
  source: string;
  purposes: string[];
  linked: boolean;
  tracking: boolean;
  shared: boolean;
  optional: boolean;
  platforms: string[];
  condition: { path: string; value: unknown } | null;
}

export interface CoreSpecModule {
  name: string;
  side: 'client' | 'server';
  collectedData: CollectedDataRow[];
  adapters: string[];
}

export interface SettingsCheckInput {
  env: Env;
  platforms: string[];
  settings: GameSettings;
  reader: RepoReader;
  /** Modules the game uses (client and server). */
  modules: string[];
  /** `core-spec.json` modules of the core release. */
  coreSpec: CoreSpecModule[];
  /** Adapter keys whose adapter names include a `-sandbox` name (game settings schema `adapters` enum). */
  sandboxKeys: string[];
}

export interface CheckWithHuman {
  check: BuildCheck;
  human: HumanFailure | null;
}

/** Checks that only warn in a DEV build (`build` `## build-time check`). */
export const DEV_WARN_ONLY = new Set(['banned word', 'placeholder', 'license', 'privacy', 'device performance', 'web smoke']);

export function outcome(name: string, env: Env, details: string[]): CheckOutcome {
  if (details.length === 0) return 'pass';
  return env === 'DEV' && DEV_WARN_ONLY.has(name) ? 'warn' : 'fail';
}

function make(name: string, env: Env, details: string[], targets: string[]): CheckWithHuman {
  const result = outcome(name, env, details);
  return {
    check: { name, result, details },
    human: result === 'fail' && targets.length > 0 ? { check: name, targets: [...new Set(targets)] } : null,
  };
}

function envSettings(settings: GameSettings, env: Env): Record<string, unknown> {
  return settings.environments?.[env] ?? {};
}

/** Game settings `environments.<env>.adapters`. */
export function adaptersOf(settings: GameSettings, env: Env): Record<string, string> {
  return (envSettings(settings, env).adapters ?? {}) as Record<string, string>;
}

export async function licenseCheck(input: SettingsCheckInput): Promise<CheckWithHuman & { unknownKeys: string[] }> {
  const keys = unknownLicenseKeys((await input.reader.read(LIST_PATH)) ?? '');
  const details = keys.map((key) => `resource/resources.csv: license unknown: ${key}`);
  return { ...make('license', input.env, details, keys), unknownKeys: keys };
}

function stgSandboxViolations(adapters: Record<string, string>, sandboxKeys: string[]): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(adapters)) {
    if (value === 'fake' || value === 'push-apns-sandbox') keys.push(key);
    else if (key !== 'push-apns' && sandboxKeys.includes(key) && !value.endsWith('-sandbox')) keys.push(key);
  }
  return keys;
}

function adapterViolations(input: SettingsCheckInput): string[] {
  const { env, settings } = input;
  const adapters = adaptersOf(settings, env);
  const keys: string[] = [];
  if (env === 'DEV' && adapters['push-apns'] === 'push-apns') keys.push('push-apns');
  if (env === 'STG') keys.push(...stgSandboxViolations(adapters, input.sandboxKeys));
  if (env === 'PROD') {
    for (const [key, value] of Object.entries(adapters)) if (value === 'fake' || value.endsWith('-sandbox')) keys.push(key);
    if (!('cdn' in adapters)) keys.push('cdn');
  }
  if (env !== 'DEV' && input.platforms.includes('ios') && 'login-google' in adapters && !('login-apple' in adapters)) {
    keys.push('login-apple');
  }
  if (input.platforms.includes('web') && adapters.cdn !== 'cdn-r2') keys.push('cdn');
  return keys;
}

export function adapterCheck(input: SettingsCheckInput): CheckWithHuman {
  const paths = adapterViolations(input).map((key) => `environments.${input.env}.adapters.${key}`);
  return make('adapter', input.env, paths.map((p) => `game settings ${p}`), paths);
}

function adUnitsOf(settings: GameSettings, env: Env): Record<string, Record<string, string>> {
  return (envSettings(settings, env).adUnits ?? {}) as Record<string, Record<string, string>>;
}

function admobAppIdPaths(settings: GameSettings, platforms: string[]): string[] {
  const admob = (settings.admob ?? {}) as Record<string, unknown>;
  const paths: string[] = [];
  if (platforms.includes('android') && !admob.appIdAndroid) paths.push('admob.appIdAndroid');
  if (platforms.includes('ios') && !admob.appIdIos) paths.push('admob.appIdIos');
  return paths;
}

function otherAdUnitIds(settings: GameSettings, env: Env, placement: string): string[] {
  const ids: string[] = [];
  for (const other of ENVS) {
    for (const [name, units] of Object.entries(adUnitsOf(settings, other))) {
      if (other === env && name === placement) continue;
      for (const id of Object.values(units)) ids.push(id);
    }
  }
  return ids;
}

export async function admobCheck(input: SettingsCheckInput): Promise<CheckWithHuman> {
  const { env, settings } = input;
  if (adaptersOf(settings, env).ads !== 'ads-admob') return make('admob', env, [], []);
  const paths = admobAppIdPaths(settings, input.platforms);
  const placements = dataRows((await input.reader.read('data/tables/ad_placement.csv')) ?? '').map((r) => r.id ?? '');
  const units = adUnitsOf(settings, env);
  for (const platform of input.platforms.filter((p) => p === 'android' || p === 'ios')) {
    for (const placement of placements) {
      const id = units[placement]?.[platform];
      const path = `environments.${env}.adUnits.${placement}.${platform}`;
      if (!id) paths.push(path);
      else if (otherAdUnitIds(settings, env, placement).includes(id)) paths.push(path);
    }
  }
  return make('admob', env, paths.map((p) => `game settings ${p}`), paths);
}

const TEXT_MODULES = ['nickname', 'guild', 'chat'];

export async function bannedWordCheck(input: SettingsCheckInput): Promise<CheckWithHuman> {
  if (!input.modules.some((m) => TEXT_MODULES.includes(m))) return make('banned word', input.env, [], []);
  const rows = dataRows((await input.reader.read('data/tables/banned_word.csv')) ?? '');
  if (rows.length > 0) return make('banned word', input.env, [], []);
  const languages: string[] = [];
  for (const language of input.settings.supportedLanguages ?? []) {
    const text = await input.reader.read(`records/setup/banned-words/${language}.txt`);
    if (text === null || text.split(/\r?\n/).every((line) => line.trim() === '')) languages.push(language);
  }
  return make('banned word', input.env, ['data/tables/banned_word.csv has no built row'], languages);
}

/** Adapter names chosen in the environment that are not `fake`, without a `-sandbox` suffix. */
export function chosenAdapterNames(settings: GameSettings, env: Env): string[] {
  return Object.values(adaptersOf(settings, env))
    .filter((name) => name !== 'fake')
    .map((name) => name.replace(/-sandbox$/, ''));
}

export function usedSpecModules(input: Pick<SettingsCheckInput, 'modules' | 'coreSpec'>): CoreSpecModule[] {
  return input.coreSpec.filter((m) => input.modules.includes(m.name));
}

export function privacyCheck(input: SettingsCheckInput): CheckWithHuman {
  const details: string[] = [];
  if (input.env !== 'DEV' && input.settings.privacy === undefined) details.push('game settings privacy is missing');
  const sources = new Set(usedSpecModules(input).flatMap((m) => m.collectedData.map((row) => row.source)));
  const undeclared = [...new Set(chosenAdapterNames(input.settings, input.env))].filter((name) => !sources.has(name));
  for (const name of undeclared) details.push(`adapter ${name} has no collectedData row`);
  return make('privacy', input.env, details, undeclared);
}

/** The human checks of `build` `## build-time check`, as `ogw build run` runs them. */
export async function humanChecks(input: SettingsCheckInput): Promise<{ checks: CheckWithHuman[]; licenseWarnings: string[] }> {
  const license = await licenseCheck(input);
  const checks = [license, adapterCheck(input), await admobCheck(input), await bannedWordCheck(input), privacyCheck(input)];
  return { checks, licenseWarnings: license.check.result === 'warn' ? license.unknownKeys : [] };
}
