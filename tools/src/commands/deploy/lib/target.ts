import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readJsonIfExists } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { gameSecretService } from '../../../lib/secrets.ts';
import type { GameSettings } from '../../../lib/settings.ts';
import { buildDir, buildRunFile, gameSettingsWithDefaults, type BuildRunResult } from '../../build/lib/buildrun.ts';
import { buildTagName, buildTags, lastProdTag, type Env } from '../../build/lib/names.ts';
import type { PatchEntry, UpdateJson } from './deploylist.ts';
import type { DeployHost } from './ssh.ts';

export interface UpdateFile {
  path: string;
  sha256: string;
  bytes: Buffer;
}

/** Everything `ogw deploy` needs about the build and the environment. */
export interface DeployTarget {
  game: GameRepo;
  env: Env;
  version: string;
  settings: GameSettings;
  envSettings: Record<string, unknown>;
  host: DeployHost;
  buildRun: BuildRunResult;
  hasProdTag: boolean;
  updateFiles: UpdateFile[];
  update: UpdateJson | null;
  patch: { appVersion: string; entry: PatchEntry } | null;
  /** `builds/<env>-<version>/web/` when the build has a web artifact. */
  webDir: string | null;
}

export async function filesBelow(dir: string): Promise<string[]> {
  if (!exists(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

async function updateFiles(dir: string): Promise<UpdateFile[]> {
  const files: UpdateFile[] = [];
  for (const sub of ['patch', 'update']) {
    for (const path of await filesBelow(join(dir, sub))) {
      const rel = relative(dir, path);
      if (rel === join('update', 'update.json') || rel === join('patch', 'patch.json')) continue;
      const bytes = await readFile(path);
      files.push({ path, bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  return files;
}

/** A secret value of the environment from this host's secret store. */
export function envSecret(ctx: Context, target: { game: GameRepo; env: Env; envSettings: Record<string, unknown> }, key: string): string {
  const name = (target.envSettings.secrets as Record<string, string> | undefined)?.[key];
  if (name === undefined) throw new OgwError(`game settings environments.${target.env}.secrets.${key} is missing`);
  const value = ctx.secrets.get(gameSecretService(target.game.name, target.env, name));
  if (value === null) throw new OgwError(`secret ${name} of ${target.env} is not in the secret store`);
  return value;
}

export async function loadDeployTarget(ctx: Context, game: GameRepo, env: Env, version: string): Promise<DeployTarget> {
  const dir = buildDir(game, env, version);
  const buildRun = await readJsonIfExists<BuildRunResult>(buildRunFile(game, env, version));
  if (!buildRun) throw new OgwError(`build ${buildTagName(env, version)} not found: ${buildRunFile(game, env, version)} is missing`);
  const settings = await gameSettingsWithDefaults(game.root, ctx.env);
  const envSettings = settings.environments?.[env] ?? {};
  const host = envSettings.deploy as DeployHost | undefined;
  if (!host) throw new OgwError(`game settings environments.${env}.deploy is missing`);
  const bundleFor = /^(.*)-bundle-[0-9]+$/.exec(version)?.[1];
  const patchEntry = await readJsonIfExists<PatchEntry>(join(dir, 'patch', 'patch.json'));
  return {
    game,
    env,
    version,
    settings,
    envSettings,
    host,
    buildRun,
    hasProdTag: lastProdTag(await buildTags(game.root)) !== null,
    updateFiles: await updateFiles(dir),
    update: await readJsonIfExists<UpdateJson>(join(dir, 'update', 'update.json')),
    patch: patchEntry && bundleFor !== undefined ? { appVersion: bundleFor, entry: patchEntry } : null,
    webDir: exists(join(dir, 'web')) ? join(dir, 'web') : null,
  };
}

