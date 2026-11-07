/** The steps of `ogw regress refresh` and admission that run other ogw commands on a regression state. */
import type { Context } from '../../../lib/command.ts';
import { parseTokens } from '../../../lib/command.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { runData } from '../../data/api.ts';
import { upgradeCommand } from '../../core/upgrade.ts';
import { commitWithoutHook } from '../../game/lib/commit-without-hook.ts';
import { list } from '../../settings/list.ts';
import { set } from '../../settings/set.ts';

/** `ogw core upgrade <state> --version <v>`: its output, or why it failed. */
export async function upgradeCore(ctx: Context, game: string, version: string): Promise<{ ok: boolean; text: string }> {
  try {
    const result = await upgradeCommand.run(ctx, parseTokens([game, '--version', version], upgradeCommand.options ?? {}));
    return { ok: (result.exitCode ?? 0) === 0, text: result.text ?? '' };
  } catch (error) {
    return { ok: false, text: (error as Error).message };
  }
}

/**
 * The first part of `### regress refresh` 1: the `settings` values of the state written to the game settings of its
 * checkout with `ogw settings set` (as the lead agent) and committed as a commit without the hook (ogw.md
 * `## pre-commit hook`; no static check runs after it), then the paths that `ogw settings list --missing` still gives
 * whose `x-owner` is not `content`. `ok` is false when the write fails or such a path is missing; `text` is the
 * `settings` column of the record.
 */
export async function stateSettings(ctx: Context, game: GameRepo, values: Readonly<Record<string, unknown>>, version: string): Promise<{ ok: boolean; text: string }> {
  const pairs = Object.entries(values).flatMap(([path, value]) => [path, JSON.stringify(value)]);
  let changed = false;
  if (pairs.length > 0) {
    try {
      await set.run(ctx, parseTokens(['game', game.name, ...pairs], set.options ?? {}));
    } catch (error) {
      return { ok: false, text: `failed: ${(error as Error).message.split('\n')[0] ?? ''}` };
    }
    changed = (await commitWithoutHook(ctx, game, ['settings.json'], `regress refresh ${version}: state settings`)) !== null;
  }
  const listed = await list.run(ctx, parseTokens(['game', game.name, '--missing'], list.options ?? {}));
  const missing = (listed.data as { paths: { path: string; xOwner: string | null }[] }).paths.filter((row) => row.xOwner !== 'content').map((row) => row.path);
  if (missing.length > 0) return { ok: false, text: `missing: ${missing.join(', ')}` };
  return { ok: true, text: changed ? 'set' : 'none' };
}

/** `ogw data <state>` on a checkout; why it failed, or null. */
export async function dataTool(ctx: Context, game: GameRepo): Promise<string | null> {
  try {
    const result = await runData(ctx, game);
    if (result.exitCode === 0) return null;
    const errors = result.lines.filter((line) => line.level === 'ERROR').map((line) => `${line.where} ${line.code}`);
    return `ogw data failed (${String(result.exitCode)})${errors.length > 0 ? `: ${errors.slice(0, 3).join(', ')}` : ''}`;
  } catch (error) {
    return (error as Error).message.split('\n')[0] ?? 'ogw data failed';
  }
}
