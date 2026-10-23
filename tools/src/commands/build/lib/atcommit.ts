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

/** Runs `fn` on a temporary worktree of the commit under `worktrees/<game>/`. */
export async function withCommitCheckout<T>(ctx: Context, game: GameRepo, commit: string, fn: (repo: GameRepo) => Promise<T>): Promise<T> {
  const ws = await ctx.workspace();
  const path = join(ws.worktrees, game.name, `build-${newId()}`);
  await worktreeAdd(game.mainRoot, path, commit, undefined, { env: ctx.env });
  try {
    return await fn({ ...game, root: path, inWorktree: true });
  } finally {
    await worktreeRemove(game.mainRoot, path, { env: ctx.env });
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
      const made: string[] = [];
      try {
        return (await binaryBuildAt(ctx, game, commit, commit, made)).versions;
      } finally {
        for (const dir of made) await worktreeRemove(game.mainRoot, dir, { env: ctx.env });
      }
    })();
    versionsMemo.set(key, versions);
    versions.catch(() => versionsMemo.delete(key));
  }
  return versions;
}

/** The protocol hash part of a data version `<protocol hash>-<data hash>`. */
export function protocolHash(dataVersion: string): string {
  return dataVersion.split('-')[0] ?? '';
}
