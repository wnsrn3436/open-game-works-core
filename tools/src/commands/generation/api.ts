// Generation group API for other groups: the `## method` rule of `skills/resource/production.md`, the catalog listing and method installs.
import type { Context } from '../../lib/command.ts';
import { startBackground } from '../../lib/cli.ts';
import { OgwError } from '../../lib/errors.ts';
import { listJobs } from '../../lib/jobs.ts';
import type { GameRepo } from '../../lib/game.ts';
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
 * The methods of a resource key that are all not installed on this host while the key has no other method, as
 * `uninstalledMethods` says; empty for a key the list or its spec rejects, which the resource sub-agent reports.
 */
export async function blockingMethods(ctx: Context, game: GameRepo, resourceKey: string): Promise<string[]> {
  try {
    return await uninstalledMethods(ctx, await ctx.settings(), game, resourceKey);
  } catch (error) {
    if (error instanceof OgwError) return [];
    throw error;
  }
}

/**
 * Starts `ogw generation install <method>` as a background job and returns its id, or returns the id of a running
 * `ogw generation install` job of that method or of every method.
 */
export async function installMethodJob(ctx: Context, method: string): Promise<string> {
  const running = (await listJobs(ctx.env)).find(
    (job) => job.status === 'running' && job.command === 'generation install' && (job.argv.length === 2 || job.argv[2] === method),
  );
  if (running) return running.id;
  const started = await startBackground(ctx, installCommand, { positionals: [method], values: {}, raw: [method] }, null);
  return (started.data as { job: string }).job;
}
