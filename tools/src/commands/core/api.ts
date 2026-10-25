import { rmSync } from 'node:fs';
import { readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists, readJsonIfExists, writeFileAtomic, writeJsonAtomic } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { commitPaths, git, gitRaw, showFile, worktreeRemove } from '../../lib/git.ts';
import { newId } from '../../lib/ids.ts';
import { withLock } from '../../lib/lock.ts';
import { isInside } from '../../lib/paths.ts';
import { openRun, withRunLock } from '../../lib/runstate.ts';
import { loadGameSettings } from '../../lib/settings.ts';
import { extractArchive } from './lib/archive.ts';
import { buildAssets } from './lib/assets.ts';
export { compareVersions, isVersion } from './lib/version.ts';
import { downloadRelease, releaseTags } from './lib/github.ts';
import { verifyRelease } from './lib/manifest.ts';
import { compareVersions, isVersion, RELEASE_TAG, releaseTag, requireVersion, sortVersions } from './lib/version.ts';
import { newPrivateTempFolder } from '../../lib/secret-files.ts';

/** Folder of a core release: `open-game-works-core-releases/<version>/` with the release assets as files. */
export interface CoreRelease {
  version: string;
  /** Folder holding the asset files (`core-spec.json`, `server.tgz`, `client-<engine>.zip`, ...). */
  dir: string;
  /** True when the assets were built from `open-game-works-core-impl/` because `useLocalCore` is true. */
  local: boolean;
}

/** Local releases built by this process, removed when the process ends. */
const localReleases = new Map<string, Promise<CoreRelease>>();
const localDirs: string[] = [];
let cleanupInstalled = false;

function removeLocalDirs(): void {
  for (const dir of localDirs) rmSync(dir, { recursive: true, force: true });
}

async function buildLocalRelease(ctx: Context, version: string): Promise<CoreRelease> {
  const ws = await ctx.workspace();
  const dir = await newPrivateTempFolder('ogw-local-core-', ctx.env);
  localDirs.push(dir);
  if (!cleanupInstalled) {
    cleanupInstalled = true;
    process.on('exit', removeLocalDirs);
  }
  try {
    await buildAssets(ws.coreImpl, version, dir, { env: ctx.env });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return { version, dir, local: true };
}

function localRelease(ctx: Context, implDir: string, version: string): Promise<CoreRelease> {
  const key = `${implDir}\0${version}`;
  let release = localReleases.get(key);
  if (!release) {
    release = buildLocalRelease(ctx, version);
    localReleases.set(key, release);
    release.catch(() => localReleases.delete(key));
  }
  return release;
}

async function downloadInto(ctx: Context, repo: string, version: string, coreReleases: string, dir: string): Promise<void> {
  const tmp = join(coreReleases, `.download-${version}-${newId()}`);
  try {
    await downloadRelease(ctx, repo, releaseTag(version), tmp);
    const problems = await verifyRelease(tmp, version);
    if (problems.length > 0) {
      throw new OgwError(`core release ${version} failed the hash check:\n${problems.join('\n')}`, 1, { problems });
    }
    await rename(tmp, dir);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * The release of `version`, fetched from the GitHub release and hash-checked against `manifest.json`
 * when it is not in `open-game-works-core-releases/` yet. With harness settings `useLocalCore` true, assets
 * built from `open-game-works-core-impl/` in a temporary folder instead.
 */
export async function coreRelease(ctx: Context, version: string): Promise<CoreRelease> {
  requireVersion(version);
  const settings = await ctx.settings();
  if (settings.useLocalCore) return localRelease(ctx, (await ctx.workspace()).coreImpl, version);
  return publishedRelease(ctx, version);
}

/**
 * The published GitHub release of `version` in `open-game-works-core-releases/`, fetched and hash-checked when it
 * is not there yet, whatever harness settings `useLocalCore` is.
 */
export async function publishedRelease(ctx: Context, version: string): Promise<CoreRelease> {
  requireVersion(version);
  const settings = await ctx.settings();
  const ws = await ctx.workspace();
  const dir = join(ws.coreReleases, version);
  if (exists(join(dir, 'manifest.json'))) return { version, dir, local: false };
  return withLock(join(ws.coreReleases, `${version}.lock`), async () => {
    if (!exists(join(dir, 'manifest.json'))) {
      await rm(dir, { recursive: true, force: true });
      await downloadInto(ctx, settings.coreReleaseRepository, version, ws.coreReleases, dir);
    }
    return { version, dir, local: false };
  });
}

/**
 * `ogw core fetch` of `version`: `coreRelease`, and a published release hash-checked against its `manifest.json`
 * again also when it was already in `open-game-works-core-releases/`.
 */
export async function fetchCoreRelease(ctx: Context, version: string): Promise<CoreRelease> {
  const release = await coreRelease(ctx, version);
  if (!release.local) {
    const problems = await verifyRelease(release.dir, release.version);
    if (problems.length > 0) {
      throw new OgwError(`core release ${release.version} in ${release.dir} failed the hash check:\n${problems.join('\n')}`, 1, { problems });
    }
  }
  return release;
}

/** game settings `coreVersion` of a checkout. */
export async function gameCoreVersion(game: GameRepo): Promise<string> {
  const settings = await loadGameSettings(game.root);
  const version = settings.coreVersion;
  if (typeof version !== 'string') throw new OgwError(`game settings of ${game.name} have no coreVersion`);
  return requireVersion(version, `coreVersion of ${game.name}`);
}

/** The release of the game settings `coreVersion` of this checkout. */
export async function coreReleaseOfGame(ctx: Context, game: GameRepo): Promise<CoreRelease> {
  return coreRelease(ctx, await gameCoreVersion(game));
}

const ARCHIVE = /^([^/\\]+)\.(zip|tgz)$/;

/**
 * Folder with the contents of an archive asset (`.zip` or `.tgz`) of the release, extracted once
 * next to the asset, for example `contract-tool.tgz` or `client-godot.zip`.
 */
export async function extractedAsset(_ctx: Context, release: CoreRelease, asset: string): Promise<string> {
  const match = ARCHIVE.exec(asset);
  if (!match || asset.startsWith('.')) throw new OgwError(`not an archive asset: ${asset}`);
  const file = join(release.dir, asset);
  if (!exists(file)) throw new OgwError(`core release ${release.version} has no asset ${asset}`);
  const target = join(release.dir, match[1] as string);
  if (exists(target)) return target;
  await withLock(`${target}.lock`, async () => {
    if (!exists(target)) await extractArchive(file, target);
  });
  return target;
}

/** Versions `<major>.<minor>.<patch>` of the GitHub releases of harness settings `coreReleaseRepository`. */
export async function remoteReleaseVersions(ctx: Context): Promise<string[]> {
  const settings = await ctx.settings();
  const tags = await releaseTags(ctx, settings.coreReleaseRepository);
  const versions: string[] = [];
  for (const tag of tags) {
    const match = RELEASE_TAG.exec(tag);
    if (match) versions.push(match[1] as string);
  }
  return sortVersions(versions);
}

/**
 * `ogw-pending-proposals.json` in the game repo git common dir: the `ogw core proposal released` calls deferred
 * while the game had an open run. Read and written only under `ogw-pending-proposals.lock`.
 */
export interface PendingProposal {
  proposalFile: string;
  version: string;
}

interface PendingFile {
  proposals: PendingProposal[];
}

export function pendingProposalsPath(game: GameRepo): string {
  return join(game.commonDir, 'ogw-pending-proposals.json');
}

function pendingLockPath(game: GameRepo): string {
  return join(game.commonDir, 'ogw-pending-proposals.lock');
}

async function readPending(game: GameRepo): Promise<PendingFile> {
  const file = await readJsonIfExists<Partial<PendingFile>>(pendingProposalsPath(game));
  return { proposals: Array.isArray(file?.proposals) ? file.proposals : [] };
}

/** The proposal file as a path relative to the game repo root with `/`. */
function proposalPath(ctx: Context, game: GameRepo, proposalFile: string): string {
  const absolute = resolve(ctx.cwd, proposalFile);
  let rel = proposalFile;
  for (const root of [game.root, game.mainRoot]) {
    if (isInside(root, absolute)) {
      rel = relative(root, absolute);
      break;
    }
  }
  rel = rel.split(sep).join('/');
  if (rel === '' || isAbsolute(rel) || rel.split('/').includes('..')) {
    throw new OgwError(`proposal file is not inside the game repo: ${proposalFile}`);
  }
  return rel;
}

/** The checkout of main: the main checkout or a worktree that has main checked out. */
async function mainCheckout(game: GameRepo): Promise<string | null> {
  const out = await git(game.mainRoot, ['worktree', 'list', '--porcelain']);
  let path: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line === 'branch refs/heads/main' && path) return path;
  }
  return null;
}

function checkProposedLine(rel: string, text: string): void {
  const first = text.split(/\r?\n/)[0] ?? '';
  if (first !== 'status: proposed') throw new OgwError(`first line of ${rel} is not "status: proposed": ${JSON.stringify(first)}`);
}

/** Fails as marking would: the proposal is not a file on main or its first line is not `status: proposed`. */
async function checkOnMain(ctx: Context, repo: GameRepo, rel: string): Promise<void> {
  const type = await gitRaw(repo.mainRoot, ['cat-file', '-t', `main:${rel}`], { env: ctx.env });
  const text = type.code === 0 && type.stdout.trim() === 'blob' ? await showFile(repo.mainRoot, 'main', rel, { env: ctx.env }) : null;
  if (text === null) throw new OgwError(`proposal file not found on main: ${rel}`);
  checkProposedLine(rel, text.toString('utf8'));
}

async function markInCheckout(root: string, rel: string, version: string): Promise<void> {
  const file = join(root, rel);
  if (!exists(file) || !(await stat(file)).isFile()) throw new OgwError(`proposal file not found on main: ${rel}`);
  const text = await readFile(file, 'utf8');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  checkProposedLine(rel, text);
  const lines = text.split(newline);
  lines.splice(0, 1, 'status: released', `version: ${version}`);
  await writeFileAtomic(file, lines.join(newline));
  await commitPaths(root, [rel], `core proposal released: ${basename(rel)} ${version}`);
}

/** Marks the proposal released on main: in the checkout of main, or in a temporary worktree of main. */
async function markOnMain(ctx: Context, repo: GameRepo, rel: string, version: string): Promise<void> {
  const checkout = await mainCheckout(repo);
  if (checkout) {
    await markInCheckout(checkout, rel, version);
    return;
  }
  const ws = await ctx.workspace();
  const temp = join(ws.worktrees, repo.name, `proposal-${newId()}`);
  await git(repo.mainRoot, ['worktree', 'add', '--quiet', temp, 'main'], { env: ctx.env });
  try {
    await markInCheckout(temp, rel, version);
  } finally {
    await worktreeRemove(repo.mainRoot, temp, { env: ctx.env });
    await rm(temp, { recursive: true, force: true });
  }
}

/** Adds the proposal to the pending file when the game has an open run. Returns false when it has none. */
async function deferWhileOpen(ctx: Context, repo: GameRepo, rel: string, version: string): Promise<boolean> {
  return withLock(pendingLockPath(repo), async () => {
    if (!(await openRun(repo))) return false;
    await checkOnMain(ctx, repo, rel);
    const pending = await readPending(repo);
    const same = pending.proposals.find((item) => item.proposalFile === rel);
    if (same && same.version !== version) throw new OgwError(`${rel} is already deferred as released in version ${same.version}`);
    if (!same) {
      pending.proposals.push({ proposalFile: rel, version });
      await writeJsonAtomic(pendingProposalsPath(repo), pending);
    }
    return true;
  });
}

/**
 * `ogw core proposal released <game> <proposal file> <version>`: marks the proposal released on main,
 * or defers it to `ogw-pending-proposals.json` while the game has an open run.
 */
export async function markProposalReleased(ctx: Context, game: string, proposalFile: string, version: string): Promise<'marked' | 'deferred'> {
  requireVersion(version);
  const repo = await ctx.game(game);
  const rel = proposalPath(ctx, repo, proposalFile);
  // The run lock covers the open-run check and the main commit: a run that starts in between would get a moved base commit.
  return withRunLock(repo, async () => {
    if (await deferWhileOpen(ctx, repo, rel, version)) return 'deferred';
    await markOnMain(ctx, repo, rel, version);
    return 'marked';
  });
}

/** A deferred proposal `releasePendingProposals` handled; `error` is why it was not marked. */
export interface PendingRelease extends PendingProposal {
  error: string | null;
}

/**
 * Marks each deferred proposal released on main as `ogw core proposal released` does, and removes it from the
 * pending file. A proposal that fails stays in the file with its error. The caller holds `withRunLock`.
 */
export async function releasePendingProposals(ctx: Context, repo: GameRepo): Promise<PendingRelease[]> {
  return withLock(pendingLockPath(repo), async () => {
    const results: PendingRelease[] = [];
    const kept: PendingProposal[] = [];
    for (const item of (await readPending(repo)).proposals) {
      try {
        await markOnMain(ctx, repo, item.proposalFile, item.version);
        results.push({ ...item, error: null });
      } catch (error) {
        if (!(error instanceof OgwError)) throw error;
        results.push({ ...item, error: error.message });
        kept.push(item);
      }
    }
    if (kept.length === 0) await rm(pendingProposalsPath(repo), { force: true });
    else await writeJsonAtomic(pendingProposalsPath(repo), { proposals: kept });
    return results;
  });
}

/** Released core proposals whose version is above `from` and at most `to`. */
export async function releasedProposals(game: GameRepo, from: string, to: string): Promise<string[]> {
  const dir = join(game.root, 'records', 'core-proposals');
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.md')).sort();
  const out: string[] = [];
  for (const name of names) {
    const [first, second] = (await readFile(join(dir, name), 'utf8')).split(/\r?\n/);
    const version = /^version:\s*(\S+)\s*$/.exec(second ?? '')?.[1];
    if (first?.trim() !== 'status: released' || version === undefined || !isVersion(version)) continue;
    if (compareVersions(version, from) > 0 && compareVersions(version, to) <= 0) out.push(`records/core-proposals/${name}`);
  }
  return out;
}
