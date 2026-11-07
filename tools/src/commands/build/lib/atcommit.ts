import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { gitRaw, worktreeAdd, worktreeRemove } from '../../../lib/git.ts';
import { newId } from '../../../lib/ids.ts';
import { binaryBuildAt, type DataVersions } from '../../data/lib/binary-build.ts';

export { readDataVersions, type DataVersions } from '../../data/lib/binary-build.ts';

/** `GameContract.CONTRACT_VERSION` in the server generated contract code of a commit; null when absent. */
export async function contractVersionAt(root: string, commit: string): Promise<number | null> {
  const result = await gitRaw(root, ['grep', '-h', '-E', 'CONTRACT_VERSION', commit, '--', 'server/generated/contract/']);
  if (result.code !== 0) return null;
  const m = /CONTRACT_VERSION\b[^0-9\n]*?([0-9]+)/.exec(result.stdout);
  return m ? Number(m[1]) : null;
}

/**
 * A new temporary worktree of the commit under `worktrees/<game>/`. `onPath` gets its path before the add, so that the
 * caller removes it (`removeCommitCheckout`) also when the add fails partway.
 */
export async function addCommitCheckout(ctx: Context, game: GameRepo, commit: string, onPath: (path: string) => unknown = () => undefined): Promise<GameRepo> {
  const ws = await ctx.workspace();
  const path = join(ws.worktrees, game.name, `build-${newId()}`);
  onPath(path);
  await worktreeAdd(game.mainRoot, path, commit, undefined, { env: ctx.env });
  return { ...game, root: path, inWorktree: true };
}

/** Removes a worktree of `addCommitCheckout`. */
export async function removeCommitCheckout(ctx: Context, game: GameRepo, path: string): Promise<void> {
  await worktreeRemove(game.mainRoot, path, { env: ctx.env });
}

/** Runs `fn` on a temporary worktree of the commit under `worktrees/<game>/`. */
export async function withCommitCheckout<T>(ctx: Context, game: GameRepo, commit: string, fn: (repo: GameRepo) => Promise<T>): Promise<T> {
  const made: string[] = [];
  try {
    return await fn(await addCommitCheckout(ctx, game, commit, (path) => made.push(path)));
  } finally {
    for (const path of made) await removeCommitCheckout(ctx, game, path);
  }
}

/** Data versions per game repo and commit, computed once per process (one `ogw` command run). */
const versionsMemo = new Map<string, Promise<DataVersions>>();

/** Data versions of a commit (a full commit id), from a binary build in a temporary worktree; each commit is built once. */
export async function dataVersionsAt(ctx: Context, game: GameRepo, commit: string): Promise<DataVersions> {
  const key = `${game.mainRoot}\0${commit}`;
  let versions = versionsMemo.get(key);
  if (versions === undefined) {
    versions = (async () => {
      try {
        const made: string[] = [];
        try {
          return (await binaryBuildAt(ctx, game, commit, commit, made)).versions;
        } finally {
          for (const dir of made) await worktreeRemove(game.mainRoot, dir, { env: ctx.env });
        }
      } catch (error) {
        // a failed build is not kept: a later call builds the commit again (`binaryBuildAt` is async, so this runs after the set below)
        versionsMemo.delete(key);
        throw error;
      }
    })();
    versionsMemo.set(key, versions);
  }
  return versions;
}

/** The protocol hash part of a data version `<protocol hash>-<data hash>`. */
export function protocolHash(dataVersion: string): string {
  return dataVersion.split('-')[0] ?? '';
}
