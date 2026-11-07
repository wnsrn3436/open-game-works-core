/**
 * The kept binary builds of the PROD data tag candidates (ogw.md `## temp folder`): the `--previous` folder of the data
 * tool (`data` skill `tool.md` `## CLI`), made once per tag commit and build inputs instead of on every data run.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { ignoreCleanupError, OgwError } from '../../../lib/errors.ts';
import { exists, readJsonIfExists, whenNotFound, writeJsonAtomic } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { git, listTags, revParse, worktreeRemove } from '../../../lib/git.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { withLock } from '../../../lib/lock.ts';
import { span } from '../../../lib/spans.ts';
import { withReader, withWriterWithin, type RwLock } from '../../../lib/rwlock.ts';
import { schemaPath } from '../../../lib/settings.ts';
import { binaryBuildAt, type CommitBuild, type DataVersions } from './binary-build.ts';
import { prodTagCandidates } from './prod-tag.ts';

/** The folder name prefix of a kept build in `worktrees/<game>/`. */
const PROD_DATA = 'prod-data-';
/** The folder in the git common dir of the game with the record and the locks of each kept build. */
const STATE = 'ogw-prod-data';

/** A kept build of a tag: its worktree, the record of its finished build, the lock of making it, and the lock of its readers. */
interface KeptBuild {
  tag: string;
  rev: string;
  dir: string;
  record: string;
  lock: string;
  readers: RwLock;
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function keptAt(game: GameRepo, worktrees: string, key: string): Omit<KeptBuild, 'tag' | 'rev'> {
  const state = join(game.commonDir, STATE, key);
  return { dir: join(worktrees, game.name, `${PROD_DATA}${key}`), record: `${state}.json`, lock: `${state}.lock`, readers: { base: `${state}.rw`, waitMs: LIMITS.programMs } };
}

/**
 * The kept build of `tag`. Its key holds what gives the build its inputs besides the files of the commit: the core
 * version at the tag commit, whose published release (hash-checked, never changed) gives the data tool and the core
 * spec, and the game settings schema of the harness, whose defaults the data tool gets.
 */
async function keptBuildOf(ctx: Context, game: GameRepo, tag: string): Promise<KeptBuild> {
  const rev = await revParse(game.root, `refs/tags/${tag}`, { env: ctx.env });
  if (rev === null) throw new OgwError(`tag ${tag} is not a commit`);
  const settings = JSON.parse(await git(game.root, ['show', `${rev}:settings.json`], { env: ctx.env })) as { coreVersion?: unknown };
  if (typeof settings.coreVersion !== 'string') throw new OgwError(`no coreVersion in settings.json at ${tag}`);
  const schema = sha256(await readFile(schemaPath('game-settings', ctx.env)));
  const key = sha256(JSON.stringify([rev, settings.coreVersion, schema])).slice(0, 24);
  return { tag, rev, ...keptAt(game, (await ctx.workspace()).worktrees, key) };
}

/** The finished build of `kept`, made under its lock when it is not there; `made` is called when it was made now. */
async function finishedBuild(ctx: Context, game: GameRepo, kept: KeptBuild, made: () => void): Promise<CommitBuild> {
  return withLock(kept.lock, async () => {
    const versions = await readJsonIfExists<DataVersions>(kept.record);
    if (versions !== null && exists(kept.dir)) return { dir: kept.dir, versions };
    await rm(kept.record, { force: true });
    // a build that did not end leaves its worktree without a record; a worktree folder that is gone leaves its registration
    await worktreeRemove(game.root, kept.dir, { env: ctx.env });
    const worktrees: string[] = [];
    let built: CommitBuild;
    try {
      built = await binaryBuildAt(ctx, game, kept.rev, kept.tag, worktrees, kept.dir);
    } catch (error) {
      // a failed build is not kept: the next data run makes it again
      for (const dir of worktrees) await worktreeRemove(game.root, dir, { env: ctx.env }).catch(ignoreCleanupError);
      throw error;
    }
    await writeJsonAtomic(kept.record, built.versions);
    made();
    return built;
  }, LIMITS.programMs);
}

/** Runs `fn` reading every build of `kept`, so that no removal takes them away meanwhile. */
function reading<T>(kept: readonly KeptBuild[], fn: () => Promise<T>): Promise<T> {
  const [first, ...rest] = kept;
  return first === undefined ? fn() : withReader(first.readers, () => reading(rest, fn));
}

/** Removes the kept builds of the game other than `used` that no run reads now; one being read stays for a later run. */
async function removeOthers(ctx: Context, game: GameRepo, used: ReadonlySet<string>): Promise<void> {
  const worktrees = (await ctx.workspace()).worktrees;
  for (const name of await readdir(join(worktrees, game.name)).catch(whenNotFound([] as string[]))) {
    if (!name.startsWith(PROD_DATA)) continue;
    const other = keptAt(game, worktrees, name.slice(PROD_DATA.length));
    if (used.has(other.dir)) continue;
    await withWriterWithin({ ...other.readers, waitMs: 0 }, async () => {
      await rm(other.record, { force: true });
      await worktreeRemove(game.root, other.dir, { env: ctx.env });
    });
  }
}

/**
 * Runs `use` with the binary-built folder of the PROD data tag (`data` skill `## data version`), or null without a PROD
 * tag, read from its kept build. A bundle patch tag is the PROD data tag only when its Client or Server data version
 * differs from that of its app version tag; the builds of a bundle patch tag and of its app version tag are made
 * together. Once a run made a build, the other kept builds of the game that no run reads are removed.
 */
export async function withProdData<T>(ctx: Context, game: GameRepo, use: (previous: string | null) => Promise<T>): Promise<T> {
  const tags = await listTags(game.root, { env: ctx.env });
  const candidates = await prodTagCandidates(game.root, tags);
  const used = new Set<string>();
  const made = { now: false };
  const step = async (i: number): Promise<T> => {
    const candidate = candidates[i];
    if (candidate === undefined) return use(null);
    const app = candidate.appTag;
    if (app !== null && !tags.includes(app)) throw new OgwError(`bundle patch tag ${candidate.tag} has no tag ${app}`);
    const kept = await Promise.all([candidate.tag, ...(app === null ? [] : [app])].map((tag) => keptBuildOf(ctx, game, tag)));
    for (const k of kept) used.add(k.dir);
    return reading(kept, async () => {
      const [built, appBuilt] = await Promise.all(kept.map((k) => span('PROD data', () => finishedBuild(ctx, game, k, () => {
        made.now = true;
      }))));
      const prod = built as CommitBuild;
      if (appBuilt === undefined || prod.versions.client !== appBuilt.versions.client || prod.versions.server !== appBuilt.versions.server) return use(prod.dir);
      return step(i + 1);
    });
  };
  try {
    return await step(0);
  } finally {
    if (made.now) await removeOthers(ctx, game, used);
  }
}
