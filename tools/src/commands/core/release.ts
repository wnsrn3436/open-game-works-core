import { readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expectPositionals, positional, str, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { writeFileAtomic } from '../../lib/fsx.ts';
import { commitPaths, currentBranch, git, gitRaw, head, revParse, statusLines, tagExists } from '../../lib/git.ts';
import { LIMITS } from '../../lib/limits.ts';
import type { HarnessSettings } from '../../lib/settings.ts';
import { clearReviews } from '../review/api.ts';
import { remoteReleaseVersions } from './api.ts';
import { buildAssets } from './lib/assets.ts';
import { assetUrl, createRelease, releaseExists } from './lib/github.ts';
import { releaseViolations, reviewDebtCounts, untestedRenderPasses } from './lib/release-conditions.ts';
import { readCoreSpecDir } from './lib/impl.ts';
import { withCoreMain } from './lib/main-checkout.ts';
import { releaseTag, requireVersion } from './lib/version.ts';
import { byteCompare } from '../../lib/order.ts';
import { newPrivateTempFolder } from '../../lib/secret-files.ts';

async function requireCleanMain(implDir: string): Promise<void> {
  const branch = await currentBranch(implDir);
  if (branch !== 'main') throw new OgwError(`open-game-works-core-impl/ must have main checked out to release (now ${branch ?? 'detached HEAD'})`);
  const status = await statusLines(implDir);
  if (status.length > 0) throw new OgwError(`open-game-works-core-impl/ has uncommitted changes:\n${status.join('\n')}`);
}

/**
 * Fails when main of `open-game-works-core-impl/` left `previousHead` or got changes since the release started (for example a
 * merge into main): the assets, the commit and the tag must be of the commit whose release conditions were checked.
 */
async function requireUnmoved(ctx: Context, implDir: string, previousHead: string): Promise<void> {
  const now = await head(implDir, { env: ctx.env });
  if (now !== previousHead) throw new OgwError(`open-game-works-core-impl/ main moved from ${previousHead} to ${now} during the release; release again`);
  await requireCleanMain(implDir);
}

/** Writes the `engine.json` files whose `ogw-` plugin URL and SHA-256 changed; returns their paths. */
async function writeEngineJson(implDir: string, texts: Map<string, string>): Promise<string[]> {
  const changed: string[] = [];
  for (const [engine, text] of texts) {
    const rel = `client/${engine}/engine.json`;
    if ((await readFile(join(implDir, rel), 'utf8')) !== text) {
      await writeFileAtomic(join(implDir, rel), text);
      changed.push(rel);
    }
  }
  return changed;
}

/** Whether the GitHub release exists after `gh release create` failed; null when `gh` cannot tell. */
async function releaseAfterFailure(ctx: Context, repo: string, tag: string): Promise<boolean | null> {
  try {
    return await releaseExists(ctx, repo, tag);
  } catch {
    return null;
  }
}

/**
 * Tags, pushes the tag and creates the GitHub release. When one of them fails and no release was made, it undoes the
 * local tag, the pushed tag and the commit, so the same version can be released again. When the release exists or
 * `gh` cannot tell (for example `gh release create` timed out after it made the release), it keeps them all, so main
 * keeps the asset URLs the release was made with.
 */
/** git options that make a push to github.com use the `gh` login, which `gh release create` uses too. */
const GH_CREDENTIAL = ['-c', 'credential.https://github.com.helper=', '-c', 'credential.https://github.com.helper=!gh auth git-credential'];

async function publish(ctx: Context, implDir: string, settings: HarnessSettings, release: { tag: string; commit: string; previousHead: string; files: string[]; notes: string }): Promise<void> {
  const repo = settings.coreReleaseRepository;
  const remote = `https://github.com/${repo}.git`;
  let pushed = false;
  try {
    await git(implDir, ['tag', release.tag, release.commit], { env: ctx.env });
    await git(implDir, [...GH_CREDENTIAL, 'push', remote, `refs/tags/${release.tag}`], { env: ctx.env, timeoutMs: LIMITS.programMs });
    pushed = true;
    await createRelease(ctx, repo, release.tag, release.files, release.notes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exists = pushed ? await releaseAfterFailure(ctx, repo, release.tag) : false;
    if (exists !== false) {
      const state = exists ? `release ${release.tag} exists in ${repo}` : `could not tell whether release ${release.tag} exists in ${repo}`;
      throw new OgwError(`${message}\n${state}; kept tag ${release.tag} (pushed) and commit ${release.commit}: check the release and its assets`);
    }
    const problems: string[] = [];
    if (pushed) {
      const removed = await gitRaw(implDir, [...GH_CREDENTIAL, 'push', remote, `:refs/tags/${release.tag}`], { env: ctx.env, timeoutMs: LIMITS.programMs });
      if (removed.code !== 0) problems.push(`could not delete the pushed tag ${release.tag} from ${remote}: ${(removed.stderr || removed.stdout).trim()}`);
    }
    await gitRaw(implDir, ['tag', '--delete', release.tag], { env: ctx.env });
    // Only the release commit itself is undone: never a commit that reached main after it.
    const releaseCommit = release.commit !== release.previousHead && (await head(implDir, { env: ctx.env })) === release.commit;
    if (releaseCommit && (await revParse(implDir, `${release.commit}^`, { env: ctx.env })) === release.previousHead) {
      await git(implDir, ['reset', '--hard', release.previousHead], { env: ctx.env });
    }
    if (problems.length > 0) throw new OgwError(`${message}\n${problems.join('\n')}`);
    throw error;
  }
}

/** The text of the `--notes` file: the release notes of the GitHub release, which the release does not make without. */
async function releaseNotes(ctx: Context, path: string | undefined, usage: string): Promise<string> {
  if (path === undefined) throw new OgwError(`--notes <file> is required: the release notes of the GitHub release\nusage: ${usage}`);
  let text: string;
  try {
    text = await readFile(resolve(ctx.cwd, path), 'utf8');
  } catch (error) {
    throw new OgwError(`cannot read the release notes file ${path}: ${(error as Error).message}`);
  }
  if (text.trim() === '') throw new OgwError(`the release notes file ${path} is empty`);
  return text;
}

/** `ogw core release <version>` (`core` command.md `## version and release`). */
export const releaseCommand: CommandDef = {
  name: ['core', 'release'],
  usage: 'ogw core release <version> --notes <file>',
  options: { notes: { type: 'string' } },
  background: { timeLimitMs: () => LIMITS.jobMs },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const version = requireVersion(positional(args, 0, 'version'));
    const notes = await releaseNotes(ctx, str(args, 'notes'), this.usage);
    const settings = await ctx.settings();
    const implDir = (await ctx.workspace()).coreImpl;
    const tag = releaseTag(version);
    await requireCleanMain(implDir);
    if (await tagExists(implDir, tag, { env: ctx.env })) throw new OgwError(`tag ${tag} already exists in open-game-works-core-impl/`);
    if (await releaseExists(ctx, settings.coreReleaseRepository, tag)) {
      throw new OgwError(`release ${tag} already exists in ${settings.coreReleaseRepository}`);
    }
    const previousHead = await head(implDir, { env: ctx.env });
    const violations = await releaseViolations(ctx, implDir, previousHead, version, await remoteReleaseVersions(ctx));
    if (violations.length > 0) {
      throw new OgwError(`release condition not met; ${version} is not released:\n${violations.join('\n')}`, 1, { violations });
    }
    const untested = await untestedRenderPasses(implDir, previousHead, await readCoreSpecDir(implDir, { skipInvalid: true }));
    const debt = await reviewDebtCounts(implDir);
    const out = await newPrivateTempFolder('ogw-core-release-', ctx.env);
    try {
      await requireUnmoved(ctx, implDir, previousHead);
      const built = await buildAssets(implDir, version, out, { assetUrl: (asset) => assetUrl(settings.coreReleaseRepository, tag, asset), env: ctx.env });
      const files = (await readdir(out)).sort(byteCompare).map((name) => join(out, name));
      // From the last check of main to the tag, main writers (merges, debt list commits) wait: the tagged commit is the
      // checked one plus the engine.json commit
      const commit = await withCoreMain(implDir, ctx.env, async () => {
        await requireUnmoved(ctx, implDir, previousHead);
        const changed = await writeEngineJson(implDir, built.engineJson);
        const made = (await commitPaths(implDir, changed, `core release ${version}: plugin URLs and SHA-256`, { env: ctx.env })) ?? previousHead;
        await publish(ctx, implDir, settings, { tag, commit: made, previousHead, files, notes });
        return made;
      });
      const left = (await clearReviews(ctx, 'core')).map((what) => `not removed: ${what}`);
      return {
        text: [`released ${version}: tag ${tag} at ${commit}`, ...untested, ...debt, ...left].join('\n'),
        data: { version, tag, commit, assets: Object.keys(built.manifest.assets).concat('manifest.json'), untested, debt },
      };
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  },
};
