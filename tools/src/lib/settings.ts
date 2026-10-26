import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { join, resolve } from 'node:path';
import { OgwError } from './errors.ts';
import { readJson } from './fsx.ts';
import { checkoutLock } from './git.ts';
import { currentHost } from './host.ts';
import { withLock } from './lock.ts';
import { harnessRoot, workspaceRoot } from './paths.ts';

export type Role =
  | 'content'
  | 'resource'
  | 'translation'
  | 'play'
  | 'judge'
  | 'server-hardening'
  | 'client-hardening'
  | 'core'
  | 'review';

export const ROLES: readonly Role[] = [
  'content',
  'resource',
  'translation',
  'play',
  'judge',
  'server-hardening',
  'client-hardening',
  'core',
  'review',
];

export interface AgentSettings {
  cli?: 'claude-code' | 'codex';
  model: string;
  effort: string;
}

export interface ToolDownload {
  platform: 'macos-arm64' | 'linux-x64' | 'windows-x64' | 'any';
  url: string;
  sha256: string;
}

export interface ToolPin {
  version: string;
  downloads: ToolDownload[];
}

/** A Python program pin: its wheel, its dependency wheels and the CPython version of its isolated environment. */
export interface PythonToolPin extends ToolPin {
  python: string;
  dependencies: ToolDownload[];
}

export interface GenerationPin {
  kind: 'git' | 'hf' | 'pip' | 'file' | 'patch';
  source: string;
  /** `file` pins: the download URL. */
  url?: string;
  revision?: string;
  files?: string;
  exclude?: string;
  sha256?: string;
  /** `hf` pins: the harness secret holding a Hugging Face access token. */
  secret?: string;
  /** `git` pins: the path in the repository of the `pyproject.toml` whose dependencies the method needs. */
  pyproject?: string;
}

export interface MeasuredStep {
  resolution?: number;
  durationMs?: number;
  jobMs?: number;
  result: 'ok' | 'failed' | 'timeout';
}

export interface GenerationMethod {
  name: string;
  kind: 'external-service' | 'local-model' | 'procedural' | 'catalog';
  resourceTypes: string[];
  safetyTimeoutMs: number;
  secret?: string;
  provider?: 'codex' | 'grok';
  pins?: GenerationPin[];
  license?: string;
  /** This host's `hosts.<id>.measured.<name>` (`loadHarnessSettings`); the file has no `measured` on a method. */
  measured?: MeasuredStep[];
  [key: string]: unknown;
}

export interface TestDevice {
  platform: 'android';
  serial: string;
}

/** One entry of harness settings `hosts`: the values of one host (schema `$defs/host`). */
export interface HostSettings {
  name: string;
  maxConcurrentInstances?: number;
  playInstances?: number;
  reviewRunConcurrency?: number;
  testDevices?: TestDevice[];
  imageMethod?: string;
  measured?: Record<string, MeasuredStep[]>;
}

/** Keys of `HostSettings` that hold a value of the host; `ogw settings` reads them as top-level harness settings paths. */
export const HOST_KEYS = ['maxConcurrentInstances', 'playInstances', 'reviewRunConcurrency', 'testDevices', 'imageMethod', 'measured'] as const;

/**
 * Harness settings as commands use them: the file with this host's `hosts` entry in place of `hosts`.
 * `maxConcurrentInstances` is null when this host has no measured value, `playInstances` and `reviewRunConcurrency` are
 * the schema defaults when this host has none, `imageMethod` is the schema default when this host has none, and each
 * method has this host's `measured` steps.
 */
export interface HarnessSettings {
  humanLanguage: string;
  agents: Partial<Record<Role, AgentSettings>>;
  maxConcurrentInstances: number | null;
  instanceWaitTimeoutMs: number;
  jobWaitTimeoutMs: number;
  testDevices?: TestDevice[];
  playInstances: number;
  reviewRunConcurrency: number;
  imageMethod: string;
  backgroundRetryLimit: number;
  webSmokeCpuThrottleRate: number;
  webSmokeBootTimeoutMs: number;
  loopStop: { repeatedDefect: number; oscillation: number; plateau: number; successJudges: number };
  reviewRounds: number;
  codeCheck: { maxComplexity: number };
  rigCheck: { iouMin: number; colorDiffMax: number };
  paths: { coreImpl: string; coreReleases: string; games: string; worktrees: string };
  coreReleaseRepository: string;
  useLocalCore: boolean;
  minCoreVersion: string | null;
  resourceGeneration: GenerationMethod[];
  tools: {
    blender: ToolPin;
    placeholderFont: ToolPin;
    postgresql: { tag: string; digest: string };
    chromium?: ToolPin;
    gdtoolkit?: PythonToolPin;
    ffmpeg?: ToolPin;
  };
}

/** Game settings are read loosely; commands pick the fields they use. */
export type GameSettings = Record<string, unknown> & {
  engine?: string;
  coreVersion?: string;
  coreModules?: { client?: string[]; server?: string[] };
  buildPlatforms?: string[];
  sourceLanguage?: string;
  supportedLanguages?: string[];
  environments?: Record<string, Record<string, unknown>>;
  core?: Record<string, unknown>;
};

/** Resolved folders of the workspace. */
export interface Workspace {
  harness: string;
  root: string;
  coreImpl: string;
  coreReleases: string;
  games: string;
  worktrees: string;
}

export function harnessSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(harnessRoot(env), 'settings.json');
}

export function schemaPath(name: 'harness-settings' | 'game-settings', env: NodeJS.ProcessEnv = process.env): string {
  return join(harnessRoot(env), 'schemas', `${name}.schema.json`);
}

/** The harness settings file: harness-wide values and `hosts`. */
export type HarnessSettingsFile = Omit<HarnessSettings, 'maxConcurrentInstances' | 'playInstances' | 'reviewRunConcurrency' | 'testDevices' | 'imageMethod'> & {
  hosts?: Record<string, HostSettings>;
};

/** The schema defaults of the `$defs/host` values that have one. */
export interface HostDefaults {
  playInstances: number;
  reviewRunConcurrency: number;
  imageMethod: string;
}

function hostDefault<T extends 'number' | 'string'>(schema: unknown, key: keyof HostDefaults, type: T): T extends 'number' ? number : string {
  const properties = (schema as { $defs?: { host?: { properties?: Record<string, { default?: unknown }> } } }).$defs?.host?.properties;
  const value = properties?.[key]?.default;
  if (typeof value !== type) throw new OgwError(`harness settings schema $defs.host.properties.${key} has no default`);
  return value as T extends 'number' ? number : string;
}

/** The schema defaults of the host values of harness settings schema `schema`. */
export function hostDefaults(schema: unknown): HostDefaults {
  return {
    playInstances: hostDefault(schema, 'playInstances', 'number'),
    reviewRunConcurrency: hostDefault(schema, 'reviewRunConcurrency', 'number'),
    imageMethod: hostDefault(schema, 'imageMethod', 'string'),
  };
}

/** Harness settings with the values of `host` (an entry of `hosts`, or undefined when this host has none). */
export function withHostValues(file: HarnessSettingsFile, host: HostSettings | undefined, defaults: HostDefaults): HarnessSettings {
  const settings: HarnessSettings = {
    ...file,
    maxConcurrentInstances: host?.maxConcurrentInstances ?? null,
    playInstances: host?.playInstances ?? defaults.playInstances,
    reviewRunConcurrency: host?.reviewRunConcurrency ?? defaults.reviewRunConcurrency,
    imageMethod: host?.imageMethod ?? defaults.imageMethod,
    resourceGeneration: file.resourceGeneration.map((inFile) => {
      const method = { ...inFile };
      Reflect.deleteProperty(method, 'measured');
      const steps = host?.measured?.[method.name];
      return steps === undefined ? method : { ...method, measured: steps };
    }),
  };
  Reflect.deleteProperty(settings, 'hosts');
  if (host?.testDevices === undefined) Reflect.deleteProperty(settings, 'testDevices');
  else settings.testDevices = host.testDevices;
  return settings;
}

/**
 * The id under which harness settings `hosts` holds this host's entry, or null when `hosts` is missing or empty: then no
 * host has an entry and the host id is not read ([ogw](../../ogw.md) `## host`).
 */
export async function hostEntryId(hosts: unknown, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (typeof hosts !== 'object' || hosts === null || Object.keys(hosts).length === 0) return null;
  return (await currentHost(env)).id;
}

/** Harness settings with this host's values. The host id is read only when `hosts` has an entry (`hostEntryId`). */
export async function loadHarnessSettings(env: NodeJS.ProcessEnv = process.env): Promise<HarnessSettings> {
  const file = await readJson<HarnessSettingsFile>(harnessSettingsPath(env));
  const id = await hostEntryId(file.hosts, env);
  const host = id === null ? undefined : file.hosts?.[id];
  return withHostValues(file, host, hostDefaults(await readJson(schemaPath('harness-settings', env))));
}

export function workspaceFrom(settings: HarnessSettings, env: NodeJS.ProcessEnv = process.env): Workspace {
  const root = workspaceRoot(env);
  return {
    harness: harnessRoot(env),
    root,
    coreImpl: resolve(root, settings.paths.coreImpl),
    coreReleases: resolve(root, settings.paths.coreReleases),
    games: resolve(root, settings.paths.games),
    worktrees: resolve(root, settings.paths.worktrees),
  };
}

export function gameSettingsPath(gameRoot: string): string {
  return join(gameRoot, 'settings.json');
}

export async function loadGameSettings(gameRoot: string): Promise<GameSettings> {
  return readJson<GameSettings>(gameSettingsPath(gameRoot));
}

/**
 * Runs `fn` in the lock of the game settings of the checkout `gameRoot`. Every command that reads, changes and writes
 * that file does it from the read to the write in this lock, so no write drops a change another command made between.
 */
export async function withGameSettingsLock<T>(gameRoot: string, env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  return withLock(await checkoutLock(gameRoot, 'ogw-game-settings.lock', { env }), fn);
}

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

function newAjv(useDefaults: boolean): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults });
  addFormats(ajv);
  ajv.addKeyword({ keyword: 'x-owner', schemaType: 'string' });
  ajv.addKeyword({ keyword: 'x-stage', schemaType: 'string' });
  return ajv;
}

function describeError(error: ErrorObject): string {
  const where = error.instancePath === '' ? '/' : error.instancePath;
  const params = error.keyword === 'additionalProperties'
    ? ` (${String((error.params as { additionalProperty?: string }).additionalProperty)})`
    : '';
  return `${where} ${error.message ?? error.keyword}${params}`;
}

/** Compiled validators by schema object identity; one Ajv per schema so schemas with one `$id` do not clash. */
const compiled = { plain: new WeakMap<object, ValidateFunction>(), defaults: new WeakMap<object, ValidateFunction>() };

function compiledValidator(schema: object, useDefaults: boolean): ValidateFunction {
  const cache = useDefaults ? compiled.defaults : compiled.plain;
  let validate = cache.get(schema);
  if (!validate) {
    validate = newAjv(useDefaults).compile(schema);
    cache.set(schema, validate);
  }
  return validate;
}

/** Validates a value against a JSON schema. Returns the Ajv errors; empty when valid. */
export function validateStructured(schema: object, value: unknown): ErrorObject[] {
  const validate = compiledValidator(schema, false);
  return validate(value) ? [] : [...(validate.errors ?? [])];
}

/** Validates a value against a JSON schema. Returns one line per error; empty when valid. */
export function validateAgainst(schema: object, value: unknown): string[] {
  return validateStructured(schema, value).map(describeError);
}

/** Returns a copy of `value` with schema `default` values filled in where the value has none. */
export function withDefaults<T>(schema: object, value: T): T {
  const copy = structuredClone(value);
  compiledValidator(schema, true)(copy);
  return copy;
}

export async function loadSchema(path: string): Promise<object> {
  const schema = await readJson(path);
  if (typeof schema !== 'object' || schema === null) throw new OgwError(`schema is not an object: ${path}`);
  return schema;
}
