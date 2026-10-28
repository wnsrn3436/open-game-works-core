import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readText } from '../../../lib/fsx.ts';
import { harnessRoot } from '../../../lib/paths.ts';
import { hasSigning, signingRequired } from '../../build/lib/signing-method.ts';
import { loadSchema, schemaPath, withDefaults, type GameSettings } from '../../../lib/settings.ts';
import { coreFiles, matchCoreKey, type CoreFiles, type SettingsConstraint } from './core-files.ts';
import { getAt, isPlainObject, mergeSettings, type JsonObject } from './json-path.ts';
import { isBuildStage } from './schema-nav.ts';
import { schemaIssues, type Issue } from './validate.ts';

export const ENVIRONMENTS = ['DEV', 'STG', 'PROD'] as const;
export type EnvName = (typeof ENVIRONMENTS)[number];

function environment(settings: GameSettings, name: EnvName): JsonObject | null {
  const env = settings.environments?.[name];
  return isPlainObject(env) ? env : null;
}

function adapters(env: JsonObject): JsonObject {
  return isPlainObject(env.adapters) ? env.adapters : {};
}

function platforms(settings: GameSettings): string[] {
  return Array.isArray(settings.buildPlatforms) ? settings.buildPlatforms : [];
}

function missing(path: string): Issue {
  return { message: `${path}: missing`, missing: path };
}

function languageIssues(settings: GameSettings): Issue[] {
  const languages = settings.supportedLanguages;
  if (!Array.isArray(languages) || typeof settings.sourceLanguage !== 'string') return [];
  if (languages.includes(settings.sourceLanguage)) return [];
  return [{ message: `sourceLanguage: ${settings.sourceLanguage} is not in supportedLanguages` }];
}

/** Platform → signing key names of the `## signing` table of `skills/build/engines/<engine>.md`. */
export async function signingTable(harness: string, engine: string): Promise<Map<string, string[]>> {
  const path = join(harness, 'skills', 'build', 'engines', `${engine}.md`);
  if (!exists(path)) throw new OgwError(`no build engine document: ${path}`);
  const lines = (await readText(path)).split('\n');
  const start = lines.findIndex((line) => line.trim() === '## signing');
  const table = new Map<string, string[]>();
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    const cells = line.trim().split('|').map((cell) => cell.trim());
    if (cells.length < 4 || cells[1] === 'platform' || /^-+$/.test(cells[1] ?? '')) continue;
    const keyCell = (cells[2] ?? '').replace(/\([^)]*\)/g, '');
    table.set(cells[1] as string, [...keyCell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string));
  }
  if (start === -1 || table.size === 0) throw new OgwError(`no signing table in ${path}`);
  return table;
}

async function signingIssues(harness: string, settings: GameSettings): Promise<Issue[]> {
  const signing = settings.signing;
  if (!isPlainObject(signing) || typeof settings.engine !== 'string') return [];
  const table = await signingTable(harness, settings.engine);
  const issues: Issue[] = [];
  for (const [platform, names] of Object.entries(signing)) {
    const expected = [...(table.get(platform) ?? [])].sort();
    const actual = isPlainObject(names) ? Object.keys(names).sort() : [];
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      issues.push({ message: `signing.${platform}: keys must be ${expected.join(', ')}` });
    }
  }
  return issues;
}

/** `signing.<platform>` of the `buildPlatforms` that a build of one of `envs` needs (`build` `## platform build`). */
function signingMissing(settings: GameSettings, envs: readonly EnvName[]): Issue[] {
  return platforms(settings)
    .filter((p) => !hasSigning(settings, p) && envs.some((env) => signingRequired(settings, env, p)))
    .map((p) => missing(`signing.${p}`));
}

function screens(settings: GameSettings): JsonObject[] {
  return Array.isArray(settings.uiCheckScreens) ? settings.uiCheckScreens.filter(isPlainObject) : [];
}

function uiScreenIssues(settings: GameSettings): Issue[] {
  const issues: Issue[] = [];
  screens(settings).forEach((screen, i) => {
    const height = Array.isArray(screen.window) ? (screen.window[1] as unknown) : undefined;
    if (typeof screen.keyboard === 'number' && typeof height === 'number' && screen.keyboard >= height) {
      issues.push({ message: `uiCheckScreens.${String(i)}.keyboard: must be less than the window height ${String(height)}` });
    }
  });
  const mobile = platforms(settings).some((p) => p === 'android' || p === 'ios');
  if (mobile && Array.isArray(settings.uiCheckScreens) && !screens(settings).some((s) => typeof s.keyboard === 'number' && s.keyboard >= 1)) {
    issues.push({ message: 'uiCheckScreens: android or ios needs a screen with keyboard 1 or more' });
  }
  return issues;
}

function operatorIssues(name: EnvName, env: JsonObject): Issue[] {
  if (!Array.isArray(env.adminOperators)) return [];
  const path = `environments.${name}.adminOperators`;
  const operators = env.adminOperators.filter(isPlainObject);
  const names = operators.map((op) => op.name);
  const issues: Issue[] = [];
  if (new Set(names).size !== names.length) issues.push({ message: `${path}: operator names repeat` });
  const ogw = operators.find((op) => op.name === 'ogw');
  if (!ogw) return [...issues, { message: `${path}: operator ogw is missing` }];
  const roles = Array.isArray(ogw.roles) ? ogw.roles : [];
  if (roles.includes('privacy')) issues.push({ message: `${path}: operator ogw must not have role privacy` });
  if (name === 'PROD' && JSON.stringify(roles) !== '["read"]') issues.push({ message: `${path}: PROD operator ogw must have only role read` });
  return issues;
}

function pushConsentIssues(settings: GameSettings): Issue[] {
  const push = settings.pushConsent;
  if (!isPlainObject(push) || push.nightStartMinute === undefined) return [];
  if (push.nightStartMinute !== push.nightEndMinute) return [];
  return [{ message: 'pushConsent: nightStartMinute and nightEndMinute must differ' }];
}

function deployIssues(settings: GameSettings): Issue[] {
  const dev = environment(settings, 'DEV')?.deploy;
  const stg = environment(settings, 'STG')?.deploy;
  if (!isPlainObject(dev) || !isPlainObject(stg) || dev.host !== stg.host) return [];
  const issues: Issue[] = [];
  if (dev.dir === stg.dir) issues.push({ message: 'environments: DEV and STG deploy on the same host need different deploy.dir' });
  if (dev.port === stg.port) issues.push({ message: 'environments: DEV and STG deploy on the same host need different deploy.port' });
  return issues;
}

function iosLoginIssues(settings: GameSettings, name: EnvName, env: JsonObject): Issue[] {
  const used = adapters(env);
  if (!platforms(settings).includes('ios') || used['login-google'] === undefined || used['login-apple'] !== undefined) return [];
  return [missing(`environments.${name}.adapters.login-apple`)];
}

function originOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function webIssues(settings: GameSettings, name: EnvName, env: JsonObject): Issue[] {
  if (!platforms(settings).includes('web')) return [];
  const path = `environments.${name}`;
  const issues: Issue[] = [];
  const cdn = adapters(env).cdn;
  if (cdn === undefined) issues.push(missing(`${path}.adapters.cdn`));
  else if (cdn !== 'cdn-r2') issues.push({ message: `${path}.adapters.cdn: must be cdn-r2 for web` });
  const cdnR2 = isPlainObject(env.cdnR2) ? env.cdnR2 : null;
  const origin = originOf(cdnR2?.publicBaseUrl);
  if (!cdnR2) issues.push(missing(`${path}.cdnR2`));
  else if (origin !== null && !(Array.isArray(env.corsAllowedOrigins) && env.corsAllowedOrigins.includes(origin))) {
    issues.push({ message: `${path}.corsAllowedOrigins: must have ${origin}` });
  }
  if (name === 'DEV' && (env.devAllowedCidrs === undefined || env.devAllowedCidrs === null)) issues.push(missing(`${path}.devAllowedCidrs`));
  return issues;
}

function desktopLoginIssues(settings: GameSettings, name: EnvName, env: JsonObject): Issue[] {
  const desktop = platforms(settings).some((p) => p === 'windows' || p === 'macos' || p === 'linux');
  if (!desktop || adapters(env)['login-google'] !== 'login-google') return [];
  const secrets = isPlainObject(env.secrets) ? env.secrets : {};
  return secrets.loginGoogleDesktop === undefined ? [missing(`environments.${name}.secrets.loginGoogleDesktop`)] : [];
}

function environmentIssues(settings: GameSettings): Issue[] {
  const issues: Issue[] = [];
  for (const name of ENVIRONMENTS) {
    const env = environment(settings, name);
    if (!env) continue;
    issues.push(...operatorIssues(name, env), ...iosLoginIssues(settings, name, env));
    issues.push(...webIssues(settings, name, env), ...desktopLoginIssues(settings, name, env));
  }
  return issues;
}

/**
 * The value written at a game settings path, or undefined. In `core.<core settings key>`, the key is the longest key
 * of game settings `core` that the rest equals or starts with followed by `.`.
 */
export function gameSettingsValue(settings: unknown, path: string): unknown {
  if (!path.startsWith('core.')) return getAt(settings, path.split('.'));
  const core = isPlainObject(settings) ? settings.core : undefined;
  if (!isPlainObject(core)) return undefined;
  const text = path.slice('core.'.length);
  const key = matchCoreKey(Object.keys(core), text);
  if (key === null) return undefined;
  return getAt(core[key], text === key ? [] : text.slice(key.length + 1).split('.'));
}

/** Each path of `humanDecided` has a value written in game settings, so the value the human decided is kept. */
function humanDecidedIssues(raw: GameSettings): Issue[] {
  const paths = raw.humanDecided;
  if (!Array.isArray(paths)) return [];
  return paths
    .filter((path): path is string => typeof path === 'string' && gameSettingsValue(raw, path) === undefined)
    .map((path) => ({ message: `humanDecided: ${path} has no value written in game settings` }));
}

/**
 * Checks of `ogw game check` that need no core release. `settings` has the schema defaults filled
 * in; `raw` is the settings as written.
 */
export async function localGameIssues(harness: string, gameSchema: object, raw: GameSettings, settings: GameSettings): Promise<Issue[]> {
  return [
    ...schemaIssues(gameSchema, raw),
    ...humanDecidedIssues(raw),
    ...languageIssues(settings),
    ...(await signingIssues(harness, settings)),
    ...uiScreenIssues(settings),
    ...pushConsentIssues(settings),
    ...deployIssues(settings),
    ...environmentIssues(settings),
  ];
}

function moduleIssues(settings: GameSettings, core: CoreFiles): Issue[] {
  const chosen = settings.coreModules;
  if (!isPlainObject(chosen)) return [];
  const issues: Issue[] = [];
  // modules that only DEV code depends on: a run with DEV code prepares them as DEV modules (`core` skill `## module`)
  const devOnly = new Set(core.modules.flatMap((m) => m.devDependencies ?? []));
  for (const side of ['client', 'server'] as const) {
    const names = Array.isArray(chosen[side]) ? chosen[side] : [];
    for (const name of names) {
      if (!core.modules.some((m) => m.name === name && m.side === side)) {
        issues.push({ message: `coreModules.${side}: ${name} is not a ${side} module of core ${core.version}` });
      } else if (devOnly.has(name)) {
        issues.push({ message: `coreModules.${side}: ${name} is a module only DEV code depends on; runs with DEV code prepare it without coreModules` });
      }
    }
  }
  return issues;
}

/** Core settings defaults of the release with game settings `core` merged over them. */
export function mergedCore(settings: GameSettings, core: CoreFiles): JsonObject {
  return mergeSettings(core.settings, isPlainObject(settings.core) ? settings.core : {});
}

function numberKey(merged: JsonObject, key: string): number {
  const value = merged[key];
  if (typeof value !== 'number') throw new OgwError(`core settings ${key} is not a number`);
  return value;
}

function ageBandIssues(settings: GameSettings, merged: JsonObject): Issue[] {
  const consent = settings.consent;
  if (!isPlainObject(consent) || !Array.isArray(consent.ageBandBoundaries)) return [];
  const bands = consent.ageBandBoundaries as unknown[];
  const path = 'consent.ageBandBoundaries';
  const issues: Issue[] = [];
  const maxAge = numberKey(merged, 'auth.maxAgeYears');
  const ordered = bands.every((age, i) => Number.isInteger(age) && (age as number) >= 1 && (age as number) <= maxAge && (i === 0 || (age as number) > (bands[i - 1] as number)));
  if (!ordered) issues.push({ message: `${path}: must be ascending integers from 1 to auth.maxAgeYears ${String(maxAge)} without repeats` });
  const needed = [numberKey(merged, 'auth.childAgeYears'), numberKey(merged, 'auth.digitalConsentAgeYears')];
  if (typeof consent.minimumAge === 'number') needed.push(consent.minimumAge);
  const limits = isPlainObject(settings.purchaseLimits) ? settings.purchaseLimits.monthlyBelowAge : undefined;
  if (isPlainObject(limits)) needed.push(...Object.keys(limits).map(Number));
  for (const age of needed) if (!bands.includes(age)) issues.push({ message: `${path}: must have ${String(age)}` });
  return issues;
}

/** With `BootstrapCore.realtimeRelayOnly`, every environment needs `adapters.turn`. */
function relayIssues(settings: GameSettings, merged: JsonObject): Issue[] {
  if (merged['BootstrapCore.realtimeRelayOnly'] !== true) return [];
  return ENVIRONMENTS.filter((name) => {
    const env = environment(settings, name);
    return env !== null && (adapters(env).turn ?? null) === null;
  }).map((name) => missing(`environments.${name}.adapters.turn`));
}

/** Settings constraint issues: `left` × `factor` ≤ `right` over the values. */
export function constraintIssues(constraints: readonly SettingsConstraint[], values: JsonObject, prefix: string): Issue[] {
  const issues: Issue[] = [];
  for (const { left, factor, right } of constraints) {
    const l = values[left];
    const r = values[right];
    if (typeof l !== 'number' || typeof r !== 'number' || l * factor > r) {
      issues.push({ message: `${prefix}${left} × ${String(factor)} must be at most ${prefix}${right}` });
    }
  }
  return issues;
}

/** Checks of `ogw game check` that read the core release of `coreVersion`. */
export function releaseGameIssues(settings: GameSettings, core: CoreFiles): Issue[] {
  const merged = mergedCore(settings, core);
  return [
    ...moduleIssues(settings, core),
    ...schemaIssues(core.schema, merged, ['core']),
    ...constraintIssues(core.constraints, merged, 'core.'),
    ...ageBandIssues(settings, merged),
    ...relayIssues(settings, merged),
  ];
}

/** `setup`: build stage values may be missing (`x-stage` `build`); `build`: every required value. */
export type CheckStage = 'setup' | 'build';

/**
 * Every check of `ogw game check`. Without `withRelease`, the checks that read the core release are left out. At
 * the `setup` stage, a missing value of a build stage path is not an issue. At the `build` stage, `envs` are the
 * environments whose builds need their signing values.
 */
export async function gameIssues(ctx: Context, game: string, settings: GameSettings, withRelease = true, stage: CheckStage = 'setup', envs: readonly EnvName[] = ENVIRONMENTS): Promise<Issue[]> {
  const schema = await loadSchema(schemaPath('game-settings', ctx.env));
  const filled = withDefaults(schema, settings);
  const issues = await localGameIssues(harnessRoot(ctx.env), schema, settings, filled);
  if (withRelease && typeof settings.coreVersion === 'string') {
    issues.push(...releaseGameIssues(filled, await coreFiles(ctx, settings.coreVersion, game)));
  }
  if (stage === 'build') return [...issues, ...signingMissing(settings, envs)];
  return issues.filter((issue) => issue.missing === undefined || !isBuildStage(schema as JsonObject, issue.missing.split('.')));
}

/**
 * Missing build stage values (`x-stage` `build`) for a build of `env`: what `ogw build start` needs on top of the
 * setup stage, with the checks that read the core release. A STG build also needs the PROD values: a PROD build
 * builds the commit STG checked. Values of the other environments are not needed.
 */
export async function buildStageMissing(ctx: Context, game: string, settings: GameSettings, env: EnvName): Promise<Issue[]> {
  const schema = await loadSchema(schemaPath('game-settings', ctx.env));
  const envs: EnvName[] = env === 'STG' ? ['STG', 'PROD'] : [env];
  const issues = await gameIssues(ctx, game, settings, true, 'build', envs);
  return issues.filter((issue) => {
    if (issue.missing === undefined) return false;
    const segments = issue.missing.split('.');
    if (segments[0] === 'environments' && segments[1] !== undefined && !(envs as string[]).includes(segments[1])) return false;
    return isBuildStage(schema as JsonObject, segments);
  });
}
