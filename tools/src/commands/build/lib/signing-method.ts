import type { GameSettings } from '../../../lib/settings.ts';

/** Build environments; the same names as `names.ts` `Env` and `game-check.ts` `EnvName`. */
type BuildEnv = 'DEV' | 'STG' | 'PROD';

/** Platforms with signing (`build` `## platform build`); web and linux have none. */
export const SIGNED_PLATFORMS: readonly string[] = ['android', 'ios', 'windows', 'macos'];

/** Free signing method of a DEV build per platform, as the build report `## artifacts` writes it. */
const FREE_METHOD: Readonly<Record<string, string>> = { android: 'debug keystore', macos: 'ad-hoc', windows: 'unsigned' };

/** Whether game settings have `signing.<platform>`. */
export function hasSigning(settings: GameSettings, platform: string): boolean {
  const signing = settings.signing;
  if (typeof signing !== 'object' || signing === null) return false;
  const names = (signing as Record<string, unknown>)[platform];
  return typeof names === 'object' && names !== null;
}

function devLoginApple(settings: GameSettings): boolean {
  const adapters = (settings.environments?.DEV as { adapters?: Record<string, unknown> } | undefined)?.adapters;
  return adapters?.['login-apple'] === 'login-apple';
}

/**
 * Whether a build of `env` needs `signing.<platform>`: a platform with signing that has no free signing there. STG
 * and PROD always; DEV for ios and for macos whose DEV `adapters.login-apple` is `login-apple`.
 */
export function signingRequired(settings: GameSettings, env: BuildEnv, platform: string): boolean {
  if (!SIGNED_PLATFORMS.includes(platform)) return false;
  if (env !== 'DEV' || platform === 'ios') return true;
  return platform === 'macos' && devLoginApple(settings);
}

/** The free signing method of this build of the platform, or null when it signs with `signing` or has no signing. */
export function freeSigning(settings: GameSettings, env: BuildEnv, platform: string): string | null {
  if (env !== 'DEV' || hasSigning(settings, platform) || signingRequired(settings, env, platform)) return null;
  return FREE_METHOD[platform] ?? null;
}
