import { OgwError } from '../../../lib/errors.ts';
import type { SecretScope } from '../../../lib/secrets.ts';
import type { GameSettings, HarnessSettings } from '../../../lib/settings.ts';
import { isPlainObject, type JsonObject } from '../../settings/lib/json-path.ts';

export const SCOPES: readonly SecretScope[] = ['DEV', 'STG', 'PROD', 'signing'];

export function isScope(text: string): text is SecretScope {
  return (SCOPES as readonly string[]).includes(text);
}

/** The environment object `environments.<env>`; fails when it is missing. */
export function environmentOf(settings: GameSettings, env: string): JsonObject {
  const value = settings.environments?.[env];
  if (!isPlainObject(value)) throw new OgwError(`game settings have no environments.${env}`);
  return value;
}

/** A secret name in settings. */
export interface NamedSecret {
  /** What the secret is, for messages; never the value. For example `secret db`, `admin operator ogw secret`. */
  label: string;
  name: string;
}

function stringEntries(value: unknown): [string, string][] {
  return isPlainObject(value) ? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string') : [];
}

/** Secrets named in `environments.<env>`: the `secrets` values and the `adminOperators` `secret`s. */
export function environmentSecrets(env: JsonObject): NamedSecret[] {
  const fromSecrets = stringEntries(env.secrets).map(([key, name]) => ({ label: `secret ${key}`, name }));
  const operators = Array.isArray(env.adminOperators) ? env.adminOperators : [];
  const fromOperators = operators.flatMap((op: unknown) =>
    isPlainObject(op) && typeof op.secret === 'string' ? [{ label: `admin operator ${String(op.name)} secret`, name: op.secret }] : [],
  );
  return [...fromSecrets, ...fromOperators];
}

/** Secrets named in `signing`: the values of every `signing.<platform>`. */
export function signingSecrets(settings: GameSettings): NamedSecret[] {
  const platforms = isPlainObject(settings.signing) ? Object.entries(settings.signing) : [];
  return platforms.flatMap(([platform, map]) =>
    stringEntries(map).map(([key, name]) => ({ label: `signing ${platform} ${key}`, name })),
  );
}

/** Secret names in `environments.<env>`. */
export function environmentSecretNames(env: JsonObject): string[] {
  return environmentSecrets(env).map((s) => s.name);
}

/** Secret names of a scope: an environment, or `signing`. */
export function scopeSecretNames(settings: GameSettings, scope: SecretScope): string[] {
  if (scope === 'signing') return signingSecrets(settings).map((s) => s.name);
  const env = settings.environments?.[scope];
  return isPlainObject(env) ? environmentSecretNames(env) : [];
}

/**
 * The harness secret with a long-lived Claude Code login token (`claude setup-token`) that `ogw agent` gives the
 * play and judge Claude Code CLI as `CLAUDE_CODE_OAUTH_TOKEN` (`tools/ogw.md` `## agent`).
 */
export const AGENT_LOGIN_TOKEN_SECRET = 'claude-code-oauth-token';

/**
 * Secret names of harness settings: the `secret` of `resourceGeneration` methods and of their `pins`, and the agent
 * login token secret.
 */
export function harnessSecretNames(settings: HarnessSettings): string[] {
  const generation = settings.resourceGeneration.flatMap((m) => [m.secret, ...(m.pins ?? []).map((p) => p.secret)]).filter((s): s is string => typeof s === 'string');
  return [...generation, AGENT_LOGIN_TOKEN_SECRET];
}
