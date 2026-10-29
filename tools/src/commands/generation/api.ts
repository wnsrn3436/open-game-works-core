// Generation group API for other groups: the `## method` rule of `skills/resource/production.md`, the catalog listing and method installs.
import type { Context } from '../../lib/command.ts';
import { startBackground } from '../../lib/cli.ts';
import { OgwError } from '../../lib/errors.ts';
import type { GameRepo } from '../../lib/game.ts';
import { listJobs } from '../../lib/jobs.ts';
import { toolProgram } from '../env/api.ts';
import { installCommand } from './install.ts';
import { chooseMethods, uninstalledMethods, type MethodChoice } from './lib/select.ts';
import { catalogEntries as listCatalog, type CatalogFile } from './list.ts';

export type { CatalogFile, MethodChoice };

/** Methods a resource key can use and the stage of each, as `ogw generation methods <game> <key>` gives them. */
export async function generationMethods(ctx: Context, game: GameRepo, resourceKey: string): Promise<MethodChoice[]> {
  return chooseMethods(ctx, await ctx.settings(), game, resourceKey);
}

/** Files of a catalog method with path, license, source URL, attribution and character set, as `ogw generation list <method>` gives them. */
export function catalogEntries(ctx: Context, method: string): Promise<CatalogFile[]> {
  return listCatalog(ctx, method);
}

/**
 * The methods that block a resource key on this host, as `uninstalledMethods` says; empty when they cannot be told (a
 * key the list or its spec rejects, which the resource sub-agent reports, or a file that cannot be read).
 */
export async function blockingMethods(ctx: Context, game: GameRepo, resourceKey: string): Promise<string[]> {
  try {
    return await uninstalledMethods(ctx, await ctx.settings(), game, resourceKey);
  } catch {
    return [];
  }
}

/**
 * The job that installs `method`: a running `ogw generation install` job of that method or of every method, else a new
 * background job of `ogw generation install <method>`. Returns the job id and its argv. Fails for a method with
 * `provider` while `tools.ffmpeg` is not installed: its `cli` puts that program on PATH, and only the install of every
 * method installs `tools`.
 */
export async function installMethodJob(ctx: Context, method: string): Promise<{ job: string; argv: string[] }> {
  const running = (await listJobs(ctx.env)).find(
    (job) => job.status === 'running' && job.command === 'generation install' && (job.argv.length === 2 || job.argv[2] === method),
  );
  if (running) return { job: running.id, argv: running.argv };
  const provider = (await ctx.settings()).resourceGeneration.find((m) => m.name === method)?.provider !== undefined;
  if (provider && (await toolProgram(ctx, 'ffmpeg')) === null) throw new OgwError('tools.ffmpeg is not installed: ogw generation install installs it');
  const started = await startBackground(ctx, installCommand, { positionals: [method], values: {}, raw: [method] }, null);
  return { job: (started.data as { job: string }).job, argv: ['generation', 'install', method] };
}
