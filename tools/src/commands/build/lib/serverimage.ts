import { cp, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import * as tar from 'tar';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { runOk } from '../../../lib/proc.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { writeFileAtomic } from '../../../lib/fsx.ts';
import type { GameSettings } from '../../../lib/settings.ts';
import { filesBelow } from '../../deploy/lib/target.ts';
import { moduleFilesWithoutDev } from '../../generate/api.ts';
import { filterCoreSettingsFile } from './godot.ts';
import { buildTagName, type Env } from './names.ts';
import { ghcrLogin, imageDigest } from './registry.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';

export interface ServerImage {
  name: string;
  tag: string;
  digest: string;
}

function repositoryOf(settings: GameSettings): { repository: string; platform: string } {
  const image = settings.serverImage as { repository?: string; platform?: string } | undefined;
  if (!image?.repository) throw new OgwError('game settings serverImage.repository is missing');
  return { repository: image.repository, platform: image.platform ?? 'linux/amd64' };
}

/**
 * Runs `fn` on the build context of the server image: a copy of `server/` (without `node_modules/`) in a temporary
 * folder. For STG its `generated/core_settings.json` and `generated/server_modules.json` are made from the used modules
 * without their DEV modules (`core` skill `## module`), and `generated/core_settings.json` keeps only this
 * environment's `<ENV>` items.
 */
async function withServerContext<T>(ctx: Context, game: GameRepo, env: Env, fn: (server: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await newPrivateTempFolder('ogw-server-image-', ctx.env);
  try {
    const server = join(dir, 'server');
    await cp(join(game.root, 'server'), server, { recursive: true, filter: (source) => !source.split(sep).includes('node_modules') });
    if (env !== 'DEV') {
      const files = await moduleFilesWithoutDev(ctx, game);
      await writeFileAtomic(join(server, 'generated', 'core_settings.json'), files.coreSettings);
      await writeFileAtomic(join(server, 'generated', 'server_modules.json'), files.serverModules);
    }
    await filterCoreSettingsFile(join(server, 'generated', 'core_settings.json'), env);
    return await fn(server, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Server DEV code paths (`server/dev/`, core `dev/`), relative to `server/`. */
function isDevCode(rel: string): boolean {
  return /^(dev|core\/[^/]+\/dev)\//.test(rel);
}

/**
 * Check `DEV code` of an STG server image: builds the image from its build context into a tar of its file system
 * (not pushed) and returns a failure for each DEV code file of the context that the image holds. A context without
 * DEV code builds nothing.
 */
export async function serverImageDevCode(ctx: Context, game: GameRepo, settings: GameSettings, env: Env): Promise<string[]> {
  const { platform } = repositoryOf(settings);
  return withServerContext(ctx, game, env, async (server, dir) => {
    const dev = (await filesBelow(server)).map((p) => relative(server, p).split(sep).join('/')).filter(isDevCode);
    if (dev.length === 0) return [];
    const image = join(dir, 'image.tar');
    await runOk(
      'docker',
      ['buildx', 'build', '--platform', platform, '--file', join(server, 'core', 'Dockerfile'), '--output', `type=tar,dest=${image}`, server],
      { env: ctx.env, timeoutMs: LIMITS.programMs },
    );
    const entries: string[] = [];
    await tar.t({ file: image, onReadEntry: (entry) => entries.push(entry.path.replace(/^\.?\/+/, '')) });
    return dev.filter((rel) => entries.some((e) => e === rel || e.endsWith(`/${rel}`))).map((rel) => `server image holds DEV code: server/${rel}`);
  });
}

/**
 * DEV, STG: builds the server image for `serverImage.platform` from the build context, with `core/Dockerfile` of the
 * copy, and pushes it as `<env>-<version>` (`build` `## server image`).
 */
export async function buildServerImage(ctx: Context, game: GameRepo, settings: GameSettings, env: Env, version: string, compat: string): Promise<ServerImage> {
  const { repository, platform } = repositoryOf(settings);
  const tag = buildTagName(env, version);
  await ghcrLogin(ctx);
  await withServerContext(ctx, game, env, async (server) => {
    await runOk(
      'docker',
      [
        'buildx', 'build',
        '--platform', platform,
        '--file', join(server, 'core', 'Dockerfile'),
        '--label', `ogw.compat_client_data_version=${compat}`,
        '--tag', `${repository}:${tag}`,
        '--push',
        server,
      ],
      { env: ctx.env, timeoutMs: LIMITS.programMs },
    );
  });
  const digest = await imageDigest(ctx, `${repository}:${tag}`);
  if (digest === null) throw new OgwError(`pushed server image ${repository}:${tag} is not in the registry`);
  return { name: repository, tag, digest };
}

/** PROD: the `stg-<version>` server image of the same commit, by digest. */
export async function stgServerImage(ctx: Context, settings: GameSettings, version: string): Promise<ServerImage> {
  const { repository } = repositoryOf(settings);
  const tag = `stg-${version}`;
  await ghcrLogin(ctx);
  const digest = await imageDigest(ctx, `${repository}:${tag}`);
  if (digest === null) throw new OgwError(`server image ${repository}:${tag} is not in the registry`);
  return { name: repository, tag, digest };
}
