import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { git } from '../../../lib/git.ts';
import { harnessRoot } from '../../../lib/paths.ts';
import { compareVersions, isVersion } from './version.ts';

/** The harness tag of a core release: the harness commit whose specs that core was made from (`core` command.md). */
export function harnessCoreTag(version: string): string {
  return `core-v${version}`;
}

const HARNESS_CORE_TAG = /^core-v(.+)$/;

/**
 * The core version of this harness checkout: the highest `core-v<version>` tag that HEAD contains, or null when it
 * contains none (a harness before its first core release).
 */
export async function harnessCoreVersion(ctx: Context): Promise<string | null> {
  const out = await git(harnessRoot(ctx.env), ['tag', '--merged', 'HEAD', '--list', 'core-v*'], { env: ctx.env });
  const versions = out
    .split('\n')
    .map((tag) => HARNESS_CORE_TAG.exec(tag.trim())?.[1] ?? '')
    .filter(isVersion);
  return versions.sort(compareVersions).at(-1) ?? null;
}

/** How to bring a game of core `version` and this harness together. */
function remedy(game: string, version: string, harness: string | null): string {
  const upgrade = harness === null ? '' : `raise the core of the game to ${harness} (ogw core upgrade ${game} --version ${harness}) or `;
  return `${upgrade}use the harness at tag ${harnessCoreTag(version)}`;
}

/**
 * Fails when this harness does not support core `version` of `game`: newer than the core version of the harness, or
 * older than harness settings `minCoreVersion` (AGENTS.md `## repo`). With `useLocalCore` there is no check.
 */
export async function requireSupportedCore(ctx: Context, game: string, version: string): Promise<void> {
  const settings = await ctx.settings();
  if (settings.useLocalCore) return;
  const harness = await harnessCoreVersion(ctx);
  if (harness !== null && compareVersions(version, harness) > 0) {
    throw new OgwError(`${game} uses core ${version}, newer than this harness (core ${harness}): ${remedy(game, version, null)}`);
  }
  const min = settings.minCoreVersion;
  if (min !== null && compareVersions(version, min) < 0) {
    throw new OgwError(`${game} uses core ${version}, older than harness settings minCoreVersion ${min}: ${remedy(game, version, harness)}`);
  }
}

/**
 * Fails unless core `version` of `game` is the core version of this harness: the agents that write and harden game
 * code read the specs of this harness, which are the specs of that core (AGENTS.md `## repo`).
 */
export async function requireHarnessCore(ctx: Context, game: string, version: string): Promise<void> {
  if ((await ctx.settings()).useLocalCore) return;
  const harness = await harnessCoreVersion(ctx);
  if (harness === null || version === harness) return;
  throw new OgwError(`${game} uses core ${version}, and the specs of this harness are of core ${harness}: ${remedy(game, version, harness)}`);
}
