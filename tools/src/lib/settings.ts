import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { join, resolve } from 'node:path';
import { OgwError } from './errors.ts';
import { readJson, readJsonIfExists } from './fsx.ts';
import { checkoutLock } from './git.ts';
import { hostId } from './host.ts';
import { isPlainObject, mergeSettings, valueUnits, type JsonObject } from './json.ts';
import { withLock } from './lock.ts';
import { harnessRoot, workspaceRoot } from './paths.ts';
import { isLocalScope, runPaths } from './schema-nav.ts';

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
  /** Harness settings `measured.<name>` (`loadHarnessSettings`); the files have no `measured` on a method. */
  measured?: MeasuredStep[];
  [key: string]: unknown;
}

export interface TestDevice {
  platform: 'android';
  serial: string;
}

/**
 * Harness settings as commands use them: the merged files with `measured` on the methods. `maxConcurrentInstances` and
 * `webSmokeCpuThrottleRate` are null when this host has no measured value, `instanceMeasureLimit`, `playInstances`,
 * `reviewRunConcurrency` and `imageMethod` are the schema defaults when the files have none, and each method has the
 * `measured` steps of its name.
 */
export interface HarnessSettings {
  humanLanguage: string;
  agents: Partial<Record<Role, AgentSettings>>;
  maxConcurrentInstances: number | null;
  instanceMeasureLimit: number;
  instanceWaitTimeoutMs: number;
  performanceLeaseWaitTimeoutMs: number;
  jobWaitTimeoutMs: number;
  testDevices?: TestDevice[];
  playInstances: number;
  reviewRunConcurrency: number;
  imageMethod: string;
  backgroundRetryLimit: number;
  /** The most fix rounds of one `ogw agent` job (ogw.md `### result format` of `## agent`). */
  resultFixRounds: number;
  webSmokeCpuThrottleRate: number | null;
  webSmokeDeviceBenchmarkIndex: number;
  webSmokeBootTimeoutMs: number;
  loopStop: { repeatedDefect: number; oscillation: number; plateau: number; successJudges: number };
  loop: {
    funIterations: number;
    judgeVotes: number;
    judgePanel: AgentSettings[];
    /** The judges of the confirmation pair and the success confirmation judges; absent: no confirmation pair. */
    confirmJudge?: AgentSettings;
    /** What a judge running with `confirmJudge` runs with once more after a limit message; absent: no fallback. */
    confirmFallback?: AgentSettings;
    variants: number;
    playTimeLimitMs: number;
    playBudgetMs: number;
    judgeInstanceBudgetMs: number;
    judgeTimeLimitMs: number;
  };
  calibration: {
    nullPairs: number;
    orderPairs: number;
    orderRuns: number;
    retestPairs: number;
    degradedPairs: number;
    degradeLatencyMs: number;
    degradeNetworkDelayMs: number;
    minDecisions: number;
  };
  reviewRounds: number;
  codeCheck: { maxComplexity: number };
  rigCheck: { iouMin: number; colorDiffMax: number };
  regress: { repeats: number; modelRepeats: number; parallel: number; permutations: number; level: number };
  paths: { coreImpl: string; coreReleases: string; games: string; worktrees: string; regress: string };
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
  /** The regress repo of the regression suite (ogw.md `### regress repo`). */
  regress: string;
}

export function harnessSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(harnessRoot(env), 'settings.json');
}

/** Local harness settings: `settings.local.json` of the harness repo, not committed, merged over `settings.json`. */
export function localHarnessSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(harnessRoot(env), 'settings.local.json');
}

/** The two files of harness settings: `settings.json` and `settings.local.json` (null when there is none). */
export interface HarnessSettingsFiles {
  shared: JsonObject;
  local: JsonObject | null;
  /** True when the files on disk hold host items (ogw.md `## host`), which these values took in: a write writes both files. */
  rewrite?: boolean;
}

function asObject(path: string, value: unknown): JsonObject {
  if (!isPlainObject(value)) throw new OgwError(`not a JSON object: ${path}`);
  return value;
}

function hostItems(file: JsonObject | null): JsonObject | null {
  if (file === null || !Object.hasOwn(file, 'hosts')) return null;
  return isPlainObject(file.hosts) ? file.hosts : {};
}

function withoutHosts(file: JsonObject): JsonObject {
  const copy = { ...file };
  Reflect.deleteProperty(copy, 'hosts');
  return copy;
}

/**
 * The files with the host items of this host taken in (ogw.md `## host`): the item of `settings.local.json` merged over
 * that of `settings.json`, without `name`, merged under the top-level values of `settings.local.json`, and no `hosts`
 * in either file. The host id is read only when a file holds a host item.
 */
export async function withHostItems(files: HarnessSettingsFiles, env: NodeJS.ProcessEnv = process.env): Promise<HarnessSettingsFiles> {
  const sharedItems = hostItems(files.shared);
  const localItems = hostItems(files.local);
  if (sharedItems === null && localItems === null) return files;
  let item: JsonObject = {};
  if (Object.keys(sharedItems ?? {}).length + Object.keys(localItems ?? {}).length > 0) {
    const id = await hostId(env);
    const own = (items: JsonObject | null): JsonObject => (isPlainObject(items?.[id]) ? items[id] : {});
    item = mergeSettings(own(sharedItems), own(localItems));
    Reflect.deleteProperty(item, 'name');
  }
  const local = mergeSettings(item, withoutHosts(files.local ?? {}));
  return { shared: withoutHosts(files.shared), local: files.local === null && Object.keys(local).length === 0 ? null : local, rewrite: true };
}

/** The two files of harness settings, with the host items of this host taken in (`withHostItems`). */
export async function readHarnessSettingsFiles(env: NodeJS.ProcessEnv = process.env): Promise<HarnessSettingsFiles> {
  const sharedPath = harnessSettingsPath(env);
  const localPath = localHarnessSettingsPath(env);
  const local = await readJsonIfExists(localPath);
  return withHostItems({ shared: asObject(sharedPath, await readJson(sharedPath)), local: local === null ? null : asObject(localPath, local) }, env);
}

/** The units (`valueUnits`) of `settings.local.json` that are not local-scope paths, which it does not hold (AGENTS.md `## settings`). */
export function nonLocalUnits(schema: JsonObject, local: JsonObject | null): string[][] {
  return local === null ? [] : valueUnits(local).filter((unit) => !isLocalScope(schema, unit));
}

/** Harness settings as one value: `settings.local.json` over `settings.json` (objects merge key by key, arrays and other values are replaced). */
export function mergedHarnessSettings(files: HarnessSettingsFiles): JsonObject {
  return files.local === null ? files.shared : mergeSettings(files.shared, files.local);
}

export function schemaPath(name: 'harness-settings' | 'game-settings', env: NodeJS.ProcessEnv = process.env): string {
  return join(harnessRoot(env), 'schemas', `${name}.schema.json`);
}

/** Harness settings as the merged files hold them: `measured` at the top level, and no schema default filled in. */
export type HarnessSettingsFile = Omit<
  HarnessSettings,
  'maxConcurrentInstances' | 'instanceMeasureLimit' | 'playInstances' | 'reviewRunConcurrency' | 'imageMethod' | 'webSmokeCpuThrottleRate'
> & {
  maxConcurrentInstances?: number;
  instanceMeasureLimit?: number;
  playInstances?: number;
  reviewRunConcurrency?: number;
  imageMethod?: string;
  webSmokeCpuThrottleRate?: number;
  measured?: Record<string, MeasuredStep[]>;
};

/** The schema defaults of the local-scope values that have one. */
export interface LocalDefaults {
  instanceMeasureLimit: number;
  playInstances: number;
  reviewRunConcurrency: number;
  imageMethod: string;
}

function localDefault<T extends 'number' | 'string'>(schema: unknown, key: keyof LocalDefaults, type: T): T extends 'number' ? number : string {
  const properties = (schema as { properties?: Record<string, { default?: unknown }> }).properties;
  const value = properties?.[key]?.default;
  if (typeof value !== type) throw new OgwError(`harness settings schema properties.${key} has no default`);
  return value as T extends 'number' ? number : string;
}

/** The schema defaults of the local-scope values of harness settings schema `schema` that have one. */
export function localDefaults(schema: unknown): LocalDefaults {
  return {
    instanceMeasureLimit: localDefault(schema, 'instanceMeasureLimit', 'number'),
    playInstances: localDefault(schema, 'playInstances', 'number'),
    reviewRunConcurrency: localDefault(schema, 'reviewRunConcurrency', 'number'),
    imageMethod: localDefault(schema, 'imageMethod', 'string'),
  };
}

/** Harness settings as commands use them (`HarnessSettings`) from the merged files. */
export function harnessSettingsOf(file: HarnessSettingsFile, defaults: LocalDefaults): HarnessSettings {
  const measured = file.measured;
  const settings: HarnessSettings = {
    ...file,
    maxConcurrentInstances: file.maxConcurrentInstances ?? null,
    instanceMeasureLimit: file.instanceMeasureLimit ?? defaults.instanceMeasureLimit,
    playInstances: file.playInstances ?? defaults.playInstances,
    reviewRunConcurrency: file.reviewRunConcurrency ?? defaults.reviewRunConcurrency,
    imageMethod: file.imageMethod ?? defaults.imageMethod,
    webSmokeCpuThrottleRate: file.webSmokeCpuThrottleRate ?? null,
    resourceGeneration: file.resourceGeneration.map((inFile) => {
      const method = { ...inFile };
      Reflect.deleteProperty(method, 'measured');
      const steps = measured?.[method.name];
      return steps === undefined ? method : { ...method, measured: steps };
    }),
  };
  Reflect.deleteProperty(settings, 'measured');
  return settings;
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) current = isPlainObject(current) ? current[segment] : undefined;
  return current;
}

/** `root` with `value` at the object path `path`, or without the path when `value` is undefined. */
function withValueAt(root: JsonObject, path: readonly string[], value: unknown): JsonObject {
  const [head, ...rest] = path;
  if (head === undefined) return root;
  const out = { ...root };
  if (rest.length > 0) out[head] = withValueAt(isPlainObject(out[head]) ? out[head] : {}, rest, value);
  else if (value === undefined) Reflect.deleteProperty(out, head);
  else out[head] = structuredClone(value);
  return out;
}

/**
 * The run settings of the merged harness settings `merged` (ogw.md `## loop start`): the values that `merged`, with
 * the schema defaults filled in, holds at the run paths of `schema`.
 */
export function runSettingsOf(schema: JsonObject, merged: JsonObject): JsonObject {
  const filled = withDefaults(schema, merged);
  let out: JsonObject = {};
  for (const path of runPaths(schema)) {
    const value = valueAt(filled, path);
    if (value !== undefined) out = withValueAt(out, path, value);
  }
  return out;
}

/** `merged` whose run paths hold the values of the run settings `run`: a run path that `run` does not hold has no value. */
export function withRunSettings(schema: JsonObject, merged: JsonObject, run: JsonObject): JsonObject {
  let out = merged;
  for (const path of runPaths(schema)) out = withValueAt(out, path, valueAt(run, path));
  return out;
}

/** The merged harness settings; fails when `settings.local.json` holds a path that is not local-scope (AGENTS.md `## settings`). */
async function mergedChecked(schema: JsonObject, env: NodeJS.ProcessEnv): Promise<JsonObject> {
  const files = await readHarnessSettingsFiles(env);
  const outside = nonLocalUnits(schema, files.local).map((unit) => unit.join('.'));
  if (outside.length > 0) {
    const which = outside.length === 1 ? 'is not a local-scope path' : 'are not local-scope paths';
    throw new OgwError(
      `settings.local.json holds ${outside.join(', ')}, which ${which}: set the value that applies on every host with ogw settings set ${outside[0] as string} <JSON value>, which moves the paths that are not local-scope to settings.json`,
    );
  }
  return mergedHarnessSettings(files);
}

/** The run settings of harness settings now (`runSettingsOf`), which a pin records (ogw.md `## loop start`). */
export async function currentRunSettings(env: NodeJS.ProcessEnv = process.env): Promise<JsonObject> {
  const schema = (await loadSchema(schemaPath('harness-settings', env))) as JsonObject;
  return runSettingsOf(schema, await mergedChecked(schema, env));
}

/**
 * Harness settings: local harness settings merged over `settings.json`, with the host items of this host taken in
 * (ogw.md `## host`). With `run`, the run paths hold the values of those run settings (ogw.md `## loop start`).
 */
export async function loadHarnessSettings(env: NodeJS.ProcessEnv = process.env, run?: JsonObject): Promise<HarnessSettings> {
  const schema = (await loadSchema(schemaPath('harness-settings', env))) as JsonObject;
  const merged = await mergedChecked(schema, env);
  const file = (run === undefined ? merged : withRunSettings(schema, merged, run)) as unknown as HarnessSettingsFile;
  return harnessSettingsOf(file, localDefaults(schema));
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
    regress: resolve(root, settings.paths.regress),
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
  ajv.addKeyword({ keyword: 'x-scope', schemaType: 'string' });
  ajv.addKeyword({ keyword: 'x-run', schemaType: 'boolean' });
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
