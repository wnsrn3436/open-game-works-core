import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreRelease } from '../../../src/commands/core/api.ts';

export const CORE_VERSION = '1.2.0';

export interface AdminOperator {
  name: string;
  roles: string[];
  secret?: string;
}

export interface Deploy {
  host: string;
  hostKey: string;
  user: string;
  dir: string;
  port: number;
}

/** One environment of game settings, typed for the fields tests change. */
export interface EnvironmentFixture {
  [key: string]: unknown;
  serverUrl: string;
  corsAllowedOrigins: string[];
  trustedProxyCount: number;
  adminOperators: [AdminOperator, ...AdminOperator[]];
  secrets: Record<string, string>;
  adapters: Record<string, string>;
  deploy?: Deploy;
  cdnR2?: Record<string, string>;
  devAllowedCidrs?: string[];
  containerLog?: { maxBytes: number };
  updatePublicKeys?: string[];
}

export type EnvironmentName = 'DEV' | 'STG' | 'PROD';

export type DeployedEnvironmentFixture = EnvironmentFixture & { deploy: Deploy };

/** Game settings, typed for the fields tests change. Other fields are `unknown`. */
export interface GameSettingsFixture {
  [key: string]: unknown;
  environments: { DEV: DeployedEnvironmentFixture; STG: DeployedEnvironmentFixture; PROD: EnvironmentFixture };
  buildPlatforms: string[];
  uiCheckScreens: [Record<string, unknown>, ...Record<string, unknown>[]];
  consent: Record<string, unknown>;
}

/** Harness settings, typed for the fields tests change. Other fields are `unknown`. */
export interface HarnessSettingsFixture {
  [key: string]: unknown;
  jobWaitTimeoutMs: number;
  resourceGeneration: [Record<string, unknown>, ...Record<string, unknown>[]];
  hosts?: Record<string, Record<string, unknown>>;
}

export function readHarnessSettingsFile(path: string): HarnessSettingsFixture {
  return JSON.parse(readFileSync(path, 'utf8')) as HarnessSettingsFixture;
}

export function readGameSettingsFile(path: string): GameSettingsFixture {
  return JSON.parse(readFileSync(path, 'utf8')) as GameSettingsFixture;
}

/** The `description` of the JSON schema node at `keys` from the schema root. */
export function schemaDescription(schema: unknown, ...keys: string[]): string {
  let node = schema;
  for (const key of keys) node = (node as Record<string, unknown>)[key];
  const description = (node as { description?: unknown }).description;
  if (typeof description !== 'string') throw new Error(`no description at ${keys.join('.')}`);
  return description;
}

/** Game settings that pass `ogw game check` against `writeRelease`. */
export function validGameSettings(): GameSettingsFixture {
  return {
    engine: 'godot',
    coreVersion: CORE_VERSION,
    coreModules: { client: ['UICore'], server: ['item-ledger'] },
    appId: 'com.example.mygame',
    supportedLanguages: ['ko', 'en'],
    environments: {
      DEV: {
        serverUrl: 'https://dev.example.com',
        corsAllowedOrigins: [],
        trustedProxyCount: 1,
        adminOperators: [{ name: 'ogw', roles: ['read', 'ops', 'release'], secret: 'admin-ogw-dev' }],
        secrets: {
          db: 'db-dev',
          accessTokenKey: 'atk-dev',
          updateSigningKey: 'usk-dev',
          devAccess: 'dev-access',
          deploySsh: 'ssh-dev',
          dbPassword: 'dbpw-dev',
        },
        adapters: {},
        deploy: { host: 'dev.example.com', hostKey: 'ssh-ed25519 AAAAC3Nza', user: 'deploy', dir: '/srv/dev', port: 8080 },
      },
      STG: {
        serverUrl: 'https://stg.example.com',
        corsAllowedOrigins: [],
        trustedProxyCount: 1,
        adminOperators: [{ name: 'ogw', roles: ['read', 'ops', 'release'], secret: 'admin-ogw-stg' }],
        secrets: { db: 'db-stg', accessTokenKey: 'atk-stg', updateSigningKey: 'usk-stg', deploySsh: 'ssh-stg', dbPassword: 'dbpw-stg' },
        adapters: {},
        deploy: { host: 'stg.example.com', hostKey: 'ssh-ed25519 AAAAC3Nza', user: 'deploy', dir: '/srv/stg', port: 8080 },
      },
      PROD: {
        serverUrl: 'https://prod.example.com',
        corsAllowedOrigins: [],
        trustedProxyCount: 1,
        adminOperators: [{ name: 'ogw', roles: ['read'], secret: 'admin-ogw-prod' }],
        secrets: { db: 'db-prod', accessTokenKey: 'atk-prod', updateSigningKey: 'usk-prod', cdn: 'cdn-prod' },
        adapters: { cdn: 'cdn-r2' },
        cdnR2: { accountId: 'acc', bucket: 'bucket', accessKeyId: 'key', publicBaseUrl: 'https://cdn.example.com/game' },
      },
    },
    buildPlatforms: ['linux'],
    serverImage: { repository: 'ghcr.io/example/mygame-server' },
    postgresqlMajor: 18,
    baseResolution: [1280, 720],
    maxResolution: [1920, 1080],
    uiCheckScreens: [{ name: 'desktop', window: [1280, 720], fillMode: 'Letterbox', notch: [0, 0, 0, 0] }],
    titleScene: 'scene_title',
    firstScene: 'scene_lobby',
    loadingScreen: 'prefab_loading',
    termsPopup: 'prefab_terms',
    termsDocuments: {
      TERMS: { version: 1, url: 'https://example.com/terms' },
      PRIVACY: { version: 1, url: 'https://example.com/privacy' },
    },
    nicknameUnique: true,
    consent: { ageConfirmation: false, privacyChoices: false, version: 1, trackingRequest: false },
  };
}

export const CORE_SETTINGS = {
  'NetworkCore.requestTimeoutMs': 10000,
  'InputBlockCore.maxDurationMs': 30000,
  'BootstrapCore.realtimeRelayOnly': false,
  'auth.maxAgeYears': 120,
  'auth.childAgeYears': 13,
  'auth.digitalConsentAgeYears': 16,
  'UICore.theme': { color: 'blue', size: 2 },
};

export const CORE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'core-settings.schema.json',
  type: 'object',
  additionalProperties: false,
  properties: {
    'NetworkCore.requestTimeoutMs': { type: 'integer', minimum: 0, description: 'Request timeout. In ms.', 'x-owner': 'human' },
    'InputBlockCore.maxDurationMs': { type: 'integer', minimum: 0, description: 'Longest input block.' },
    'BootstrapCore.realtimeRelayOnly': { type: 'boolean', description: 'Relay only.' },
    'auth.maxAgeYears': { type: 'integer', minimum: 1 },
    'auth.childAgeYears': { type: 'integer', minimum: 1 },
    'auth.digitalConsentAgeYears': { type: 'integer', minimum: 1 },
    'UICore.theme': {
      type: 'object',
      description: 'Theme.',
      properties: { color: { type: 'string', description: 'Color name.' }, size: { type: 'integer', minimum: 1, default: 2 } },
    },
    'UICore.theme.dark': { type: 'boolean', default: false, description: 'Dark theme.' },
  },
};

export const CORE_CONSTRAINTS = [{ left: 'NetworkCore.requestTimeoutMs', factor: 2, right: 'InputBlockCore.maxDurationMs' }];

export const CORE_SPEC = {
  version: CORE_VERSION,
  modules: [
    { name: 'BootstrapCore', side: 'client', devDependencies: ['QACore'] },
    { name: 'UICore', side: 'client' },
    { name: 'NetworkCore', side: 'client' },
    { name: 'QACore', side: 'client' },
    { name: 'auth', side: 'server' },
    { name: 'item-ledger', side: 'server' },
    { name: 'routing', side: 'server', devDependencies: ['cheat'] },
    { name: 'cheat', side: 'server' },
  ],
};

/** A release folder with the files settings commands read. */
export function writeRelease(dir: string, version = CORE_VERSION): CoreRelease {
  mkdirSync(dir, { recursive: true });
  const files: Record<string, unknown> = {
    'core-settings.json': CORE_SETTINGS,
    'core-settings.schema.json': CORE_SCHEMA,
    'core-settings-constraints.json': CORE_CONSTRAINTS,
    'core-spec.json': { ...CORE_SPEC, version },
  };
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
  return { version, dir, local: false };
}
