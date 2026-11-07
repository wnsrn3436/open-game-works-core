import { OgwError } from '../../../lib/errors.ts';
import { ENVIRONMENTS, type EnvName } from '../../settings/lib/game-check.ts';
import { isPlainObject, type JsonObject } from '../../settings/lib/json-path.ts';

/** Roles of operator `ogw` per environment (ogw.md `## game derive`). */
export const OGW_ROLES: Record<EnvName, string[]> = {
  DEV: ['read', 'ops', 'release'],
  STG: ['read', 'ops', 'release'],
  PROD: ['read'],
};

function objectAt(parent: JsonObject, key: string, path: string): JsonObject {
  const value = parent[key];
  if (value === undefined) {
    const created: JsonObject = {};
    parent[key] = created;
    return created;
  }
  if (!isPlainObject(value)) throw new OgwError(`${path} is not an object`);
  return value;
}

/** Secret name of operator `ogw` in an environment (ogw.md `## game derive`). */
export function ogwSecretName(name: EnvName): string {
  return `admin-ogw-${name.toLowerCase()}`;
}

function deriveOperators(env: JsonObject, name: EnvName): void {
  const path = `environments.${name}.adminOperators`;
  if (env.adminOperators === undefined) env.adminOperators = [];
  if (!Array.isArray(env.adminOperators)) throw new OgwError(`${path} is not an array`);
  const operators = env.adminOperators as unknown[];
  const ogw = operators.find((op): op is JsonObject => isPlainObject(op) && op.name === 'ogw');
  if (ogw) {
    ogw.roles = [...OGW_ROLES[name]];
    ogw.secret = ogwSecretName(name);
  } else operators.push({ name: 'ogw', roles: [...OGW_ROLES[name]], secret: ogwSecretName(name) });
}

function originOf(url: unknown): string | null {
  return typeof url === 'string' ? (URL.parse(url)?.origin ?? null) : null;
}

function deriveCors(env: JsonObject, web: boolean): void {
  const cdnR2 = isPlainObject(env.cdnR2) ? env.cdnR2 : null;
  const origin = web ? originOf(cdnR2?.publicBaseUrl) : null;
  env.corsAllowedOrigins = origin === null ? [] : [origin];
}

/**
 * Game settings with the values `ogw game derive` decides (ogw.md `## game derive`) set again from the
 * other values: operator `ogw`, `adapters.cdn`, and `corsAllowedOrigins` of every environment.
 */
export function deriveSettings(settings: JsonObject): JsonObject {
  const next = structuredClone(settings);
  const web = Array.isArray(next.buildPlatforms) && next.buildPlatforms.includes('web');
  const environments = objectAt(next, 'environments', 'environments');
  for (const name of ENVIRONMENTS) {
    const env = objectAt(environments, name, `environments.${name}`);
    deriveCors(env, web);
    deriveOperators(env, name);
    if (name === 'PROD' || web) objectAt(env, 'adapters', `environments.${name}.adapters`).cdn = 'cdn-r2';
  }
  return next;
}
