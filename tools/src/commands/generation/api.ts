// Generation group API for other groups: the `## method` rule of `skills/resource/production.md`, the catalog listing and method installs.
import type { Context } from '../../lib/command.ts';
import { startBackground } from '../../lib/cli.ts';
import { OgwError } from '../../lib/errors.ts';
import type { GameRepo } from '../../lib/game.ts';
import { listJobs } from '../../lib/jobs.ts';
import { toolProgram } from '../env/api.ts';
import { runHarnessSettings } from '../loop/lib/harness-pin.ts';
import { installCommand } from './install.ts';
import { methodDir } from './lib/install.ts';
import { chooseMethods, keySpecIfListed, LOGO_PREFIX, LOGOTYPE_METHOD, uninstalledMethods, type MethodChoice, type Stage } from './lib/select.ts';
import { performanceLeaseBase } from './lib/lease.ts';
import { catalogEntries as listCatalog, type CatalogFile } from './list.ts';

export type { CatalogFile, MethodChoice, Stage };
/** The logotype method and the prefix of the logo keys it letters (`production.md` `## logo`). */
export { LOGO_PREFIX, LOGOTYPE_METHOD };
/** The lock of the performance lease that the performance measurement of `ogw check` holds exclusively (ogw.md `### performance lease`). */
export { performanceLeaseBase };

/** Methods a resource key can use and the stage of each, as `ogw generation methods <game> <key>` gives them. */
export async function generationMethods(ctx: Context, game: GameRepo, resourceKey: string): Promise<MethodChoice[]> {
  return chooseMethods(ctx, await runHarnessSettings(ctx, game), game, resourceKey);
}

/** Files of a catalog method with path, license, source URL, attribution and character set, as `ogw generation list <method>` gives them. */
export function catalogEntries(ctx: Context, method: string): Promise<CatalogFile[]> {
  return listCatalog(ctx, method);
}

/**
 * The methods that block a resource key on this host, as `uninstalledMethods` says; empty for a key the list or its
 * spec rejects, which the resource sub-agent reports. A list or settings that cannot be read are thrown.
 */
export async function blockingMethods(ctx: Context, game: GameRepo, resourceKey: string): Promise<string[]> {
  const settings = await runHarnessSettings(ctx, game);
  const keyed = await keySpecIfListed(game, resourceKey);
  return keyed === null ? [] : uninstalledMethods(ctx, settings, resourceKey, keyed);
}

/**
 * The job that installs `method`: a running `ogw generation install` job whose job record names the install folder of
 * that method on this checkout (ogw.md `## generation install`), else a new background job of
 * `ogw generation install <method>`. Returns the job id and its argv. Fails for a method with `provider` while
 * `tools.ffmpeg` is not installed: its `cli` puts that program on PATH, and only the install of every method installs
 * `tools`.
 */
export async function installMethodJob(ctx: Context, method: string): Promise<{ job: string; argv: string[] }> {
  const pinned = (await ctx.settings()).resourceGeneration.find((m) => m.name === method);
  if (pinned === undefined) throw new OgwError(`no method ${method} in harness settings resourceGeneration`);
  const folder = await methodDir(ctx, pinned);
  const running = (await listJobs(ctx.env)).find(
    (job) => job.status === 'running' && job.command === 'generation install' && (job.meta.installs as Record<string, unknown> | undefined)?.[method] === folder,
  );
  if (running) return { job: running.id, argv: running.argv };
  if (pinned.provider !== undefined && (await toolProgram(ctx, 'ffmpeg')) === null) throw new OgwError('tools.ffmpeg is not installed: ogw generation install installs it');
  const started = await startBackground(ctx, installCommand, { positionals: [method], values: {}, raw: [method] }, null);
  return { job: (started.data as { job: string }).job, argv: ['generation', 'install', method] };
}
