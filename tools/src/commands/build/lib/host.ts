import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { readJson } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { gameSecretService, type SecretScope } from '../../../lib/secrets.ts';
import type { GameSettings, HarnessSettings } from '../../../lib/settings.ts';
import { ogwOperatorSecret } from '../../admin/api.ts';
import { missingLoginToken } from '../../secret/lib/login-token.ts';
import { coreRelease, coreReleaseOfGame, extractedAsset } from '../../core/api.ts';
import { requireSupportedCore } from '../../core/lib/harness-core.ts';
import { dockerBuildx, ghStatus, hostPlatform, postgresPresent, probeBuildTool, requireEngine, toolProgram, type BuildToolSpec } from '../../env/api.ts';
import type { Env } from './names.ts';
import { signingRequired, SIGNED_PLATFORMS } from './signing-method.ts';

export interface BuildTool extends BuildToolSpec {
  platform: string;
  hosts: string[];
}

export interface EngineJson {
  godot?: string;
  buildTools?: BuildTool[];
  plugins?: unknown[];
  [key: string]: unknown;
}

/**
 * `engine.json` of a core release of the game (root of `client-<engine>.zip`): of `version`, the core of the commit a
 * build checks, or of the checkout's `coreVersion` when it is left out.
 */
export async function engineJson(ctx: Context, game: GameRepo, engine: string, version?: string): Promise<EngineJson> {
  if (version !== undefined) await requireSupportedCore(ctx, game.name, version);
  const release = version === undefined ? await coreReleaseOfGame(ctx, game) : await coreRelease(ctx, version);
  const dir = await extractedAsset(ctx, release, `client-${engine}.zip`);
  return readJson<EngineJson>(join(dir, 'engine.json'));
}

export function secretPresent(ctx: Context, game: string, scope: SecretScope, name: string): boolean {
  return ctx.secrets.get(gameSecretService(game, scope, name)) !== null;
}

export function requireOperatorSecret(ctx: Context, game: string, settings: GameSettings, env: Env): string | null {
  const operator = ogwOperatorSecret(ctx, game, settings, env);
  return 'problem' in operator ? operator.problem : null;
}

export interface HostCheckInput {
  game: GameRepo;
  env: Env;
  platforms: string[];
  settings: GameSettings;
  harness: HarnessSettings;
  hasProdTag: boolean;
}

/** Signing secrets of the platforms with `signing.<platform>`; a DEV build of a platform without it uses free signing. */
function signingProblems(ctx: Context, input: HostCheckInput): string[] {
  const problems: string[] = [];
  const signing = (input.settings.signing ?? {}) as Record<string, Record<string, string> | undefined>;
  for (const platform of input.platforms.filter((p) => SIGNED_PLATFORMS.includes(p))) {
    const names = signing[platform];
    if (!names) {
      if (signingRequired(input.settings, input.env, platform)) problems.push(`game settings signing.${platform} is missing`);
      continue;
    }
    for (const [key, name] of Object.entries(names)) {
      if (!secretPresent(ctx, input.game.name, 'signing', name)) problems.push(`signing secret ${name} (${platform} ${key}) is not in the secret store`);
    }
  }
  return problems;
}

async function toolProblems(ctx: Context, input: HostCheckInput): Promise<string[]> {
  const problems: string[] = [];
  const engine = input.settings.engine ?? 'godot';
  const meta = await engineJson(ctx, input.game, engine, String(input.settings.coreVersion));
  try {
    await requireEngine(ctx, engine, meta.godot ?? '');
  } catch (error) {
    problems.push((error as Error).message);
  }
  const host = hostPlatform(ctx.env);
  for (const tool of meta.buildTools ?? []) {
    if (!input.platforms.includes(tool.platform) || host === null || !tool.hosts.includes(host)) continue;
    if (!(await probeBuildTool(ctx, tool)).ok) {
      problems.push(`build tool ${tool.name} ${tool.version} for ${tool.platform} is not on this host`);
    }
  }
  if (input.platforms.includes('web') && (await toolProgram(ctx, 'chromium')) === null) {
    problems.push('harness settings tools.chromium is not on this host');
  }
  return problems;
}

async function dockerProblems(ctx: Context, input: HostCheckInput): Promise<string[]> {
  const problems: string[] = [];
  const pg = input.harness.tools.postgresql;
  if (!(await postgresPresent(ctx, pg))) problems.push(`docker image postgres:${pg.tag}@${pg.digest} is not on this host`);
  const major = Number.parseInt(pg.tag, 10);
  if (major !== input.settings.postgresqlMajor) {
    problems.push(`harness settings tools.postgresql tag major ${String(major)} differs from game settings postgresqlMajor ${String(input.settings.postgresqlMajor)}`);
  }
  if (input.env === 'PROD') return problems;
  if (!(await dockerBuildx(ctx.env)).found) problems.push('docker buildx is not on this host');
  if (!(await ghStatus(ctx.env)).scopes.includes('write:packages')) problems.push('the GitHub CLI login has no write:packages scope');
  return problems;
}

/** The environment's `secrets` and `adminOperators` secrets that are not in the secret store (`ogw deploy` writes them). */
function deploySecretProblems(ctx: Context, input: HostCheckInput): string[] {
  const { env, settings, game } = input;
  const envSettings = settings.environments?.[env] ?? {};
  const secrets = (envSettings.secrets ?? {}) as Record<string, string>;
  const problems = Object.entries(secrets)
    .filter(([, name]) => !secretPresent(ctx, game.name, env, name))
    .map(([key]) => `secret ${key} of ${env} is not in the secret store`);
  const ogw = requireOperatorSecret(ctx, game.name, settings, env);
  if (ogw) problems.push(ogw);
  const operators = (Array.isArray(envSettings.adminOperators) ? envSettings.adminOperators : []) as { name?: unknown; secret?: unknown }[];
  for (const op of operators) {
    if (op.name === 'ogw' || typeof op.secret !== 'string' || secretPresent(ctx, game.name, env, op.secret)) continue;
    problems.push(`secret of operator ${String(op.name)} of ${env} is not in the secret store`);
  }
  return problems;
}

/** `updatePublicKeys` of the environment; a STG build also needs the PROD keys: a PROD build builds the commit STG checked. */
function updateKeyProblems(settings: HostCheckInput['settings'], env: Env): string[] {
  return (env === 'STG' ? (['STG', 'PROD'] as const) : [env]).flatMap((keyEnv) => {
    const keys = settings.environments?.[keyEnv]?.updatePublicKeys;
    return Array.isArray(keys) && keys.length > 0 ? [] : [`game settings environments.${keyEnv}.updatePublicKeys is missing`];
  });
}

function deployProblems(ctx: Context, input: HostCheckInput): string[] {
  const { env, settings, game } = input;
  const problems: string[] = [];
  const envSettings = settings.environments?.[env] ?? {};
  problems.push(...updateKeyProblems(settings, env));
  if (env === 'PROD') return problems;
  if (!envSettings.deploy) problems.push(`game settings environments.${env}.deploy is missing`);
  problems.push(...deploySecretProblems(ctx, input));
  const prod = input.hasProdTag ? requireOperatorSecret(ctx, game.name, settings, 'PROD') : null;
  if (prod) problems.push(prod);
  return problems;
}

/** Host and settings checks of `build` `## procedure` 1, before anything is made. */
export async function hostProblems(ctx: Context, input: HostCheckInput): Promise<string[]> {
  const problems: string[] = [];
  if (input.platforms.some((p) => p === 'ios' || p === 'macos') && hostPlatform(ctx.env) !== 'macos-arm64') {
    problems.push('ios and macos build only on a Mac host');
  }
  problems.push(...signingProblems(ctx, input));
  problems.push(...(await toolProblems(ctx, input)));
  problems.push(...(await dockerProblems(ctx, input)));
  problems.push(...deployProblems(ctx, input));
  // the loop steps of the build run play and judge agents
  const tokenMissing = missingLoginToken(ctx, input.harness);
  if (tokenMissing !== null) problems.push(tokenMissing);
  return problems;
}
