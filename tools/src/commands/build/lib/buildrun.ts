import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { gitLine, revParse, showFile } from '../../../lib/git.ts';
import { openRun, type RunState } from '../../../lib/runstate.ts';
import { loadGameSettings, loadSchema, schemaPath, withDefaults, type GameSettings } from '../../../lib/settings.ts';
import { buildDirName, parseEnv, type Env } from './names.ts';

/** Fields `ogw build start` keeps in `run.data.build`. */
export interface BuildRunData {
  /** Retries counted by `ogw build retry`. */
  retries: number;
  /** Bundle patch number, or null. */
  bundle: number | null;
  /** The commit the build branch was made from (`baseCommit`), for PROD the `stg-<version>` commit. */
  startCommit: string;
}

export interface OpenBuildRun {
  run: RunState;
  env: Env;
  /** `<version>` or `<app version>-bundle-<n>`. */
  version: string;
  data: BuildRunData;
}

export function buildData(run: RunState): BuildRunData {
  const value = run.data.build as Partial<BuildRunData> | undefined;
  return {
    retries: value?.retries ?? 0,
    bundle: value?.bundle ?? null,
    startCommit: value?.startCommit ?? run.baseCommit,
  };
}

/** The open build run of the game; fails when the game has none. */
export async function requireBuildRun(game: GameRepo): Promise<OpenBuildRun> {
  const run = await openRun(game);
  if (run?.kind !== 'build' || run.env === null || run.version === null) {
    throw new OgwError(`no open build run for game ${game.name}`);
  }
  return { run, env: parseEnv(run.env), version: run.version, data: buildData(run) };
}

/** Subject of the merge commit `ogw build finish` makes on main for a DEV or STG build run. */
export function buildMergeSubject(run: RunState): string {
  return `build: merge ${run.branch}`;
}

/**
 * True when `commit` is the merge `ogw build finish` made for this build run: its parents are the build branch's
 * start commit and the build branch's HEAD, and its subject is the run's merge subject. An earlier `build finish`
 * that stopped after the merge and before the tag leaves main there.
 */
export async function isBuildRunMerge(root: string, run: RunState, commit: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const branchHead = await revParse(root, run.branch, { env });
  const parents = (await gitLine(root, ['rev-list', '--parents', '-n', '1', commit], { env })).split(' ').slice(1);
  if (parents.length !== 2 || parents[0] !== run.baseCommit || parents[1] !== branchHead) return false;
  return (await gitLine(root, ['log', '-1', '--format=%s', commit], { env })) === buildMergeSubject(run);
}

/** `builds/<env>-<version>/` of the checkout. */
export function buildDir(game: GameRepo, env: Env, version: string): string {
  return join(game.root, 'builds', buildDirName(env, version));
}

export function buildRunFile(game: GameRepo, env: Env, version: string): string {
  return join(buildDir(game, env, version), 'build-run.json');
}

/** Game settings of a checkout with the schema defaults filled in. */
export async function gameSettingsWithDefaults(root: string, env: NodeJS.ProcessEnv): Promise<GameSettings> {
  const schema = await loadSchema(schemaPath('game-settings', env));
  return withDefaults(schema, await loadGameSettings(root));
}

/** Game settings `settings.json` of a commit with the schema defaults filled in. */
export async function gameSettingsAt(root: string, commit: string, env: NodeJS.ProcessEnv): Promise<GameSettings> {
  const bytes = await showFile(root, commit, 'settings.json', { env });
  if (bytes === null) throw new OgwError(`commit ${commit} has no settings.json`);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new OgwError(`settings.json of commit ${commit} is not JSON: ${(error as Error).message}`);
  }
  const schema = await loadSchema(schemaPath('game-settings', env));
  return withDefaults(schema, value as GameSettings);
}

export type CheckOutcome = 'pass' | 'fail' | 'warn' | 'unknown';

export interface BuildCheck {
  name: string;
  result: CheckOutcome;
  /** Failure (or warning) lines. */
  details: string[];
}

export interface HumanFailure {
  check: string;
  targets: string[];
}

/** `builds/<env>-<version>/build-run.json` written by `ogw build run`. */
export interface BuildRunResult {
  env: Env;
  version: string;
  checks: BuildCheck[];
  human: HumanFailure[];
  /** DEV build: resource keys the `license` check warned about. */
  licenseWarnings: string[];
  /** First loading ms web smoke measured, or null. */
  webSmokeLoadingMs: number | null;
  /** `protocol change` build: the two data versions the server accepts; null when not a protocol change build. */
  protocolChange: { client_data_version: string; compat_client_data_version: string } | null;
  /** Data versions of the new server (`server/build/data/`); compat is '' when the file is absent. */
  serverDataVersions: { client_data_version: string; compat_client_data_version: string } | null;
  /** The last PROD build tag, or `none`. */
  compatibilityBase: string;
  /** `freeSigning`: the free signing method of a DEV build artifact. */
  artifacts: { platform: string; path: string; freeSigning?: string }[];
  serverImage: { name: string; tag: string; digest: string } | null;
  /** PROD build: converters added after the last PROD build. */
  converters: { kind: string; fromVersion: number }[] | null;
  /** PROD build: `coreSchemaVersion` of the last PROD build and of this build. */
  coreSchema: { last: number | null; current: number | null } | null;
  /** Match wait ms (`build` `## deploy` PROD 3), or null. */
  matchWaitMs: number | null;
}
